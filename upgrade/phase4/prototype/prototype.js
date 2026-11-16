'use strict';

// All content below is an authored fixture. There is no transport or persistence.
const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const messageHeader = (person, time, assistant = false) => `<div class="message-person"><span class="avatar${assistant ? ' oracle-eye' : ''}" aria-hidden="true">${assistant ? '' : '你'}</span><b>${person}</b>${assistant ? '<span class="model-label">GPT-6</span>' : ''}<time>${time}</time></div>`;
const userMessage = `<article class="message user-message">${messageHeader('你', '14:31')}<div class="message-body">请梳理会话恢复方案，重点看看长历史、草稿和未知操作的边界。</div></article>`;
const sampleReply = `<article class="message">${messageHeader('Oraculum', '14:32', true)}<div class="message-body"><h1>让恢复更轻，也更可靠。</h1><p>可以把恢复过程拆成三条清晰的路径。已加载的历史让阅读立即继续，草稿留在本机，未决操作则单独核实。</p><div class="process-summary">${icon('check')}<span>已查看 3 个样例文件</span><span class="duration">8.2 s</span>${icon('chevron')}</div><ol class="steps"><li><span class="step-index">1</span><div><b>先恢复阅读，再校正历史</b><small>缓存只负责首屏。连接恢复后，按历史版本校正当前会话。</small></div></li><li><span class="step-index">2</span><div><b>草稿和历史分开保存</b><small>切换会话、清理历史缓存，都不会顺手清空尚未发送的内容。</small></div></li><li><span class="step-index">3</span><div><b>未知结果，先核实再继续</b><small>用原操作标识查询结果，避免重发一条已经执行过的指令。</small></div></li></ol><p class="muted">右侧展示了这份方案的样例 Diff。你可以先看状态边界，再决定具体实现。</p><button class="inline-link" data-open-panel="diff">查看建议变更 ${icon('chevron')}</button></div><div class="message-meta"><span>2.4k tokens</span><span>12 s</span><span>示例回复</span><button class="icon-button" data-demo="复制回复" aria-label="复制样例回复（仅预览）">${icon('copy')}</button></div></article>`;
const approvalReply = `<article class="message">${messageHeader('Oraculum', '14:32', true)}<div class="message-body"><h1>方案已整理，等待一次确认。</h1><p>下一步是运行项目测试，核对恢复边界。请先查看完整命令及作用范围。</p><div class="approval"><h2>运行项目测试</h2><p>需要执行以下命令来检查会话恢复逻辑。</p><pre>pnpm test --filter recovery</pre><div class="approval-details"><span>目录：Atlas Studio</span><span>网络：未请求</span></div><div class="approval-actions"><button class="primary-button" disabled>允许本次</button><button class="quiet-button" disabled>拒绝</button></div><small>静态审批样例 · 按钮不执行、不提交任何决定</small></div></div></article>`;
const offlineReply = `<article class="message">${messageHeader('Oraculum', '上次可见', true)}<div class="message-body"><h1>阅读可以继续，结果还需要核实。</h1><p>这里保留了上次加载的对话。草稿仍可编辑；当前会话有一项发送操作未确认结果。</p><div class="unknown-notice"><b>1 项操作待核实</b><p>恢复连接后，将先查询原操作结果。不会自动重发，也不会把草稿当成新的消息发送。</p><button class="quiet-button" disabled>${icon('refresh')}查询原操作结果</button></div><p class="muted">这只影响当前会话的相关写入。其他会话的已加载内容仍可查看。</p></div><div class="message-meta"><span>上次加载 · 样例</span><span>当前未连接</span></div></article>`;
const connectionPage = `<div class="connect-content"><span class="connect-eye" role="img" aria-label="神谕之眼"></span><div class="connect-eyebrow">YOUR OWN WORKSPACE</div><h1>把神谕连接到<br>你的工作台。</h1><p>连接已有的 Oraculum Gateway。会话由 Codex 运行，草稿与外观偏好保存在这台设备。</p><label class="form-label" for="gateway-address">Gateway 地址</label><input class="form-input" id="gateway-address" value="http://127.0.0.1:PORT/" readonly><div class="form-help">示例地址，PORT 由实际配置提供。本机支持 HTTP / WS；也可填写配置化的 HTTPS 入口。</div><div class="form-label">一次性配对码</div><div class="pairing-code" aria-label="配对码占位，未包含真实凭据"><span>·</span><span>·</span><span>·</span><span>·</span><span>·</span><span>·</span></div><p class="form-help">从 Gateway CLI 获取配对码。新设备建立自己的信任身份，不导入旧版数据。</p><div class="connect-footer"><button class="primary-button" disabled>连接并配对</button><small>静态原型 · 不读取或保存凭据</small></div></div>`;

