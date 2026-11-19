import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import { PROTOCOL, validateContract, type Capabilities, type EventConnection, type EventEnvelope, type EventPong, type SessionResponse } from '../../../../packages/gateway-protocol/src/index';
import { CredentialStore, type DeviceIdentity } from './credentials';
import { endpointUrl, normalizeEndpoint, websocketUrl } from './endpoint';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';
export type GatewayEventMessage = EventConnection | EventEnvelope | EventPong;
export type TransportIdentity = { endpoint: string; installationId: string; deviceId: string };
export type TransportConnection = {
  endpoint: string; installationId: string; deviceId: string | null; paired: boolean;
  epoch: string | null; capabilities: Capabilities | null; session: SessionResponse | null;
};
export type ByteResponse = { status: number; bytes: Buffer; headers: Record<string, string> };
export type GatewayHttpRequest = {
  url: URL; method: HttpMethod; headers: Record<string, string>; body?: Buffer;
  signal: AbortSignal; timeoutMs: number; maxBytes: number;
};
export type GatewaySocketOptions = {
  headers: Record<string, string>; handshakeTimeout: number; maxPayload: number;
  rejectUnauthorized: true; followRedirects: false;
};
export type GatewaySocket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'readyState'>;
/** Injection is main-process/test only. No network primitive is exposed over IPC. */
export interface GatewayIO {
  request(input: GatewayHttpRequest): Promise<ByteResponse>;
  socket(url: URL, options: GatewaySocketOptions): GatewaySocket;
}

export class TransportError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'TransportError'; }
}

const JSON_LIMIT = 16 * 1024 * 1024;
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const DOWNLOAD_LIMIT = 64 * 1024 * 1024;
const REQUEST_LIMIT = 128 * 1024;
const EVENT_LIMIT = 8 * 1024 * 1024;
const DEADLINE_MS = 30_000;
const KNOWN_CODES = new Set([
  'UNAUTHENTICATED', 'DEVICE_REVOKED', 'INVALID_REQUEST', 'PROTOCOL_INCOMPATIBLE', 'RATE_LIMITED',
  'NOT_FOUND', 'OPERATION_NOT_FOUND', 'OPERATION_UNKNOWN', 'OPERATION_ALREADY_RECORDED', 'STALE_EPOCH',
  'PROJECT_UNAVAILABLE', 'PROJECT_CHANGED', 'THREAD_UNAVAILABLE', 'THREAD_NOT_FOUND', 'TURN_UNAVAILABLE',
  'HISTORY_BUSY', 'HISTORY_STALE', 'HISTORY_CURSOR_INVALID', 'HISTORY_UNAVAILABLE', 'HISTORY_LIMIT',
  'HISTORY_TIMEOUT', 'HISTORY_PROTOCOL',
  'INTERACTION_RESPONSE_INVALID', 'INTERACTION_FORBIDDEN', 'INTERACTION_UNAVAILABLE', 'INTERACTION_ALREADY_RESOLVED',
  'FILE_CHANGED', 'FILE_UNAVAILABLE', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'FILE_GRANT_EXPIRED',
  'ATTACHMENT_UNAVAILABLE', 'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_LIMIT', 'CAPABILITY_UNAVAILABLE',
  // Gateway NativeFailureCode/HistoryError are finite public codes. In particular
  // a fresh thread's unmaterialized history is distinct from an arbitrary error.
  'NATIVE_UNAVAILABLE', 'NATIVE_TIMEOUT', 'NATIVE_REQUEST_FAILED', 'NATIVE_PAGINATION_UNSUPPORTED',
  'NATIVE_PROTOCOL', 'NATIVE_TOO_LARGE', 'NATIVE_BUSY', 'NATIVE_REJECTED', 'NATIVE_UNSUPPORTED',
  'NATIVE_EXPERIMENTAL', 'NATIVE_HISTORY_NOT_MATERIALIZED', 'INVALID_NATIVE_ARGUMENT',
  'CURSOR_RESET_REQUIRED', 'TURN_NOT_ACTIVE', 'THREAD_ACTIVE', 'THREAD_LIFECYCLE_UNAVAILABLE',
  'THREAD_LIFECYCLE_CHANGED', 'INTERACTION_STALE', 'CONFIRMATION_REQUIRED', 'INTERNAL_ERROR',
]);
const responseHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const selected: Record<string, string> = {};
  for (const key of ['content-type', 'content-length', 'content-digest', 'content-disposition']) {
    const value = headers[key];
    if (typeof value === 'string' && value.length <= 2048 && !/[\r\n\0]/.test(value)) selected[key] = value;
  }
  return selected;
};

