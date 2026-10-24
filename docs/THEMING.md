# Oraculum Theme API v1 · Trusted CSS Themes

主题是本人明确安装的可信本地 **CSS + 素材目录**，不是代码插件。产品决策以 [Notion Project §6.4.1](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf) 为准。3C.1 保留原 Theme Manager 与 `themeApi: 1`，取消固定 Slot、逐属性和深色亮度白名单；旧 Violet 及既装 v1 包继续可用。

## 包与安装

```text
my-theme/
  manifest.json       # 必需
  theme.css           # 必需，浏览器标准 CSS
  mobile.css          # 可选，移动条件内的追加覆盖
  assets/             # 可选，PNG/JPG/WebP、WOFF/WOFF2/TTF/OTF
  preview.webp        # 可选，GUI 目前仍使用名称列表
```

```json
{"id":"my-theme","name":"My Theme","version":"1.0.0","themeApi":1}
```

Manifest 保持原四字段：id 为 `[a-z][a-z0-9-]{0,47}`，保留 id `oracle-eye` 不可使用；名称 1–64 字符，无控制或双向文本控制字符；版本为三段数字，每段最多四位。

1. 复制 `themes/template/` 至主机来源根目录的直接子目录，目录名也遵守 id 格式。
2. `ORACULUM_THEME_SOURCE_DIR` 配置来源根，默认程序资源根下 `themes/`（与启动 cwd 无关）。GUI 不接受任意主机路径。
3. `ORACULUM_THEME_DIR` 配置已装目录，默认已选择的 Bridge state directory 下 `themes/`。覆盖值必须为绝对路径，不允许符号链接；本阶段不迁移既有数据。资源根、XDG 与显式旧数据选择见 [Runtime configuration](RUNTIME_CONFIGURATION.md)。
4. 「设置 → 主题 → 从主机主题目录安装」选择安装，然后手动选择当前主题。安装不会自动应用；目录变更无需重启 Bridge。
5. 各设备、各服务器入口分别保存选择；正常刷新/重启保持。切换无需重编 Web UI 或重装 APK/Electron，不发送模型请求，不改变 thread、turn、审批身份或收据。

同 id 拒绝覆盖。迭代时使用新 id 明确安装，或由作者编辑主机已装目录：重载、回前台、约 30 秒轮询会复验。失败会保存默认选择并移除自定义 CSS，不继续显示旧版本掩盖损坏。

## CSS 与层叠

使用浏览器支持的标准 CSS：元素/class/data-*、组合选择器、伪类/伪元素、嵌套、Grid/Flex/position、透明度、字体/字号/行高、复杂渐变、图片、阴影、玻璃模糊、filter、`@media`、`@supports`、`@container`、`@font-face`、`@keyframes`、动画、过渡、`!important` 等均可使用。不限亮度或暗色。Bridge 用 PostCSS 解析基本语法并报告行列；浏览器不支持的属性/选择器仍按浏览器规则忽略，不做逐项 CSS 语义校验或布局审计。

`theme.css` 是正常文档样式表；`:root` 现在就是文档根，旧 tokens 自动继承到应用。主题只在认证后的应用挂载，默认/退出认证时移除。宿主基础 CSS 在 `oraculum` layer，自定义主题的调色板兼容底色在 `theme-defaults` layer。**建议主题直接写无 layer 的 CSS**：即使 `button { ... }` 也能覆盖宿主更具体的普通声明，不必堆叠选择器权重。若自行使用 layer，需理解标准层叠次序；宿主 reduced-motion 的重要声明仍生效，作者应主动提供减弱动画版本。

`mobile.css` 整体追加在 `@media (max-width: 760px), (pointer: coarse)` 内，可包含 tokens、选择器和嵌套条件。与旧版相同，移动覆盖在 theme.css 之后。`@import`/`@charset` 等只可置于样式表顶层的规则应遵守浏览器要求，不放 mobile.css；目录包不分发额外 CSS 文件。

## 推荐 tokens 与 hooks（不是白名单）

| 用途 | 稳定 tokens |
| --- | --- |
| 表面 | `--background`, `--surface`, `--surface-raised`, `--surface-hover`, `--accent-soft` |
| 文字/边线 | `--foreground`, `--muted`, `--subtle`, `--line`, `--line-bright` |
| 强调/状态 | `--accent`, `--accent-strong`, `--success`, `--warning`, `--danger` |
| 字体/圆角 | `--font-sans`, `--font-mono`, `--radius` |
| 可选主按钮 | `--primary-background`, `--on-accent` |

任何合法 CSS 值及作者自己的变量都可使用。建议在 `:root` 设置完整调色板和 `color-scheme: light` 或 `dark`。自定义主题的导航、按钮、输入、工具、审批、设置、代码和 Diff 会跟随基础调色板；省略属性保留宿主样式。默认 Oracle Eye 不依赖主题文件或主题服务。

