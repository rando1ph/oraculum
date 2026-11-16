import { describe, expect, it } from 'vitest';
import { endpointUrl, normalizeEndpoint, websocketUrl } from './endpoint';

describe('Gateway endpoint boundaries', () => {
  it.each([
    ['http://127.0.0.1:4871', 'http://127.0.0.1:4871/'],
    ['http://127.255.255.255', 'http://127.255.255.255/'],
    ['http://[::1]:4871/base', 'http://[::1]:4871/base/'],
    ['HTTPS://EXAMPLE.COM:443', 'https://example.com/'],
    ['https://example.com:8443/custom/base/', 'https://example.com:8443/custom/base/'],
    ['https://example.com/%7Eclient', 'https://example.com/~client/'],
    ['https://example.com/%E7%A5%9E%E8%B0%95', 'https://example.com/%E7%A5%9E%E8%B0%95/'],
  ])('normalizes %s without deployment defaults', (input, expected) => {
    expect(normalizeEndpoint(input)).toBe(expected);
    expect(normalizeEndpoint(expected)).toBe(expected);
  });

  it.each([
    '', ' http://127.0.0.1', 'http://127.0.0.1 ', 'http://localhost', 'http://localhost.localdomain',
    'http://127.0.0.1.example.com', 'http://192.168.1.1', 'http://[::ffff:127.0.0.1]', 'http://[0:0:0:0:0:0:0:1]',
    'http://127.1', 'http://2130706433', 'http://0177.0.0.1', 'http://0x7f.0.0.1', 'http://127.00.0.1',
    'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://%65xample.com', 'https://ｅxample.com',
    'https://user:secret@example.com', 'https://user@example.com', 'https://example.com?token=secret',
    'https://example.com/#fragment', 'https://example.com?', 'https://example.com#',
    'https://example.com:000443', 'https://example.com:65536', 'https://example.com:0', 'https://example.com:',
    'https://-example.com', 'https://example..com', 'https://example.com/../base', 'https://example.com/./base',
    'https://example.com/a//b', 'https://example.com/a/%2e%2e/b', 'https://example.com/a%2fb',
    'https://example.com/a%5cb', 'https://example.com/%252e%252e', 'https://example.com/a\\b',
    'https://example.com/%00', 'https://example.com/%0a', 'https://example.com/%', 'https://example.com/\nbase',
    'ws://127.0.0.1', 'wss://example.com', 'file:///tmp/gateway', 'https:example.com',
    `https://example.com/${'x'.repeat(2_048)}`,
  ])('rejects unsafe or ambiguous endpoint %#', input => {
    expect(() => normalizeEndpoint(input)).toThrow(/^ENDPOINT_INVALID$/);
  });

  it('resolves resources and queries inside both root and custom base paths', () => {
    expect(endpointUrl('http://127.0.0.1:4871/', 'health').href).toBe('http://127.0.0.1:4871/health');
    const url = endpointUrl('https://example.com/prefix/', 'api/v2/projects?cursor=a%2Fb%2B%3D&next=https%3A%2F%2Fother.example');
    expect(url.href).toBe('https://example.com/prefix/api/v2/projects?cursor=a%2Fb%2B%3D&next=https%3A%2F%2Fother.example');
    expect(url.origin).toBe('https://example.com');
    expect(url.searchParams.get('cursor')).toBe('a/b+=');
    expect(websocketUrl('http://[::1]:4871/prefix').href).toBe('ws://[::1]:4871/prefix/api/v2/events');
    expect(websocketUrl('https://example.com:8443/prefix/').href).toBe('wss://example.com:8443/prefix/api/v2/events');
  });

  it.each([
    '', '/api/v2/projects', '//evil.example/api', 'https://evil.example/api', 'http:evil.example',
    '../health', 'api/../../health', './health', '%2e%2e/health', 'api/%2E./health', 'api%2fv2/projects',
    'api/%252e%252e/health', 'api\\v2/projects', 'api//v2/projects', '?path=health',
    'api/v2/projects#fragment', 'api/v2/projects\n', 'api/v2/projects?x=%0D%0AHeader:value',
    'api/v2/projects?x=%', `api/v2/projects?x=${'x'.repeat(8_192)}`,
  ])('refuses request escape or ambiguous path %#', path => {
    expect(() => endpointUrl('https://example.com/private/base/', path)).toThrow(/^REQUEST_PATH_INVALID$/);
  });

  it('never echoes supplied private input in errors', () => {
    for (const value of ['https://private:secret@example.com/', 'https://example.com/?token=secret']) {
      expect(() => normalizeEndpoint(value)).toThrow('ENDPOINT_INVALID');
    }
    expect(() => endpointUrl('https://example.com/', 'https://private:secret@example.com/')).toThrow('REQUEST_PATH_INVALID');
  });

  it.each(['token', 'access_token', 'authorization', 'credential', 'TOKEN', 'Access_Token', 'AUTHORIZATION',
    'Credential', '%74oken', 'access%5Ftoken', 'authorizatio%6E', '%43REDENTIAL'])('rejects credential query key %s', key => {
    expect(() => endpointUrl('https://example.com/', `api/v2/projects?cursor=safe&${key}=secret`))
      .toThrow(/^REQUEST_PATH_INVALID$/);
  });
});
