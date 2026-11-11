# Phase 3 视觉整改 Iteration 1｜工程报告

报告日期：2026-11-12。**本轮完成情况以本报告的已验证项及后续真实截图为准；视觉整改子任务与 Phase 3 母任务保持 `In progress`，等待用户亲自视觉审阅。** 当前已确认本地图标与语义设计系统提交 `dceffcf`，Android Debug 构建、lint 和 129 项 JVM 测试通过；真实回归、最终构建身份及云端交付信息仍待补齐，不能据此宣布视觉通过。

依据：[视觉整改正式任务](https://app.notion.com/p/4155421e690b811cae2edc23319d9c91)、[Phase 3 母任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。本轮组件规则见 [DESIGN_RULES.md](DESIGN_RULES.md)，既有能力与设计映射见 [DESIGN_MAPPING.md](../DESIGN_MAPPING.md)。旧版工程报告与第一轮截图保留，不由本轮覆盖。

## 1. 本轮实现

| 范围 | 实现与边界 |
| --- | --- |
| 本地图标与品牌 | 40 个精选官方 Material Symbols Outlined XML，统一尺寸、着色和中文操作语义；新增原创 Oracle Eye 线条矢量。资源来源、固定上游提交、许可及逐项哈希已记录；未引入图标整库、远程字体或 CDN |
| 语义设计系统 | `OraculumCard` 区分助手内容、用户消息、执行摘要、内嵌细节和待处理交互；三主题共用组件结构。补齐 ColorScheme 角色及 Shape/排版层级，使用色阶和留白形成主次 |
| 左侧导航 | 以“神谕 / Oraculum”品牌行和项目/会话分组替换“工作区”；搜索按需展开，仅筛选已加载列表。新建、项目、会话、刷新与设置具有统一图标和清晰选中态 |
| 中央对话与 Composer | 用户、助手和执行内容采用不同结构与密度；过程按需展开，助手答案支持本机复制。Composer 补充附件、权限、模型、发送/停止图标，保留原操作与状态判定 |
| Inspector 与设置 | 执行类型和状态优先，长 ID 弱化并支持完整展开/复制；真实错误保留。Diff、用量、扩展及设置分组统一层次，模型与权限仍来自真实状态，Full access 保留确认 |
| 公共内容 | 代码块提供独立标题/内容层、复制反馈及长块展开；文件、附件和审批卡复用图标与容器。代码、Diff 与用量保持有界预览，文件修改审批仍完整展示允许范围内的路径与 Diff |

主界面见 [OraculumScreen.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt)，Inspector/设置等面板从该文件提取至 [WorkspacePanels.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/ui/WorkspacePanels.kt)。提取用于组织 UI，不建立新的状态或执行层。

## 2. 已验证结果

| 检查 | 当前结果 | 证据边界 |
| --- | --- | --- |
| V1 提交 | `dceffcf` — `feat(android): add local outlined symbols and semantic visual system` | 仅代表本地图标和公共设计系统；最终交付 SHA 待填 |
| Android 构建 | `BUILD SUCCESSFUL in 1m 22s`，包含主 Debug APK、测试 APK、JVM 与 lint 任务 | 本次为开发验证构建，使用隔离 fixture CA；不作为最终干净交付 APK |
| Android JVM | **129/129**，0 failure、0 error、0 skipped | 从当前 JUnit XML 汇总；不代替真实设备与 Gateway/Codex 旅程 |
| Android lint | **0 error、18 warnings** | 构建检查通过，不将 warnings 描述为零 |
| 图标与原件 | **40/40** XML 解析和分发哈希、许可哈希通过；**15/15** Stitch/品牌原件哈希保持 | 未改变定稿原件及正式 App PNG；未新增 TTF/OTF |
| 静态安全复核 | 原 Screen 与提取后的 Panels 动作引用无增减，既有 testTag 无删除；`git diff --check` 通过 | 搜索输入补齐 48dp 点击高度；用量卡保留 64Ki 字符/256 行预览保护。静态复核不证明实际画面可用 |
| 模拟器环境 | `emulator-5554`，Android API **36**，**1080 × 2400**，**420 dpi** | 当前必要回归的目标设备；不外推物理手机、蜂窝网络或厂商后台行为 |

本轮没有修改 Gateway/Codex、ViewModel、Repository、协议、Room/DataStore/Keystore、文件校验、通知或恢复逻辑。Unknown 仍只允许原回执查询、只读状态核对及停止确证的活动 Turn；没有新增重发或强制解除入口。系统 Sans/CJK fallback/Monospace、Dark / Light / OLED Dark、正式 App 图标和现有阅读字号偏好保持。

## 3. 待补齐的真实回归与交付

以下项目由本轮执行者取得实际结果后填写；“待填写”不表示通过，也不引用上一轮测试替代。

| 项目 | 本轮结果 / 链接 |
| --- | --- |
| 导航、对话、Inspector 与三主题真实旅程 | **待填写**：方法、结果、证据路径及运行构建 SHA |
| 设置、模型/权限、代码块、IME、横屏与 200% 字号 | **待填写**：实际回归结果；触控/TalkBack 语义与实听覆盖分别注明 |
| 文件/附件、审批、离线与 unknown 不重发 | **待填写**：实际触发状态、通过/失败/未覆盖及限制，不虚构受限原生能力 |
| 最终实现提交与推送 | **待填写**：完整 Git SHA、本地与 `origin/main` 一致性核验 |
| 最终 Debug APK / manifest | **待填写**：可追溯构建 SHA、`sourceDirty`、有无 fixture CA、文件路径、大小与 SHA-256 |
| 真实截图与视觉索引 | **待填写**：PNG 逐项链接/SHA、Stitch 对应页面及 `VISUAL_REVIEW.md`；目标为 [Iteration 1 文件夹](https://drive.google.com/drive/folders/1Q0-1wjg7atr5iEoCqn1nQxcsxJvPPTH6) |
| Notion 与关键进展通知 | **待填写**：母任务/子任务回写、少量 ntfy 推送结果或失败原因；私有通知地址不得进入仓库、APK 或截图 |

截图须来自本轮实际 Emulator 和可追溯 Debug 构建，不拼接、修图或使用设计图替代运行画面。最终工程检查与截图交付完成后，仍须等待用户第二次视觉审阅；本轮不进入 Phase 4，不正式签名/发行，不修改生产 Gateway、VPS 或网络配置。
