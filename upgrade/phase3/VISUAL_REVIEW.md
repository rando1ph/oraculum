# Oraculum 2.0 Phase 3｜视觉审阅索引

日期：2026-11-12。状态：**In progress，等待 Randolph 独立视觉审阅**。自动化结果不代表视觉接受；Phase 4 未启动。

验收目录：[Phase 3 Android 视觉验收](https://drive.google.com/drive/folders/1Goib8sSQzkKOb_z-lSC7MdaZcIJ0pIGY)。保持原有私有权限，没有创建公开链接权限。20 张 PNG 共 3,395,628 字节，均直接上传本机原图，未裁切、拼接、修图或重新生成；其余 16 张仍保存在本机原目录。

## 设备、来源与源码身份

- 设备：`emulator-5554`；AVD `codex_api36_aosp`；Android API 36 / x86_64。竖屏 1080×2400，横屏 2400×1080；部分图展示 200% 系统字体。compile/target SDK 35，min SDK 26。
- 原始目录：`.local/evidence/oraculum-v2-phase3/screenshots/`。由真实 Android Emulator 的 ADB/仪器测试采集，使用专用测试线程/文件；图中 `/tmp/...` 是隔离 fixture 项目，不是用户私有项目。无配对码、访问令牌、密码或私钥。
- 本次交付源码 SHA：`ab90769430616c6e9290b3acb52ca2942ac6b8df`。Clean Build 15 主 APK 内嵌 `sourceDirty=false`；同次 `clean --no-build-cache` 重建主 APK 和测试 APK。交付 APK 使用系统证书信任，不包含一次性 fixture CA。
- **截图沿用既有历史旅程，未在 Build 15 上重拍。** 表内 build12/13/14 由既有旅程日志支撑；未记录构建编号的只标为历史旅程。历史截图未嵌入逐图 Git 身份，部分捕获时有未提交修正，因此单图精确 `captureSourceGit` 为未记录，不能冒称最终 SHA 或 clean build。APK 源码身份与截图来源分别记录。
- 设计基准为原封不动的 `upgrade/stitch_oraculum_android_workspace/`，下面的 Stitch 目录对应 [DESIGN_MAPPING.md](https://github.com/rando1ph/oraculum/blob/main/upgrade/phase3/DESIGN_MAPPING.md)。当前 12 原件哈希与 Phase 0 基线一致。

## 代表性原图

三主题使用同一专用线程、相同可见回复和草稿；其他图保留真实运行状态。04 仍在只读校正；08b 是后台完成通知点击后的同进程新 Activity/VM，不能证明进程死亡后送达。07 是命令审批历史画面，07e 是后续缺证据文件审批安全阻断。20 是故意触发 TLS 拒绝后的离线缓存，不是普通联网成功图。

| 原图链接 | 真实状态 | 历史旅程 | Stitch 对应目录 | 像素 / 字节 | 原图 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| [02-theme-dark.png](https://drive.google.com/file/d/1t3WXBx19tqP438ikFq4ltR1g1ZKfN0Ah/view?usp=drivesdk) | Dark 主对话，同一线程与内容 | build13 | `oraculum_2.0_1` | 1080×2400 / 192218 | `413f320e78b79a09bc43d98f7152459072aa2aeec89fbe44deb9a29748734e7f` |
| [02-theme-light.png](https://drive.google.com/file/d/13YaWyhUKb24ElJqaACfXPELHuZSSCjJV/view?usp=drivesdk) | Light 主对话，同一线程与内容 | build13 | `oraculum_2.0_1` | 1080×2400 / 192593 | `4d0e08e028c3e1498c59ef255fbfc414d7f0e86fdefa2982dee13179e17646ba` |
| [02-theme-oled.png](https://drive.google.com/file/d/1G2iWeifqnlux1NIEM4X_6Hez_8atYldt/view?usp=drivesdk) | OLED Dark 主对话，同一线程与内容 | build13 | `oraculum_2.0_1` | 1080×2400 / 191661 | `37694ea9d693aef0d455308c43d9affdab3488fff375d8a71d40276edb906b78` |
| [03-navigation.png](https://drive.google.com/file/d/1Pxum-27WJs3CDxUrCxGy59U5l3HpYMgn/view?usp=drivesdk) | 左侧项目/会话导航，专用临时项目路径 | build13 | `oraculum_2.0_2` | 1080×2400 / 133639 | `58688a3037f1e9bc324777933d409f79c2331fb7017ad8b24826a924e2034055` |
| [04-inspector.png](https://drive.google.com/file/d/15RckQonvDl5XGFYNGZFSTk6fQ9sx7GRW/view?usp=drivesdk) | 右侧 Inspector 输出页，截图时仍在只读校正 | build13 | `oraculum_2.0_right_inspector_3` | 1080×2400 / 141319 | `25a5e571d6ae0f62bfd30e9e8fa0f4695d4ac368955a667ece0fed2bd3f20352` |
| [05-native-ime.png](https://drive.google.com/file/d/1cJ5vq55841pcY4X80Aqxtc0CfLQ3YLAT/view?usp=drivesdk) | 原生 IME、聊天背景及可见 Composer/发送按钮 | build13 | `oraculum_2.0_1` | 1080×2400 / 202812 | `9970f4c9fa1d6a000055f3710cbb5a1db68b01d4326b7b2a0356d187849dab2a` |
| [06-landscape-large-font.png](https://drive.google.com/file/d/1GozASWBsotjMTlx3VxjYFkoYnX2rszxX/view?usp=drivesdk) | 横屏、系统字体 200% 与 Inspector | build13 | `oraculum_2.0_right_inspector_3` | 2400×1080 / 196710 | `5b82e1c78cf72733a3550b95aa1560be734fc401ffb3f9949fba23c9464463db` |
| [07-real-native-approval-cancel.png](https://drive.google.com/file/d/1efTmfu3BLIxtb3lJg2SA66T9j5Rqu8B_/view?usp=drivesdk) | 真实命令审批；本轮测试选择取消 | historical journey | `oraculum_2.0_4` | 1080×2400 / 155439 | `25b9649a193082aa299bc1abd0fca28be6aa3bed862c7553107536d84016470f` |
| [07a-real-diff.png](https://drive.google.com/file/d/1koNiayOHsAEC_i6RAABi1KmFyA4UNFvU/view?usp=drivesdk) | 真实原生 Diff；测试项目文件 | historical journey | `oraculum_2.0_right_inspector_3` | 1080×2400 / 106809 | `5cc963d240de268837295ce0bddac0c9188897feb63d9e5100307862c69a6e6a` |
| [07b-real-usage.png](https://drive.google.com/file/d/1mKWWalV4w96gFZDyegzWNxmfMzvGu9g-/view?usp=drivesdk) | 真实 token/context 用量；账户额度未公开 | historical journey | `oraculum_2.0_right_inspector_3` | 1080×2400 / 118768 | `1c9d3bdd5f9e75f9a48ad9f5e667306db9bc4f3fc9d6ed504af47656379ef572` |
| [07e-filechange-evidence-unavailable.png](https://drive.google.com/file/d/1WX7JPM-ZrRsSjlfxacom3toI0BTkbVIx/view?usp=drivesdk) | 原生文件审批缺完整证据，禁止正向批准 | build13 | `oraculum_2.0_4` | 1080×2400 / 219855 | `06e7eceb231b7def35580be70fc70a39948cdb3924b0309819f7c60c931118d3` |
| [08b-notification-cold-activity.png](https://drive.google.com/file/d/1_wNdWMbSdhiJ_9BTWjB2E3W-TLLORTjT/view?usp=drivesdk) | 通知点击后，同进程新 Activity/VM 定位 Inspector | build14 | `oraculum_2.0_right_inspector_3` | 1080×2400 / 142128 | `99e59aef28629e5c8cfc98974265e8c283917a9e0d868d385969a31868357694` |
| [09-unknown-details.png](https://drive.google.com/file/d/1YTm7UsXcXcLIscL4P6y10Zjhe-sBCgak/view?usp=drivesdk) | 丢 ACK 后 unknown/附件认领屏障，离线保留草稿 | historical journey | `oraculum_2.0_1` | 1080×2400 / 297297 | `ac72a5599ceb05b27ff600b5e3a72a4a5b22343059e35ae82e6fb4dae01afb99` |
| [11-saf-uploaded-attachments.png](https://drive.google.com/file/d/1ncUHv2jrevImxpPZ0hxj-E3hIf5a0-fE/view?usp=drivesdk) | 真实 SAF 文档/图片已上传、尚未认领 | historical journey | `oraculum_2.0_1` | 1080×2400 / 195224 | `b22ffbe35bdcd2a3775e300d8aa49f417cf4923a83f3cff3c50384ae8f84fbf8` |
| [14-verified-host-preview.png](https://drive.google.com/file/d/1w3_wWShTs3IUXik2O2qHvqooHnLda5Zo/view?usp=drivesdk) | 授权主机文件列表、131B Markdown 摘要验证与预览 | build12 | `oraculum_2.0_right_inspector_1` | 1080×2400 / 175549 | `af7864c56c155f16220383d5ece2a1f9c19d4f36f20ceb6bcc2a02c5f95609cf` |
| [14b-system-sharesheet-receiver-choice.png](https://drive.google.com/file/d/1f9WNu4Jb0SBrMOiVve0M59cUjeHZ73yU/view?usp=drivesdk) | Android 原生 Sharesheet 明确选择测试接收器 | build12 | `oraculum_2.0_right_inspector_1` | 1080×2400 / 125915 | `51c80f355a6ff85a163f6a07bb835c5d564b57ae5539ed2b0cbeec3f2541dd8a` |
| [14c-verified-share-receiver.png](https://drive.google.com/file/d/1t6X1b_EhWjUQRV8py0h183jDdCmelUSS/view?usp=drivesdk) | 独立 UID 接收器读取 131B 并核验摘要/只读 URI | build12 | `oraculum_2.0_right_inspector_1` | 1080×2400 / 45756 | `acf551ed3d5dae3624a43b5a033e5da79aa64479678c747dc71dd4d1a90be982` |
| [17-notification-permission-prompt.png](https://drive.google.com/file/d/15WhuYdgGy3xLcFy3pHeBzijpqRoHRYMc/view?usp=drivesdk) | 系统通知权限弹窗；背景为真实主题/别名设置 | historical journey | `oraculum_2.0_3` | 1080×2400 / 131041 | `87679b8a6f07ce18e12e4f81e783585e1dcaae1d76743e30e3299bfd38dd4269` |
| [20-offline-draft-readonly.png](https://drive.google.com/file/d/1j9jeN9VAw3SXU72OI850xp2aMK1yzTUu/view?usp=drivesdk) | 受控 TLS 拒绝后离线缓存、草稿保留、禁止发送 | historical journey | `oraculum_2.0_1` | 1080×2400 / 240478 | `26d22721f6a0c06d9878d433d6a084d33185f394672fb50d0f1774cc971ce7e4` |
| [22-epoch-explicit-resume-required.png](https://drive.google.com/file/d/1-y1p2xExktHFLkLP01AonkepbZI1iY_4/view?usp=drivesdk) | epoch 变更后必须显式恢复，未自动发送草稿 | build14 | `oraculum_2.0_1` | 1080×2400 / 190417 | `cad7316d405066bd7f68262e8b66431af60ac4c0acf91a1e20bfea7258848f26` |

## 工程证据与限制

沿用既有证据：仓库 854/854（73 文件）、JVM 129/129（17 suites）、系统 instrumentation 14/14、后台通知完整旅程 1/1（80.726s）、lint 0 error / 14 warnings。本次只重新构建 APK，没有重复运行以上测试。完整日志与边界见 [Phase 3 工程报告](https://github.com/rando1ph/oraculum/blob/main/upgrade/phase3/README.md)。

fileChange 正向批准 E2E 仍因 Codex 稳定待审快照缺少完整路径/Diff 而未通过；07e 展示安全阻断，原请求安全取消已通过。TalkBack 实听、物理机/蜂窝、Doze/强杀/厂商后台、PDF/Office 外部接收器、真实双设备审批竞争未验收。现有 36 图没有单独完整覆盖模型/effort/权限菜单、完整设置页或所有扩展变体；本次依用户要求复用原图，不把这些画面写成已视觉验证。

明显设计差异：使用原生系统字体；移动面板为中文和触控放宽内容区；宽屏为对话与 Inspector 并列并保留导航抽屉；自定义图片头像编辑未实现。是否接受这些实际画面由 Randolph 审阅决定。

## Clean Build 15 APK 对照

| 产物 | 字节 | SHA-256 |
| --- | --- | --- |
| `oraculum-phase3-build15-androidTest.apk` | 1161792 | `550b57206ab4cb998953a4e1ff5d3086427cb0b8202f651cef00f22d006c6266` |
| `oraculum-phase3-build15-debug.apk` | 13900999 | `26d4532e2df897f1bc4dfea2633a9f09d2e656e4d461abec58c14b3ce60cf187` |

APK 本机位置：`~/Projects/Oraculum/.local/artifacts/oraculum-v2-phase3/build15/`；本 Drive 目录交付 PNG 和本文，不上传 APK。测试 APK 没有独立内嵌 sourceGit，由同次干净构建日志和产物 manifest 绑定源码 SHA。
