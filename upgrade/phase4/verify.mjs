// Read-only P4.0 delivery checks. No server, app, network or profile access.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const read = path => readFile(path, 'utf8');
let links = 0;
for (const file of ['README.md', '01-架构与安全设计.md', '02-源码复用与API映射.md', '03-视觉系统与交互.md', '04-分步实施与验收计划.md', '验收记录.md']) {
  const text = await read(resolve(here, file));
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^[a-z]+:\/\//i.test(href)) continue;
    const [path, anchor] = href.split('#');
    const target = resolve(here, decodeURIComponent(path));
    assert(target.startsWith(repo + '/'), `Link escapes repository: ${href}`);
    assert((await stat(target)).isFile(), `Missing local link: ${href}`);
    if (/^L\d/.test(anchor ?? '')) {
      const last = Number(anchor.match(/\d+/g).at(-1));
      assert(last <= (await read(target)).split('\n').length, `Invalid source line: ${href}`);
    }
    links++;
  }
}

const html = await read(resolve(here, 'prototype/index.html'));
const css = await read(resolve(here, 'prototype/prototype.css'));
const js = await read(resolve(here, 'prototype/prototype.js'));
assert(html.includes("connect-src 'none'"), 'Prototype must block connections');
assert(html.includes("form-action 'none'"), 'Prototype must block form submission');
assert(!/\b(?:fetch|WebSocket|XMLHttpRequest|sendBeacon)\s*\(/.test(js), 'Network operation in prototype');
assert(!/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(js), 'Prototype unexpectedly persists state');
assert(!/@import\b|url\(\s*["']?https?:/i.test(css), 'Remote CSS dependency');
for (const match of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
  assert(!/^[a-z]+:/i.test(match[1]), `Non-local resource: ${match[1]}`);
  assert((await stat(resolve(here, 'prototype', match[1]))).isFile(), 'Missing prototype resource');
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const kind of ['outline', 'compact']) {
  const source = await readFile(resolve(repo, `design/brand/oracle-eye-user/oraculum_oracle_eye_${kind}.svg`));
  const copy = await readFile(resolve(here, `prototype/assets/oracle-eye-${kind}.svg`));
  assert.equal(hash(source), hash(copy), `Brand source changed: ${kind}`);
}

// WCAG relative luminance. These token pairs are not a full accessibility audit.
const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
const tokens = await read(resolve(here, 'prototype/tokens.css'));
const blocks = [...tokens.matchAll(/:root([^{}]*)\{([^{}]*)\}/g)];
assert.equal(blocks.length, 3, 'Expected exactly Light / Dark / OLED token blocks');
let base = {};
let pairs = 0;
for (const [, selector, body] of blocks) {
  const colors = { ...base, ...Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], m[2]])) };
  if (!selector.trim()) base = colors;
  if (selector.includes('oled')) assert.equal(colors.canvas.toLowerCase(), '#000000');
  const combinations = [];
  for (const fg of ['ink', 'muted', 'subtle', 'accent']) {
    for (const bg of ['canvas', 'navigation', 'panel', 'surface', 'hover', 'selected']) combinations.push([fg, bg, 4.5]);
  }
  for (const name of ['warning', 'danger', 'added', 'removed']) combinations.push([name, `${name}-bg`, 4.5]);
  combinations.push(['accent-ink', 'accent', 4.5]);
  for (const bg of ['canvas', 'navigation', 'panel', 'surface']) combinations.push(['focus', bg, 3]);
  let minimumText = Infinity;
  for (const [fg, bg, required] of combinations) {
    const value = contrast(colors[fg], colors[bg]);
    assert(value >= required, `${selector || 'light'} ${fg}/${bg}: ${value.toFixed(3)} < ${required}`);
    if (required === 4.5) minimumText = Math.min(minimumText, value);
    pairs++;
  }
  console.log(`${selector.trim() || 'light'}: text token minimum ${minimumText.toFixed(3)}:1`);
}
console.log(`PASS: ${links} local links, offline resources, unchanged brand SVGs, ${pairs} contrast pairs`);
