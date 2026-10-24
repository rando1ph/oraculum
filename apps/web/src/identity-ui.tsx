import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { appUrl } from '../../../packages/shared/entry';
import { OracleEye } from './brand';
import { AVATAR_SIZE, avatarBlob, centeredCrop, decodeAvatarFile, defaultNames, drawCrop, emptyIdentities, exportAvatar, normalizeNickname, parseIdentities, type Crop, type Identities, type Identity, type IdentityRole } from './identity';
import './identity.css';

const IdentityContext = createContext<{ identities: Identities; save: (role: IdentityRole, value: Identity) => void }>({ identities: emptyIdentities(), save: () => {} });
export function IdentityProvider({ children }: { children: ReactNode }) {
  const key = `oraculum.identities.v1:${appUrl('').pathname}`;
  const [identities, setIdentities] = useState(() => {
    try { return parseIdentities(localStorage.getItem(key)); } catch { return emptyIdentities(); }
  });
  const current = useRef(identities);
  function save(role: IdentityRole, value: Identity) {
    const next = { ...current.current, [role]: { ...value, nickname: normalizeNickname(value.nickname) } };
    try { localStorage.setItem(key, JSON.stringify({ version: 1, ...next })); }
    catch { throw new Error('本机存储空间不足或不可用，未保存；原设置已保留。'); }
    current.current = next; setIdentities(next);
  }
  return <IdentityContext.Provider value={{ identities, save }}>{children}</IdentityContext.Provider>;
}
export function Avatar({ role, avatar, className = '' }: { role: IdentityRole; avatar: string | null; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), [ready, setReady] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (avatar) void createImageBitmap(avatarBlob(avatar)).then(picture => {
      if (!cancelled && canvas.current) { drawCrop(canvas.current, picture, centeredCrop()); setReady(avatar); }
      picture.close();
    }).catch(() => { if (!cancelled) setReady(''); });
    return () => { cancelled = true; };
  }, [avatar]);
  const custom = !!avatar && ready === avatar;
  return <>
    <canvas ref={canvas} width={AVATAR_SIZE} height={AVATAR_SIZE} className={`message-avatar custom-avatar ${className}`} hidden={!custom} aria-hidden="true"/>
    {!custom && (role === 'assistant' ? <OracleEye className={`message-avatar ${className}`}/> : <svg className={`message-avatar user-avatar ${className}`} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="16" cy="12" r="4"/><path d="M8 25v-2a8 8 0 0 1 16 0v2"/></svg>)}
  </>;
}
export function MessageIdentity({ role }: { role: IdentityRole }) {
  const value = useContext(IdentityContext).identities[role];
  return <><Avatar role={role} avatar={value.avatar}/><span className={`message-name ${role === 'user' ? 'user-label' : ''}`}>{value.nickname || defaultNames[role]}</span></>;
}
function IdentityEditor({ role }: { role: IdentityRole }) {
  const { identities, save } = useContext(IdentityContext), saved = identities[role];
  const [nickname, setNickname] = useState(saved.nickname), [avatar, setAvatar] = useState(saved.avatar);
  const [picture, setPicture] = useState<ImageBitmap | null>(null), [crop, setCrop] = useState(centeredCrop);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const picker = useRef<HTMLInputElement>(null), preview = useRef<HTMLCanvasElement>(null), epoch = useRef(0);
  const label = role === 'user' ? '用户' : 'Codex';
  useEffect(() => () => { ++epoch.current; }, []);
  useEffect(() => () => picture?.close(), [picture]);
  useEffect(() => { if (picture && preview.current) drawCrop(preview.current, picture, crop); }, [picture, crop]);
  const changed = nickname !== saved.nickname || avatar !== saved.avatar;
  function persist(value: Identity) {
    setError(''); setNotice('');
    try { save(role, value); setNickname(value.nickname); setAvatar(value.avatar); setNotice('已保存到本机'); }
    catch (reason) { setError((reason as Error).message); }
  }
  return <section className="identity-card" aria-label={`${label}身份`} data-identity-role={role}>
    <div className="identity-card-heading"><span>{label}</span><span className="identity-role-hint">{role === 'user' ? '你的显示身份' : 'AI 的显示身份'}</span></div>
    <div className="identity-fields"><div className="identity-preview"><Avatar role={role} avatar={avatar}/></div>
      <label>{label}昵称<input aria-label={`${label}昵称`} autoComplete="off" maxLength={64} value={nickname} placeholder={defaultNames[role]} onChange={event => { setNickname(event.target.value); setError(''); setNotice(''); }}/><small>最多 32 个字符 · 留空使用默认昵称</small></label></div>
    <input ref={picker} className="identity-file" type="file" accept="image/jpeg,image/png,image/webp" aria-label={`${label}头像文件`} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const ticket = ++epoch.current; setBusy(true); setError(''); setNotice('');
      void decodeAvatarFile(file).then(next => {
        if (ticket !== epoch.current) { next.close(); return; }
        setCrop(centeredCrop()); setPicture(next);
      }).catch(reason => { if (ticket === epoch.current) setError((reason as Error).message); })
        .finally(() => { if (ticket === epoch.current) setBusy(false); });
    }}/>
    <div className="identity-actions"><button type="button" disabled={busy || !!picture} onClick={() => picker.current?.click()}>{busy ? '正在读取…' : avatar ? '替换头像' : '选择图片'}</button><button type="button" disabled={busy || !!picture || !avatar} onClick={() => { setAvatar(null); setNotice(''); }}>移除头像</button></div>
    {picture && <div className="avatar-crop" role="group" aria-label={`${label}头像裁切`}>
      <div className="avatar-crop-heading"><strong>调整头像</strong><span>方形裁切 · 圆形预览</span></div>
      <canvas ref={preview} width={AVATAR_SIZE} height={AVATAR_SIZE} className="avatar-crop-preview" aria-label="裁切预览"/>
      {([['zoom', '缩放', 1, 3, 0.05], ['x', '水平位置', 0, 100, 1], ['y', '垂直位置', 0, 100, 1]] as const).map(([key, name, min, max, step]) => <label key={key}>{name}<input aria-label={`${label}头像${name}`} type="range" min={min} max={max} step={step} value={crop[key]} onChange={event => setCrop(value => ({ ...value, [key]: Number(event.target.value) }) as Crop)}/></label>)}
      <div className="identity-actions"><button className="primary" type="button" onClick={() => { try { setAvatar(exportAvatar(picture, crop)); setPicture(null); setNotice('预览已更新，点击保存应用'); } catch (reason) { setError((reason as Error).message); } }}>使用此头像</button><button type="button" onClick={() => setPicture(null)}>取消裁切</button></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="identity-notice" role="status">{notice}</p>}
    <div className="identity-save"><button type="button" className="primary" disabled={busy || !!picture || !changed} onClick={() => { try { persist({ nickname: normalizeNickname(nickname), avatar }); } catch (reason) { setError((reason as Error).message); } }}>保存{label}身份</button><button type="button" disabled={busy || !!picture || !saved.nickname && !saved.avatar && !changed} onClick={() => { persist({ nickname: '', avatar: null }); }}>重置{label}身份</button></div>
  </section>;
}
export function IdentitySettings() {
  return <section className="identity-settings" aria-label="头像与昵称"><h3>头像与昵称</h3><p>仅在本机显示，桌面与手机可分别设置。</p><IdentityEditor role="user"/><IdentityEditor role="assistant"/><p className="identity-format-hint">JPG / PNG / WebP · 最大 8 MB · 保存前可裁切预览</p></section>;
}
