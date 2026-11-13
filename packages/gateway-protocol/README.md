# Oraculum Gateway 协议 2.1

`schema/v2.json` 是公共 DTO 的唯一字段来源。JSON Schema Draft-07 由 Ajv 8.20.0 在 HTTP 输入、输出及事件边界校验；`generated/` 中的 TypeScript 与 Kotlin 源码由锁定的 quicktype-core 24.0.0 生成。这里没有 Android 应用、Compose UI 或任意 Codex RPC 通道。

## 接入与响应

路径相对部署的 Origin + Base Path（默认 `/`）。除健康检查及配对/token 交换外，原生客户端通过 `Authorization: Bearer <accessToken>` 认证；凭据和 access 不进入 URL。读取统一返回 `ResourceResponse`，其 `data` 还须验证表中资源 DTO。写入返回 `OperationResponse`；查询操作回执使用 `ResourceResponse<OperationQueryResult>`，可含上传回执所关联的 `attachment`。失败返回 `ErrorResponse`。配对、token 直接返回对应 DTO；session 使用资源响应包装。所有 `/api/v2` 请求（含 WebSocket 握手）必须携带 `X-Oraculum-Protocol: 2`。

| 方法与路径 | 请求 DTO | 响应/读取 data DTO |
| --- | --- | --- |
| GET `/health` | 无 | `HealthResponse` |
| POST `/api/v2/auth/pair` | `PairRequest` | `AuthResponse` |
| POST `/api/v2/auth/token` | `TokenRequest` | `AuthResponse` |
| GET `/api/v2/auth/session` | 无 | `SessionResponse` |
| POST `/api/v2/auth/logout` | `LogoutRequest` | `OperationResponse` |
| GET `/api/v2/capabilities` | 无 | `Capabilities` |
| GET `/api/v2/models` | 无 | `ModelPage` |
| GET `/api/v2/account/rate-limits` | 无 | `AccountRateLimits`（脱敏原生账户额度） |
| GET `/api/v2/account/usage` | 无 | `AccountUsage`（脱敏原生累计用量） |
| GET `/api/v2/projects` | 无 | `Projects` |
| GET `/api/v2/projects/{projectId}/native-defaults` | 无 | `NativeDefaults`（项目有效原生配置） |
| GET `/api/v2/projects/{projectId}/extensions` | 无 | `ExtensionsSnapshot`（只读、有界摘要） |
| POST `/api/v2/project-directories/query` | `DirectoryQuery` | `DirectoryPage` |
| POST `/api/v2/projects` | `ProjectRegisterRequest` | `OperationResponse` |
| DELETE `/api/v2/projects/{projectId}` | `ProjectUnregisterRequest` | `OperationResponse` |
| GET `/api/v2/projects/{projectId}/threads` | `ThreadQuery` 查询参数 | `ThreadPage` |
| POST `/api/v2/projects/{projectId}/threads` | `ThreadStartRequest` | `OperationResponse` |
| GET `/api/v2/projects/{projectId}/threads/{threadId}` | 无 | `Thread` |
| POST `/api/v2/threads/{threadId}/resume` | `ThreadResumeRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/name` | `ThreadNameRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/archive` | `ThreadMutationRequest` | 409 `NATIVE_CASCADE_SCOPE_UNVERIFIABLE` |
| POST `/api/v2/threads/{threadId}/unarchive` | `ThreadMutationRequest` | `OperationResponse` |
| DELETE `/api/v2/threads/{threadId}` | `ThreadMutationRequest` | 409 `NATIVE_CASCADE_SCOPE_UNVERIFIABLE` |
| POST `/api/v2/threads/{threadId}/fork` | `ThreadForkRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/revert` | `ThreadRevertRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/compact` | `ThreadMutationRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/snapshot` | `SnapshotRequest` | `Snapshot` |
| POST `/api/v2/threads/{threadId}/history/query` | `HistoryQuery` | `HistoryPage` |
| POST `/api/v2/threads/{threadId}/history/details` | `ItemDetailsRequest` | `ItemDetails` |
| POST `/api/v2/threads/{threadId}/turns` | `TurnStartRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/turns/{turnId}/interrupt` | `TurnInterruptRequest` | `OperationResponse` |
| POST `/api/v2/threads/{threadId}/turns/{turnId}/steer` | `TurnSteerRequest` | `OperationResponse` |
| POST `/api/v2/interactions/{interactionId}/response` | `InteractionResponseRequest` | `OperationResponse` |
| GET `/api/v2/operations/{operationId}` | 无 | `OperationQueryResult` |
| POST `/api/v2/projects/{projectId}/files/query` | `FilesQuery` | `FilePage` |
| POST `/api/v2/projects/{projectId}/files/select` | `FileSelectRequest` | `FileGrant` |
| GET `/api/v2/files/{fileId}/content` | 无 | 已认证二进制流 |
| POST `/api/v2/threads/{threadId}/attachments` | `AttachmentUploadMetadata` + 二进制流 | `OperationResponse`（通过附件查询读取资源） |
| DELETE `/api/v2/attachments/{attachmentId}` | `AttachmentDeleteRequest` | `OperationResponse` |
| GET `/api/v2/events`（WebSocket Upgrade） | `EventResume` / `EventHeartbeat` | `EventConnection` / `EventEnvelope` / `EventPong` |

