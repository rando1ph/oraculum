import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import type { Readable } from 'node:stream';
import type { GatewayConfig } from './config';
import { GatewayService, receipt, type Authorized } from './service';
import { GatewayError } from './store';
import { record } from './codex';
import { assertContract, parseContract, ContractValidationError, type ContractName } from '../../packages/gateway-protocol/src/index';
const safeCode = (error: unknown) => record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
const statusFor = (error: unknown) => {
    if (error instanceof ContractValidationError)
        return 400;
    if (error instanceof GatewayError)
        return error.statusCode;
    if (record(error) && typeof error.code === 'string' && error.code.startsWith('FST_') && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500)
        return error.statusCode;
    const code = safeCode(error);
    if (code === 'INVALID_REQUEST' || code === 'INTERACTION_RESPONSE_INVALID')
        return 400;
    if (code === 'UNAUTHENTICATED')
        return 401;
    if (code === 'DEVICE_REVOKED' || code === 'INTERACTION_FORBIDDEN')
        return 403;
    if (/LIMIT|TOO_LARGE/.test(code) && code !== 'RATE_LIMITED')
        return 413;
    if (code === 'RATE_LIMITED' || code === 'HISTORY_BUSY')
        return 429;
    if (/STALE|CURSOR|CHANGED|UNAVAILABLE|ALREADY|UNKNOWN/.test(code))
        return 409;
    return 503;
};
const withoutUndefined = (value: unknown) => JSON.parse(JSON.stringify(value));
export async function createGatewayServer(service: GatewayService, config: GatewayConfig = service.config) {
    const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 120000, connectionTimeout: 15000,
        ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
    const base = config.basePath, api = base + 'api/v2';
    const host = `${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
    const remote = config.externalOrigin ? new URL(config.externalOrigin) : undefined;
    const meta = (request: FastifyRequest) => ({ requestId: request.id, installationId: service.store.installationId, epoch: service.epoch });
    const auth = (request: FastifyRequest): Authorized => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
            throw new GatewayError('UNAUTHENTICATED', 401, 'Authentication required');
        const token = header.slice(7), device = service.auth.authenticate(token);
        return { deviceId: device.id, check: () => { service.auth.authenticate(token); } };
    };
    const resource = (request: FastifyRequest, data: unknown, contract?: ContractName) => {
        const value = withoutUndefined(data);
        if (contract)
            assertContract(contract, value);
        const result = { ...meta(request), data: value };
        assertContract('ResourceResponse', result);
        return result;
    };
    const operation = (request: FastifyRequest, reply: FastifyReply, result: unknown) => {
        const value = { ...meta(request), operation: result };
        assertContract('OperationResponse', value);
        if (record(result) && result.status === 'unknown')
            reply.code(202);
        return value;
    };
    const params = (request: FastifyRequest) => request.params as Record<string, string>;
    const connections = new Set<() => void>();
    const deviceConnections = new Map<string, number>();
    app.server.maxConnections = 128;
    await app.register(websocket, { options: { maxPayload: 4096 } });
    app.addContentTypeParser('application/octet-stream', (request, payload, done) => { done(null, payload); });
    app.addHook('onRequest', async (request, reply) => {
        const supplied = request.headers.host, remoteHost = !!remote && supplied === remote.host;
        if ((supplied !== host && !remoteHost) || (remoteHost && request.headers['x-forwarded-proto'] !== 'https') ||
            (request.headers.origin && request.headers.origin !== (remoteHost ? remote!.origin : `http://${host}`)) || request.headers['sec-fetch-site'] === 'cross-site') {
            throw new GatewayError('UNTRUSTED_ORIGIN', 403, 'Untrusted request origin or transport');
        }
        const url = request.raw.url ?? '', path = url.split('?')[0]!;
        if (!/^\/[A-Za-z0-9._~/-]*$/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..'))
            throw new GatewayError('INVALID_REQUEST', 400, 'Non-canonical request path');
        if (!path.startsWith(base))
            throw new GatewayError('NOT_FOUND', 404, 'Unknown endpoint');
        if (request.headers['sec-websocket-protocol'])
            throw new GatewayError('INVALID_REQUEST', 400, 'WebSocket subprotocol credentials are not supported');
        const query = new URL(url, 'http://local.invalid').searchParams;
        if (['token', 'access_token', 'authorization', 'credential'].some(key => query.has(key)))
            throw new GatewayError('INVALID_REQUEST', 400, 'Credentials must use the Authorization header');
        if (path.startsWith(api) && request.headers['x-oraculum-protocol'] !== '2')
            throw new GatewayError('PROTOCOL_INCOMPATIBLE', 409, 'Gateway protocol major 2 is required');
        if (path.startsWith(api) && ![api + '/auth/pair', api + '/auth/token'].includes(path))
            auth(request);
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    });
    app.setErrorHandler((error, request, reply) => {
        const code = error instanceof ContractValidationError ? 'INVALID_REQUEST' : safeCode(error);
        const status = statusFor(error);
        reply.code(status).header('Cache-Control', 'no-store').send({ ...meta(request), error: { code,
                message: status >= 500 ? 'Gateway operation unavailable; query the receipt before any further write.' : 'Request rejected. Refresh authorization, scope, or state before continuing.',
                ...(record(error) && typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
                ...(/CURSOR|STALE/.test(code) ? { reset: true } : {}),
            } });
    });
    app.setNotFoundHandler((request, reply) => reply.code(404).send({ ...meta(request), error: { code: 'NOT_FOUND', message: 'Unknown Gateway endpoint' } }));
    app.get(base + 'health', async () => ({ status: 'ok', protocolMajor: 2, installationId: service.store.installationId }));
    app.post(api + '/auth/pair', async (request) => { const result = service.auth.pair(parseContract('PairRequest', request.body), request.ip); assertContract('AuthResponse', result); return result; });
    app.post(api + '/auth/token', async (request) => { const result = service.auth.token(parseContract('TokenRequest', request.body), request.ip); assertContract('AuthResponse', result); return result; });
    app.get(api + '/auth/session', async (request) => resource(request, service.auth.session(request.headers.authorization!.slice(7)), 'SessionResponse'));
    app.post(api + '/auth/logout', async (request, reply) => {
        const caller = auth(request), input = parseContract('LogoutRequest', request.body);
        service.store.transaction(() => { service.store.reserveOperation({ operationId: input.operationId, deviceId: caller.deviceId, kind: 'auth.logout' }); service.auth.revoke(caller.deviceId); service.store.finishOperation(input.operationId, 'accepted'); });
        return operation(request, reply, receipt(service.store.getOperation(input.operationId, caller.deviceId)!));
    });
    app.get(api + '/capabilities', async (request) => resource(request, service.capabilities(), 'Capabilities'));
    app.get(api + '/projects', async (request) => resource(request, { projects: await service.projects.list(), roots: config.allowedRoots.map(root => ({ id: root.id, label: root.id })) }, 'Projects'));
    app.post(api + '/project-directories/query', async (request) => { const q = parseContract('DirectoryQuery', request.body); return resource(request, await service.projects.queryDirectories(q.rootId, q.path, q.limit, q.cursor ?? undefined), 'DirectoryPage'); });
    app.post(api + '/projects', async (request, reply) => {
        const caller = auth(request), q = parseContract('ProjectRegisterRequest', request.body);
        await service.projects.register(q.rootId, q.path, { operation: { operationId: q.operationId, deviceId: caller.deviceId } });
        return operation(request, reply, receipt(service.store.getOperation(q.operationId, caller.deviceId)!));
    });
    app.delete(api + '/projects/:projectId', async (request, reply) => {
        const caller = auth(request), q = parseContract('ProjectUnregisterRequest', request.body), projectId = params(request).projectId!;
        await service.projects.validate(projectId);
        caller.check();
        if (service.store.hasUnknownOperation(projectId))
            throw new GatewayError('OPERATION_UNKNOWN', 409, 'Project has unknown operations');
        service.projects.unregister(projectId, { operation: { operationId: q.operationId, deviceId: caller.deviceId } });
        return operation(request, reply, receipt(service.store.getOperation(q.operationId, caller.deviceId)!));
    });
    app.get(api + '/models', async (request) => resource(request, await service.codex.listModels({ limit: 100 }), 'ModelPage'));
    app.get(api + '/projects/:projectId/extensions', async (request) => resource(request, await service.extensions(auth(request), params(request).projectId!), 'ExtensionsSnapshot'));
    app.get(api + '/projects/:projectId/threads', async (request) => {
        const query = request.query as Record<string, string>, q = parseContract('ThreadQuery', { ...query, ...(query.limit ? { limit: Number(query.limit) } : {}), ...(query.archived ? { archived: query.archived === 'true' ? true : query.archived === 'false' ? false : query.archived } : {}) });
        return resource(request, await service.listThreads(auth(request), params(request).projectId!, q), 'ThreadPage');
    });
    app.post(api + '/projects/:projectId/threads', async (request, reply) => operation(request, reply, await service.startThread(auth(request), params(request).projectId!, parseContract('ThreadStartRequest', request.body))));
    app.get(api + '/projects/:projectId/threads/:threadId', async (request) => {
        const p = params(request), thread = await service.requireThread(auth(request), p.projectId!, p.threadId!);
        return resource(request, service.threadView(thread, p.projectId!), 'Thread');
    });
    app.post(api + '/threads/:threadId/resume', async (request, reply) => operation(request, reply, await service.resumeThread(auth(request), params(request).threadId!, parseContract('ThreadResumeRequest', request.body))));
    app.post(api + '/threads/:threadId/turns', async (request, reply) => operation(request, reply, await service.startTurn(auth(request), params(request).threadId!, parseContract('TurnStartRequest', request.body))));
    app.post(api + '/threads/:threadId/turns/:turnId/interrupt', async (request, reply) => operation(request, reply, await service.interrupt(auth(request), params(request).threadId!, params(request).turnId!, parseContract('TurnInterruptRequest', request.body))));
    app.post(api + '/threads/:threadId/history/query', async (request) => resource(request, await service.historyPage(auth(request), params(request).threadId!, parseContract('HistoryQuery', request.body)), 'HistoryPage'));
    app.post(api + '/threads/:threadId/history/details', async (request) => resource(request, await service.itemDetails(auth(request), params(request).threadId!, parseContract('ItemDetailsRequest', request.body)), 'ItemDetails'));
    app.post(api + '/threads/:threadId/snapshot', async (request) => { const q = parseContract('SnapshotRequest', request.body); return resource(request, await service.snapshot(auth(request), params(request).threadId!, q.projectId), 'Snapshot'); });
    app.post(api + '/interactions/:interactionId/response', async (request, reply) => operation(request, reply, await service.answer(auth(request), params(request).interactionId!, parseContract('InteractionResponseRequest', request.body))));
    app.get(api + '/operations/:operationId', async (request) => {
        const caller = auth(request), id = params(request).operationId!, value = service.store.getOperation(id, caller.deviceId);
        if (!value)
            throw new GatewayError('OPERATION_NOT_FOUND', 404, 'Receipt unavailable; absence is not proof of non-execution');
        return resource(request, { ...receipt(value), ...(service.attachments.forUploadOperation(id, caller.deviceId) ? { attachment: service.attachments.forUploadOperation(id, caller.deviceId) } : {}) }, 'OperationQueryResult');
    });
    app.post(api + '/projects/:projectId/files/query', async (request) => { const q = parseContract('FilesQuery', request.body); return resource(request, await service.files.query(params(request).projectId!, q.path, q.limit, q.cursor ?? undefined), 'FilePage'); });
    app.post(api + '/projects/:projectId/files/select', async (request) => {
        const caller = auth(request), q = parseContract('FileSelectRequest', request.body), projectId = params(request).projectId!;
        if (q.threadId)
            await service.requireThread(caller, projectId, q.threadId);
        const result = await service.files.select({ deviceId: caller.deviceId, projectId, threadId: q.threadId, path: q.path, authorized: () => { try {
                caller.check();
                return true;
            }
            catch {
                return false;
            } } });
        return resource(request, result, 'FileGrant');
    });
    app.get(api + '/files/:fileId/content', async (request, reply) => {
        const caller = auth(request), fileId = params(request).fileId!, scope = service.files.scope(fileId, caller.deviceId), epoch = service.epoch;
        if (scope.threadId)
            await service.requireThread(caller, scope.projectId, scope.threadId);
        const result = await service.files.content(fileId, { deviceId: caller.deviceId, ...scope, authorized: () => { try {
                caller.check();
                return true;
            }
            catch {
                return false;
            } }, validate: async () => { caller.check(); if (epoch !== service.epoch)
                throw new GatewayError('STALE_EPOCH', 409, 'Native connection changed'); await service.projects.validate(scope.projectId); } });
        reply.header('Content-Digest', `sha-256=:${Buffer.from(result.digest, 'hex').toString('base64')}:`).header('Content-Type', result.mime).header('Content-Length', result.size).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`);
        return reply.send(result.stream);
    });
    app.post(api + '/threads/:threadId/attachments', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
        const raw = request.headers['x-oraculum-upload'];
        if (typeof raw !== 'string' || raw.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(raw) || request.headers['content-type'] !== 'application/octet-stream')
            throw new GatewayError('INVALID_REQUEST', 400, 'Invalid upload metadata');
        let parsed: unknown;
        try {
            parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        }
        catch {
            throw new GatewayError('INVALID_REQUEST', 400, 'Invalid upload metadata');
        }
        const q = parseContract('AttachmentUploadMetadata', parsed);
        if (q.threadId !== params(request).threadId || Number(request.headers['content-length']) !== q.size)
            throw new GatewayError('INVALID_REQUEST', 400, 'Upload length or scope mismatch');
        return operation(request, reply, await service.upload(auth(request), q, request.body as Readable));
    });
    app.delete(api + '/attachments/:attachmentId', async (request, reply) => operation(request, reply, await service.removeAttachment(auth(request), params(request).attachmentId!, parseContract('AttachmentDeleteRequest', request.body))));
    app.get(api + '/events', { websocket: true }, (socket, request) => {
        let caller: Authorized;
        try {
            caller = auth(request);
            service.observe(caller.deviceId);
        }
        catch {
            socket.close(1008, 'Authentication or capacity unavailable');
            return;
        }
        if (connections.size >= 64 || (deviceConnections.get(caller.deviceId) ?? 0) >= 4) {
            socket.close(1008, 'Event connection limit');
            return;
        }
        deviceConnections.set(caller.deviceId, (deviceConnections.get(caller.deviceId) ?? 0) + 1);
        let unsubscribe: (() => void) | undefined;
        let resumed = false, closing = false;
        const send = (value: unknown) => {
            caller.check();
            if (socket.bufferedAmount > 2 * 1024 * 1024)
                throw new Error('Slow client');
            if (record(value) && typeof value.seq === 'number')
                assertContract('EventEnvelope', value);
            socket.send(JSON.stringify(value));
        };
        const deadline = Date.now() + 10000;
        const cleanup = () => {
            if (closing)
                return;
            closing = true;
            clearInterval(timer);
            unsubscribe?.();
            socket.close(1008, 'Connection closed; renew authorization or resume events');
            const terminate = setTimeout(() => socket.terminate(), 1000);
            terminate.unref();
            socket.once('close', () => clearTimeout(terminate));
        };
        const timer = setInterval(() => { try {
            caller.check();
            if (!resumed && Date.now() > deadline)
                cleanup();
        }
        catch {
            cleanup();
        } }, 1000);
        timer.unref();
        connections.add(cleanup);
        socket.on('close', () => {
            clearInterval(timer);
            unsubscribe?.();
            connections.delete(cleanup);
            const remaining = (deviceConnections.get(caller.deviceId) ?? 1) - 1;
            if (remaining)
                deviceConnections.set(caller.deviceId, remaining);
            else
                deviceConnections.delete(caller.deviceId);
        });
        socket.on('error', cleanup);
        socket.on('message', data => {
            try {
                caller.check();
                const message: unknown = JSON.parse(data.toString());
                if (record(message) && message.type === 'ping') {
                    assertContract('EventHeartbeat', message);
                    send({ type: 'pong', epoch: service.epoch });
                    return;
                }
                const cursor = parseContract('EventResume', message);
                if (resumed)
                    throw new Error('Already subscribed');
                resumed = true;
                unsubscribe = service.feeds.subscribe(caller.deviceId, event => { try {
                    send(event);
                }
                catch {
                    cleanup();
                } });
                const replay = service.feeds.replay(caller.deviceId, cursor);
                send({ type: 'connection', installationId: service.store.installationId, epoch: service.epoch, headSeq: replay.headSeq, resetRequired: replay.resetRequired });
                for (const event of replay.events)
                    send(event);
            }
            catch {
                cleanup();
            }
        });
    });
    app.addHook('preClose', async () => { for (const close of connections)
        close(); });
    return app;
}
