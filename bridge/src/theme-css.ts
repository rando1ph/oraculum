import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { themeMobileMedia } from '../../packages/shared/themes';

const fail = (reason: string): never => { throw new Error(`Theme CSS: ${reason}`); };
// CSS escapes are legal in URLs (and function names). Decode only for resolution;
// selectors, declarations and the browser's CSS feature support remain untouched.
const unescapeCss = (value: string) => value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])|\\\r?\n/gi,
  (_match, hex: string | undefined, char: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char ?? '');

// Trusted local CSS, not a sandbox. Parse for author errors and resolve package
// resources; do not audit selectors, properties, contrast, layout or animation.
// External/absolute URLs retain their standard meaning under the existing CSP.
export function compileThemeCss(css: string, mobile: boolean, assets: ReadonlySet<string>, assetBase: string): string {
  if (Buffer.byteLength(css) > 64 * 1024 || css.includes('\0')) fail('invalid characters or size');
  let root;
  try { root = postcss.parse(css); } catch (error) {
    const e = error as postcss.CssSyntaxError;
    return fail(`invalid syntax at ${e.line ?? '?'}:${e.column ?? '?'}: ${e.reason ?? 'parse error'}`);
  }
  function resolveAsset(raw: string): string {
    const url = unescapeCss(raw);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return raw;
    const path = url.replace(/^\.\//, '').split(/[?#]/, 1)[0];
    if (!assets.has(path)) return fail(`missing or unsupported local asset: ${path}`);
    return assetBase + url.replace(/^\.\//, '');
  }
  function resources(value: string, importRule = false) {
    const parsed = valueParser(value);
    parsed.walk(node => {
      if ('unclosed' in node && node.unclosed) fail('unclosed CSS value');
      if (node.type !== 'function') return;
      const name = unescapeCss(node.value).toLowerCase();
      if (name === 'url') {
        const argument = node.nodes.filter(n => n.type !== 'space' && n.type !== 'comment');
        if (argument.length !== 1 || !['string', 'word'].includes(argument[0].type)) fail('invalid URL');
        argument[0].value = resolveAsset(argument[0].value);
      } else if (name === 'image-set' || name === '-webkit-image-set') {
        // image-set also accepts bare strings as image URLs. format()/type()
        // strings are nested, so they are deliberately left unchanged.
        for (const child of node.nodes) if (child.type === 'string') child.value = resolveAsset(child.value);
      }
    });
    if (importRule) {
      const first = parsed.nodes.find(n => n.type !== 'space' && n.type !== 'comment');
      if (first?.type === 'string') first.value = resolveAsset(first.value);
    }
    return parsed.toString();
  }
  root.walkDecls(decl => { decl.value = resources(decl.value); });
  root.walkAtRules(rule => { rule.params = resources(rule.params, rule.name.toLowerCase() === 'import'); });
  // Legacy :root tokens now use their standard document scope. The stylesheet
  // is mounted only while authenticated and removed on reset/unmount.
  return mobile ? `@media ${themeMobileMedia}{${root.toString()}\n}` : root.toString() + '\n';
}
