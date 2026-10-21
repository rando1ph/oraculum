// Display only: native paths stay intact for events, titles and all operations.
export function displayPath(path: string, cwd?: string): string {
  if (!path.startsWith('/')) return path;
  const root = cwd?.replace(/\/+$/, '');
  if (root !== undefined && path.startsWith(`${root}/`)) return path.slice(root.length + 1) || path;
  return path.split('/').filter(Boolean).at(-1) || path;
}
