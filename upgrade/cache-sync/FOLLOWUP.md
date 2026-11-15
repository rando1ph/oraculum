# 分页窗口修正与一加 6T 验证

2026-11-16；基线 `de4d894476975e58fd307dcee27fd04058506a13`。仍在现有 main 开发，更新原 Notion Task，不创建重复任务。没有部署或重启正式 Gateway，没有发布正式 APK。

实现提交：[Gateway 9d36a7e](https://github.com/rando1ph/oraculum/commit/9d36a7e)、[Android 94763c3](https://github.com/rando1ph/oraculum/commit/94763c3)。

## 根因与小范围修复

1. `refreshThreads` 先提交首屏，后续读取只为寻找当前会话；当前会话已经在首屏时，其他已加载页被丢掉。活动/归档列表现在分别保存已加载页数，从新根游标按原生顺序重建该窗口，所有读取成功且 scope/generation/失效 ticket 仍匹配时一次提交。新增、删除、归档均以新窗口为准，不拼接旧行；保持原有 selected 成员核验及新建会话特例。Room 的 `_loadedPages` 只是本地元数据，不进入 Gateway 请求。
2. 30 秒租约原先无条件旋转 `historyRevision`。现在到期只触发内容验证：完整读取后备顺带摘要原有全历史；原生分页重验有界已观察页和详情。内容相同保留 revision、分页与详情 cursor；内容变化或确证原生位置失效才重建。网络/超时不清旧窗口、不续租，保持只读恢复。
3. 真机进一步复现了纯单测未覆盖的问题：并行 Item 请求的完成次序改变 `itemTimings` 字典插入顺序，普通 JSON 序列化摘要将它误判为内容变化。摘要现在递归规范对象键顺序，保留数组顺序、所有时间值和正文事实。修复前确定性并发回归先失败；修复后真实原生连续 8 次、跨租约读取只有一个 revision，原始历史和展示内容均无差异。数组顺序或时间值实际变化仍失效。
4. 稳定历史窗口刷新直接保留当前内存阅读锚点，不再用尚未落盘或较旧的 Room 锚点覆盖它。真正的新窗口仍恢复持久锚点。

没有增加协议字段、数据库 schema、依赖或缓存框架；权限、审批、unknown 对账和草稿分库路径未改。

## 回归与性能

- 全仓 Vitest：80 文件、1088 测试通过；历史测试 35 项。Android JVM 32 组、237 项通过，0 failures/errors/skips；Debug assemble、test APK 编译、lint、TypeScript 与 diff 检查通过。
- 列表回归覆盖首屏 selected、无 selected、多页删除/归档/新增、原生顺序、失败/事件中断不提交半窗口、单页无额外读取及 12 页窗口不被原 10 页成员搜索上限截断。
- 历史回归覆盖未变续租、旧页或截断预览之外的外部修改、详情 cursor、位置失效恢复、读取预算、并发失效与字典键顺序。

同一认证 HTTP/Service/临时 SQLite 夹具，与上轮源码比较，固定 10ms/RPC：

| 场景 | 上轮 RPC → 本轮 RPC | 上轮总耗时 → 本轮总耗时 |
|---|---:|---:|
| 10 次 Snapshot | 16 → 16 | 228.05 → 208.17ms |
| 10 次相同列表 | 1 → 1 | 47.68 → 42.77ms |
| 两个并发 Snapshot | 7 → 7 | 61.49 → 61.43ms |
| 失效后 Snapshot | 7 → 7 | 60.20 → 61.61ms |
| 10 次 fallback Snapshot | 12 → 12 | 182.24 → 182.69ms |

单独历史热页 10 次仍为 6 RPC（42.46 → 43.36ms）。这些是合成测量，耗时含机器噪声，不能推导真机/公网时延；原有热路径请求减少没有回退。重读已加载列表窗口按页数产生必要的校正读取。

原生分页的长窗口验证有明确成本：20 页、每页 5 Turn、10ms/RPC 的夹具为 120 RPC / 约 819ms，仍在原有 12 秒准入预算内；超时不会把旧窗口当成新状态。full-read 后备搭便车摘要不增加 RPC。是否支持原生分页还取决于具体线程存储，本轮真机新线程实际使用 `native-pagination`，不能把此前另一些线程的 unsupported 响应泛化为所有会话。

复现：

```sh
pnpm test
pnpm check
bash scripts/android-build.sh :app:testDebugUnitTest
pnpm exec tsx scripts/gateway-sync-benchmark.ts --baseline de4d894476975e58fd307dcee27fd04058506a13 --output .local/evidence/cache-sync-followup/performance-final.json
pnpm exec tsx scripts/gateway-history-benchmark.ts --baseline de4d894476975e58fd307dcee27fd04058506a13
```

## 真机与证据边界

使用实际一加 6T / ONEPLUS A6013、Android 15/API 35。通过仅本地 Gradle init 配置构建独立 `dev.oraculum.poc.debug.cachesync` 与 test APK，临时 CA 只进入该 Debug 构建；原 Debug 包未覆盖，其私有数据先备份。设备通过 ADB reverse 访问专用回环 TLS/WSS、全新 SQLite 和官方 Codex 0.169.0，正式 Gateway 不参与。

新增 opt-in 测试和夹具：

- [CacheSyncJourneyTest.kt](../../apps/android/app/src/androidTest/java/dev/oraculum/poc/e2e/CacheSyncJourneyTest.kt)
- [cache-sync-device-fixture.ts](../../scripts/cache-sync-device-fixture.ts)

夹具创建 8 个简短真实 Turn（含一个 18KiB 输入用于完整详情）、45 个原生 fork，共 46 会话。真机已直接验证跨 38 秒自动刷新保留多页列表、16 条历史、revision、阅读锚点/偏移和完整详情；会话切换保草稿，断线保只读缓存且无业务重放；第二官方 App Server 的新增/归档/删除/重命名后，活动列表由 46 变成 45 并保持原生顺序。

真实 CLI 写入曾因测试控制请求的 15 秒 idle timeout 丢 ACK；原生历史与夹具 status 均确认原写入完成，未重发。测试夹具现只对认证控制 socket 延长超时，并私存有界诊断；测试在派发前持久化 intent，丢 ACK 或进程重启只查询原结果。生产 Gateway 的超时与写入语义未改。

最终安全续跑为 `OK (1 test)`，实际再验证 45 会话、2 页/18 条历史，以及真实 CLI 与 ACP marker 自动可见；记录复用已确认的外部目录/CLI 操作，没有重复派发。夹具最终计数为 CLI 1 次、ACP 1 次、外部目录变更 4 次、连接切断 2 次；Android 业务写入 0 次。4 张真机原图与各阶段 JSON 保存在 `.local/evidence/cache-sync-followup/`，正式 Codex 配置哈希不变，隔离实例正常关闭，无清理错误。

原 Debug 身份密文逐字节一致，草稿和操作记录的身份/状态/内容保留；仅一条既有操作的后台查询 `updatedAt` 发生变化，未回滚该正常观察。临时测试包和 ADB reverse 已移除，USB 保亮恢复为原值 0，设备锁屏后确认物理显示与 committed state 均为 OFF。原正式 Gateway PID 与启动时间保持不变。原始 JSON、PNG、构建产物、配对码和控制 nonce 不提交 Git。

## 保留的边界

- 本轮严格保页的是同一在线会话内容未变的自动校正；切回会话及断线重连仍执行既有新鲜 Snapshot 校正，不声称完整旧分页窗口跨重连不变。
- 长期断线、OEM 后台/蜂窝、正式公网与超大历史不因本轮 ADB/TLS 验收而视为通过。
- 实测 Debug 构建来源为开发工作树候选；实现源码随后以独立提交保存，没有用该测试包覆盖任何正式 Release 资产。
