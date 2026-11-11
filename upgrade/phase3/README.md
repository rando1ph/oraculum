# Oraculum 2.0 Phase 3｜Android 完整客户端工程报告

报告日期：2026-11-12。**这是待归档交付报告：已验证的单元、仪器和真实 Gateway/Codex 旅程逐项登记。当前原生待审批快照缺少文件修改 Item，客户端正确阻止正向批准并安全取消原请求。未归档会话列表超时已定位，最小读取预算修正后，真实 Home 后台通知及同进程热/冷 Activity 定位完整旅程通过；不代表进程死亡后的送达。最终交付物及 SHA、截图索引和延续环境清理仍待完成。实现、自动化通过和独立视觉/人工验收分别记录；Phase 3 保持 In progress，等待独立审阅，未进入 Phase 4。**

正典：[Phase 3 正式任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[父项目](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)。前置交付：[Phase 0 Android/Stitch 规格](../phase0/05-Android与Stitch落地.md)、[Phase 1 Gateway](../phase1/README.md)、[Phase 2 原生 PoC](../phase2/README.md)。本阶段详细设计与协议边界分别见 [DESIGN_MAPPING.md](DESIGN_MAPPING.md) 和 [CAPABILITIES.md](CAPABILITIES.md)。

## 1. 实现范围与源码入口

Android 使用 Kotlin + Jetpack Compose + Material 3，复用 Phase 2 GatewayClient、Room/DataStore/Keystore、历史校正和未知回执状态机。官方 Codex App Server 仍是唯一执行权威；Android 只使用 Gateway 白名单 HTTP/WSS 契约。没有主 UI WebView、任意原生 RPC、自建 Agent Loop、工具执行器或模型调度。

| 范围 | 当前源码实现 | 实现入口 | 最终验收 |
| --- | --- | --- | --- |
| P3.1 原生工作区 | 左导航、中央对话/Composer、右 Inspector；窄屏独立模态面板，宽屏可并排对话与 Inspector；系统返回、IME、有限高度输入区、文字与代码滚动 | [OraculumScreen.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt) | 三面板/返回/真实 IME/横屏/200% 字号旅程通过；TalkBack 未实听，最终人工验收待审 |
| P3.1 设计系统与偏好 | Matcha Light / Dark / OLED Dark；原生字体、色阶/圆角、语义按钮；本机用户/助手别名和阅读字号偏好 | [OraculumTheme.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumTheme.kt)、[ClientPreferences.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/storage/ClientPreferences.kt) | 三主题旅程通过并有真实图；自定义图片头像未实现，最终选图/产物关联待归档 |
| P3.1 消息与内容 | 原生 Markdown 常用子集、可选择文本、代码复制/横向滚动、GFM 表格与任务列表 | [MarkdownContent.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/MarkdownContent.kt) | 真实 Markdown 回复与大字体旅程通过；复杂 GFM 不作完整兼容承诺 |
| P3.2 项目/会话与模型 | 授权目录浏览/注册、线程分页、本地筛选、显式新建/恢复、上次线程恢复；真实模型与 effort、下一次执行 preset；线程切换清理模型 override | [PocViewModel.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/PocViewModel.kt) | 真实配对/注册/新线程/模型目录/恢复通过；非已运行子路径不推定全覆盖 |
| P3.2 交互与 Inspector | 真实审批、受约束输入/elicitation、原生 Turn 完成/失败/中断、工具/Plan/Diff、可识别子代理活动、token 用量与只读扩展；完整文件修改与请求绑定后才可批准 | [NativeInteractionPanel.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/NativeInteractionPanel.kt)、[InspectorProjection.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/repository/InspectorProjection.kt) | 真实命令审批取消、工具/Diff/用量/扩展通过；本次 Codex 待审批快照不含完整 fileChange Item，正向旅程失败且 accept 保持禁用；build 13 原请求安全取消通过、目标文件未生成。条件式正向路径仅有单元/静态证据 |
| P3.2 未知写入 | 一级 unknown 提示、原操作身份/时间/范围、原回执查询、只读刷新、停止确证活动 Turn；404/重连/缓存清理不解除屏障 | [WritePreparation.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/repository/WritePreparation.kt)、ViewModel 持久 operation 流程 | 上传及 Turn/附件认领丢 ACK、进程重启、原回执对账通过；独立操作/Turn 计数无重复 |
| P3.3 文件与附件 | 授权主机目录/文件浏览、MIME/大小/摘要校验下载、图片/文本/PDF 首页预览、SAF 选择/保存、FileProvider 系统打开/分享、上传/删除/原子认领与 unknown 查询 | [FilesController.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/files/FilesController.kt)、[FilesPanel.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/files/FilesPanel.kt)、[FileTransferPolicy.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/files/FileTransferPolicy.kt) | SAF/上传/认领/文本预览/损坏下载拒绝通过；build 12 系统 chooser 明确选择独立 UID 测试接收器，实际读取 131B、摘要/只读权限核验及完整 runner 均通过；PDF/Office 接收器未覆盖 |
| P3.4 系统通知 | Android 通知权限/设置入口；执行结果、审批/回复、错误三个渠道；已验证事件去重、隐藏锁屏细节、只读定位 Intent | [GatewayNotifications.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/notifications/GatewayNotifications.kt)、[NotificationLedger.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/notifications/NotificationLedger.kt) | 权限、系统测试、真实前台通知及 Home 后台完成通知全流程通过；同进程热启动及新建 Activity/VM 的定位通过，进程死亡送达未覆盖 |
| P3.4 恢复 | access 续期、有限 WSS 重连、epoch/seq reset 后只读校正、离线缓存/草稿、失效线程回退；前台恢复不自动 resume 或发草稿 | [GatewayClient.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/gateway/GatewayClient.kt)、[MainActivity.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/MainActivity.kt)、ViewModel | 5 项真实恢复旅程通过；epoch 变更仅用户显式增加 1 次 resume，Turn 不增 |

## 2. 设计采用、冲突与保全

唯一视觉输入为 `upgrade/stitch_oraculum_android_workspace/` 的 7 HTML、4 PNG、1 DESIGN.md。Dark 采用 DESIGN front matter 与主对话/设置 HTML 一致的 Matcha 语义 Tokens；Light/OLED 基于同一套组件适配。OLED 根背景为 `#000000`，保留可分辨容器层级。正文使用 Android 系统 Sans/CJK，代码使用系统 Monospace；没有加载原稿中的 CDN、远程字体或 JavaScript。

七屏分别落在对话、左导航、设置、真实审批、Inspector 文件、原生子代理活动和 Inspector Diff/输出/用量。设计中没有真实 API 的分叉/回退/永久允许/插件安装/宿主机打开不做按钮；示例模型、网络时延、费用、额度和“退出后结算”不作为产品事实。三配色不产生新 Stitch 稿，不迁移旧 CSS Themes/Theme API v1，也没有底部 Navigation Bar 或假键盘屏幕。

初次静态色对验证见设计映射：指定的普通文字、主按钮及错误卡实色色对最低为 Dark/OLED 主容器文字的 4.55:1。该结果不包含混色/禁用 alpha、系统栏和 TalkBack，也不替代最终 Emulator 可访问性验证。

**原件复核：2026-11-12 02:37（Asia/Shanghai）再次只读重算全部 12 文件，路径集合、字节数与 SHA-256 均匹配本阶段 `.local/evidence/oraculum-v2-phase3/stitch-baseline.json`；该基线也与 Phase 0 原件表一致。** 未修改、移动、重新生成或提交 Stitch 原件。最终清理归档仍需复核保全结果。

实现对原稿的明确差异：移动面板为保证触控和长中文使用更宽的可用内容区；宽屏采用对话 + Inspector，并保留导航抽屉，不机械按 840dp 强塞三列。设置提供本机别名和阅读字号，图片头像编辑尚未实现。最终截图对照应标出这些差异，不把“同一设计系统”写成像素级逐项等同。

## 3. 真实能力与限制

### 3.1 Gateway 的最小增量

新增授权项目的 `GET projects/{projectId}/extensions` / `ExtensionsSnapshot`：仅白名单只读摘要，Skills/MCP/Apps 各节独立超时与数量限制，部分失败不会伪装为空成功。Plugins 因稳定性未核实明确 unavailable，不调用 `plugin/list` 或将默认 Schema 中的方法当作稳定承诺。`Thread` 增加原生 start/resume 响应的最近权限回读及既有 parentThreadId 的只读投影；请求 preset 不冒充当前权限事实，Turn 开始/代次失效后回读失效。

实际联调还定位出 `thread/list` 在 8014 ms 命中原 8 秒只读预算。最小修正仅令未配置显式 `readTimeoutMs` 时的 `thread/list` 使用 20 秒预算；显式覆盖仍优先，其余只读和写入超时保持原值。该修正不增加重试或写方法，28 项 adapter 测试及全仓测试通过；真实后台完整旅程随后通过，列表读取实际出现 9010/9769/9344/8440 ms 成功样本，证实原 8 秒预算不足。

这些变化没有新增 Codex 写方法，没有开启 `experimentalApi`、插件安装/卸载、MCP 配置或任意 RPC。Schema 同源生成 TypeScript/Kotlin DTO；协议验证结果见第 5 节。完整字段、权限映射和官方来源见能力矩阵。

### 3.2 可用功能与不能承诺的部分

| 功能 | 实际支持 | 明确限制 |
| --- | --- | --- |
| 会话与搜索 | 已加载项目/会话筛选、Gateway 分页、新建、切换、显式恢复 | 没有全文搜索引擎；当前 Android 不提供归档/恢复归档/重命名/删除/Fork/Revert/Review/Compact 写按钮 |
| 模型与权限 | 原生模型目录与协议允许的 effort 交集；read-only / auto / full-access；危险 preset 二次确认 | 模型目录有分页时标受限；`ultra` 不在当前写 DTO；本机下一次选择与原生最近回读分开，不改主机默认配置 |
| 审批语义 | 仅对已识别的 command/network 语义显示操作；命令非空或具备完整、受支持的网络 host/protocol 上下文，决策取自该请求实际允许集合。fileChange 仅在当前实时快照提供完整原生 Item，且 scope、Turn/Item、interaction ID、generation 与显示摘要绑定时开放 accept | `humanCommand` / `writeStdin` 缺少专用终端安全展示，禁用动作。fileChange 原始 Item 与规范化内容均不超过 16KiB、最多 20 文件、Diff 合计 256 行且非空；`grantRoot` 必须缺省或 null。缺证据、截断、越界或失效时仅保留原生允许的 decline/cancel；未知子类型不退化为通用“允许”按钮 |
| Markdown/GFM | 标题、常见强调/删除线、行内代码、围栏代码、引用、列表/有限缩进、任务列表、表格与对齐、可验证链接 | 自写原生展示解析器为 **常用子集**，不是完整 CommonMark/GFM 引擎；复杂嵌套、引用式链接、转义组合等可能按纯文本展示。单个预览最多 64Ki 字符/256 行、128 内容块；表格最多 8 列且合计 128 单元格，截断明确提示。行内格式超过 256 段后余文按纯文本保留；代码截断时仅“复制预览”。raw HTML/JS 不执行，远程图片不自动加载 |
| Turn/工具/Plan/Diff | 真实已公开 Item/事件、Turn 终态和错误摘要、命令输出/退出码/时长（字段存在时）、Plan 更新、fileChange/Diff | 不是完整工具日志流；部分上游 progress/delta 未公开。Plan 只读更新，不提供 Plan 模式；Diff 聚合在拼接前限制为 64Ki 字符/256 行，界面明确提示截断，无 apply/revert；不构造 Git 状态 |
| 子代理 | 原生可识别 Item 中的已观察关系/状态/Prompt 或工具信息 | 不是完整全量代理树，不自行调度；任意子线程或未公开历史不可读取，不伪造“加载更早” |
| token / 账户 | 当前可得 total/last/token/contextWindow 字段 | 事件未到或重启后不可恢复的字段显示未知；没有账户额度/账单路由，不估算费用/百分比/重置时间 |
| 原生扩展 | Skills、MCP、Apps 的有界只读状态与部分失败 | enabled 不代表 callable；MCP 可超时；MCP/Apps 为当前 App Server 范围，不是项目独占清单；每节最多 100 条，未取完仅标 limited。Plugins 因 `STABILITY_UNVERIFIED` 禁用，无市场/安装/卸载/动态脚本运行器 |
| 大 Item | 连续分块、同 identity/epoch/revision、总 SHA-256 校验；重计算移出主线程；有界预览 | 原生详情最多 8MiB；UI 只显示有界前缀（64Ki 字符/256 行，固定截断提示另计）。校验完整数据不表示完整内容都已渲染或可完整复制；正常历史投影本身也有限额 |
| SAF 附件 | 用户选择图片/文档，读取真实内容并上传，按 scope/draft/operation 绑定；回执查询恢复 | 不申请全盘权限、不将 Content URI 当宿主路径；实时限额优先。上传/删除/认领未知时不自动重试，临时 URI 失效需重新明确选择 |
| 成果预览 | 校验后图片、有限 UTF-8 文本、受限 PDF 第 1 页 | 文本预览上限 512KiB；PDF 内嵌预览仅第 1 页且当前文件不超过 16MiB。Office（DOCX/XLSX/PPTX）走系统打开/分享/保存，App 不自带 Office 排版器；完整 PDF 阅读依赖外部应用 |
| 下载/打开/分享 | 授权文件、大小/MIME/SHA-256 核验；SAF 保存及只读 FileProvider URI | 下载最多 64MiB，grant 约 5 分钟、无断点续传；文件替换/摘要不符/中断拒绝预览。外部接收器不存在时提示失败；没有“在宿主机打开” |
| 本机文件保留 | 已证实 sent/expired 的附件终态与本机 payload 有界清理，保留最近 32 条终态记录；unknown/held 不参与终态清理；预览缓存有容量和分享租期保护 | 预览缓存最多 128MiB/64 文件；保留当前预览及最近一小时打开/分享文件，达到预算会明确拒绝新下载，不通过删除未知附件腾空间 |
| unknown | 原 operation 查询、只读状态核对、停止确证活动 Turn | 无通用人工解除 API；事实不足就继续阻塞。404、缓存清理、重新配对/注册、用户主观确认都不证明未执行 |
| 通知与后台 | 复用当前进程 WSS；前台和按 Home 后进程/连接仍存活时尽力提醒 | **尽力而为，不保证后台必达。** 无远程 Push、前台服务、WakeLock、后台 retry worker 或无限轮询；进程回收、force-stop、Doze/锁屏和厂商省电不承诺送达 |
| 个性化 | 三套主题、本机别名、阅读字号，仍响应 Android 字体缩放 | 未实现用户/AI 图片头像编辑；Dynamic Color 与可导入主题不是本阶段必交；不迁移旧偏好 |

**当前真实 fileChange 边界：Codex 0.167.1 的本次待审批会话中，稳定快照开始/结束序号同为 2118，历史未截断；进行中的 Turn 只有 user/reasoning/agent Item，没有待审批文件 Item 的路径/Diff。** 客户端无法从 request 的 Turn/Item ID 构造修改证据，因而保持 accept 禁用。这是已观察到的当前原生行为；只有上游确实返回完整、可绑定且未超限 Item 时，条件式批准代码才可能开放，不承诺当前环境可完成正向批准，也不读取未授权或 Experimental 数据补齐内容。

## 4. 安全、持久化与系统体验

每个副作用请求先持久保存原 operationId，再单次派发。Unknown 提示展示操作类型、项目/线程、创建时间、delivery/status 和原生标识；查询缺失不能改写为 rejected。停止是对已确认活动 Turn 的独立请求，不清除原未知操作。缓存重建仅针对可重建历史库，草稿/回执/附件操作状态保留；持久状态损坏时停止写入并保全文件。

权限 UI 区分本机下一次 preset 与最近原生权限回读。Full access 明确确认后才用于下一次执行；换线程清理其本机选择，模型/effort 也避免串用另一线程的 override。只展示请求实际允许的审批决策与约束；提交前失败、已提交未知、过期/取消/其他设备已处理不相互混淆。表单秘密回答只在当前 composition，不能写入草稿、通知或缓存。

文件修改批准使用 [FileChangeApprovalContexts.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/repository/FileChangeApprovalContexts.kt) 的内存证据，缓存、分页和预览摘要不能建立授权依据。证据只由连接代次、失效版本及事件证据版本仍一致的实时快照建立，快照的开始/结束序号须相等；UI 完整显示受限范围内的所有路径、移动目标和原始 Diff，不截断后保留批准按钮。点击携带所见内容摘要，先只读刷新再比较 scope、请求代次和摘要；持久化操作及认证刷新后、实际派发前再次校验。相关事件、断线、范围切换及提交结束撤销证据，内容变化后必须重新查看。这套条件式实现通过独立静态复核及单元测试；真实正向旅程因上游缺少完整修改 Item 而失败，安全条件未放宽。

通知的三个渠道分别承载执行结果、审批/回复和错误；以事件/原生身份去重并持久记录，已处理审批撤销提示。通知正文为概括信息，锁屏使用更少信息；Intent 无凭据、命令或审批响应，不能自动执行操作。点击定位先读取可访问项目、最多 10 页未归档线程列表与目标快照，再校验 scope、epoch、连接/失效/接收事件版本及序号，全部成功后才提交会话切换；目标不可用、读取超时或状态变化时保留原会话与草稿。阶段诊断明确定位会话列表 8014 ms 超时后，Gateway 最小预算修正通过真实联调：Home 后 Activity STOPPED 时收到匹配本次 native Turn 的新通知，实际 PendingIntent 热启动和新建 Activity/VM 均定位回原项目/线程及 Inspector。全程仍为同一进程，不包含进程死亡、force-stop 或 Doze 送达保证。

全新连接、前台返回、WSS 重连、epoch/seq reset 或上次线程失效均不自动新建、resume、发送草稿或上传附件。App 保留当前线程、草稿和阅读锚点；离线内容明确标为缓存。Phase 2 的新空线程 `NATIVE_HISTORY_NOT_MATERIALIZED` 精确兼容继续保留，不扩大成普通历史失败的发送绕过。

Android 正式 applicationId 保持 `dev.oraculum.poc`；本阶段仅 `dev.oraculum.poc.debug`，不卸载正式应用、不使用原长期签名证书、不运行正式签名脚本。没有重复卸载已结项的 Ubuntu Desktop/Bridge，没有正式安装/启用 Gateway，也没有改动 VPS、Caddy、SSH、systemd 或生产网络。

## 5. 验证记录（最终填写）

本轮证据根目录为 `.local/evidence/oraculum-v2-phase3/`。下面结果须由最终日志填写，不能以“测试源码存在”替代运行；真实 Codex、合成协议、故障注入与物理机范围分别记录。Phase 2 的既有通过记录不计成本轮重新执行结果。

| 检查 | 本轮最终结果 | 证据与覆盖边界 |
| --- | --- | --- |
| 环境 | 已核对 `emulator-5554` / `codex_api36_aosp` / API 36 / x86_64；`codex-cli 0.167.1`，pnpm 10.34.7，Gradle 8.13 / AGP 8.13.2 / JDK 21 | `environment.json`；compile/target SDK 35，min SDK 26；只代表 Emulator，不代表物理机/蜂窝/生产代理 |
| TypeScript / 仓库单测 | 最新 `pnpm test` **854/854 通过，73/73 文件，8.45s**；`pnpm check` 通过 | `repository-tests-final.txt`、`typescript-check-final.txt`；包含 Gateway 列表读取预算修正。此前 852/852 的 `repository-tests.txt` 保留为历史记录，不累加测试数 |
| Gateway 最小增量 / 协议 | 聚焦测试 **252/252 通过，13/13 文件**；生成 **71 DTO**，TypeScript/Ajv **80 往返、22 非法 fixture 拒绝**，Kotlin 编译 71 DTO 并通过同源 **80 往返** | 已核对 `gateway-tests.txt`（00:52:25，8.91s）和 `protocol-verification.txt`；后者确认生成、TS 编译、运行时校验和 Kotlin 往返通过。Android 最终源码构建另列 |
| Gateway 列表读取预算回归 | adapter 聚焦 **28/28 通过**，随后已纳入全仓 854 项复测 | `gateway/src/codex.test.ts` 的本轮输出亦见 `repository-tests-final.txt`；只改默认 thread/list 预算，显式 readTimeoutMs 优先，其余方法预算保持原值 |
| Android Debug 主/测试 APK、JVM、lint | build 14 **BUILD SUCCESSFUL（1m20s）**；归档 JVM XML 确认 **129/129，17 suites**，0 failure/error/skipped；lint **0 error、14 warnings**。build 13 为 127/127、16 suites，build 12 为 126/126、16 suites，build 11 为 106/106、14 suites | `android-integration-build-14.txt`、`build14-reports/TEST-*.xml`、`build14-reports/lint-results-debug.xml`；包含原生读取阶段诊断，交付 APK 与最终提交的对应关系仍 `PENDING` |
| 系统 instrumentation 完整复测 | 单批 **OK (14 tests)**，1.788s：7 项 LocalPersistenceTest、1 项 CredentialVaultInstrumentedTest、3 项通知、2 项附件保留、1 项取消结算 | `android-system-instrumentation-final.txt`；本次同批 runner 完整通过。下面此前通知/保留分批结果为历史复测记录，不能再累加成新的独立覆盖数 |
| 通知系统 instrumentation | 修正 JUnit `@After` 返回值后，**OK (3 tests)**，0.177s | `notification-instrumentation-final.txt`：渠道/隐私/immutable Intent、持久去重与 resolved 撤销；合成 fixture，不代替真实后台事件旅程 |
| 文件保留/取消 instrumentation | **OK (3 tests)**，1.087s：2 项 AttachmentRetentionTest + 1 项 FilesCancellationTest | `files-retention-instrumentation.txt`；终态有界保留、未知记录保全和删除取消结算等与真实 Codex E2E 分开 |
| 真实 Gateway/Codex 首轮 | 首轮及稳定状态检查均 **OK (1 test)**，耗时 69.803s / 7.242s | `native-initial-final.txt`、`native-settled.txt`：配对→专用项目→显式线程→真实 Markdown 回答；最终 operation/Turn 总数及 config 哈希另行归档 |
| 三面板/主题/IME/横屏/200% 字号 | build 13 最新主题/面板/真实 IME 与横屏大字体旅程分别 **OK (1 test)**（25.685s / 9.075s）；此前对应旅程也通过 | `themes-ime-build13.txt`、`landscape-font-build13.txt`，最新真实截图已收集；此前 `themes-ime-verified.txt`、`landscape-font-final.txt` 保留。测试在 finally 恢复原硬键盘 IME 设置；此前已核对恢复为 0。TalkBack **未实听** |
| 通知权限 | 系统请求、拒绝与设置启用旅程 **OK (1 test)**（9.732s） | `notification-permission.txt`、截图 17–19；只证明权限路径，不能替代后台提醒或通知 ledger 测试 |
| 真实前台完成通知 | **OK (1 test)**（14.057s） | `native-foreground-notification.txt`、`screenshots/foreground-notification.json`；Activity 全程 RESUMED，显式发送后出现新通知，通知 tag 精确匹配本次 native Turn，证明前台真实完成通知，不外推后台或冷启动 |
| 真实审批、工具/Diff/用量/扩展 | 工具/Diff/用量/扩展与审批旅程分别 **OK (1 test)**（22.915s / 14.774s） | `native-tools-diff-usage.txt`、`native-approval-final.txt`；本次原生审批仅允许 accept/cancel，测试采用 cancel。input/elicitation 未计为真实模型覆盖；详见下方失败复测记录 |
| 真实 fileChange 条件式正向批准 | **FAIL：1 test / 1 failure，189.410s**；未得到完整原生文件修改 Item，accept 正确保持禁用，未派发正向批准 | `native-file-change-approval.txt`；主实施者另核对原生快照 seq 2118 未变化、history 未截断，进行中 Turn 仅有 user/reasoning/agent，无待审批 Item 路径/Diff；失败记录保留，后续安全取消另列 |
| 真实 fileChange 缺证据安全取消 | build 13 **OK (1 test)**，10.614s；仅对原 pending 请求选择原生允许的 cancel，校验终态，未新增 Turn，主机目标 `phase3-approved.txt` 不存在 | `native-file-change-safe-cancel.txt`、`screenshots/native-filechange-missing-evidence-blocked.json`、07e/07f；JSON 确认 reviewEvidenceAbsent/positiveApprovalBlocked/originalRequestOnly/currentTerminalSnapshot，decision=cancel。这证明缺证据拒绝正向批准与安全取消，不证明正向路径通过 |
| Turn / 附件认领 unknown | 丢 ACK、离线进程重启保全、原回执校正分别 **OK (1 test)**（6.213s / 3.080s / 4.502s） | `turn-claim-unknown.txt`、`turn-claim-unknown-process-restart.txt`、`turn-claim-original-receipt.txt`；同一 operationId/held 附件保留，只有原 accepted 回执后结算，独立计数无重复 |
| 离线/重连/access/游标/epoch | **5 个独立方法均 OK (1 test)**：离线缓存草稿 3.276s、恢复原线程不发送 7.522s、已签发 access 受控过期续期 20.798s、非法历史/WSS 游标 2.003s、epoch 后显式 resume 6.163s | `recovery-offline-final.txt`、`recovery-online-final.txt`、`recovery-access-renewal.txt`、`recovery-cursors.txt`、`recovery-epoch.txt`；实际使用隔离代理/测试时钟，不改生产网络或凭据 |
| SAF 选择/取消/超限/URI 不可读 | 取消后文档/图片上传、超限/不可读 URI 拒绝分别 **OK (1 test)**（14.398s / 7.395s） | `files-saf-upload.txt`、`files-saf-rejections.txt`；真实 DocumentsUI + 测试 DocumentsProvider，不代表物理第三方云盘行为 |
| 上传/附件认领/原回执恢复 | 显式 Turn 认领 **OK (1 test)**（16.554s）；上传丢 ACK/原回执恢复分别 **OK (1 test)**（6.278s / 4.573s） | `files-native-claim.txt`、`files-upload-unknown.txt`、`files-upload-reconciled.txt`；独立 status 验证 upload 总数 2→3→3，无重新上传 |
| 授权成果/下载/系统分享 | 完整性下载/无接收器 Sharesheet 弹出及返回、摘要篡改拒绝、截断拒绝分别 **OK (1 test)**（9.520s / 7.036s / 8.572s）。build 12 系统 chooser 明确选择独立 UID 接收器，核验 **131B**、摘要及只读权限，完整旅程 **OK (1 test)**（14.698s） | `files-host-preview-share-final.txt`、`files-digest-rejection.txt`、`files-truncated-rejection.txt`、`files-share-receiver-final.txt`、`screenshots/host-preview-system-share.json`。已直接核对 JSON：resolver_selection、systemChooserObserved/explicitReceiverSelection/receiverVerified/receiverReadOnlyGrant 均成立，摘要 `92ba25eb3cd32527ef0ef220d24ce6f29978ad295459891e1ffd5c0236c6c8b1`；14c 为实际接收图。build 11 的 receiver body 成功和失败 runner 均保留；PDF/Office 实际接收器未覆盖 |
| Home 后台提醒与点击定位 | 预算修正后完整旅程 **OK (1 test)**，80.726s：真实 Home/Activity STOPPED、后台收到本次 Turn 精确匹配的新通知、热启动及同进程新建 Activity/VM 的 PendingIntent 定位均通过 | `native-background-notification-continuation.txt`、`screenshots/background-notification.json`、08/08b；JSON 明确 sameProcess=true、processDeathDeliveryTested=false。实际列表读取 9010/9769/9344/8440 ms 均成功；build 12–14 失败日志继续保留 |
| 延续 fixture / epoch 恢复 | **OK (1 test)**，7.360s；沿用原测试身份、状态和 TLS endpoint，在新的隔离 epoch 中由用户操作显式 resume；累计 thread.resume=2，Turn 仍为 12 | `recovery-epoch-continuation.txt`；本轮仅增加显式 resume，重连未自动新建/发送。隔离延续脚本保存在证据目录 `resume-fixture.ts`，不进入产品逻辑 |
| 清理与保全 | 初始 fixture 已正常停止：**cleanupErrors=[]、Codex config 未变、12 个 Turn**；延续环境最终停止和本轮 ADB/私有测试输入清理 `PENDING` | `fixture-initial-report.json`；测试专用 continuation 沿用身份/状态/TLS endpoint，不修改生产服务，最终清理报告与端口关闭核对仍需归档 |

独立 fixture status 对账（仅本表所列阶段，不代表后续最终总数）：

| 阶段 | 真实副作用计数 | 结论 |
| --- | --- | --- |
| 上传前 → 丢上传 ACK → 原回执校正 | attachment.upload：2 → 3 → 3；turn.start 与原生 Turn 均为 6 | 原上传只派发一次，查询不重新上传 |
| 丢 Turn ACK → 离线进程重启 → 原回执校正 | turn.start 与原生 Turn：7 → 7 → 7；attachment.upload：3 → 3 → 3 | 原 Turn 与附件认领没有重发/重传 |
| 离线恢复与受控 access/游标校正 | Turn 保持 7、upload 保持 3 | 只读恢复未自动发草稿或新增 Turn |
| epoch 变更后用户显式恢复 | thread.resume 仅增加 1；Turn 仍为 7 | 重连不自动 resume，新增写入来自显式恢复 |
| 后续原始 fixture 停止 → 隔离 continuation → 用户显式恢复 | Turn 保持 12；thread.resume 累计从 1 增至 2 | 延续环境换 epoch 后仍须显式恢复，无新增 Turn；与前述早期计数分阶段记录 |
| 延续环境真实后台通知旅程完成 | Turn 13、thread.resume 2、attachment.upload 3、interaction.respond 3 | 本次显式发送新增 1 个 Turn；通知热/冷 Activity 定位未增加 resume、上传或响应；见 `status-after-background-continuation.json` |

早期对账来自 `status-before-upload-unknown.json`、`status-after-{upload-loss,upload-reconcile,turn-loss,turn-restart,turn-reconcile,offline-online,access-cursors,epoch-resume}.json`；初始 fixture 终态另见 `fixture-initial-report.json`。这些记录确认 Codex config 未变，原生线程和操作保留供复审。延续环境的最终总计和清理结论另行归档。

初期失败与修复记录如下。后台完整旅程已在最小列表预算修正后通过；当前原生环境的 fileChange 正向旅程仍因证据缺失失败，已验证原请求安全取消。早期失败日志保留，不从报告中删除。

| 初期问题 | 定位与处理 | 证据 / 最终复测 |
| --- | --- | --- |
| 新建线程旅程在 `new-thread.performScrollTo()` 失败 | 新建入口已位于固定面板顶部，无可滚动父节点；属于测试选择器问题，改为直接定位并点击 | `native-initial.txt`；`native-initial-final.txt` 已 OK (1 test) |
| 测试 APK 的 DocumentsProvider 进程缺少 `kotlin.Pair` | 测试组件在独立系统调用路径启动时缺少对应 Kotlin 运行时；测试 Provider 转为纯 Java，未修改产品权限或绕过 SAF | `crash-log-initial.txt`；修正后 `files-saf-upload.txt`、`files-saf-rejections.txt` 均 OK (1 test) |
| instrumentation 编译时对 `performTextReplacement` 的 `Unit` 返回值继续链式调用 | 拆开文字替换和后续节点操作，保留原交互断言；属于测试代码修正 | build 6–8 测试 APK 编译成功，相关面板/IME 旅程已通过 |
| 审批测试等待不存在的 decline 动作而超时 | 实际原生请求仅允许 accept/cancel；测试改为从真实允许集合选择 decline 或 cancel。人工取消原请求后，原操作回执 accepted、Turn interrupted，目标文件未落地 | `status-before-files.json` 保留原操作/Turn 事实且 config 未变；修正后 `native-approval-final.txt` OK (1 test)。回执 accepted 表示取消响应被接受，不表示执行获准 |
| 通知测试 `@After` 返回 Boolean，runner 初始化失败 | `tearDown` 改为明确的 Unit 返回值；不改通知产品行为 | 初始 `android-system-instrumentation.txt` 保留；`notification-instrumentation-final.txt` 已 OK (3 tests) |
| 文件分享旅程返回焦点失败 | 下载/摘要核验及预览已完成；Sharesheet 返回后 Espresso 无目标窗口焦点，调整系统返回操作 | 初始 `files-host-preview-share.txt` 保留；`files-host-preview-share-final.txt` 已 OK (1 test)，通过范围限无可用接收器的 Sharesheet 弹出/返回 |
| 独立 UID 分享接收器已成功但 runner 等待 chooser 失败 | build 11 的测试接收器已读取完整 131B、摘要一致并证实无写权限；系统直接进入接收器，测试仍要求 chooser 稳定焦点而失败，现兼容系统直达路径并验证完整系统流程 | `share-receiver-body-build11.json` 与失败的 `files-share-receiver.txt` 保留；build 12 的 `files-share-receiver-final.txt` 已 OK (1 test)，本次实际为 resolver_selection，系统 chooser 中明确选择接收器，body/只读授权均通过 |
| 独立背景通知旅程的 Home 注入失败 | `pressHome()` 返回 false，没有满足真正 Home 后台前置条件；修改测试的系统输入和生命周期观察，未放宽通过条件 | `native-background-notification-verified.txt` 保留；最终 continuation 旅程明确验证 Home 可见及 Activity STOPPED 后通过 |
| 通知点击定位在原生读取超时时清空会话 | build 11 运行遇到 `NATIVE_TIMEOUT`，原先先切换再读取使选中线程变为 null；现先完成目标预读及版本校验，成功后提交选择，失败保留旧会话与草稿 | build 11/12 失败日志保留，build 12 冷 Activity 超时时原线程未清空；最终预算修正后完整热/冷 Activity 定位通过，不能将此前局部成功替代最终日志 |
| build 13/14 后台旅程首次发送前原生读取超时 | build 13 在发送前失败（130.290s）；普通探针仅 4.3–4.7 秒，因此先增加阶段诊断。build 14 明确记录 `ACTIVE_THREADS` 8014 ms 超时（整体 132.672s），仍未调用发送 | 两次失败日志保留；仅调整 thread/list 默认预算为 20 秒后，28 项 adapter、854 项全仓测试及 `native-background-notification-continuation.txt`（80.726s）均通过；新列表耗时 8.4–9.8 秒解释原限制 |
| 静态审阅：fileChange 可批准却缺少绑定的修改内容 | 先禁用无证据 accept，最终增加当前实时快照的完整原生 Item 证据：16KiB/20 文件/256 行，scope、Turn/Item、interaction ID、generation 和显示摘要绑定；无 grantRoot，点击后刷新及派发前再次验证，失效立即撤销，负向决策仅保留原生允许项 | 最终 Context/forms/panel/VM 已独立只读复核，build 13 的 127 项 JVM 通过。真实正向旅程因缺少完整 Item 而失败且 accept 禁用；随后 `native-file-change-safe-cancel.txt` 10.614s 通过，原请求取消、目标文件不存在、无新增 Turn。条件式正向路径仍不宣称真实联调通过 |
| 静态审阅：Diff 聚合/逐行组合缺少总预算 | 已增加 `boundedContentPreview`：聚合前限制 64Ki 字符/256 行；Markdown 另限制 128 内容块、表格 8 列/合计 128 单元格，截断显式提示。模型分页受限及 unknown 影响范围文案也已修正 | 已核对预算源码；包含该修正的 build 11 成功，归档 106/106 JVM、14 suites 通过；最终交付构建仍待归档 |

未覆盖或仅有合成证据：TalkBack 未实际启用实听；分享已验证真实跨 UID 的测试接收器、系统明确选择与完整 runner，常用第三方 App、PDF/Office 的实际外部接收器未验收。审批竞争/其他设备已处理主要由 Gateway 协议与单元测试覆盖，没有真实双设备竞争旅程；fileChange 条件式正向逻辑只有单元/静态证据，当前真实待审批快照缺少完整 Item，正向旅程失败，已验证的是阻止批准和安全取消；input/elicitation、Plan/子代理所有变体没有逐一由真实模型触发。后台验证包含同进程冷 Activity/新 VM，不包含进程死亡；物理机、蜂窝、Doze、强杀后通知与厂商省电均未覆盖。

## 6. 真实截图与 Debug 交付物（最终填写）

截图须来自 `uiAutomation.takeScreenshot()` 或 ADB 原始截图，检查脱敏后选择少量关键画面；不使用 Stitch PNG 替代、不拼接或生成图片。截图文件不进入 Git，Notion 使用最终选图。

早期 `screenshots-build4/` 当前包含 8 张真实 PNG，仅作开发回看，**不作为最终视觉验收**。该目录 05 当时未显示键盘、06 被测试包崩溃弹窗覆盖，部分 `P3_NATIVE_OK` 误识别为斜体。后续 `screenshots/` 已有修正后的真实旅程图：新 05 确实显示系统键盘，输入区和发送按钮在键盘上方；新 06 无崩溃弹窗，Inspector 关闭入口和大字体标签可见；14 显示 131B 授权 Markdown 文件的“摘要已验证”及原文预览。build 13 主题/IME/横屏字号复测后的最新图已收集；07e 缺证据阻止批准和 14c 跨 UID 实际接收图已上传 Notion。最终产物关联与 SHA-256 仍待归档，不等同最终 Debug APK 或独立视觉验收。

| 画面 | 真实文件 / SHA-256 | 检查重点 |
| --- | --- | --- |
| 主对话与导航 | `screenshots/01b-native-workspace-settled.png`、`03-navigation.png`；最终 SHA `PENDING` | 已采集；左对齐卡、当前项目/会话、真实回复、已加载筛选、草稿 |
| Inspector 与实际审批/文件 | `07-real-native-approval-cancel.png`、`07a-real-diff.png`、`07b-real-usage.png`、`07e-filechange-evidence-unavailable.png`、`07f-filechange-safely-cancelled.png`、`14-verified-host-preview.png`、`14b-system-sharesheet-no-recipient.png`、`14c-verified-share-receiver.png`；最终 SHA `PENDING` | 07e/07f 为缺证据禁用正向批准与原请求安全取消；14 为摘要验证与正文，14c 为实际接收。07e/14c 已上传 Notion；历史无接收器图单独保留 |
| Light / Dark / OLED | `screenshots/02-theme-{light,dark,oled}.png`；最终 SHA `PENDING` | build 13 最新三主题旅程通过并已收集图；对应交付 APK 的 manifest 待归档 |
| 横屏 / IME / 200% 字号 | `screenshots/05-native-ime.png`、`06-landscape-large-font.png`；最终 SHA `PENDING` | build 13 最新 IME 与横屏字号旅程通过并已收集图；此前已观察键盘、输入/发送区和可用 Inspector，无测试包崩溃弹窗 |
| unknown / 恢复 / 通知 | `09-unknown-details.png`、`10-unknown-restored.png`、`16-upload-unknown.png`、`22`–`23` epoch 图、`17`–`19` 权限图及最新 08/08b 通知定位图已采集；最终 SHA `PENDING` | unknown、显式恢复及完整后台热/冷 Activity 定位旅程通过；08b 最新 Inspector 已由主实施者目视检查，不代表进程死亡送达 |

| 产物字段 | 最终值 |
| --- | --- |
| Debug 主 APK 交付位置 | `PENDING` |
| 主 APK 字节数 / SHA-256 | `PENDING` |
| 测试 APK 交付位置 / 字节数 / SHA-256 | `PENDING` |
| APK 内 applicationId / versionName / versionCode | `PENDING`（目标 applicationId：`dev.oraculum.poc.debug`） |
| 内嵌 sourceGit / sourceDirty | `PENDING`；最终交付应来自已提交源码，原始 Stitch 按既有规则不计入 sourceDirty |
| Debug 签名验证 / 公开证书指纹 | `PENDING`；不使用正式签名材料 |
| Debug TLS 测试 CA | `PENDING`：说明最终 APK 是否包含本次一次性 fixture 公共 CA；不含私钥，不放宽主机名校验 |
| 产物 manifest / 接受摘要路径 | `PENDING` |

## 7. 复现方法与数据范围

仓库入口为 `~/Projects/Oraculum` 的 `main`，先读取 AGENTS 和 Notion 正典并保护未跟踪原件。只使用指定 Emulator 与 Debug 身份；不要通过 `pm clear`、删除未知记录或正式包卸载来修复测试状态。

常规构建与检查：

```bash
pnpm check
pnpm test
pnpm verify:gateway:protocol
bash scripts/android-build.sh :app:assembleDebugAndroidTest :app:testDebugUnitTest
```

`android-build.sh` 本身已执行 `assembleDebug` 与 `lintDebug`，使用既有隔离 JDK/SDK/Gradle 工具目录；不需要改生产服务。本轮环境为 pnpm 10.34.7、Temurin JDK 21.0.12.1、Gradle 8.13、AGP 8.13.2，compile/target SDK 35、min SDK 26；完整构建输出见 `android-integration-build-13.txt`，最终交付构建另附源码与产物 manifest。

真实联调由独立终端保持隔离 fixture：

```bash
pnpm exec tsx scripts/android-phase3-fixture.ts
```

fixture 创建临时项目、配置、状态库、HTTPS/WSS 代理和公开测试 CA，只向官方 Codex 新建专用测试线程；其安全 metadata 给出端口/CA/配对文件位置，配对码不能打印、塞入参数或 APK。按照 metadata 用 `-PoraculumDebugCa=本次公开证书路径` 构建 Debug，安装主/测试 APK 后，使用以下工具准备本机私有输入和 ADB reverse：

```bash
python3 scripts/android-phase3-emulator.py --serial emulator-5554 prepare --metadata /path/to/current/metadata.json
python3 scripts/android-phase3-emulator.py --serial emulator-5554 test --method pairRegisterAndReadNativeThread --output /path/to/evidence/native-initial.txt
```

这些是**有状态按顺序执行**的旅程，不能随机跑整个 JUnit 类。`prepare` 只接受 phase3 fixture，拒绝复用 Phase 2 的已撤销身份。后续可用方法见 [Phase3WorkspaceJourneyTest](../../apps/android/app/src/androidTest/java/dev/oraculum/poc/e2e/Phase3WorkspaceJourneyTest.kt) 与 [Phase3FilesJourneyTest](../../apps/android/app/src/androidTest/java/dev/oraculum/poc/e2e/Phase3FilesJourneyTest.kt)，文件旅程需 `--suite files`；恢复旅程用 `--suite recovery`，独立后台通知用 `--suite notifications`。完整前置条件、受控 access 过期屏障及故障顺序见 [TESTING.md](TESTING.md)。

| 顺序/前提 | 旅程或控制 |
| --- | --- |
| 专用线程完成初轮后 | `panelsThemesAndImePreserveDraft`、`landscapeAndLargeFontPreserveWorkspace` |
| 在线且状态校正 | `actualNativeApprovalCanBeDeclined`、`realToolsDiffUsageAndExtensions`；上游未产生目标事实须如实失败/未覆盖 |
| 通知权限已授权 | `realCompletionNotifiesAfterHomeAndRoutesBack` |
| 代理预设一次丢写 ACK | `lostAcknowledgementShowsDurableUnknown`，保持离线重启后 `unknownSurvivesProcessRestartWithoutResend`，恢复网络后 `unknownReconcilesOnlyWithOriginalReceipt` |
| 文件线程与测试 DocumentsProvider 就绪 | `safCancellationThenRealDocumentAndImageUpload`、`safOversizeAndUnreadableUriDoNotUpload`、`explicitTurnClaimsReadyAttachments` |
| 项目 artifacts 目录可读 | `authorizedHostPreviewAndSystemShare`；fixture `corruptNextDownload` / `truncateNextDownload` 控制对应 `damagedDownloadNeverBecomesPreview` |
| 代理预设一次丢上传 ACK | `lostUploadAcknowledgementRetainsUnknown`，恢复连接后 `originalUploadReceiptReconcilesWithoutReupload` |

fixture stdin 的 `status`、`offline`、`online`、`cut`、`restartGateway`、`expireAccess`、`dropNextWriteResponse`、下载故障与 `stop` 都是隔离测试控制，未加入产品 API。过期控制仅推进注入的测试时钟；丢 ACK 转发了真实上游请求后丢回包，不是模拟原生执行。实际运行的控制、线程/Turn 数、测试顺序与时长在第 5 节补齐。

完成后导出必要证据并删除私有测试输入：

```bash
python3 scripts/android-phase3-emulator.py --serial emulator-5554 collect --output /path/to/evidence/screenshots
python3 scripts/android-phase3-emulator.py --serial emulator-5554 remove-test-input
```

随后向 fixture 发送 `stop`，核对报告和端口关闭，仅移除本轮 ADB reverse。保留 Debug 身份、草稿/回执、独立状态目录及新增测试原生线程供复审；不删除已有 Codex 历史或配置。

## 8. Git、Notion 与下一步

开发基线为 `abbf8bd2120ba651daf4ad9ee1deec35537344a7`。Android、审批/通知安全修复、真实旅程测试及后续阶段诊断均已直接提交 `main`；最新 Gateway 列表读取预算修复 `46db61bc65ec1a61a0f4df09db11dce7b740764b` 已正常推送，主实施者核对远端一致。最终报告/产物提交后仍须核对最终同步。

| 步骤 | Git SHA | 最终推送核对 |
| --- | --- | --- |
| Stitch 设计/能力映射 | `e291be4e7094dc56716368f2d2c288f63ed1ebbe` | 已核对远端 `main` 包含 |
| 最小 Gateway 扩展及权限回读 | `b18b8289521fb9f0342e9c9fcdb65a8c3013a51b` | 已核对远端 `main` 包含 |
| Phase 3 真实联调/文件故障工具 | `bd8ffdeebe78e49249fe1c6e1a0faf9039868006` | 已核对远端 `main` 包含 |
| Android 实现/测试 | `1a2b06e678b7eecaba2c4a85d18365c63171e5d1` | 已核对 HEAD / origin/main / 实时远端一致 |
| 附件终态与预览缓存有界保留 | `7968da235b7239000fb4f86a5ff11b6569f3b70a` | 已正常推送；主实施者核对本地/远端一致 |
| 原生审批与通知导航安全修复 | `8915e44653bddadaeea397363ff395c3d9a0bae9` | 已正常推送；主实施者核对远端一致 |
| Emulator 旅程与系统边界测试 | `a29d666a413154db151b80f85a1b3cb0a899a311` | 已正常推送；主实施者核对远端一致 |
| 原生读取阶段与耗时诊断 | `56269ccd12b11f53a53b626feeb921418599930a` | 已正常推送；主实施者核对远端一致 |
| Gateway 会话列表独立读取预算 | `46db61bc65ec1a61a0f4df09db11dce7b740764b` | 已正常推送；主实施者核对远端一致 |
| 最终报告归档 | `PENDING` | `PENDING` |
| 最终 HEAD / origin/main / 实时 refs/heads/main | `PENDING` | 必须全部一致，无强推/分叉/历史重写 |

Notion 已持续回写实现进度、已验证测试、已推送提交和真实能力限制；07e 文件审批缺证据提示、14c 跨 UID 分享接收截图已上传。最新后台成功证据、Debug APK/最终 SHA、截图索引与清理保全结果待最终归档。正式任务保持 **In progress**，只能由用户或明确授权的独立审阅者接受；本报告不自行标记 Done，不把仍待验证的项目列为已验收，也不进入 Phase 4、正式 Gateway 部署或 Android 签名/发行。
