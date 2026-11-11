# Phase 3 视觉整改 Iteration 1｜统一设计规则

本轮依据 [视觉整改正式任务](https://app.notion.com/p/4155421e690b811cae2edc23319d9c91)、[既有设计映射](../DESIGN_MAPPING.md) 和只读 Stitch 定稿实施。它是已授权原生界面的整改规则，不新增能力、不替代用户视觉验收。

## 主要问题与落地方式

| 原有问题 | 本轮规则 |
| --- | --- |
| 导航标题泛化、筛选字段挤占首屏 | 品牌行和项目/会话分组承担导航结构；搜索入口按需展开，明确仅筛选已加载列表；新建为单一主操作 |
| 所有消息/状态像相近的大色块 | 用户、助手、执行摘要和代码使用不同语义表面、轮廓及内边距；过程先摘要、详情按需展开；正文保留阅读空间 |
| Inspector 长 ID 主导画面 | 先显示状态、内容和真实计数，ID 用系统等宽小字、截断显示，提供完整展开与复制；不省略真实错误或数据 |
| 大量文字按钮缺少识别线索 | 统一使用本地 Material Symbols Outlined；图标与文字并排时只读一次，独立图标按钮提供中文操作标签 |
| 设置、审批、文件缺少共同节奏 | 同一套分组标题、卡片语义、图标尺寸、触控目标与排版；审批容器表示待响应，错误独立使用错误色 |

## Surface、形状与密度

ColorScheme 保留现有 Matcha Dark / Light / OLED Dark 及定稿色值。补齐 tertiaryContainer、surfaceVariant、inverse 等角色，避免未指定组件落入默认紫色色系。OLED 根背景保持纯黑，实际内容容器仍有递进色阶。

| 公共组件角色 | 表面 | 形状与用途 |
| --- | --- | --- |
| `Content` | `surfaceContainer` | 24dp，助手正文、Inspector 内容与设置分组 |
| `User` | `surfaceContainerLow` | 左上 8dp、其余 24dp，降低用户消息视觉重量，同时保留清晰边界 |
| `Process` | `surfaceContainerHigh` | 16dp，执行摘要和已处理交互；应保持紧凑，不重复使用主卡高度 |
| `Inset` | `surfaceContainerLowest` | 12dp、1dp outlineVariant，用于代码/细节深层平面 |
| `Attention` | `secondaryContainer` / `onSecondaryContainer` | 24dp，仅用于需要用户响应的交互；普通审批不是错误，不能统一标红 |

公共 `OraculumCard` 默认内边距 16dp、子项间隔 8dp，紧凑区域可明确传 `PaddingValues(12.dp)`。页面主要水平间距 16dp，行内间距 8/12dp。抽屉/面板外轮廓 28dp；不使用大阴影、霓虹边框或额外动态背景。设置、文件等密集列表应优先共享分组容器和行间距，避免每项都变成独立大卡。

## 排版与图标

继续使用 Android 系统 Sans / CJK fallback / Monospace，无 TTF/OTF、远程字体或 CDN。面板标题 20/28sp，主要标题 18/24sp，行标题 16/24sp，正文 16/24sp、次正文 14/20sp、元信息 12/16sp；已有阅读字号与系统字号行为保持。代码和 ID 使用系统等宽字。

- 常规图标 20dp、品牌/主入口 24dp、分组装饰 18dp；点击区至少 48dp。尺寸是图形尺寸，不可用它缩小触控目标。
- `OraculumIcon(OraculumSymbol, contentDescription, …)` 统一从本地 XML 读取，默认随 `LocalContentColor` 着色；强度来自语义角色，不能另写页面专属色值。
- 装饰图标旁已有文字时 `contentDescription = null`；独立按钮需提供具体操作名称。选中态、运行状态和错误也有文本/语义，不只靠颜色区分。
- 原创 `OracleEyeMark` 将既有品牌的眼眸、瞳环与中央星芒抽象为单色矢量轮廓，随主题着色。它仅用于应用内，正式 App 图标及启动 PNG 原件保持不变。

## 图标来源与许可

官方 [Android Compose Icons 指南](https://developer.android.com/develop/ui/compose/graphics/images/material) 推荐从 Material Symbols 下载 XML 并使用 `Icon(painterResource(...))`。本轮选取 **40 个 Material Symbols Outlined**，24px、FILL 0、weight 400、grade 0，来自 [Google 官方资源库](https://github.com/google/material-design-icons/tree/10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7/symbols/android)，固定源提交 `10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7`。

仅移除 XML 的 `android:tint="?attr/colorControlNormal"`，由 Compose 统一应用当前语义颜色；不修改官方 path/viewport。40 个 XML 共 32,044 字节，无整库依赖。每个源 URL、源文件与分发文件 SHA-256 见 [material-symbols.json](../../../packaging/licenses/android/material-symbols.json)；[NOTICE](../../../packaging/licenses/android/NOTICE-Material-Symbols.txt) 和 [上游 Apache-2.0 许可](../../../packaging/licenses/android/LICENSE-Material-Symbols.txt) 随现有第三方资产任务进入 APK。原创 Oracle Eye 不属于 Google 图标资源，沿用仓库许可。

## 验证边界

资源解析、许可清单和 Compose 构建只能证明工程可用；真实 Emulator 的三主题、IME、横屏、大字号、导航/Inspector/设置与审批截图才用于本轮视觉核对。最终截图索引、构建 SHA 和回归结果由本轮交付报告记录；任务及 Phase 3 母任务保持 `In progress`，由用户亲自作视觉接受结论。
