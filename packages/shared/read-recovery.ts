// Used only at explicit read call sites. Mutations never enter this retry loop.
export async function retryRead<T>(read: () => Promise<T>, signal: AbortSignal, delays = [1000, 3000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      if (attempt >= delays.length) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delays[attempt]);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
