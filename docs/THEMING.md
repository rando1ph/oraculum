# Oraculum Theme API v1

本文件是主题作者的操作接口说明。产品决策仍以 [Notion Project §6.4](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf) 为准。
主题是明确安装的、可信本地 CSS 目录；React 组件、业务交互和原生壳的改动属于正常软件升级。

## 目录与安装

```text
my-theme/
  manifest.json       # 必需
  theme.css           # 必需
  mobile.css          # 可选，只应用于移动布局
  assets/             # 可选，本地 PNG / JPG / WebP
  preview.webp        # 可选，保留供作者查看，v1 GUI 使用名称列表
```

```json
{"id":"my-theme","name":"My Theme","version":"1.0.0","themeApi":1}
```

Manifest v1 只接受上述四个字段。`id` 为 `[a-z][a-z0-9-]{0,47}`，不得使用宿主保留的 `oracle-eye`；名称为 1–64 字符，不能含控制或双向文本控制字符；版本为三段数字，每段不超过四位。

1. 复制 `themes/template/` 到主题来源目录的一个直接子目录，修改 manifest 与 CSS。来源目录中的目录名也须符合 id 格式；安装后使用 manifest id 命名。
2. 主机 `ORACULUM_THEME_SOURCE_DIR` 指定允许安装的来源根目录，开发默认是启动目录下的 `themes/`。GUI 只列出该根目录中的候选包，不接受任意主机路径。
3. `ORACULUM_THEME_DIR` 指定已安装主题目录，开发默认是现有 Bridge state directory 下的 `themes/`。两项均由主机配置解析为绝对路径，不允许符号链接。这些默认值不是 Phase 4 的正式安装布局，不移动任何既有数据。
4. 双端「设置 → 主题」中刷新来源，检查名称/版本，点击「安装」。安装会验证并复制文件，**不会自动应用**；然后在当前设备选择该主题。另一端可刷新列表并独立选择。
5. 主题选择仅保存在当前客户端、当前服务器入口的本地存储中，刷新/正常重启后恢复。切换不重载会话、不发送模型请求，也不重新编译 Web UI 或重装应用。新增/修改来源目录无需重启 Bridge。

同 id 安装拒绝覆盖。最简单的主题迭代方式是使用新 id 明确安装；开发者也可在主机上编辑已安装目录，客户端会在重载、回到前台或约 30 秒内复验。失败回到默认，不继续沿用旧主题掩盖损坏。不支持 ZIP 导入、主题市场、运行时 JS、`/ui` 或构建/发布平台。

## Tokens 与组件骨架

默认 Oracle Eye 保留在宿主 `tokens.css`、`style.css`、`mobile.css` 与内容样式中，不依赖外部主题文件。主题只覆盖自己声明的值；宿主新增控件继续使用基础按钮/输入样式。省略值不是缺失错误。

`theme.css` 可有**一个无条件 `:root`**（加载时限定到应用主题根，不作用于配对页）：

| 类型 | 稳定 tokens | 可接受值 |
| --- | --- | --- |
| 表面 | `--background`, `--surface`, `--surface-raised`, `--surface-hover`, `--accent-soft` | 不透明 `#RRGGBB` |
| 文字 | `--foreground`, `--muted`, `--subtle` | 不透明 `#RRGGBB` |
| 边线 | `--line`, `--line-bright` | 不透明 `#RRGGBB` |
| 强调/状态 | `--accent`, `--accent-strong`, `--success`, `--warning`, `--danger` | 不透明 `#RRGGBB` |
| 卡片圆角 | `--radius` | `0px`–`24px` |
| 字体 | `--font-sans`, `--font-mono` | 系统字体名称列表，ASCII 字母/空格/连字符，名称可用双引号；不加载字体文件 |

v1 保留已批准的 OLED 宿主 chrome：表面相对亮度不超过 0.06；foreground 与各表面至少 4.5:1，muted 至少 3:1。主题可显著改变暗色配色/排版/装饰，但 v1 不承诺完整浅色 chrome。扩大接口须明确兼容版本和实机验证，不能依赖未公开 class 或任意 CSS 永久兼容。状态和关键操作仍由宿主保护。

```text
应用主题根
  navigation               桌面导航 / Android Drawer
  conversation             会话容器
    decoration             宿主定位的低透明背景层，不接收点击
    header                 会话标题
    content                可滚动正文内层
      user-message         用户消息卡片
      tool                 工具卡片
      [宿主审批区]
    [宿主 Composer / Send / Stop]
  inspector                桌面 Inspector / 移动全屏详情
  [宿主 Settings / Theme Management]
```

