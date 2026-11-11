# Oraculum 2.0 Phase 3｜最终交付索引

日期：2026-11-12。**Phase 3 保持 In progress，等待 Randolph 独立视觉审阅；Phase 4 未启动。** 本次只完成现有文档推送、一次干净构建、原图交付、定向清理和记录同步，没有重新开发或重跑全套测试。

## 源码与构建

- 构建源码：`ab90769430616c6e9290b3acb52ca2942ac6b8df`（已正常推送的原有文档提交），主 APK 内嵌 `sourceDirty=false`。
- Clean Build 15：2026-11-12 03:12:21–03:13:19（Asia/Shanghai），退出码 0，58.782 秒，Gradle **BUILD SUCCESSFUL in 58s，77/77 tasks executed**。
- 命令：既有隔离 JDK/SDK/Gradle 环境下 `gradle -p apps/android --no-daemon --console=plain --no-build-cache clean :app:assembleDebug :app:assembleDebugAndroidTest`。没有运行测试任务或安装新 APK。
- 原 Build 14 两份 APK 已先备份至 `.local/evidence/oraculum-v2-phase3/build14-apks/`；旧日志、报告和 36 张原图保留。
- 正式 Application ID 保持 `dev.oraculum.poc`；本次主包为 `dev.oraculum.poc.debug`，版本 `0.1.2-debug` / code 4；测试包为 `dev.oraculum.poc.debug.test`。
- 两份 APK 均通过 `apksigner verify --verbose --print-certs`。仅 AGP Debug 签名，公开证书 SHA-256 为 `e4bb888b2c73da57e9484e5a9e2a792e733902cdf102c847228c044d93b1b1fb`。未使用正式签名材料。
- 本次不设置 `oraculumDebugCa`，包内确认没有一次性 fixture CA；使用系统证书信任，主机名校验保持启用。Origin 为空、Base Path 为 `/`，没有用户生产端点硬编码。
- APK 内只在主包包含 `assets/oraculum-build.json`；测试包由同次 clean 构建、构建日志与本表 SHA 绑定，不声称测试包有独立内嵌 Git 身份。

## APK 与机器可读清单

路径均相对于 `~/Projects/Oraculum/`，文件不进入 Git。

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| `.local/artifacts/oraculum-v2-phase3/build15/oraculum-phase3-build15-androidTest.apk` | 1161792 | `550b57206ab4cb998953a4e1ff5d3086427cb0b8202f651cef00f22d006c6266` |
| `.local/artifacts/oraculum-v2-phase3/build15/oraculum-phase3-build15-debug.apk` | 13900999 | `26d4532e2df897f1bc4dfea2633a9f09d2e656e4d461abec58c14b3ce60cf187` |
| `.local/artifacts/oraculum-v2-phase3/build15/manifest.json` | 2013 | `214437acfeed0d3ae03fe2f844ff7863355ed4d725b1d2fbe47f74be0d5e76ce` |
| `.local/artifacts/oraculum-v2-phase3/build15/SHA256SUMS` | 206 | `8d524500cc9969866574f26ef70bb3ce93365cbb75a86e90b4755c4f54541a52` |
| `.local/evidence/oraculum-v2-phase3/android-clean-build-15.txt` | 6404 | `876a1e00ebdaf0a9bbe5f3d60df1469d4d037cea555ce17fae349b4fae9aaf44` |
| `.local/evidence/oraculum-v2-phase3/build15-execution.json` | 590 | `e92ba85158f3bed12d0407aa2ed7e0ec0c6fe5ba5ea74164fea785746af9d17c` |

## 视觉交付

