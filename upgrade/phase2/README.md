# Oraculum 2.0 Phase 2｜Android 原生 PoC 工程报告

报告日期：2026-11-11。**P2.1–P2.3 已完成实现与本机 Emulator 验证，包括真实 Codex 会话/流式/停止、存储安全、离线与系统重启恢复，以及缓存重建、游标失效、access 过期、代次变化、丢 ACK 后 unknown 恢复和 CLI 撤销。已归档测试证据、Debug APK 摘要与真实截图，隔离测试进程已关闭。正式 Task 保持 In progress，等待独立审阅，不自行进入 Phase 3 或正式发行。**

正典：[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[已验收的 Phase 1](https://app.notion.com/p/4155421e690b818b8d19e6ab806641bd)、[Phase 2 正式任务](https://app.notion.com/p/4155421e690b81d6bd42e4dcd321cd56)。前置工程证据见 [Phase 1 交付报告](../phase1/README.md)。最新 Notion 裁定优先于历史文档。

## 1. 本阶段实现

| 范围 | 实现入口与行为 |
| --- | --- |
| P2.1 原生壳、网络与配对 | `ComponentActivity` + Kotlin/Compose + Material 3；HTTPS endpoint/可选 Base Path、协议与能力握手、CLI 一次性配对、Keystore 凭据、短期 access、HTTP/WSS |
| P2.2 真实会话与控制 | 已注册项目、授权根目录下显式注册、会话选择/显式新建、原生消息与流式、停止、显式恢复、历史读取及操作回执查询 |
| P2.3 本地恢复与离线 | 独立 Room 历史缓存与持久状态库、DataStore 启动选择、草稿和阅读锚点、离线只读、断连/代次/游标失效校正、unknown 不自动重发 |

Android 正式 Application ID 继续为 `dev.oraculum.poc`；本阶段构建和安装的调试身份为 `dev.oraculum.poc.debug`。版本号仍来自现有 `release.json`，调试版本不会自行变成正式 2.0 发行。没有调用正式签名脚本或改变原长期签名材料。

主界面已替换旧 WebView。少量颜色与圆角取自只读 Stitch Matcha Terminal 设计：深色背景 `#11140f`、主色 `#a5d65d`、分层容器与可选择的消息文本。使用系统字体，不加载远程 HTML、字体或脚本。项目与会话入口、配对、连接/执行状态、简洁 Composer、基础标题/代码/强调文本属于本次 PoC；完整三面板与三套主题仍留在 Phase 3。已失去调用入口的旧通知 Service 与其 Manifest 权限一并移除。

源码导航：[Android 模块](../../apps/android/README.md)、[MainActivity](../../apps/android/app/src/main/java/dev/oraculum/poc/MainActivity.kt)、[Compose UI](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt)、[PocViewModel](../../apps/android/app/src/main/java/dev/oraculum/poc/PocViewModel.kt)、[Gateway 客户端](../../apps/android/app/src/main/java/dev/oraculum/poc/gateway/GatewayClient.kt)、[本地存储](../../apps/android/app/src/main/java/dev/oraculum/poc/storage/LocalStore.kt)。

## 2. 执行、认证与持久化边界

链路为 Android 原生界面 → Gateway 的 HTTP/WSS → 官方 Codex App Server。Android 只消费公开 Gateway 契约，不调用任意原生 RPC、不直接执行工具、不创建 Agent Loop。Kotlin 编译直接使用 [Schema 生成的 DTO](../../packages/gateway-protocol/generated/GatewayDtos.kt)，协议字段不另设一套来源。

Endpoint 只接受规范 HTTPS 地址，可以带部署 Base Path；不接受账号、查询参数、fragment、路径转义和 `.`/`..` 段。OkHttp 保留平台 TLS 与主机名校验，关闭重定向和网络故障下的透明重试。access 只在内存，临近过期先交换新 token；业务请求遇到 401/断线仍不会自动重发。已撤销设备、Gateway 安装身份变化或本机密钥不可读均保留原身份并拒绝继续认证，不悄悄生成替代设备。

| 存储 | 内容 | 生命周期与保护 |
| --- | --- | --- |
| Android Keystore + `noBackupFilesDir/oraculum-v2-identity` | 长期设备身份与秘密的 AES-GCM 密文 | Keystore 密钥；endpoint 作为附加认证数据；AtomicFile 写入；先持久身份再发送配对；不保存 access |
| `oraculum-v2-cache.db` | 项目、会话、快照、历史分页、消息投影、事件游标 | 可重建；投影与对应游标在同一 Room 事务提交；确认缓存损坏时仅重建此库 |
| `oraculum-v2-state.db` | 草稿、阅读 Item/偏移、operationId 与原生回执关联 | 与可清理缓存分文件；unknown 行须先提交才派发；终态不会被迟到 unknown 降级；损坏时保留文件并停止写入，不自动删除重建 |
| `oraculum-v2-preferences` DataStore | endpoint、最近 scope/项目/会话 | 小规模非秘密偏好；endpoint 切换清除当前启动选择，旧 scope 的持久状态仍保留 |

缓存和持久状态按 endpoint、Gateway installationId、deviceId 隔离；草稿与阅读位置进一步按项目/线程隔离。没有读取或迁移旧 Cookie、WebView/localStorage、旧数据库、配对和主题。Manifest 禁止应用备份，并排除云备份和设备转移。Room 内容位于 Android 应用私有目录；本阶段没有宣称聊天历史数据库做了额外应用层加密。

首次启动或上次会话不可用时显示选择入口。恢复项目/会话、重新连接、进程重启和网络恢复都不自动创建线程或发送草稿。离线可以浏览已缓存内容并编辑草稿；发送、注册、新建、恢复执行与停止等有副作用操作需要在线且状态校正完成。

每次可派发写入先保存原 operationId。结果未知时只读查询回执并核对原生状态，停止已观察到的活动 Turn 是独立的明确动作。缺少回执不能解释成未执行；PoC 没有强制清除 unknown、换 ID 或换设备绕过的入口。无法取得确定结果时，用户需保留记录，在主机检查原生执行；客户端继续保持写入屏障。

事件按真实 epoch 和 seq 校验连续性；代次变化、缺口、未知关键事件和历史失效会重新取得快照。原生 Thread/Turn/Item ID 保持不变，完整终态优先于迟到的增量。上次会话恢复还需核对当前活动列表；归档、删除、无权限或超出有界确认范围时明确回退。受限历史会明确提示；客户端展示条数达到上限本身不等于同步失败。发送取决于实际原生同步、执行和 unknown 状态，Gateway 截断结果对应的 stale 同步状态仍会阻止发送。

### 新空线程的原生历史兼容

真实接入发现，官方 `thread/start` 已返回新线程后，首条用户消息之前的 `thread/turns/list` 可能返回 `-32600`，明确表示该线程历史尚未 materialize。Gateway 在 [0307fb4](https://github.com/rando1ph/oraculum/commit/0307fb425fc9984e997d20c22a86811885fd8089) 中只对**方法、错误码、与请求 threadId 完全匹配的完整原生消息**做 `NATIVE_HISTORY_NOT_MATERIALIZED` 分类；其他失败保持原分类。`experimentalApi=false` 不变，snapshot 继续返回真实错误，不伪造空历史、已同步水位或成功结果。

Android 的 [FirstTurnPermit](../../apps/android/app/src/main/java/dev/oraculum/poc/repository/FirstTurnPermit.kt) 只接受当前明确 `thread.start` 的 accepted 回执，并绑定项目、原生线程、epoch 和连接代次。遇到上述精确错误后，再只读查询元数据并确认同一线程为 idle，且在线、事件连接仍有效、没有 unknown，才能允许用户手动发送第一条消息。许可仅在内存保存，写入持久 Turn 意图后即消费，即使结果随后为 unknown 也不恢复；断连、代次变化或原生状态失效会撤销。这里的 `snapshotCurrent` 始终为 false，正常历史可读后回到既有快照门控。进程重启不会从缓存或旧回执重建这一许可。

该分支解决的是新空线程尚无历史的兼容问题，不提供重试写、自动首发、历史故障的通用绕过或既有线程的权限提升。相关原生精确分类、错误 threadId/错误方法负例及一次性许可的生命周期由单测覆盖；首轮真实 Android 发送已通过该兼容路径。

## 3. Debug 构建与许可证

本轮沿用已配置的 Gradle 8.13、AGP 8.13.2、JDK 21、Kotlin/Compose compiler 2.2.21，`compileSdk/targetSdk=35`、`minSdk=26`。主要新增依赖锁定为 Compose BOM 2025.04.01、Material 3、Room 2.7.2/KSP 2.2.21-2.0.5、DataStore 1.1.7、Lifecycle 2.9.1、OkHttp 4.12.0、serialization 1.8.1 和 coroutines 1.10.2。实际解析集合由 Gradle 与许可证清单核对。

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
bash scripts/android-build.sh :app:assembleDebugAndroidTest :app:testDebugUnitTest
```

脚本使用 `${ORACULUM_TOOLS:-$HOME/.local/share/oraculum-tools}` 下的 `jdk-21`、`android-sdk`、`gradle-8.13` 和专用 Gradle 缓存。已有配置满足构建时不需要更改用户 SDK、AVD 或系统网络。常规构建只信任系统 CA。

本机隔离 E2E 额外传入**当次 fixture 公开 CA 证书路径**：

```bash
bash scripts/android-build.sh \
  -PoraculumDebugCa="$ORACULUM_FIXTURE_CA" \
  :app:assembleDebugAndroidTest :app:testDebugUnitTest
```

该参数仅生成 Debug 资源，检查证书有效期、CA 约束和私钥片段；不写入源码、Release 资源或系统信任。没有 `trustAll`、不安全 HostnameVerifier 或明文 HTTP 例外。每次 fixture 生成不同证书，必须用对应证书重新构建，旧 Debug APK 不会自动信任新 fixture。

默认产物为 `apps/android/app/build/outputs/apk/debug/app-debug.apk` 和 `apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`。构建身份位于 APK `assets/oraculum-build.json`，包含 Git SHA/sourceDirty；只排除用户未跟踪的原始 Stitch 目录，其他源码改动仍使 sourceDirty=true。最终交付副本与摘要见第 6 节。

[Android 许可证清单](../../packaging/licenses/android/manifest.json) 当前覆盖 120 个 releaseRuntimeClasspath 组件（包括 BOM/变体元数据），解析到 78 个 artifact。43 份嵌入 AndroidX LICENSE 在末尾换行规范化后与共用 Apache-2.0 文本一致；同时保留 Kotlin LICENSE/NOTICE、DataStore shaded protobuf 的 BSD-3-Clause 文本，以及 OkHttp Public Suffix 的 NOTICE/MPL-2.0。Guava ListenableFuture 的许可继承由精确 parent POM 核对。构建继续执行组件集合与许可文件 hash 检查，未关闭该门禁。测试专用依赖不进入 releaseRuntimeClasspath。

## 4. 隔离 Gateway 与 Emulator 复现

需要已配置登录的官方 Codex CLI、Node 24、OpenSSL，以及用户现有 Android Emulator/ADB。以下操作仅针对明确选中的模拟器 Debug 包；不安装正式 Gateway、不修改系统证书、不卸载正式 APK。

先核对目标设备，记录实际 AVD/API/ABI，再启动 fixture：

```bash
android info
adb devices -l
adb -s "$ORACULUM_ADB_SERIAL" emu avd name
adb -s "$ORACULUM_ADB_SERIAL" shell getprop ro.build.version.sdk
adb -s "$ORACULUM_ADB_SERIAL" shell getprop ro.product.cpu.abi
pnpm exec tsx scripts/android-v2-fixture.ts
```

[fixture](../../scripts/android-v2-fixture.ts) 在私有临时目录创建全新 Gateway 配置/状态、专用 `project` 和临时 loopback HTTPS/WSS 代理；通过正式 CLI 实现初始化、配对与撤销，原生端为真实官方 Codex。终端必须保持运行，其 stdin 接收控制 JSON。ready 输出提供 metadataPath、endpoint、port、wrongTlsPort 和 certPath，配对码只写入 CLI 创建的 0600 文件，不在 ready 日志中输出。

在另一个终端设置 `ORACULUM_FIXTURE_META` 为当次 metadata.json 路径、`ORACULUM_ADB_SERIAL` 为已核对的模拟器序号。从 metadata 读取证书路径及两个端口；把该公开证书传给上一节的 Debug 构建。路由与安装命令如下，端口均取本轮 metadata：

```bash
adb -s "$ORACULUM_ADB_SERIAL" reverse "tcp:$ORACULUM_FIXTURE_PORT" "tcp:$ORACULUM_FIXTURE_PORT"
adb -s "$ORACULUM_ADB_SERIAL" reverse "tcp:$ORACULUM_WRONG_TLS_PORT" "tcp:$ORACULUM_WRONG_TLS_PORT"
adb -s "$ORACULUM_ADB_SERIAL" install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ORACULUM_ADB_SERIAL" install -r apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$ORACULUM_ADB_SERIAL" shell am start -n dev.oraculum.poc.debug/dev.oraculum.poc.MainActivity
```

fixture 的 `/android-poc/` 是测试实例 Base Path，未写成产品默认值。测试流量只通过指定 ADB reverse 到宿主 loopback；错误证书端口使用另一张不受 APK 信任的证书。每次重启模拟器后复核 ADB 序号并重建本次 reverse。

手动路径为：填入本次 HTTPS endpoint → 使用 CLI 一次性码配对 → 注册授权根 `acceptance` 下的相对目录 `project` → 选择项目 → 明确新建测试会话 → 输入受控消息 → 观察流式 → 停止活动 Turn。不要选择用户已有项目或会话。

自动路径使用 [NativeGatewayJourneyTest](../../apps/android/app/src/androidTest/java/dev/oraculum/poc/e2e/NativeGatewayJourneyTest.kt)。它仅在 Debug 私有 `no_backup/phase2-e2e.json` 存在时运行真实旅程；缺少输入会明确跳过。输入需要 `endpoint`、`wrongTlsEndpoint`、`projectRelativePath` 与从本次 CLI 私有配对文件读出的 `pairCode`。读取后通过 ADB stdin 写入该 Debug 私有文件，禁止把配对码放入 shell 参数、Gradle 参数、APK assets、日志或 Git。配对码过期时在 fixture 终端输入 `{"command":"pair"}` 取得新的私有文件，再更新测试输入。

[Emulator 辅助脚本](../../scripts/android-v2-emulator.py) 只接受显式 `emulator-NNNN` 序号并核对 qemu 属性，可完成上述私有输入传递、两条 ADB reverse、单方法测试与证据导出：

```bash
python3 scripts/android-v2-emulator.py --serial "$ORACULUM_ADB_SERIAL" prepare --metadata "$ORACULUM_FIXTURE_META"
python3 scripts/android-v2-emulator.py --serial "$ORACULUM_ADB_SERIAL" test \
  --method initialPairRegisterChatStop --output .local/evidence/oraculum-v2-phase2/initial-native-journey.txt
python3 scripts/android-v2-emulator.py --serial "$ORACULUM_ADB_SERIAL" collect \
  --output .local/evidence/oraculum-v2-phase2/screenshots
```

该脚本不会清应用数据、使用正式包身份或签名证书。测试结束使用其 `remove-test-input` 子命令仅删除本次私有输入，身份、草稿和回执仍保留。

单个旅程的调用形式：

```bash
adb -s "$ORACULUM_ADB_SERIAL" shell am instrument -w \
  -e class 'dev.oraculum.poc.e2e.NativeGatewayJourneyTest#initialPairRegisterChatStop' \
  dev.oraculum.poc.debug.test/androidx.test.runner.AndroidJUnitRunner
```

这些有状态旅程应按前置条件逐项运行，不能把所有方法按 JUnit 任意顺序运行后当作完整 E2E。错误配对测试在首次成功配对之前运行；撤销在所有需要在线权限的旅程之后执行。

| 情景 | fixture 控制/Emulator 动作 | 对应检查 |
| --- | --- | --- |
| 错误 TLS/配对 | 保持正常代理与错误证书代理在线 | `wrongCertificateAndPairingRejected`，随后使用有效码首次配对 |
| 配对、注册、新建、真实流式与停止 | 正常在线 | `initialPairRegisterChatStop`；同一原生 Item 的文本在终态前增长，保留本机草稿/阅读锚点 |
| 进程恢复 | `adb shell am force-stop dev.oraculum.poc.debug` 后重开 | `restoreAfterProcessOrEmulatorRestart`；原会话/草稿/阅读锚点恢复且不发送草稿 |
| 模拟器重启 | 重启当前 AVD，待系统启动，恢复 ADB reverse | 再运行同一恢复旅程，不能仅用 Activity 重建代替 |
| 非法项目相对路径 | 正常在线，提交测试用不存在路径 | `invalidProjectPathDoesNotCreateUnknown`；只读预检失败，不派发注册写入 |
| 离线与草稿 | `{"command":"offline"}` | `offlineCacheDraftAndNoWrite` |
| 重连与历史缓存重建 | `{"command":"online"}` | `reconnectAndRebuildCache`；草稿、unknown 与回执独立保留 |
| 未签发历史游标/越界事件游标 | 正常在线，只读查询随机历史 cursor；WSS 使用同 epoch 下越界 seq | `invalidHistoryAndEventCursorsResetReadOnly`；真实 Gateway 拒绝历史游标、事件连接返回 `resetRequired` |
| access 过期 | 先运行 `expiredAccessRenewsWithoutPairingOrWrite`，待 `access-expiry-ready.json` 为 ready 后发送 `{"command":"expireAccess"}`，再写入 Debug 私有 `no_backup/phase2-access-expired` 触发文件 | 此控制只推进注入的 GatewayAuth 测试时钟；读取触发旧 token 401 后使用原配对身份续期，不能写成自然等待十分钟 |
| 代次变化 | `{"command":"restartGateway"}` | `newEpochRequiresExplicitResume`；先读取校正，再由用户点击恢复 |
| 写入 ACK 丢失 | `dropNextWriteResponse` 指定当前测试线程的 `/android-poc/api/v2/threads/THREAD_ID/turns` 路径 | `lostWriteAcknowledgementStaysUnknown`；真实上游执行，代理丢弃应答并切断连接 |
| unknown 跨进程保存 | 维持离线并杀进程/重开 | `unknownSurvivesRestartOffline`；不得重发 |
| 只查回执恢复 unknown | `{"command":"online"}` | `reconcileUnknownByQueryWithoutResend`；另核对 Gateway operation 数和原生 Turn 数没有重复增长 |
| CLI 在线撤销 | 先启动 `liveRevocationClosesAccessAndEvents`，待 `revocation-ready.json` 为 ready；通过 `{"command":"devices"}` 核对设备后发送 `{"command":"revoke","deviceId":"本次测试设备 UUID"}` | 原在线 HTTP/WSS 失效，身份及写控制禁用 |
| 撤销后的再认证 | 保持原设备已撤销，不重新配对 | `revokedDeviceIsReadOnly`；原长期凭据交换 access 被明确拒绝 |

`status` 只读报告本次设备/项目/回执、原生 Turn 摘要和 Codex config hash 是否保持；`cut` 只断当前连接；`stop` 关闭 fixture 并写入 fixture-report.json。状态目录和专用原生测试线程保留以便检查，不清除用户既有数据。故障控制只存在于测试脚本，没有加成产品远程开关。

Android instrumentation 的截图来自 `uiAutomation.takeScreenshot()`，结果写入 Debug 私有 `files/phase2-evidence/`。导出后先核对真实画面与脱敏，再选择少量图归档；不生成或拼接模拟截图。最终归档只包括必要的公开摘要，不包含配对文件、身份密文、TLS 私钥、原始数据库或敏感 native 日志。结束时删除 Debug 私有测试输入文件并移除本轮两个 ADB reverse；不要使用 `pm clear` 清除 unknown 来继续测试。

## 5. 验证记录

以下记录来自本轮实际输出，区分实现测试、受控异常注入与真实模型 E2E。最终已提交源码构建和安装后的只读回归均通过。当前脱敏证据目录为 `.local/evidence/oraculum-v2-phase2/`，下表证据文件名均相对此目录。

| 检查 | 最终结果 | 证据/限制 |
| --- | --- | --- |
| AVD、设备序号、API、ABI | `codex_api36_aosp` / `emulator-5554` / API 36 / x86_64 | 官方 `codex-cli 0.167.1`；`acceptance-summary.json` 与 `emulator-reboot.json` |
| `pnpm check`、全仓单测 | 通过；72 个文件、833/833 测试 | `gateway-materialization-typecheck.txt`、`repository-tests.txt` |
| 协议生成/跨端检查 | 通过；67 个 DTO、75 组 TS/Ajv/Kotlin 往返、20 组非法 fixture 拒绝 | `protocol-verification.txt`；Kotlin DTO 实际编译 |
| Debug 主 APK/测试 APK构建、JVM 单测、lint | 最终已提交源码完整 Gradle 通过（59 秒）；6 个 suite、41/41 JVM 测试；lint 0 errors、12 warnings | `android-committed-build.txt`、`android-final-checks.txt`；来源 `1b78490`；warnings 为 SDK/固定依赖版本、图标及未使用资源提示 |
| Room/DataStore/Keystore instrumentation | API 36 上 8/8 通过：存储 7 项、真实 Keystore 1 项 | `storage-keystore-final.txt`（最终 8/8）及 `storage-corruption-instrumentation.txt`；重开、scope 隔离、回执终态、缓存重建、损坏保全、密文篡改均覆盖 |
| CLI 配对 → 专用项目 → 原生线程 → 流式 → 停止 | 真实 E2E 通过，用时 43.08 秒 | `initial-native-journey-final.txt`、`screenshots/initial.json`、`status-after-initial.json`；同一原生 Item 在终态前增长；仅 2 个 Turn，分别 completed/interrupted |
| force-stop 后会话、草稿与阅读锚点恢复 | 通过；修正测试 checkpoint 后复测 2.191 秒 | `process-restart-final.txt`、`reading-checkpoint.txt`；没有重新发送草稿或重跑产品会话路径 |
| 非法项目相对路径预检 | 通过，4.407 秒 | `invalid-project.txt`；输入在持久写入意图/业务写请求派发之前经只读查询拒绝，不制造 unknown |
| 模拟器系统重启恢复 | 通过；实际 OS 重启后恢复旅程 3.223 秒 | `emulator-reboot.json` 记录前后 bootId 不同，`emulator-restart-final.txt` 验证会话、草稿与阅读锚点恢复；不是 Activity/进程重建 |
| 离线缓存与草稿 | 通过，3.209 秒；发送/停止/恢复禁用，离线草稿可编辑 | `offline-cache.txt`；`status-before-offline.json` 与 `status-after-offline.json` 的操作计数完全一致，`turn.start` 始终为 2，原 Codex config hash 不变 |
| 错误 TLS 与错误配对 | 通过，1.678 秒 | `wrong-certificate-pairing-final.txt`、`screenshots/wrong-certificate-pairing.json`；真实错误证书端口和无效配对码拒绝 |
| 重连与可重建缓存清理 | 通过，9.221 秒 | `cache-rebuild.txt`；重新取得同一原生消息 ID 集合，持久草稿仍保留；unknown/回执分库保全另由存储 instrumentation 覆盖 |
| 历史与 WSS 游标失效 | 通过，1.783 秒 | `invalid-cursors.txt`、`screenshots/invalid-cursors.json`；真实 Gateway 拒绝未签发历史 cursor，WSS 在相同 epoch、越界 seq 时返回 `resetRequired`；仅只读探测 |
| 已签发 access 过期后续期 | 受控时钟实测通过，61.08 秒 | `access-expiry-final.txt`、`access-expiry-controls.json`、`status-after-access-expiry.json`；保留原配对、会话与草稿，操作计数仍为 2 个 `turn.start`；首次额度周转与正式 token 过期分开记录，见下文 |
| Gateway epoch 变化与显式恢复 | 通过，12.011 秒 | `epoch-explicit-resume.txt`、`status-before-unknown.json`；新 epoch 先只读恢复历史，未加载线程不可发送；明确点击恢复后恰新增 1 个 accepted `thread.resume`，没有新增 Turn |
| 写入 ACK 丢失 → unknown → 离线进程重启 | 分别通过，7.271 秒、2.4 秒 | `lost-ack.txt`、`unknown-restart.txt`、`status-unknown-offline.json`；真实上游执行后代理丢弃 1 次写应答并断连，unknown 跨进程保留且阻止继续发送/恢复 |
| unknown 只查回执校正、不重发 | 通过，6.391 秒 | `unknown-reconciled.txt`、`status-after-unknown-reconcile.json`；操作集合与离线 unknown 时完全相同，accepted `turn.start` 恰 3 个，对应原生 3 个 Turn：completed/interrupted/completed；`P2_ACK_ONCE` 仅 1 条 assistant 回复 |
| CLI 撤销后的 HTTP/WSS 与再认证 | 两项真实测试通过；最终已提交 APK 只读回归亦通过 | `live-revocation.txt`、`revoked-reauthentication.txt`、`committed-apk-readonly-smoke.txt`；原在线 WSS 失效，写控制禁用，原长期凭据的新 access 交换明确拒绝 |
| 受限历史及安全回退 | JVM 合成边界测试通过：270 个 Item、超大文本、分页次序、终态/旧快照和事件缺口 | 明确受限投影；未同步时禁止发送。未生成超长真实 Codex 历史；归档/删除/无权限回退经代码审查，未逐项实机造数 |
| 原配置、旧数据与 Stitch 保全 | Codex config hash 不变；12 个用户 Stitch 文件 hash 全部不变 | `fixture-report.json`、`stitch-preservation.json`；没有旧数据迁移、正式应用卸载或生产服务修改 |
| Git 同步与 Notion 回写 | 聚焦提交直接在 main 正常推送并核对实时远端 | 实现 SHA 见下表，文档归档 SHA 与最后推送核对见 Notion Task / `delivery-status.json`；Task 保持 In progress |

一次进程恢复测试因 harness 在 fling 尚未结束时写下 checkpoint，预期阅读偏移与稍后持久化的稳定偏移不同而失败，原记录保留为 `process-restart.txt`。修正仅涉及测试：`until` 等待期间推进 Compose 帧，截图/检查点前等待 UI idle，再读取稳定位置；另运行 `stabilizeReadingCheckpoint` 后重测恢复通过。没有为迁就断言修改产品恢复逻辑，也没有重发真实消息。

access 过期首轮并未进入已发 token 的正式过期断言：多次 instrumentation 冷启动累积到每设备 8 个活动 access grant 的既有限额，等待在线超时，失败记录保留为 `access-expiry.txt`。没有修改生产限额、配对身份或产品逻辑。fixture 第一次推进注入时钟 11 分钟，只让旧 grant 过期以恢复测试前置条件；重新在线并写出 ready 标记后，第二次再推进 11 分钟，才验证已发 token 的 401、原设备凭据续期及只读恢复。两次控制的用途与时间分别保存在 `access-expiry-controls.json`。这是一项受控过期测试，不代表自然等待或跳过服务端授权限制。

丢 ACK 测试使用原 `operationId` 查询和同一原生 Thread/Turn 状态校正，恢复前后没有重新派发 Turn。`status-unknown-offline.json` 的独立官方 App Server 只读核对确认 `P2_ACK_ONCE` 恰有 1 条 assistant 回复；`status-after-unknown-reconcile.json` 再次确认操作集合不变。诊断新空线程兼容问题时另开的 App Server 探针单独归档于 `native-probes/`，其文件 hash 见 `native-probes/manifest.json`；这些诊断线程不计入 Android 主旅程的 3 个原生 Turn，也不冒充 Android E2E 结果。

## 6. Git、产物和截图

| 项目 | 最终记录 |
| --- | --- |
| 开工 main 基线 | `ad4d9fac0b11c723c6ffb7ecf8c1b0ec93e5c563`，开工 fetch 核对与 origin/main 一致 |
| 已提交的隔离 fixture | `4e078aa702e353e3926ee47125365d068ec4638b`，`test(android): add isolated native Gateway acceptance fixture` |
| 已提交的新空线程精确兼容修正 | `0307fb425fc9984e997d20c22a86811885fd8089`，`fix(gateway): identify unmaterialized native thread history` |
| 原生实现提交 SHA | `1b78490a9455539c9b0ab188b38c49da52bd3d5b`；文档归档为后续 docs 提交，最终 SHA 回写 Notion Task |
| 最终 Debug APK 路径、大小、SHA-256 | `.local/artifacts/oraculum-v2-phase2/1b78490/oraculum-v2-phase2-debug.apk`；13,838,332 bytes；`714bbd74aafc2aacd3a522926e763b6d79b6d688ed34a2c7077ac9363794d839` |
| APK 内构建来源/sourceDirty | `sourceGit=1b78490a9455539c9b0ab188b38c49da52bd3d5b`，`sourceDirty=false`；`dev.oraculum.poc.debug`，0.1.2-debug / versionCode 4；普通 Debug 签名校验通过 |
| 测试 APK 路径与 SHA-256 | `.local/artifacts/oraculum-v2-phase2/1b78490/oraculum-v2-phase2-androidTest.apk`；`26575cda0b64c59e18ac86b4256591978d833f4a33cd43e54fe2e4effea20f8e` |
| 本地脱敏测试报告目录 | `.local/evidence/oraculum-v2-phase2/`：`acceptance-summary.json`、`artifact-manifest.json`、`delivery-status.json`；APK 同目录 `manifest.json` |
| 截图 1：原生会话/真实回复 | `review-screenshots/01-native-chat.png`；首轮完成、第二轮停止及未发送草稿 |
| 截图 2：离线缓存 | `review-screenshots/02-offline-cache.png`；原生历史与离线草稿，执行控件禁用 |
| 截图 3–4：unknown 与 CLI 撤销 | `review-screenshots/03-unknown-preserved.png`、`04-cli-revocation.png`；原 operationId 保全说明与撤销拒绝画面 |

截图路径相对上述本地证据目录；4 张选图已嵌入 [Notion Phase 2 Task](https://app.notion.com/p/4155421e690b81d6bd42e4dcd321cd56)。选图为真实 Emulator PNG 原始像素，未拼接/修图；仅含专用测试内容，SHA 清单在 `review-screenshots/manifest.json`。

二进制 APK、日志、缓存、数据库与密钥材料不提交 Git。所有修改仅在原工作区 main 聚焦提交并正常推送；最终交付需核对本地 HEAD、origin/main 和实时远端相同。用户 Stitch 原件持续保留、只读、不提交。

## 7. 阶段限制与停止线

- 本次为本机 Android Emulator 和隔离 loopback HTTPS/WSS；模拟器不代表物理手机的后台限制、蜂窝切换、厂商省电或真实公网代理。未做这些场景时在最终表明确标注。
- 会话入口显示最近 20 条；恢复上次会话使用有界确认。历史与 Item 展示受 Gateway 的预算、分页/后备能力和客户端投影限制约束；不把可读的局部结果称作全量历史。复杂 GFM、完整大 Item 详情和超长历史性能另行处理。
- 完整审批表单、权限选择、附件/文件/Inspector/Diff、通知、完整三面板、Light/Dark/OLED Dark、正式主题偏好和完整产品视觉均不属于本 PoC。原生等待交互时提供说明与可用的停止动作，不虚构审批决定。
- 永久 unknown 暂无人工解除流程。Room 草稿/回执库和 Keystore 失效不会自动重建身份或清除安全屏障；后续恢复方案必须另行审阅。
- 不迁移旧应用数据；旧 Desktop/Bridge 卸载属于独立任务。没有正式 Gateway 安装/启用、VPS/Caddy/SSH/systemd/生产网络变更、正式 APK 签名或发行授权。
- Phase 2 工程结果回写后，Task 仍为 **In progress**。进入 Phase 3 或正式发行需用户或明确授权审阅者另行接受和批准。
