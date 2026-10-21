import { expect, it } from 'vitest';
import { appUrl, basePath, httpsOrigin } from './entry';

it('accepts root or a portable nested deployment and rejects ambiguous configuration', () => {
  expect(basePath()).toBe('/');
  expect(basePath('/team/console')).toBe('/team/console/');
  for (const bad of ['', 'https://example.test/', '//other/', '/a/../', '/./', '/a//', '/a\\b/', '/a%2fb/', '/a?b/', '/a#b/', '/a\n/', '/a/\n']) {
    expect(() => basePath(bad)).toThrow();
  }
  expect(httpsOrigin('https://example.test:9443/')).toBe('https://example.test:9443');
  for (const bad of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/a/../', 'https://example.test/?x', 'https://example.test/#x', 'https://example.test/\n', 'https://example.test:0', 'https://example.test\\', 'https://exam\tple.test']) {
    expect(() => httpsOrigin(bad)).toThrow();
  }
});

it('keeps API and chunk-directory URLs on the entry origin and path in either mode', () => {
  for (const entry of ['http://127.0.0.1:17860/', 'https://example.test:9443/team/console/', 'https://example.test:9443/team/console/index.html']) {
    const expected = entry.replace(/index\.html$/, '');
    expect(appUrl('auth/session', entry).href).toBe(expected + 'auth/session');
    expect(appUrl('ws', entry).href).toBe(expected + 'ws');
  }
});
