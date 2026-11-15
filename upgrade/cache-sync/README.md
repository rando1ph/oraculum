# Gateway / Android 缓存、Snapshot 与同步优化

2026-11-16。基线：`f8a11b6992f555d2b7003b13bd092f931afd0b0b`。仅在现有 main 开发；没有部署正式 Gateway、安装客户端或签名/发布 APK。正典仍为 [Oraculum 2.0 项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。

实施提交：[Gateway b897a3c](https://github.com/rando1ph/oraculum/commit/b897a3c)、[Android 8b44df2](https://github.com/rando1ph/oraculum/commit/8b44df2)。

后续分页修正与一加 6T 验收见 [FOLLOWUP.md](FOLLOWUP.md)。以下性能表保留首轮测量；租约和列表窗口行为以本轮修正为准。

## 已确认的瓶颈

| 原有链路 | 实际开销或风险 | 本次处理 |
|---|---|---|
| Snapshot → requireThread → historyPage → requireThread | 每次重复两次元数据 RPC | 同一 Snapshot 复用已校验的会话元数据 |
| 历史分页只有 cursor/revision，没有展示页缓存 | 重复首屏反复读取 Turn 和每个 Turn 的 Item | 有界投影缓存及同请求合并 |
| 5 个 Turn 的 Item 读取串行 | 冷页等待 6 个串行 RPC | 每个已准入请求最多 2 路 Item 读取 |
| 重复项目会话列表查询 | 原生扫描会话目录，重复原生分页 | 5 秒列表缓存，命中仍校验项目和设备 |
| 回前台总是执行完整刷新链 | 重读项目、会话、Snapshot、默认配置及账户 | 按过期/失效范围自动校正，手动刷新保留强制语义 |
| 每次 delta 都安排 300ms Snapshot | 流式稍停就重读；新事件还会取消在途读 | 合并任务，流式有界校正，终态优先 |
| Snapshot 总是删线程缓存并重置分页 | 已加载历史丢失，翻页重复请求 | 同 epoch/revision 且根页相同才保留窗口 |
| 重连总是请求新事件基线 | 没有复用同进程已处理的连续游标 | 同进程恢复游标，仍执行回执及 Snapshot 校正 |
| 普通 thread/list 依赖原生默认来源过滤 | 其他原生客户端保存的普通会话可能漏列 | 显式包含 CLI、IDE、exec、App Server、unknown 来源 |

## Gateway

实现位于 [service.ts](../../gateway/src/service.ts)、[history.ts](../../gateway/src/history.ts)、[read-cache.ts](../../gateway/src/read-cache.ts)。未引入新依赖、数据库表或历史权威副本。

官方接口文档明确区分了只读 metadata/history 和会话恢复/事件订阅；读取一个保存的会话不能证明其他客户端的后续变化都会通过当前连接通知。因此本方案同时采用事件失效与有界重新读取，不新增 ACP 通信。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

- 列表缓存上限 128 条 / 4 MiB；历史投影缓存上限 128 条 / 8 MiB，TTL 均为 5 秒。历史缓存只保存经过大小限制的展示页和分页位置描述；每次返回重新签发绑定设备/项目/查询的 opaque cursor。
- 原生会话元数据不跨时间缓存。只合并同时进行的只读请求；每个调用者独立执行前后认证、项目 inode/canonical path 与 epoch 校验。所有写入和生命周期 inventory 仍读取新鲜原生事实。
- Snapshot 不缓存 interactions、operations、事件序号或完整响应。活动 Turn、待审批和返回的 inProgress 历史强制读取新鲜页；详情每块仍重新读取并校验摘要。
- 原生通知到达即失效相关缓存，不等待异步事件投影队列；本地写派发前后均失效，包括 unknown 结果。失效后的晚到请求不能回填或冒充当前结果。
- 未识别线程的相关事件保守失效列表；列表中已验证 cwd 的线程会记入事件归属。未知原生正文仍不向客户端广播。
- 历史页缓存键覆盖 scope、thread、revision、查询种类、页大小和原生位置。授权失败、原生错误、超时与协议错误不缓存。不同查询超出读取容量时拒绝，不无限排队；并行任务失败也等待已发请求结束再释放容量。
- `historyRevision` 仍是 Gateway 投影失效标识，不是原生提交版本。30 秒租约到期触发内容验证，内容未变保持 revision、分页和详情游标。完整读取后备顺带校验全历史摘要；原生分页校验有界的已观察页/详情摘要，内容变化或确证旧位置失效才使旧窗口失效。

## Android

实现位于 [PocViewModel.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/PocViewModel.kt) 及 repository 同步策略。保留现有 Compose 界面与 Room / durable state 分库。

- 在线切换项目也先展示本机缓存；相同选择快速返回。Snapshot 校正前仍先对账 unknown；缓存新鲜度绝不直接解锁发送或审批。
- 自动列表校正从新根游标重读已加载的页数，全部成功后一次提交；保持 Gateway 页内和页间顺序，不拼接旧行。活动及归档列表分别记录分页深度。
- 导航和只读 Snapshot 使用独立失效/新鲜度记录；前台每 5 秒检查 30 秒新鲜度，只对过期/失效范围发请求，通常在 35 秒内开始校正未被本连接事件覆盖的外部变化，另加排队与读取时间。手动刷新、写前同步和重连完整校正保留。
- 原生默认设置采用 60 秒、账户数据采用 300 秒独立校正间隔；外部配置变化不会在同一长连接下永久滞留。可选读取失败保留可见错误并退避，手动刷新仍立即读取。
- 流式事件直接更新投影并撤销写许可；自动 Snapshot 合并为 5 秒调度，完成/关键失效用 300ms 调度。后来的普通事件不推迟已预约的更早读取，不取消正在执行的请求。
- 同 scope、epoch、revision、根页内容和完整性均一致，且未发生破坏性失效时，保留已加载终态旧页和分页进度；新 epoch/revision、gap、回退或压缩仍替换窗口。
- 同进程的事件恢复点只来自已经处理完成的连续事件；非 reset 连接从请求游标接续，reset 才从连接 head 建立基线。进程重启不信任只保存了单线程投影的全设备持久游标。
- `project.changed` 即使发生在其他项目或当前没有项目选择，也会校正项目列表。附件绑定只在实际 scope/online/capabilities 等变化时更新；移除 ViewModel 重复心跳，保留传输层心跳。

## 性能测量

相同夹具分别加载旧源码与当前源码；通过 `git show` 读取基线，没有 checkout、分支或 worktree。固定原生 RPC 延迟 10ms，认证 Fastify HTTP → Service → 临时 SQLite，5 个 Turn；每个场景使用独立夹具。所有返回内容等价，事件失效后另断言读取到新内容。

| 场景 | 原生 RPC 前 → 后 | 总耗时前 → 后 |
|---|---:|---:|
| 连续 10 次 Snapshot | 80 → 16（减少 80%） | 945.03 → 215.61ms |
| 连续 10 次相同会话列表 | 10 → 1（减少 90%） | 154.57 → 51.93ms |
| 两个并发相同 Snapshot | 16 → 7 | 95.22 → 62.15ms |
| 事件失效后 Snapshot | 8 → 7 | 90.89 → 61.00ms |
| 不支持原生分页时连续 10 次 Snapshot | 40 → 12（减少 70%） | 517.64 → 188.26ms |

Snapshot 热读均值 92.55 → 16.77ms；p50 92.54 → 16.91ms。单独历史投影基准：10 次首屏 60 → 6 RPC，614.49 → 43ms 左右；冷首屏仍为 6 RPC，65.10 → 45.87ms。

上述是本机合成测量，耗时随机器负载波动；不能推导真机、公网或生产 Codex 的同等提升。请求数量是同夹具下的实测值；热读在 TTL 内，冷读与失效读单列。

复现：

```sh
pnpm exec tsx scripts/gateway-sync-benchmark.ts --baseline f8a11b6992f555d2b7003b13bd092f931afd0b0b --output .local/evidence/cache-sync/comparison.json
pnpm exec tsx scripts/gateway-history-benchmark.ts
pnpm test
pnpm check
pnpm test:gateway:live
bash scripts/android-build.sh :app:testDebugUnitTest
```

## 验证与后续事项

- 全仓 TypeScript/Vitest：80 文件、1077 测试通过；`pnpm check`、`git diff --check` 通过。新增回归覆盖缓存容量、TTL、跨设备/项目授权、撤销和路径替换、cursor、并发合并、失效晚到、强制新鲜读取及外部历史校正。
- 官方 Codex CLI 0.169.0 隔离 HTTPS/WSS：9 组通过，包括流式与历史一致、11 条迟到 delta 收敛、回补、原生负向审批、unknown 回执、附件、重启/epoch 和撤销。原 Codex config 哈希未变，测试实例清理无错误；专用原生测试线程按原测试流程保留。
- Android JVM：32 组、230 测试，失败/错误/跳过均为 0；Debug assemble 与 lintDebug 通过。TLS/WSS 回归验证 requested seq=5、head=8 时 seq=6 被实际接收，后续 gap 仍拒绝。虚拟时钟的 12 次每秒 delta 加终态场景，Snapshot 调度读取 13 → 3 次（减少 76.9%）；10 次短间隔自动导航观察仅 1 次读取。这些是调度/策略测量，不是真机端到端时延。
- 未安装 APK，未进行真机/OEM 后台、蜂窝或公网性能验收。默认系统 Java 25 运行 Gradle wrapper 的尝试失败于缺少 javac；最终使用仓库现有 `android-build.sh` 的 JDK 21 / Gradle 8.13 工具链完成验证，未修改共享工具链配置。
- 当前真实原生版本仍返回 `thread/turns/list` 不支持，保留已识别、有界的 full-read fallback。未命中的旧页仍可能完整读取原生线程；没有解析 rollout 文件或引入未经批准的实验 API。
- 内容变化、原生位置失效或观察预算淘汰会使旧分页/详情 cursor 失效，需要重新加载；单纯时间到期不再使旧页失效。外部未通知的数据只承诺下次成功校正收敛，不承诺跨客户端即时同步。
- 冷进程仍完整建立事件基线；持久化多 scope 失效证据、长期断线增量恢复、生产网络和真实长历史性能留后续验证。审批/活动历史有意绕过热缓存，不按已完成历史的热读指标承诺性能。
- 本次未触及签名材料、发布标签、Release assets、正式 Gateway 服务或生产网络配置。Notion Task 保持 In progress，等待用户审阅。
