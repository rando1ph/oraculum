# Gateway 原生能力交付记录

2026-11-14，源码提交 `a55a128fdf32b3f6999a9cc9574be087facc855b`，官方 Codex CLI `0.169.0`。

依据 [OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)、[原生权限说明](https://learn.chatgpt.com/docs/permissions)及本机生成的默认协议核对。运行时始终 `experimentalApi:false`，执行、工具、模型与上下文管理均由官方 App Server 完成。

## 已交付

- 原生会话命名、归档、恢复、确认永久删除、分叉与按 `beforeTurnId` 撤回历史。
- 同一活动 Turn 的插话与现有停止入口；手动压缩由原生事件报告完成。
- 省略覆盖时继承模型、思考强度及权限；只读项目配置与实际会话读回分别表达，不用模型目录推荐值替代当前事实。
- `ultra` 及未来目录支持的强度：HTTP Schema／生成 DTO／适配器使用有界字符串，服务按实际选定模型校验。
- 脱敏账户额度窗口、重置时间、累计 token 与按日用量；缺失事实保留 null，不返回账户身份和原始配置。
- MCP 轻量发现与有界超时，Skills／Apps 独立返回；未请求资源时省略资源数量并标记不完整。

契约见 [共享协议](../packages/gateway-protocol/README.md)。变更仅涉及 Gateway 及共享协议，未修改 Android 应用或已发布 Beta 1 资产。

归档／删除采用旧 Bridge 的有界原生全来源、普通及归档元数据预检，检查子会话依赖，并在写入前再次读取原生状态、授权和通知版本。正常根会话已实测可用；有依赖、活动执行、待处理审批或不完整盘点时拒绝该次请求。删除必须 `confirm:true`。原生未提供原子性的项目级联约束，预检不冒充该保证；不会改写官方会话文件来替代接口。

所有写操作仍保存 operationId／回执并遵守 unknown 屏障；超时、断线或响应不符不重发，列表缺失不证明删除成功。撤回历史不撤销工作区文件，旧存储不支持时保留原生拒绝。

## 验证

- `pnpm test`：77 个文件，1025/1025 通过。
- `pnpm check` 通过。
- `pnpm verify:gateway:protocol`：生成文件逐字节一致；TypeScript/Ajv 101 组往返、37 组无效输入拒绝；Kotlin 85 DTO 根、101 组往返通过。
- Gateway main／CLI 的 Node 24 ESM 打包与语法检查通过；未构建或发布新 DEB/APK。
- [真实原生探针](test/native-capabilities-live.ts)在上述提交上重跑，13/13 通过：有效配置、账户额度、累计用量、扩展、默认继承、ultra 推理与流式、命名、归档／归档列表／恢复／resume、同 Turn 插话／停止、压缩触发及完成、分叉、持久历史撤回、测试会话永久删除。
- 该轮扩展读取约 3.17 秒：Skills 84、MCP 9、Apps 22 均可用；MCP 标记 `MCP_RESOURCES_NOT_REQUESTED`，Plugins 保持 `STABILITY_UNVERIFIED`。计数为测试时观察，并非产品常量。
- 实测使用全新配置、状态、项目和随机回环 HTTP/WebSocket 端口；不能代替公网 HTTPS/WSS、Android 接入或正式部署验收。模型／权限继承的读回使用真实主机设置，推理测试显式使用只读权限且不调用工具。
- Codex 配置哈希前后相同，原生进程已关闭；仅测试创建的两个会话经原生接口删除，无遗留测试会话。既有 Gateway 服务持续运行，未替换安装或重启；原有 Android／Stitch 未跟踪文件逐字节保护。

## 自动命名的明确限制

本机默认及 experimental 生成协议均只有需要显式名称的 `thread/name/set`，没有稳定的原生自动标题生成 RPC；官方文档也未提供可调用的自动标题生成入口。隔离真实首轮结束后再等待两秒，`name` 仍为空，仅 preview 填充，未收到 `thread/name/updated`。

CLI 二进制的 TUI 标题生成模块与独立标题线程提示仅说明 CLI 可能另有客户端协调机制，不能据此声明 App Server 提供了相同接口。本轮不加入额外标题生成线程、模型任务调度或本地标题猜测；能力明确返回 `thread.name.auto=false`、`NATIVE_AUTO_TITLE_UNAVAILABLE`。手动命名和外部原生名称更新的事件／读取链路均有测试。后续官方提供稳定入口时再接入。

Plan 模式、未验证的 Plugin 能力与原生配置写入继续保留原有边界。Android 若显式传入只读或其他设置，仍按该覆盖执行；客户端继承入口及 ultra 解禁属于后续 Android 工作。

Notion Task 保持 **In progress**，由用户审阅后决定是否 Done。
