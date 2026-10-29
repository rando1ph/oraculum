import { useEffect, useRef, useState } from 'react';
import type { BridgeClient } from '../../../packages/shared/client';
import type { ExtensionEntry, ExtensionKind, ExtensionsOverview } from '../../../packages/shared/extensions';
import { Icon } from './icons';
import './extensions.css';

const labels: Record<ExtensionKind, string> = { skills: 'Skills', mcp: 'MCP', apps: 'Apps', plugins: 'Plugins' };
const states: Record<string, string> = { notStarted: '尚未启动', starting: '连接中', connected: '已连接', authenticationRequired: '需要认证', failed: '连接失败', cancelled: '已取消', disabled: '已禁用' };
const auth: Record<string, string> = { unknown: '认证状态未知', unsupported: '不提供认证状态', notLoggedIn: '未登录', bearerToken: '令牌认证', oAuth: 'OAuth 认证' };

export function ExtensionRow({ entry, kind }: { entry: ExtensionEntry; kind: ExtensionKind }) {
  const badges = [...new Set([entry.installed === true ? '已安装' : entry.installed === false ? '未安装' : '',
    kind === 'mcp' ? entry.enabled === false ? '已禁用' : '已配置' : entry.enabled === null ? '启用状态未知' : entry.enabled ? '已启用' : '已禁用',
    kind === 'apps' ? entry.callable === true ? '可调用' : entry.callable === false ? '不可调用' : '调用状态未知' : '',
    kind === 'mcp' ? states[entry.runtimeStatus ?? ''] ?? '运行状态未知' : '',
    kind === 'plugins' && entry.available === false ? '管理员限制' : '',
  ].filter(Boolean))];
  return <li className="extension-entry">
    <div className="extension-name">{entry.name}</div>
    <div className="extension-badges">{badges.map((badge, index) => <span key={index}>{badge}</span>)}</div>
    {entry.description && <p>{entry.description}</p>}
    <small>{entry.source}{kind === 'mcp' ? ` · ${auth[entry.authStatus ?? ''] ?? '认证状态未知'}${entry.toolCount == null ? '' : ` · 已发现 ${entry.toolCount} 个工具`}` : ''}</small>
  </li>;
}

export function ExtensionSettings({ client, cwd, threadId, connected }: { client: BridgeClient | null; cwd: string; threadId?: string; connected: boolean }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState<ExtensionsOverview>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  async function refresh() {
    if (!client || !connected || !cwd) return;
    const ticket = ++generation.current;
    setBusy(true); setError(''); setValue(undefined);
    try {
      const result = await client.request<ExtensionsOverview>('bridge/extensions', { cwd, ...(threadId ? { threadId } : {}) });
      if (ticket === generation.current && result.cwd === cwd && result.threadId === (threadId ?? null)) setValue(result);
    } catch { if (ticket === generation.current) setError('扩展状态暂时不可用，请稍后刷新。'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  useEffect(() => {
    ++generation.current; setValue(undefined); setError(''); setBusy(false);
    if (open && connected) void refresh();
    return () => { ++generation.current; };
  }, [cwd, threadId, connected, client, open]);
  return <details className="extension-settings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="settings" size={17}/><span>原生扩展</span><small>Skills · MCP · Apps · Plugins</small></summary>
    {open && <div className="extension-content" aria-busy={busy}>
      <div className="extension-toolbar"><span>当前项目 · 只读</span><button disabled={!connected || !cwd || busy} onClick={() => void refresh()}><Icon name="refresh" size={14}/>刷新扩展</button></div>
      <p>沿用 Codex 已有扩展。可调用性由原生工具与权限策略决定。</p>
      {!connected ? <p role="status">连接已断开，扩展状态尚未确认。</p> : busy ? <p role="status">正在读取扩展…</p> : error ? <p role="status">{error}</p> : null}
      {value && (Object.keys(labels) as ExtensionKind[]).map(kind => {
        const list = value.lists[kind];
        return <details className="extension-group" key={kind} data-extension-kind={kind}>
          <summary><span>{labels[kind]}</span><small>{list.status === 'unsupported' ? '不支持' : list.status === 'unavailable' ? '暂不可用' : `${list.entries.length} 项${list.status === 'partial' ? ' · 部分可用' : ''}`}</small></summary>
          {list.message && <p className="extension-notice" role="status">{list.message}</p>}
          {!list.entries.length && list.status === 'ready' && <p className="extension-notice">{kind === 'plugins' ? '原生列表未返回已安装或已启用的插件。' : '原生列表暂无项目。'}</p>}
          {!!list.entries.length && <ul className="extension-list" aria-label={`${labels[kind]} 扩展列表`}>{list.entries.map(entry => <ExtensionRow key={entry.id} entry={entry} kind={kind}/>)}</ul>}
          {kind === 'plugins' && <p className="extension-notice">仅展示原生列表返回的安装与启用状态，列表可能与插件详情存在差异。</p>}
        </details>;
      })}
      <p className="extension-note">扩展安装与配置请使用官方 Codex；MCP OAuth 认证请在 Ubuntu 终端使用官方命令。</p>
    </div>}
  </details>;
}