公开 hook 的唯一选择器写法为 `[data-theme-slot="navigation"]` 等上图八个名称。不能加组合、后代、属性测试、伪类/伪元素或逗号。CSS 本身照常使用 JSON + CSS 工具编辑；这里是受支持 CSS 子集，不是新的主题语言。

| 范围 | 允许的声明 |
| --- | --- |
| 除 decoration 外的 hook | `background-color: var(--background/--surface/--surface-raised)`；`border-color: var(任一已公开颜色 token)` |
| 除 content/decoration 外的 hook | `border-radius: 0px…24px`；`box-shadow: none` 或 `inset 0 0 Npx Mpx #RRGGBB[AA]`（N 0–32，M 0–4） |
| content | `max-width: 640px…1200px`；`padding-inline: 12px…32px` |
| user-message / tool | `margin-block: 4px…24px` |
| decoration | `background-image: none`、`linear-gradient(Ndeg, #RRGGBB, #RRGGBB)` 或 `url("assets/name.png")`；N 为 0–999 的整数 |

高级覆盖不能改变 display/position/z-index/opacity/transform/pointer-events/content，也不能任意改尺寸或全局样式。阴影仅允许 inset，装饰层由宿主固定在内容后方、低透明、不接收输入；关键按钮和审批没有主题 hook，颜色/字体来自宿主基础样式。任何不支持的声明使整包失败，不会悄悄跳过。

`theme.css` 的 hook 可放入 `@media (max-width: 760px)`、`@media (min-width: 761px)` 或 `@media (max-width: 760px), (pointer: coarse)`；不允许嵌套 media。`mobile.css` 自动包在最后一个移动条件中，不能定义 tokens。CSS 中不接受转义、`!important`、嵌套选择器或其他 at-rule。

移动正文建议 12–16px 边距；宿主强制保留单列、Drawer、IME 避让、安全区和全屏详情。主题不能改变最小 44px / 关键操作 48px 触摸目标。桌面面板宽度偏好仍由宿主控制，主题可调整正文宽度及卡片间距。

## 安全与恢复

- 所有主题列表、安装、CSS 包和图片请求沿用 Bridge 的设备认证、撤销、Origin 与 Base Path 边界。客户端不能指定来源根或读取任意主机文件；安装必须来自主机明确开放的来源目录。
- 目录/文件 symlink、硬链接、隐藏/未知文件、JS/TS/HTML/SVG、网络 `@import`/URL、data/blob/file URL、路径逃逸全部拒绝。不修改 CSP、TLS、Electron sandbox 或 WebView 权限。
- 仅包内 `assets/` 的 PNG/JPG/WebP 可作为装饰资源，目录/文件名限字母数字、`_`、`-`；路径最多四层目录。扩展名与图片签名须一致，按固定图片 MIME + nosniff 分发。浏览器图片解码失败也恢复默认。图片不是受信执行代码；本机制不承诺防御拥有主机写权限的恶意 OS 用户。
- 每包最多 64 个文件/目录；manifest 4KiB，单 CSS 64KiB，单图片 2MiB，总文件内容 4MiB；最多 100 个候选/已装目录。每份 CSS 最多 256 条声明。
- Theme API 不兼容、缺文件、损坏 CSS、资源或网络失败时移除自定义样式并保存默认选择；提示具体失败。默认主题无需主题服务成功即可显示。重新认证前移除自定义主题。
- **Electron 原生恢复**：按 `Ctrl+Shift+0`，或 `Alt` 打开应用菜单选择「恢复默认主题」。壳重载可信入口并强制选择默认；不依赖设置按钮可见，也不授予 renderer 新的系统接口。
- **Android 原生恢复**：应用前台按住音量加键，打开原生恢复对话框，选择「恢复默认主题」。错误页的原生恢复区也提供该按钮。它重载当前可信入口，保留服务器 profile、认证、草稿和主机任务；短按音量键仍调整音量。
- 恢复操作只改变主题偏好；不会清除 Cookie、项目、会话或发送回执。原生恢复重载页面会重新查询官方状态，不重发发送/审批。

## 主题作者验收

先运行 `pnpm check && pnpm test && pnpm build`，再用 `pnpm test:themes:ui` 检查确定性模拟合约。该合约不代替真实 Codex 验收。

至少检查：375/390px、实际 Android 竖/横屏及键盘、字号放大、长消息、Diff、旧主题未知的新按钮；正常 Send/Stop/Allow/Decline 可见且可点；双端独立选择、刷新/进程重启、缺失/损坏/不兼容和恶意覆盖拒绝；最后用原生入口在页面完全被遮挡时恢复默认。

`themes/test-violet/` 是唯一验收测试主题，`themes/template/` 是最小作者模板；均不自动安装。真实设备证据与限制写回 Phase 3 Task，不能把模拟协议或参考图当作实机成果。
