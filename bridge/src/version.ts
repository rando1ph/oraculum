import lock from '../../protocol.lock.json';
export function assertCodexVersion(version: string) {
  if (version.trim() !== lock.codexVersion) {
    throw new Error(`Expected ${lock.codexVersion}; got ${version.trim()}. Review the protocol upgrade before running.`);
  }
}