[Google Drive 私有验收目录](https://drive.google.com/drive/folders/1Goib8sSQzkKOb_z-lSC7MdaZcIJ0pIGY) 已实际回读 **21 个文件：20 张 PNG + VISUAL_REVIEW.md，共 3,405,888 字节**。20 张 PNG 为现有 36 张中的原字节精选，共 3,395,628 字节；名称、大小、父目录与权限已逐一核对，均只有 owner，没有 anyone/domain/group 分享。未更改原权限。

- [Drive 上的 VISUAL_REVIEW.md](https://drive.google.com/file/d/1BqHxDsAqmPUj_Tf7VF2tx-MRaN5oyW_F/view?usp=drivesdk)，本地同文见 [VISUAL_REVIEW.md](VISUAL_REVIEW.md)。10,260 字节，SHA-256 `f9f937c0230f245a9d2a8a7b828370d402d395a052799892433a4ce8ff8308ec`。
- 每张 PNG 的真实链接、状态、字节数、像素、SHA-256、历史构建和 Stitch 页面均在视觉索引中。
- 截图来自历史真实 Emulator 旅程，没有在 Build 15 上重拍。历史图缺少逐图 Git 身份；不能将最终构建 SHA 冒充捕获时 SHA。模型/effort/权限菜单、完整设置页和全部扩展变体没有独立完整截图，仍待人工验证。

## 保留的测试证据

以下为此前已完成测试，本次没有重复运行。只读复核结果：仓库 854/854（73 文件）、JVM XML 129/129（17 suites，0 failure/error/skipped）、系统 instrumentation 14/14（1.788s）、后台通知完整旅程 1/1（80.726s）；lint 0 error /14 warnings。原生 fileChange 正向批准失败日志保留，缺证据禁止批准及安全取消通过；不将安全降级写成正向成功。

| 既有证据（`.local/evidence/oraculum-v2-phase3/` 下） | SHA-256 |
| --- | --- |
| `android-integration-build-14.txt` | `f0837349e035f73da87bbee644fe88d391751f8bfc11c728b0c51178fe272b84` |
| `android-system-instrumentation-final.txt` | `3d4a4bdf1504c86e9a759f05ec3a4327cb5a301c8e3e23ceeec2aa8a37cf2dae` |
| `build14-reports/TEST-dev.oraculum.poc.ArtifactDownloadPolicyTest.xml` | `d547d09e076f0a75d52f4eeb79cc86e3a4f7be69af0409a93b4e6b9a8f7556ae` |
| `build14-reports/TEST-dev.oraculum.poc.AttachmentPickerPolicyTest.xml` | `5fc8c0fdb05c1bac56b18b01910a6afaa52fcbd94f42714532d7b229b86fd34d` |
| `build14-reports/TEST-dev.oraculum.poc.ServerEntryTest.xml` | `f03bd7296bc48d62ef360bdf699c64ba8c9cbc98dd83fc58b47d6c13ff14d990` |
| `build14-reports/TEST-dev.oraculum.poc.files.FileTransferPolicyTest.xml` | `1b734b63fbf67cf7721b8049a982ecd44ff90c5229ab9839bea4efe332e948b4` |
| `build14-reports/TEST-dev.oraculum.poc.files.PreviewCacheTest.xml` | `f6363b2d2cac15f2cf04727c939833ca19cef05c0caf47b8b9be61c789879baa` |
| `build14-reports/TEST-dev.oraculum.poc.gateway.GatewayClientTest.xml` | `6ca0153be131f7f0f62682c0deab42b1a8b9fbf645178109527c9d5f552c6e40` |
| `build14-reports/TEST-dev.oraculum.poc.notifications.NotificationPolicyTest.xml` | `75f79248c45b26385e2aab4e704ef68745b1e0b0376c7281ad2c3fe319b0a904` |
| `build14-reports/TEST-dev.oraculum.poc.repository.FileChangeApprovalContextsTest.xml` | `9ca99112acdc67a9e3abe14f1dbd1fbdd5b81b8c431d79924083447ea26e1b77` |
| `build14-reports/TEST-dev.oraculum.poc.repository.FirstTurnPermitTest.xml` | `d148157f0f86e8f1bcebe0ff06713236b54266ee28e8bdf2f626f983e332c1d0` |
| `build14-reports/TEST-dev.oraculum.poc.repository.InspectorProjectionTest.xml` | `1a31f3d6f012e52dac6a40a4b4273606fc3d2a779e261217d433eae4d4b8769e` |
| `build14-reports/TEST-dev.oraculum.poc.repository.NativeInteractionFormsTest.xml` | `6479942c12a3757551dd43e35d396c9943dd8e1ded9cdc2c1645be2e80a46cab` |
| `build14-reports/TEST-dev.oraculum.poc.repository.NativeReadDiagnosticsTest.xml` | `83ee7e4101ad85f44a85bcfec309a9be7a655baaaabfa06289a46a85917ad3f3` |
| `build14-reports/TEST-dev.oraculum.poc.repository.NotificationNavigationTest.xml` | `32eee20be8086452f69b8d587a81e87e6cbd337731853f13055d45ce779d6290` |
| `build14-reports/TEST-dev.oraculum.poc.repository.PermissionReadbackTest.xml` | `f8da98fe171ba2dba6be42bc834d6a05faabe3fb6222c9ff4d2d8b70524d0d5d` |
| `build14-reports/TEST-dev.oraculum.poc.repository.RecoveryRulesTest.xml` | `b333a531d527bc9ef5315fdaa74289e70fa1b5f43674c9d6adcc49b8faf792cc` |
| `build14-reports/TEST-dev.oraculum.poc.repository.WritePreparationTest.xml` | `f4256b8714245888c45c5f2a79974e46be02d13b9fdd8458df9b2361fba747ce` |
| `build14-reports/TEST-dev.oraculum.poc.ui.MarkdownContentTest.xml` | `698890dcfaf780e6029ffa0c4fd86ecd4e60d555c3c6867f8f9dde1e9ade05f4` |
| `build14-reports/lint-results-debug.xml` | `1f943d52cdaedf785720beecb45d7f6548af30e723e312818197cc6dc2e1a9c5` |
| `native-background-notification-continuation.txt` | `55ee83a8c725b4020f306428ee0ff18b0afcae17c34302084a20d6099babcd4f` |
| `native-file-change-approval.txt` | `91b0a10d0b7fecfb355325eed4b1425102ae2a3efed6188e7089d1ce32eb63e7` |
| `native-file-change-safe-cancel.txt` | `13f0a6356619fde59e98a770a06078e66125bedf5958405c3920e6d7159bd923` |
| `repository-tests-final.txt` | `97a599fcc55e114fba958eb422f60a6208d5ed5f1d86b769a2b89dba9de07daf` |
| `typescript-check-final.txt` | `1e3c8f2ef072147d227296d25eebd5ff6b2a54c94783b6a6c6bfb580b96e6069` |

## 定向清理与保全

03:20:57 确认 fixture 进程不存在、40995/40149 无监听，再通过既有 helper 删除 `dev.oraculum.poc.debug` 的 `no_backup/phase3-e2e.json`，仅移除对应两条 ADB reverse。回读映射为空，`oraculum-v2-identity` 保留。没有 pm clear、卸载、删除 Room/草稿/回执、清理 Codex 原生数据、停止其他进程或删除测试证据。

初始 fixture 正常停止报告仍在，cleanupErrors=[]。此前被中断的 continuation 没有 graceful-stop 报告，其临时目录在本次清理前已不存在；本次依据进程/端口确认停止，没有重建 fixture 或补造停止报告。最后保存的 status 显示 13 个 Turn、2 次显式 resume、3 次 upload、3 次 interaction.respond；这些是历史保存值，不是本次重新查询原生结果。

本次只读重算 Codex config 与初始基线一致，12 个 Stitch 文件的路径/字节/SHA 与基线一致；25 份既有报告及 36 张 PNG 的 SHA 全部保持。长期签名材料及其他服务未参与本次操作。

| 最终归档证据 | 字节 | SHA-256 |
| --- | --- | --- |
| `.local/evidence/oraculum-v2-phase3/finalization-cleanup.json` | 860 | `8a59831ce66320be3f8686304bcd364754e5578307f42075343090b1aed54bc0` |
| `.local/evidence/oraculum-v2-phase3/drive-final-list.json` | 4975 | `460933f1755a892da77576fd0f2513bd9d716262b3e7d755e8ebcc10bf2d4207` |
| `.local/evidence/oraculum-v2-phase3/visual-selection.json` | 14870 | `b9f7f05e49c29bdd452dd6aeb871fd97732247c34f551ee9037cff328712e73a` |
| `.local/evidence/oraculum-v2-phase3/screenshots-original-inventory.json` | 5152 | `2486afdb42e49af41193ac60ffec8f5b8b9c8beddb18da7d5f07249d5aa4825d` |
| `.local/evidence/oraculum-v2-phase3/preserved-evidence-sha256.json` | 3348 | `93cba02ee939226de0d4da72c312e6fbea152f146b28a98bc6bf5ffe7c74d059` |

## 同步与审阅边界

本索引、视觉索引与 README 的最终提交只包含文档，Android/Gateway 产品源码与构建 SHA `ab90769` 无差异。文档提交的完整 SHA、HEAD/origin/main/实时 GitHub 一致性及最终 Drive/Notion 回读写入 Notion Task 和 `.local/evidence/oraculum-v2-phase3/finalization-verification.json`，不在文件内容中循环嵌入自身提交 SHA。

[Phase 3 Notion Task](https://app.notion.com/p/4155421e690b81d1bea3d08e5b1008dc) 保持 In progress。已知限制继续保留在 [README.md](README.md)：正向 fileChange 缺原生证据；TalkBack/物理机/蜂窝/Doze/强杀/厂商后台、真实双设备竞争、PDF/Office 外部接收器及所有 input/Plan/子代理变体未全覆盖。工程交付与 Randolph 的视觉接受分别记录，不自行进入 Phase 4。
