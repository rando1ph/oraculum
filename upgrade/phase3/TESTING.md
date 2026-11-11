# Phase 3 Android 原生验收复现

本文是执行说明，不代表所有情景已经通过。最终执行结果、失败与限制以本阶段交付报告及本地原始证据为准。仅使用明确选定的 Android Emulator、Debug 包与隔离项目；不得清除 Phase 2 身份、草稿和 unknown，不卸载正式 APK，不运行正式签名脚本。

## 1. 独立测试实例与输入

先记录 `android info`、`adb devices -l`、AVD 名称、API 与 ABI。启动真实官方 Codex 支持的隔离 Gateway：

```bash
pnpm exec tsx scripts/android-phase3-fixture.ts
```

此入口复用已验证的 Phase 2 fixture，另建随机 TLS Origin、`/android-phase3/` 测试 Base Path、Gateway 状态和专用 `project`。随机端口与新 Base Path 是测试隔离措施，不是产品默认值。保留已有 Phase 2 endpoint 的 Keystore 凭据和 Room 数据；不能重配已撤销身份以绕过 unknown。新增主机文件全部位于本轮临时项目：`artifacts/phase3-note.md`、`phase3-image.png`、`phase3-data.json`。真实测试产生的原生线程保留于 Codex 历史。

ready JSON 提供 `metadataPath`、`endpoint`、`certPath` 与端口。配对码仅存于 CLI 的 0600 文件。Debug 构建通过 `-PoraculumDebugCa=<certPath>` 信任本轮公开证书，不改系统信任、不禁用主机名校验。按 Phase 2 Gradle 流程构建主 APK 和 instrumentation APK，用 `adb install -r` 保留现有 Debug 数据。

```bash
python3 scripts/android-phase3-emulator.py --serial emulator-5554 prepare --metadata /本轮/metadata.json
python3 scripts/android-phase3-emulator.py --serial emulator-5554 test \
  --method pairRegisterAndReadNativeThread --output .local/evidence/oraculum-v2-phase3/native-initial.txt
```

辅助脚本必须收到实际核对过的模拟器序号。`prepare` 通过 ADB stdin 写入 Debug 私有 `no_backup/phase3-e2e.json`，建立本轮两个 reverse；配对码不进入参数、环境变量、日志或 APK。配对过期时在 fixture stdin 发送 `{"command":"pair"}` 后重新 prepare。缺少私有输入时 E2E 会明确跳过，跳过不得计为通过。

## 2. 真实工作区旅程

每个方法单独执行。它们有明确前置条件，不能让 JUnit 任意排序运行整类。首次连接只注册本轮 `acceptance/project` 并明确创建测试原生线程；后续测试校验 checkpoint 中的 threadId，防止误操作用户会话。

| 顺序 | 方法 | 检查 |
| --- | --- | --- |
| 1 | `pairRegisterAndReadNativeThread` | 新 endpoint 配对、项目注册、原生线程、真实 Codex 回复和 Gateway 模型列表；保存测试线程 checkpoint |
| 2 | `panelsThemesAndImePreserveDraft` | 真实 Light/Dark/OLED 界面、左右面板系统返回、Android IME、线程与草稿保全；结束恢复原主题和草稿 |
| 3 | `landscapeAndLargeFontPreserveWorkspace` | 系统字体 2.0 倍与横屏、Inspector、可见 Composer 与发送按钮；finally 恢复原字体值与方向 |
| 4 | `realToolsDiffUsageAndExtensions` | Auto 下仅在专用项目生成 `phase3-output.md`，真实原生工具、Diff、用量、Gateway 只读扩展；不以合成事件冒充真实执行 |
| 5 | `actualNativeApprovalCanBeDeclined` | 优先处理当前真实 pending 请求；否则在 Read only 下请求原生受限写入。仅从原生 availableDecisions 选择 decline，未提供则选择 cancel，记录实际决定；不添加或假设拒绝按钮。若模型未请求审批，此测试失败/未覆盖，不伪造请求 |
| 5a | `actualNativeFileChangeCanBeReviewedAndAccepted` | 仅本轮 checkpoint 项目/线程，在 Read only 下请求 apply_patch 创建 `phase3-approved.txt`。必须出现真实 fileChange pending、完整受限 Diff 上下文，核对精确 canonicalPath、单一 add、无 move、唯一 marker、scope/epoch/generation/turn/item/digest；通过实际 UI accept 后等待新 assistant ID 与终态 current snapshot。无 context、其他交互类型或不支持的 grantRoot 均不得批准 |
| 5b | `nativeFileChangeWithoutReviewEvidenceCannotBeAccepted` | 仅处理 5a 已保存 marker 对应的原 pending/原 Turn；确认无完整原生上下文、accept 不存在或禁用，再通过实际 UI 使用原生允许的 cancel（否则 decline）。不新发 Turn，单独记录安全阻断及取消后的终态，不能计为正向批准通过 |
| 6 | `nativeNotificationPermissionDenyThenGrant` | 从尚未授权开始，实际系统弹窗拒绝，确认不可通知，再从应用设置入口请求并允许；不用 ADB grant 或重置既有权限 |
| 7 | `--suite notifications --method realCompletionNotifiesForeground` | 新唯一标记的真实短 Turn；生命周期监视器断言原 Activity 在发送至通知期间持续 RESUMED；按本次真实 nativeTurnId 对应的通知 tag、新 key、渠道和时间戳核对前台送达，不能用旧历史/旧通知通过 |
| 8 | `--suite notifications --method realCompletionNotifiesAfterHomeAndRoutesBack` | 由独立 `Phase3BackgroundNotificationTest` 启动真实 Turn 后按 Home，在进程仍存活时接收完成通知；通过实际 PendingIntent 热返回正确线程/Inspector，再关闭 Activity 后验证同一通知的冷 Activity 路由（同进程，不能称进程死亡后推送） |

