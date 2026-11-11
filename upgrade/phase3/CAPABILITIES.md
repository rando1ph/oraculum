# Phase 3｜Gateway 真实能力矩阵

核对日期：2026-11-12。依据 [正式任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[升级正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[Phase 0 接口审计](../phase0/03-Codex接口与兼容策略.md)、[Phase 1 交付](../phase1/README.md)、[Phase 2 交付](../phase2/README.md)，逐项复核当前 `gateway/src`、公共 Schema 和 Android 接入。本文描述可实现的真实契约与停止线；设备端完成度、截图及最终验证以本阶段交付报告为准。

所有路径相对部署 Origin + Base Path 下的 `api/v2/`。除配对/token 外均需 Bearer access 与 `X-Oraculum-Protocol: 2`。读结果是 `ResourceResponse.data`，写结果是 `OperationResponse.operation`。HTTP 202 代表 unknown，不代表已完成。各写请求先落本机 operationId，再单次派发；读路径可恢复连接，但不得由此重放写请求。

## 1. 原生接口边界

Gateway 继续仅以官方 `codex app-server --listen stdio://` 通信，`experimentalApi:false`，有限方法白名单。生成默认类型、运行时成功与官方稳定性承诺分开记录；没有因为默认 Schema 存在就开启新写能力。

本轮重新打开 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server) 核对：`skills/list`、`mcpServerStatus/list`、`app/installed` 是文档列出的只读接口；`collaborationMode/list` 仍标实验；`plugin/list/read/install/uninstall` 仍标开发中并禁止生产客户端调用。`plugin/installed` 虽出现在本机默认生成类型，且只读探针成功，但当前官方页面没有足够稳定性说明，因此新公开接口不调用它，Plugins 完整清单返回 `STABILITY_UNVERIFIED`。App Server 命令自身的上游成熟度限制仍须沿用 Phase 0 记录，不将“禁用实验字段”写成上游全部产品的稳定保证。[命令成熟度](https://learn.chatgpt.com/docs/developer-commands)

只读探针使用专用临时 cwd，没有创建线程或 Turn、写入 Codex 配置或调用插件写接口：Skills 返回可读，Apps 返回可读；MCP 在现有 3 秒预算内超时，按节降级。插件探针成功仅用于区分运行时事实，未据此公开该能力。完整业务 E2E 由阶段报告另列。

## 2. 客户端契约矩阵

| 功能 | 路径 / DTO | 原生事实与 Android 行为 |
| --- | --- | --- |
| 连接、版本、限额 | `GET capabilities` → `Capabilities`；`GET auth/session` → `SessionResponse` | `installationId`、`epoch`、协议 major/minor、Codex 连接态；能力的 supported/verified/availability 必须分开解释。连上 Gateway 不等于原生线程已恢复 |
| 项目入口 | `GET projects` → `Projects`；`POST project-directories/query` + `DirectoryQuery` → `DirectoryPage` | 只列授权根与注册项目；目录分页 `nextCursor/limited/canRegister`。`canonicalPath` 是显示信息，不是 Android 本地路径 |
| 注册项目 | `POST projects` + `ProjectRegisterRequest` | 显式 `operationId/rootId/path`；先读目录验证，不因输入错误制造 unknown。注销路由存在，但不能用注销/重注册绕过 unknown |
| 会话列表 | `GET projects/{projectId}/threads` + `ThreadQuery` → `ThreadPage` | cursor/limit/archived/search；`source/nextCursor/truncated`。首版 Android 可对已加载项目/会话本地筛选，不能称为全文搜索 |
| 单会话读取 | `GET projects/{projectId}/threads/{threadId}` → `Thread` | 原生 `thread/read`，不隐式 resume。id/title/preview/status/model/reasoningEffort/时间与已知 parentThreadId；模型字段是当前/最近保存值，非逐轮计量 |
| 显式新建 | `POST projects/{projectId}/threads` + `ThreadStartRequest` | operationId/expectedEpoch，可选 model/permissionPreset。只由用户明确动作触发 |
| 显式恢复 | `POST threads/{threadId}/resume` + `ThreadResumeRequest` | operationId/projectId/expectedEpoch；原生 `excludeTurns:true`。它会装载线程，不能作为只读刷新或自动重试 |
| 模型目录 | `GET models` → `ModelPage` | 原生 `model/list`，当前 HTTP 返回最多 100 项；存在 nextCursor 时标目录受限，不能假称所有模型。提交 `model` 值而非目录 id/displayName，不手输虚构模型 |
| Reasoning effort | `Model.supportedReasoningEfforts`；`TurnStartRequest.effort` | 取模型目录与公共协议枚举交集：none/minimal/low/medium/high/xhigh/max；上游可能返回的 ultra 当前不在写 DTO，不提供该选项。Gateway 再验证模型/effort 的实际组合 |
| 下一次执行权限 | `ThreadStartRequest.permissionPreset`、`TurnStartRequest.permissionPreset` | read-only = 原生只读且 network=false、on-request；auto = workspaceWrite、network=false、无额外 writableRoots、on-request；full-access = dangerFullAccess、never。full-access 必须显式确认。省略表示保留原生配置，不发配置写请求 |
| 原生权限回读（本阶段最小增量） | `Thread.permissionReadback`，可选 `permissionPreset` | 来源只为原生 thread/start 或 resume 响应；sandboxType/approvalPolicy/preset（可空）/observedAt/source。精确映射才给 preset；自定义审批、额外根、未知约束保留 null。标为“最近原生回读”，Turn 开始、卸载、未知事件或 epoch 变化即移除；不得把请求值当成权限事实 |
| 发送 | `POST threads/{threadId}/turns` + `TurnStartRequest` | operationId/projectId/expectedEpoch/input，及可选 model/effort/preset/draftId/attachmentIds；Gateway 在同一事务预留回执和认领附件。文本和已授权图片/文档转换由 Gateway 负责 |
| 停止 | `POST threads/{threadId}/turns/{turnId}/interrupt` + `TurnInterruptRequest` | 仅当前原生已观察活动 Turn；停止请求获 accepted 仍须等原生终态。unknown 屏障允许停止确证活动 Turn，不允许猜 Turn ID |
| 真实交互 | 快照 `Snapshot.interactions` 与 opened/resolved 事件；`POST interactions/{id}/response` + `InteractionResponseRequest` | epoch/generation/projectId/operationId 绑定；跨设备单次占用。submitted/unknown/resolved 都不能再回答；原生响应写入 stdin 不等于接受，需 `serverRequest/resolved` 才校正 |
| unknown 回执 | `GET operations/{operationId}` → `OperationQueryResult`；Snapshot.operations | status=accepted/rejected/unknown；delivery=notSent/sent/unknown；关联 native IDs 与 errorCode。404 不证明未执行。操作类型/时间/原 scope 由客户端持久写意图补充；不修改编号、不清屏障、不重新配对规避 |
| 线程快照 | `POST threads/{id}/snapshot` + `SnapshotRequest` → `Snapshot` | thread/history/interactions/operations 和观察 seq；观察 seq 不是原生水位。同步期间保留缓存/草稿并禁用不安全写入 |
| 历史分页 | `POST threads/{id}/history/query` + `HistoryQuery` → `HistoryPage` | 以 projectId + 可选 turnId/cursor 查询；Turn cursor 与 itemCursors 独立。historyRevision/epoch/source/complete/truncated 均保留；旧存储精确降级为 native-read-projection，不把受限投影说成完整历史 |
| 大 Item | `POST threads/{id}/history/details` + `ItemDetailsRequest` → `ItemDetails` | base64 chunk、offsetBytes、totalBytes、sha256、nextCursor、revision、complete。按连续字节拼合并验总摘要后解析 native-item-json；游标失效重新只读加载，不能拼不同版本 |
| 文件/成果 | `POST projects/{id}/files/query` + `FilesQuery` → `FilePage`；`POST .../files/select` + `FileSelectRequest` → `FileGrant`；`GET files/{fileId}/content` | 名称/path/MIME/size、limited/分页；grant 绑定设备/项目/可选线程/文件版本。下载最多 64 MiB、5 分钟 grant、无 Range；校验 Content-Digest、MIME/大小及中断，不把 HTML当受信任执行页 |
| 附件上传 | `POST threads/{id}/attachments`，二进制 + `X-Oraculum-Upload` 编码 `AttachmentUploadMetadata` | operationId/projectId/threadId/draftId/name/mime/size；Content-Length 一致。用原上传 operationId 查回执找回 Attachment，避免丢 ACK 后重复上传 |
| 附件删除/认领 | `DELETE attachments/{id}` + `AttachmentDeleteRequest`；发送时 attachmentIds/draftId | ready/held/sent/expired/unknown 的真实状态；held/unknown/sent 不因 TTL 删除。文档是已授权主机引用，官方输入无通用 document 类型；不能伪装原生文档解析 API |
| 扩展只读（本阶段最小增量） | `GET projects/{id}/extensions` → `ExtensionsSnapshot`，capability `extensions.read` | 四节固定 kinds；Skills/MCP/Apps 独立 3 秒原生预算，最多 2 组并发；每节 100 条白名单摘要，路径、配置、工具内容、OAuth/原始错误不透传。错误、超限、未取完原生分页由 limited/reasonCode 标明；不启动执行或改配置 |

附件实时公开预算来自 capabilities：20 MiB/文件、50 MiB/草稿、6 个/草稿；另有 Gateway 内部总量/设备/并发限制，不能假设上传一定被接受。SAF 临时 URI、文件复制/预览及系统打开/分享是 Android 本地职责。

## 3. 原生交互只显示允许的决定

| kind | 可发送的响应 | 额外规则 |
| --- | --- | --- |
| command / fileChange | `{type:"approval",decision:"accept"|"decline"|"cancel"}` | 若 request.availableDecisions 存在，仅取其中确实为上述字符串的交集；策略对象/永久授权选项当前不支持。真实 Phase 1 审批不一定提供 decline，不固定渲染三按钮 |
| permissions | 同 approval 形态 | accept 仅授予请求的受支持 network/fileSystem 子集，scope固定turn；decline/cancel发空权限。结构化/glob或未知字段由Gateway拒绝，不弱化条件 |
| input | `{type:"input",answers:{questionId:[answer]}}` | 仅真实被动请求；questions/isOther/isSecret/options 原样约束输入，secret不进入通知正文。该上游请求类型有实验注释；被动兼容不启用experimentalApi，也不主动生成问题 |
| elicitation | `{type:"elicitation",action:"accept"|"decline"|"cancel",content?}` | 只对真实请求展示；form按请求schema校验，URL模式不发送content。URL仅http/https且无内嵌凭据，经用户显式打开；不假装完成OAuth/URL流程 |

`INTERACTION_STALE`、`INTERACTION_ALREADY_RESOLVED`、撤销、离线或未知回执均使该卡不可重复提交。刷新显示原生状态；不得仅凭本机点击成功把审批标成已生效。

## 4. 事件与 Inspector 映射

事件走 `GET events` WSS，客户端先发 `EventResume`，收到 `EventConnection`；installation/epoch/seq 变化、重放缺口或 resetRequired 后先只读重建基线。`item.started/completed` 的 native data 和 `native.state` 都是有界投影，truncated必须可见。

| Gateway kind / 原生 method | 可显示的事实 | 限制 |
| --- | --- | --- |
| `item.delta` / agentMessage、reasoning/textDelta、commandExecution/outputDelta | 同原生 Item ID 的活动流 | delta不能盲拼到恢复快照，终态Item覆盖；日志/推理只显示原生实际公开内容 |
| `item.started/completed` / userMessage、agentMessage、plan、commandExecution、fileChange、mcpToolCall等 | 对话、代码/命令输出、退出码/时长（存在时）、文件变更、工具状态 | 未知Item可展示类型及可读详情，不触发客户端工具执行 |
| `native.state` / `turn/started`、`turn/completed`、`thread/status/changed` | 执行状态、Turn失败/中断/完成 | 原生终态与操作回执不同；泛型native.state不能直接解锁发送，沿用同步失效规则 |
| `native.state` / `turn/plan/updated` | explanation、plan[].step/status | Plan只读更新，不提供Plan模式按钮。`item/plan/delta`当前服务不转发，终态plan Item仍可读 |
| `native.state` / `turn/diff/updated` | 当前Turn原生diff字符串 | 只有实际收到才显示；历史fileChange.changes含path/kind/diff时可展示，不伪造Git状态、不提供未实现的apply/revert |
| `native.state` / `thread/tokenUsage/updated` | tokenUsage.total/last、modelContextWindow（可空） | totalTokens/inputTokens/cachedInputTokens/cacheWriteInputTokens/outputTokens/reasoningOutputTokens按原生字段显示；缺失为未知，不能从token推算费用/账户额度 |
| 原生 `collabAgentToolCall`、`subAgentActivity` Item | 已观察agentThreadId/receiverThreadIds/agentsStates、昵称/角色/状态等 | 仅可识别关系；不建立自己的调度树、不用实验parent过滤去补全全量树。没有真实关系则显示未观察到 |
| `interaction.opened/resolved`、`operation.changed` | 审批卡、unknown交付变化、可去重的通知来源 | 使用epoch+原生/operation/interaction ID定位，不把其他设备私有回执展示出来 |
| `history.invalidated`、`connection.changed`、未知state事件 | 清楚说明重校正/连接状态，保留离线只读缓存 | 不自动resume、不发送草稿、不重复写入；native.state若无法安全解释同样先失效 |

当前 Gateway 没有账户额度读取路由，`account/rateLimits/read` / `account/usage/read` 未列入它的有限方法白名单。Inspector可显示真实会话Token；账户额度明确未提供。`item/mcpToolCall/progress`、fileChange output delta和原生顶层error当前没有独立公开投影，不能声称完整实时日志；已识别Item终态和Turn错误仍可显示。

## 5. 明确不提供与最小扩展结论

- 不提供 Plan 模式、Turn steer、Review/Compact/Fork/Revert、rename/archive/unarchive/delete 按钮。这些能力可能在上游存在，但当前 Gateway 无已交付公开操作；Phase 3 不借任意 RPC 绕过。
- 不提供插件目录/商店、安装/卸载、MCP OAuth配置、远程工具调用器或完整 Plugins 清单；Skills/MCP/Apps只展示真实只读状态，enabled 与 callable 不混同。
- 不提供强制清除 unknown、无回执即认定未发、换 operationId重试、重配对/重注册绕过。现有事实不足以证明永久unknown结果，因此本阶段没有增加“人工确认成功”的伪证据API。
- 不提供“在宿主机打开”、原生全文搜索、远程Push服务、常驻后台执行或force-stop后必达承诺。
- 唯一必要 Gateway 增量是授权项目的有界扩展摘要、既有原生start/resume响应的权限事实投影，以及已存在parentThreadId字段的只读投影。无新增原生写方法、无主机配置写入、无生产服务变更。

## 6. 本矩阵相关验证

`pnpm check` 通过。`pnpm exec vitest run gateway/src/extensions.test.ts gateway/src/server.test.ts packages/gateway-protocol/src/protocol.test.ts` 为 132/132 通过：白名单/敏感元数据省略、授权根、Apps enabled/callable区别、MCP局部错误、超量、Plugins不调用、权限请求与原生回读不一致、自定义权限不冒充preset、Turn开始失效，以及既有HTTP安全回归。

`pnpm verify:gateway:protocol` 通过：71个生成DTO，TS/Ajv与Kotlin 2.1.20 / kotlinx.serialization 1.8.1真实编译，80组往返、22组非法fixture拒绝。生成器重跑逐字一致。首次HTTP新测试把未注册项目误写为404，按既有 `PROJECT_UNAVAILABLE` 的409契约修正测试后通过，没有改变产品错误语义。

以上为Gateway/协议及只读原生探针证据，不替代Android模拟器端到端验收，也不构成Phase 3接受或进入Phase 4。
