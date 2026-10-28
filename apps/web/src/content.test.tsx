import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Item, Message } from './content';
import type { ThreadItem } from '../../../packages/shared/protocol';
import { alignedTable, gfmMessage, incompleteTable, partialTable, wideTable } from '../../../scripts/fixtures/markdown';

const render = (text: string) => renderToStaticMarkup(<Message text={text}/>);

it('renders a semantic GFM table with ordered cells, alignment and inline formatting', () => {
  const html = render(alignedTable);
  for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td']) expect(html).toMatch(new RegExp(`<${tag}[ >]`));
  expect(html).toContain('<th style="text-align:left">项目 Project</th>');
  expect(html).toContain('<th style="text-align:right">数量</th>');
  expect(html).toContain('<th style="text-align:center">状态</th>');
  expect(html).toContain('<td style="text-align:left"><strong>神谕</strong> English</td><td style="text-align:right">42</td><td style="text-align:center"><em>通过</em></td>');
  expect(html).toContain('转义 a|b 与 <code>x|y</code>');
  expect(html).toContain('<del>旧值</del>');
  expect(html.match(/<td[ >]/g)).toHaveLength(8);
  expect(html).toContain('<div class="markdown-table-scroll" role="region" aria-label="表格（可横向滚动）" tabindex="0"><table>');
});

it('preserves surrounding paragraphs, lists, quotes, long cells and read-only GFM tasks', () => {
  const html = render(gfmMessage);
  expect(html.indexOf('表格前文本。')).toBeLessThan(html.indexOf('<table>'));
  expect(html.indexOf('表格后文本。')).toBeGreaterThan(html.indexOf('</table>'));
  expect(html).toContain('<blockquote>');
  expect(html).toContain('class="contains-task-list"');
  expect(html).toContain('<input type="checkbox" disabled="" checked=""/>');
  expect(html).toContain('<input type="checkbox" disabled=""/>');
  expect(render(wideTable).match(/<td>/g)).toHaveLength(12);
  expect(html).toContain('long-token-'.repeat(12));
  const nested = render('- 列表\n\n  ' + alignedTable.replaceAll('\n', '\n  '));
  expect(nested).toMatch(/<li>[\s\S]*<table>[\s\S]*<\/table>[\s\S]*<\/li>/);
});

it('keeps fenced tables literal and accepts incomplete streamed Markdown', () => {
  const html = render('```md\n' + alignedTable + '\n```');
  expect(html).toContain('class="code-block"');
  expect(html).toContain('| 项目 Project | 数量 | 状态 | 语法 |');
  expect(html).not.toContain('<table>');
  expect(html).toContain('class="copy"');
  const adjacent = render(alignedTable + '\n\n```text\n代码与表格相邻\n```\n\n结束段落。');
  expect(adjacent.match(/<table>/g)).toHaveLength(1);
  expect(adjacent).toContain('<code class="language-text">代码与表格相邻\n</code>');
  expect(adjacent).toContain('<p>结束段落。</p>');
  expect(render(incompleteTable)).not.toContain('<table>');
  expect(render(partialTable)).toContain('<table>');
  expect(render(partialTable)).toContain('`未闭合');
  expect(render(partialTable + '` | 7 |')).toContain('<code>未闭合</code>');
  expect(render('`a|b`')).toContain('<code>a|b</code>');
});

it('keeps raw HTML inert, unsafe URLs uncopyable and external images as placeholders', () => {
  const html = render([
    '<script>window.BAD=true</script>',
    '<img src=x onerror="window.BAD=true">',
    '<iframe src="https://example.com"></iframe>',
    '[script](javascript:alert%281%29) [data](data:text/html,bad) [encoded](jav&#x61;script:alert%281%29)',
    '![外部图片](https://example.com/private.png)',
    '| 安全 | 内容 |\n| --- | --- |\n| <img src=x onerror="window.BAD=true"> | [bad](javascript:alert%281%29) |',
  ].join('\n\n'));
  expect(html).not.toMatch(/<(script|img|iframe|a)\b/);
  expect(html).not.toMatch(/javascript:|data:text|onerror=|window\.BAD/);
  expect(html).toContain('[图片：外部图片]');
  expect(html).not.toContain('class="copy"');
});

it('routes GFM autolinks and footnote links through the existing display-and-copy policy', () => {
  const html = render('https://example.com/gfm reader@example.com www.example.com\n\n说明[^1]\n\n[^1]: 注释');
  expect(html).not.toMatch(/<a\b/);
  for (const href of ['https://example.com/gfm', 'mailto:reader@example.com', 'http://www.example.com', '#user-content-fn-1']) expect(html).toContain(`title="${href}"`);
  expect(html.match(/class="copy"/g)?.length).toBeGreaterThanOrEqual(4);
});

it('shares table rendering across assistant, plan and reasoning items', () => {
  const items: ThreadItem[] = [
    { id: 'a', type: 'agentMessage', text: alignedTable, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
    { id: 'p', type: 'plan', text: alignedTable },
    { id: 'r', type: 'reasoning', summary: [alignedTable], content: [] },
  ];
  for (const item of items) expect(renderToStaticMarkup(<Item item={item} live/>)).toContain('<table>');
});