const diffPanel = `<section class="inspector-section"><h2>本轮变更 <span>只读样例</span></h2><div class="change-stats"><span>2 个文件</span><span class="add-text">+18</span><span class="remove-text">−6</span></div><div class="file-row selected">${icon('file')}<span class="file-name">recovery.ts</span><small><span class="add-text">+14</span> <span class="remove-text">−4</span></small></div><div class="file-row">${icon('file')}<span class="file-name">drafts.ts</span><small><span class="add-text">+4</span> <span class="remove-text">−2</span></small></div><div class="diff-heading">${icon('file')}recovery.ts</div><div class="file-path">src / state / recovery.ts</div><div class="diff-code" aria-label="样例只读差异"><div class="diff-line meta">@@ −18,6 +18,8 @@</div><div class="diff-line"><span class="line-number">18</span>  async function restore() {</div><div class="diff-line removed"><span class="line-number">19</span>−   await reloadAll();</div><div class="diff-line added"><span class="line-number">19</span>+   await showCached();</div><div class="diff-line added"><span class="line-number">20</span>+   await reconcilePending();</div><div class="diff-line added"><span class="line-number">21</span>+   await validateHistory();</div><div class="diff-line"><span class="line-number">22</span>  }</div></div><p class="inspector-note">示意代码用于讨论层次与排版，不是正式实现，也不代表仓库已有变更。</p></section><section class="inspector-section"><h2>会话上下文</h2><dl class="detail-list"><div><dt>项目</dt><dd>Atlas Studio</dd></div><div><dt>模型</dt><dd>GPT-6 · High</dd></div><div><dt>权限</dt><dd>工作区写入</dd></div><div><dt>设置状态</dt><dd><span class="quiet-label">原生已确认 · 样例</span></dd></div></dl></section>`;
const filesPanel = `<section class="inspector-section"><h2>项目文件 <span>授权范围 · 样例</span></h2><div class="file-tree"><div>${icon('folder')}Atlas Studio</div><div class="tree-child">${icon('folder')}src</div><div class="tree-grandchild">${icon('file')}recovery.ts</div><div class="tree-grandchild">${icon('file')}drafts.ts</div><div class="tree-child">${icon('file')}README.md</div><div class="tree-child">${icon('folder')}deliverables</div></div></section><section class="inspector-section"><h2>成果预览 <span>README.md</span></h2><div class="preview-document"><h3>恢复设计</h3><p>阅读、草稿与未决操作各自保留恢复路径。</p><p>此处只展示 Gateway 授权范围内的样例文件。</p><button class="quiet-button" disabled>${icon('file')}下载文件</button><p class="inspector-note">静态预览，不访问主机文件。</p></div></section>`;
const processPanel = `<section class="inspector-section"><h2>执行摘要 <span>本轮 · 样例</span></h2><ol class="timeline"><li>${icon('check')}<div>读取项目结构<span>完成 · 1.2 s</span></div></li><li>${icon('check')}<div>分析恢复边界<span>完成 · 7.0 s</span></div></li><li>${icon('check')}<div>整理设计建议<span>完成 · 3.8 s</span></div></li></ol></section><section class="inspector-section"><h2>子代理</h2><div class="extension-row"><div><b>边界核查</b><span class="quiet-label">上次可见：完成</span></div><small>只读分析 · 层级未确认时不构造代理树</small></div></section><section class="inspector-section"><h2>计划</h2><dl class="detail-list"><div><dt>01 · 研究现状</dt><dd>完成</dd></div><div><dt>02 · 明确边界</dt><dd>完成</dd></div><div><dt>03 · 提交方案</dt><dd>完成</dd></div></dl></section>`;
const approvalPanel = `<section class="inspector-section"><h2>待审批请求 <span>命令执行 · 样例</span></h2><dl class="detail-list"><div><dt>请求</dt><dd>运行项目测试</dd></div><div><dt>作用范围</dt><dd>本次命令</dd></div><div><dt>工作目录</dt><dd>Atlas Studio</dd></div><div><dt>网络</dt><dd>未请求</dd></div><div><dt>当前状态</dt><dd>等待用户决定</dd></div></dl><p class="inspector-note">审批由官方原生请求决定；本页仅示意单次命令请求。文件、额外权限、表单及 URL 请求分别提供对应内容和决策范围。</p></section><section class="inspector-section"><h2>计划</h2><ol class="timeline"><li>${icon('check')}<div>整理恢复方案<span>完成</span></div></li><li>${icon('clock')}<div>核对测试结果<span>等待审批，尚未执行</span></div></li></ol></section>`;
const offlinePanel = `<section class="inspector-section"><h2>未决操作 <span>当前会话</span></h2><dl class="detail-list"><div><dt>操作</dt><dd>发送消息</dd></div><div><dt>结果</dt><dd>unknown · 待核实</dd></div><div><dt>原操作标识</dt><dd><code>sample-operation-01</code></dd></div><div><dt>连接状态</dt><dd>离线 · 样例</dd></div></dl><p class="inspector-note">离线内容只供阅读。重连先查询回执与原生状态，不自动重发，也不提供强制清除入口。</p><button class="quiet-button" disabled>${icon('refresh')}查询原操作结果</button></section><section class="inspector-section"><h2>本机内容</h2><dl class="detail-list"><div><dt>历史</dt><dd>上次加载 · 只读</dd></div><div><dt>草稿</dt><dd>可编辑</dd></div><div><dt>相关写入</dt><dd>等待恢复与核实</dd></div></dl><p class="inspector-note">静态页面的输入仅保留在当前打开期间，不构成草稿持久化实现。</p></section>`;
const usagePanel = `<section class="usage-hero"><span>会话累计 Token · 样例</span><div class="metric">24,680<small>tokens</small></div><span>累计用量不等于上下文占用</span></section><section class="inspector-section"><h2>本会话</h2><dl class="detail-list"><div><dt>输入</dt><dd>18,240</dd></div><div><dt>其中缓存输入</dt><dd>12,600</dd></div><div><dt>输出</dt><dd>6,440</dd></div><div><dt>其中推理输出</dt><dd>4,120</dd></div></dl></section><section class="inspector-section"><h2>上下文占用 <span>样例值</span></h2><div class="meter" role="img" aria-label="样例上下文占用37%"></div><dl class="detail-list"><div><dt>已用</dt><dd>37%</dd></div></dl></section><section class="inspector-section"><h2>账户额度</h2><dl class="detail-list"><div><dt>剩余额度</dt><dd>—</dd></div></dl><p class="inspector-note">额度数据不可用。未知值显示“—”，不会当成 0%。离线时保留上次数据并标明。</p></section>`;
const extensionsPanel = `<section class="inspector-section"><h2>MCP <span>只读状态 · 样例</span></h2><div class="extension-row"><div><b>docs</b><span class="quiet-label">已配置</span></div><small>可调用状态尚未确认</small></div><div class="extension-row"><div><b>workspace</b><span class="quiet-label">上次可见：可调用</span></div><small>2 个工具 · 样例信息</small></div></section><section class="inspector-section"><h2>Skills</h2><div class="extension-row"><div><b>review</b><span class="quiet-label">已启用</span></div><small>项目内可用 · 不代表已调用</small></div></section><section class="inspector-section"><h2>Apps / Plugins</h2><p class="inspector-note">当前无可用信息。这里区分未返回、部分结果和不支持，不把空列表当作“没有安装”。</p></section><section class="inspector-section"><h2>状态说明</h2><p class="inspector-note">配置、安装、启用与可调用分别展示；不在信息页新增安装或授权操作。</p></section>`;
const connectPanel = `<section class="connection-step"><span>01 / EXISTING GATEWAY</span><h3>使用已有的 Gateway</h3><p>客户端只建立连接。不会启动、安装、重启或升级 Gateway。</p></section><section class="connection-step"><span>02 / DEVICE TRUST</span><h3>这台设备，独立的信任</h3><p>从 CLI 获取一次性配对码。长期凭据由主进程管理，不交给页面。</p></section><section class="connection-step"><span>03 / LOCAL EXPERIENCE</span><h3>草稿留在本机</h3><p>本机偏好与缓存独立保存，不导入旧版应用数据，不跨设备同步草稿。</p></section><p class="inspector-note">本页为静态设计示意，未实现配对、凭据或数据库。HTTPS 仅预留配置入口，未进行真实验证。</p>`;