附件以 `application/octet-stream` 上传，`Content-Length` 与 metadata.size 一致；metadata 的 JSON 使用 base64url 编码放 `X-Oraculum-Upload` 请求头（最多 8 KiB）。下载响应包含 `Content-Digest: sha-256=:BASE64:`，客户端须校验所选文件版本的摘要；不支持 Range。上传回执通过本设备 `GET /operations/{operationId}` 找到关联附件 ID。

本表的路由能力还须以运行中 `Capabilities` 为准。Schema 中 DTO 的存在不会自动开放对应的原生能力。模型/扩展等只读信息必须经服务的白名单投影；客户端不能传任意 method、配置覆盖或主机路径来执行原生调用。

协议 minor 为 1，最低客户端 minor 仍为 0：新增能力与字段是增量契约，已发布 Beta 1 的 API major 和资产不变。表中的原生能力仍受已安装 Codex 版本、会话存储类型和账户可用性约束。

## 原生能力与设置

- 省略 `model`、`effort`、`permissionPreset` 会保留原生继承语义，不由 Gateway 补写目录推荐值或权限 preset。`ThreadStartRequest.effort` 和 `TurnStartRequest.effort` 为有界字符串，接受 `ultra` 及未来原生目录声明的强度；运行时仍按选定模型的真实 `supportedReasoningEfforts` 校验。
- `NativeDefaults` 来自项目 cwd 下的 `config/read`，只包含模型、强度、审批、sandbox、workspace-write 网络开关及来源类别。缺失值为 null；它是有效配置事实，不等于当前会话最近一次执行读回。来源不包含配置文件路径，接口不开放配置写入。当前命名权限 profile 无法从这组旧 sandbox 字段完整还原；null 不表示只读，省略权限覆盖仍由原生决定。
- `AccountRateLimits` 保留真实额度窗口、原生重置时间、可用 credits 等字段；`AccountUsage` 为累计 token、运行时长、streak 与按日 token 桶，不是当前会话 token 用量。两者带读取时间、null 和 `limited`；不推算缺失额度，不返回账户身份或原始附加信息。额度窗口中的 `resetsAt` 保留原生 Unix 秒，`readAt` 为 Gateway UTC epoch milliseconds。
- 会话管理、插话、分叉、回退与压缩均使用有限的原生方法，不接受任意 RPC。所有写请求保留 `operationId`、`expectedEpoch`、操作回执和 unknown 屏障；`accepted` 是请求交付确认，压缩触发后仍须等待原生 Turn/Item 事件完成。插话携带路径中的当前 Turn ID，以防输入落到后续 Turn。
- `fork` 由原生继承会话历史，可用 `lastTurnId` 限定分叉点。`revert` 以 `beforeTurnId` 排除目标 Turn 及之后历史，仅适用于原生支持的已加载、持久化分页会话，不撤销工作区文件变更。原生归档和删除会级联后代会话，稳定接口无法提供原子性的项目范围约束；本版本将两者声明为不可用并返回 `NATIVE_CASCADE_SCOPE_UNVERIFIABLE`，不会发送上游调用。

## 类型与安全语义

