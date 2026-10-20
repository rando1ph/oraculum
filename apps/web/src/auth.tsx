import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from './store';

export async function checkSession() {
  const response = await fetch('/auth/session', { cache: 'no-store' });
  if (response.status === 401) {
    window.dispatchEvent(new Event('oraculum-auth-required'));
    return false;
  }
  if (!response.ok) throw new Error('无法查询设备信任状态');
  return true;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function check() {
    setLoading(true);
    try { setAllowed(await checkSession()); setError(''); }
    catch { setError('无法连接 Bridge，请检查连接后重试。'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const expired = () => { setAllowed(false); useSession.getState().reset(); };
    window.addEventListener('oraculum-auth-required', expired);
    void check();
    return () => window.removeEventListener('oraculum-auth-required', expired);
  }, []);
  if (loading) return <main className="pairing"><p role="status">正在检查连接…</p></main>;
  if (allowed) return children;
  return <main className="pairing">
    <h1>Oraculum <span>神谕</span></h1>
    <h2>信任此设备</h2>
    <p>输入主机上生成的一次性配对码。配对码五分钟内有效，本次设备访问授权有效期为一天，可随时在主机撤销。</p>
    {error && <p className="error" role="alert">{error}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      setBusy(true); setError('');
      const submitted = code.trim();
      setCode('');
      void fetch('/auth/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, code: submitted }),
      }).then(async response => {
        if (!response.ok) throw new Error(response.status === 429 ? '尝试次数过多，请一分钟后再试。' : '配对码无效或已过期，请在主机生成新码。');
        setAllowed(await checkSession());
      }).catch(e => setError(e instanceof Error ? e.message : '配对失败')).finally(() => setBusy(false));
    }}>
      <label>设备名称<input aria-label="设备名称" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} required autoComplete="off"/></label>
      <label>配对码<input aria-label="配对码" type="password" value={code} onChange={e => setCode(e.target.value)} maxLength={43} required autoComplete="one-time-code" spellCheck={false}/></label>
      <button className="primary" disabled={busy || !label.trim() || !code.trim()}>配对并连接</button>
      <button type="button" disabled={busy} onClick={() => void check()}>重新检查连接</button>
    </form>
  </main>;
}
