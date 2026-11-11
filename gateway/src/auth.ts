import { digest, GatewayError, GatewayStore, randomCredential, validCredential, type CredentialInput, type Device, type PairInput } from './store';

export interface AuthResponse { installationId: string; deviceId: string; accessToken: string; expiresAt: number }
interface AccessGrant { deviceId: string; installationId: string; expiresAt: number }
interface RateBucket { count: number; until: number }

function objectKeys(input: unknown, keys: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) || Object.values(input).some(value => typeof value !== 'string')) {
    throw new GatewayError('INVALID_REQUEST', 400, 'Invalid authentication request');
  }
}

export class GatewayAuth {
  private readonly access = new Map<string, AccessGrant>();
  private readonly attempts = new Map<string, RateBucket>();
  private readonly failures = new Map<string, RateBucket>();
  private readonly now: () => number;
  private readonly accessTtlMs: number;
  private readonly maxAccessPerDevice: number;

  constructor(readonly store: GatewayStore, options: { now?: () => number; accessTtlMs?: number; maxAccessPerDevice?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.accessTtlMs = options.accessTtlMs ?? 10 * 60_000;
    this.maxAccessPerDevice = options.maxAccessPerDevice ?? 8;
    if (this.accessTtlMs <= 0 || this.accessTtlMs > 10 * 60_000 || !Number.isInteger(this.maxAccessPerDevice) || this.maxAccessPerDevice < 1 || this.maxAccessPerDevice > 32) throw new Error('Invalid access token limits');
  }

  private checkRate(map: Map<string, RateBucket>, key: string, limit: number, increment: boolean): void {
    const now = this.now();
    for (const [name, entry] of map) if (entry.until <= now) map.delete(name);
    const bucket = map.get(key);
    if ((bucket?.count ?? 0) >= limit || (!bucket && map.size >= 2048)) {
      const error = new GatewayError('RATE_LIMITED', 429, 'Authentication rate limit reached; retry later');
      Object.assign(error, { retryAfterMs: Math.max(1, (bucket?.until ?? now + 60_000) - now) });
      throw error;
    }
    if (increment) map.set(key, { count: (bucket?.count ?? 0) + 1, until: bucket?.until ?? now + 60_000 });
  }

  private authenticateRequest<T>(source: string, kind: 'pair' | 'token', fn: () => T): T {
    // source must be the actual socket peer, never an untrusted forwarding header.
    const sourceKey = `${kind}:${digest(source).slice(0, 32)}`;
    this.checkRate(this.failures, 'installation', 5, false);
    this.checkRate(this.failures, sourceKey, 5, false);
    this.checkRate(this.attempts, 'installation', 120, true);
    this.checkRate(this.attempts, sourceKey, 30, true);
    try { return fn(); }
    catch (error) {
      if (error instanceof GatewayError && [400, 401, 403].includes(error.statusCode)) {
        this.checkRate(this.failures, 'installation', 5, true);
        this.checkRate(this.failures, sourceKey, 5, true);
      }
      throw error;
    }
  }

  private issue(device: Device): AuthResponse {
    const now = this.now();
    for (const [key, grant] of this.access) if (grant.expiresAt <= now) this.access.delete(key);
    const count = [...this.access.values()].filter(grant => grant.deviceId === device.id).length;
    if (count >= this.maxAccessPerDevice || this.access.size >= 4096) throw new GatewayError('RATE_LIMITED', 429, 'Active access token limit reached; reuse a valid token or wait for expiry');
    this.checkRate(this.attempts, `device:${device.id}`, 12, true);
    const accessToken = randomCredential(); const expiresAt = now + this.accessTtlMs;
    this.access.set(digest(accessToken), { deviceId: device.id, installationId: this.store.installationId, expiresAt });
    return { installationId: this.store.installationId, deviceId: device.id, accessToken, expiresAt };
  }

  pair(input: unknown, source = 'local'): AuthResponse {
    return this.authenticateRequest(source, 'pair', () => {
      objectKeys(input, ['installationId', 'deviceId', 'deviceCredential', 'code', 'label']);
      return this.issue(this.store.pair(input as unknown as PairInput));
    });
  }

  token(input: unknown, source = 'local'): AuthResponse {
    return this.authenticateRequest(source, 'token', () => {
      objectKeys(input, ['installationId', 'deviceId', 'deviceCredential']);
      return this.issue(this.store.authenticateCredential(input as unknown as CredentialInput));
    });
  }

  authenticate(accessToken: string | undefined): Device {
    if (!validCredential(accessToken)) throw new GatewayError('UNAUTHENTICATED', 401, 'A valid access token is required');
    const key = digest(accessToken); const grant = this.access.get(key);
    if (!grant || grant.expiresAt <= this.now() || grant.installationId !== this.store.installationId) {
      this.access.delete(key);
      throw new GatewayError('UNAUTHENTICATED', 401, 'Access token expired or unavailable; exchange the device credential again');
    }
    // The database is consulted on every operation, including websocket/file
    // activity, so a separate CLI process can revoke an existing access grant.
    const device = this.store.getDevice(grant.deviceId);
    if (!device || device.revokedAt !== null) {
      this.access.delete(key);
      throw new GatewayError('DEVICE_REVOKED', 403, 'Device was revoked');
    }
    this.store.touchDevice(device.id);
    return device;
  }

  session(accessToken: string): { installationId: string; deviceId: string; label: string; createdAt: number; expiresAt: number } {
    const device = this.authenticate(accessToken);
    return { installationId: this.store.installationId, deviceId: device.id, label: device.label, createdAt: device.createdAt, expiresAt: this.access.get(digest(accessToken))!.expiresAt };
  }

  revoke(deviceId: string): boolean {
    const result = this.store.revokeDevice(deviceId);
    for (const [key, grant] of this.access) if (grant.deviceId === deviceId) this.access.delete(key);
    return result;
  }
}
