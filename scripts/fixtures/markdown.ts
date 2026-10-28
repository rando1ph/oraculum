// Controlled content only: shared by component and simulated message contracts.
export const alignedTable = [
  '| 项目 Project | 数量 | 状态 | 语法 |',
  '| :--- | ---: | :---: | --- |',
  '| **神谕** English | 42 | *通过* | 转义 a\\|b 与 `x\\|y` |',
  '| 中文 / English | 3.14 | ~~旧值~~ | `inline code` |',
].join('\n');

export const wideTable = [
  '| ' + Array.from({ length: 12 }, (_, i) => `宽列 ${i + 1} English`).join(' | ') + ' |',
  '| ' + Array(12).fill('---').join(' | ') + ' |',
  '| ' + Array.from({ length: 12 }, (_, i) => `${i + 1}: 中文长内容 English ${'long-token-'.repeat(12)}`).join(' | ') + ' |',
].join('\n');

export const gfmMessage = [
  '## GFM 表格 · 模拟消息',
  '表格前文本。',
  alignedTable,
  '表格后文本。',
  '- [x] 已完成\n- [ ] 待验收',
  '> 引用与表格相邻。',
  '自动链接 https://example.com/gfm 和 reader@example.com。',
  wideTable,
].join('\n\n');

// A real stream may stop before a delimiter row or inside an inline code span.
export const incompleteTable = '| 项目 | 数量 |\n| --- |';
export const partialTable = '| 项目 | 数量 |\n| --- | ---: |\n| `未闭合';