/** Node does not follow redirects. TLS verification is explicitly required. */
export const nodeGatewayIO: GatewayIO = {
  request(input) {
    return new Promise((resolve, reject) => {
      const request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(input.url, {
        method: input.method, headers: input.headers, signal: input.signal, agent: false,
        rejectUnauthorized: true, maxHeaderSize: 32 * 1024,
      }, response => {
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > input.maxBytes) {
          response.destroy(); reject(new TransportError('RESPONSE_TOO_LARGE')); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > input.maxBytes) { response.destroy(); reject(new TransportError('RESPONSE_TOO_LARGE')); }
          else chunks.push(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks), headers: responseHeaders(response.headers) }));
        response.on('error', () => reject(new TransportError('CONNECTION_FAILED')));
        response.on('aborted', () => reject(new TransportError('CONNECTION_FAILED')));
      });
      request.on('error', () => reject(new TransportError(input.signal.aborted ? 'CONNECTION_CANCELLED' : 'CONNECTION_FAILED')));
      request.end(input.body);
    });
  },
  socket: (url, options) => new WebSocket(url, options),
};

function apiPath(path: string): string {
  if (typeof path !== 'string' || path.startsWith('//')) throw new TransportError('REQUEST_PATH_INVALID');
  const relative = path.startsWith('/') ? path.slice(1) : path;
  if (!relative || /^(?:api\/|health(?:$|\?))/.test(relative) || (relative.startsWith('auth/') && relative !== 'auth/logout')) throw new TransportError('REQUEST_PATH_INVALID');
  return `api/v2/${relative}`;
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new TransportError('RESPONSE_INVALID'); }
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Authenticated transport. Request methods are internal to the main service. */
export class GatewayTransport {
  private state: TransportConnection | null = null;
  private credential: DeviceIdentity | null = null;
  private token: { accessToken: string; expiresAt: number } | null = null;
  private tokenPending: Promise<void> | null = null;
  private pairingGeneration: number | null = null;
  private generation = 0;
  private readonly requests = new Set<AbortController>();
  private readonly eventClosers = new Set<() => void>();
  private readonly io: GatewayIO;
  private readonly now: () => number;
  constructor(private readonly options: { credentials: CredentialStore; io?: GatewayIO; now?: () => number }) {
    this.io = options.io ?? nodeGatewayIO; this.now = options.now ?? Date.now;
  }
  get connection(): TransportConnection | null { return this.state ? structuredClone(this.state) : null; }
  get identity(): TransportIdentity | null {
    const state = this.state;
    return state?.deviceId ? { endpoint: state.endpoint, installationId: state.installationId, deviceId: state.deviceId } : null;
  }
  /** An encrypted local identity may select an offline cache; it is never authentication. */
  savedIdentity(input: string): TransportIdentity | null {
    const metadata = this.options.credentials.metadataForEndpoint(normalizeEndpoint(input));
    return metadata?.paired ? { endpoint: metadata.endpoint, installationId: metadata.installationId, deviceId: metadata.deviceId } : null;
  }
  disconnect(): void {
    ++this.generation;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    for (const close of [...this.eventClosers]) close();
    this.eventClosers.clear(); this.state = null; this.credential = null; this.token = null; this.tokenPending = null; this.pairingGeneration = null;
  }
  async connect(input: string): Promise<TransportConnection> {
    const endpoint = normalizeEndpoint(input);
    this.disconnect(); const generation = this.generation;
    const health = await this.exchangeJson(endpoint, 'GET', 'health', undefined, false, generation);
    if (!validateContract('HealthResponse', health) || health.protocolMajor !== PROTOCOL.major) throw new TransportError('PROTOCOL_INCOMPATIBLE');
    this.checkGeneration(generation);
    this.state = { endpoint, installationId: health.installationId, deviceId: null, paired: false, epoch: null, capabilities: null, session: null };
    this.credential = this.options.credentials.load(endpoint, health.installationId);
    if (!this.credential) return this.connection!;
    this.state.deviceId = this.credential.deviceId;
    try { await this.refreshToken(generation); }
    catch (error) {
      // A saved pending identity may not have reached Gateway. Retain it; the user
      // may explicitly pair again. A successful lost ACK is recovered by token.
      if (!this.credential?.paired && error instanceof TransportError && error.code === 'UNAUTHENTICATED') return this.connection!;
      throw error;
    }
    await this.handshake(generation);
    return this.connection!;
  }
  async pair(code: string, label: string): Promise<TransportConnection> {
    if (!this.state) throw new TransportError('NOT_CONNECTED');
    if (this.state.paired) throw new TransportError('ALREADY_PAIRED');
    if (this.pairingGeneration !== null) throw new TransportError('PAIRING_IN_PROGRESS');
    const generation = this.generation;
    // Validate before creating an identity, then persist before any network write.
    const normalizedCode = typeof code === 'string' ? code.replace(/[\s-]/g, '').toUpperCase() : '';
    if (!/^[A-Z2-7]{32}$/.test(normalizedCode) || typeof label !== 'string' || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new TransportError('PAIR_INPUT_INVALID');
    this.pairingGeneration = generation;
    try {
      this.credential = this.options.credentials.create(this.state.endpoint, this.state.installationId);
      this.state.deviceId = this.credential.deviceId;
      const auth = await this.exchangeJson(this.state.endpoint, 'POST', 'api/v2/auth/pair', {
        installationId: this.credential.installationId, deviceId: this.credential.deviceId, deviceCredential: this.credential.deviceCredential,
        code: normalizedCode, label: label.trim(),
      }, false, generation);
      this.acceptAuth(auth, generation);
      await this.handshake(generation);
      return this.connection!;
    } finally { if (this.pairingGeneration === generation) this.pairingGeneration = null; }
  }
  async request<T = unknown>(method: HttpMethod, relativeApiPath: string, body?: unknown, beforeDispatch?: () => void): Promise<T> {
    this.assertMethod(method);
    const path = apiPath(relativeApiPath); const generation = this.generation;
    if (path === 'api/v2/auth/logout' && method !== 'POST') throw new TransportError('REQUEST_PATH_INVALID');
    await this.ensureToken(generation);
    return await this.exchangeJson(this.state!.endpoint, method, path, body, true, generation, beforeDispatch) as T;
  }
  async requestBytes(method: 'GET' | 'POST', relativeApiPath: string, options: { body?: Buffer; headers?: Record<string, string>; beforeDispatch?: () => void } = {}): Promise<ByteResponse> {
    if (method !== 'GET' && method !== 'POST') throw new TransportError('INVALID_REQUEST');
    const path = apiPath(relativeApiPath); const generation = this.generation;
    const headers: Record<string, string> = {};
    const supplied = options.headers ?? {};
    if (Object.keys(supplied).some(key => !['x-oraculum-upload', 'content-type', 'content-length'].includes(key.toLowerCase()))) throw new TransportError('INVALID_REQUEST');
    for (const [key, value] of Object.entries(supplied)) {
      if (typeof value !== 'string' || /[\r\n\0]/.test(value) || headers[key.toLowerCase()] !== undefined) throw new TransportError('INVALID_REQUEST');
      headers[key.toLowerCase()] = value;
    }
    if (method === 'GET' && (options.body !== undefined || Object.keys(headers).length)) throw new TransportError('INVALID_REQUEST');
    if (method === 'POST') {
      const encoded = headers['x-oraculum-upload'];
      if (!Buffer.isBuffer(options.body) || options.body.length > UPLOAD_LIMIT || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TransportError('INVALID_REQUEST');
      const metadata = json(Buffer.from(encoded, 'base64url'));
      if (!validateContract('AttachmentUploadMetadata', metadata) || metadata.size !== options.body.length
        || path !== `api/v2/threads/${encodeURIComponent(metadata.threadId)}/attachments`
        || (headers['content-type'] && headers['content-type'] !== 'application/octet-stream')
        || (headers['content-length'] && headers['content-length'] !== String(options.body.length))) throw new TransportError('INVALID_REQUEST');
      headers['content-type'] = 'application/octet-stream'; headers['content-length'] = String(options.body.length);
    }
    await this.ensureToken(generation);
    const response = await this.exchange(this.state!.endpoint, method, path, options.body, true, generation, method === 'GET' ? DOWNLOAD_LIMIT : JSON_LIMIT, headers, options.beforeDispatch);
    this.checkResponse(response);
    if (method === 'GET') {
      const digest = response.headers['content-digest'];
      const actual = createHash('sha256').update(response.bytes).digest('base64');
      if (digest !== `sha-256=:${actual}:` || (response.headers['content-length'] !== undefined && response.headers['content-length'] !== String(response.bytes.length))) throw new TransportError('FILE_DIGEST_MISMATCH');
    }
    return response;
  }
  async openEvents(cursor: { epoch?: string; afterSeq?: number }, onMessage: (message: GatewayEventMessage) => void, onClose: (error: TransportError) => void): Promise<() => void> {
    const generation = this.generation; await this.ensureToken(generation);
    const resume = { type: 'resume', epoch: cursor.epoch ?? this.state!.epoch, afterSeq: cursor.afterSeq ?? 0 };
    if (!validateContract('EventResume', resume)) throw new TransportError('EVENT_CURSOR_INVALID');
    let socket: GatewaySocket;
    try {
      socket = this.io.socket(websocketUrl(this.state!.endpoint), {
        headers: this.headers(true), handshakeTimeout: 10_000, maxPayload: EVENT_LIMIT,
        rejectUnauthorized: true, followRedirects: false,
      });
    } catch { throw new TransportError('EVENTS_CLOSED'); }
    let closed = false; let connected = false; let lastMessageAt = this.now();
    const finish = (code: string, notify: boolean) => {
      if (closed) return;
      closed = true; clearInterval(timer); this.eventClosers.delete(close);
      try { socket.terminate(); } catch { /* Never surface socket details. */ }
      if (notify && this.generation === generation) onClose(new TransportError(code));
    };
    const close = () => finish('EVENTS_CLOSED', false);
    const timer = setInterval(() => {
      if (this.generation !== generation) { close(); return; }
      if (!connected && this.now() - lastMessageAt > 10_000) { finish('EVENTS_TIMEOUT', true); return; }
      if (this.now() - lastMessageAt > 60_000) { finish('EVENTS_TIMEOUT', true); return; }
      if (!this.token || this.token.expiresAt <= this.now() + 15_000) { finish('AUTH_REFRESH_REQUIRED', true); return; }
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch { finish('EVENTS_CLOSED', true); }
      }
    }, 5_000);
    timer.unref(); this.eventClosers.add(close);
    socket.on('open', () => {
      if (this.generation !== generation) { close(); return; }
      try { socket.send(JSON.stringify(resume)); } catch { finish('EVENTS_CLOSED', true); }
    });
    socket.on('message', (data, isBinary) => {
      if (closed || this.generation !== generation) return;
      try {
        const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
        if (isBinary || bytes.length > EVENT_LIMIT) throw new TransportError('EVENT_INVALID');
        const message = json(bytes); const type = asRecord(message)?.type;
        if (type === 'connection') {
          if (connected || !validateContract('EventConnection', message) || message.installationId !== this.state!.installationId) throw new TransportError('EVENT_INVALID');
          connected = true;
        } else if (type === 'pong') {
          if (!connected || !validateContract('EventPong', message)) throw new TransportError('EVENT_INVALID');
        } else if (!connected || !validateContract('EventEnvelope', message) || message.installationId !== this.state!.installationId) throw new TransportError('EVENT_INVALID');
        lastMessageAt = this.now(); onMessage(message as GatewayEventMessage);
      } catch { finish('EVENT_INVALID', true); }
    });
    socket.on('error', () => finish('EVENTS_CLOSED', true));
    socket.on('close', () => finish('EVENTS_CLOSED', true));
    return close;
  }
  private checkGeneration(generation: number): void { if (generation !== this.generation) throw new TransportError('CONNECTION_CANCELLED'); }
  private assertMethod(method: HttpMethod): void { if (!['GET', 'POST', 'DELETE'].includes(method)) throw new TransportError('INVALID_REQUEST'); }
  private headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'x-oraculum-protocol': '2', accept: 'application/json' };
    if (authenticated) {
      if (!this.token) throw new TransportError('UNAUTHENTICATED');
      headers.authorization = `Bearer ${this.token.accessToken}`;
    }
    return headers;
  }
  private async ensureToken(generation: number): Promise<void> {
    this.checkGeneration(generation);
    if (!this.state || !this.credential || !this.state.paired) throw new TransportError('PAIRING_REQUIRED');
    if (!this.state.epoch || !this.state.capabilities || !this.state.session) throw new TransportError('HANDSHAKE_REQUIRED');
    if (!this.token || this.token.expiresAt <= this.now() + 15_000) await this.refreshToken(generation);
    this.checkGeneration(generation);
  }
  private async refreshToken(generation: number): Promise<void> {
    this.checkGeneration(generation);
    if (this.tokenPending) return this.tokenPending;
    const credential = this.credential;
    if (!this.state || !credential) throw new TransportError('PAIRING_REQUIRED');
    const pending = (async () => {
      const auth = await this.exchangeJson(credential.endpoint, 'POST', 'api/v2/auth/token', {
        installationId: credential.installationId, deviceId: credential.deviceId, deviceCredential: credential.deviceCredential,
      }, false, generation);
      this.acceptAuth(auth, generation);
    })();
    this.tokenPending = pending;
    try { await pending; } finally { if (this.tokenPending === pending) this.tokenPending = null; }
  }
  private acceptAuth(auth: unknown, generation: number): void {
    this.checkGeneration(generation);
    if (!validateContract('AuthResponse', auth) || !this.credential || !this.state
      || auth.deviceId !== this.credential.deviceId || auth.installationId !== this.credential.installationId
      || auth.expiresAt <= this.now() || auth.expiresAt > this.now() + 10 * 60_000 + 60_000) throw new TransportError('AUTH_RESPONSE_INVALID');
    this.options.credentials.markPaired(this.credential);
    this.credential = { ...this.credential, paired: true };
    this.token = { accessToken: auth.accessToken, expiresAt: auth.expiresAt };
    this.state.paired = true;
  }
  private async handshake(generation: number): Promise<void> {
    const endpoint = this.state!.endpoint;
    const [capabilityResponse, sessionResponse] = await Promise.all([
      this.exchangeJson(endpoint, 'GET', 'api/v2/capabilities', undefined, true, generation),
      this.exchangeJson(endpoint, 'GET', 'api/v2/auth/session', undefined, true, generation),
    ]);
    this.checkGeneration(generation);
    if (!validateContract('ResourceResponse', capabilityResponse) || !validateContract('ResourceResponse', sessionResponse)
      || !validateContract('Capabilities', capabilityResponse.data) || !validateContract('SessionResponse', sessionResponse.data)) throw new TransportError('HANDSHAKE_INVALID');
    const capabilities = capabilityResponse.data; const session = sessionResponse.data;
    if (capabilities.protocol.major !== PROTOCOL.major || capabilities.protocol.minClientMinor > PROTOCOL.minor) throw new TransportError('PROTOCOL_INCOMPATIBLE');
    if (capabilities.installationId !== this.state!.installationId || session.installationId !== this.state!.installationId
      || capabilityResponse.installationId !== this.state!.installationId || sessionResponse.installationId !== this.state!.installationId
      || session.deviceId !== this.credential!.deviceId || capabilities.epoch !== capabilityResponse.epoch
      || sessionResponse.epoch !== capabilityResponse.epoch) throw new TransportError('IDENTITY_MISMATCH');
    this.state!.capabilities = capabilities; this.state!.session = session; this.state!.epoch = capabilities.epoch;
  }
  private async exchangeJson(endpoint: string, method: HttpMethod, path: string, body: unknown, authenticated: boolean, generation: number, beforeDispatch?: () => void): Promise<unknown> {
    let bytes: Buffer | undefined;
    if (body !== undefined) {
      try { bytes = Buffer.from(JSON.stringify(body)); } catch { throw new TransportError('INVALID_REQUEST'); }
      if (bytes.length > REQUEST_LIMIT || method === 'GET') throw new TransportError('INVALID_REQUEST');
    }
    const response = await this.exchange(endpoint, method, path, bytes, authenticated, generation, JSON_LIMIT,
      bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}, beforeDispatch);
    this.checkResponse(response);
    if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) throw new TransportError('RESPONSE_INVALID');
    return json(response.bytes);
  }
  private async exchange(endpoint: string, method: HttpMethod, path: string, body: Buffer | undefined, authenticated: boolean, generation: number, maxBytes: number, extraHeaders: Record<string, string>, beforeDispatch?: () => void): Promise<ByteResponse> {
    this.checkGeneration(generation);
    const url = endpointUrl(endpoint, path); const controller = new AbortController(); this.requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new TransportError('REQUEST_TIMEOUT')); controller.abort(); }, DEADLINE_MS);
      timer.unref();
      controller.signal.addEventListener('abort', () => reject(new TransportError('CONNECTION_CANCELLED')), { once: true });
    });
    try {
      const input: GatewayHttpRequest = { url, method, headers: { ...this.headers(authenticated), ...extraHeaders }, body,
        signal: controller.signal, timeoutMs: DEADLINE_MS, maxBytes };
      // A main-only write guard rechecks live permission/scope after token refresh.
      // No await or asynchronous work separates the guard from handing bytes to IO.
      beforeDispatch?.();
      try {
        const response = await Promise.race([this.io.request(input), deadline]);
        this.checkGeneration(generation);
        if (!Buffer.isBuffer(response.bytes) || response.bytes.length > maxBytes) throw new TransportError('RESPONSE_TOO_LARGE');
        return { ...response, headers: responseHeaders(response.headers) };
      } catch (error) {
        if (error instanceof TransportError) throw error;
        throw new TransportError('CONNECTION_FAILED');
      }
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  private checkResponse(response: ByteResponse): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status >= 300 && response.status < 400) throw new TransportError('REDIRECT_REJECTED', response.status);
    let value: unknown;
    try { value = json(response.bytes); } catch { /* Error bodies never escape. */ }
    const code = validateContract('ErrorResponse', value) && KNOWN_CODES.has(value.error.code) ? value.error.code : 'GATEWAY_REJECTED';
    if (response.status === 401 || code === 'DEVICE_REVOKED') this.token = null;
    throw new TransportError(code, response.status);
  }
}