下图省略部分包装节点；缩进表示后代关系，不保证是直接子元素。每行选择器中的标签、class 与 `data-*` 属性属于同一个元素；`/` 分隔并列 hooks。

```text
main.app-shell[data-theme-root][data-theme-id]
  aside.navigation[data-theme-slot="navigation"]   桌面侧栏 / Android Drawer
    .brand-row / .project-picker / .mobile-project-tree
    .session-link / .navigation-footer
  section.conversation[data-theme-slot="conversation"]
    div.theme-decoration[data-theme-slot="decoration"]（默认不接收点击）
    header.conversation-header[data-theme-slot="header"]
    .conversation-scroll
      div.conversation-content[data-theme-slot="content"]
        article.message.user[data-theme-slot="user-message"][data-message-role="user"]
        article.message.agent-message[data-theme-slot="assistant-message"][data-message-role="assistant"]
          header.message-heading
            .message-avatar / .message-name / .message-actions
          .message-body / .markdown（AI 正文）
        .tool[data-theme-slot="tool"]（article 或 details）
          .tool-body（部分工具）
        article.approval[data-theme-slot="approval"]
          .approval-actions
    form.composer[data-theme-slot="composer"]
      .composer-context.model-controls
        .project-control / .model-control / .effort-badge
      .composer-input textarea
      .composer-toolbar
        .composer-more / .permission-control / .composer-actions
      .composer-popover（项目、模型与思考强度、权限或空托盘）
        .composer-model-summary（模型/思考强度的一级两行入口）
        .composer-submenu-header / .composer-choice-list（二级返回栏与纵向选项）
      .send-button / .stop-button
  section.inspector[data-theme-slot="inspector"]      桌面详情 / 手机全屏
    .diff-editor / .cm-editor / .cm-gutters
    .diff-added / .diff-removed / .diff-hunk
  dialog.settings-dialog.app-settings[data-theme-slot="settings"]
    .theme-settings
```

原八个 Slot 保留，3C.1 新增 composer/approval/settings，4D.3 新增 assistant-message。双方消息共享 `.message` 卡片、`.message-heading` 头像与名称标题行、`.message-body` 正文；现有 `.message.user`、`.agent-message`、`.user-label` 继续兼容。默认用户为「你」与人物轮廓头像，AI 为 Codex 与 Oracle Eye；本阶段不提供自定义身份设置。正文不再为头像预留左侧列，桌面内容容器上限 980px（含边距），移动端卡片近全宽。卡片使用现有表面、文字、边线和圆角 tokens；主题可通过 `.message` 同时覆盖双方材质，或用两个 Slot 分别覆盖。

上述语义 class 是推荐覆盖接口；其他 DOM 也可使用，但不能保证所有内部节点跨未来版本永久兼容。业务状态类 `.nav-collapsed`、`.drawer-open`、`.inspector-open`、`.expanded` 控制展开/收起，主题应分别检查这些状态。品牌 PNG 是既有 Oracle Eye 资产，可通过 CSS 调整尺寸/滤镜；CSS 主题不替换业务组件。

4D.3-Patch 将项目与模型/思考强度入口合并在 Composer 上排，`+`、权限和发送/停止位于下排；`.model-controls` 兼容 class 保留，但原 `select` 改为 `.composer-control` 按钮和 `.composer-popover` 选择面板。菜单采用现有表面、文字、强调和边线 tokens；空 `+` 托盘没有内容。窄屏隐藏权限文字、保留可访问名称；极小横屏键盘视口临时收起上排，保留输入与发送/停止。不要覆盖菜单依据可见空间计算的最大高度。

模型/思考强度菜单使用替换式两级导航：`.composer-popover-model[data-level="summary"]` 仅有两条纵向入口，`[data-level="model"]` 或 `[data-level="effort"]` 仅显示对应的纵向选项与返回栏。选项沿用 `[aria-checked="true"]` 选中态；主题应保留返回按钮、键盘焦点和选项可滚动性，不能将两级重新平铺。模型入口的 18px 内联 SVG 是简化的 Oracle Eye，颜色继承文字 token，不替换主品牌资产。

```css
:root {
  color-scheme: light;
  --background: #f6f7f9;
  --surface: #ffffff;
  --foreground: #202b38;
  --accent: #195bb0;
  --on-accent: #ffffff;
}
button.primary { border-radius: 999px; background: #235daf; color: white; }
.composer { backdrop-filter: blur(12px); background: #ffffffdd; }
[data-theme-slot="navigation"] { background: var(--surface); }
@media (min-width: 1101px) { .conversation-content { max-width: 1100px; } }
```

完整 Light 调色板见 `themes/minimal-light/`。复杂图片、玻璃、剪角按钮、伪元素雨线、字体及动画见 `themes/hong-kong-rain/`；它是虚构香港雨夜插画验收样例，不是实景照片或新正式品牌稿。Violet 原样保留。素材来源和字体许可见 [THEME-ASSETS.md](THEME-ASSETS.md)。

