# Phase 3 Iteration 2｜工程与真机交付报告

报告日期：2026-11-12。六组视觉与交互修改、用户 Oracle Eye 接入和独立对账修复已实现。先看 [真机视觉索引](VISUAL_REVIEW.md) 与 [Debug APK](ARTIFACTS.md)。本轮以视觉审阅为主，未追加性能基准测试。Phase 3 母任务与 Iteration 2 均保持 **In progress**；工程验证不代替独立视觉接受。

正典：[Iteration 2 正式任务](https://app.notion.com/p/4165421e690b81308f13da32581c9e54)、[Phase 3 母任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[Oraculum 2.0](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。反馈来源为 [Google Docs 六组意见、八张截图与问题 001](https://docs.google.com/document/d/1Cwg-3mGpaIp5hGYczW0zVOERo0-Fn8M3oEV8pT6fBfQ/edit)。原始反馈、Iteration 1 记录及截图保留。

## 1. 六组界面修改

实施前已研究旧 `apps/web/src`、`bridge/src`、`design/reference` 和 Stitch 定稿；可追溯的旧行为、2.0 现状、真实能力与实施边界见 [LEGACY_MAPPING.md](LEGACY_MAPPING.md)。其中强调色与消息时间的来源区分了旧实现、原设计及本轮新增要求，没有将设计占位写成已实现的旧功能。

| 用户反馈 | 本轮实现 | 保留边界 |
| --- | --- | --- |
| 主对话与 Composer | 去掉右上角重复设置入口；正常连接和校正提示降级。左侧「+」打开本机图片/文档、项目文件与成果、项目入口的真实动作菜单；附件区更紧凑，保留预览与移除。 | 菜单复用现有 Gateway 文件、附件、项目接口；不新增任意命令、@、插件执行或未支持的 Codex 操作。离线、unknown 与错误提示仍可访问。 |
| 设置与身份 | Light / Dark / OLED Dark 使用统一选择组，普通宽度并排，小屏或大字号按空间适配；提供六种本地持久化强调色。系统选择器导入用户头像，以昵称预览、私有 PNG 存储、移除及缺失回退关联展示。Gateway 文案简化；清理缓存移入存储入口并增加确认。 | OLED 背景仍为纯黑，保留系统字体。头像不上传 Gateway；有界解码和私有提交处理取消/替换。清理范围是本机可重建缓存，配对、草稿、回执及主机真实历史保留，不能借此解除 unknown。 |
| Inspector | MCP 服务优先；扩展名称、可用状态和工具/资源数量替代内部布尔值与错误码。用量采用紧凑数值、上下文及缓存比例图。 | 只展示实际返回字段。有效分子分母齐备才显示比例；缺失不是 0%。本次 MCP 读取不可用，不能声称 MCP 完整链路已验证；账户额度无当前 Gateway 契约。 |
| 模型、思考强度与权限 | Composer 选择改为 Material 3 ModalBottomSheet；当前模型与 effort 位于相邻区域，模型目录按需展开。权限区分下次选择与最近确认；Full access 仍明确确认。 | 只选原生模型目录支持的 effort。具体执行审批沿用独立安全容器，完整路径、Diff、移动目标、缺证据禁批准及单次响应保护不缩减。 |
| 消息与执行过程 | 按原生 Turn 聚合完成摘要；正常 completed 过程默认收起，最终答复和未知 phase 的助手消息保持可见，失败过程保留关注提示。显示实际消息时间、原生耗时及已知用量。 | 运行、待审批、失败或中断不伪装成成功折叠。原生 Item/Turn 时间、最近请求与会话累计用量分别处理；不以本机接收时间、命令耗时求和或示例数字补造。 |
| 空状态与品牌 | 恢复品牌、主标题、引导文字和输入入口的构图；已知正常的首轮无历史提示不再重复呈现。用户完整 SVG 用于大品牌区，紧凑 SVG 用于导航和助手头像。 | 未自动新建或发送；原生读失败与未知写入仍独立呈现。用户原始 ZIP/SVG/预览保留，正式 Launcher 与启动图标未替换。 |

用户 SVG 的来源、转换方式、四份原件及 VectorDrawable 哈希见 [BRAND_ASSETS.md](BRAND_ASSETS.md)。消息时间、单位、Token 语义、缓存绑定和缺失处理见 [METADATA.md](METADATA.md)。这些实现与自动检查不替代真机视觉审阅。

## 2. 对账阻断的独立结论

复现与红绿测试见 [RECONCILIATION.md](RECONCILIATION.md)。本轮分别处理了以下已证明问题：

1. 临时 HTTPS 测试代理的上下游连接寿命不一致；修复限于测试设施，不改生产网络。
2. 业务请求尚未入队便错误留下 unknown。派发信号现位于认证、请求构造与本机校验之后；只有确证未入队才结算**原 intent**为 rejected/notSent。
3. 其它项目/会话事件使当前空闲会话反复校正。快照按目标作用域检查已有事件窗口；全局变化、相关作用域、epoch 变化和保留窗口丢失继续阻断。
4. 超长工具正文的展示截断被误认为执行状态不明。保留 `truncated`、详情入口与审批证据限制，同时使用已验证的原生 Turn id/status 判断执行状态。
5. 全设备 unknown 误禁用另一项目新建，以及其它项目事件误撤销首条许可。界面与现有 Gateway/客户端保护范围对齐。
6. 首条消息在本机准备失败、已知未派发时仍消耗许可。消费移至实际入队前无挂起边界，保留同作用域、epoch、连接代次、新鲜 idle 与 unknown 检查。

业务请求一旦入队，丢回包、取消、HTTP 错误或查不到回执均不能证明未执行。现有 unknown 不清除、不自动重发、不切换 operationId 绕过，设备鉴权与审批不放宽。历史那次未知请求没有足够事实证明未派发，不能追溯改成 notSent。

首条许可仍不跨真实断连或进程重启恢复；已新建但尚未物化历史的会话可能因此需要另行处理。保留 accepted 回执不等于许可可复活，本轮未以当前 idle 倒推旧写入结果。

## 3. 已验证的工程结果

证据根目录为本机 `.local/iteration2/`。下表独立计数，针对性回归已包含于对应总数，不重复累加；没有将本轮检查写成整个历史仓库全量验收。

| 检查 | 当前结果 | 证据与范围 |
| --- | --- | --- |
| Gateway 回归 | **13 个测试文件、271/271 通过** | `gateway-all.log`；认证、事件、历史、文件、附件、审批及本轮快照范围回归。 |
| Android JVM | **169/169 通过，0 failure/error/skipped** | `precommit-build.log` 及 `app/build/test-results/testDebugUnitTest` 的 25 份 XML；包含状态/派发、元信息、折叠、主题对比度、头像提交和偏好。 |
| Android lint | **0 error、0 fatal、21 warnings** | `app/build/reports/lint-results-debug.xml`；保留 warnings，不写成零警告。 |
| 协议生成与往返 | **71 个 DTO roots；TS/Ajv 与 Kotlin 各 82 次共享 fixture 往返；25 个无效 fixture 按预期拒绝** | `protocol-final.log`；`itemTimings` 为可选加法，协议版本与写入语义不变。 |
| Debug / AndroidTest 构建 | **构建通过** | `precommit-build.log`、`clean-source-device-build.log`；后者来源为已提交干净产品源码，属于增量构建，不称全量 clean rebuild。构建测试 APK 不代表设备测试通过。 |
| 品牌资源 | **四原件字节一致；两 XML 资源编译通过** | 详见品牌报告；三背景渲染比较与目视核对已记录，生成验证图不作为真机截图。 |

## 4. 一加 6T 与本轮 Debug APK

主要设备为现场 ADB 核对的一加 6T：`e5ee4f28`、`ONEPLUS A6013`、Android 15 / API 35。已有 Debug 数据与配对作为保留现场；本轮使用匹配既有 Debug 签名的 `adb install -r` 更新，核对签名一致且首次安装时间不变。没有通过 `pm clear` 或卸载解决问题，也未修改手机全局 CA/代理。

| 产物身份 | 当前已核验值 |
| --- | --- |
| 产品源码 SHA | `7c37855f1ebf67bcad75fcba0793b54c68f7b870` |
| APK | `oraculum-7c37855-oneplus-debug.apk`，**14,893,980 bytes** |
| APK SHA-256 | `0acbb047ce623d6d45921f3b1e4cfdc6d85fe624ba04fc10513680d698035494` |
| 包身份 | `dev.oraculum.poc.debug`；版本基线 `0.1.2` / code `4`，Debug 后缀独立于正式应用 |
| 内嵌构建身份 | `assets/oraculum-build.json`：上述源码 SHA、`sourceDirty=false`；与外部 JSON 一致 |
| 信任边界 | 内置本轮隔离测试 CA，保留 HTTPS/WSS 证书校验；该真机测试包不作为正式签名发行包 |

当前已观察的能力边界：本次原生 MCP 目录读取不可用；Skills 实际返回 84 项。Apps/Plugins 按各自稳定公开能力呈现，不将目录读取成功外推为可安装/执行。账户额度当前不可用。真实消息时间、5 秒/6 秒等原生耗时、24,143 tokens 及 13,056 缓存输入已在初始在线 Turn 显示；历史重新读取后可能没有用量，索引同时保留真实数值画面与缺失降级画面。未用 fixture 填补模型数据。

真机已完成主对话、真实菜单、三主题/强调色、昵称、SAF 头像、Gateway/缓存取消、模型/强度、Full access 取消、真实命令审批取消、过程折叠、IME/横屏和 Home 后实际通知回跳。定向旅程及偏好恢复共 **12 个阶段通过**，隔离存储与通知组件 **14/14** 通过；原始失败及后续有效复测分别记录在 [device-evidence.json](device-evidence.json)，不重复累加重跑。

故障注入中，草稿/原 operationId/held 附件在断连和进程重启后保留，未重复发送。但隔离代理过早切断请求，Gateway 无原回执，`reconcileKnownReceipt` 未通过，**不能宣称真实 accepted 回执恢复已验证**。此测试 unknown 不强清，仍保护专用线程和同项目新建；普通离线草稿改写阶段未继续，以免替换该 unknown 对应的原草稿。详见 [独立对账报告](RECONCILIATION.md)。

测试设施中途修正了 DocumentsUI 的系统返回/网格文件名定位、Android CLI 与 instrumentation 的 UiAutomation 占用、系统窗口/旋转动画截图时机，以及通知 Activity 替换后的测试清理。前次失败未计入通过数。修正只在测试代码；已安装产品 APK 始终保持 `7c37855`。

## 5. 截图、上传与收尾状态

指定目录：[Visual Refinement｜Iteration 2](https://drive.google.com/drive/folders/1RFMOnE7UJHXPF98NL4213ul1Ui3trLdK)。[VISUAL_REVIEW.md](VISUAL_REVIEW.md) 逐图列出原始真机 PNG 和实际观察；[visual-manifest.json](visual-manifest.json) 记录逐图大小、SHA-256 与 Drive 链接；[ARTIFACTS.md](ARTIFACTS.md) 汇总 APK、构建身份和信任边界。

所有截图保持设备采集字节，不拼接、不修图；动画中间帧留在私有调试目录，没有混入最终图集。APK 的本地、已安装 base.apk 与 Drive 下载内容一致。缓存清理和 Full access 均只验证确认后取消；真实命令审批取消，测试目标文件未产生。

最终比对原始私有 TAR：原有 **12 条 accepted 回执、1 条原草稿、1 条原附件记录**保留，长期凭据文件逐字节一致，endpoint/scope 不变；新增测试记录单独保留。原本地主题/强调色/昵称/字号/头像已恢复；为保留 unknown 上下文，当前选择仍是专用测试线程。真实重连证明既有身份可用，未重新配对。

仅本轮启动的 Gateway/TLS 进程已退出、两个测试监听端口已关闭，本轮 ADB reverse 和私有测试 opt-in 已移除，Debug App 已停止，真机显示 OFF（系统 Dozing）。全局 Codex 配置哈希与开工时一致，原安装/设备信任未撤销。未操作其它服务或设备。ntfy 使用既有私有配置发送关键节点简报，地址、配对码和密钥不进入仓库或交付材料。

## 6. Git 与审阅边界

开工核对本地与 `origin/main` 一致，基线为 `c1a78e52caf79144bda6aba3ef7d0de8da77b92a`。以下实现步骤均直接在 `main` 提交并正常推送，无分支、worktree 或历史重写：

| 提交 | 内容 |
| --- | --- |
| `67a53d91671f82274c1c792640796bef888027c3` | 旧版交互与能力映射 |
| `69046c1c68b62660e2c0952083b9451d9a16c9d5` | 临时 Android HTTPS fixture 连接寿命对齐 |
| `c211dbb08fa2501c08117ba0f9e7098fa85864dd` | 用户完整/紧凑 Oracle Eye 原件与矢量接入 |
| `e6495906d208958b82c473103c5f5026ee93b312` | Gateway 保留原生 Item 时间 |
| `9afa0f4fc05dc54b2b5daee9cda2a76a1401d149` | Gateway 快照按相关作用域核对稳定性 |
| `7c37855f1ebf67bcad75fcba0793b54c68f7b870` | 原生交互、身份/外观、元信息、安全恢复与回归 |

测试设施与真机证据修正提交 `0e82a0a192aab2c05ec82e55ba4ffd54b122f150` 已正常推送；产品 APK 的源码身份固定为 `7c37855`，不能用后续测试/文档提交冒称重新构建。最终文档提交及实时远端 SHA 核对写入本轮 Notion 正式任务，供独立审阅。

未跟踪 Stitch 原件与既有设计保留。没有正式签名/发行、生产 Gateway 安装、VPS/Caddy/SSH/systemd/生产网络变更或旧状态迁移。Iteration 2 与 Phase 3 保持 **In progress**，等待用户或明确授权的独立审阅者接受；不进入 Phase 4。
