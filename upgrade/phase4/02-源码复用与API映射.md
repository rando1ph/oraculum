# P4.0｜源码复用与 API 映射

研究基线：`3c7a7787b31c3fc007c19c993e0b9f8f78f12923`（main，2026-11-17 上海时间）。本文是静态分析与后续实施建议，没有运行客户端、连接在线 Gateway 或修改正式代码。

依据：[P4.0 任务](https://www.notion.so/41a5421e690b813b8004c9495eed1027)、[2.0 正典](https://www.notion.so/4135421e690b815eb404c3024c860134)、根 [AGENTS.md](../../AGENTS.md)。2026-11-16 Desktop 决定覆盖旧文档中“Desktop 暂缓”“高级旧主题可选复用”等历史表述。保留 Electron / React / TypeScript、Vite / pnpm、Zustand、IndexedDB、Tailwind CSS；全新三主题，无旧应用数据迁移、无 Tray、无 ACP 或自建执行循环。

## 1. 结论与复用边界

现有 Desktop 是加载 Bridge 页面的一层 Electron 壳；Web 的入口同时编排 Bridge RPC、浏览器认证、旧主题、Android WebView 与页面状态。把 `apps/web` 整体打包进去会继续携带旧运行链路。可复用的价值主要是纯展示能力、数据合并规则及已有安全案例；Gateway 2 协议必须从正式 Schema 接入。

分类中的“舍弃”指**新版构建不引用**，不授权在 P4.0 删除历史文件。以下都不是本阶段已完成的代码抽取。

| 源码 / 当前作用 | 处理 | 后续落点与理由 |
| --- | --- | --- |
| [desktop/main.cjs:9–15,30–34,115–131](../../apps/desktop/main.cjs#L9-L131) | 需重组 | 复用 sandbox、禁止 Node 集成、关闭窗口退出的安全意图；删除新版对远端页面 `loadURL` / `ensureBridge` 的调用，改为 Desktop 自有资源。 |
| [desktop/runtime.cjs:13–58](../../apps/desktop/runtime.cjs#L13-L58) | 新版舍弃 | 协议 1 健康检查和启动 Bridge systemd 的行为与现有 Gateway Beta 3 保护要求冲突；新版不管理任何服务。 |
| [desktop/artifacts.cjs:8–16](../../apps/desktop/artifacts.cjs#L8-L16)、[main.cjs:39–53](../../apps/desktop/main.cjs#L39-L53) | 需解耦 | 保留文件名/MIME/大小校验、系统保存后显式打开的交互；旧 `blob:Bridge-origin` 白名单不能直接用于主进程鉴权下载。 |
| [shared/client.ts:4–29,67–105](../../packages/shared/client.ts#L4-L105) | 新版舍弃 | `BridgeClient` 是浏览器 WebSocket 上的任意 method RPC，不是 Gateway 2 的 HTTP 操作 + WS 事件。不能换 URL 后继续使用。 |
| [shared/protocol.ts:20–81](../../packages/shared/protocol.ts#L20-L81) | 需解耦 | 含 BridgeEvent、bridgeToken、旧 Snapshot、数值 historyRevision 及 `.local/codex-protocol` 类型依赖；不能用作新 Desktop 网络 DTO。 |
| [gateway-protocol/src/index.ts:1–60](../../packages/gateway-protocol/src/index.ts#L1-L60)、[schema/v2.json](../../packages/gateway-protocol/schema/v2.json) | 可直接复用契约 | main 使用 `parseContract` / `assertContract` 校验；renderer 只接收有限的显示 DTO。生成类型不等于 JSON 已通过校验，也不等于原生能力已验证。 |
| [shared/entry.ts:1–18](../../packages/shared/entry.ts#L1-L18)、[entry.ts:22–26](../../packages/shared/entry.ts#L22-L26) | 部分复用 | `basePath` / `httpsOrigin` 的严格规范化可复用；`appUrl` 从 `location.href` 推导 Gateway 的假设应舍弃。HTTP loopback 单独校验，不放宽 HTTPS 函数。 |
| [shared/read-recovery.ts:1–16](../../packages/shared/read-recovery.ts#L1-L16) | 可复用纯函数 | 只用于有界、可取消的明确只读调用；不能按 HTTP 动词判定安全，也不能给所有错误或写操作套重试。 |
| [web/store.ts:47–114,130–180](../../apps/web/src/store.ts#L47-L180) | 复用规则，适配 DTO | 原生顺序、terminal 不回退、同 revision 保留旧页、不同 revision 丢弃投影值得保留；旧 `Snapshot` / `Approval` / 数值 revision 及旧事件 reducer 必须替换，不能整份 store 直搬。 |
| [gateway/reconcile.ts:11–92](../../gateway/src/reconcile.ts#L11-L92) | 规则参考 / 小范围抽取 | 有 seq 去重、gap、baseline / stream 分离与 terminal 合并规则；它在 Gateway 目录且使用 Node `Buffer`，renderer 不直接导入整个后端模块。 |
| [web/content.tsx:24–35](../../apps/web/src/content.tsx#L24-L35)、[diff-lines.ts:1–31](../../apps/web/src/diff-lines.ts#L1-L31)、[paths.ts:1–7](../../apps/web/src/paths.ts#L1-L7) | 可复用核心 | 保留 GFM / `skipHtml`、禁远程图片自动加载、代码复制、Diff 行统计和仅显示的相对路径；DOM 样式改用新 tokens，网络路径始终保留原始身份。 |
| [web/diff.tsx:7–41](../../apps/web/src/diff.tsx#L7-L41)、[content.tsx:61–130](../../apps/web/src/content.tsx#L61-L130) | 需解耦 | 复用只读 CodeMirror、工具和文件变更展示；移除旧 CSS / theme slots、固定 dark 配色，给有界 JSON item 加类型防护和详情加载状态。 |
| [web/process.tsx:13–78,80–105](../../apps/web/src/process.tsx#L13-L105)、[reading.ts:1–54](../../apps/web/src/reading.ts#L1-L54)、[layout.tsx:19–32](../../apps/web/src/layout.tsx#L19-L32) | 复用交互规则 | 复用执行摘要、原生时长、item/turn 阅读锚点、键盘可调分栏；更换旧 storage key 和持久层，不继承旧展开/阅读/布局数据。 |
| [web/composer-settings.ts:19–29,50–88](../../apps/web/src/composer-settings.ts#L19-L88)、[permissions.tsx:10–44](../../apps/web/src/permissions.tsx#L10-L44) | 复用语义，重做绑定 | 区分待发送选择、配置默认值、原生已确认设置；由新 `PermissionReadback` 提供实际事实，不能把本地选中值显示成已生效。 |
| [shared/elicitation.ts:22–101](../../packages/shared/elicitation.ts#L22-L101)、[web/native-request.tsx:10](../../apps/web/src/native-request.tsx#L10) | parser 可直接复用，表单需适配 | Gateway 自身也使用此 parser（[interactions.ts:4](../../gateway/src/interactions.ts#L4)）。保留不支持约束即拒绝的规则；表单提交改用 Interaction ID / generation / epoch，不发送旧 bridgeToken / 原生 request ID。 |
| [web/session-actions.tsx:5–35](../../apps/web/src/session-actions.tsx#L5-L35)、[native-controls.ts:3–14](../../apps/web/src/native-controls.ts#L3-L14) | 需适配 | 保留确认、名称校验及运行态限制；`review/start` 在新 Gateway 无对应端点，旧 Receipt / NativeOperation 状态也不等价。 |
| [web/attachments.tsx:17–81](../../apps/web/src/attachments.tsx#L17-L81)、[artifact-client.ts:3–36](../../apps/web/src/artifact-client.ts#L3-L36) | 重写传输，复用展示 / 校验意图 | 旧 cookie/XHR 与 `artifacts/*` 路由舍弃；新上传走二进制流和操作回执，下载校验 `Content-Digest`，凭据只在 main。 |
| [shared/attachments.ts:1–25](../../packages/shared/attachments.ts#L1-L25)、[artifacts.ts:1–21](../../packages/shared/artifacts.ts#L1-L21) | 部分纯逻辑复用 | MIME / 预览预算 / 文件名校验可参考；scope 从 cwd 改为 projectId，实际上传限额以 capabilities 为准，旧 grant DTO 不能充当新 FileGrant。 |
| [web/agent-tree.ts:14–79](../../apps/web/src/agent-tree.ts#L14-L79)、[subagents.tsx:32–49](../../apps/web/src/subagents.tsx#L32-L49) | 树算法可适配，详情受限 | 从父线程原生 collab item 派生可见树；旧 `bridge/agent` 详情 RPC 不存在，不能宣称完整子会话浏览已具备。 |
| [web/usage.tsx:5–38](../../apps/web/src/usage.tsx#L5-L38)、[extensions.tsx:11–34](../../apps/web/src/extensions.tsx#L11-L34) | 复用展示规则，适配投影 | 保留缺值为“—”、缓存输入为子集、不把额度百分比换算成剩余 token；新扩展分区的 unavailable / limited 状态不能映射成空列表成功。 |
| [web/main.tsx:5–24,583–706,970–1140](../../apps/web/src/main.tsx#L5-L1140)、[auth.tsx:6–90](../../apps/web/src/auth.tsx#L6-L90) | 新版入口舍弃 | 新建 Desktop composition root；不复用集中式 Bridge 编排、浏览器 cookie 认证、WebView URL scheme 或旧主题设置。 |
| [shared/themes.ts:1–24](../../packages/shared/themes.ts#L1-L24)、[web/themes.tsx](../../apps/web/src/themes.tsx)、[theme-loading.ts](../../apps/web/src/theme-loading.ts)、[tokens.css](../../apps/web/src/tokens.css) | 新版舍弃 | 新版完全不引用 Trusted CSS Themes / Theme API v1、目录扫描、CSS 导入、迁移和旧主题状态。Oracle Eye 品牌资源另行保留，不借主题引擎加载。 |
| Android Compose 页面与 Room / Keystore | 不共享 UI / 平台实现 | 只参考已验证的协议与安全行为；Kotlin 不是 React 共享页面源，新 Desktop 有自己的布局、Profile 和缓存。 |

## 2. 统一请求约定

下表路径均相对于 **`{origin}{basePath}api/v2`**，`basePath` 规范化为以 `/` 结束；`health` 则位于 `{origin}{basePath}health`。不写入私有 endpoint 或部署路径。main 的 Node HTTP/WS transport 构造正确 Host，不能拿 renderer 自定义 origin 当 Gateway Origin，也不能关闭服务端校验。[server.ts:38–47,70–90](../../gateway/src/server.ts#L38-L90)

- `/api/v2/*` 均带 `X-Oraculum-Protocol: 2`。配对/换 token 以外均需 `Authorization: Bearer …`；禁止 URL query 或 WebSocket subprotocol 放凭据。WS 也由 main 设置认证 header。[server.ts:42–47,81–89](../../gateway/src/server.ts#L42-L89)
- 多数读响应为 `{requestId, installationId, epoch, data}`，写响应为 `{requestId, installationId, epoch, operation}`；auth 与 health 有独立响应。不能假定所有成功响应都有 `data`。[server.ts:41–62,102–111](../../gateway/src/server.ts#L41-L111)
- `OperationReceipt.status` 只有 `accepted / rejected / unknown`；accepted 不是任务已执行完成，完成事实来自原生 Turn。旧 Bridge 的 completed / failed 等回执枚举不能直接保留。[schema:133–174](../../packages/gateway-protocol/schema/v2.json#L133-L174)
- 可用性读取 capabilities 的 `supported / availability / verified / reasonCode`；`supported:true, unverified` 仅表示入口存在。不得因生成了 TS 类型就展示“已验证支持”。[service.ts:274–282](../../gateway/src/service.ts#L274-L282)

## 3. 前端意图 → HTTP / WS → 官方 Codex / 主机能力

“读”包含 POST 查询；带 operationId 的变更须先持久化本地账本。本文的前端方法名称为设计意图，不是新增的正式 API。

| 前端意图 / 页面 | 实际 Gateway 接口及主要输入 | 响应 / 后端依据 |
| --- | --- | --- |
| 连接与版本 | `GET {basePath}health`（不含 api/v2）；`GET /capabilities` | health 仅服务身份；capabilities 含协议 2.1、最低客户端 minor 0、Codex 连接及能力/限额。[server:102,111](../../gateway/src/server.ts#L102-L111)、[protocol:11](../../packages/gateway-protocol/src/index.ts#L11) |
| 首次配对 / 续期 | `POST /auth/pair` PairRequest；`POST /auth/token` TokenRequest | main 自建 deviceId / credential，pair 输入 installationId/code/label；access 最多 10 分钟，长期 credential 不回 renderer。[auth:21–25,57–79](../../gateway/src/auth.ts#L21-L79) |
| 身份显示 / 退出登录 | `GET /auth/session`；`POST /auth/logout` LogoutRequest | logout 撤销**本设备**，是显式变更；关窗口不调用 logout。[server:105–110](../../gateway/src/server.ts#L105-L110) |
| 项目 / 目录浏览 | `GET /projects`；`POST /project-directories/query` DirectoryQuery | 返回已注册项目和 allowed-root ID；目录路径受 Gateway 授权，不允许 renderer 绕过读取主机。[server:112–113](../../gateway/src/server.ts#L112-L113) |
| 注册 / 移除项目 | `POST /projects` ProjectRegisterRequest；`DELETE /projects/:projectId` ProjectUnregisterRequest | operationId + rootId/path 或 projectId；未知操作会阻断移除。移除注册不是删除目录。[server:114–127](../../gateway/src/server.ts#L114-L127) |
| 模型 / 新会话默认值 | `GET /models`；`GET /projects/:projectId/native-defaults` | `model/list(limit:100)` 首页；`config/read(includeLayers:false)` 的净化显示投影，不是现有会话实际权限。[server:128–129](../../gateway/src/server.ts#L128-L129)、[native-reads:47–65](../../gateway/src/native-reads.ts#L47-L65) |
| 会话列表 / 搜索 / 归档筛选 | `GET /projects/:projectId/threads?limit=&cursor=&search=&archived=` | ThreadPage；native `thread/list` 按 cwd/sourceKinds 过滤，opaque cursor 绑定查询。[server:133–136](../../gateway/src/server.ts#L133-L136)、[service:367–400](../../gateway/src/service.ts#L367-L400) |
| 会话 metadata / 恢复 loaded 状态 | `GET /projects/:projectId/threads/:threadId`；`POST /threads/:threadId/resume` ThreadResumeRequest | GET 验证项目/cwd；resume 是带 operationId / expectedEpoch 的原生写，不得每次唤醒自动当读请求重试。[server:138–142](../../gateway/src/server.ts#L138-L142)、[service:515–525](../../gateway/src/service.ts#L515-L525) |
| 新会话 | `POST /projects/:projectId/threads` ThreadStartRequest | operationId / expectedEpoch，可选 model/effort/permissionPreset → `thread/start`，原生线程 ID 来自回执。[service:500–512](../../gateway/src/service.ts#L500-L512) |
| 重命名 / 归档 / 恢复 / 删除 | `POST /threads/:threadId/name` ThreadNameRequest；`POST .../archive`、`.../unarchive` ThreadMutationRequest；`DELETE /threads/:threadId` ThreadDeleteRequest | 每项带 projectId / expectedEpoch / operationId；删除必须 `confirm:true`，原生生命周期和 pending 审批额外校验。[server:143–149](../../gateway/src/server.ts#L143-L149)、[service:577–629](../../gateway/src/service.ts#L577-L629) |
| 分支 / 回退 / 压缩 | `POST /threads/:threadId/fork` ThreadForkRequest；`.../revert` ThreadRevertRequest；`.../compact` ThreadMutationRequest | native `thread/fork`、`thread/revert`、`thread/compact/start`。运行态先停止；不通过改历史本地缓存模拟完成。[service:577–629](../../gateway/src/service.ts#L577-L629) |
| 发送 / 补充 / 停止 | `POST /threads/:threadId/turns` TurnStartRequest；`POST .../turns/:turnId/steer` TurnSteerRequest；`POST .../interrupt` TurnInterruptRequest | operationId、projectId、expectedEpoch；发送 input 文本数组及可选附件/草稿身份；steer/interrupt 必须指向当前原生 active Turn。[service:538–568](../../gateway/src/service.ts#L538-L568) |
| 快照 / 历史 / 单项详情 | `POST /threads/:threadId/snapshot` SnapshotRequest；`.../history/query` HistoryQuery；`.../history/details` ItemDetailsRequest | Snapshot、HistoryPage、ItemDetails；后者有自己的 detail cursor。历史分页不依赖旧 bridge/history*。[server:153–155](../../gateway/src/server.ts#L153-L155)、[service:654–704](../../gateway/src/service.ts#L654-L704) |
| 原生审批 / 询问 / MCP 表单 | `POST /interactions/:interactionId/response` InteractionResponseRequest | projectId、operationId、epoch、generation、typed response；command/fileChange/permissions/input/elicitation。写入原生 stdin 没有 ACK，先 unknown，等原生 resolution。[service:632–652](../../gateway/src/service.ts#L632-L652)、[interactions:7–12](../../gateway/src/interactions.ts#L7-L12) |
| 未知操作查询 | `GET /operations/:operationId` | OperationQueryResult；只查本设备，上传成功时可带 attachment。404 不证明原操作未执行。[server:157–161](../../gateway/src/server.ts#L157-L161) |
| 主机文件 / 成果浏览与选择 | `POST /projects/:projectId/files/query` FilesQuery；`.../files/select` FileSelectRequest | FilePage / FileGrant；路径是项目相对路径，select 可含 threadId，不产生 Codex 操作回执。[server:163–175](../../gateway/src/server.ts#L163-L175) |
| 成果预览 / 下载 / 系统打开 | `GET /files/:fileId/content` | 受认证二进制流；`Content-Digest` SHA-256、类型、长度、文件名须校验；main 再交系统保存/打开。无单独 artifacts API。[server:177–190](../../gateway/src/server.ts#L177-L190) |
| 图片 / 文档附件上传、移除 | `POST /threads/:threadId/attachments`；`DELETE /attachments/:attachmentId` AttachmentDeleteRequest | 上传 `application/octet-stream`，`X-Oraculum-Upload` 为 base64url JSON AttachmentUploadMetadata，Content-Length 匹配；operationId / projectId / threadId / draftId 绑定。[server:192–208](../../gateway/src/server.ts#L192-L208)、[service:706–715](../../gateway/src/service.ts#L706-L715) |
| 额度 / 账户 token 活动 | `GET /account/rate-limits`；`GET /account/usage` | `account/rateLimits/read` 与 `account/usage/read` 两类不同事实；后者不是当前 thread token usage。[server:130–131](../../gateway/src/server.ts#L130-L131)、[native-reads:85–120](../../gateway/src/native-reads.ts#L85-L120) |
| MCP / Skills / Apps / Plugins | `GET /projects/:projectId/extensions` | ExtensionsSnapshot 的分区 available/unavailable / limited / reasonCode；无安装、启用或认证配置写接口。[service:342–354](../../gateway/src/service.ts#L342-L354)、[extensions:18–73](../../gateway/src/extensions.ts#L18-L73) |
| 流式消息 / 执行 / Plan / Diff / token | `WS /events`，认证后发送 EventResume | item.delta、item.started/completed；`turn/plan/updated`、`turn/diff/updated`、`thread/tokenUsage/updated` 等经 `native.state`。client 必须按已核验的 NativeStateEvent 分派，不能把任意 JSON 当权威状态。[service:221–236](../../gateway/src/service.ts#L221-L236)、[codex:47–51](../../gateway/src/codex.ts#L47-L51) |
| 子代理树 / 通知 | 父线程 history/item 中的 `collabAgentToolCall`，WS 原生 item/Turn/Interaction 事件 | 现有接口可派生可见子代理摘要与本地通知；没有旧 `bridge/agent` / `bridge/notifications` 的对应端点，受限部分见下文。 |

## 4. 重连、缓存与安全语义的实现约束

1. **身份与代次先于缓存。** 以 endpoint identity + installationId + deviceId 分区；epoch 变更使旧事件/游标/审批失效。认证撤销由每次活动重查生效，已有 WS 也会关闭；缓存只能继续只读展示已加载内容，不能解锁写入。[auth.ts:82–108](../../gateway/src/auth.ts#L82-L108)、[service.ts:130–148](../../gateway/src/service.ts#L130-L148)
2. **事件连续性。** WS 在 10 秒内只允许一次 resume，发送 `{type:'resume',epoch,afterSeq}`；服务返回 connection / headSeq / resetRequired，随后补发。seq 按设备独立；先应用事件或标记投影失效，再保存 seq。重复忽略、gap 请求回补、未知 informational 跳过、未知 state 触发重同步。[server.ts:234–289](../../gateway/src/server.ts#L234-L289)、[events.ts:36–64,91–140](../../gateway/src/events.ts#L36-L140)、[reconcile.ts:11–23](../../gateway/src/reconcile.ts#L11-L23)
3. **快照不是 native watermark。** Snapshot 最新 5 Turn、interactions 和最多 100 条本设备相关 operations；observedStartSeq / observedEndSeq 只描述 Gateway 观察窗口，不能据此断言之前的 delta 已全部包含在快照。baseline 与临时 stream 分开，不能恢复后盲拼 delta。synchronizing 时补读需合并、退避，不能启动紧循环。[service.ts:687–704](../../gateway/src/service.ts#L687-L704)、[events.ts:77–88](../../gateway/src/events.ts#L77-L88)、[reconcile.ts:26–92](../../gateway/src/reconcile.ts#L26-L92)
4. **历史 revision 是 opaque string。** 同 revision 刷新保留已加载旧页与阅读锚点；新 revision / HISTORY_STALE / cursor reset 才重建相关投影。lease 到期要求验证，不代表内容已经变化；cursor 绑定 scope/thread/turn/revision/pageSize 且有 TTL。`complete:false` / `truncated:true` 是显示不完整，不等于执行未知。itemTimings 只用原生 producer 时间，缺失不以接收时间伪造。[history.ts:9–17,120–121,158–175,234–254,300–317](../../gateway/src/history.ts#L9-L317)、[service.ts:658–671](../../gateway/src/service.ts#L658-L671)
5. **写操作不提供幂等重发。** main 发送前先持久化 operationId / scope / 意图；Gateway reserve 后才 dispatch，重复 ID 返回 OPERATION_ALREADY_RECORDED。断线、超时、崩溃后逐项 GET 原 ID 对账，不换 ID 自动发送。Snapshot operations 不是完整账本。OPERATION_NOT_FOUND 不能清除 unknown。[service.ts:441–493,697–699](../../gateway/src/service.ts#L441-L699)、[server.ts:157–161](../../gateway/src/server.ts#L157-L161)
6. **不要扩大阻断。** Gateway 默认按项目/线程 unknown scope 拦截，interrupt 和 interaction.response 等有明确 `allowUnknown` 安全例外；UI 不能把一个线程未知扩大为所有项目禁用，也不能把例外理解为重发未知写入的许可。[service.ts:450–452,554–565,632–651](../../gateway/src/service.ts#L450-L651)
7. **权限事实与用户选择分层。** permissionReadback 仅为匹配 epoch 的 thread.start/resume 原生回读；startTurn 会清除旧确认。默认配置、待发送 preset 或持久缓存均不能宣称“当前已生效”。审批使用当前 generation/epoch；旧按钮只读，用户明确点击也须经 main 再校验。[permission-readback.ts:8–21](../../gateway/src/permission-readback.ts#L8-L21)、[service.ts:500–525,545–547,632–651](../../gateway/src/service.ts#L500-L651)
8. **文件授权不可旁路。** FileGrant 是短时本设备授权身份，不是 bearer URL；主机读取由 Gateway 执行路径/符号链接/硬链接/文件版本校验。Desktop 本地选择只用于显式上传，不能因与 Gateway 同主机就用 Node 直接读项目代替文件 API。[files.ts:29–45,68–96](../../gateway/src/files.ts#L29-L96)

## 5. 真实缺口与受限能力

以下是当前源码事实，**本轮不修 Gateway、不增加协议，也不声称 Beta 3 在线行为已经实测**。正式联调发现额外缺口时，记录最小 fixture / 期望 / 实际 / 版本，再单独请求后端处理。

| 差异 / 缺口 | Desktop 可执行的降级与后续出口 |
| --- | --- |
| `HistoryQuery.limit` Schema 接受 1–100，但实现最多 20，默认 5（[schema:1198–1202](../../packages/gateway-protocol/schema/v2.json#L1198-L1202)、[history:347–349](../../gateway/src/history.ts#L347-L349)）。 | Desktop 使用默认 5、上限 20；记录契约不一致，P4.0 不改 schema 或运行服务。 |
| `knownEpoch / knownRevision` 虽在 SnapshotRequest 中，server 仅传 projectId（[schema:1293–1312](../../packages/gateway-protocol/schema/v2.json#L1293-L1312)、[server:155](../../gateway/src/server.ts#L155)）。 | 不依赖 304、条件快照或“只返回变化”；在客户端按 revision 合并，网络请求仍是真实完整组合读取。 |
| OperationReceipt 的 `delivery` 是 Schema 可选字段；当前公共 receipt 投影不填它（[service:30–31](../../gateway/src/service.ts#L30-L31)）。 | 缺省不解释为 notSent；unknown/404继续对账。有效 rejected 回执可结束原提交，由用户显式发起新意图，不额外等待永不出现的 delivery 字段。 |
| `GET /models` 仅转发首 100 项，无 cursor 输入（[server:128](../../gateway/src/server.ts#L128)）。 | 如 nextCursor 非空显示“目录未完整加载”，不虚构“加载更多”成功；另记 API 扩展建议。 |
| `classifyEvent` 的已知 payload 映射不含 `native.state`（[index:45–60](../../packages/gateway-protocol/src/index.ts#L45-L60)），但 Gateway 实际发送它。 | 在 Desktop main 先用已存在的 NativeStateEvent 契约和有限 native method 映射处理；未知/不兼容 state 仍失效重读，不直接将 JSON 注入 store。 |
| Gateway 无 `review/start`、Plan Mode 或自动标题接口；capabilities 明确 plan.mode / thread.name.auto 为 unsupported（[codex:40–46](../../gateway/src/codex.ts#L40-L46)、[service:281](../../gateway/src/service.ts#L281)）。 | 保留原生 Plan 输出/更新、手动改名；不把旧 Review 按钮或 Plan Mode 伪装成可用，也不自行调用 experimental API。受限项交用户审阅接受或独立研究。 |
| 没有授权的子代理详情/独立会话浏览端点；列表主动排除 subAgent sourceKinds（[codex:264–283](../../gateway/src/codex.ts#L264-L283)）。 | 父线程 collab item 可形成摘要树，缺少的详情明确说明；不能借任意 threadId 或全主机原生目录扫描绕过授权。完整旧 `bridge/agent` 能力列入后续协议讨论。 |
| 没有持久 thread token usage 查询；WS thread/tokenUsage/updated 只在被观察到后转发。Snapshot 不含独立 token usage（[service:234–236,687–704](../../gateway/src/service.ts#L234-L704)）。 | 本设备已观察的用量可缓存并标记时间；首次/冷启动无数据为“尚未报告”，不用 account usage 代填。另列可靠补读 API 建议。 |
| 无独立通知 feed / 后台推送 API。 | Desktop 运行期间从当前授权 WS 事实生成本地通知并去重、点击回查；关闭窗口后应用退出，无持续提醒承诺。离线期间未观察的提醒不能伪造补发成功。 |
| Plugins catalog 在 Gateway 固定 `STABILITY_UNVERIFIED`；MCP `toolsAndAuthOnly` 不查询 resources，返回 limited（[extensions:18–21,49–73](../../gateway/src/extensions.ts#L18-L73)）。 | 保留对应分区和可理解的受限说明；空数组不显示“没有插件/资源”，不提供配置写入口。MCP HTTP 连接超时留量为30秒（[server:34–36](../../gateway/src/server.ts#L34-L36)），客户端查询预算不能小于已批准的有界发现预算。 |
| Gateway 对若干 item 增量/工具进度没有逐一投影为专用事件（仅[service:221–236](../../gateway/src/service.ts#L221-L236)中的有限分派）。 | 以 completed item / 原生历史校正为准；不承诺旧 UI 所有实时细粒度效果等价。P4.2 fixture 覆盖这些边界，缺失影响若阻碍核心使用再独立讨论。 |

## 6. P4.0 交付判定

已完成的只是源码与契约映射。本文支持后续按核心能力分步实现，不能替代 Electron sandbox、真实 IPC、HTTP/WS、文件下载、原生审批、Wayland 或视觉验收。后续验证计划见同目录实施计划；P4.0 审阅前不启动正式客户端开发。
