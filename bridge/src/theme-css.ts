import postcss, { type Container } from 'postcss';
import { themeColors, themeMobileMedia, themeSlots } from '../../packages/shared/themes';

const hex = /^#[0-9a-f]{6}$/i;
const fail = (reason: string): never => { throw new Error(`Theme CSS: ${reason}`); };
const length = (v: string, min: number, max: number) => /^\d+(?:\.\d+)?px$/.test(v) && Number(v.slice(0, -2)) >= min && Number(v.slice(0, -2)) <= max;
const luminance = (color: string) => color.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
  .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

// Parse real CSS, then serialize only known selectors/properties/values. Never
// forward raw input, error recovery, nesting, escapes, or unknown at-rules.
export function compileThemeCss(css: string, mobile: boolean, assets: ReadonlySet<string>, assetBase: string): string {
  if (Buffer.byteLength(css) > 64 * 1024 || /[\\\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(css)) fail('invalid characters or size');
  let root;
  try { root = postcss.parse(css); } catch { return fail('invalid syntax'); }
  let declarations = 0;
  function compile(container: Container, media = false): string {
    let output = '';
    for (const node of container.nodes ?? []) {
      if (node.type === 'comment') continue;
      if (node.type === 'atrule') {
        if (media || node.name !== 'media' || !node.nodes || !['(max-width: 760px)', '(min-width: 761px)', themeMobileMedia].includes(node.params)) fail('unsupported @ rule');
        output += `@media ${node.params}{${compile(node, true)}}`;
        continue;
      }
      if (node.type !== 'rule') fail('expected a rule');
      const rule = node as postcss.Rule;
      const isRoot = rule.selector === ':root';
      const slot = themeSlots.find(slot => rule.selector === `[data-theme-slot="${slot}"]`);
      if (!isRoot && !slot) fail('unsupported selector');
      const palette: Record<string, string> = { ...themeColors };
      const entries: string[] = [];
      for (const child of rule.nodes) {
        if (child.type === 'comment') continue;
        if (child.type !== 'decl' || child.important || ++declarations > 256) fail('unsupported declaration');
        const decl = child as postcss.Declaration;
        const p = decl.prop, v = decl.value;
        let valid = false, value = v;
        if (isRoot) {
          // A palette is one complete root rule, without conditional overrides:
          // contrast checks must see the same values that the browser inherits.
          if (media || mobile) fail('tokens belong in the unconditional theme.css :root');
          if (Object.hasOwn(themeColors, p)) { valid = hex.test(v); if (valid) palette[p] = v; }
          else if (p === '--radius') valid = length(v, 0, 24);
          else if (p === '--font-sans' || p === '--font-mono') valid = v.length <= 160 && /^(?:[a-zA-Z][a-zA-Z -]*|"[a-zA-Z][a-zA-Z -]*")(?:,\s*(?:[a-zA-Z][a-zA-Z -]*|"[a-zA-Z][a-zA-Z -]*"))*$/.test(v);
        } else {
          const color = /^var\((--[a-z-]+)\)$/.exec(v)?.[1];
          if (p === 'border-color') valid = !!color && Object.hasOwn(themeColors, color);
          if (p === 'border-radius' && slot !== 'content' && slot !== 'decoration') valid = length(v, 0, 24);
          if (p === 'background-color' && slot !== 'decoration') valid = ['--background', '--surface', '--surface-raised'].includes(color ?? '');
          if (p === 'background-image' && slot === 'decoration') {
            const url = /^url\("(assets\/[a-zA-Z0-9_/-]+\.(?:png|jpg|webp))"\)$/.exec(v)?.[1];
            if (url && assets.has(url)) { valid = true; value = `url("${assetBase}${url}")`; }
            else valid = /^linear-gradient\((?:\d{1,3})deg,\s*#[0-9a-fA-F]{6},\s*#[0-9a-fA-F]{6}\)$/.test(v) || v === 'none';
          }
          if (p === 'box-shadow' && slot !== 'content' && slot !== 'decoration') {
            // Inset only: a shadow cannot cover a sibling or a critical action.
            valid = v === 'none' || /^inset 0 0 (?:[0-9]|[12][0-9]|3[0-2])px (?:[0-4])px #[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(v);
          }
          if (slot === 'content') {
            if (p === 'max-width') valid = length(v, 640, 1200);
            if (p === 'padding-inline') valid = length(v, 12, 32);
          }
          if (slot === 'user-message' || slot === 'tool') {
            if (p === 'margin-block') valid = length(v, 4, 24);
          }
        }
        if (!valid) fail(`unsupported value for ${p}`);
        entries.push(`${p}:${value}`);
      }
      if (isRoot) {
        for (const bg of ['--background', '--surface', '--surface-raised', '--surface-hover', '--accent-soft']) {
          // v1 retains OLED host chrome; bright surfaces would hide its fixed
          // labels. Light host chrome requires a future explicit API revision.
          if (luminance(palette[bg]) > .06 || contrast(palette['--foreground'], palette[bg]) < 4.5 || contrast(palette['--muted'], palette[bg]) < 3) fail('unreadable palette');
        }
      }
      output += `${isRoot ? '[data-theme-root]' : `[data-theme-root] ${rule.selector}`}{${entries.join(';')}}`;
    }
    return output;
  }
  if (root.nodes.filter(node => node.type === 'rule' && node.selector === ':root').length > 1) fail('use one :root rule');
  const compiled = compile(root);
  return mobile ? `@media ${themeMobileMedia}{${compiled}}` : compiled;
}
