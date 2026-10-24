import { useId, useState } from 'react';
import type { Approval } from '../../../packages/shared/protocol';
import { elicitationFields, isRecord, type ElicitationField } from '../../../packages/shared/elicitation';
import { Copy } from './content';

type Reply = { decision: 'accept' | 'decline' | 'cancel' } | { result: unknown };
type Props = { request: Approval; busy: boolean; canAccept: boolean; canReply: boolean; reply: (value: Reply) => void };
type Value = string | number | boolean | string[];

export function NativeRequest({ request, busy, canAccept, canReply, reply }: Props) {
  const { params } = request;
  const formId = useId();
  const [values, setValues] = useState<Record<string, Value>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [urlCompleted, setUrlCompleted] = useState(false);
  const labels = {
    'item/commandExecution/requestApproval': request.method === 'item/commandExecution/requestApproval' && request.params.kind === 'writeStdin' ? '终端输入' : '命令执行', 'item/fileChange/requestApproval': '文件变更',
    'item/permissions/requestApproval': '额外权限', 'item/tool/requestUserInput': '用户输入',
    'mcpServer/elicitation/request': 'MCP / App 请求',
  };
  const input = request.method === 'item/tool/requestUserInput';
  const mcp = request.method === 'mcpServer/elicitation/request' ? request.params : null;
  const fields = mcp && mcp.mode !== 'url' ? elicitationFields(mcp.requestedSchema) : null;
  const toolConsent = mcp && isRecord(mcp._meta) && mcp._meta.codex_approval_kind === 'mcp_tool_call' ? mcp._meta : null;
  const disabled = busy || !canReply;
  const setValue = (key: string, value: Value) => setValues(current => ({ ...current, [key]: value }));
  function accept() {
    if (disabled || !canAccept || !inputReady || mcp && (mcp.mode === 'url' ? !urlCompleted : fields === null)) return;
    if (request.method === 'item/tool/requestUserInput') {
      reply({ result: { answers: Object.fromEntries(request.params.questions.map(question => {
        const selected = choices[question.id];
        const answer = selected && selected !== 'other' ? question.options?.[Number(selected)]?.label : values[question.id];
        return [question.id, { answers: typeof answer === 'string' && answer.trim() ? [answer] : [] }];
      })) } });
    } else if (mcp) {
      const content = mcp.mode === 'url' ? null : Object.fromEntries((fields ?? []).flatMap(field => {
        const value = values[field.id] ?? field.default ?? (field.required && field.type === 'string' && !field.options ? '' : undefined);
        if (value === undefined || value === '' && (field.type !== 'string' || field.options && !field.options.some(option => option.value === ''))) return [];
        return [[field.id, field.type === 'number' || field.type === 'integer' ? Number(value) : value]];
      }));
      reply({ result: { action: 'accept', content } });
    } else reply({ decision: 'accept' });
  }
  const inputReady = request.method !== 'item/tool/requestUserInput' || request.params.questions.every(question => {
    const selected = choices[question.id];
    return selected && selected !== 'other' || typeof values[question.id] === 'string' && String(values[question.id]).trim();
  });
  return <article data-theme-slot="approval" className="approval" data-native-method={request.method}>
    <div className="approval-heading"><span className="approval-symbol">!</span><h2>{input ? '需要你的输入' : '需要审批'}</h2><span>{labels[request.method]}</span></div>
    {!!request.displayThreadIds?.length && <p className="path">来自子代理的请求</p>}
    {'reason' in params && <p>{params.reason ?? 'Codex 请求确认本次操作'}</p>}
    {request.method === 'item/commandExecution/requestApproval' && <><pre>{request.params.command ?? '未提供命令内容'}</pre>{request.params.networkApprovalContext && <p>网络访问 · {request.params.networkApprovalContext.protocol} · {request.params.networkApprovalContext.host}</p>}<small className="path">工作目录 · {request.params.cwd}</small></>}
    {request.method === 'item/fileChange/requestApproval' && request.params.grantRoot && <p>此请求涉及写入目录权限：{request.params.grantRoot}</p>}
    {request.method === 'item/permissions/requestApproval' && <><p>允许将授予以下权限，持续至本轮结束。</p><pre aria-label="请求的额外权限">{JSON.stringify(request.params.permissions, null, 2)}</pre><small className="path">工作目录 · {request.params.cwd}</small></>}
    {mcp && <><p>{mcp.message}</p><small>来源服务器 · {mcp.serverName}</small></>}
    {toolConsent && <><p>工具 · {typeof toolConsent.tool_name === 'string' ? toolConsent.tool_name : '未提供名称'}</p><pre aria-label="待授权工具参数">{JSON.stringify(toolConsent.tool_params_display ?? toolConsent.tool_params ?? null, null, 2)}</pre></>}
    <form className="native-request-form" id={formId} onSubmit={event => { event.preventDefault(); accept(); }}>
      {request.method === 'item/tool/requestUserInput' && request.params.questions.map(question => <fieldset key={question.id} disabled={disabled}>
        <legend>{question.header}</legend><p>{question.question}</p>
        {question.options?.map((option, index) => <label className="native-choice" key={index}><input type="radio" name={`${formId}:${question.id}`} value={index} checked={choices[question.id] === String(index)} onChange={() => setChoices(current => ({ ...current, [question.id]: String(index) }))}/><span>{option.label}<small>{option.description}</small></span></label>)}
        {!!question.options?.length && question.isOther && <label className="native-choice"><input type="radio" name={`${formId}:${question.id}`} value="other" checked={choices[question.id] === 'other'} onChange={() => setChoices(current => ({ ...current, [question.id]: 'other' }))}/><span>其他答案</span></label>}
        {(!question.options?.length || question.isOther && choices[question.id] === 'other') && <label className="native-field"><span>{question.isSecret ? '保密答案' : '你的答案'}</span>{question.isSecret
          ? <input type="password" autoComplete="off" maxLength={16000} value={String(values[question.id] ?? '')} onChange={event => setValue(question.id, event.target.value)} required/>
          : <textarea rows={3} maxLength={16000} value={String(values[question.id] ?? '')} onChange={event => setValue(question.id, event.target.value)} required/>}</label>}
      </fieldset>)}
      {mcp?.mode === 'url' && <><p>复制完整地址，在外部浏览器完成操作后确认。</p><div className="native-url"><code>{mcp.url}</code><Copy text={mcp.url}/></div><label className="native-choice"><input type="checkbox" checked={urlCompleted} onChange={event => setUrlCompleted(event.target.checked)} disabled={disabled}/><span>我已在外部浏览器完成操作</span></label></>}
      {mcp && mcp.mode !== 'url' && (fields === null ? <p role="alert">当前客户端尚不支持此表单结构。请拒绝或取消，并联系维护者检查此表单。</p> : fields.map(field => <Field key={field.id} field={field} value={values[field.id] ?? field.default} disabled={disabled} setValue={value => setValue(field.id, value)}/>))}
    </form>
    <div className="approval-actions">
      {input ? <button disabled={disabled} onClick={() => reply({ result: { answers: {} } })}>跳过</button> : <button disabled={disabled} onClick={() => reply(mcp ? { result: { action: 'decline', content: null } } : { decision: 'decline' })}>拒绝</button>}
      {mcp && <button disabled={disabled} onClick={() => reply({ result: { action: 'cancel', content: null } })}>取消</button>}
      <button className="primary" type="submit" form={formId} disabled={disabled || !canAccept || !inputReady || !!mcp && (mcp.mode === 'url' ? !urlCompleted : fields === null)}>{input ? '提交答案' : mcp ? mcp.mode === 'url' ? '确认完成' : '提交并允许' : request.method === 'item/permissions/requestApproval' ? '允许本轮' : '允许本次'}</button>
    </div>
  </article>;
}