## 相对资源与浏览器权限

```css
@font-face {
  font-family: "My Mono";
  src: url("assets/mono.woff2") format("woff2");
  font-display: swap;
}
.app-shell { background: url("assets/night.webp") center / cover; }
.panel { background-image: image-set("assets/night.webp" 1x); }
```

`theme.css` 和 `mobile.css` 中的相对 URL 均相对于主题包根；支持 `assets/...`、`./assets/...`、引号/无引号、CSS 转义及 query/fragment。`url()`、image-set 字符串和字体 src 会转换为当前入口 Base Path 下的认证资源地址。相对路径必须对应实际包内素材，缺失或越界拒绝。不要硬编码服务器 IP、部署路径或 `/themes/` URL。

绝对/外部 URL 保持 CSS 标准语义，继续受现有 CSP 控制；当前 `default-src 'self'` 不允许第三方网络字体、图片、样式或 data/blob 资源。不要依赖它们。没有为主题扩大 CSP、TLS、WebView/Electron 权限，也没有 JS/HTML/React/Node/OS/Bridge 执行扩展。不要在包中放可执行文件或 SVG。

基本文件约束沿用：禁止 symlink、硬链接、隐藏/未知文件；assets 路径名用字母数字、`_`、`-`，最多四层目录；检查扩展名与图片/字体签名并以固定 MIME + nosniff 分发。包最多 64 文件/目录；manifest 4KiB、每 CSS 64KiB、每素材 2MiB、包总 4MiB、最多 100 个候选/已装目录。没有声明数量限制。字体许可可写在 CSS 注释中，随包保留。

## 布局建议与故障恢复

这是可信作者可自由修改的界面，**不保证任意 CSS 在所有尺寸可用**，也不逐条审核遮挡或对比度。建议保持 Send/Stop/Allow/Decline/设置可见，装饰使用 `pointer-events: none`，保持文字对比度及一般 ≥44px、关键 ≥48px 触摸目标。

移动设备还需检查粗指针横屏、`--app-height` 的可视 viewport/IME 高度、`env(safe-area-inset-bottom)`、长文本与字号放大、Drawer/全屏 Inspector、Back 和滚动位置。避免覆盖 `--app-height`、把 Composer 固定到布局 viewport 底部、强行给导航 `display:flex` 而忽略关闭状态。默认宿主仍负责这些交互；CSS 不改变发送或审批逻辑。

缺文件、API 不兼容、语法/资源解码/网络失败会移除主题并提示原因。支持的 CSS 即使隐藏整页也会被接受，此时使用原生恢复：

- **Electron**：`Ctrl+Shift+0`，或 Alt → 神谕 → 恢复默认主题。
- **Android**：应用前台长按音量加键，在系统对话框选择「恢复默认主题」。错误页原生恢复区也有该按钮；短按仍调音量。

原生恢复重载可信入口并保存默认选择，不依赖任何网页按钮或当前 CSS。不清 Cookie、服务器 profile、草稿、项目、会话或收据，不重发模型操作/审批。认证页不加载自定义主题。

## 验收

`pnpm check && pnpm test && pnpm build` 后运行 `pnpm test:themes:ui`（真实 Electron + 模拟手机/协议合约）。检查 Violet、新主题、375/390px、横屏/小高度、完整浅色组件、长消息/Diff、资源解码失败、失效回退和原生恢复；模拟结果不等于官方 Codex 或真机验收。

`pnpm test:themes:live` 使用真实 Ubuntu Electron、HONOR Android 15 USB/ADB reverse、隔离认证 Bridge 与官方 Codex 的两轮受控测试。运行前拒绝覆盖已有 17860 服务，备份并恢复手机原 Cookie/local/session storage；不迁移用户数据或改生产设施。接受已有 `.local/evidence/phase3/themes-live/.../acceptance.json` 可复查同一真实会话，禁止新建会话或模型轮次。失败证据保留；清理失败必须核验并恢复原备份后再报告。IME 使用真实系统键盘事件单独记录，CDP fill 不得冒充拼音输入。真实截图、测试范围/限制和 SHA 记录在原 Phase 3 Task；Task 等独立审阅，不由实施方标 Done。

真实脚本的常规 Electron 检查使用平台默认后端；快捷键的操作系统事件注入单独重启同一测试 profile 到 X11（`--ozone-platform=x11`，XTest），不改变产品启动默认值。原生菜单与 Android 对话框也分别验证。`ORACULUM_THEME_DEVICE_HOLD=1` 可在原生会话检查后暂停给真机 IME/横屏操作，在私有输出目录写入 `device-checks.json` 的 passed 结果后继续；脚本重新连接可能因系统字号变化而重建的 WebView。此测试入口只用于明确执行的设备验收，不是产品功能。
