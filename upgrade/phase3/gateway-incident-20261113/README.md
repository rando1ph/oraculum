# Android 真机 Gateway 故障修复记录

任务：[Android 真机 Gateway 端到端连接故障](https://app.notion.com/p/4175421e690b8165abb9ce58ccbc813d)。日期：2026-11-13。任务保持 In progress，等待用户审阅。

## 根因及证据

正式 `oraculum-gateway.service` 未获得此主机访问 ChatGPT 所需的代理环境。Android 到 Gateway 的 HTTPS/WSS 连接成功，并不证明 Gateway 子进程中的官方 Codex 可以访问推理服务。

- Android 缓存、Gateway 原 operationId 回执和官方 Codex rollout 一致：原请求已 accepted，随后 Turn 因 `workspace routing discovery failed` 或 `workspace routing discovery timed out` 失败。accepted 是接收回执，不表示推理成功。
- 三个原生失败 Turn 的 Snapshot 均为 `current`，观察序号稳定；失败事实和错误内容已进入 Android 历史。没有证据支持通过放宽 epoch/seq 或 Snapshot 检查修复问题。
- 正式 Gateway 与子 Codex 均缺少全部八个大小写 proxy 环境变量。同机正常 Codex 具备这些变量；Adapter 本身按现有契约继承进程环境，没有过滤代理。
- 无认证 HTTPS 对照：官方 models 等请求直连约五秒超时、HTTP 000；沿既有代理则完成 TLS 校验、返回预期的 HTTP 401。探针没有读取或发送 token。候选 accounts/check 路径也得到相同对照，但未将其冒称为已捕获的完整 discovery URL。
- 隔离相同 Codex 0.169.0 和 Adapter，加入现有代理环境后，一条固定、无工具消息约十秒完成，收到八个 agentMessage delta，原生回读为 completed/idle，工具 Item 为零，全局 Codex 配置 SHA 未变。

接管时已存在一次由本轮之外操作触发的正式 Gateway 重启。首次截图显示原线程 `notLoaded`、历史 Turn 失败，没有再次捕获最初持续执行的警告画面。原故障依据原始日志、原回执、失败 Snapshot 和官方 rollout 交叉确认；不将重启后的现场冒称为原警告仍然复现。

## 最小修复与回滚

用户在本会话明确批准后，仅新增私有环境文件 `~/.config/oraculum-gateway/network.env` 及该服务的 `20-network-env.conf` drop-in，权限均为 0600；只对 `oraculum-gateway.service` 执行一次重启。两个文件的实际内容留在主机私有配置中，不提交私人代理地址。

变更前已只读备份 Gateway 配置和一致性 SQLite 数据库；部署前全部十四条回执均 accepted、unknown 为零。变更后服务 active、Gateway 和子 Codex 均回读到八个代理变量，公网 HTTPS health 为 200，Gateway 原配置 SHA 未变。

回滚：移除本次新增的环境文件和 drop-in，执行 user daemon-reload，再重启同一服务。不恢复或覆盖数据库，不删除身份、草稿或操作记录，不修改 VPS/Caddy/隧道或系统代理。

产品源码无需硬编码私人网络参数。本轮不修改视觉设计、官方执行权威、operationId、unknown 屏障、审批或 epoch/seq 规则。

## 真机与验收

USB 真机为 OnePlus A6013，LineageOS / Android 15 / API 35。保留原 Endpoint、配对、Keystore、草稿及全部原操作记录；不重新配对，不自动恢复或重发原请求。

原安装 Debug APK：2.0.0-beta.1 / code 5，sourceGit `bdecbf00a2b67726a011476b29534a418bf200cc`，sourceDirty=true，SHA-256 `99de26b68e7fda37b8a71ff43e0efe900a5ff0d6294ec239a6d6092897333a2b`。

### 实测结果

| 检查 | 结果 |
| --- | --- |
| Debug 构建 / 测试 APK / 签名 | 通过；原安装与新包使用相同 Debug 证书，`adb install -r` 成功 |
| JVM | 169/169，25 suites，0 failure/error/skipped |
| lint | 0 error / 21 warnings |
| 原配对只读链路诊断 | 1/1 通过，27.376 秒；HTTPS、认证、项目/会话列表、WSS、两次 Snapshot、十二条原回执均可读取 |
| 单次受控 E2E | 1/1 通过，66.936 秒，包含前置核验、刷新、切换和重连；仅在 TEST 项目新建一个线程并发送一条消息 |
| 原生执行 / 流式 | 八个真实 WSS delta，exact Turn completed，Thread idle，正确固定回复，无工具 Item |
| 状态协调 | WSS 连续性通过；最终 Snapshot current，observedStartSeq / observedEndSeq / client seq 均为 21 |
| 恢复 | 刷新、切回原会话再返回、断开只读历史、重连均通过；没有虚假执行态 |
| 数据保全 | credential 加密原字节 SHA 不变；四条原草稿全行保留，全部原操作身份/范围/状态/原生绑定保留；新增操作仅 thread.start、turn.start 两条 accepted，unknown=0 |
| 最终包回读 | 从已提交测试源码重新构建并覆盖安装；安装字节与归档 APK 相同；再次只读诊断通过，原成功 Turn 仍 completed/idle/current，无新增业务写入 |

原操作回执的正常读取会更新本地 receiptJson 和 updatedAt；保全断言保护原操作语义和身份，不将这些回读元数据的合法更新当成破坏。只读诊断的 success 表示采集成功；完整验收由 E2E 的连续性、epoch、current 和原生终态断言共同证明。

### 回归测试与安全运行方式

- [SavedGatewayDiagnosticTest.kt](../../../apps/android/app/src/androidTest/java/dev/oraculum/poc/gateway/SavedGatewayDiagnosticTest.kt)：只读原 Endpoint、原配对和本地数据库；认证只换临时 access，CredentialStore.save 禁止；业务写入为零。需要显式 `oraculumReadOnlyDiagnostic=true`。
- [SavedGatewayRecoveryJourneyTest.kt](../../../apps/android/app/src/androidTest/java/dev/oraculum/poc/e2e/SavedGatewayRecoveryJourneyTest.kt)：需要显式 `oraculumGatewayE2e=true` 和 `oraculumTestProject=TEST`；先检查原 Snapshot、原回执、unknown 与审批，再经现有 ViewModel 安全路径创建/发送各一次。派发前持久化 create/send guard，重复执行会拒绝，不能删除 guard 后重跑或补发。

测试提交：`975da2a1f3fc4fe62a5057c3a3fe1d8c134fc7ab`，`test(android): cover paired Gateway recovery on real devices`，已正常推送并核对 origin/main。没有产品 UI、Gateway 协议、安全状态机或 Release 元数据修改。

### 最终 Debug APK 与截图

最终包：`.local/evidence/gateway-incident-20261113/oraculum-gateway-recovery-debug.apk`，14,107,014 bytes。

SHA-256：`c97aee06503d8c54f39db7de9850422ba8b7638f474695be13e40808b2b72cf7`。

内嵌 sourceGit：`975da2a1f3fc4fe62a5057c3a3fe1d8c134fc7ab`；sourceDirty=true。保留用户现有未跟踪 Android Studio/Gradle 文件及本次未提交报告，未为制造 clean 标记移动或删除文件。源码中 Android main、Gateway src 和 Release 元数据相对接管基线没有差异。真实单次写入 E2E 在前一 Debug 构建上运行（sourceGit 为接管基线），之后只有测试/文档与构建身份变化；最终已安装包重新做的是无新增业务写入的完整只读链路回读，没有重发 E2E 消息。

全部截图均为 OnePlus 6T 原始 1080×2340 PNG：`01-initial.png`、`e2e-02-completed.png`、`e2e-03-offline-readonly.png`、`e2e-04-reconnected.png`。接管现场与重连成功图已原字节上传到 [Notion 专项任务](https://app.notion.com/p/4175421e690b8165abb9ce58ccbc813d)，本机 `artifacts.json` 记录各图字节数、尺寸和 SHA。

原始 Logcat、Gateway 日志、数据库快照、部署回执、网络对照和原始 Snapshot 仅保存在本机 `.local/evidence/gateway-incident-20261113/` 私有证据区；不提交或上传原始历史与敏感诊断。Beta 1 tag、Release、发布资产与校验值保持原样。正式 Gateway 已按用户批准修复并保持运行，最终 Debug 保留在成功的测试会话，等待用户复核。
