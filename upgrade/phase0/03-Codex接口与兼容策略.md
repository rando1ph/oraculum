# 03｜Codex 接口与兼容策略

> 2026-11-11 结项同步：[Phase 0](https://app.notion.com/p/4155421e690b81829fe6ce746cff195d) 已获用户接受并结项，[Phase 1](https://app.notion.com/p/4155421e690b818b8d19e6ab806641bd) 已获授权。本文保留 Phase 0 的研究证据；最新裁定见[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。Android 后续按同一 Stitch 设计和 Compose ColorScheme 实现 Light / Dark / OLED Dark，仅做必要 token、对比度与可访问性验证，不另做设计稿或反复视觉审阅。旧 CSS 主题、Theme API v1 和历史偏好不要求迁移；Desktop 高级可导入主题为可选范围。Phase 1 不开发客户端 UI、不改 Stitch 原件，也不授权正式部署。

> 研究日期：2026-11-11。本文是 Phase 0 的建议规格，未修改协议实现、Codex 配置或原生会话，未执行真实模型 Turn。实现与运行时验证须在后续获授权的阶段进行。

## 1. 推荐结论与证据边界

沿用 **Gateway → 官方 `codex app-server --listen stdio://`**；客户端只连接 Gateway。继续使用 `initialize.capabilities.experimentalApi: false`，保留 Codex 对会话、工具、审批、配置、模型和子代理的所有权。Gateway 建立有限的能力适配与展示投影，不向 Android 导出整个 Codex RPC，不提供任意方法转发。

“默认生成协议中存在”只能证明该版本生成器没有按实验门控剔除这个方法或字段，不能证明它已有长期稳定承诺、所有账户都可用、所有历史存储都支持，或实际运行已通过。尤其必须区分以下四层：

| 层次 | 本次证据 | 可以据此得出的结论 |
| --- | --- | --- |
| 官方支持口径 | 已打开 OpenAI 官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands)，另抓取前者 Markdown 原文复核 | 支持定位、弃用、实验/开发中标记；不能替代本机运行验证 |
| 仓库构建基线 | [protocol.lock.json](../../protocol.lock.json)、[生成脚本](../../scripts/generate-protocol.mjs) 与已有 `.local/protocol-fingerprints.json` | 构建基线为 `codex-cli 0.160.0`，`experimentalApi: false`；构建绑定版本与运行时版本分离 |
| 本机现有 CLI | `codex --version`、帮助、分别生成默认与 `--experimental` 的 TS / JSON Schema | 本机是 `codex-cli 0.167.1`；可以逐项比较门控和字段变化 |
| 现有 Oraculum 源码 | `bridge/src/`、`packages/shared/`、`apps/web/src/` | 证明已有处理逻辑、测试意图与需保留的安全语义；不等于本轮重新完成真实 E2E |

本轮未启动新的 App Server、未查询账户目录、未调用会话写接口。当前账号的模型、扩展可用性、原生历史完整度、运行中的审批、原生请求跨重启行为均不声称已实测。

