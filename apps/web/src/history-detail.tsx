import { useEffect, useState } from 'react';
import type { BridgeClient } from '../../../packages/shared/client';
import type { HistoryDetail } from '../../../packages/shared/protocol';

export function HistoryText({ client, threadId, revision, detail }: { client: BridgeClient | null; threadId: string; revision: number; detail: HistoryDetail }) {
  const [text, setText] = useState(''), [offset, setOffset] = useState<number | null>(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setText(''); setOffset(0); setError(''); }, [threadId, revision, detail]);
  async function more() {
    if (!client || offset === null || busy) return;
    setBusy(true); setError('');
    try {
      const part = await client.request<{ text: string; nextOffset: number | null }>('bridge/historyText', { threadId, historyRevision: revision, ...detail, offset }, undefined, 12_000);
      setText(value => value + part.text); setOffset(part.nextOffset);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }
  return <><p>内容较长，按需分段读取原生详情。</p>{error && <p role="alert">{error}</p>}<pre>{text}</pre>{offset !== null && <button disabled={busy} onClick={() => void more()}>{busy ? '正在读取…' : '读取后续内容'}</button>}</>;
}