- UUID 为规范小写 UUIDv4。原生 thread/turn/item ID 是有界不透明字符串。整数均在 JavaScript 安全整数范围内；时间为 UTC epoch milliseconds。需要保留更大整数的文件 dev/ino 等内部身份使用十进制字符串，不冒充浮点数。
- `ExtensionsSnapshot` 按 Skills/MCP/Apps/Plugins 四节返回，只公开有界名称/描述及原生状态；每节至多 100 条，`limited` 表示截断、原生分页未读完或局部错误。只读 API `skills/list`、`mcpServerStatus/list`、`app/installed` 各自失败不影响其他节。Plugins 完整已安装清单当前因稳定支持未确证固定为 `unavailable/STABILITY_UNVERIFIED`；不调用 `plugin/list` 或以生成类型存在替代稳定支持证据。缺失 enabled/callable 不等于 false。
- `Thread.permissionReadback` 是本 epoch 最近一次原生 `thread/start` 或 `thread/resume` 响应的读取事实，包含来源/时间和可精确匹配时的 preset；不是客户端请求值或逐 Turn 权限确认。新增 Turn、卸载、代次/未知事件失效时移除；`permissionPreset` 只在该读取事实可以精确映射时给出。自定义审批、额外可写根或未知 sandbox 形态的 preset 为 null。Android 应明确区分“最近原生回读”和“下次执行设置”。
- 安全请求 `additionalProperties:false`，不隐式删字段、不强制类型转换、不自动补默认值。响应容许新增字段。未知原生 item/event 的类型是字符串；不能据此生成可执行审批。
- `OperationReceipt.status` 只有 `accepted/rejected/unknown`，描述交付结果，不代表原生 Turn 已完成。`delivery` 为 `notSent/sent/unknown`。重复 operation ID 不执行；unknown 只读查询，禁止自动重发。
- `installationId` 区分重新初始化的安装；`epoch` 区分 Gateway/Codex 运行代次；`seq` 为同设备、同 epoch 的事件序号，不保证从 1 开始；客户端使用首次连接响应的 headSeq 初始化游标。连接恢复先观察事件再读快照；`observedStartSeq/observedEndSeq` 不是原生历史水位。无 offset/revision 证明的活动 delta 不拼接到恢复快照正文，原生完成事实按 item ID 覆盖校正。
- `classifyEvent` 只将已知且 payload 合法的事件交给投影。未知或格式不兼容的 `informational` 可跳过；其他情况（包括缺省/未知 impact）必须使投影失效并阻止相关写操作，直到重新同步。`connection.reset` 本身要求重新同步。当前 `native.state` 是只读的有界原生投影，客户端不能用未解释的 data 解锁执行；通用分派器要求重新同步。
- Kotlin 的未知响应字段通过 `ignoreUnknownKeys=true` 忽略。必填 nullable 字段必须存在；可选 nullable 的 null 与省略等价。已知关键状态出现未知枚举会解码失败，客户端必须进入受限/重新同步状态，不能猜测允许执行。
- `InteractionResponseRequest.response` 的三个独立形态由 Schema `oneOf` 校验。生成器将 Kotlin union 投影为字段集合，因此 DTO 构造和 kotlinx 解析不能代替服务端 Schema、原生 request 和权限子集校验。客户端构造请求时使用对应的 `ApprovalResponse`、`InputResponse` 或 `ElicitationResponse`。
- 附件上传的 `operationId` 是上传操作；附件资源的 `operationId` 是后续 Turn 的认领操作，认领前可为 null。held/unknown/sent 不按过期时间删除。`draftId` 为设备预生成 UUIDv4。
- 历史页 `items` 为原生 Turn 或 Item 的有界只读投影；`itemCursors` 按 Turn ID 提供尚未加载 Item 的分页令牌，继续查询时必须同时带相同 `turnId`。`truncated` 不等于完整历史，不能用投影恢复执行。超出展示预算的单个 Item 通过 `history/details` 读取：每页至多 64 KiB 的原生 Item JSON 字节，以 base64 传输；按 offset 拼合后核对 SHA-256，再解析 UTF-8/JSON。游标绑定设备、项目、thread、turn、item、revision 与完整摘要，内容变化必须重读，不能拼接两个版本。最多扫描 32 个原生 Item 页，单 Item/原生帧上限 8 MiB；每次均受原生读取并发与时限约束，不持久保存原生正文。

## 可复现生成与验证

```bash
node scripts/generate-gateway-protocol.mjs
pnpm exec vitest run packages/gateway-protocol/src/protocol.test.ts
node scripts/verify-gateway-protocol.mjs
```

验证脚本在一次性目录重新生成并逐字比较源码，编译 TypeScript fixture 与 DTO，用 Ajv 跑同一组有效/无效 fixture，再真实编译 Kotlin DTO 并执行同一组 JSON 的解析/序列化。Kotlin round trip 的输出再次经 Ajv 校验；正常字段必须等价，只有已声明的未知响应字段与可选 null 允许丢弃。覆盖 Unicode、required-null、optional-null、无缺省字段、审批三形态、未知事件/原生 item、错误码、最大安全整数及越界负例。

Kotlin 编译器 2.1.20 与 kotlinx.serialization 1.8.1 的 Maven artifact URL/版本/SHA-256 固定在 `kotlin/toolchain.lock.json`；首次验证下载公开构建依赖到忽略的 `.local/gateway-protocol-toolchain/`，以后离线复用且每次核对摘要。不会改 Android 工程、系统 Java/Kotlin 或用户 Gradle 配置。

`generate-gateway-protocol.mjs` 对固定版本 quicktype 使用两个小型 renderer 扩展：TypeScript 的任意 JSON 类型收窄为 `unknown`；Kotlin 对 Schema 的必填属性生成 `@Required`，避免上游默认 `= null` 在序列化时丢掉必填字段。全部调整由 Schema 语义图驱动，没有手写另一套 DTO 字段。不得直接编辑 `generated/`。
