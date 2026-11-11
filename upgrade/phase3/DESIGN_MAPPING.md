# Phase 3｜Stitch → Android 原生实现映射

本文件记录 2026-11-12 Phase 3 的设计输入、冲突裁定与真实能力边界，供实现和独立审阅逐项对照。它是实施映射，不是测试通过声明；最终完成范围、设备截图、测试及 APK 以本阶段工程报告为准。

依据为 [Phase 3 正式任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[父项目最新授权](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)、Phase 0–2 已接受交付，以及 [Phase 0 Android/Stitch 规格](../phase0/05-Android与Stitch落地.md)。Phase 0 的待审主题建议已被最终裁定覆盖：同一设计实现 Light / Dark / OLED Dark，无额外设计稿、旧 CSS 主题迁移或底部 Navigation Bar。Phase 2 已交付 Kotlin/Compose、GatewayClient、Room/DataStore/Keystore 与未知回执保护；本阶段延续这些分层。

## 1. 设计输入与原件保全

唯一输入目录是 `upgrade/stitch_oraculum_android_workspace/`，不是历史拼写 `andriod`。本次逐一只读检查了 **7 个 HTML、4 张 PNG、1 个 DESIGN.md，共 12 文件**；全部 SHA-256 与 Phase 0 原件表一致。不存在独立 Light/OLED、键盘展开或额外设计屏幕。三个没有 PNG 的目录只存在 HTML，不能描述成已经检查了对应原始截图。

本次原件基线存于忽略目录 `.local/evidence/oraculum-v2-phase3/stitch-baseline.json`，包含相对路径、字节数及 SHA-256，结束时应逐项复核。原件不移动、不修改、不重新生成，也不随实现提交；完整公开哈希表已存在 Phase 0 规格第 1.2 节。

HTML 仅作静态设计输入，不执行其中 Tailwind CDN、Google Fonts 或示例 JavaScript，不转换成 WebView 页面。PNG 中的系统时间、5G、电量、设备外框和手势条是画布装饰；实际 App 使用 Android 系统栏和 Insets。文件预览稿里的灰色 `img` 占位也不是可用产品图片。

## 2. 七个屏幕的唯一落点

下表的组件名表示职责，不要求为每个名称新增 Kotlin 文件或抽象层。工作区入口为 [OraculumScreen.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt)，其中落点包括 `NavigationPanel`、`Conversation`、`Composer`、`InspectorPanel`、`SettingsPanel`、`UnknownRecoveryPanel` 和 `MarkdownContent`；设计系统为 [OraculumTheme.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumTheme.kt)，数据与安全状态由现有 ViewModel/Gateway 层提供。

| Stitch 目录 | 实际视觉与交互 | Compose 页面/组件职责 | Gateway / 原生事实与限制 |
| --- | --- | --- | --- |
| `oraculum_2.0_1`（HTML + PNG） | 顶部会话/项目标题、左眼睛导航和右 Inspector 入口；双方左对齐卡片、完成过程折叠、Markdown/代码、Composer | 工作区 Header、对话 LazyColumn、用户/助手消息卡、过程摘要、原生 Markdown、代码块、Composer；最终答复不随过程折叠隐藏 | 项目/线程查询、历史/详情、WSS item/turn；发送/停止/恢复只走明确写契约。复制/系统分享使用已显示内容；分叉/回退没有当前公开写契约时不显示伪按钮 |
| `oraculum_2.0_2`（HTML） | 左抽屉约 84% 宽，右角 28dp；品牌、新建、搜索、项目树/会话、连接/设置 | 导航 Drawer、项目组、会话行、本地筛选、授权根目录浏览及项目注册；当前会话选中态与待处理状态 | `projects`、`project-directories/query`、分页线程列表/显式新建。筛选说明为“筛选已加载会话”；归档列表可按已有查询字段读取，不能据此提供归档/恢复/删除写操作；额度只用真实字段 |
| `oraculum_2.0_3`（HTML + PNG） | 设置分组卡：本机身份、原生扩展、主题/字号、连接与通知 | 设置页/Sheet、本机显示偏好、三主题选择、阅读字号、连接状态及系统通知入口；扩展与 Inspector 共用只读数据 | 主题/字号/本机别名不改变 Codex 配置或模型身份；端点使用 HTTPS Origin + Base Path。扩展需公开只读契约和真实能力结果；无真实数据时显示 unavailable/unsupported，不能固定“运行中” |
| `oraculum_2.0_4`（HTML） | 运行中对话与命令审批卡；命令、工作目录、响应、停止 | 原生 Interaction 卡；可选决策、结构化输入/elicitation、过期/冲突/已处理状态；Composer 停止按钮 | Snapshot/WSS 中当前 `interactionId + epoch + generation`；`interactions/:id/response`。只显示 Gateway 接受且本请求允许的响应；不复制原稿“总是允许”承诺 |
| `oraculum_2.0_right_inspector_1`（HTML + PNG） | 右 Inspector、四分区、文件路径/列表/选中态、真实预览、保存/外部打开/分享 | 右面板文件分区、面包屑、文件列表、预览卡；SAF 保存、FileProvider/系统 Sharesheet | 授权项目 `files/query`、`files/select`、`files/:fileId/content`；核对 MIME、长度和 SHA-256。系统外部打开在 Android 上执行，不实现“在宿主机打开”；无额外主机文件写入 |
| `oraculum_2.0_right_inspector_2`（HTML） | 子代理详情、父任务返回、完整 Prompt、原生 IDs、工具日志、加载更早 | Inspector 执行详情子页/展开区、有限层级活动列表、ID/来源说明 | 仅从可识别原生 collab Item/事件提取父子关系和已公开内容；不推断子代理、命令计数或耗时。不提供自行调度。若独立子线程读取/分页未被 Gateway 授权，则说明仅显示父线程已提供的活动 |
| `oraculum_2.0_right_inspector_3`（HTML + PNG） | 右 Inspector 的 Diff/输出/文件/用量；文件 chip、逐行 `+/-`、完整内容、空态 | 同一个 Inspector 的 Diff/输出/用量分区；代码横向滚动、选择复制、细节加载 | `turn/diff/updated`、`fileChange`、命令 Item/输出、`thread/tokenUsage/updated` 等经 Gateway 校验事件与历史。完整文件须另经文件授权；“退出后结算”等原稿示例文案不采纳 |

配对、初次选择、空会话、加载失败、离线只读、未知写入、游标失效、大 Item、附件上传/取消、通知权限、已处理审批等没有独立 Stitch 图，仍使用同一色阶、卡片、字体和按钮系统补齐真实状态；它们不构成重新设计。

## 3. 归一化设计 Tokens

### 3.1 Dark 的来源裁定

采用 `matcha_terminal/DESIGN.md` **front matter 与主对话/设置 HTML 一致的语义颜色**。DESIGN 正文另出现 `#121511 / #181C16 / #21261F / #2B3229`，以及把 `#74A12E` 称作 primary 的文字；这些是较早的泛化说明，不覆盖定稿主画面的语义表。`#A5D65D` 是主强调，`#74A12E` 是主强调容器，不按文字别名互换。

| 语义 | Dark 定稿值 | 原生用途 |
| --- | --- | --- |
| background / surface / surfaceDim | `#11140F` | 工作区、对话底色、系统栏协调 |
| surfaceContainerLowest | `#0B0F0A` | 命令/预览最深层 |
| surfaceContainerLow | `#191D17` | 用户卡、导航、Composer 所属表面 |
| surfaceContainer | `#1D211B` | 助手卡、标准内容容器 |
| surfaceContainerHigh / Highest | `#272B25` / `#32362F` | 过程、菜单、模型/权限 chip、交互状态 |
| surfaceBright | `#363A33` | 更亮的表面状态 |
| onSurface / onSurfaceVariant | `#E0E4DA` / `#C3C9B4` | 主文本/次文本 |
| primary / onPrimary | `#A5D65D` / `#213600` | 发送、选中、强调与其文字 |
| primaryContainer / onPrimaryContainer | `#74A12E` / `#1E3200` | 品牌、状态容器及其文字 |
| secondary / onSecondary | `#C2C9B4` / `#2C3323` | 次强调与其文字 |
| secondaryContainer / onSecondaryContainer | `#454B3B` / `#B4BBA6` | 次要 pill 与标签 |
| tertiary / onTertiary | `#71DC8D` / `#003918` | 成功/连接相关强调 |
| tertiaryContainer / onTertiaryContainer | `#39A75E` / `#003416` | 第三强调容器 |
| outline / outlineVariant | `#8D9380` / `#434939` | 必要边界 / 弱分隔 |
| error / onError | `#FFB4AB` / `#690005` | 错误文字及实色按钮文字 |
| errorContainer / onErrorContainer | `#93000A` / `#FFDAD6` | 错误提示卡 |
| inverseSurface / inverseOnSurface | `#E0E4DA` / `#2D322B` | 反色提示 |
| inversePrimary | `#446900` | Light 主强调适配的输入 |

Diff 原稿新增为 `#B8E986` 字 + `#74A12E` 18% 填充，删除为 `#FCA5A5` 字 + `#EF4444` 18% 填充；同时保留 `+/-`、路径和上下文，不能只靠红绿判断。原稿成功 `#4EBA6F`、警告 `#E5A93C`、中断 `#E05D52` 是语义色输入；小字号文字必须用足够对比的对应色，必要时改用 ColorScheme 的文字角色。

Light 从同一组角色适配浅背景、深文字和 Matcha 主强调；OLED Dark 使用纯黑 `#000000` 根背景，容器仍以可分辨色阶分层。不能只把 Dark 根背景换黑、却保留所有低对比边界。三模式共用排版、间距、组件结构及安全状态，不使用 Dynamic Color 或新增主题包作为交付依赖。最终三套实现色值以 `OraculumTheme.kt` 为准，颜色计算与真实设备截图应同时核验。

实施中的 Light/OLED 适配值如下。Dark 的 `onSecondaryContainer` 从定稿 `#B4BBA6` 调整为同色族 `#DEE5CF`，提高次要容器小文字对比，其余上表是定稿来源值。字体使用 Android 系统 Sans/CJK 和 Monospace，保留离线可用性，无额外下载字体。

| 语义 | Light | OLED Dark |
| --- | --- | --- |
| background / surface | `#F8FAF1` | `#000000` |
| lowest / low / container | `#FFFFFF` / `#F1F4E9` / `#EBEEE3` | `#000000` / `#0C100B` / `#141912` |
| high / highest | `#E5E8DD` / `#DEE2D6` | `#20261D` / `#2D3428` |
| onSurface / onSurfaceVariant | `#191D17` / `#434939` | `#E9EDDF` / `#CCD3BE` |
| primary / onPrimary | `#446900` / `#FFFFFF` | `#A5D65D` / `#213600` |
| primaryContainer / onPrimaryContainer | `#C0F275` / `#1E3200` | `#74A12E` / `#1E3200` |
| outline / outlineVariant | `#737B67` / `#C3C9B4` | `#8D9380` / `#4C5541` |
| error / errorContainer / onErrorContainer | `#BA1A1A` / `#FFDAD6` / `#410002` | `#FFB4AB` / `#93000A` / `#FFDAD6` |

对当前源码的实色 token 进行 sRGB 相对亮度计算，得到下列对比值。这里没有包含禁用 alpha、混色后的 Diff 背景、系统栏截图或 TalkBack，所以只能证明指定色对，不能代替完整无障碍验收。

| 色对 | Dark | Light | OLED Dark |
| --- | ---: | ---: | ---: |
| 主文本 / 根表面 | 14.40:1 | 16.22:1 | 17.64:1 |
| 次文本 / 最高容器 | 7.24:1 | 7.09:1 | 8.34:1 |
| 主按钮文字 / primary | 7.77:1 | 6.43:1 | 7.77:1 |
| 主容器文字 / primaryContainer | 4.55:1 | 10.72:1 | 4.55:1 |
| 错误卡文字 / errorContainer | 7.24:1 | 13.26:1 | 7.24:1 |

### 3.2 排版、间距、形状与图标

| 角色 | 定稿输入 | 原生归一规则 |
| --- | --- | --- |
| 正文 | Roboto Flex 16/24、14/20、12/16 | `sp`/lineHeight；中文采用 Android CJK fallback。可用系统 Sans 保持原生离线字体；未经许可核验不下载/打包字体 |
| 标题 | 20/28、16/24，500–600 字重 | 工作区和分组为主；40/48、32/40 大标题 token 不要求新增屏幕 |
| 代码与数据 | JetBrains Mono 14/22、12/18、11/16 | 系统 Monospace 可作离线回退；代码/路径/计数使用等宽，数字适用时用 tabular figures |
| 标签 | 12/16、10/14 | 极小字号仅用于非关键辅助信息；发送/审批/错误信息不能依赖 10sp |
| 间距 | 4 / 8 / 12 / 16 / 24 / 32 | 转为 dp；主要 8dp 节奏，内部 4dp 对齐 |
| 圆角 | 8 / 16 / 24 / 28 / 32 / 48 / pill | 按数值定义；代码卡通常 16dp，抽屉/Composer 采用 28dp 语义；避免 `lg/xl` 在稿件中的不同解释 |
| 表面 | 主要靠色阶，不靠大投影 | 使用 ColorScheme 分层，必要 1dp 边线；不模拟网页 blur 背景或设备外框 |
| 图标 | Material outlined、Oracle Eye | 20–24dp 视觉尺寸；圆按钮至少 48dp 点击区；每个可操作图标有中文语义名称 |
| 动效 | 轻量展开、状态提示 | 使用现有 Material 交互反馈；无必要无限呼吸动画可省略，不用动画表示唯一状态 |

## 4. Gateway 真实能力矩阵

公开 HTTP 路径均相对于用户配置的 `Origin + Base Path + api/v2/`；WSS 同源派生。下表依据 [server.ts](../../gateway/src/server.ts)、[service.ts](../../gateway/src/service.ts)、[codex.ts](../../gateway/src/codex.ts)、[interactions.ts](../../gateway/src/interactions.ts) 及单源 [v2.json](../../packages/gateway-protocol/schema/v2.json)。旧 React/Bridge 能力不能自动视为新版 Gateway 已提供。

| UI 能力 | 公开事实 / 契约 | 可用性与动作边界 |
| --- | --- | --- |
| 连接、配对、续期 | health、auth/pair、auth/token、capabilities、events | 沿用 Keystore 和严格 HTTPS/WSS；不以新配对清除 unknown，不将凭据放 Intent、URL、通知或日志 |
| 项目浏览/注册 | projects、project-directories/query、POST projects | 仅授权 rootId/相对目录；注册是独立 operation，unknown 时不可换 ID 自动再注册 |
| 会话分页/切换/新建 | projects/:id/threads、GET thread、POST threads | 显式新建；切换与列表刷新为只读；本地筛选明确仅覆盖已加载列表；不自建全文搜索 |
| 模型/effort | models、capabilities、TurnStartRequest | 模型/effort 来自真实列表，不使用 `Codex 5.2 · Mid` 示例常量；默认/未知不冒充用户已选择值 |
| 权限 preset | `read-only` / `auto` / `full-access` | 映射由 Gateway 固定；read-only/auto 为 on-request，full-access 为 never + dangerFullAccess。auto 的工作区写权限和网络受限必须按真实策略说明；危险选项显式确认，不修改主机默认配置 |
| 发送/停止/显式恢复 | turns、turns/:id/interrupt、threads/:id/resume | 需要当前身份、epoch、项目/线程与 operationId；恢复线程不等于自动开始 Turn；离线、未知写和不可信状态阻止新增副作用 |
| 历史和大 Item | history/query、history/details、snapshot | 保留 complete/truncated/source/nextCursor、revision、digest 信息；摘要不是全文。游标失效后只读校正，不把失败伪装成空历史 |
| 原生审批/输入 | snapshot interactions、interaction.opened/resolved、response | 当前 pending/epoch/generation 才能答；仅可用决策。其他设备已处理、取消、未知响应分别显示；不制造永久授权 |
| Plan/Diff/工具/子代理 | Gateway 已校验的原生 Item/事件 | 仅显示实际存在字段；Plan 更新不意味着可切 Plan 模式；父线程中的 collab 事实不等于客户端能够独立调度或读取任意子线程 |
| token / 上下文 | 原生 tokenUsage 事件及可恢复事实 | 没有窗口上限不算百分比，没有 token 数据不显示 0；账户额度与本线程用量区分；没有计费数据不估算费用 |
| Skills/MCP/Apps/Plugins | Phase 2 基线无专用列表路由；Phase 3 如增加则需专用只读 Gateway 契约和协议测试 | 仅已核实稳定方法；返回 partial/unavailable/unsupported 必须如实显示。`plugin/list`、实验目录、安装/卸载和任意 RPC 不开放 |
| 文件/成果 | files/query、files/select、files/:id/content | grant 绑定身份/项目/可选 thread；过期、替换、目录不合法、摘要不符时不交给预览/外部 App |
| 本机附件 | threads/:id/attachments、DELETE attachments/:id；TurnStartRequest 引用 | SAF Content URI 在应用内读取；实时 capabilities 限额优先。上传和删除分别持有 operationId，发送认领与其 Turn 关联，未知时不得重复上传/认领 |
| 通知 | 已授权当前连接中的真实事件 + Android 系统 | 无新推送服务、后台执行或模型行为；点击只定位并刷新，不自动发送/审批。权限拒绝仍可使用前台对话 |

Phase 2 基线声明 `plan.mode`、`plugins.catalog`、`turn.steer` 为 unsupported；此文不授权将它们升级为按钮。归档列表的读取能力也不等于支持 rename/archive/unarchive/delete/fork/rollback 等写操作。确需新增公开能力时，先核实官方稳定方法，再做最小白名单路由、Schema/TS/Kotlin DTO 与测试；没有通过的能力继续显示受限。

## 5. 设计冲突的最终采用项

| 冲突 / 示例 | 采用的实现 | 不采用的内容与理由 |
| --- | --- | --- |
| DESIGN prose 与 front matter 的色值/圆角名称不一致 | 主对话/设置和 front matter 的语义 Tokens；半径按 dp 命名 | 不将每个稿件色值堆成独立主题，避免视觉与组件角色漂移 |
| DESIGN 提及底栏、rail、>840dp 三列和 40:60 代码编辑器 | Notion 确定的导航/对话/Inspector；按可用空间复用同一组件 | 不新增底部导航、主代码编辑器或固定比例桌面 UI |
| 主稿 PNG 与 HTML 头像/滚动位置有差异 | 双方身份的左对齐卡片，真实文本驱动自然高度 | 不裁掉用户作者行来机械复刻截图取景；不固定 844/884px 内容高度 |
| 设计动作“分叉/回退/总是允许” | 仅经真实契约可用的操作与本次请求提供的决策 | 没有稳定/公开契约时不展示可点击假操作；不承诺撤销磁盘文件 |
| 模型、Fast AST、宿主名、24ms、工作区路径 | 由当前真实数据展示，缺失留空或说明不可得 | 不内置样例模型、遥测数字或用户部署默认值 |
| 额度 78%、专享、周五重置、退出后结算 | 仅真实账户字段或 token 字段；缺失明确提示 | 不推算账单、重置时间或根据关闭 Inspector “结算” |
| Plugins 扩展脚本/动态守护进程 | 稳定原生扩展的只读信息 | 不创造插件执行器、市场、安装入口或自建 Agent Runtime |
| 文件 PNG 灰色占位/外部打开 | 校验后的本机实际预览；Android 外部打开/分享 | 不显示假图片，不提供没有 Gateway 能力的宿主机打开 |
| 独立键盘/键盘叠层设想 | Android 原生 IME + insets | 不重绘键盘、不新增假键盘屏幕 |
| 强调色圆点/Dynamic Color | 首版采用定稿 Matcha + 三配色 | Dynamic Color 非必交，不用无行为的色点装饰成可选功能 |
| 设置昵称与头像 | 作为本机显示偏好，和实际模型独立 | 未实现某偏好时不留可点击假入口；不导入旧 WebView 身份数据 |
| 原稿极小按钮与禁止缩放 viewport | 原生触摸区 ≥48dp，系统字体缩放 | 不复制 28/32px 命中区或禁用无障碍缩放 |

## 6. 响应式、阅读状态与可访问性

手机窄屏保持中央对话与 Composer；左导航、右 Inspector 分别按需打开，同一时刻只保留一个模态面板。侧面板开合保留线程、该线程草稿、滚动锚点及 Inspector 所选分区；切线程不会共享草稿或未决 operation。返回先关闭当前弹窗/子页/面板，再执行页面返回；IME 收起遵循 Android 系统行为，不发送或停止请求。

右 Inspector 维持约 88% 视觉关系与左圆角 28dp，左导航约 84% 与右圆角 28dp；超窄屏、长代码、大字体时允许原生面板用足可用宽度。不得通过全局 RTL 实现右侧抽屉，中文和代码自然方向保持。大屏按实际可用窗口选择并排：导航约 280dp、对话至少约 400dp、Inspector 约 320dp 是 Phase 0 建议的可用性起点，不是硬编码设备型号或 840dp 即三列的承诺。横屏/分屏不足时回退面板。

Composer 使用多行原生输入与内部滚动、`imePadding`/系统 Insets，48dp 的发送/停止始终可达；长模型/权限标签可换行或滚动。对话、代码、GFM 宽表不撑破工作区；代码/表格局部横向滚动，长路径可选择复制。Markdown 链接仅按可验证 scheme 交给系统，raw HTML/JS 不执行。

可访问性验收必须包括：中文 TalkBack 名称、选中/展开/禁用语义、面板标题、返回焦点、真实状态文字；关键状态不能仅靠颜色/动画。至少默认与 200% 系统字体下检查发送、停止、审批、关闭、分页和 unknown 动作。文字/按钮随内容增长而不是固定高度裁切；阅读字号偏好不降低系统无障碍字号，也不缩小关键控件。

## 7. Unknown 与恢复的可见合同

Unknown 是工作区一级状态，包含操作类型、项目/线程、operationId、创建时间、最后 delivery/status 与影响范围。说明“请求可能已到达主机，暂时不能确认结果；继续发送可能重复执行”，保留当前草稿和附件关联。

安全动作只有查询**原 operation 回执**、只读刷新原生线程和确有活动 Turn 时停止该 Turn。查到 accepted/rejected 等事实后才能解除相应屏障；404、无回执、断网、重建缓存、停止完成、改设备身份都不证明原操作没有发生。不能提供强制清除、换 operationId 重发、换设备/配对/项目注册的绕过入口。

无法收敛时显示操作标识和主机侧检查说明：由主机操作者核对 Gateway 原回执与原生线程记录，不要求手动编辑数据库或删除 Codex 数据。没有经过证明与测试的证据型恢复 API 就继续保持 unknown；“用户确认没有执行”不是原生事实。

恢复状态区分离线缓存、access 续期、WSS 重连、epoch/seq reset、历史校正、持久状态损坏、上次线程不可用。前台恢复和通知点击均先读取事实；不自动 resume Turn、不自动发送草稿、不自动重试上传或其他副作用请求。只可清理可重建历史缓存，草稿和未知 operation 独立保留。

## 8. 文件、通知及证据要求

SAF 选图/文档须处理取消、Content URI 失效、授权撤销、实际字节/类型/大小、上传进度与错误；URI 不是宿主机文件路径。Gateway capabilities 的附件单文件/总量/数量限额优先；基线为 20MiB / 50MiB / 6 个，不能在 UI 长期写死为契约真相。上传与认领 unknown 不自动重试；项目/线程/草稿切换不能复用旧附件。

成果只有在授权文件内容、MIME、大小和摘要核验后预览、保存或分享。图片必须来自实际下载字节；文本/Markdown 只读展示；其他安全类型交 Android 外部接收器，缺接收器有明确提示。临时 FileProvider 只授予读取权限，不暴露带认证 URL、凭据或主机路径。下载中断、文件替换、摘要不符、grant 过期均应可理解地失败。

通知来自真实 Turn 完成/失败、待审批/待输入等事件，按事件身份去重并区分渠道重要性。通知不含秘密或完整敏感内容；点击定位当前连接对应项目/线程/Inspector，然后刷新真实状态。前台与按 Home 后进程/连接仍存活分别验收；不把 Emulator 结果延伸为进程回收、force-stop、Doze、锁屏或所有厂商保证。若没有经过单独批准的推送/长期常驻方案，界面应准确说明后台提醒依赖当前进程和连接。

交付时至少保留真实 Emulator 的主对话/导航、Inspector、三主题或关键状态截图；不使用 Stitch 图充作运行截图、不合成设备画面。测试证据将真实 Codex、合成协议夹具、JVM/仪器测试分开记录；设计映射与测试报告不能互相替代。Debug APK、截图、缓存与日志放忽略目录，仓库只提交源码和可公开报告。Phase 3 完成后仍为 **In progress**，等待独立审阅；不启动 Phase 4 或正式签名/发行。
