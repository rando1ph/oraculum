import { useId, useState } from 'react';
import type { Interaction, InteractionAnswer } from '../../../../packages/gateway-protocol/src/index';
import { elicitationFields, validElicitationContent, type ElicitationField } from '../../../../packages/shared/elicitation';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import { record, string } from './Native';
import { canAnswerInteraction, hasPendingInteractionResponse } from './store';
import { FileChangeEvidence, validFileChangeContext } from './FileChangeEvidence';

type Value = string | number | boolean | string[];
type Decision = 'accept' | 'decline' | 'cancel';
export function approvalDecisions(interaction: Interaction): Decision[] {
  const values = interaction.request.availableDecisions;
  return (['accept', 'decline', 'cancel'] as const).filter(value => values === undefined || Array.isArray(values) && values.includes(value));
}
export function approvalLimitation(interaction: Interaction, relativeCwd?: '.'): string | undefined {
  const request = interaction.request;
  if (interaction.kind === 'fileChange') return '尚无与本次请求绑定的完整变更证据，当前仅可拒绝或取消。右侧普通 Diff 不代表本次审批范围。';
  if (request.truncated === true || request.detailsAvailable === true) return '审批内容不完整，当前不能允许此请求。';
  if ((interaction.kind === 'command' && string(request.command).includes('[主机路径]'))
    || (interaction.kind === 'permissions' && JSON.stringify(request.permissions ?? null).includes('[主机路径]')))
    return '请求包含当前客户端无法完整显示的主机路径，请在原生客户端审阅其完整范围。';
  if (interaction.kind === 'command') {
    if (request.kind !== undefined && request.kind !== 'command') return '当前客户端不能确认这类终端交互，请在原生客户端处理。';
    const network = request.networkApprovalContext;
    const context = record(network);
    const validNetwork = !!context && Object.keys(context).every(key => ['host', 'protocol'].includes(key))
      && typeof context.host === 'string' && context.host.length > 0 && !/[\s\x00-\x1f]/.test(context.host)
      && ['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(string(context.protocol));
    if (network !== undefined && network !== null && !validNetwork) return '网络访问范围无法完整显示，不能允许本次请求。';
    if (!string(request.command).trim() && !validNetwork) return '请求未提供可审阅的命令或网络访问范围。';
    if (string(request.command).trim() && relativeCwd !== '.') return '尚未确认此命令在当前项目根目录执行，当前不能允许。请在原生客户端审阅完整执行范围。';
  }
  return undefined;
}

export function InteractionCard({ interaction, state, disabled, act }: {
  interaction: Interaction; state: WorkspaceState; disabled: boolean;
  act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>;
}) {
  const form = useId();
  const [values, setValues] = useState<Record<string, Value>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [urlCompleted, setUrlCompleted] = useState(false);
  const request = interaction.request, kind = interaction.kind;
  const [submitted, setSubmitted] = useState(false);
  const pendingResponse = hasPendingInteractionResponse(state, interaction);
  const unavailable = submitted || !canAnswerInteraction(state, interaction, disabled);
  const fileChangeContext = validFileChangeContext(state, interaction);
  const commandScope = state.commandScopes && Object.hasOwn(state.commandScopes, interaction.interactionId)
    ? state.commandScopes[interaction.interactionId] : undefined;
  const relativeCwd = commandScope?.relativeCwd === '.' ? '.' : undefined;
  const labels: Record<string, string> = { command: '命令执行', fileChange: '文件变更', permissions: '本轮额外权限', input: '需要你的输入', elicitation: 'MCP / App 请求' };
  const questions = Array.isArray(request.questions) ? request.questions.map(record).filter((value): value is Record<string, unknown> => !!value) : [];
  const validQuestions = kind === 'input' && Array.isArray(request.questions) && questions.length === request.questions.length
    && questions.length <= 20 && questions.every(question => typeof question.id === 'string' && typeof question.question === 'string'
      && (question.options == null || Array.isArray(question.options) && question.options.every(option => typeof record(option)?.label === 'string')))
    && new Set(questions.map(question => question.id)).size === questions.length;
  const fields = kind === 'elicitation' && request.mode !== 'url' ? elicitationFields(request.requestedSchema) : null;
  const content: Record<string, unknown> = Object.fromEntries((fields ?? []).flatMap(field => {
    let value = values[field.id] ?? field.default;
    if (value === undefined || value === '' && field.type !== 'string') return [];
    if (field.type === 'number' || field.type === 'integer') value = typeof value === 'string' && value.trim() ? Number(value) : value;
    return [[field.id, value]];
  }));
  const validUrl = (() => { try { const url = new URL(string(request.url)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } })();
  const inputReady = validQuestions && questions.every(question => !!choices[string(question.id)] && choices[string(question.id)] !== '__other'
    || typeof values[string(question.id)] === 'string' && String(values[string(question.id)]).trim().length > 0);
  const limitation = kind === 'fileChange' && fileChangeContext ? undefined : approvalLimitation(interaction, relativeCwd);
  const decisions = approvalDecisions(interaction);
  const setValue = (id: string, value: Value) => setValues(current => ({ ...current, [id]: value }));

  async function answer(response: InteractionAnswer) {
    if (unavailable) return;
    if (response.type === 'approval' && response.decision === 'accept' && limitation) return;
    if (kind === 'fileChange' && response.decision === 'accept' && !fileChangeContext) return;
    const knownOperations = new Set(state.operations.map(operation => operation.operationId));
    setSubmitted(true);
    const next = await act({ type: 'answer', interactionId: interaction.interactionId, generation: interaction.generation, epoch: interaction.epoch, response,
      ...(kind === 'fileChange' && response.decision === 'accept' && fileChangeContext ? { contextDigest: fileChangeContext.digest } : {}) });
    // An explicit preflight failure remains pending and may be attempted again;
    // unknown/submitted status stays locked until an authoritative resolution.
    const newOperations = next?.operations.filter(operation => !knownOperations.has(operation.operationId) && operation.kind === 'interaction.respond') ?? [];
    if (next && next.interactions.some(item => item.interactionId === interaction.interactionId && item.status === 'pending')
      && newOperations.every(operation => operation.status === 'rejected')) setSubmitted(false);
    if (next && !next.interactions.some(item => item.interactionId === interaction.interactionId && item.status === 'pending')) { setValues({}); setChoices({}); }
  }
  function accept() {
    if (kind === 'input' && inputReady) void answer({ type: 'input', answers: Object.fromEntries(questions.map(question => {
      const id = string(question.id), choice = choices[id];
      return [id, [choice && choice !== '__other' ? choice : String(values[id] ?? '')]];
    })) });
    else if (kind === 'elicitation' && (request.mode === 'url' ? validUrl && urlCompleted : fields !== null && validElicitationContent(request.requestedSchema, content)))
      void answer({ type: 'elicitation', action: 'accept', content: request.mode === 'url' ? null : content });
    else if (!limitation && decisions.includes('accept')) void answer({ type: 'approval', decision: 'accept' });
  }
  return <article className="interaction-card" aria-label={labels[kind] ?? '原生请求'}>
    <header><span className="interaction-symbol">!</span><h2>{labels[kind] ?? kind}</h2><small>{interaction.status === 'pending' ? '等待回应' : interaction.status === 'unknown' ? '回应结果待核实' : '等待原生确认'}</small></header>
    {typeof request.reason === 'string' && <p>{request.reason}</p>}
    {kind === 'command' && <>{request.command && <pre>{string(request.command)}</pre>}{string(request.command).trim() && relativeCwd === '.' && <p>执行目录 · 当前项目根目录</p>}{record(request.networkApprovalContext) && <p>网络访问 · {string(record(request.networkApprovalContext)?.protocol)} · {string(record(request.networkApprovalContext)?.host)}</p>}</>}
    {kind === 'permissions' && <><p>允许后仅对当前 Turn 授权以下权限：</p><pre>{JSON.stringify(request.permissions, null, 2)}</pre></>}
    {fileChangeContext && <FileChangeEvidence context={fileChangeContext} />}
    {kind === 'elicitation' && <><p>{string(request.message)}</p><small>来源服务器 · {string(request.serverName)}</small>{record(request._meta)?.codex_approval_kind === 'mcp_tool_call' && <pre>{JSON.stringify(record(request._meta)?.tool_params_display ?? record(request._meta)?.tool_params, null, 2)}</pre>}</>}
    <form id={form} onSubmit={event => { event.preventDefault(); accept(); }}>
      {kind === 'input' && (validQuestions ? questions.map(question => {
        const id = string(question.id), options = Array.isArray(question.options) ? question.options.map(record) : [];
        return <fieldset key={id} disabled={unavailable}><legend>{string(question.header)}</legend><p>{string(question.question)}</p>
          {options.map((option, index) => <label className="native-choice" key={index}><input type="radio" name={`${form}-${id}`} checked={choices[id] === string(option?.label)} onChange={() => setChoices(current => ({ ...current, [id]: string(option?.label) }))} /><span>{string(option?.label)}<small>{string(option?.description)}</small></span></label>)}
          {!!options.length && question.isOther === true && <label className="native-choice"><input type="radio" name={`${form}-${id}`} checked={choices[id] === '__other'} onChange={() => setChoices(current => ({ ...current, [id]: '__other' }))} /><span>其他答案</span></label>}
          {(!options.length || question.isOther === true && choices[id] === '__other') && <label className="native-field"><span>{question.isSecret ? '保密答案' : '你的答案'}</span>{question.isSecret ? <input type="password" autoComplete="off" maxLength={16000} value={String(values[id] ?? '')} onChange={event => setValue(id, event.target.value)} /> : <textarea rows={3} maxLength={16000} value={String(values[id] ?? '')} onChange={event => setValue(id, event.target.value)} />}</label>}
        </fieldset>;
      }) : <p className="unavailable-note">无法完整解析此输入请求，请在原生客户端处理。</p>)}
      {kind === 'elicitation' && (request.mode === 'url' ? <><p>复制下面的地址，在外部浏览器完成操作后确认。</p><pre>{string(request.url)}</pre><label className="native-choice"><input type="checkbox" disabled={unavailable || !validUrl} checked={urlCompleted} onChange={event => setUrlCompleted(event.target.checked)} /><span>我已完成地址中的操作</span></label></> : fields === null ? <p className="unavailable-note">当前表单包含尚不支持的约束，仅可拒绝或取消。</p> : fields.map(field => <Field key={field.id} field={field} value={values[field.id] ?? field.default} disabled={unavailable} setValue={value => setValue(field.id, value)} />))}
    </form>
    {limitation && <p className="unavailable-note">{limitation}</p>}
    {pendingResponse && <p className="unavailable-note">本会话有原生回应等待核实。请先核实原操作，当前不能再次回应。</p>}
    <div className="interaction-actions">
      {kind === 'input' ? <button className="quiet-button" disabled={unavailable || !validQuestions} onClick={() => void answer({ type: 'input', answers: {} })}>跳过</button>
        : kind === 'elicitation' ? <><button className="quiet-button" disabled={unavailable} onClick={() => void answer({ type: 'elicitation', action: 'decline', content: null })}>拒绝</button><button className="quiet-button" disabled={unavailable} onClick={() => void answer({ type: 'elicitation', action: 'cancel', content: null })}>取消</button></>
          : decisions.filter(decision => decision !== 'accept').map(decision => <button className="quiet-button" key={decision} disabled={unavailable} onClick={() => void answer({ type: 'approval', decision })}>{decision === 'decline' ? '拒绝' : '取消'}</button>)}
      {(kind === 'input' || kind === 'elicitation' || decisions.includes('accept')) && <button className="primary-button" type="submit" form={form} disabled={unavailable || (kind === 'input' ? !inputReady : kind === 'elicitation' ? request.mode === 'url' ? !validUrl || !urlCompleted : fields === null || !validElicitationContent(request.requestedSchema, content) : !!limitation)}>{kind === 'input' ? '提交答案' : kind === 'elicitation' ? request.mode === 'url' ? '确认完成' : '提交并允许' : kind === 'permissions' ? '允许本轮' : '允许本次'}</button>}
    </div>
  </article>;
}

function Field({ field, value, disabled, setValue }: { field: ElicitationField; value?: Value; disabled: boolean; setValue: (value: Value) => void }) {
  const id = useId();
  if (field.type === 'array') return <fieldset disabled={disabled}><legend>{field.label}{field.required ? ' *' : ''}</legend><p>{field.description}</p>{field.options?.map(option => <label className="native-choice" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => setValue(event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : (Array.isArray(value) ? value : []).filter(item => item !== option.value))} /><span>{option.label}</span></label>)}</fieldset>;
  return <label className="native-field" htmlFor={id}><span>{field.label}{field.required ? ' *' : ''}</span><small>{field.description}</small>
    {field.type === 'boolean' ? <select id={id} disabled={disabled} value={value === undefined ? '' : String(value)} onChange={event => setValue(event.target.value === '' ? '' : event.target.value === 'true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
      : field.options ? <select id={id} disabled={disabled} value={value === undefined ? '' : String(field.options.findIndex(option => option.value === value))} onChange={event => setValue(event.target.value === '' ? '' : field.options![Number(event.target.value)].value)}><option value="">请选择</option>{field.options.map((option, index) => <option key={index} value={index}>{option.label || '（空值）'}</option>)}</select>
        : <input id={id} disabled={disabled} type={field.type === 'integer' || field.type === 'number' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'} value={String(value ?? '')} autoComplete="off" min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.type === 'number' ? 'any' : field.type === 'integer' ? 1 : undefined} onChange={event => setValue(event.target.value)} />}
  </label>;
}
