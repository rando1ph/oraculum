# 04｜Gateway 协议、状态库、认证与主机文件

> 2026-11-11 结项同步：[Phase 0](https://app.notion.com/p/4155421e690b81829fe6ce746cff195d) 已获用户接受并结项，[Phase 1](https://app.notion.com/p/4155421e690b818b8d19e6ab806641bd) 已获授权。本文保留 Phase 0 的研究证据；最新裁定见[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。Android 后续按同一 Stitch 设计和 Compose ColorScheme 实现 Light / Dark / OLED Dark，仅做必要 token、对比度与可访问性验证，不另做设计稿或反复视觉审阅。旧 CSS 主题、Theme API v1 和历史偏好不要求迁移；Desktop 高级可导入主题为可选范围。Phase 1 不开发客户端 UI、不改 Stitch 原件，也不授权正式部署。

本文是 2026-11-11 Phase 0 的**已接受技术规格**；原研究本身未实现 API，Phase 1 的独立实施授权与验收范围见文首链接。产品约束来自 [2.0 子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134) 与 [Phase 0 Task](https://app.notion.com/p/4155421e690b81829fe6ce746cff195d)。源码研究只读取文件与表定义，不读取真实数据库业务行、设备秘密或 Codex 凭据。

## 1. 推荐与边界

保留现有 Node.js 24、TypeScript、Fastify 5、`@fastify/websocket` 和 SQLite 技术路线，抽出独立 `oraculum-gateway`。Gateway 对客户端提供明确的 `/api/v2` HTTP 资源与命令、WSS 事件、受控文件流；内部通过官方 Codex App Server 接口适配。所有命令逐项白名单化，不提供 `POST /rpc {method, params}` 形式的任意原生 RPC 通道。

选型依据是已经实现并测试过的安全与可靠性边界，不是重新开发框架：

| 当前源码 | 已有价值 | 2.0 推荐处理 |
|---|---|---|
| [`bridge/src/server.ts`](../../bridge/src/server.ts) | Fastify HTTP/WSS、Host/Origin/Base Path 校验、有限事件回补、上传下载限额 | 保留后端能力；移除页面、主题包与 React 资源托管；换明确 HTTP API 与原生客户端认证 |
| [`bridge/src/service.ts`](../../bridge/src/service.ts)、[`native-requests.ts`](../../bridge/src/native-requests.ts) | 原生请求白名单、项目归属、审批令牌、先移除待审批再向 Codex 回答 | 拆分适配职责，保留校验；审批仍由 Codex 产生和裁决 |
| [`bridge/src/trust-store.ts`](../../bridge/src/trust-store.ts) | 私有目录/数据库权限、随机设备凭据摘要、一次性配对、长期信任、撤销 | 新库从零建立同等语义；不接受旧 cookie、设备身份或旧表 |
| [`bridge/src/receipts.ts`](../../bridge/src/receipts.ts)、[`native-operations.ts`](../../bridge/src/native-operations.ts) | 原生调用前持久化操作 ID；断线后保留 unknown；不重放 RPC | 合并为最小 operations 表；覆盖全部副作用 |
| [`bridge/src/projects.ts`](../../bridge/src/projects.ts)、[`attachments.ts`](../../bridge/src/attachments.ts)、[`artifacts.ts`](../../bridge/src/artifacts.ts) | 主机授权根、目录 inode、描述符相对访问、附件归属、短期成果授权 | 保留这些安全语义；仅转换 API 和新状态存储 |
| [`packages/shared/protocol.ts`](../../packages/shared/protocol.ts)、[`scripts/generate-protocol.mjs`](../../scripts/generate-protocol.mjs) | 已有共享 DTO 和 Codex 版本/Schema 指纹锁 | 分开 Gateway 公共协议与 Codex 内部生成类型；不直接把所有 Codex 类型暴露给 Kotlin |

当前仓库 `package.json` 声明 Node `>=24 <25`，Bridge 使用 Fastify `5.12.7`、`@fastify/websocket` `11.3.4`；这是研究基线，Phase 1 应锁定经验证的精确依赖，不在本阶段升级。`node:sqlite` 的 Node 24 官方文档仍标为 Active development，且 `DatabaseSync` 同步执行；保留它能避免增加原生依赖，但必须锁定 Node 补丁版本，把数据库调用限制为短小事务，避免大查询阻塞事件循环。不能把它描述成已经达到稳定等级 2 的 API。[Node 24 SQLite 官方文档](https://raw.githubusercontent.com/nodejs/node/v24.11.0/doc/api/sqlite.md)

Gateway 持久化通信安全与主机能力元数据。Codex 会话/消息/执行/审批事实属于 Codex；客户端草稿、主题、窗口、阅读位置与历史缓存属于各客户端。Gateway 不存 UI 状态，不建立云账户或跨端偏好系统。

## 2. 协议和版本的单一来源

### 2.1 Schema 工具链

推荐在 Phase 1 建立 `packages/gateway-contract/schema/`：以手写并审阅的 **JSON Schema Draft-07** 为唯一 DTO 来源，覆盖请求、响应、事件 envelope、各 `kind` 的 payload 和错误。Draft-07 足以描述本项目数据，且与 Fastify 默认验证路径一致。[Fastify 验证与序列化](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[JSON Schema Draft-07](https://json-schema.org/draft-07)

推荐使用 **quicktype** 从同一组 Schema 生成 TypeScript DTO 与 Kotlin `kotlinx.serialization` DTO。官方仓库明确支持 JSON Schema 输入及 Kotlin/TypeScript 输出，Kotlin renderer 明确提供 `framework=kotlinx`。调研时上游源码 `package.json` 为 `24.0.0`；这是候选版本证据，尚未在本仓库安装或执行完整 Kotlin 编译验证。[quicktype 官方 README](https://github.com/glideapps/quicktype)、[Kotlin renderer 选项](https://raw.githubusercontent.com/glideapps/quicktype/master/packages/quicktype-core/src/language/Kotlin/language.ts)、[上游版本声明](https://raw.githubusercontent.com/glideapps/quicktype/master/package.json)

具体构建约定：

1. 生成器作为精确版本的开发依赖，锁文件包含完整性值；生成不联网拉取 Schema，不从消息样本推断正式模型，不依赖浮动 `latest`。
2. 输入使用 `object`、显式 `required`、`$ref`、数组、标量与简单 nullable；同一字段不得混用数字/字符串 ID。避免依赖深层 `allOf`、条件 Schema 或生成器对复杂多态的隐式推断。
3. 请求与 payload 每种命令/事件独立生成。事件外层以 `kind` 分派到对应 payload DTO；少量手写分派代码只选择生成类型，不再手写第二套字段模型。不要求生成完整 HTTP SDK。
4. TypeScript 使用生成 DTO；Gateway 的 Fastify/Ajv 负责运行时输入验证，并对输出和事件做契约校验。Kotlin DTO 序列化只解决读写类型，不能代替范围、权限、状态与文件归属检查。
5. 客户端允许响应增加未知字段；可扩展事件 `kind`、原生 item 类型按字符串保留。未知可选展示事件可推进游标并提示；未知关键状态事件使相关投影失效、重同步并阻止相关写，不能一概跳过，更不能把未知审批当同意。安全敏感请求拒绝未知字段。
6. CI 在临时输出目录重新生成，编译 TypeScript/Kotlin，跑相同 JSON fixture 的双向 round-trip，并验证 nullable/缺省、未知枚举、64 位边界、Unicode、错误响应和每种审批。生成结果不得手改。
7. Phase 1 首个门槛就是上述最小契约编译实验。若候选 quicktype 版本无法可靠处理窄子集，应先报告具体失败并调整生成配置/更换经审阅的生成器，不通过人工复制 DTO 绕过门槛。

Codex 自己的 Schema 是另一条输入链：继续用官方 `generate-ts` / `generate-json-schema` 和版本/指纹锁建立内部适配证据；默认生成面与 `--experimental` 面分别核对。**出现在生成文件中不等于接口或字段稳定，不能因此自动加入 Gateway 公共协议。**具体接口核对以本交付的 Codex 专章为准。

### 2.2 安装身份、运行代次和兼容性

| 字段 | 精确定义 | 客户端用途 |
|---|---|---|
| `installationId` | 新 Gateway 状态库第一次初始化生成的随机 UUID；正常重启/自身更新不变，重新初始化才变化 | 区分同一 URL 后面的不同安装；变化时隔离旧缓存、旧设备身份和未确认操作 |
| `epoch` | Gateway 与所连 Codex 的运行代次 UUID；Gateway 重启、Codex 重启或重新建立原生连接时变化 | 使旧事件游标、审批 generation、快照和分页令牌失效 |
| `protocol.major/minor` | 首版建议 `2.0`；与 Gateway、Desktop、Android 三个发行版本相互独立 | major 不匹配禁止调用；minor 增加可选能力 |
| `protocol.minClientMinor` | 当前 major 下执行所需的最低客户端协议次版本 | 旧端显示明确升级提示；不能猜测字段兼容 |
| `gatewayVersion`、`codex.version` | 实际运行版本 | 诊断与兼容矩阵；不能代替能力判断 |
| `capabilities[]` | 逐项列 `name/supported/availability/maturity/verified/reasonCode/observedVersion/epoch` | 区分有适配器、当前可用性和真实运行证据；未列出的功能禁用 |
| `limits` | 请求大小、历史页大小、附件限额、事件回补上限 | 客户端提前校验；服务端仍最终执行限额 |

`GET /health` 无鉴权，只返回存活、协议 major、公开的 `installationId`，不暴露目录、模型、设备列表或 Codex 账户。`GET /api/v2/capabilities` 经过设备认证，返回完整协商结果。所有路径拼在规范化 `Origin + Base Path` 下，Base Path 默认 `/`；本地 loopback 运行不依赖远程配置。

`supported` 表示有已审阅适配器；`availability` 使用 `unverified | available | unavailable | unsupported`；`verified` 表示是否已有当前版本/epoch 下该能力的运行证据，不能从 initialize 成功推导。`maturity` 沿用 Codex 专章分类。已审阅、符合稳定性准入规则、`supported=true/availability=unverified` 的写能力，允许用户明确意图触发第一次正常操作，再由其真实返回更新运行证据；禁止为检测能力自动发写请求。`unavailable/unsupported` 禁止执行并显示原因。下面是协议结构示例，不代表已经完成这些运行验证：

```json
{
  "protocol": { "major": 2, "minor": 0, "minClientMinor": 0 },
  "gatewayVersion": "2.0.0-dev",
  "installationId": "7df9e57b-79bd-4d5b-b1ac-0ac6430ab9a6",
  "epoch": "a29e7a47-e3dd-43ca-8a06-2dbb9498c3f7",
  "codex": { "version": "0.167.1", "connectionState": "connected" },
  "capabilities": [{
    "name": "turn.start", "supported": true,
    "availability": "unverified", "maturity": "default-surface",
    "verified": false, "reasonCode": "AWAITING_FIRST_USER_OPERATION",
    "observedVersion": "0.167.1",
    "epoch": "a29e7a47-e3dd-43ca-8a06-2dbb9498c3f7"
  }],
  "limits": { "attachmentFileBytes": 20971520, "eventReplayCount": 1024 }
}
```

## 3. HTTP 和 WSS 接口草案

以下是资源契约，不表示表中所有 Codex 能力现已稳定可用。每项最终开放范围受能力矩阵约束；原生限制必须向客户端保留，不能由 Gateway 仿造原生操作。

| HTTP 接口（均相对 `/api/v2`） | 输入/输出要点 | 权限与语义 |
|---|---|---|
| `POST /auth/pair` | 一次性码、预生成 `deviceId/deviceCredential`、标签、`installationId`；返回设备与短 access | 仅配对码可授权；事务内消费一次 |
| `POST /auth/token` | `deviceId/deviceCredential/installationId`；返回短 access 与 expiry | 仅长期凭据可调用；不轮换/消耗长期凭据 |
| `GET /auth/session`、`POST /auth/logout` | 当前设备状态；退出并撤销本设备 | 不返回凭据摘要；logout 后关闭该设备连接 |
| `GET /capabilities` | 上述版本、能力、限制 | 已配对设备 |
| `GET /projects` | 注册项目、可用性、项目 ID | 不扫描未授权主机路径 |
| `POST /project-directories/query` | 授权根 ID、相对目录、cursor；目录页 | 浏览不等于注册/授权运行 |
| `POST /projects`、`DELETE /projects/{projectId}` | 注册/取消注册，写入带 `operationId` | 只更改 Gateway 注册元数据，不创建/删除项目文件 |
| `GET /projects/{projectId}/threads` | limit、cursor、归档筛选、受支持搜索 | 只查询该项目；不建设额外全文搜索引擎 |
| `POST /projects/{projectId}/threads` | `operationId`、原生允许的初始设置 | 新建 thread；未知结果采用 workspace 级阻塞 |
| `GET /projects/{projectId}/threads/{threadId}` | 原生元信息、可用性、当前设置、同步状态 | 核对原生 cwd 与项目身份，不仅信任 URL |
| `POST /threads/{threadId}/resume` | `operationId`、`projectId`、期望 epoch；默认不带设置 overrides | 用户选择现有会话后恢复/装载原生 thread；属于受控原生状态操作，不能隐藏在 snapshot/history 读取中 |
| `POST /threads/{threadId}/snapshot` | `projectId`、客户端已知 epoch/revision；返回有界投影与同步状态 | 只读；包括有效的待交互摘要及本设备回执 |
| `POST /threads/{threadId}/history/query` | `projectId`、受控 cursor、limit；历史页/详情 | 查询用 POST 便于不把游标/路径写入 URL 日志；不是写操作 |
| `POST /threads/{threadId}/turns` | `operationId`、`projectId`、输入/附件 ID、原生设置 | 发起一次新 turn；绝不后台重发 |
| `POST /threads/{threadId}/turns/{turnId}/interrupt`、`.../steer` | `operationId`、当前 turn ID；steer 输入 | 必须匹配已观察的活动 turn；停止也是受控副作用 |
| `POST /threads/{threadId}/commands` | `operationId`、`projectId`、封闭 `command` 枚举及专用 payload | name/fork/archive/unarchive 等逐项映射；delete/revert/review/compact 仅在兼容矩阵允许时开放 |
| `POST /interactions/{interactionId}/response` | `operationId`、`epoch`、`generation`、原生响应 DTO | CAS 竞争；只回答当前原生请求 |
| `GET /operations/{operationId}` | 本设备操作状态与已确认的 native ID | 无记录不等于原生未执行；不同 deviceId 不可读取 |
| `GET /models`、`GET /account/limits`、`GET /threads/{threadId}/usage` | 原生模型/effort、账户限额、用量投影 | 返回来源与可用性，不能填造缺失值 |
| `GET /extensions`、`GET /threads/{threadId}/agents` | 经批准的 Skills/MCP/Apps/Plugins 只读总览、子代理关系 | 不新增扩展安装控制台或 Agent Runtime |
| `POST /projects/{projectId}/files/query` | 相对目录、cursor；允许读取的文件/目录 | 项目内受控浏览；与 Codex 工具执行权限分开 |
| `POST /projects/{projectId}/files/select` | 相对路径、可选 thread 上下文；短期 fileId | 不返回可匿名使用的文件 URL |
| `GET /files/{fileId}/content` | 已认证文件流，限定 content type/长度/hash | 绑定设备、项目、文件版本和 expiry；变化后重新选择 |
| `POST /threads/{threadId}/attachments` | 受限文件元信息、`draftId`、operationId、binary stream | 仅写新 Gateway 管理的附件收件区；不允许客户端指定绝对落盘路径 |
| `DELETE /attachments/{attachmentId}` | `operationId`、对应草稿范围 | 只删除本设备尚未提交的附件；held/unknown 材料保留 |
| `GET /events`（Upgrade WSS） | Authorization；首次消息 `resume {epoch, afterSeq}` | 仅事件/回补/心跳，不承载业务写命令 |

同一命令不再同时开放 HTTP 与 WSS 两个执行入口。HTTP 超时只表示客户端没有取得结果，不能当成“原生已取消”。文件流与 JSON 路由单独限额；所有认证响应 `Cache-Control: no-store`，默认不对内容启用公共缓存。

### 3.1 Envelope 与错误

写入请求必须有客户端先持久化的 UUIDv4 `operationId`，以及所需的项目/thread/turn 预条件；`requestId` 只用于一次网络尝试的诊断，不能当幂等键。下面是说明性 JSON，实际 Schema 在 Phase 1 建立：

```json
{
  "operationId": "93c7b7d0-beb1-4b1c-85c3-6b9252f10f42",
  "projectId": "c13ab2f9-47cd-4f42-bdbd-cb32229ece17",
  "expectedEpoch": "a29e7a47-e3dd-43ca-8a06-2dbb9498c3f7",
  "input": [{ "type": "text", "text": "用户明确发送的内容" }]
}
```

响应的公共元信息为 `requestId/installationId/epoch`；写响应额外返回 `{operationId,status,nativeThreadId?,nativeTurnId?}`。`status` 只描述网关交付结果，取 `accepted | rejected | unknown`。原生 turn 的 running/completed/failed 是另一个来自 Codex 的字段，不能把“已送交”画成“执行已完成”。

错误结构建议 `{code,message,operationId?,delivery?,retryAfterMs?,reset?}`；稳定错误码包括 `UNAUTHENTICATED`、`DEVICE_REVOKED`、`PROTOCOL_INCOMPATIBLE`、`CAPABILITY_UNAVAILABLE`、`PROJECT_UNAVAILABLE`、`STALE_EPOCH`、`CURSOR_RESET_REQUIRED`、`OPERATION_ALREADY_RECORDED`、`OPERATION_UNKNOWN`、`INTERACTION_STALE`、`FILE_CHANGED`、`RATE_LIMITED`。HTTP 对应 401/403/409/413/429/503 等；中文文案不是客户端状态机的判断依据。未知写不能因为 5xx、连接关闭或 `retryAfterMs` 而自动重发。

## 4. 事件、分页和恢复

### 4.1 有界事件流

事件包含 `{epoch, seq, kind, impact, scope, payload}`；`impact` 为 `informational | state`，缺失/无法解释时保守按 state 处理；`scope` 使用项目/thread/turn/item ID，不使用客户端可操纵的任意主机路径。`seq` 推荐定义为**同 epoch、同 deviceId 内严格递增的序号**，该设备的多个连接共用同一流。先做权限过滤再分配 seq，避免全局序号过滤后产生假缺口；设备相关附件和操作回执不广播给其他设备。非所有者可见的只有其有权限项目内的线程级状态。

首版保留每设备内存 ring：建议最多 1,024 条、2 MiB 或 5 分钟，三者任一达到即淘汰；另设活跃设备总预算和连接上限。此数值是待压测默认值，不是新增永久事件库。重新建立 feed、Gateway/Codex 重启或回补越界时统一 `resetRequired`。离线几小时/进程被杀不承诺完整事件补齐。

客户端只接受期望 epoch 下连续 seq；重复 seq 丢弃，跳号停止应用增量并回补。恢复请求只读、可带退避和抖动重试。事件确认游标要在对应缓存变更提交后保存，不能先推进游标再写内容。待审批和 unknown 写记录不能因只读历史清理而消失。

未知 `informational` 事件允许跳过展示并推进游标；未知 `state` 事件先使 scope 内投影失效并阻止相关写，再获取受支持快照。若快照/协议也无法解释关键状态，则保持受限并提示更新，不能用 reset 循环掩盖不兼容。

事件可含原生消息 delta、工具/Plan/Diff 状态、interaction opened/resolved、operation changed、project changed、history invalidated、usage changed。大型 item/工具输出只给有明确 `truncated/detailsAvailable` 的有界投影，通过历史/详情接口读取；不得静默截断后宣称完整。

### 4.2 分页不是原生历史副本

每个历史页应返回 `{epoch,historyRevision,source,items,nextCursor,complete,truncated}`。cursor 是 Gateway 签发的有界不透明令牌，至少绑定 installation/epoch、项目/thread、查询种类、revision、位置、expiry；客户端不能把任意原生 cursor 或主机路径当通用能力传回。翻页时先重新检查授权与项目身份。

`historyRevision` 是 epoch 内投影失效标识，不是 Codex 全局提交版本。revert、compact、删除、原生历史变动或无法确认连续性时，使旧 cursor 和受影响历史缓存失效；旧 epoch 下的 revision 即使数字相同也不能复用。

现有 [`history.ts`](../../bridge/src/history.ts) 有 `thread/turns/list`、`thread/items/list` 和回退 `thread/read` 后切页；其中回退切页只限制发给客户端的页大小，**不限制原生一次读取整段历史的 CPU、内存与响应成本**。稳定接口限制必须保留：不为追求分页启用未经批准的 experimental 接口，不解析 Codex rollout 文件补造历史，不建 Gateway 权威历史库。对不可获得原生分页的版本，明确报告 `source=native-read-projection`，设置并发/超时/内存预算；超限给出可重试错误并保留客户端旧缓存，不让一个大历史请求卡住所有设备。

### 4.3 快照与流式消息的竞态

`seq` 只是 Gateway 观察顺序；除非官方接口明确保证，不能声称原生 `thread/read` 与 notification 是原子快照。连接恢复采用“先建立事件观察，再取快照，再校正”的顺序；读取期间记录该 thread 的变更计数，但这个计数只用于发现碰撞，**不能证明没有稍后才送达、却已包含在快照中的 delta**。

WSS `resume` 先原子注册本设备事件观察，再给出当前 `headSeq`；客户端从此连续缓冲。snapshot 返回 `observedStartSeq/observedEndSeq` 表示 Gateway 原生读取前后所观察到的流范围，**它们不是 Codex 历史水位，不能用于丢弃全部 `seq <= observedEndSeq` 的内容事件**。客户端只对可按原生 ID 整体替换的事实合并，对活动 item 执行以下隔离规则；缓冲越界则重新 reset，不能默默丢失中段。

- 对仍在运行的 item，若原生没有可核验的 offset/revision/水位证据，始终把恢复快照与后续 delta 分开：后者进入独立临时流，不 append 到快照正文。临时流明确标记“正在同步”，不能冒充完整持久内容。
- 完整 `item/completed` 按原生 ID 覆盖；若该事件本身只是截断投影，则继续读取详情/原生状态，不把截断内容标记完整。对于在本次连接中从完整 `item/started` 起观察到的新 item，可以在其独立流内按 seq 追加；任何 gap 后立即退回隔离状态。
- 原生已经报告 terminal、且对应完整 item 或原生重读确认静止后，以原生读取覆盖历史基线；晚到的旧 item delta 忽略。单纯“等待几秒没有事件”不能证明静止，也不能解锁跨快照的 append。
- 持续活动期间允许暂时显示有明确同步状态的投影，不能提前确认缓存完整。最终完成事件/后续成功原生读取必须收敛到同一内容；该竞态是 Phase 1/2 必测项。
- 已归档、删除或无权限会话回退到项目/会话入口；本机草稿保留在原 partition，不能自动转给另一会话或自动发送。

该流程不假设跨进程原子快照；Phase 1 应用真实 Codex 流式输出验证最终合并规则，文档阶段不宣称已经实现。

## 5. 未知写、多端竞争与审批

### 5.1 操作回执

1. 客户端先持久化本设备 operationId 和“用户已点击发送”的状态，再发 HTTP。草稿正文与此记录分开保存；不建立离线发送队列。
2. Gateway 完成认证、能力和项目检查后，在短事务内插入 `operations(status=unknown)`，并原子认领相关附件；提交成功才允许调用 Codex。不得把事务跨越网络等待。
3. Codex 写只有明确原生响应或能够证明未派发的本地拒绝才能记 accepted/rejected；后者附 `delivery=notSent`。连接中断、超时、进程崩溃、原生响应与本地落盘之间故障均保留 unknown。纯 Gateway 元数据写（例如项目注册）以自身原子事务提交/明确拒绝为结果，不等待不存在的 native ACK。数据库写失败时绝不能继续调用原生接口。
4. 已记录的 operationId 永远不再次执行；重复业务 POST 一律返回 409 `OPERATION_ALREADY_RECORDED`，客户端只能 `GET /operations/{id}` 查询，不论重复正文是否变化。由于不保存请求正文/摘要，不能把不同 payload 复用 ID 的重复 POST 回成 accepted。操作 ID 不可复用；最小墓碑不按普通缓存 TTL 删除。
5. 恢复连接先查该 operationId、再查原生 thread/turn。仅当记录了可靠 native ID、明确原生结果等证据时校正；不能凭“文本看起来相同”或“没有找到”推断没执行。
6. 无法确定时显示 unknown，并阻止冲突写；允许继续读与对已确认活动 turn 发停止。不能通过自动重试、重新分配 operationId 或切换设备绕过未知状态。

作用域必须正确：`turn/start`、steer、生命周期写以 thread 为阻塞范围；**`thread/start` 返回 threadId 之前的 unknown 必须以项目/workspace 为范围**。fork 也可能产生未知的新 thread，不能只看旧 thread 完成就判定成功。

永久不确定需要保守出口：用户先读原生状态，再明确发起新的独立意图。可以在新写请求中提供绑定当前阻塞版本的显式已阅字段；它只表示用户理解不确定性，不把旧记录改成 rejected、不重发旧 operationId。首个 Phase 1 里程碑可先保持 unknown 只读与停止出口，待故障测试后确定最小交互；不新增“解决未知操作”的通用管理系统。

回执查询按 `deviceId` 授权。重新配对得到新 deviceId，不继承旧回执、unknown、草稿或凭据；旧 tombstone 继续存在。对其他已授权设备只暴露当前项目的“有未确认操作”阻塞原因，不泄露旧设备 operationId 或输入。Gateway 重建后 `installationId` 变化：原设备的操作 ID 不能送到新安装假装恢复。

### 5.2 原生审批与请求用户输入

`interactionId` 是 Gateway 为当前原生请求生成的 UUID；内部绑定 `{epoch,nativeRequestId,threadId,turnId?,generation}`。原生 request ID 可被下一次 Codex 进程复用，不能单独当唯一键。Gateway 持有的是当前待回答请求的临时索引，不是批准/拒绝的历史权威。

多端同时回答时，在单 Gateway 进程内执行无 await 的 compare-and-set：检查 request 仍 pending、generation/epoch 匹配、设备和项目有效；将 pending 改为 submitting，再发送一次原生 response。另一设备得到 409 stale/resolved 并刷新。操作收据先持久化后进入这个边界，不能在 HTTP ACK 丢失后再次回答。

“已提交响应”不等于“原生已批准并执行”。原生 resolved/后续状态到来后各端更新；若发送结果未知，则显示 unknown 并等待原生校正。Gateway/Codex 代次变化后所有旧卡片失效，禁止自动补交曾保存的 approve。原生重新发出的请求生成新 interactionId/generation，由用户重新决定；不从旧历史重建一个可点击的批准按钮。

未知请求类型必须 fail closed 并给出具体不支持原因，不把它当普通 yes/no，不新增自己的权限评审器。审批正文不写 Gateway SQLite，历史展示也不能以实时事件缓冲冒充完整原生审批历史。

## 6. 设备认证与长期信任

### 6.1 推荐首版：长期设备凭据换取短期 access

推荐使用随机、不可预测的设备秘密；它是本产品的个人设备凭据，不包装成 OAuth/OIDC，也不建立用户账户/授权服务器。`deviceCredential` 32 个随机字节；Gateway 仅保存 SHA-256 摘要，秘密只在客户端安全存储与专用 TLS 认证请求中出现。设备信任无日历到期，撤销、丢失安全材料或明确安全失效时才重新配对。

短 access 为随机 opaque token，建议有效期 10 分钟，Gateway 只在内存存其摘要、deviceId、expiry、installationId。每个已授权 HTTP/WS 操作仍检查设备撤销状态，不把“access 尚未过期”当长期信任的替代。Gateway 重启清空 access，客户端使用设备凭据重新换取即可。

**首版不做自动 refresh-token rotation。**长期凭据只用于 `/auth/token`，不用于每个业务请求；换 access 不消耗它，可以安全重试，ACK 丢失不会使设备必须重新配对。相较旋转 token，这省去了 successor secret 持久化、丢 ACK 重放窗口、并发刷新和误判重放后撤销全设备的问题。代价是长期秘密一旦泄漏，其风险持续到撤销；短 access 不能修复长期秘密被盗，安全存储、TLS、日志脱敏与快速撤销是必要条件。若真实威胁/验收证明需自动轮换，应单独设计并验证双阶段轮换与恢复，再改变认证协议。

主动替换长期身份采用“配对新设备记录 → 确认可用 → 撤销旧记录”，不覆盖旧秘密，也不继承旧客户端状态。此设计符合已批准的长期信任与全新配对，不额外引入到期强制重新登录。

### 6.2 配对与 ACK 丢失

1. `oraculum pair` 在主机本地生成至少 128 位随机一次性码，推荐分组 Base32 便于输入；TTL 5 分钟，同一安装仅一条当前码。CLI 只在用户终端/私有交付位置展示，不进服务日志、公开文档或 Notion。
2. 客户端规范化 endpoint，检查 TLS 证书及公开 installationId；在本机安全存储先创建 pending `{deviceId,deviceCredential,endpoint,installationId}`。Android 使用系统 CSPRNG，Desktop 使用 Node crypto；均不能由 renderer/用户文本指定低熵秘密。
3. `POST /auth/pair` 携带 code、这组身份和设备标签。Gateway 校验格式、限速、installationId；事务内消费 code 并插入凭据摘要。返回设备状态与短 access，标签不参与授权判断。
4. 若配对响应丢失，客户端仍持有预存秘密：仅调用 `/auth/token` 查询/取得 access。成功即配对完成；临时断网/5xx 保留 pending 身份并退避重试 token 交换，不要求新码。只有明确认证拒绝或 installationId 不匹配才提示重新核对/配对，不自动反复消费配对码或重建身份。
5. `/auth/token` 响应丢失可重试；新颁发 access 不立即作废此前同设备 access，后者自然到期。限制每设备活跃 access 和交换速率，避免丢 ACK 制造无界会话。

配对失败按安装级总量和来源限速；不能仅信任可伪造的 `X-Forwarded-For`。建议维持现有每分钟最多 5 次失败的起点，再对总连接/成功交换加入预算。不得记录 code、credential、Authorization、cookie 或完整请求体。

### 6.3 HTTP/WSS 与撤销

Android 原生 HTTP/WSS 客户端与 Electron main 发 `Authorization: Bearer <access>`；token 不放 URL、WebSocket 子协议、下载链接或 renderer。WSS 握手认证后，每条事件/命令前校验设备状态，另每秒检查撤销；撤销时中止连接、上传和下载。access 到期前客户端换新 access 并重新连接 WSS，使用只读事件游标恢复；不为业务写自动重放。

原生客户端没有浏览器 cookie 的同源语义。新 Gateway 不要求每个 Android 请求伪造浏览器 Origin，不把 Origin 当身份；仍校验 Host、规范 Base Path 和配置的外部 HTTPS Origin，不开放任意 CORS。若请求提供 Origin，必须来自明确支持的客户端来源；普通网页无法取得凭据。只监听明确配置的 loopback，反向代理只信任受控本地入口/覆写后的转发协议；不能把任意远端 `X-Forwarded-*` 当成 HTTPS 证明。

本地 Desktop 可使用 loopback HTTP/WS，但仍需设备认证，不因 `127.0.0.1` 自动信任任何网页。远程必须 HTTPS/WSS，遵循系统证书校验；Base Path/Origin 改变由用户显式重设 endpoint 并确认连接目标，不能跨 host 自动转发 Authorization。产品代码不包含私人 VPS、域名、反向隧道和证书配置。

### 6.4 两端安全存储

Android 使用 Android Keystore 内不可导出的 AES-GCM 密钥包装 deviceCredential；密文与随机 nonce 放应用私有、排除备份的文件，AAD 绑定 endpoint/installationId/deviceId。Keystore 保存的是加密密钥，不是把任意 bearer 字符串直接塞进 Keystore。access 只放内存。不要要求每次解密强制生物识别而破坏已批准的后台提醒；密钥失效时停止网络写入、保留本机草稿并提示重新配对。[Android Keystore 官方说明](https://developer.android.com/privacy-and-security/keystore)

设备身份、密文、unknown 操作和本机草稿不通过 Android 自动备份迁移到另一设备；配置 cloud backup 与 device-to-device extraction 排除规则，并在真机验证。仅设置 `allowBackup=false` 不能覆盖所有厂商设备转移行为。[Android Auto Backup 官方说明](https://developer.android.com/identity/data/autobackup)

Electron main 独占设备秘密、access、HTTP/WSS 与文件授权；使用实际支持版本的 `safeStorage`/Ubuntu Secret Service 包装本地凭据。Linux `basic_text` 后端不能当安全加密：不可用时明确提示配置密钥环，最多提供当前进程内会话，不能静默明文持久化。renderer 仅有受限 preload，例如 `project.list`、`thread.read`、`turn.start`、`operation.get`；每个 IPC 校验 sender/frame、参数和 scope，不暴露任意 URL/header/method、`ipcRenderer` 或 `getToken()`。保持 sandbox、contextIsolation、nodeIntegration=false。[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

## 7. 全新 SQLite 的最小模型

数据库建议位于 `$XDG_STATE_HOME/oraculum-gateway/gateway.sqlite`（XDG 未设置时使用标准用户目录），新配置位于 `$XDG_CONFIG_HOME/oraculum-gateway/config.json`。目录 0700，库及相关文件 0600；拒绝符号链接、意外 owner 和未知 schema。不能把新路径指向旧 `trust.sqlite`。使用 `PRAGMA user_version` 管理**新版自身未来升级**，不提供旧表/旧状态迁移。

选择单进程 Gateway、单库、短事务，建议 `foreign_keys=ON`、`synchronous=FULL`、有限 `busy_timeout`；首版可沿用 rollback journal，低并发情况下不为“现代化”强行开启 WAL。SQLite 单写者足以协调 CLI 与 Gateway；事务不得含文件流或 Codex await。[SQLite 事务文档](https://www.sqlite.org/lang_transaction.html)

Gateway 自行生成的安装、设备、项目、操作和附件 ID 为 TEXT UUID；Codex 原生 thread/turn/request ID 保持原生不透明标识语义，不能强制为 UUID，配置中的 root ID 也按自身契约校验。时间为 UTC epoch milliseconds INTEGER，dev/ino 为十进制 TEXT，避免 JavaScript 精度损失。CHECK/NOT NULL/FK 应在 Phase 1 DDL 明确实现；下表为设计字段，不是已创建的数据库。

| 表 | 最小字段与约束 | 索引与生命周期 |
|---|---|---|
| `gateway_meta` | 单行 `id=1`、`installation_id UNIQUE`、`created_at`；Schema 版本放 `user_version` | 与新安装共存；不存账号/token/UI |
| `devices` | `id PK`、`label`、`credential_digest UNIQUE`、`created_at`、`revoked_at NULL`、`last_seen_at NULL` | 按 digest 查认证；撤销墓碑长期保留；无自然过期；last_seen 可节流写 |
| `pairing_codes` | `code_digest PK`、`created_at`、`expires_at` | 至多当前一条；消费事务删除；过期清理；不存明文 |
| `projects` | `id PK`、`canonical_path UNIQUE`、`root_id`、`dev`、`ino`、`created_at`、`unregistered_at NULL`、`inbox_name NULL`、`inbox_dev NULL`、`inbox_ino NULL` | 注册路径唯一；项目取消注册只做元数据停用，不删除项目/附件；根策略来自本机配置 |
| `operations` | `operation_id PK`、`device_id FK`、`project_id FK`、`thread_id NULL`、`kind`、`status CHECK(unknown/accepted/rejected)`、`created_at`、`updated_at`、`native_thread_id NULL`、`native_turn_id NULL`、`error_code NULL` | `(device_id,created_at)`、`(project_id,thread_id,status)`；操作 ID 和结果最小墓碑长期保留；无 prompt、回答、工具输出、原始错误日志 |
| `attachments` | `id PK`、`device_id FK`、`project_id FK`、`thread_id`、`draft_id`、`name`、`mime`、`extension`、`size`、`digest`、`state`、`created_at`、`expires_at NULL`、`operation_id NULL FK`、`turn_id NULL`、`dev/ino/folder_dev/folder_ino` | `(device_id,project_id,thread_id,draft_id)`、`(state,expires_at)`、`operation_id`；二进制不入库；状态见下 |
| `thread_permission_hints`（条件表） | `project_id`、`thread_id` 联合 PK，`preset`、`confirmed_at`、`codex_version` | 只有真实兼容测试证明仍需恢复用户已确认 preset 时才建立；只作提示，不覆盖原生实际权限 |

条件表不是把现有 `thread_permission_choices` 全搬过来。当前实现明确针对 Codex 0.160.0 重启恢复 sandbox 的差异；新版本必须重新验证。不能从缓存的 `full-access` 自动作出新授权，也不能用 UI 缓存盖过 Codex 的实际配置。

不建立以下持久表：会话/消息/turn/工具/审批历史、客户端草稿、账户偏好、主题、永久事件日志、成果文件内容。历史 revision、pending interactions、access、事件 ring、短期 file grants 都是可丢弃内存状态，epoch 负责重启失效。没有单独 artifacts 表是有意的：项目文件仍是原文件，重新浏览/选择即可重建授权。

`attachments` 状态建议 `uploading → ready → held → sent`，另有 `expired` 墓碑。上传失败/重启后未完成 uploading 可清理，未提交 ready 默认 24 小时；**held 和已进入 Codex 原生历史引用的 sent 不按 TTL 自动删除字节**。sent 的 30 天仅可作为重新检查/提示时间，不能作为删除授权；只有能证实无原生历史引用且安全可清理，或用户明确处置时才释放。若无法证明不再被引用，就保留并报告占用。已过期记录保留最小归属/ID 墓碑，不能复用旧附件 ID。存储总额达到上限时拒绝新上传，不能为了腾空间删除未知写材料或破坏原生历史中的附件引用。

CLI `oraculum init/status/pair/devices list/devices revoke` 使用共享 store 的短事务访问同 UID 私有库；不增加管理控制台、独立守护进程或管理凭据通道。CLI 打开前检查 schema/version；并发忙时安全失败。Gateway 每次使用 access 复查 devices，所以 CLI 撤销不依赖进程间内存广播；现有长连接最迟在下个检查周期关闭。

## 8. 项目、文件、上传和成果的边界

项目授权由本机配置给定的 `allowedRoots` 与显式项目注册共同决定。客户端只能选择已暴露的 root ID/相对路径，不能上传一个 `/etc` 或任意 cwd 变成授权根。注册保留 canonical path 与 dev/ino；目录移动、替换或 root 变化时标记不可用，要求用户重新注册。不得静默追随新路径或改写 Codex 原生 cwd。

文件/成果读取使用项目 ID 与规范相对路径：拒绝绝对路径、`..`、空段、编码分隔符、NUL/控制符、符号链接逃逸、特殊文件及不安全 hardlink。沿用现有 Linux 描述符相对遍历与 `O_NOFOLLOW`，固定每一级目录和最终文件的身份，操作前后复核；只做 `realpath` 再按路径 open 不足以抵御检查与使用之间的替换。嵌套注册项目必须重新走其自身授权边界。[现有项目检查](../../bridge/src/projects.ts)、[成果安全访问](../../bridge/src/artifacts.ts)

主机文件浏览保留已授权代码/文档读取与文件详情，不等于公开主机所有文件；隐藏敏感目录、凭据/私钥、Codex auth/config 等仍不可由文件面板读取。文件扩展名、MIME 和内容嗅探共同决定能否预览；扩大当前成果类型名单须有具体用例与测试，不通过任意 `file://` 绕过。HTML/SVG/主动内容不得在具有 Gateway/Node 权限的上下文执行；Markdown/GFM 走已审阅的安全渲染链。

上传只写新安装拥有的项目私有收件区，建议 `.oraculum-attachments-v2-<installationId前缀>`，与旧 `.oraculum-attachments` 明确隔离；只接受空的新目录，记录 inbox inode，不接管/清理旧目录。临时文件使用独占创建、限额/超时、MIME 嗅探、摘要与 fsync，完成后标 ready。建议保留目前单文件 20 MiB、单批 50 MiB、最多 6 个的起点，经 Phase 2 真机测量后调整；拒绝直接写入客户端指定文件名/路径，名称仅用于显示。

提交附件时，必须同时校验 device/project/thread/draft 归属；附件认领与 operation 预留同事务完成。draftId 只是设备本地关联标识，Gateway 不存草稿正文；附件 ID 不是另一设备可用的 bearer capability。Android 系统文件选择器读取到的 content URI 只在本地使用，通过原生流上传，不能当 Ubuntu 文件路径。图片/文档向 Codex 的转换沿用已批准的原生输入规则，不能假定所有文档 MIME 都是 App Server 原生二进制输入。

成果和主机读取通过短期 fileId grant，绑定 device/project/thread（如有）、规范相对路径、dev/ino/size/mtime/ctime、expiry。每次下载重新认证与核验；撤销/文件变化立即中止，返回 `FILE_CHANGED`，不悄悄发送另一版本。初版维持完整文件下载，不承诺 Range/断点续传，避免授权与内容版本未固定时拼出错误文件。分享由 Android SAF/系统分享、Desktop 保存对话框接管已下载内容，不能把 access token 交给外部浏览器或分享链接。

清理只针对本安装记录且身份仍一致的文件描述符；不递归删除未知目录，不删除 Codex 项目文件、原生历史或配置。取消项目注册不意味着删除目录。新安装过程中发现旧状态/旧附件目录，报告并保留。

## 9. 双端本地数据契约

Android Room 与 Desktop renderer IndexedDB 分别存各自历史缓存、草稿、导航和阅读位置；Zustand 是 Desktop 内存状态，不能代替持久层。至少按 `endpoint + installationId + deviceId + projectId + threadId` 分区；这里的 endpoint 是规范 Origin+Base Path，不是硬编码部署地址。本项目没有新建账户系统，不虚构 accountId 同步层。

缓存页保留 epoch/revision/source/complete/loadedAt 和原生 item ID，能替换、丢弃、重建。已发送内容以原生读取校正；历史修订/压缩/删除后不能把本地旧消息重新写回 Codex。断网仅保留已加载内容只读、草稿可编辑；恢复不能自动提交草稿。

unknown operation 记录属于本设备的通信安全状态，应与可清理历史缓存分区/存储分开。用户清理历史、恢复阅读位置失败、IndexedDB/Room 页损坏都不能自动清除 unknown 并启用发送。草稿同样独立于可重建历史：一段历史缓存删除不应把未发文字带走。重新配对的新 deviceId 不继承旧发送权限或把旧待发送状态重新排队。

两端只共享正式 Schema、状态含义和 fixture；不共享 UI 组件，不同步草稿，不把 Android Room 变成 Gateway 历史数据库。客户端详细表与恢复交互见 Android/Desktop 专章。

## 10. 风险、验证门与尚需落实的工程问题

| 风险/边界 | 必须验证的验收结果 |
|---|---|
| 生成器复杂多态或缺省语义失真 | 同组 fixture 通过 Ajv、TS、Kotlin 编译与 round-trip；unknown payload 安全降级；不能手改生成文件补救 |
| 短 access/配对 ACK 丢失 | 配对已提交后丢响应仍能用本地预存身份恢复；token ACK 丢失不要求重配；多连接刷新不错误撤销设备 |
| 撤销与长连接/文件竞态 | 已撤销设备无新请求进入 Codex，WSS/文件流在约定检查周期关闭；UI 不继续显示可提交状态 |
| Gateway/Codex 崩溃前后 | 在预留前、预留后、native 接收后、native ACK 后分别杀进程；同 operationId 最多一次转发；不把 unknown 推断为 failed |
| 新建会话无已知 threadId | workspace barrier 生效；其他端不能无提示绕过；新安装/新 deviceId 不继承旧回执 |
| 双端竞争回答审批 | 两端同时提交只向原生输出一次；旧 generation/epoch、未知类型和越权 scope 全部拒绝 |
| 事件缺口/回补越界 | 重复、乱序、gap、epoch reset、设备过滤均不造成重复 delta 或跨设备回执泄露；最终内容与原生一致 |
| 快照读与持续输出同时发生 | 不把 snapshot 内已有 delta 重复追加；结束后按 item ID/原生读取收敛；同步状态不误标完成 |
| 原生全量历史成本 | 超长原生历史有限并发、可观测超时/内存；本地缓存立刻可读；不能把投影页大小当原生有界性证明 |
| 文件系统替换/敏感路径 | symlink、祖先目录替换、hardlink、FIFO、路径编码、撤销、跨项目/跨设备附件、过期 grant 均拒绝；旧文件保持原样 |
| 本地安全存储不可用/损坏 | Android Keystore 失效和 Desktop keyring/basic_text 情况有明确恢复路径；不明文落盘，不丢草稿，不自动发 unknown |
| 新库与 CLI 并发 | schema 不匹配拒绝打开；配对只消费一次；撤销实时可见；SQLite busy 不导致跳过回执/授权 |

本章尚未完成的内容均是 Phase 1/2 工程验证：候选代码生成器编译实验、当前 Codex 权限 preset 持久行为、真实代理 WSS 空闲/长文件行为、Keystore/Secret Service 故障恢复，以及持续流下的快照合并。它们不是要求用户重新选择已批准框架、旧数据迁移或个人 VPS 参数。本章不把这些未测事项写成“已通过”；Phase 0 已接受、Phase 1 已独立授权，后续按正式 Task 补充实现及测试证据。
