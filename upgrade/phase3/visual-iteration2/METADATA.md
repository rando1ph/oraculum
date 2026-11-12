# Iteration 2｜原生消息时间与用量投影

本轮只扩展显示所需的原生字段，不增加执行接口、账户查询或独立会话权威。源依据为本仓旧版 `apps/web/src/process.tsx`、`bridge/src/usage.ts`，现有 Gateway `codex.ts` 的稳定通知白名单，以及本机官方 Codex 生成类型 `Turn`、`ThreadItemEntry`、`ItemStartedNotification`、`ItemCompletedNotification`、`ThreadTokenUsageUpdatedNotification`。生成类型仅证明字段形状；实际真机数据是否返回另由联调记录证明。

| 显示事实 | 原生来源与单位 | 当前实现与缺失处理 |
| --- | --- | --- |
| 消息时间 | `thread/items/list` 的 Item envelope：`startedAtMs` / `completedAtMs`；或 `item/started` / `item/completed` 对应字段，均为 Unix 毫秒 | Gateway 在 `HistoryPage.itemTimings` 中按原生 Item ID 转发，事件也保留同名字段；用户消息优先开始时间，其余消息优先完成时间。`thread/read` 回退没有 Item 时间时保持未知，不拿 Turn 时间或本机接收时间冒充 |
| 整轮开始、完成和耗时 | Turn `startedAt` / `completedAt` 为 Unix 秒，`durationMs` 为毫秒 | 优先已完成 Turn 的原生 `durationMs`；缺失时只在真实起止时间齐备且顺序有效时求差。执行中不凭本机时钟制造完成耗时 |
| 最近用量 | `thread/tokenUsage/updated` 的 `tokenUsage.last`，绑定事件的原生 `turnId` | 提供最近原生用量，不把它叫整轮累计。多次工具执行可能有多个模型响应，客户端不累加或猜测 Turn 总量 |
| 会话累计用量 | 同事件 `tokenUsage.total` | 输入、输出、缓存输入、推理输出等字段各自可空；不把缺失写作零，不推算账户余额或费用 |
| 上下文比例 | `tokenUsage.last.totalTokens` 与 `modelContextWindow` | 只有真实有效分子分母才可显示；不能用会话累计总数除以上下文窗口 |
| 缓存比例 | 同一组计数的 `cachedInputTokens` 与 `inputTokens` | 分母大于零且缓存数不超过输入数时才有意义；不能拿输出或总 Token 作为缓存命中分母 |
| 执行过程折叠 | 原生 Turn 状态、`agentMessage.phase`、具体工具失败事实 | 仅 `commentary` 被当作助手过程消息；未知 phase 和最终答复保持可见。失败命令、工具错误等仍可提示关注 |

所有计数和时间都校验数值类型、整数范围和单位；拒绝负数、字符串计数、溢出、非整数及无效时间。已有原生事实可以随可重建缓存恢复，但仍以同一原生 ID 关联，绝不赋给新 Turn/Item。缓存恢复不能建立活动 Turn 或授权写入。切换线程仍使用现有投影隔离边界。

新增字段均为可选加法，旧客户端可忽略，新客户端可读取旧 Gateway 的缺省响应；不改变协议版本、设备认证、operationId、unknown 回执或审批边界。Gateway 仍只转发支持的方法，未读取 Codex 私有会话文件来补造 API 未公开的用量。

自动验证包含原生时间单位、缺失回退、错配/截断事件拒绝、同 ID 缓存恢复、换 Turn 隔离、真实失败保留、Gateway 分页时间透传和无时间回退，以及 TypeScript / Kotlin 协议往返。实际通过结果与真机返回字段见本轮交付报告。

独立审阅补充：Inspector 的计数与聊天摘要使用相同的原生 Turn 范围。当当前权威历史替换后不再包含用量所属 Turn 时，同时清除图表结构和文字摘要；追加旧分页、读取 Item 分页或保留同一 Turn 的刷新不会清除已观察值。缺少原生 `turnId` 的用量事件/缓存不接受。对比测试在隔离 Kotlin/JUnit 目录中移除清除逻辑后出现 2 项旧计数残留失败，恢复当前实现后 10/10 元信息测试通过；未触碰设备或共享 Gradle 输出。完整 Android 构建与系统旅程仍由主实施者统一验证。