const initial = new URLSearchParams(location.search);
let scene = ['conversation', 'approval', 'offline', 'connect'].includes(initial.get('scene')) ? initial.get('scene') : 'conversation';
let panel = ['diff', 'files', 'process', 'usage', 'extensions'].includes(initial.get('panel')) ? initial.get('panel') : ['approval', 'offline'].includes(scene) ? 'process' : 'diff';
let toastTimer;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function setTheme(theme) {
  if (!['light', 'dark', 'oled'].includes(theme)) return;
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
}
function renderPanel() {
  const normal = {diff: diffPanel, files: filesPanel, process: scene === 'approval' ? approvalPanel : scene === 'offline' ? offlinePanel : processPanel, usage: usagePanel, extensions: extensionsPanel};
  $('#inspector-content').innerHTML = scene === 'connect' ? connectPanel : normal[panel];
  if (scene === 'connect') {
    $('#inspector-content').removeAttribute('aria-labelledby');
    $('#inspector-content').setAttribute('aria-label', '连接说明');
  } else {
    $('#inspector-content').removeAttribute('aria-label');
    $('#inspector-content').setAttribute('aria-labelledby', `tab-${panel}`);
  }
  document.querySelectorAll('[data-panel]').forEach(button => {
    const selected = button.dataset.panel === panel;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $('#inspector-content').scrollTop = 0;
}
function setPanel(next) {
  panel = next;
  renderPanel();
}
function renderScene() {
  document.body.dataset.scene = scene;
  $('#scene-select').value = scene;
  $('#conversation-content').innerHTML = scene === 'connect' ? connectionPage : `<div class="conversation-inner"><div class="conversation-day">今天 · 静态样例</div>${userMessage}${scene === 'approval' ? approvalReply : scene === 'offline' ? offlineReply : sampleReply}</div>`;
  $('#connection-banner').hidden = scene !== 'offline';
  $('#connection-banner').innerHTML = `${icon('wifi-off')}<span>当前离线 · 已加载内容可阅读 · 重连后先核实未决操作</span>`;
  $('#connection-summary').textContent = scene === 'offline' ? '离线 · 上次数据可读' : scene === 'connect' ? '尚未连接 · 静态样例' : '本机 Gateway · 示例已连接';
  $('#composer-area').hidden = scene === 'connect';
  $('#composer-state').innerHTML = scene === 'offline' ? '<span class="status-dot"></span><span>当前会话的发送待核实</span><span class="composer-state-detail">草稿可编辑 · 不会自动重发</span>' : scene === 'approval' ? '<span class="status-dot"></span><span>等待原生审批 · 样例</span><span class="composer-state-detail">决定前不继续相关执行</span>' : '<span class="status-dot"></span><span>本轮已完成</span><span class="composer-state-detail">模型与权限：原生已确认 · 样例</span>';
  $('#thread-title').textContent = scene === 'connect' ? '连接与外观' : '重构会话恢复流程';
  $('.breadcrumb span').textContent = scene === 'connect' ? 'Oraculum' : 'Atlas Studio';
  $('.titlebar-center').textContent = scene === 'connect' ? '连接设置' : 'Atlas Studio';
  $('.new-conversation').disabled = scene === 'connect';
  $('#thread-search').disabled = scene === 'connect';
  $('.navigation-scroll').hidden = scene === 'connect';
  $('#inspector-context').textContent = scene === 'connect' ? '连接前' : scene === 'offline' ? '上次可见数据' : '当前会话';
  $('.inspector-tabs').hidden = scene === 'connect';
  renderPanel();
  $('#conversation-content').scrollTop = 0;
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.themeChoice) setTheme(button.dataset.themeChoice);
  if (button.dataset.panel) setPanel(button.dataset.panel);
  if (button.dataset.openPanel) setPanel(button.dataset.openPanel);
  if (button.dataset.demo) toast(`${button.dataset.demo}：此处仅为视觉预览，未执行操作。`);
  if (button.dataset.thread) toast('仅展示样例导航；此原型没有加载或切换真实会话。');
});
$('#scene-select').addEventListener('change', event => {
  scene = event.target.value;
  if (scene === 'approval' || scene === 'offline') panel = 'process';
  renderScene();
});
$('#settings-button').addEventListener('click', () => { scene = 'connect'; renderScene(); });
$('#inspector-toggle').addEventListener('click', () => {
  const collapsed = !$('#inspector').hidden;
  $('#inspector').hidden = collapsed;
  $('.workspace').classList.toggle('inspector-closed', collapsed);
  $('#inspector-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#inspector-toggle').setAttribute('aria-label', collapsed ? '展开 Inspector' : '收起 Inspector');
});
$('#thread-search').addEventListener('input', event => {
  document.querySelectorAll('[data-thread]').forEach(button => { button.hidden = !button.dataset.thread.toLowerCase().includes(event.target.value.toLowerCase()); });
});
$('.inspector-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-panel]')];
  let index = tabs.findIndex(tab => tab.dataset.panel === panel);
  index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  setPanel(tabs[index].dataset.panel);
  tabs[index].focus();
});
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!$('#thread-search').disabled) $('#thread-search').focus(); }
  if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); toast('新建会话：静态预览未创建任何会话。'); }
  if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); toast('静态原型不会发送消息。输入仅在当前预览页面保留。'); }
  if (event.key === 'Escape') $('#toast').hidden = true;
});
setTheme(initial.get('theme') || 'light');
renderScene();
