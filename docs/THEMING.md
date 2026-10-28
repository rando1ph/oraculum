# Oraculum Theme API v1 · Trusted CSS Themes

主题是本人明确安装的可信本地 **CSS + 素材目录**，不是代码插件。产品决策以 [Notion Project §6.4.1](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf) 为准。3C.1 保留原 Theme Manager 与 `themeApi: 1`，取消固定 Slot、逐属性和深色亮度白名单；旧 Violet 及既装 v1 包继续可用。

## 包与安装

**内置 Minimal Light · 极简浅色**：ID `minimal-light`，沿用 `themes/minimal-light/` 的既有完整浅色样式，现与 Oracle Eye、Hong Kong Neon、Old Terminal 一起开箱可选（含默认主题共四套）。设置中标为「内置」，不再需要从来源目录安装。文件位置与视觉样式不变，直接从程序资源根只读加载；设备独立偏好、认证与损坏回退复用现有机制。启用内置目录时 `minimal-light` 为保留 ID，旧的同 ID 已装副本保留但不能覆盖内置包；自定义变体需使用不同 ID。Violet 与香港雨夜仍为验收样例，`template` 仍为开发模板。

**内置 Old Terminal · 老式终端（2.0.0 重做）**：设置的「当前主题」中开箱可选，ID `old-terminal`，只读包位于 `themes/old-terminal/`；与 Oracle Eye / Hong Kong Neon 共存，沿用内置目录、保留 ID、认证、设备独立偏好与损坏回退机制。无需安装或发起模型轮次。

