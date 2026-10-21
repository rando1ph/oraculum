// Deployment paths are deliberately canonical and unescaped. Reject ambiguous
// separators/dot segments instead of trusting a proxy or URL parser to repair them.
export function basePath(value = '/'): string {
  if (value.trim() !== value || !value.startsWith('/') || !/^\/[A-Za-z0-9._~/-]*$/.test(value) ||
      value.includes('//') || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Base Path must be an absolute path without escapes, empty or dot segments');
  }
  return value.endsWith('/') ? value : `${value}/`;
}

export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https:\/\/[^/?#\\\s]+\/?$/.test(value) || value.trim() !== value || url.username || url.password ||
      url.protocol !== 'https:' || url.pathname !== '/' || !url.hostname || url.port === '0' || url.origin === 'null') {
    throw new Error('Remote access requires an exact HTTPS origin');
  }
  return url.origin;
}

// The server serves canonical directory entries (or index.html), with no SPA
// fallback. Deriving this directory keeps one static build usable at any base.
export function appUrl(path: string, entry = location.href): URL {
  const directory = new URL('.', entry);
  basePath(directory.pathname);
  return new URL(path, directory);
}
