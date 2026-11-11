# Phase 3 视觉整改 Iteration 1｜工程报告

报告日期：2026-11-12。**本轮视觉整改已完成实现，最终 Debug 构建来源为 `ba4ead96f68d8d3464528c97a541e44b768dfb19`，内嵌 `sourceDirty=false`。** 本地图标、导航/对话/Inspector 层级与公共组件已落地，构建、lint、129 项 JVM、14 项系统仪器测试及下列真实旅程已有通过证据。26 张最终构建的真实 Emulator PNG、视觉索引和产物 manifest 已上传本轮 Drive 目录。最终构建的 15 个实际旅程及 14 项系统仪器测试通过；fixture 的全局 Codex 配置指纹检查存在独立异常，见第 5 节。**子任务与 Phase 3 母任务保持 `In progress`，最终视觉接受由用户决定。**

依据：[视觉整改正式任务](https://app.notion.com/p/4155421e690b811cae2edc23319d9c91)、[Phase 3 母任务](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc)、[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)。设计规则见 [DESIGN_RULES.md](DESIGN_RULES.md)，能力与定稿映射见 [DESIGN_MAPPING.md](../DESIGN_MAPPING.md)。旧版工程报告、Stitch 原件和第一轮截图保留，不由本轮覆盖。

## 1. 实现与提交

| 提交 | 实现 |
| --- | --- |
| `dceffcf` | 40 个精选官方 Material Symbols Outlined 本地 XML、统一图标 API、原创 Oracle Eye 线条矢量、语义容器与 Shape/排版角色；记录固定上游提交、许可和逐项哈希 |
| `07641bb` | 导航品牌行、按需展开的紧凑本地筛选、项目/会话分组与选中态；用户/助手/执行过程分层；Inspector 状态优先、长 ID 展开/复制；设置、模型/权限、代码、文件/附件和审批卡统一图标与层次 |
| `d744a56` | 修复真实附件/成果预览触发的 `Canvas: trying to use a recycled bitmap`：移除三个 UI bitmap 的提前 `recycle()`，由 GC 在绘制引用释放后回收；解码尺寸与文件安全边界保持 |
| `ba4ead9` | 修复 200% 字号旅程的测试同步：等待字体配置改变后新 Activity 的 RESUMED、已附着窗口及旧 Activity 销毁，再进行 Compose 操作；仅修改测试，不改产品生命周期 |

主界面见 [OraculumScreen.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt)，Inspector/设置等面板从该文件提取至 [WorkspacePanels.kt](../../../apps/android/app/src/main/java/dev/oraculum/poc/ui/WorkspacePanels.kt)。提取只组织 UI，没有增加执行层或状态权威。中央 Composer 保留附件、权限、模型、发送/停止动作；搜索仍只筛选已加载列表，不冒充全局搜索。

代码、Diff 与用量保留 64Ki 字符/256 行预览保护及截断提示；长代码可展开当前有界预览。文件修改审批仍完整显示允许范围内的全部路径、移动目标与 Diff，缺少绑定证据时不开放批准。Inspector 原生错误不因折叠 ID 而隐藏；用量仅展示实际返回字段，最终用量截图如实显示“当前原生状态尚未提供 token / 上下文用量”，没有填入样例值或推算百分比。

## 2. 已验证结果

证据根目录：`.local/evidence/oraculum-p3-visual-iteration1/`。每个真实旅程按前置状态单独执行；重复的截图/复测日志不累加为不同测试。未把上一轮 854 项仓库测试计成本轮重新执行结果。

| 检查 | 本轮结果与证据 | 覆盖边界 |
| --- | --- | --- |
| Android Debug 构建 | 最终系统 CA 交付构建 `BUILD SUCCESSFUL in 22s`；最终 fixture CA 主/测试 APK 构建 `BUILD SUCCESSFUL in 1m 25s`，见 `logs/final-delivery-build.log`、`logs/final-emulator-build.log` | 从已提交干净源码生成；日志是增量构建，不称为全量 clean rebuild |
| JVM / lint | **129/129**，0 failure/error/skipped；lint **0 error、18 warnings** | 不把 warnings 写为零；不代替运行旅程 |
| 系统仪器测试 | `final-system.log`：**OK (14 tests)**（最终 ba4ead9 构建） | 持久化、Keystore、通知、附件保留/取消等系统边界；不外推真实后台必达 |
| 真实连接与稳定状态 | `initial.log`、`final-settled.log`：各 **OK (1 test)** | 隔离 Gateway/官方 Codex、专用项目与原生线程；最终稳定状态确认不是重新发送 |
| 导航与本地筛选 | `final-navigationFilterStaysLocalAndReversible.log`：**OK (1 test)** | 搜索展开/关闭、已加载边界、会话与草稿保留 |
| 三主题、面板与真实 IME | `final-panels.log`、`final-themes-ime.log`：各 **OK (1 test)** | Dark / Light / OLED、导航/Inspector 与软件键盘；同一方法的复测不重复计数 |
| 设置、模型/权限及代码 | `final-settingsModelPermissionAndCodeEvidence.log`：**OK (1 test)** | 来自真实 Activity/状态；Full access 确认展示后取消，不改变实际权限 |
| 200% 字号与横屏 | `final-largeFontActionsRemainReachable.log`、`final-landscape.log`：各 **OK (1 test)** | 关键控件可达、中文操作语义及 48dp 触控目标；TalkBack 未实听 |
| 工具、Diff 与扩展 | `tools.log`：**OK (1 test)** | 当前真实原生能力；没有由示例设计推导新增 API |
| 附件上传、实际认领、成果分享 | `files-upload.log`、`final-attachments-claimed.log`、`final-preview-share.log`：各 **OK (1 test)** | 真实 SAF/文件与 native Turn 认领；预览初次 recycled-bitmap 失败记录保留，修复后预览/分享复测通过 |
| 200% 字号原生审批 | `final-native-approval-font200.log`：**OK (1 test)** | 实际原生审批的 cancel 路径；不代表 fileChange 正向批准能力已证明 |
| 上传 unknown 与原回执对账 | `final-upload-unknown.log`、`final-upload-receipt.log`：各 **OK (1 test)** | 上传原回执恢复为 ready，未重新上传；操作数核验见下文 |
| Turn unknown / 重启 / 原回执 | `final-turn-unknown.log`、`final-unknown-process-restart.log`、`final-turn-receipt.log`：各 **OK (1 test)** | 进程重启后原 operation 与 held 附件仍在；仅原回执解除屏障 |
| 离线与恢复 | `final-offline-draft.log`、`final-online-restore.log`：各 **OK (1 test)** | 草稿持久化、禁止写入、恢复原线程，未自动发送草稿 |
| 图标、原件与静态复核 | **40/40** 图标 XML/分发哈希、许可哈希通过；**15/15** Stitch/品牌原件哈希保持；`git diff --check` 通过 | 无新增 TTF/OTF；原 Screen 与提取 Panels 动作引用无增减，既有 testTag 无删除 |

设备为 **`emulator-5554` / API 36 / 1080 × 2400 / 420 dpi**。截图与自动化证明的是该模拟器环境，不代表物理手机、蜂窝网络、厂商后台限制或用户视觉接受。200% 画面中附件仍通过横向滚动查看；真实审批出现的原生通知横幅按实际状态保留，没有修图移除。

## 3. 安全与保留边界

本轮未修改 Gateway/Codex、ViewModel、Repository、协议、Room/DataStore/Keystore、文件授权/校验、通知或恢复逻辑。Bitmap 修复限于 UI 像素生命周期，仍保留图片/PDF 的尺寸、文件大小与资源关闭约束。Unknown 继续保留发送屏障，只提供原回执查询、只读状态核对及停止确证活动 Turn；没有重发或强制解除入口。Full access 仍明确确认，文件修改审批仍要求原生完整绑定证据。

系统 Sans / CJK fallback / Monospace、Dark / Light / OLED Dark、正式 App PNG 和阅读字号偏好保持。没有重新生成 Stitch、引入字体包、迁移旧状态或新增后台服务。没有正式签名/发行，没有变更生产 Gateway、VPS、Caddy、SSH、systemd 或网络配置，也未启动 Phase 4。

## 4. 最终 Debug APK 与视觉交付

最终源码 SHA：`ba4ead96f68d8d3464528c97a541e44b768dfb19`。最终文档提交可能在此之后；APK 的源码身份以包内 `assets/oraculum-build.json` 为准。

| 产物 | 身份与位置 |
| --- | --- |
| 可审阅 Debug APK | [Google Drive APK](https://drive.google.com/file/d/1QMtF5OPSG5bOV_p1uQZyMZC03_GWS2uf/view)；本机 `oraculum-ba4ead9-debug.apk`；**14,820,984 bytes**；SHA-256 `110417f05c3a827454763c77fa273138d8be7cdf5e86869bd26a1dc60c4b468a` |
| 构建 manifest | [Google Drive manifest](https://drive.google.com/file/d/1hO_jC8JrBNoUipQCs5WbMjL2yG10ieKs/view)；本机 `oraculum-ba4ead9-debug.json`；`sourceDirty=false`、`dev.oraculum.poc.debug`、版本 `0.1.2` / code `4`；仅系统 CA，无正式发行签名 |
| 模拟器回归包 | 本机 `oraculum-ba4ead9-emulator-debug.apk` 及同名 JSON；包含本轮隔离 fixture CA；与交付包分别归档，不能混称同一字节产物 |
| 真实 PNG | 最终 `ba4ead9` 已重新采集并上传 **26 张**至 [Visual Refinement Iteration 1](https://drive.google.com/drive/folders/1Q0-1wjg7atr5iEoCqn1nQxcsxJvPPTH6)；不覆盖第一轮图片 |
| 视觉索引 | [本地 VISUAL_REVIEW.md](VISUAL_REVIEW.md) / [Drive 视觉索引](https://drive.google.com/file/d/1xAVljly_ast4ObzOiosNjEjVTcwCY0qD/view)；逐项包含链接、SHA-256、Build/设备身份和 Stitch 映射；[ARTIFACTS.json](ARTIFACTS.json) / [Drive manifest](https://drive.google.com/file/d/1plpIAKWPbboCf2Y_I0veVIKPIa6WkHOK/view) |

APK 与 manifest 的 Drive 文件已更新为上述最终构建，旧中间构建不作为本轮交付身份。原图未经拼接、修图或生成替代；工程检查通过与图片上传不等于用户已接受视觉。

## 5. 对账、清理与配置完整性边界

本轮受控丢弃 **2 个真实写响应**。从开始 unknown 测试到对账结束，Gateway 只增加 **1 个 attachment.upload 和 1 个 turn.start**，均为 accepted；原生 Turn 数从 **4 增至 5**。进程重启没有新增 operation。其后的离线/恢复旅程没有新增 operation 或原生 Turn。证据为 `unknown-status-before.json`、`unknown-status-after.json`、`final-fixture-status.json` 及对应日志；公开报告不复制专用原生会话 ID。

隔离 fixture 已停止，`cleanupErrors=[]`；仅移除本轮私有测试输入与两条 ADB reverse，保留应用身份、草稿、回执和专用原生线程。模拟器 `font_scale=1.0`、硬件键盘显示 IME 偏好 `0` 均恢复；15 份保留原件再次校验一致。没有遗留本轮 fixture 进程。

**独立异常：fixture 的最终全局配置指纹检查未通过。** 此前 unknown 对账后的状态仍为 `codexConfigUnchanged=true`，最终为 false，fixture 按原规则返回 `result=failed` / exit 1。全局 Codex 配置 mtime 为 2026-11-12 05:01:55（北京时间）；本轮没有覆盖或还原它，未修改完整性检查，也不将 fixture 总体状态写成通过。只读日志已定位到并行 Codex Desktop（另一 app-server 进程）的配置活动：05:01:19 同步 openai-bundled，05:01:23 调用 config/batchWrite，05:01:55 同步 openai-primary-runtime；最后的 marketplace/add 请求、配置 mtime 和成功事件在同一毫秒窗口。用户确认没有手动调整设置。日志将上述请求归属到 Desktop 进程；本轮 Android/Gateway 未增加或调用此配置写入路径。batchWrite 参数未出现在日志中，且未重建开工时的完整配置字节，因此不能确认全部变化键，也不将异常全部归结为两项市场配置。原始失败结果及脱敏时间线保留在本地证据中。Android UI 旅程、操作计数和 PNG/构建身份的结果与此检查分别报告。

产品实现提交已正常推送至 `origin/main`，Build SHA 为 `ba4ead96f68d8d3464528c97a541e44b768dfb19`。最终文档与完整截图索引随单独文档提交发布，完整提交 SHA 和本地/远端一致性结果记录在 Notion。该外部配置变动作为独立核验边界保留，不改写 fixture 的失败状态。关键通知使用任务私有地址；最终发送结果记录在 Notion，不把地址写入仓库。

子任务与 Phase 3 母任务继续 `In progress`，等待用户第二次视觉审阅，不标记 Done，不进入 Phase 4。
