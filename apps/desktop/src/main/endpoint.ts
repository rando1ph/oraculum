const ENDPOINT_LIMIT = 2_048;
const REQUEST_PATH_LIMIT = 8_192;
const UNSAFE_CHARACTERS = /[\s\\\x00-\x1f\x7f]/;
const ENCODED_PATH_DELIMITERS = /%(?:2e|2f|5c|25)/i;
const CREDENTIAL_QUERY_KEYS = new Set(['token', 'access_token', 'authorization', 'credential']);

function invalidEndpoint(): never { throw new Error('ENDPOINT_INVALID'); }
function invalidPath(): never { throw new Error('REQUEST_PATH_INVALID'); }

/** Decode once and serialize once; ambiguous traversal cannot reach a proxy. */
function pathSegments(path: string): string {
  if (ENCODED_PATH_DELIMITERS.test(path)) throw new Error('INVALID_PATH');
  return path.split('/').map((segment, index, segments) => {
    // An initial/trailing slash is handled by the caller; internal empty parts
    // are refused because reverse proxies disagree about their normalization.
    if (!segment && index !== 0 && index !== segments.length - 1) throw new Error('INVALID_PATH');
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..' || /[\\/%\x00-\x1f\x7f]/.test(decoded)) throw new Error('INVALID_PATH');
    return encodeURIComponent(decoded);
  }).join('/');
}

/** Canonical Origin + Base Path. Plain HTTP is restricted to literal loopback. */
export function normalizeEndpoint(input: string): string {
  try {
    if (typeof input !== 'string' || !input || input.length > ENDPOINT_LIMIT || UNSAFE_CHARACTERS.test(input)) invalidEndpoint();
    const matched = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(input);
    if (!matched) invalidEndpoint();
    const authority = matched[2];
    // Requiring the original host to match URL's host rejects alternate IPv4
    // forms (decimal, octal, hex, abbreviated), escapes, and Unicode lookalikes.
    const hostPort = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
    if (!hostPort || (hostPort[2] !== undefined && (!/^[1-9][0-9]*$/.test(hostPort[2]) || Number(hostPort[2]) > 65_535))) invalidEndpoint();
    const url = new URL(input);
    const originalHost = hostPort[1].toLowerCase();
    if (url.hostname !== originalHost || url.username || url.password || url.search || url.hash) invalidEndpoint();
    if (!originalHost.startsWith('[')) {
      const labels = originalHost.replace(/\.$/, '').split('.');
      if (originalHost.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalidEndpoint();
    }
    if (url.protocol === 'http:') {
      const ipv4 = originalHost.split('.');
      const loopbackV4 = ipv4.length === 4 && ipv4[0] === '127'
        && ipv4.every(part => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
      if (!loopbackV4 && originalHost !== '[::1]') invalidEndpoint();
    }
    const path = pathSegments(matched[3] ?? '/');
    return `${url.origin}${path.endsWith('/') ? path : `${path}/`}`;
  } catch { return invalidEndpoint(); }
}

/** Internal main-process URL construction; never accepts an absolute URL. */
export function endpointUrl(endpoint: string, relativePath: string): URL {
  const normalized = normalizeEndpoint(endpoint);
  try {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > REQUEST_PATH_LIMIT
      || UNSAFE_CHARACTERS.test(relativePath) || relativePath.includes('#') || relativePath.startsWith('/')
      || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) invalidPath();
    const queryStart = relativePath.indexOf('?');
    const path = queryStart < 0 ? relativePath : relativePath.slice(0, queryStart);
    const query = queryStart < 0 ? '' : relativePath.slice(queryStart);
    if (!path || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(query) || /%(?![0-9a-f]{2})/i.test(query)) invalidPath();
    const url = new URL(pathSegments(path) + query, normalized);
    const base = new URL(normalized);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password) invalidPath();
    // URLSearchParams decodes parameter names before comparison, including
    // percent-encoded names. Authentication belongs exclusively in headers.
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) invalidPath();
    }
    return url;
  } catch { return invalidPath(); }
}

export function websocketUrl(endpoint: string): URL {
  const url = endpointUrl(endpoint, 'api/v2/events');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}
