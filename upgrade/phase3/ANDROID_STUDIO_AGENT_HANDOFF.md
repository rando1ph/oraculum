# Android Studio Agent Mode｜视觉精修 Handoff

只做 Android 原生 UI 视觉精修。先读根 [AGENTS.md](../../AGENTS.md) 和本文，再等待用户逐页、逐项指定要求，不自行启动整体重构。当前依据为 [Oraculum 2.0 正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134) 与 [本次交接任务](https://app.notion.com/p/4165421e690b81589ee1dff073a30e27)。

## 项目入口

- 仓库：`~/Projects/Oraculum`。Android Studio 打开 [apps/android](../../apps/android)，即含 `settings.gradle.kts` 的 Gradle 项目，应用模块为 `app`。
- Android 是 Kotlin + Jetpack Compose 原生客户端；Gateway 是独立后端，本轮不处理。Activity 入口：[MainActivity.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/MainActivity.kt)。

| Compose 文件 | 视觉职责 |
| --- | --- |
| [OraculumScreen.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumScreen.kt) | 主工作区、左右面板承载、导航、空状态、消息、Composer。 |
| [WorkspacePanels.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/WorkspacePanels.kt) | 模型/权限选择、Inspector、设置与恢复面板。 |
| [OraculumTheme.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumTheme.kt) | Light / Dark / OLED Dark、强调色、字体层级和形状。 |
| [OraculumComponents.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumComponents.kt) | Surface/卡片层级、间距、形状和分组标题。 |
| [OraculumIcon.kt](../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumIcon.kt) | 现有 Material Symbols Outlined 与 `OracleEyeMark` 品牌组件。 |

## 视觉参考

Stitch 定稿原件：`~/Projects/Oraculum/upgrade/stitch_oraculum_android_workspace`，只读保留，不移动、改名或覆盖。先看本轮核心页面：

| 相对该目录的文件 | 对照内容 |
| --- | --- |
| [matcha_terminal/DESIGN.md](../stitch_oraculum_android_workspace/matcha_terminal/DESIGN.md) | 设计系统与 Matcha 色彩。 |
| [oraculum_2.0_1/code.html](../stitch_oraculum_android_workspace/oraculum_2.0_1/code.html)、[screen.png](../stitch_oraculum_android_workspace/oraculum_2.0_1/screen.png) | 主对话、消息与 Composer。 |
| [oraculum_2.0_2/code.html](../stitch_oraculum_android_workspace/oraculum_2.0_2/code.html) | 左侧导航；原件没有 PNG。 |
| [oraculum_2.0_3/code.html](../stitch_oraculum_android_workspace/oraculum_2.0_3/code.html)、[screen.png](../stitch_oraculum_android_workspace/oraculum_2.0_3/screen.png) | 设置。 |
| [oraculum_2.0_right_inspector_1/code.html](../stitch_oraculum_android_workspace/oraculum_2.0_right_inspector_1/code.html)、[screen.png](../stitch_oraculum_android_workspace/oraculum_2.0_right_inspector_1/screen.png) | 右侧 Inspector、文件与成果。 |
| [oraculum_2.0_right_inspector_3/code.html](../stitch_oraculum_android_workspace/oraculum_2.0_right_inspector_3/code.html)、[screen.png](../stitch_oraculum_android_workspace/oraculum_2.0_right_inspector_3/screen.png) | Inspector 用量。 |

- 品牌原件：[用户批准的 Oracle Eye LOGO ZIP](https://drive.google.com/file/d/1qRvZ9IywsUhv8zjfjc-Ge3Uyx3C6MYH8/view?usp=drivesdk)；仓库原 SVG 为 [完整 outline](../../design/brand/oracle-eye-user/oraculum_oracle_eye_outline.svg) 与 [compact](../../design/brand/oracle-eye-user/oraculum_oracle_eye_compact.svg)。复用已集成的 [oracle_eye_full.xml](../../apps/android/app/src/main/res/drawable/oracle_eye_full.xml) / [oracle_eye_compact.xml](../../apps/android/app/src/main/res/drawable/oracle_eye_compact.xml) 和 `OracleEyeMark`，不重绘或覆盖原件，不改正式 App PNG 启动图标。
- Iteration 2 一加 6T 实际成品：[33 张真机截图的视觉索引](https://drive.google.com/file/d/13_ywLBLl6QnPoaYhe3meE7MCsi_LkVXV/view)、[交付文件夹](https://drive.google.com/drive/folders/1RFMOnE7UJHXPF98NL4213ul1Ui3trLdK)；仓库对应 [VISUAL_REVIEW.md](visual-iteration2/VISUAL_REVIEW.md)。这是历史视觉基线，不代表 Beta 1 重新截图或用户已接受。
- 用户逐图问题与意见：[Oraculum 2.0｜Phase 3 用户体验问题记录](https://docs.google.com/document/d/1Cwg-3mGpaIp5hGYczW0zVOERo0-Fn8M3oEV8pT6fBfQ/edit)。结合 Notion 当前视觉优先级和用户本轮指示使用。

## 当前视觉方向

- **美观第一**：品牌识别、排版层级、视觉重心、色彩与图标语言、组件密度、空间节奏、跨页面一致性。
- Material 3 Expressive 是基础，不机械堆叠默认 Card、大圆角和模板化组件。品牌强调色为 Matcha Green `#74A12E`；沿用现有三配色及语义 ColorScheme，兼顾对比度与已有强调色偏好。
- 保留系统 Sans/CJK fallback 与 Monospace，不新增打包字体；Stitch HTML 的外部字体、脚本不作为 Android 实现依赖。
- Stitch 是重要视觉参考，结合用户最新逐图反馈判断，不固化成不可调整的像素规范。不得擅改产品方向或信息架构；明显冲突或重大设计取舍先向用户展示判断，等待指示。

## Agent Mode 工作边界

- 仅修改 Compose 视觉层及实现视觉效果所必需的局部 UI 代码。不新增产品功能，不改变既有功能语义、导航/信息架构、Codex 交互、安全状态或数据行为；保留左导航 / 中央对话 / 右 Inspector，不新增底部导航栏。
- 不改 Gateway、协议、状态机、数据库、网络、签名、Release 或生产部署；不为视觉简化绕过 unknown 写入保护、审批或真实能力限制。
- 每轮按用户指定页面/项目精修，完成后提供真实 Android Emulator 或已连接一加 6T 的截图供用户审阅；测试前先确认设备实际在线，保留现有应用数据与配对，不用网页 mockup 代替 Android 成品。
- 按根 AGENTS 在唯一 `main` 提交、验证和回写；已发布 Beta 1 tag、Release、安装包及校验资产保持不变，后续修改进入新源码提交和未来 Beta。Phase 3 及本交接任务保持 `In progress`，等待用户审阅，不自行 Done 或进入 Phase 4。
