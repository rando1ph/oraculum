# Android 与 Stitch 落地规格

> Phase 0 研究交付，2026-11-11。本文推荐供审阅，不代表已实现、已完成真机验收或获准进入 Phase 3。以 [2.0 子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134) 与 [Phase 0 Task](https://app.notion.com/p/4155421e690b81829fe6ce746cff195d) 已批准决定为边界。

## 1. 结论与输入保全

采用已批准的 Kotlin + Jetpack Compose，按定稿的 Matcha Terminal 深色视觉建立原生设计系统。手机保持「对话 + 左导航抽屉 + 右 Inspector」，无底部 Navigation Bar。Room 保存可重建历史缓存及独立的本机草稿；DataStore 保存小规模偏好；Keystore 保护设备凭据。首次启动或原会话不可用时显示项目/会话入口，正常启动恢复本机上次会话，任何恢复流程都不得自动发送消息。

用户与 Notion 记录的 `upgrade/stitch_oraculum_andriod_workspace` 在当前仓库不存在；实际唯一对应目录为 `upgrade/stitch_oraculum_android_workspace`。本轮只读采用该实际目录，未改名、补图或修改设计文件。原始设计不随 Phase 0 研究文档发布，复核视觉需使用用户本机原件。这是路径拼写差异，不是另选设计。

已清点全部 **12 个文件：7 个 HTML、4 个 PNG、1 个 DESIGN.md**，阅读全部 HTML 与 DESIGN.md，并实际查看全部 4 张 PNG。3 个屏幕没有随包 PNG，不能声称已看过对应截图；原 HTML 含 Tailwind CDN、Google Fonts 和示例数据，是设计参考而非可直接打包的生产客户端。Phase 0 未执行这些外部脚本。

### 1.1 全部屏幕与功能映射

所有路径相对于实际设计目录；每行表示定稿输入，屏幕缺失不等于能力取消。

| 文件目录 | 输入 | 实际内容 | Compose 落点及真实能力来源 |
| --- | --- | --- | --- |
| `oraculum_2.0_1` | HTML + PNG | 主对话、双身份消息卡、完成过程、代码块、复制/分享/分叉/回退、Composer、权限与模型入口 | `ConversationScreen`、`TurnCard`、`Composer`；参考现有 [apps/web/src/content.tsx](../../apps/web/src/content.tsx)、`process.tsx`、`native-controls.ts`、`session-actions.tsx` |
| `oraculum_2.0_2` | HTML | 左导航抽屉；项目树、会话搜索、活跃/归档、新建、项目添加、额度、连接状态、设置 | `NavigationDrawerContent`；参考 [apps/web/src/layout.tsx](../../apps/web/src/layout.tsx)、`project-browser.tsx`、`usage.tsx`；搜索沿用已支持能力，不新增全文搜索引擎 |
| `oraculum_2.0_3` | HTML + PNG | 设置；双方昵称/头像、原生扩展、主题/强调色/字号、连接、通知 | `SettingsScreen`、身份编辑及系统通知跳转；参考 `identity-ui.tsx`、`extensions.tsx`、Android `ServerEntry.kt`；扩展仍是只读总览 |
| `oraculum_2.0_4` | HTML | 运行中命令审批；命令、目录、拒绝/总是允许/允许本次、停止 | `NativeRequestCard`；参考 [apps/web/src/native-request.tsx](../../apps/web/src/native-request.tsx) 与 [bridge/src/native-requests.ts](../../bridge/src/native-requests.ts)；按钮必须取自真实原生请求 |
| `oraculum_2.0_right_inspector_1` | HTML + PNG | 右抽屉「文件」；目录、成果列表、图片预览、保存/外部打开/分享 | `InspectorFiles`、`ArtifactPreview`；参考 [apps/web/src/artifacts.tsx](../../apps/web/src/artifacts.tsx)、Android `ArtifactDownloads.kt`、`ArtifactFileProvider.kt` |
| `oraculum_2.0_right_inspector_2` | HTML | 子代理详情；返回父任务、Prompt、父子 ID、阶段状态、原生工具输出、加载更早 | `InspectorSubagent`；参考 [apps/web/src/subagents.tsx](../../apps/web/src/subagents.tsx)、[bridge/src/subagents.ts](../../bridge/src/subagents.ts)；不提供自行调度子代理的按钮 |
| `oraculum_2.0_right_inspector_3` | HTML + PNG | 右抽屉「Diff」；文件标签、逐行 Diff、完整代码、输出/用量空态 | `InspectorDiff`、`InspectorOutput`、`InspectorUsage`；参考 `diff.tsx`、`diff-lines.ts`、`usage.tsx`；只读展示原生或授权文件数据 |
| `matcha_terminal/DESIGN.md` | Markdown | 色彩、字体、形状、间距、动效与响应式说明 | `OraculumTheme` 的输入；其中与屏幕、Notion 冲突的泛化描述见第 4 节 |

没有独立设计文件的必要状态：配对、凭据失效、首次项目选择、无会话、恢复失败、断网只读、历史加载/损坏、附件上传与取消、权限请求输入/MCP elicitation、会话管理与删除确认、Plan/Review/Compact、通知设置解释、Light。这些由既有能力和 2.0 正典确定，以相同设计系统补齐状态稿；不重新探索整体视觉，也不把缺稿作为删减功能的依据。

### 1.2 原文件 SHA-256

以下哈希在只读审阅时计算；本地完整机器清单另存 `/tmp/oraculum-phase0-evidence/stitch-sha256.json`，该临时文件不作为仓库交付依赖。Phase 0 结束前应按本表复核原输入未变。

| 相对文件 | SHA-256 |
| --- | --- |
| `matcha_terminal/DESIGN.md` | `120bce846d7b4e42c6f8dbfe62dcd39f89aa022ba94d4268bac63bf230f71599` |
| `oraculum_2.0_1/code.html` | `79ebc6ec3ca22d59dbb8e18b6e8c5e9d8d7003889407aefa6a14989ac84b929f` |
| `oraculum_2.0_1/screen.png` | `993fbb54dbfe565ae0899896a53fc48c24143f5e79836159f74ee0504bc2bb80` |
| `oraculum_2.0_2/code.html` | `333de0362a5585f182d93eaefbbdfbd64bbabd9f86562efbb58bfcba86fa8873` |
| `oraculum_2.0_3/code.html` | `cba000b4f94f79a19d1cb038695373e81e82b0d8e6557660d2de5f3034f463ec` |
| `oraculum_2.0_3/screen.png` | `a80980de738b9b4e27c1938dbd91ecc0e7f62ca6f4fb14ae72d92e7f6efca6bb` |
| `oraculum_2.0_4/code.html` | `4fd700b300faf3dc03a74876adc7b006471c44f99e11c9c6a6fb0168d82e18f1` |
| `oraculum_2.0_right_inspector_1/code.html` | `1037308aec1ff0fb1bbadf5e8d3e76972b07163c84720f7519a219d15de47468` |
| `oraculum_2.0_right_inspector_1/screen.png` | `d996c699f7e04cc99d44e293f5e9622d011565aaae8e97c2f7f5e14ad7d6f7f7` |
| `oraculum_2.0_right_inspector_2/code.html` | `7597c97da8e375627dd37a362e4e5019d5cac93cd6bb99b383cb43d7dbc1a513` |
| `oraculum_2.0_right_inspector_3/code.html` | `e8ed749bf7ed0d7d97197da78e48cbaa172e3f8cfdaf459077a222d94280e78c` |
| `oraculum_2.0_right_inspector_3/screen.png` | `783d50081ddd5ff19bf35b8f1f26bb74108d797015f264c94377f03ed820e26c` |

## 2. 当前源码事实与原生替换边界

当前 [apps/android/app/build.gradle.kts](../../apps/android/app/build.gradle.kts) 的应用身份为 `dev.oraculum.poc`，Debug 后缀 `.debug`，`minSdk=26`、`compileSdk=35`、`targetSdk=35`；运行依赖目前主要是 WebView。[MainActivity.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/MainActivity.kt) 创建 WebView、按入口隔离 Cookie/profile、处理附件选择/原生下载、主题恢复和通知跳转，**没有 Compose、Room 或完整 Android 原生历史库**。2.0 不应把当前 WebView 缓存称作本机持久会话缓存。

当前网络入口校验、成果传输校验、临时 FileProvider 分享、系统选择器、品牌资源、包身份和签名验证语义可复用；旧 Cookie、WebView profile、localStorage、SharedPreferences、旧草稿与旧配对不导入。UI 与会话同步重构为原生消费者，Codex Harness 仍在 Ubuntu 官方 App Server 中。新版 Room、DataStore 与 Keystore alias 使用全新命名空间，不读取旧 WebView 状态；首次全新部署按[独立交付方案](06-实施阶段与独立交付.md)处理用户重新安装/清状态与配对，不自动删除旧数据。现有 [AndroidManifest.xml](../../apps/android/app/src/main/AndroidManifest.xml) 和 [data_extraction_rules.xml](../../apps/android/app/src/main/res/xml/data_extraction_rules.xml) 已禁用/排除云备份与设备转移，2.0 要复核这些保护，避免系统恢复旧应用状态。全新初始化规则只针对旧版→2.0；之后 2.0 自身更新须维护其已建立的身份、草稿和偏好。

现有可靠性行为必须保留：[store.ts](../../apps/web/src/store.ts) 已防止迟到数据把完成状态改回运行中；[session-actions.tsx](../../apps/web/src/session-actions.tsx) 有未知原生操作阻断与回退/删除确认；[extensions.tsx](../../apps/web/src/extensions.tsx) 区分 unavailable、unsupported、partial 与未知认证；[usage.tsx](../../apps/web/src/usage.tsx) 区分账户额度和会话 token；Android [ArtifactDownloads.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ArtifactDownloads.kt) 有取消、大小/哈希、授权与重定向约束。可以重新实现原生表现层，不能静默删除这些安全和状态语义。

## 3. Design token 与 Compose 组件规范

### 3.1 深色事实与推荐归一规则

HTML 的实际色值比设计说明中的抽象文字更接近成稿，但不同屏幕并不完全一致。推荐以主对话/设置 HTML 和 DESIGN.md front matter 一致的语义值建立基础 token，以 Inspector 特有色作为组件 token；Phase 3 做同状态截图审阅后再合并，不在 Phase 0 修改定稿。

| 角色 | 已提取色值 | Compose 推荐映射 |
| --- | --- | --- |
| 根背景/表面 | `#11140F` | `background`、`surface` |
| 最低/低/普通容器 | `#0B0F0A` / `#191D17` / `#1D211B` | `surfaceContainerLowest/Low/Container` |
| 高/最高容器 | `#272B25` / `#32362F` | `surfaceContainerHigh/Highest` |
| 主文本/次文本 | `#E0E4DA` / `#C3C9B4` | `onSurface/onSurfaceVariant` |
| 主强调/主按钮容器 | `#A5D65D` / `#74A12E` | `primary/primaryContainer`；不要按变量名互换其用途 |
| 主强调上的文字 | `#213600`；容器上 `#1E3200` | `onPrimary/onPrimaryContainer` |
| 次强调/第三强调 | `#C2C9B4` / `#71DC8D` | `secondary/tertiary` |
| 轮廓/弱轮廓 | `#8D9380` / `#434939` | `outline/outlineVariant` |
| 错误 | `#FFB4AB`；容器 `#93000A` | `error/errorContainer` |
| 语义状态（设计文字） | 成功 `#4EBA6F`、警告 `#E5A93C`、中断 `#E05D52` | 额外 `StatusColors`；配文字/图标，不仅靠颜色 |
| Diff（右 Inspector HTML） | 新增背景 `rgba(116,161,46,.18)`、字 `#B8E986`；删除背景 `rgba(239,68,68,.18)`、字 `#FCA5A5` | `DiffColors`，始终保留 `+/-`、行号及文本选择 |
| Inspector 差异 | 文件面板 `#191D17`，Diff 面板 `#181C16`；文本 `#E4E7DF` / `#E3E9DC` | 初期保留组件局部值，截图对照后决定是否收敛 |

**Light/Dark 已批准，但只有 Dark 输入完整。** 设置页出现「跟随系统 / 浅色 / 深色 / OLED 纯黑」，不表示已经交付 Light/OLED 成稿；OLED 只是待用户接受的可选视觉范围，不属于新增强制验收。建议 Phase 3 为同一 token 体系补齐 Light，默认主题模式跟随系统、强调色默认 Matcha；Dynamic Color 作为可选开关，仅 Android 12+ 生效，低版本回退 Matcha。Light 衍生稿及用户同意纳入时的 OLED 衍生稿要由用户视觉审阅；这不是再次挑选总体风格。Android 官方说明 Material 3 的 `ColorScheme`/Typography/Shapes 可独立定制，Dynamic Color 从 Android 12 起可用，部分 M3 API 仍需实验性 opt-in；不能把“Expressive”当作引入全部 alpha 依赖的理由。[官方 Material 3 文档](https://developer.android.com/develop/ui/compose/designsystems/material3)

### 3.2 字体、间距与形状

| 类型 | 输入事实 | 原生实现规范 |
| --- | --- | --- |
| 正文字体 | Roboto Flex；正文 16/24、14/20、12/16 px | 映射相应 sp/lineHeight；中文使用系统可用 CJK fallback；字体若随包分发，先核实来源、许可与体积 |
| 标题 | 40/48、移动 32/40、28/36、20/28、16/24；字重 500–700 | 主工作区采用 16/24、20/28；不要为了类型齐全添加大标题 |
| 等宽 | JetBrains Mono；14/22、12/18、11/16；标签 12/16、10/14 | 代码、路径、token 与行号用等宽；数字启用 tabular figures；极小字仅限辅助信息 |
| 间距 | 4、8、12、16、24、32 px；说明使用 8dp/4dp 网格 | 常规转为同数值 dp，以实际窗口密度重排，不把 PNG 像素直接当设备 px |
| 圆角 | front matter：8/16/24/32/48/full；说明另有 16/32 叫法；抽屉 28 px | 定义按尺寸命名的 `radius8/16/24/28/32/48/full`；避免复用有歧义的 `lg/xl` 名称 |
| 点击区域 | 设计说明要求 48dp，但部分 HTML 按钮只有 28/32/44px | 视觉图标保持 20–24dp，原生交互边界至少 48dp，不能复制过小命中区域 |
| 字号偏好 | 设置稿 85%–140% | 阅读字号只影响消息/代码内容；不得降低系统无障碍字号，也不缩小审批/发送按钮；200% 系统字号须可操作 |
| 动效/层级 | 色阶、细边、圆润 pill；少量状态呼吸 | 稳定 Material 动效优先；减少动画设置下关闭无必要循环；状态信息始终由文字表达 |

Compose 的最小触摸区与语义能力应由真实组件和 semantics 保证；截图相似不能替代可访问性验收。[Compose 无障碍默认行为](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)

### 3.3 组件层级

推荐单一 `OraculumTheme` 提供颜色、字体、形状和少量业务显示 token；组件分为 `WorkspaceHeader`、`MessageCard`、`TurnProcess`、`NativeRequestCard`、`Composer`、`SessionRow`、`ProjectGroup`、`InspectorTabs`、`DiffBlock`、`ArtifactCard`、`ConnectionBanner`。业务能力由 ViewModel/Repository 提供，主题不得改发送/审批行为。

Markdown/GFM、代码、Diff 使用原生渲染。Phase 3 先验证成熟 Markdown 解析器与原生 Compose 渲染组合的表格、任务列表、代码块、链接、选择复制和超长输出；不执行 raw HTML/JS，不以 WebView 托管旧页面作为“原生完成”。具体 Markdown 包须通过这些夹具与许可证核对再锁定，属于工程验证项，不转交用户选择依赖。图片/受限 PDF 原生预览有大小上限，未知格式走系统外部打开。

## 4. 定稿中的示例/冲突审阅表

下表保留原稿，不将示例值、静态 mock 或设计文案升级成事实。已由正典决定的修正是实现约束；真正的产品取舍单列在第 9 节。

| 定稿元素 | 核对结果 | 实施推荐 / 审阅点 |
| --- | --- | --- |
| `Codex 5.2 · Mid`、`Fast AST` | 示例模型与思考等级不是运行时来源；没有已交付 Fast AST 能力 | 模型/effort 由 Gateway 转发的原生列表驱动；身份别名与实际模型分开；不新增 AST 功能 |
| 宿主名、示例路径、WSS 地址、24ms | 样例内容，不是部署配置 | 界面显示当前获授权实际值；产品入口采用 HTTPS Origin + Base Path，再派生 WSS；不把示例地址或私有部署写成默认 |
| 审批「总是允许」 | 当前原生审批有具体范围/decision 类型，不能解释成 Oraculum 永久授权 | 根据当前原生请求列出真实决策和作用域；若仅本会话允许则显示“本会话允许”，无该 decision 则不显示；原稿按钮位置保留可用槽位 |
| 回退/undo 图标 | 原生回退不承诺撤销磁盘文件 | 点击进入明确 Turn 选择和确认，说明文件变化边界；不做一键静默文件撤销 |
| 「Plugins 扩展脚本/宿主动态守护进程」 | 与既有只读原生扩展总览不符 | 按[接口兼容策略](03-Codex接口与兼容策略.md)展示已确认来源；`plugin/installed` 尚待官方支持口径与运行验证，未确认前显示“完整清单暂不可用”；不能执行任意本地脚本或重造插件运行时 |
| MCP 固定「运行中」、Skills 固定「已加载」 | 列表成功不等于可调用或已认证 | 显示已连接/未知/需认证/部分可用/不支持等实际状态，安装配置仍经官方 Codex |
| 「本周剩余额度 78% / 周五重置 / 专享」 | 静态示例；账户额度、token、resetAt 有不同来源 | 只有实际字段存在时展示；未知明确标注，不估算账单；使用量不等待退出 Inspector 才“结算” |
| 子代理完整 Prompt、耗时和进度 | 只有原生可读取内容才能展示；“当前进展”不能预测执行状态 | 不可读时显示范围限制/未知；时长注明原生值或客户端自某事件起计时；不得编造实时状态 |
| 文件列表/完整源码 | 素材不足以证明任意路径可访问 | 只在授权项目根内读取，校验实际 MIME/大小/路径/哈希；成果不自动执行 |
| DESIGN.md 中 voice、Apply、AST depth、cost、branch selector | 未在已交付能力中确认，部分也未出现在具体屏幕 | 不新增语音、直接 Apply、AST 遥测或自行计费；记录为设计说明泛化示例 |
| DESIGN.md 的 bottom navigation rails | 与 Notion 明确禁止底部 Navigation Bar 冲突；具体 7 屏没有该栏 | 以已批准三面板为准；底部 Composer 和 Android 系统手势条可保留 |
| 48dp 规范与 HTML 小按钮 | CSS 的 28/32/44px 命中区不满足自身规范 | 扩大原生命中区；长标题/徽标换行而不遮挡关闭/审批/保存 |
| 假状态栏、5G、电量、固定 844px 手机外框 | 设计画布装饰 | 生产使用系统状态栏/insets，不绘制假电量网络或固定设备外框 |
| Light/OLED/Dynamic Color | 设置入口存在，缺完整衍生稿 | 保持现有定稿不变，Phase 3 提交 Light 同屏衍生效果审阅；OLED 仅在用户接受范围后补齐；Dynamic Color 默认关闭以保留 Matcha 品牌 |
| Trusted CSS Themes | 父项目 Theme API v1 面向 Web DOM/CSS；Compose 不执行该格式 | Desktop 继续可信 CSS；Android 原生主题范围必须由用户接受（第 9 节），不得暗中取消可定制能力或塞回 WebView |

## 5. 三面板、返回栈与启动恢复

### 5.1 手机与大屏

手机中央始终是当前 Conversation + Composer。左抽屉负责项目、会话、搜索、新建/归档和设置；右抽屉负责 Diff/输出/文件/用量，子代理详情作为 Inspector 的子页。推荐一个 `activeOverlay = none | navigation | inspector` 状态，窄屏同一时刻只打开一个模态面板；打开另一个先关闭当前面板，当前 thread、草稿、阅读锚点和 Inspector tab 不随抽屉销毁。

左侧可使用 Material `ModalNavigationDrawer`。右侧使用局部 Compose 模态边栏，保持约 88% 屏宽与 28dp 左圆角的视觉关系；文件和长代码必要时可在同一 Inspector 内切换全宽阅读。不得通过全局 RTL 翻转整个界面来模拟右抽屉；中文和代码方向保持自然。实现关闭按钮、遮罩点击、焦点约束、TalkBack 标题和恢复焦点；边缘滑动不能拦截系统返回或代码横向滚动。

以实际可用窗口尺寸而非设备名称判断布局。**首个 Phase 3 里程碑推荐所有尺寸先保证同一抽屉模型**，横屏保持可操作；之后在宽度足够时做同一 Navigation/Conversation/Inspector 的并排复用，不新增 Navigation Rail 或底栏。建议并排所需最小内容宽度为导航 280dp + 对话 400dp + Inspector 320dp，再加间距；达不到则保留抽屉/双面板，不机械执行设计说明的“>840dp 三栏”。该值是待截图和折叠/分屏测试验证的建议，非已批准的新硬约束。[官方窗口尺寸分类](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)

### 5.2 返回顺序与输入法

打开抽屉时收起 IME 并保留输入，因此系统 Back 在关闭当前弹窗/菜单后优先关闭顶层面板，再按页面导航返回；Inspector 的“返回父任务”按钮回到面板内的父详情，Settings 返回来源工作区。没有抽屉时，IME 按系统惯例先收起；没有面板/子页时才退出当前 Activity。任何返回、横竖屏切换和面板开合均不执行中断或消息发送。返回预测动画与实际落点一致，手势取消不改变已保存状态。Compose 支持系统 predictive back，需按组件层级测试，不能用一个吞掉所有 Back 的处理器模拟。[官方 Predictive Back](https://developer.android.com/develop/ui/compose/system/predictive-back)

Composer 跟随 IME insets，保持多行输入、附件、发送/停止可见；窗口变小时先收敛辅助模型/权限入口的展示，实际功能仍可访问。利用 `WindowInsets`/`imePadding` 和 edge-to-edge 正确消费系统栏，避免上下重复 padding；不沿用 HTML 固定高度或伪造键盘。[官方 Insets](https://developer.android.com/develop/ui/compose/system/insets-ui)

### 5.3 恢复状态机

| 启动条件 | 可见行为 | 网络与副作用约束 |
| --- | --- | --- |
| 全新初始化，无 endpoint/身份 | 连接配置 → 一次性配对 → 项目/会话入口 | 不读取旧 WebView profile；不自动注册项目或建立 thread |
| 上次 thread 有有效本机缓存，当前离线 | 显示最后已确认内容、缓存时间与“离线只读”，恢复草稿/阅读锚点 | 禁用发送、审批、停止、归档/删除及文件主机写操作；不放入离线发送队列 |
| 有身份/上次 thread，在线 | 先展示缓存并标注核对中，查询可访问性、原生状态、未知请求后开放操作 | 先对账，后恢复订阅；不把本地“发送过”当作原生成功 |
| thread 已归档/删除/失权/不在当前项目 | 明确提示失效原因，显示可用项目/会话入口 | 不隐式 unarchive/recreate；保留本机未发送草稿并允许用户主动复制/转用 |
| Gateway 身份变化/设备被撤销/凭据无法解密 | 回连接/重新配对入口；隔离旧缓存与旧草稿 | 不把新 Gateway 连接到旧 installationId 的缓存；不自动恢复已撤销身份 |
| 缓存损坏 | 丢弃可重建缓存分区并在线重取，保留可独立读取的草稿/偏好 | 不能因历史缓存损坏清除整个应用数据或 Codex 历史 |
| 通知进入指定 thread | 校验 endpoint/installationId/身份与 notice 当前状态后打开指定 thread | 已处理或不可访问则回入口；通知点击不自动批准/发送 |

上次 thread 与阅读锚点需持久保存，`SavedStateHandle` 只保留小型导航恢复数据。官方说明它依赖任务栈，用户 force-stop、移除任务或重启后不保证恢复，因此不能单独承担已批准的“默认恢复上次会话”。[官方 SavedStateHandle 文档](https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-savedstate)

## 6. Android 技术选型与数据分工

| 层 | 推荐 | 理由及限制 |
| --- | --- | --- |
| UI | Kotlin、Compose、Material 3；稳定基础组件上实现 Expressive token | 已批准路线；原生能力与独立 UI；实验性组件按需局部 opt-in，并有稳定替代 |
| 状态 | AndroidX ViewModel + Kotlin Coroutines/StateFlow、生命周期感知订阅 | 单向数据流；Activity 重建不丢失会话选择；不新建通用 Agent/事件总线框架 |
| 模块 | 首期维持一个 Android app Gradle 模块，按 `ui/data/network/security` 包划分 | 同仓库独立客户端已足够；协议生成代码放单独目录，无需为少量页面拆大量 module |
| 网络 | 一个受控 HTTP/WSS 客户端与连接 Repository；复用协议文档确定的请求/事件 Schema | HTTP 承载读查询、发送/审批等写操作和文件传输，WSS 承载流式事件；版本/能力不足时明确降级；不以 Cookie/WebView 登录作为长期设备身份 |
| 历史缓存 | Room + SQLite，DAO/事务、索引与分页 | 复杂关联和部分更新适合 Room；历史是 Codex 投影，不能成为权威执行事实 |
| 本机偏好 | Preferences DataStore；小对象、可默认恢复 | 主题/字号/上次入口/通知开关；不把大历史、附件或密钥塞进 DataStore |
| 凭据 | Android Keystore 保存不可导出的密钥；按认证方案封装设备凭据 | Keystore 保存密钥不是任意 token；若使用 token，则用 Keystore 密钥加密到 app 私有存储，不写明文偏好/日志 |
| 文件与系统能力 | Activity Result API + SAF/Photo Picker + FileProvider | 明确用户选择范围；系统保存/分享；不申请全盘文件权限 |
| 后台 | 前台连接 + 用户主动启用的任务提醒服务；延后性工作才使用 WorkManager | 不引入外部推送账户/第三方云；后台保证范围需真机测量，见第 7 节 |

Room 与 DataStore 的分工有官方依据：Room 面向结构化本机数据与离线缓存；DataStore 适合小数据，复杂关系或部分更新应使用 Room。[Room](https://developer.android.com/training/data-storage/room)、[DataStore](https://developer.android.com/topic/libraries/architecture/datastore)

本轮不修改 Gradle 或锁定一个未构建过的组合。Phase 2 Android PoC 开始前必须固定稳定 Compose BOM、Kotlin/AGP、Room/KSP 和网络库版本，保留解析后的依赖与许可证清单，再跑 release/debug 构建与最低 SDK 验证。保持 `minSdk=26` 的既有支持线是推荐；compile/target SDK 依据实施时稳定工具链和所需系统行为选定，升级后必须重测 insets、通知、前台服务与存储。不能照搬当前依赖清单并宣称已支持 Compose。

### 6.1 本机数据模型约束

具体共享字段和协议以本套缓存/协议文档为准，Android 需满足如下持久化分工；以下所有缓存、草稿、阅读及传输记录均继承完整基础分区：

- `serverProfile`：规范化 Origin/Base Path、Gateway 全新安装身份 `installationId`、`deviceId` 及凭据引用；基础分区键为 Origin + Base Path + installationId + deviceId，再按 projectId/threadId 分区，不保存私有默认值。按 04 的统一契约使用 `epoch`：Gateway 或 App Server 任一重启、原生连接重建都会变化，同时使旧审批和事件失效；它不替代安装身份，客户端不再维护两套公开代次字段。
- `thread/turn/item cache`：在上述完整基础分区和 projectId/threadId 范围内以原生 turn/item ID 为键，保留查询代次/水位、来源修订或内容指纹、是否完整/截断、lastVerifiedAt、分页游标。分页按原生/Gateway cursor；不能靠本地数组长度推导完整历史。
- `draft`：完整基础分区 + projectId/threadId、文本、附件选择的本地引用、更新序号；与可丢弃历史缓存分表或分库管理，缓存重建不得删草稿。发送回执未知时保留草稿和 requestId 的关联，禁止恢复后自动重发。
- `readingState`：原生 turn/item 锚点 + 相对偏移，及是否跟随底部。加载更早消息、跨屏、压缩/回退后锚点失效时落到最近仍存在的条目，并提示内容已校正。
- `transfer`：只有用户发起的上传/下载临时任务；保存大小、hash、进度和失败状态。缓存 URI 授权可被撤销，重开附件须验证；它不是后台自动执行命令队列。
- DataStore：主题、字号、最后工作区、抽屉展开/Inspector tab 和通知偏好。大头像/字体/附件在受控私有文件目录，只保存引用。

缓存 LRU/上限、分页大小、连接重试等是可测的实现参数，不需要用户逐一决定。推荐先以设备容量限额而非无限增长管理缓存；保留当前会话、未发送草稿、未知请求关联不被普通历史 LRU 清理。无原生修订号时必须用明确的重新读取/替换策略，不能假定任意 delta 永远可拼接。

## 7. 认证、文件与后台通知

### 7.1 身份与文件

Android 原生身份与旧 WebView Cookie 分离。首次从 CLI 一次性码建立长期设备身份；HTTP 与 WSS 使用相同 installationId/deviceId 授权语义；短期 access 凭据过期时用仍有效的长期凭据安全换取新 access；网络失败进入离线/退避重试，不因此删除身份；仅撤销、长期凭据失效或 Keystore 无法解密等身份失效情况进入重新配对。不绕过 TLS、不跨 Origin 转发 Authorization，不把凭据放 URL/Intent/通知中。Keystore 是否硬件支持需实际检查；不能要求所有手机都有 StrongBox，也不能把“不可导出密钥”写成“进程被攻破后绝对安全”。[官方 Keystore](https://developer.android.com/privacy-and-security/keystore)

文件流程推荐：本地附件 → SAF/图片选择器 → 检查实际内容/MIME/大小 → 上传到授权项目的附件入口 → 显示完成后的 attachment reference；发送消息时再引用，未知发送不自动复用重发。主机项目/文件浏览始终经 Gateway，客户端本地的 `content://` 不当作 Ubuntu 路径。

成果保存用 `ACTION_CREATE_DOCUMENT`；外部打开/分享仅授予临时 `content://` 读取权限，不暴露认证下载 URL。私有下载缓存设容量/寿命，取消与空间不足可恢复；Gateway 拒绝越界/符号链接等路径风险。官方 SAF 以系统选择器和 URI 授权限定访问范围，适合文档导入/保存，不需要全盘存储权限。[官方 SAF](https://developer.android.com/training/data-storage/shared/documents-files)

### 7.2 通知策略与可承诺边界

现有 [TaskNotificationService.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/TaskNotificationService.kt) 每 2 秒 HTTP 轮询，使用 `remoteMessaging` 前台服务；它保留脱敏摘要、短租约撤销、已读去重、不持久化 Cookie 和通知点击复核。2.0 应保留这些语义，把常态 2 秒轮询改为复用 WSS 事件/摘要订阅，断线后有限退避重连；没有可靠连接就显示中断，不能宣称持续在线。

推荐基本承诺：应用前台及用户从前台主动开启后台提醒后按 Home，能在保持连接时收到完成/失败/待审批/待输入提醒；系统权限拒绝不影响基本对话；点击重新核对状态。Android 13+ 对通知有运行时权限，服务通知也必须正确声明。[通知权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)

后台机制仍有一项必须在 Phase 3 工程试验中闭合的风险：官方 `remoteMessaging` 用途是设备间文本消息传输与消息任务连续性，不能仅因“无 runtime prerequisite”就认定任何后台轮询适用；实现者需证明 Oraculum 的跨设备会话连续性符合类型语义，或对替代服务类型给出明确评估。既有声明不是 2.0 合规性或无限存活的证明。[前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)

Android 12+ 限制从后台任意启动前台服务；Android 15+ 的 `dataSync`/`mediaProcessing` 还受后台时限约束，因此不能改名为 dataSync 就获得无限长连。无第三方推送、无外部基础设施改动的前提下，不承诺 force-stop、Doze、OEM 清理和系统杀进程后即时提醒；应记录实测范围及前台回来后的补偿同步。[后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[服务时限](https://developer.android.com/develop/background-work/services/fgs/timeout)

WorkManager 用于可延后的缓存清理或显式传输后处理，不能承载实时 WSS 常驻/自动重发未知写入。它有持久调度与系统省电约束，不是实时消息保证。[官方 WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent)

## 8. Phase 3 实施顺序与验收

这是一份供总体 Phase 1–5 计划引用的 Android 子计划。Gateway/协议/身份能力与审阅后的缓存规则是前置依赖；不能跳过 Phase 1–2，先把设计稿套在旧 WebView 上算作 Phase 3 完成。

| 增量 | 交付与验证 | 不通过时处理 |
| --- | --- | --- |
| A. 原生壳与连接 | 复验 Phase 2 已完成的原生壳/依赖锁定/配对/Keystore/HTTP/WSS PoC 基线，再扩展独立本地资源与正式页面；Debug 隔离身份 | 保留旧安装与证书，修复协议/身份，不放宽 TLS，不导入旧信任 |
| B. 对话最小闭环 | 复验 Phase 2 已完成的最小发送/事件/重连闭环，再补项目/会话入口、默认恢复、Room/DataStore、停止/未知对账、左右抽屉 | 未知写保持查询状态；不自动重发来伪造成功 |
| C. 核心能力齐全 | GFM/代码、过程/Plan、审批与输入、模型/effort/权限、会话操作、Diff、用量、扩展/子代理 | 按能力表明确禁用/提示受限接口，修复必要适配；不伪造 UI 数据 |
| D. 文件与设备体验 | SAF、上传、成果保存/分享/预览、通知、IME、Back、旋转、缓存修正、长历史性能 | 按断网/过期/空间不足清理临时资源，保留草稿与原生历史 |
| E. 视觉与正式候选验证 | 深色逐屏对照与 Light 衍生稿审阅；OLED 仅用户同意纳入时验收，动态色可选，真实手机与远程链路，签名身份静态检查 | 不宣称模拟器/静态截图替代真机；签名/安装/正式发布按独立授权执行 |

### 8.1 可测验收清单

1. **设计保全**：原 12 文件全部 SHA-256 不变；7 个屏幕逐项有对应原生页面/状态；4 PNG 的同状态对照可追溯。没有底部 Navigation Bar，没有加载旧 Web 页面。
2. **导航恢复**：左/右面板连续开合、系统 Back、旋转、系统进程回收、正常重新打开后，会话/草稿/阅读锚点保持；首次/失效回退绝不产生 `thread/start` 或 `turn/start`。通知跳转后 Back 正确返回。
3. **真实状态**：完成 turn 不被旧分页改回运行中；线程回退/压缩/删除后缓存可校正；并发双端审批仅一个结果被原生接受；另一端显示已处理。原生不支持的能力显示受限，不生成本地替代执行。
4. **离线/重连**：断网可读已加载内容和编辑本机草稿，所有副作用操作禁用；WSS 断线、Gateway 重启、游标失效、确认丢失后先对账，无重复命令/审批/消息。
5. **身份**：新安装全新配对；相同包名+证书不代表继承旧数据。撤销、续期竞争、Keystore 失效、服务身份变化、URI 重定向、日志脱敏有明确测试；无认证信息进入通知和分享 Intent。
6. **输入与可访问性**：360/390dp 窄屏、横屏短高度、平板/分屏；中文拼音输入、长草稿、GFM 宽表、长路径、长模型名；默认及 200% 系统字号下发送/停止/审批/关闭可见可点，触摸区至少 48dp，TalkBack 可读状态与操作名称。
7. **文件**：图片/文档选择、取消、过大/错 MIME、URI 授权失效、下载中断/磁盘不足、文件被换掉、临时分享授权与外部无接收器；不要求 broad storage permission，不执行产物。
8. **通知**：通知允许/拒绝、渠道关闭、前台/按 Home、断线/恢复、已读/已处理不重复、点击失效审批；真实目标设备记录后台时长、接收延迟和耗电观察。Doze/锁屏/force-stop 等未测范围明确列出。
9. **性能与缓存**：先定义代表性夹具（例如 1,000 条已完成 item、长工具输出与分页、连续流式增量），测冷启动缓存首屏、切会话、滚动、内存与数据库增长；发布前确定测量基线和允许退化范围。未经测量不承诺某个毫秒值。
10. **发行边界**：`dev.oraculum.poc`、原长期证书、明确 versionCode 与 sourceGit；不把本阶段研究当成构建/签名/安装授权；真实 Codex 项目、会话和配置的保全要有证据。

## 9. 真正需要用户审阅的剩余问题

**Android 原生可定制主题的产品范围**需要一次明确接受：推荐 2.0 Android 先提供已定稿 Matcha、Light/Dark、可选 Dynamic Color、阅读字号与双方本机身份；原始可信 CSS 主题继续在 Desktop 支持。Android 不承诺直接运行 Theme API v1 CSS，也不偷偷删掉“可定制”要求。若用户仍要求可导入任意主题包，应另行定义不含脚本的原生 token/资源格式及范围，再估算是否纳入 2.0；不要做通用 CSS→Compose 转换器。依据是父项目 [docs/THEMING.md](../../docs/THEMING.md) 的 DOM/CSS 合约与本子项目原生 Compose 决策之间存在格式边界。

其余事项不重复要求用户决策：Kotlin/Compose、无底栏、恢复上次会话、包名/证书、全新配对、无旧状态迁移均已批准。Light 具体视觉效果属于 Phase 3 衍生稿验收，OLED 只有用户接受纳入范围后才成为验收项；横屏是否三栏、库版本、字体许可、后台服务类型、缓存阈值属于实施者应完成的技术验证。只有用户希望提升为“应用被强停/深度休眠仍必须即时提醒”时，才需要另行讨论额外推送基础设施与权限，本文不擅自增加该范围。

## 10. 证据限制

本轮完成静态源码审阅、原始设计文件哈希、4 张已有 PNG 的直接视觉检查，以及 Android 官方资料核对。未启动 Android 模拟器/真机、未新建 Compose 工程、未构建/安装 APK、未读取签名口令、未触及旧应用数据或正式服务。技术推荐和验收清单不能当作已有实现的通过记录。