新版从空目录独立创作，参考用户在 [4E.2B Task](https://app.notion.com/p/4045421e690b8124842bd444f9dab587) 指定的三张真实 DSH 截图的显示质感：纯黑画布、清冷绿色荧光、细线轮廓、文字余辉与静态扫描纹。只借鉴美术，不复制其布局、品牌或功能；原 Oraculum 控件、文字度量、双方卡片、头像昵称与菜单排列由宿主保留。扫描层是无文字且不接收点击的空伪元素，不显示虚构状态；无环境动画、外部图片/字体、额外依赖或权限。仅既有品牌位图着色，自定义头像保留原色。高对比偏好关闭扫描层并提高文字亮度。Desktop/移动端共享艺术语言，移动 CSS 仅调整表面；不覆盖视口、IME、安全区或菜单高度。

**内置 Hong Kong Neon · 香港霓虹**：设置的「当前主题」中开箱可选，标为「内置」，无需从来源目录安装。它与默认 Oracle Eye 并存，选择仍按设备/入口保存。内置包从程序资源根的 `themes/hong-kong-neon/` 只读加载，复用相同的 Theme API v1 校验、认证资源路由与失败回退；不复制到用户状态目录，`ORACULUM_THEME_SOURCE_DIR` 的覆盖不影响内置主题。启用内置目录时 `hong-kong-neon` 为保留 ID，来源/已装目录中的同 ID 包不能覆盖它；创作变体请换 ID 后按下述流程安装。损坏或缺失的内置包同样恢复 Oracle Eye。

Hong Kong Neon 的桌面与移动端使用独立城市素材和玻璃/雨幕光效，不改变控件的位置、尺寸、排列或字体度量。仅 `prefers-reduced-motion` 停止环境动画；极短 IME 视口遵循宿主的菜单定位规则。艺术素材来源与完整生成提示词见 [THEME-ASSETS.md](THEME-ASSETS.md)。

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

同 id 拒绝覆盖。迭代时使用新 id 明确安装，或由作者编辑主机已装目录：重载、回前台、约 30 秒轮询会复验。Bundle 与资源使用需先认证的私有 HTTP 重验；相同 revision 不重复探测图片/字体，revision 变化的资源 URL 随之更新。已确认非法主题或损坏资源会保存默认选择并移除自定义 CSS，不继续显示旧版本掩盖损坏。短暂网络失败保留所选偏好；已应用的同一主题继续显示，首次加载则暂用默认主题，恢复连接后在回前台或下一次轮询重试。

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
        section.turn-process[data-turn-id][data-status]  原生 Turn 分组
          .turn-records
            article.message.user[data-theme-slot="user-message"][data-message-role="user"]
            article.message.agent-message[data-theme-slot="assistant-message"][data-message-role="assistant"]
              header.message-heading
                .message-avatar / .message-name / .message-actions
              .message-body / .markdown（AI 正文）
            .process-records[hidden]                   可折叠过程，最终回答在其外
              .tool[data-theme-slot="tool"]（article 或 details）
                .tool-body（部分工具）
          .process-status / .process-toggle[aria-expanded] / .process-counts
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
    .identity-settings
      .identity-card[data-identity-role="user"/"assistant"]
        .identity-preview / .identity-fields / .identity-save
        .avatar-crop
          canvas.avatar-crop-preview / input[type="range"]
```

原八个 Slot 保留，3C.1 新增 composer/approval/settings，4D.3 新增 assistant-message。双方消息共享 `.message` 卡片、`.message-heading` 头像与名称标题行、`.message-body` 正文；现有 `.message.user`、`.agent-message`、`.user-label` 继续兼容。默认用户为「你」与人物轮廓头像，AI 为 Codex 与 Oracle Eye。4D.5 在设置中增加双方独立昵称与头像，仍使用 `.message-avatar` / `.message-name`；自定义头像为 `canvas.custom-avatar`，默认头像保持原 SVG/PNG。正文不再为头像预留左侧列，桌面内容容器上限 980px（含边距），移动端卡片近全宽。卡片使用现有表面、文字、边线和圆角 tokens；主题可通过 `.message` 同时覆盖双方材质，或用两个 Slot 分别覆盖。

身份设置使用 `.identity-settings`、`.identity-card[data-identity-role="user"/"assistant"]`、`.identity-preview`、`.avatar-crop`；沿用表面、文字、边线、强调与圆角 tokens。昵称最多 32 个 Unicode 字符，按纯文本显示；图片仅选择 JPG/PNG/WebP，最大 8MiB，边长不超过 8192、总像素不超过 3200 万，裁切压缩为 256px 方形。预览后需点击对应保存；重置立即保存默认身份，取消裁切或关闭设置丢弃未保存编辑。身份只存于本机当前 Origin/Base Path 的受控 localStorage，不发送 Bridge、Codex 或第三方；设备、原生 profile 与服务器入口各自独立。清除应用数据/站点存储会清除此偏好。默认头像在损坏的本地图片无法解码时继续可见。4D.5-Patch 的自定义头像缓冲跟随 CSS 尺寸与 DPR，最高保留源图 256px；相同图片在挂载期间共享解码，最后一个使用者卸载时释放。主题修改头像尺寸时会重新绘制；裁切预览和保存的 256px 精度不变。画布直接解码本地字节，不扩大主题 CSP，也不允许主题使用 data/blob 或远程资源。

上述语义 class 是推荐覆盖接口；其他 DOM 也可使用，但不能保证所有内部节点跨未来版本永久兼容。业务状态类 `.nav-collapsed`、`.drawer-open`、`.inspector-open`、`.expanded` 控制展开/收起，主题应分别检查这些状态。品牌 PNG 是既有 Oracle Eye 资产，可通过 CSS 调整尺寸/滤镜；CSS 主题不替换业务组件。

4D.3-Patch 将项目与模型/思考强度入口合并在 Composer 上排，`+`、权限和发送/停止位于下排；`.model-controls` 兼容 class 保留，但原 `select` 改为 `.composer-control` 按钮和 `.composer-popover` 选择面板。菜单采用现有表面、文字、强调和边线 tokens；空 `+` 托盘没有内容。窄屏隐藏权限文字、保留可访问名称；极小横屏键盘视口临时收起上排，保留输入与发送/停止。不要覆盖菜单依据可见空间计算的最大高度。

模型/思考强度菜单使用替换式两级导航：`.composer-popover-model[data-level="summary"]` 仅有两条纵向入口，`[data-level="model"]` 或 `[data-level="effort"]` 仅显示对应的纵向选项与返回栏。选项沿用 `[aria-checked="true"]` 选中态；主题应保留返回按钮、键盘焦点和选项可滚动性，不能将两级重新平铺。模型入口的 18px 内联 SVG 是简化的 Oracle Eye，颜色继承文字 token，不替换主品牌资产。

4D 改版后的选择器迁移（不改变 `themeApi: 1` 或包格式）：

| 已移除的 UI 选择器 | 当前推荐 hooks | 状态与层叠注意点 |
| --- | --- | --- |
| `.model-controls select` | `.composer-control`（项目、模型与权限入口）、`.composer-popover`、`.composer-submenu-header` | `.model-controls` 仍是上排兼容 class，但内部没有 `select`。入口用 `[aria-expanded="true"]`，权限 `.full-access` 保留 `--warning`。 |
| `.settings-model-options`、`.settings-effort-options` | `.composer-model-summary`、`.composer-choice-list [role="radio"]` | 设置页不再提供模型列表。模型/思考强度二级列表与权限列表都用 `[aria-checked="true"]`，配色为 `--accent` / `--accent-soft`。 |

无 layer 的入口底色规则也会覆盖宿主的 hover/展开样式，因此自定义 `.composer-control` 背景时，应同时提供 hover 与 `[aria-expanded="true"]` 规则。弹出面板与 sticky 返回栏应使用协调的表面色；不要将所有菜单按钮统一涂色而丢失选中态。实际迁移示例见 Hong Kong Rain；仅使用旧 tokens 的 Violet 无需更新。

4D.4 按原生 Turn 包装时间线。运行时 `.process-status` 位于过程下方，显示已确认状态与原生时间；正常完成后 `.process-toggle` 可展开/收起过程，`.process-counts` 来自实际 Item。双方消息卡片及原有工具 Slot 保留；已确认的最终回答与未知 phase 消息不放入 `.process-records`，审批仍在独立区域。主题不要覆盖 `[hidden]` 的收起语义，也不要隐藏失败/中断/审批行。按钮保持可见键盘焦点和至少 44px（移动端 48px）触摸高度；计数可换行，移动端不增加多层缩进。手动展开是设备当前页面会话的阅读偏好，刷新保持；运行结束的首次显示默认收起。

过程状态使用 `.turn-process[data-status="inProgress"/"completed"/"failed"/"interrupted"]`；失败与中断的 `.process-label` 分别继承 `--danger`、`--warning`。头像覆盖应直接作用于 `.message-avatar`（SVG/PNG/canvas 共用），不要假设它内部还有 `img`；卡片标题、昵称和正文分别用 `.message-heading`、`.message-name`、`.message-body`。设置预览为 `.identity-preview .message-avatar`，裁切画布为 `.avatar-crop-preview`；检查双方身份与长昵称，不要让装饰遮住保存/取消或缩放滑块。

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

共享消息的 GFM 表格使用 `.markdown-table-scroll > table`：外层是可聚焦、带中文标签的横向滚动区域，内部保留原生 `table/thead/tbody/th/td` 语义和列对齐。宿主样式位于 `oraculum` layer，使用 `--line`、`--surface`、`--surface-raised` 与 `--accent`，可信主题可覆盖。主题应保留容器宽度约束、焦点提示及横向滚动，不将表格改为 `display:block`，也不要让宽表撑破消息卡片与 Composer。

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

缺文件、API 不兼容、语法或资源损坏会移除主题并提示原因；网络中断、超时或服务器暂时不可用不会永久覆盖主题偏好。Bundle 传输预算为 10 秒，单个资源传输预算为 15 秒（含响应体），网络暂时失败最多重试一次、间隔 750ms；完整字节到达后图片/字体另有 5 秒解码预算。解码超时保留偏好，确定的解码错误恢复默认。手动恢复默认会取消未完成加载，旧响应不能再次覆盖选择。支持的 CSS 即使隐藏整页也会被接受，此时使用原生恢复：

- **Electron**：`Ctrl+Shift+0`，或 Alt → 神谕 → 恢复默认主题。
- **Android**：应用前台长按音量加键，在系统对话框选择「恢复默认主题」。错误页原生恢复区也有该按钮；短按仍调音量。

原生恢复重载可信入口并保存默认选择，不依赖任何网页按钮或当前 CSS。不清 Cookie、服务器 profile、草稿、项目、会话或收据，不重发模型操作/审批。认证页不加载自定义主题。

## 验收

`pnpm test:terminal:ui` 使用真实 Electron 与 Android 比例 Chromium、隔离 Bridge/临时 profile/明确标注的模拟协议，验证 Old Terminal 开箱选择、刷新、设备独立性、双端菜单与过程/Diff、身份、发送/停止/审批、默认恢复、reduced motion，以及同状态默认主题与新主题的真实控件数量、顺序、坐标/尺寸（容差 0.5 CSS px）、DOM 文字与非空伪元素内容不变。包含 375/390px、横屏和短 IME 视口；缩放后等待宿主的实际可视高度同步。新运行截图与几何报告写入忽略目录 `.local/evidence/phase4e2b-redesign/terminal-contract/`，不复用被否决版本的证据。结果不代表 Android 真机/原生 IME、官方 Codex、耗电测试或用户审美验收；4E.2B 不构建或安装 DEB/APK。

`pnpm check && pnpm test && pnpm build` 后运行 `pnpm test:themes:ui`（真实 Electron + 模拟手机/协议合约）。检查 Violet、新主题、375/390px、横屏/小高度、完整浅色组件、长消息/Diff、资源解码失败、失效回退和原生恢复；模拟结果不等于官方 Codex 或真机验收。

`pnpm test:neon:ui` 专门验证 Hong Kong Neon 的开箱选择、刷新保持、双端操作与默认恢复。它在隔离 Bridge、临时 Electron profile 和模拟协议上运行，保存 Desktop 与 Chromium Android 比例截图，以及默认/Neon 同状态的控件顺序和坐标对照。覆盖消息、两级菜单、权限、过程、Inspector、空会话、Drawer、身份编辑、发送/停止/审批和短 IME 菜单；输出在忽略的 `.local/evidence/phase4e2a/neon-contract/`。这不是 Android 真机、原生 IME 或真实 Codex 验收，也不替代用户审美验收。

涉及 4D 组件时再运行 `pnpm test:composer:ui`、`pnpm test:process:ui`、`pnpm test:identity:ui`：四套主题分别覆盖两级菜单/权限选中态、过程折叠与失败/中断可见性，以及双方昵称/自定义头像/裁切预览。主题合约还逐套验证桌面与模拟手机的输入、发送/停止和允许/拒绝；这些脚本使用临时 Electron profile、隔离 Bridge 与模拟协议，不启动正式 Bridge、不访问真实 Codex 会话，也不操作 Android WebView 数据。

`pnpm test:themes:live` 使用真实 Ubuntu Electron、HONOR Android 15 USB/ADB reverse、隔离认证 Bridge 与官方 Codex 的两轮受控测试。运行前拒绝覆盖已有 17860 服务，备份并恢复手机原 Cookie/local/session storage；不迁移用户数据或改生产设施。接受已有 `.local/evidence/phase3/themes-live/.../acceptance.json` 可复查同一真实会话，禁止新建会话或模型轮次。失败证据保留；清理失败必须核验并恢复原备份后再报告。IME 使用真实系统键盘事件单独记录，CDP fill 不得冒充拼音输入。真实截图、测试范围/限制和 SHA 记录在原 Phase 3 Task；Task 等独立审阅，不由实施方标 Done。

真实脚本的常规 Electron 检查使用平台默认后端；快捷键的操作系统事件注入单独重启同一测试 profile 到 X11（`--ozone-platform=x11`，XTest），不改变产品启动默认值。原生菜单与 Android 对话框也分别验证。`ORACULUM_THEME_DEVICE_HOLD=1` 可在原生会话检查后暂停给真机 IME/横屏操作，在私有输出目录写入 `device-checks.json` 的 passed 结果后继续；脚本重新连接可能因系统字号变化而重建的 WebView。此测试入口只用于明确执行的设备验收，不是产品功能。