function Field({ field, value, disabled, setValue }: { field: ElicitationField; value: Value | undefined; disabled: boolean; setValue: (value: Value) => void }) {
  const id = useId();
  const label = `${field.label}${field.required ? ' *' : ''}`;
  if (field.type === 'array') return <fieldset disabled={disabled}><legend>{label}</legend>{field.description && <p>{field.description}</p>}{field.options?.map(option => <label className="native-choice" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => setValue(event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : (Array.isArray(value) ? value : []).filter(item => item !== option.value))}/><span>{option.label}</span></label>)}</fieldset>;
  return <div className="native-field"><label htmlFor={id}>{label}</label>{field.description && <small>{field.description}</small>}
    {field.type === 'boolean' ? <select id={id} disabled={disabled} value={value === undefined ? '' : String(value)} required={field.required} onChange={event => setValue(event.target.value === '' ? '' : event.target.value === 'true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
      : field.options ? <select id={id} disabled={disabled} value={value === undefined ? '' : String(field.options.findIndex(option => option.value === value))} required={field.required} onChange={event => setValue(event.target.value === '' ? '' : field.options![Number(event.target.value)].value)}><option value="">请选择</option>{field.options.map((option, index) => <option key={index} value={index}>{option.label || '（空值）'}</option>)}</select>
      : <input id={id} disabled={disabled} type={field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'} value={String(value ?? '')} required={field.required && (field.type !== 'string' || !!field.minLength || !!field.format)} min={field.minimum} max={field.maximum} step={field.type === 'number' ? 'any' : field.type === 'integer' ? 1 : undefined} minLength={field.minLength} maxLength={field.maxLength} autoComplete="off" placeholder={field.format === 'date-time' ? '2026-10-23T10:00:00+08:00' : undefined} onChange={event => setValue(event.target.value)}/>}
  </div>;
}