IME 截图要求真实 `TYPE_INPUT_METHOD` 窗口及非零 insets 连续采样几何稳定，截图后再次检查窗口仍可见。此 Emulator 启用了硬件键盘，旅程临时将系统 `show_ime_with_hard_keyboard` 设为 1，以显示真实软件键盘，并在 finally 恢复原值（原键不存在时删除测试值）；产品代码不强制修改用户输入法偏好。首次回复截图还要求非空本机未发送草稿下 `canSend` 恢复，证明原生终态之后的 snapshot 已校正；仅出现 assistant 回复和 `canStop=false` 不代表已收敛。

`NotificationInstrumentedTest` 另覆盖渠道、隐私、immutable intent、跨实例去重和 resolved 取消等确定性边界；这些合成事件测试与上表真实模型旅程应分开报告。撤销通知权限可能导致系统杀进程，应由外部 ADB runner 单独执行并记录，不在活跃真实 Turn 中隐式改变权限。Emulator Home 后进程仍存活的提醒不证明 force-stop、系统回收、锁屏 Doze 或厂商省电下保证送达。

真实前台和后台通知旅程使用独立类和 `--suite notifications`，不使用 Compose 的 ActivityScenarioRule：原生 PendingIntent 可能替换 Activity，旧规则对过期 Activity 的 teardown 会产生测试基础设施异常。新旅程通过 Android 生命周期监视器观察实际 RESUMED/STOPPED，且只在显式清理完成后记录成功；不得把旧 teardown 失败记录改写为成功。前台旅程另保存 `foreground-notification.json` 与 `08c-notification-foreground.png`，整体通过仍须以对应 JUnit runner 的成功结果为准。

正向 fileChange 旅程不合成审批、不改用 command 通过、不调用 ViewModel 的响应 API 代替按钮。请求时保存非敏感 `filechange-approval-request.json` 的唯一 marker；成功必须另有 runner `OK`、审批前后真实截图和 `native-filechange-approved.json`。外部 runner 在本轮临时项目只读检查 `phase3-approved.txt` 恰好为该 marker 与换行；没有真实 pending 或上下文校验不完整时按失败/未覆盖记录，并保留请求等待审查，测试不擅自取消或重发。新增方法本身不代表已执行。

若真实稳定 API 在请求批准前没有提供对应 fileChange Item 的完整内容，5a 必须保留失败/未覆盖。单独运行 5b 验证安全降级：要求同一 current endpoint、checkpoint project/thread 和原 pending Turn 的 user message 中包含已保存唯一 marker；只能拒绝/取消该原请求。证据另用 `native-filechange-missing-evidence-blocked.json`、`07e`/`07f` 截图及独立 runner 日志；不得覆盖 5a 失败日志或称其为正向批准成功。外部 runner 只读检查测试文件未产生，并对比 fixture operation/turn 集合确认没有替代 Turn。

