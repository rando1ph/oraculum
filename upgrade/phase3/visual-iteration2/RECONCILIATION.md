# Iteration 2｜对账阻断的独立复现与修复

依据：[正式任务 I2.3](https://app.notion.com/p/4165421e690b81308f13da32581c9e54)、[用户问题 001](https://docs.google.com/document/d/1Cwg-3mGpaIp5hGYczW0zVOERo0-Fn8M3oEV8pT6fBfQ/edit) 及上一轮人工体验记录。开发基线 `c1a78e52caf79144bda6aba3ef7d0de8da77b92a`。问题分为传输、派发事实、投影完整性及作用域；不能只凭“待确认”文案认定每次阻断都应解除。

## 1. 原始现场与本轮证据的区别

上一轮 Notion 人工体验记录已定位临时 HTTPS fixture：它对外透传上游 `Keep-Alive: timeout=72`，自身连接超时却是 5 秒；同一连接空闲 7 秒后的只读请求出现 BrokenPipe。该现场已通过仅作用于临时代理的 `Connection: close` 包装恢复。原 `thread.start` 在客户端留下 unknown，Gateway 查询不到回执；**缺少回执依然不足以证明业务写入未送达**。本轮不删除、重写或重发这项历史 unknown。

本轮一加 6T 开工检查中，现存独立 HTTPS 代理已有关闭 HTTP 连接的处理。主实施者实际点击新建：操作进行时短暂出现待确认提示，随后原回执 accepted、会话正常进入首条消息状态，Gateway 只增加一次 thread.start。该中间画面不算最终失败，也不把原历史传输故障重新归因于本轮 UI。

以下缺陷由本轮自动化独立复现；它们证明现有实现会产生额外阻断，但不能反推它们全部造成了用户最初那次 HTTPS 中断。

## 2. 可复现缺陷及最小修改

| 问题 | 原实现与复现 | 修改及保留边界 |
| --- | --- | --- |
| 明确未派发仍留下 unknown | ViewModel 在请求构造前保存 intent；GatewayClient 的 callback 在本机 JSON 大小校验前就声明可派发。128 KiB 以上请求被本机拒绝，服务器收到 0 次业务写入，callback 却已触发；过期认证失败也发生在业务入队前，而原 ViewModel 只处理特定生命周期异常 | callback 移到一次性业务请求实际入队前，且在认证、请求构建及本机校验之后。`dispatchWriteRequest` 只在该信号尚未发生时把**原 intent**记录为 rejected/notSent；使用 NonCancellable 完成持久化结算，再抛回原异常。信号发生后，丢回包、401/503、取消等仍为 unknown，不重发 |
| 无关会话事件让空闲会话反复“校正中” | Gateway snapshot 用整条设备事件流序号是否变化判断当前会话稳定性。在读取 A 历史时注入 B 会话、另一项目的真实原生形状事件，A 原生状态 idle、历史终态均不变，却返回 synchronizing；两个 HTTP 回归在基线失败 | 在已有有界事件保留区间内检查目标 project/thread 的变化。明确属于其他作用域的事件不干扰 A；相关项目、相关会话、全局事件、epoch 变化及事件区间丢失仍拒绝宣告 current。没有增加独立执行状态机或无界 revision 存储 |
| 超长工具输出使后续发送永久受阻 | 已完成 Turn 的一条输出超过 16 KiB，NativeHistory 对展示内容作有界投影，`truncated=true`；snapshot 把展示截断直接当作 stale，重复刷新仍不可发送。HTTP 回归在基线失败 | 原生适配器先校验 Thread/Turn 状态，NativeHistory 在文本和元数据投影之后保留原 Turn id/status；snapshot 的执行就绪使用这些原生事实及作用域稳定性。`truncated=true`、`complete=false`、详情入口与警告保持。inProgress 的长输出仍 synchronizing；文件变更审批仍独立拒绝截断证据 |
| 另一项目的 unknown 禁用导航新建 | 导航把整个设备 `unresolvedOperations.isEmpty()` 作为新建前置条件，比 ViewModel/Gateway 的项目作用域更宽；此前人工体验记录也明确记录这项行为 | 新建按钮使用 `canCreateThread`：在线、持久状态可用、具备能力、已选项目及该项目没有受影响 unknown。同项目任一会话 unknown 仍阻止项目级新建；未知项目注册仍全局保护。当前会话警告与其他作用域待确认信息分开 |
| 另一项目的项目级事件撤销当前首条消息许可 | Android 原判断只看 threadId；带另一 projectId、没有 threadId 的事件被当作当前会话事件，撤销快照及 FirstTurnPermit | 客户端同样按已声明 project/thread 选择作用域。缺失作用域仍视为全局；真正相关事件仍撤销许可。此修改不生成新的首条消息许可、不使已消费许可复活 |
| 已知未派发仍消耗首条消息许可 | 原顺序在 durable intent 保存后立即 consume，随后附件本机准备失败虽然被证明 notSent，首条消息仍不能显式再试；独立组合复现按此顺序得到失败 | 许可保留到实际入队 callback：再次核验原作用域、epoch、连接代次、校正版本、其它 unknown 与原生 idle，然后无挂起地 consume、标记派发。仅本机 body-size 拒绝不再被误判为断连。入队后丢回包仍消费许可；实际断连/重置仍丢弃许可。新建 accepted 候选也移到可选列表刷新之前记录，但仍需同代次的新鲜 idle 确证 |

主要实现：

- [GatewayClient.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/gateway/GatewayClient.kt)：严格的一次性请求及实际入队前 callback；现有 FilesController 的 notDispatched 判断也因此使用准确边界。
- [WritePreparation.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/repository/WritePreparation.kt)、[PocViewModel.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/PocViewModel.kt)：原 intent 的已知未派发结算、项目范围新建状态与事件作用域。
- [events.ts](../../../gateway/src/events.ts)、[service.ts](../../../gateway/src/service.ts)：有界事件窗口和 snapshot 的执行就绪判断。

## 3. 安全约束没有改变

1. 所有副作用操作仍在派发前持久保存 UUID，HTTP RequestBody 仍 one-shot，`retryOnConnectionFailure(false)` 保持；没有改为自动重试写请求。
2. 业务入队后不能凭网络异常、HTTP 状态、404 回执、原生当前 idle 或相似消息证明失败。原 unknown 继续保护受影响项目/会话，不清空、不换 UUID 绕过、不换设备身份绕过。
3. `blocksWrite`、Gateway `hasUnknownOperation`、设备认证/撤销、expectedEpoch、审批绑定及 Full access 边界未放宽。停止仍只能针对确证活动 Turn。
4. Snapshot 的 observedStartSeq / observedEndSeq 仍只是 Gateway 观察次序，不宣称是 Codex 原生水位线。事件窗口丢失时不能证明无变化，必须保持校正。
5. 展示内容截断只解除不必要的发送阻断，不能拿来批准文件修改。完整路径/Diff 的专门证据校验保留。

## 4. 测试证据

- Gateway 红灯：同设备的其他会话与其他项目事件两例，基线都返回 synchronizing；20,000 字节已完成输出一例，基线返回 stale。均先复现失败再修改。
- Gateway 绿灯：`pnpm exec vitest run gateway/src/events.test.ts gateway/src/server.test.ts gateway/src/history.test.ts gateway/src/codex.test.ts`，初次 **4 文件、81/81 通过**；消息元数据测试并入后本任务独立重跑 **83/83 通过**，日志 `.local/iteration2/reconciliation/gateway-regression.log`。`pnpm check`、`git diff --check` 通过。
- Gateway 新增反例覆盖：目标会话事件、项目级事件、全局事件、1,025 条事件导致保留窗口淘汰、epoch 重置、长输出仍在执行，以及读窗口检查不消费 WSS replay 的 reset 状态。
- Android 红灯：`GatewayClientTest.oversizedBusinessRequestFailsBeforeDispatchSignal`，**1/1 按预期失败**，证明本机拒绝时错误提前触发派发信号。私有日志 `.local/iteration2/reconciliation/baseline-dispatch.log`。
- Android 绿灯：`GatewayClientTest` 18 项、`WritePreparationTest` 5 项、`RecoveryRulesTest` 12 项，**35/35 通过，0 failure/error/skipped**；日志 `.local/iteration2/reconciliation/fixed-dispatch.log`。认证失败在业务入队前结算 notSent；丢回包仍 unknown 且服务器只见 1 次请求；取消发生在入队前后分别结算/保留；项目/会话作用域及未声明作用域保护。首次整合尝试曾遇并行 UI 编写未完成的编译错误，补齐后同一组测试通过，不把前次失败记作测试通过。最终全量 Android 执行结果与真机回归见本轮交付索引，未以纯单测代替真机联调。
- 首条许可补充复现：使用真实 `FirstTurnPermit` / `WritePreparation` 的旧调用顺序做独立 JVM 组合复现，**1/1 失败**，`baseline-first-turn.log`；新增 `FirstTurnDispatchTest` 6 例与已有许可/派发测试共 **15/15 通过**，`fixed-first-turn.log`。使用缓存 Kotlin 编译器和 JUnit、隔离输出目录执行，未与主实施者争用 Gradle；此组合证据不冒充真实 ViewModel/设备故障注入。最终集成构建由主实施者执行。

尚无法从历史有限记录确认原未知请求当时是否曾到达业务处理边界，因此历史 unknown 不能由本次改动回溯强制改成 notSent。首次消息许可仍要求已接受新建、同一连接代次及新鲜原生 idle 确证；断线/进程重启不复用旧许可。新建 accepted 后仅列表读取失败、连接仍有效时可保留候选；实际连接失败仍撤销它。无首条消息的原生会话在断线后也可能尚未进入活动列表。已接受回执保留，但本轮未新增持久化许可恢复或以当前 idle 倒推历史写入结果。此行为没有为了便利而放宽。


## 5. 一加 6T 本轮故障注入结果与限制

真机在既有配对和真实 Gateway/Codex 链路中上传一个专用文本附件，再显式发送一次。隔离 HTTPS 代理的故障控制在转发请求期间过早切断 WSS/连接；其业务请求计数仅增加 1，完整响应计数为 0，Gateway SQLite 中没有对应原操作回执。该注入未形成原计划的“Gateway 已 accepted、仅回包丢失”条件。

设备实际进入 unknown，原草稿、原操作 UUID 和 held 附件均保留；进程强制结束后重新启动仍不能发送或恢复执行。网络恢复后，查询不到原回执不能证明未执行，应用继续保护该会话。没有重复派发、替换 UUID、清空回执、删除 held 附件或人为补写 accepted/notSent。

`reconcileKnownReceipt` 因无法获得 accepted 回执而失败，不能记作真机恢复成功。已知回执结算的代码回归仍有 JVM/Gateway 测试证据；本轮**未完成该故障情景的真实 accepted 回执恢复证明**。按用户后续“以视觉美观为核心、不扩大检查”要求停止追加故障注入，将这一项留给独立审阅。新增测试 unknown 留在专用测试线程，继续阻止该线程写入及同项目新建；这不影响读取、设置和原图审阅。原有配对、原有回执及用户草稿另行进行保留核对。
