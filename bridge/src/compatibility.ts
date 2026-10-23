type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string';
const identifier = (value: unknown) => text(value) && value !== '';

export class CodexCompatibilityError extends Error {
  constructor(readonly version: string, readonly method: string, field: string) {
    super(`${version}: incompatible App Server ${method} response at ${field}; operation result may be unknown, do not retry automatically`);
  }
}

// Check the fields Oraculum actually consumes, not equality with the whole
// generated schema. Additive fields, new model names and unused metadata remain
// compatible. Never probe mutating methods merely to discover capabilities.
export function validateNativeResponse(version: string, method: string, result: unknown) {
  const require = (valid: boolean, field: string) => { if (!valid) throw new CodexCompatibilityError(version, method, field); };
  const object = (value: unknown, field: string): ObjectValue => { require(record(value), field); return value as ObjectValue; };
  const array = (value: unknown, field: string): unknown[] => { require(Array.isArray(value), field); return value as unknown[]; };
  const item = (value: unknown, path: string) => {
    const entry = object(value, path);
    require(identifier(entry.id), `${path}.id`);
    require(identifier(entry.type), `${path}.type`);
  };
  const turn = (value: unknown, path: string) => {
    const entry = object(value, path);
    require(identifier(entry.id), `${path}.id`);
    // These states control send blocking and receipt reconciliation.
    require(['inProgress', 'completed', 'interrupted', 'failed'].includes(entry.status as string), `${path}.status`);
    array(entry.items, `${path}.items`).forEach((value, index) => item(value, `${path}.items[${index}]`));
  };
  const thread = (value: unknown, path: string) => {
    const entry = object(value, path);
    require(identifier(entry.id), `${path}.id`);
    require(identifier(entry.cwd), `${path}.cwd`);
    require(text(entry.preview), `${path}.preview`);
    const status = object(entry.status, `${path}.status`);
    require(['notLoaded', 'idle', 'systemError', 'active'].includes(status.type as string), `${path}.status.type`);
    if (status.type === 'active') require(array(status.activeFlags, `${path}.status.activeFlags`).every(text), `${path}.status.activeFlags`);
    array(entry.turns, `${path}.turns`).forEach((value, index) => turn(value, `${path}.turns[${index}]`));
  };
  const page = (response: ObjectValue, validate: (value: unknown, path: string) => void) => {
    require(response.nextCursor === null || text(response.nextCursor), 'nextCursor');
    array(response.data, 'data').forEach((value, index) => validate(value, `data[${index}]`));
  };

  if (!['initialize', 'config/read', 'model/list', 'thread/list', 'thread/start', 'thread/resume',
    'thread/read', 'turn/start', 'turn/interrupt', 'thread/turns/list', 'thread/items/list'].includes(method)) return;
  const response = object(result, 'result');
  if (method === 'initialize') require(identifier(response.userAgent), 'userAgent');
  if (method === 'config/read') {
    const config = object(response.config, 'config');
    for (const key of ['model', 'model_provider', 'model_reasoning_effort']) require(config[key] === null || text(config[key]), `config.${key}`);
    for (const key of ['sandbox_mode', 'approvals_reviewer', 'web_search']) require(config[key] == null || text(config[key]), `config.${key}`);
    require(config.approval_policy == null || text(config.approval_policy) || record(config.approval_policy), 'config.approval_policy');
  }
  if (method === 'model/list') page(response, (value, path) => {
    const model = object(value, path);
    for (const key of ['id', 'model', 'displayName']) require(identifier(model[key]), `${path}.${key}`);
    array(model.supportedReasoningEfforts, `${path}.supportedReasoningEfforts`).forEach((value, index) => {
      require(identifier(object(value, `${path}.supportedReasoningEfforts[${index}]`).reasoningEffort), `${path}.supportedReasoningEfforts[${index}].reasoningEffort`);
    });
  });
  if (method === 'thread/list') page(response, thread);
  if (['thread/read', 'thread/start', 'thread/resume'].includes(method)) thread(response.thread, 'thread');
  if (method === 'thread/start' || method === 'thread/resume') {
    require(text(response.approvalPolicy) || record(response.approvalPolicy), 'approvalPolicy');
    require(identifier(object(response.sandbox, 'sandbox').type), 'sandbox.type');
    require(identifier(response.approvalsReviewer), 'approvalsReviewer');
  }
  if (method === 'turn/start') turn(response.turn, 'turn');
  if (method === 'thread/turns/list') page(response, turn);
  if (method === 'thread/items/list') page(response, (value, path) => {
    const entry = object(value, path);
    require(identifier(entry.turnId), `${path}.turnId`);
    item(entry.item, `${path}.item`);
  });
}