## 3. SAF、文件与故障

测试 APK 自带 `Phase3DocumentsProvider`，只有生成的测试文件。它通过 Android DocumentsUI 被选择，需真实 Content URI 临时授权，主 APK 不存在选择器绕过开关。测试根名称为 **Phase 3 test files**，文件包括 `phase3-note.txt`、32×32 PNG、30 MiB 超限文件和无法打开的 URI 样本。所有测试输入由测试包缓存提供，不能浏览宿主机用户目录。

文件旅程使用 `--suite files`。确认取消不上传、选择器真实返回文件、上传进度/完成、原生 Turn 附件认领、图片预览、授权主机文件下载/预览/分享。过大文件与不可读 URI 必须在派发上传前失败。故障代理只修改隔离实例流量：

`authorizedHostPreviewAndSystemShare` 通过真实 Android Sharesheet 选择仅测试 APK 提供的 **Phase 3 share receiver**；测试 APK 另有一个 activity-alias 候选便于观察系统选择过程。若系统直接启动接收器，报告必须记录 `shareRouting=direct_receiver`，不得声称已观察 chooser 或手选；只有真实选择流程记录 `resolver_selection` 并保存 `14b-system-sharesheet-receiver-choice.png`。接收 Activity 使用独立应用 UID，从实际 `EXTRA_STREAM` Content URI 读取全部 131 字节，核对固定内容与 SHA-256，以及 READ grant 存在、WRITE grant 不存在；结果只写入测试包私有非敏感 receipt，instrumentation 通过 Debug `run-as` 读取并校验新时间戳。接收器由纯 Java/Android API 实现，不出现在主 APK，且不请求持久授权、不尝试写入。保存接收器截图后点击返回，确认原应用预览仍可用。早期 `14b` 与 `files-host-preview-share-final.txt` 仅证明下载、预览及 Sharesheet 展示；没有接收器的那次运行不能称为跨应用内容传递验收。

工具与附件认领旅程在发送前记录已有 message ID，完成条件要求新 assistant ID 且无客户端错误，避免复跑时误用旧固定回复标记。严格断言的新增不代表再次执行了原生 Turn；执行结果仍以对应 runner 日志为准。

正常顺序为 `safCancellationThenRealDocumentAndImageUpload` → `safOversizeAndUnreadableUriDoNotUpload` → `explicitTurnClaimsReadyAttachments` → `authorizedHostPreviewAndSystemShare`。然后分别注入下表两种下载故障，每次运行 `damagedDownloadNeverBecomesPreview`，输出文件分别命名以保留两次结果。上传未知单独运行 `lostUploadAcknowledgementRetainsUnknown`，恢复 online 后运行 `originalUploadReceiptReconcilesWithoutReupload`；前后独立比较 fixture status 中 upload 操作 ID/数量，不能仅以 UI 成功提示判断未重传。

| fixture stdin 控制 | 用途 |
| --- | --- |
| `{"command":"corruptNextDownload"}` | 下一次成功 `/files/ID/content` 正文首字节变化，原完整性头不变；客户端必须拒绝摘要不符且不保留可分享文件 |
| `{"command":"truncateNextDownload"}` | 下一次成功文件正文中断；客户端不得将部分文件当作完整成果 |
| `{"command":"dropNextWriteResponse","path":"/android-phase3/api/v2/threads/THREAD/attachments"}` | 真正上传到 Gateway 后丢应答并断网；上传 unknown 保留，不能重新上传 |
| `{"command":"dropNextWriteResponse","path":"/android-phase3/api/v2/threads/THREAD/turns"}` | 真正 Turn 派发后丢应答；同时验证附件认领 unknown 和原 operationId 对账 |

上述下载故障是受控代理注入，不代表正式生产网络自然故障。`scripts/android-v2-fixture.test.ts` 检查故障只触发一次、响应损坏后正常请求仍工作，以及写入恰转发一次。

## 4. unknown 与恢复顺序

