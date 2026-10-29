import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExtensionRow } from './extensions';

it('uses precise native states and escapes metadata instead of enabling catalog actions', () => {
  const base = { id: 'id', name: '<script>secret</script>', description: 'Description', source: '项目', enabled: null };
  const mcp = renderToStaticMarkup(<ExtensionRow kind="mcp" entry={{ ...base, authStatus: 'unsupported', runtimeStatus: 'connected', toolCount: 3 }}/>);
  expect(mcp).toContain('已配置'); expect(mcp).toContain('已连接'); expect(mcp).toContain('不提供认证状态'); expect(mcp).not.toContain('连接失败');
  expect(mcp).toContain('&lt;script&gt;'); expect(mcp).not.toMatch(/<script>|<button|href=/);
  const app = renderToStaticMarkup(<ExtensionRow kind="apps" entry={{ ...base, installed: true, enabled: false, callable: false }}/>);
  expect(app).toContain('已安装'); expect(app).toContain('已禁用'); expect(app).toContain('不可调用');
  const unknown = renderToStaticMarkup(<ExtensionRow kind="apps" entry={base}/>);
  expect(unknown).toContain('启用状态未知'); expect(unknown).toContain('调用状态未知');
});