官方 Developer commands 当前仍将 `codex app-server` 命令成熟度列为 Experimental；App Server 页面另将 WebSocket transport 标记为 experimental / unsupported。它们与 `experimentalApi: false` 的默认方法表是不同层次。**不据此推翻已批准的 App Server 架构，也不把 stdio 表述为整个上游产品已获生产稳定保证。**本项目控制办法是保留 stdio、最小接口面、结构核验、清晰降级与针对性回归。[官方命令成熟度](https://learn.chatgpt.com/docs/developer-commands)

## 2. 可复核的协议核对结果

本次只在 `/tmp/oraculum-phase0-evidence/` 生成研究文件，未覆盖仓库 `.local`，未运行会更新锁文件的项目生成脚本：

```bash
codex --version
codex app-server --help
codex app-server generate-ts --help
codex app-server generate-json-schema --help
codex app-server generate-ts --out /tmp/oraculum-phase0-evidence/codex-ts-default
codex app-server generate-ts --experimental --out /tmp/oraculum-phase0-evidence/codex-ts-experimental
codex app-server generate-json-schema --out /tmp/oraculum-phase0-evidence/codex-schema-default
codex app-server generate-json-schema --experimental --out /tmp/oraculum-phase0-evidence/codex-schema-experimental
```

| 证据 | 结果 |
| --- | --- |
| 已锁定 0.160.0 Schema bundle SHA-256 | `8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e` |
| 本机 0.167.1 默认 Schema bundle SHA-256 | `021462a9bacd117f4cd40c256a4888619d059cec6a65b795198d521ba660e554` |
| 本机 0.167.1 含实验项 Schema bundle SHA-256 | `486c7c8daa5dc7f3ab2a1fb56de5316804caf7a4210fda1dc28d3f0f4e90cfe1` |
| 默认 `ClientRequest` 方法数 | 0.160.0：107；0.167.1：109 |
| 0.167.1 默认相对 0.160.0 默认新增方法 | `feedback/save`、`thread/attachmentOwner/list`；没有删除方法，但不能由此推断字段完全兼容 |
| 0.167.1 仅含实验生成版存在的方法数 | 74；包括 Plan、原生全文搜索、项目 CRUD、队列、实时音频、额外进程控制等 |

以上 hash 是生成文件 `codex_app_server_protocol.schemas.json` 的内容指纹，不是运行时版本门槛。后续实现不得因为用户 CLI 不等于 0.160.0 就拒绝所有功能，也不得自动升级用户的 CLI 或配置。0.167.1 是本次对照对象，不是 Phase 1 已批准的新构建基线；更换构建基线须提交聚焦协议 diff 与验证记录。

### 2.1 分类规则

- **D：默认协议候选。**默认生成类型可见，未发现该条目的额外实验标记；仍须结构校验及后续实际验证。
- **E：实验或开发中。**只出现在 `--experimental` 输出，或虽然默认生成仍带实验注释/官方开发中限制；不作为核心必需依赖。
- **L：存储或运行时限制。**字段类型存在，但受历史存储、账户、配置、平台或正在运行的状态限制。
- **G：Gateway 自有能力。**主机授权、上传、成果下载、设备身份等；不伪装成 Codex 原生功能。

分类按“方法 + 具体字段 + 方向”记录。例如 `thread/start` 为 D，不表示其 `historyMode` / `permissions` / `dynamicTools` 也为 D；默认响应能读取 `parentThreadId`，不表示 `thread/list.parentThreadId` 过滤也已解除门控。

## 3. 功能与原生接口映射

下表的方法、参数与默认/实验差异来自上述版本生成的 `ClientRequest.ts`、`ServerRequest.ts`、`ServerNotification.ts` 及对应 `v2/*.ts`；“当前实现”列提供可长期定位的仓库依据。

| 功能 | 原生方法 / 字段 | 核对与限制 | 2.0 推荐与当前实现 |
| --- | --- | --- | --- |
| 初始化 | `initialize` → `initialized`；`clientInfo`、`capabilities.experimentalApi` | D；每连接一次握手。无通用、完整、可保证所有功能的 capability 列表 | stdio 私有连接，身份标记 Oraculum；保留配置继承。[codex.ts](../../bridge/src/codex.ts) |
| 列表、标题搜索 | `thread/list`：`cwd`、`archived`、`cursor`、`limit`、`searchTerm`、`modelProviders` | D；`searchTerm` 是提取标题子串过滤，不是全文索引。0.167.1 的 `thread/search` / `searchOccurrences` 为 E | 保留现有项目内标题搜索；不建设独立全文搜索。以原生 ID 去重。[service.ts](../../bridge/src/service.ts) |
| 新建、续接 | `thread/start`、`thread/resume`；`threadId`、`cwd`、`excludeTurns` | D；`resume` 会装载原生运行时并订阅，不能当纯缓存读取。`excludeTurns:true` 为 D；指定 `historyMode` 为 E | 显式新建才调用 start。打开既有会话先读元数据；需要实时会话控制时 resume。[service.ts](../../bridge/src/service.ts) |
| 历史分页 | `thread/turns/list`：`itemsView`；`thread/items/list`：`turnId`；`nextCursor` / `backwardsCursor` | 两方法在 0.160 与 0.167 默认类型均存在；L：旧存储可能不实现分页。0.167 item cursor 还允许锚点对象，不强迫客户端透传新变体 | 先分页；Gateway 对外只签发自己的不透明 cursor。按 `threadId + turnId + itemId` 合并。[history.ts](../../bridge/src/history.ts) |
| 完整历史读取 | `thread/read {includeTurns:true}` | D，非实验；0.160/0.167 类型注释均说明分页线程 full-history hydration 已 deprecated | 只作明确旧存储不支持分页时的有界后备；不在正常重连循环读取全部历史。无法完成时保留缓存并显示此次读取失败 |
| 发送、停止、补充 | `turn/start`、`turn/interrupt`、`turn/steer`；`expectedTurnId` | D；Steer 必须带当前 Turn 前置条件。`clientUserMessageId` 可作原生关联，不视为 exactly-once 保证 | 每次写操作先登记 Gateway `operationId`；失去 ACK 后查询，不自动重发。停止成功请求仍需原生终态确认。[receipts.ts](../../bridge/src/receipts.ts)、[service.ts](../../bridge/src/service.ts) |
| 归档、恢复、删除 | `thread/archive`、`thread/unarchive`、`thread/delete`；对应 lifecycle 通知 | 三方法在当前默认类型均存在；删除是永久操作，原生行为涉及衍生子线程；不能因方法已生成就探测性执行 | 已有能力保留；删除确认说明影响范围，先阻止在途冲突，回执未知不重新执行。[thread-lifecycle.test.ts](../../bridge/src/thread-lifecycle.test.ts) |
| 重命名、Fork、Revert | `thread/name/set`、`thread/fork`、`thread/revert {beforeTurnId}` | D/L；Revert 要求持久分页线程，改变会话历史，不回滚工作目录文件；Fork 的模型/权限必须核对原生返回 | 各自 operation receipt；Revert/Fork 后重新加载相应投影，不合并旧分页到新版本。[native-operations.ts](../../bridge/src/native-operations.ts) |
| 模型与 effort | `model/list`、`config/read`；`supportedReasoningEfforts`、`defaultReasoningEffort`；`turn/start.model/effort` | D；目录依本机原生 Provider 与账号；`Thread.model/reasoningEffort` 是当前/最近保存值，不是逐 Turn 真实执行计量 | 延续冻结策略：动态选择器与继承原配置，不新增 Provider 切换、手输模型 ID、service tier 或自动升级模型 |
| 权限模式 | `thread/start.sandbox/approvalPolicy`；`turn/start.sandboxPolicy/approvalPolicy`；原生返回 `sandbox/approvalsReviewer` | D。`permissionProfile/list` 默认可见但官方标 Beta；写入 `permissions` 字段为 E | 保留 read-only/auto/full-access 映射及内部“不覆盖”语义，不新增“继承/默认”菜单。原生 readback 决定实际权限，未知时禁用可能提升权限的动作。[permissions.ts](../../bridge/src/permissions.ts)、[thread-permissions.ts](../../bridge/src/thread-permissions.ts) |
| 原生审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | D 候选；server request 的 RPC `id` 需要原样相关联。command payload 的某些附加权限字段另有 E 门控 | 只响应当前 Gateway/App Server 生命周期真实请求；跨设备单次处理；额外权限仅授予请求的子集与受支持 scope。[native-requests.ts](../../bridge/src/native-requests.ts) |
| 用户问题、MCP elicitation | `item/tool/requestUserInput`；`mcpServer/elicitation/request` 的 form / URL | 前者默认 `ServerRequest` 可见，但 `ToolRequestUserInputParams` 明写 `EXPERIMENTAL`；后者 D 候选。二者不能统一叫稳定审批 | 保留已交付的被动请求处理与独立结构验证，不主动启用实验 API；未知形态不得猜答、扩大授权或使界面假装已完成 |
| Plan 展示 / Plan 模式 | `turn/plan/updated`、`item/plan/delta`、plan item；`collaborationMode/list`、`turn/start.collaborationMode` | 原生计划事件可显示；**切换 Plan 模式仍 E**，且 `collaborationMode` 可覆盖模型/推理设置 | 原生事件来了才显示计划；模式按钮明确暂不可用，不用提示词模拟。[service.ts](../../bridge/src/service.ts) 的 `nativeCapabilities()` 已如此处理 |
| Review | `review/start {threadId,target,delivery}`，entered/exited review items | D；0.167 `ReviewDelivery` 仅 `inline`，不承诺 detached 选项 | 保留当前 Review；独立会话审阅若另有明确需求，使用原生 Fork/新建再 review，不编造 delivery 值 |
| Compact | `thread/compact/start`、`contextCompaction` item | D；请求返回 `{}` 只说明已接受，不能当压缩完成 | 等待原生事件并使历史缓存版本失效；失败/断连时保留真实 unknown。[service.ts](../../bridge/src/service.ts) |
| 工具、Diff、文件变更 | item 生命周期、命令输出 delta、`fileChange`、`turn/diff/updated`、MCP tool items | D 候选；展示的文本、状态和 diff 均来自原生事件；未知 item 必须可容纳 | 保留原生顺序与 ID，展示已完成事实；折叠 UI 不丢事件，不自行执行命令。内容读取另走 G 主机授权 |
| 图片 / 文档输入 | `UserInput.localImage {path}`；`text {text,text_elements}` | 默认 `UserInput` 没有通用 `document` 输入类型；现有文档是主机路径引用。新出现音频字段不扩大当前产品范围 | G 完成上传/验证后才转换已授权主机路径；图片走 `localImage`，文档走真实引用文本，工具解析仍由 Codex 完成。[attachments.ts](../../bridge/src/attachments.ts) |
| 子代理树 | `Thread.parentThreadId`、`agentNickname`、`agentRole`；`collabAgentToolCall`、`subAgentActivity` | 展示字段/事件在默认协议；`thread/list.parentThreadId/ancestorThreadId` 过滤仅 E；未知/不可见子代理状态不推测 | 复用原生已观察的父子关系与受授权只读详情，不启动/调度/轮询驱动代理。[subagents.ts](../../bridge/src/subagents.ts) |
| Skills / MCP / Apps | `skills/list {cwds}`；`mcpServerStatus/list`；`app/installed` | 默认协议有对应方法；L：配置、账户、连接决定实际内容。可用目录与已启用/可调用不等价 | 只读总览、独立超时、局部失败不影响聊天；不做商店、OAuth 管理、手动调用器。[extensions.ts](../../bridge/src/extensions.ts) |
| Plugins | 当前实现 `plugin/list`；候选 `plugin/installed {cwds}` | `plugin/list` 虽在默认类型，官方明确开发中且不推荐生产客户端调用；`plugin/installed` 在两个默认基线均存在，但本轮未作运行验证 | 不继续将 `plugin/list` 当稳定核心。Phase 1 验证 `plugin/installed` 的已安装只读投影；不能确认时仅显示已由 Skills/MCP 明确返回的插件来源与“完整清单暂不可用” |
| Token / 账户额度 | `thread/tokenUsage/updated`；`account/rateLimits/read` / updated；`account/usage/read` | D 候选；字段可能缺失，bucket 不能重复计数，旧快照不能当实时事实 | 保留原生计数，缺失为 unknown 而非 0；额度导航只展示已验证周窗口，Inspector 展示会话 Token。[usage.ts](../../bridge/src/usage.ts) |
| 项目、文件与成果 | Codex `cwd`；G 项目注册、授权路径、附件和下载 | 0.167 原生 `project/*` 为 E；不以实验项目管理替代 Gateway 最小注册 | 项目文件、Codex 配置、会话仍保留；新 Gateway 项目注册从零开始，不解析/重写 rollout 以“重建历史” |

三个需要特别防止的误读：

1. **删除和分页不是本次已证实的实验方法。**它们在两个默认构建面都存在；历史存储不支持与实验门控不同，须分别处理。
2. **`includeTurns` 不是实验字段，但对分页线程是已弃用的读取方式。**禁用实验 API 不等于必须全量读取历史。
3. **原生请求可能自带实验标记。**被动接收既有 `requestUserInput` 与主动启用 `collaborationMode` 不是同一个决定；前者必须独立适配，不能因此为整个连接打开实验门控。

官方对插件目录的明确限制为：“Don't call this method from production clients yet.” 该限制直接覆盖 `plugin/list/read/install/uninstall` 的支持口径；默认 Schema 并不能解除它。Plan、权限 Profile 写入、用户问题等不同成熟度也须单独记录。[官方 App Server API overview](https://learn.chatgpt.com/docs/app-server)

## 4. 请求生命周期、重连与历史

### 4.1 正常流程

1. Gateway 建立 stdio 通道，执行一次 initialize/initialized。只读取有效配置与必要目录以核验核心结构，不启动模型作为探测。
2. 用户选择项目后，以授权项目的规范目录过滤原生 Thread。`thread/read` 提供无需续接的元数据；读取历史使用分页。
3. 要继续运行时，Gateway 执行 `thread/resume {threadId,excludeTurns:true}`，读取原生实际设置，并订阅其后事件。初始化、网络连接、历史加载和会话就绪是不同状态。
4. 用户发送时先提交附件、验证模型/effort 与项目归属，再持久登记唯一 operation receipt；之后发送一次 `turn/start`。
5. ACK、原生 Turn 与事件可能交错到达；以原生 ID 与 Gateway 序号合并，不按客户端到达时间重排事实。
6. `turn/completed` 等原生终态确认结束；客户端断开不主动 interrupt。Gateway/App Server 自身退出与客户端断网必须区分。

`thread/resume` 不是纯读：它可能装载线程、恢复 MCP、建立实时执行状态，并可应用覆盖值。对只有浏览需求的历史/子代理使用 read/page；禁止把 resume 与普通 GET 一样无界自动重试，禁止为“刷新 UI”发送配置覆盖。

### 4.2 分页与失效规则

- 初始建议每页 20 个 Turn，最新窗口可先取 5 个 Turn；每个 Turn 的 Item 独立分页。数值为实现起点，Phase 2 以真机耗时/内存调整，不是上游协议承诺。
- cursor 是不透明的。Gateway 对外 cursor 绑定 `threadId`、查询方向、过滤条件与历史版本，客户端不自行推导偏移。
- 原生 `backwardsCursor` 反向查询可以再次包含锚点；合并必须按 ID 更新，不能按“多了一条就追加”处理。
- 历史页按版本写入；Revert、Compact、删除或新观察到的历史变化使既有页失效。老版本请求晚到只丢弃结果，不覆盖新状态。
- 归档/删除可能影响子线程；分别处理每个原生事件并使相关树与列表失效。未收到某子线程事件不擅自宣称它也处理成功。
- 只对确定的 `-32601`、明确实验门控或“该存储不支持分页”等已识别原因做后备。超时、损坏、授权拒绝、Provider 不匹配不能被误报成“不支持分页”。现有 [history.ts](../../bridge/src/history.ts) 的广义文本匹配应在重构时收窄成明确分类。
- 后备的 `thread/read(includeTurns:true)` 即使界面只画 5 条，上游仍可能读完整历史。设置总时限/大小预算、去重并取消过时读取；无法满足预算时提供继续保留缓存的明确失败状态，不能循环耗尽主机。

### 4.3 未知写入与断线

保留已有“未知不重发”原则，并覆盖 start/steer、审批回答、生命周期操作、Review、Compact、Revert。Gateway 回执与原生状态相关联，但回执不是独立执行事实：

| 结果 | 处理 |
| --- | --- |
| Gateway 在发送前本地验证拒绝 | `status=rejected, delivery=notSent`；用户修正后可提交新 operation；notSent 不是第四种回执状态 |
| 原生明确返回错误且能确定未接受 | `rejected`；保留错误分类，不伪装超时 |
| 收到原生 ACK / 对应 ID | `accepted`；还需等待该操作适用的终态 |
| 写入后断线、超时或应答结构不兼容 | `unknown`；查询原生状态、保留有关 IDs，不自动重放 |
| 对账无法唯一确定 | 继续 `unknown`，显示针对该操作的恢复提示；不能仅凭相似消息/相同文本认领成功 |

`clientUserMessageId` 可用于关联，但本次没有证据证明重发同一 ID 就有 exactly-once 语义，因此不能取代 Gateway 操作回执。读取重试与写入重试采用不同策略。

Gateway 事件 epoch 变化后，客户端丢弃对旧事件流连续性的假设，重新读取元数据/操作回执/必要历史。旧缓存仍可只读显示且明确陈旧。**不恢复父项目已经取消的笼统“历史未完整恢复”常驻警告**；只有实际失败、已截断、过期、unknown 等有证据的情况才给对应提示。

## 5. 权限、审批和兼容元数据

既有权限模式是显示与请求意图，实际权限来自 Codex 回读。`inherit` 是适配层“不覆盖”的内部语义，必须省略覆盖字段；它不授权新增“继承/默认”菜单按钮，用户界面沿用父项目最后批准的权限选项。`null` 不能被解释成“恢复全部原配置”。原生 Turn 设置可能是 sticky，额外可写根、网络、Reviewer 路由都不得由 GUI 猜测。

建议保留 [thread-permissions.ts](../../bridge/src/thread-permissions.ts) 的有限兼容元数据思路：记录已确认的来源与 native epoch，而非复制一套权威权限引擎。重连后无法确认时显示未知，并阻止依赖确认权限的发送；不得把客户端上次勾选的“只读”当成主机当前已处于只读。

审批请求身份至少关联 Gateway epoch、原生 RPC `id`、`threadId`，并保留可空 `turnId`：MCP elicitation 不一定绑定某个 Turn。RPC `id` 可为字符串或数字，跨进程可能重复，不能当全球持久审批主键。

- 原生 request 仍在途才允许回答；同设备重复点击、另一设备先答、撤销设备之后的回答都拒绝。
- Gateway 重启后旧客户端卡片失效。只有收到新的真实请求才能重新启用按钮，不从持久历史恢复可执行审批。
- command/file 审批只映射已经支持的决策；当原生带 `availableDecisions` 时进一步取交集，不能自行发明批准选项。
- 额外权限响应最多包含请求内的权限；沿用当前实现的 Turn scope，不从客户端接收任意授权对象。
- MCP 表单按收到的 schema 验证；URL 流只允许经验证的 HTTP(S) 外部打开，客户端不回传任意页面内容或登录令牌。
- 未知 server request / 新实验字段必须进入“本客户端暂不支持该交互”的明确状态，并保留停止/重新查询路径；不得默默自动同意、拼装猜测回答、让 pending 永久无提示。
- `requestUserInput` 作为已交付但仍带实验标记的交互保留独立适配和测试。遇到不兼容只停用该回答面，不全局开启实验门控，不假冒稳定功能。

## 6. 附件、扩展、子代理与用量的边界

图片输入沿用 Gateway 验证后的 `localImage`；客户端不能任意传入主机路径。文档上传后提供真实主机文件引用，不声称所有 PDF/Word 已被模型完整内联解析，不建立第二套文档执行器。原生 `thread/attachment/*` 即使存在，也不替代 G 的上传授权与暂存所有权；除非后续具体功能证明需要，不新增附件同步子系统。

Skills/MCP/Apps/Plugins 保持信息总览。列表失败不能使聊天、模型选择、历史恢复失败。显示 `installed`、`enabled`、`callable`、`available` 时仅采用明确返回值，目录出现不代表已装或可调用。Plugin 候选转换只覆盖已安装项，不借机引入安装入口或插件市场；Phase 1 要确认 `plugin/installed` 的实际支持状态与返回形态，再决定可用范围。**本轮没有找到 `plugin/installed` 独立的正式稳定性承诺；它没有被默认生成器剔除，不等于已证明稳定。**启用前必须同时复核届时官方支持口径与隔离运行结果；不足时维持来源信息展示和完整清单受限，不将它当成已验证的替代接口。

子代理来自已授权父 Thread 的原生关系/事件。没有父子来源证据就不能浏览任意 thread ID；不使用实验父/祖先过滤、不推断 `sessionId == parentThreadId`。`sessionId` 是会话树标识，`forkedFromId` 与真正的 `parentThreadId` 关系不同。服务重启后未知状态显示未知，不能把“没有事件”解释为执行完毕。

Token 来自原生统计，额度来自原生窗口；不从 Markdown 字数估算 Token、不硬编码额度百分比、不根据账户套餐名推断额度。客户端缓存带 `observedAt` 和 `stale`；缺字段与确实零用量分别表达。父项目已冻结的导航周额度/Inspector 会话 Token 展示分工继续有效。

## 7. 适配层与运行时兼容检查

建议 Gateway 内保持一个小型 `CodexAdapter` 边界，其职责是白名单映射、输入构造、原生结果验证、错误分类及事件规范化。客户端使用 Oraculum 的正式共享 Schema；不让 Kotlin 和 TypeScript UI 分别解释所有上游 raw union。不得为每个 CLI 小版本建立一整套平行实现。

每个能力分别记录：

```text
name              例如 thread.delete / history.pagination / plan.mode
availability      unverified | available | unavailable | unsupported
maturity          default-surface | experimental | under-development | deprecated
reasonCode        实际不可用原因；不发送敏感的上游原始错误
observedVersion   本次原生 CLI 版本
epoch             对应 Gateway 与 App Server 共同运行代次
```

这是原生适配层的语义分类；对外字段和首个已授权写操作的开放规则以 04 的 `capabilities` 契约为准。公开协议的 `epoch` 在 Gateway 或 App Server 任一重启、原生连接重建时变化，避免旧审批跨原生进程复用。`available` 只能根据该能力可验证的证据设置，不能从“初始化成功”推导。写操作不能为了发现能力而执行一次；其首次实际授权调用的返回才是运行证据。`-32601` 等 capability 错误只禁用相关能力，不连带关闭已验证的普通聊天。

现有 [compatibility.ts](../../bridge/src/compatibility.ts) 已采用“只检查消费字段”而非整个生成 Schema 完全相等，方向应保留：

1. 构建期锁定已审阅的 schema 与生成器，变更单独审阅；运行时记录版本但按消费字段核验，不精确绑定版本号。
2. 对必需 ID、项目归属、Turn 状态、结果相关字段严格核验；对新增未使用字段保持可兼容。
3. 新 item 类型保留 ID、类型与安全的通用展示；不能因为 renderer 不认识它而使后续 `turn/completed` 失效。新权限/执行状态则保守停止相关动作，不能默认降为“允许”。
4. `config/read` 返回的配置只取需要的白名单投影；不把整个配置、环境变量、Token 或原始错误跨设备传输。
5. 核心健康检查只使用只读、低开销请求；可选扩展目录异步加载。不得为排查兼容性启动真正模型任务、删除 Thread、压缩历史或写配置。
6. 不暴露 `thread/shellCommand`、`process/*`、任意 `command/exec`、`thread/inject_items`、远程环境、原生项目 CRUD、原生队列或读状态同步等当前无产品需求的接口。

## 8. 后续验收与开放结论

本文件的 Phase 0 验收是可复核的接口清单、源码映射、成熟度区分与具体降级设计；真实运行验证属于后续阶段。Phase 1 的隔离集成最低测试集如下：

| 场景 | 验收标准 |
| --- | --- |
| 默认初始化 | `experimentalApi:false`；缺必需读能力清楚报错，扩展失败不阻断核心 |
| 协议变动 | 已审阅构建版与选定运行版均完成结构回归；加字段兼容，必需字段缺失产生具体受限状态 |
| 分页 / 旧存储 | 正常长会话只读取需要的窗口；分页不支持才走后备；重复 cursor、过时页与跨线程 item 被拒绝 |
| unknown 写入 | 在写前、写后 ACK 前、ACK 后分别断线；只发送一次；无法唯一对账保持 unknown |
| 权限 / 双端审批 | 实际权限回读正确；一个设备回答后另一个失效；撤销与 Gateway 重启后的旧卡片无法生效 |
| 生命周期 / Review / Compact | 真正授权的隔离测试 Thread 验证完成/失败/unknown；Revert 不影响工作目录文件；删除测试不涉及既有会话 |
| 实验排除 | Plan mode、named permissions、父代理过滤与队列均不被默认发送；计划事件仍可正确显示 |
| 交互兼容 | 真实 requestUserInput / MCP 表单与 URL 可处理；未知结构有明确出口，不能自动批准 |
| Plugins 支持口径 | 对 `plugin/installed` 进行只读探测及字段核验；未确认时展示来源信息与完整清单受限，不调用 `plugin/list` 冒充稳定能力 |
| 附件 / 子代理 / 用量 | 不接收任意主机路径；父子可见范围不越权；用量缺失不变成 0；重启旧统计明确陈旧 |

无需用户重新决定 App Server、stdio、模型动态目录或默认关闭实验 API；这些已有批准依据。已接受的受限能力策略是：**当上游尚无经验证且符合支持口径的完整插件清单时，Plugins 总览暂时只显示已确认来源信息，并在 `plugin/installed` 验证后补全。**这是可选信息面降级，不改变 Codex 已配置插件的实际运行，也不阻塞核心聊天；不得将“保留现有全部能力”解释成必须依赖官方明确不建议生产使用的方法。

Phase 0 不为原生 Plan 模式开放新实验依赖；它维持既有的暂不可用状态。若用户将来要求启用，另行提交具体版本、隔离适配、开关与真实回归方案，不能作为 Phase 1 默认动作。