1. 先完成上传丢 ACK → 原上传回执校正，留下 **恰好一个 ready 附件**。从 checkpoint 读取本轮 Thread ID，保存 fixture `status` 为 before。对本轮 Turn 路径设置 `dropNextWriteResponse`，运行 `lostAcknowledgementShowsDurableUnknown`：真实 Turn 与附件认领同时产生 unknown，原附件 ID 必须为 held。
2. 代理保持离线，记录 `status`；用 `adb shell am force-stop dev.oraculum.poc.debug` 再启动 instrumentation 方法 `unknownSurvivesProcessRestartWithoutResend`。同一操作 ID 和同一 held 附件 ID 均须保留。不得 `pm clear`。
3. fixture 发送 `{"command":"online"}`，运行 `unknownReconcilesOnlyWithOriginalReceipt`。只有原回执 accepted 后，原 held 附件才成为 sent 并离开当前草稿，附件 unknown 消失。再次保存 `status`，独立比较操作 ID 集合、`attachment.upload` / `turn.start` 数量、原生 Turn 数量；应没有重传或重发。真实回复标记为 `P3_ACK_ONCE`。

其他恢复旅程已使用独立 `Phase3RecoveryJourneyTest`，helper 选择 `--suite recovery`，仅使用 Phase 3 私有输入与 checkpoint，完全不读写 Phase 2 测试数据。可在 unknown 旅程前执行；每项用独立输出文件保存：

| fixture / runner 前置步骤 | Recovery 方法 | 检查 |
| --- | --- | --- |
| fixture `offline` | `offlineCacheDraftAndNoWrite` | 原线程缓存可读、发送/停止/恢复均禁用；编辑本机草稿并只读核对 Room 已落盘，保存恢复 checkpoint |
| fixture `online`，可在此前 force-stop 重启 Debug 进程 | `onlineRestoresOriginalThreadWithoutSendingDraft` | 恢复同一线程与离线草稿，不 resume，不发送 |
| fixture `restartGateway` 后 | `newEpochRequiresExplicitResume` | 新 epoch 先只读历史；确认 `canResume=true`、`canSend=false` 和无新 Turn，再点击真实 Resume；只增加一次明确 `thread.resume` |
| 正常在线 | `invalidHistoryAndEventCursorsResetReadOnly` | 独立原生客户端仅请求未签发历史 cursor 和越界 WSS seq，真实 Gateway 拒绝/要求 reset，不改 UI 或原生历史 |
| 按下述 ready/trigger 屏障推进受控时钟 | `issuedAccessRenewsAfterControlledExpiry` | 已签发 access 过期后，以原配对身份只读刷新续期；保持同一线程/草稿/unknown 集合，无副作用重试 |

access 测试必须先启动该单方法并等到 Debug 私有 `files/phase3-evidence/phase3-access-expiry-ready.json` 出现 `ready:true`，此时 access 已签发；再发送 fixture `{"command":"expireAccess"}`，最后以 ADB 创建 **非敏感触发文件** `no_backup/phase3-access-expired`。例如在确认 ready 和 fixture 控制成功之后执行：

```bash
adb -s "$ORACULUM_ADB_SERIAL" shell run-as dev.oraculum.poc.debug touch no_backup/phase3-access-expired
```

测试只接受 90 秒内的外部触发；不会自行推进时钟或重新配对。每次 instrumentation 进程启动与额外只读客户端可能签发 access，受真实活动 token 限额约束。若为释放过期 grant 先用了另一次 fixture `expireAccess`，必须单独记录其目的；不能把预先推进时钟后新建 session 误称为“已签发 token 过期续期”，也不修改生产限额。CLI 撤销可独立回归，但不能将未执行的 Phase 2 旧测试列为本轮通过。

永久 unknown 若原回执和原生事实均不足，必须继续显示一级阻塞状态。离线、404、重建缓存或主观确认均不能解除。

## 5. 证据与清理

截图由 `uiAutomation.takeScreenshot()` 从真实 Emulator 获取，保存于 Debug 私有 `files/phase3-evidence/`。使用 helper `collect --output ...` 导出并逐张检查，不生成、拼接或编辑 UI 像素。APK、日志与原始证据放在 `.local/`，不提交 Git；报告记录 APK 大小、SHA-256、内嵌 sourceGit/sourceDirty 与真实执行命令。

完成后执行 `remove-test-input`，只移除本轮 E2E 私有输入；移除本轮 ADB reverse；fixture `stop` 输出最终报告及 Codex config hash 保全结论。保留 app 身份、草稿、unknown、正式 Codex 历史、Stitch 和签名材料。Phase 3 Task 保持 In progress 等待独立审阅。
