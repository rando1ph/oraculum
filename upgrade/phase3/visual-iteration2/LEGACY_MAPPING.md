# Phase 3 Iteration 2｜旧版交互与原生 Android 映射

开工基线：`c1a78e52caf79144bda6aba3ef7d0de8da77b92a`。本表是实施前的源码与设计核对，**“本轮落点”表示实施要求，完成情况与设备证据另见本轮交付报告**。

正典：[Iteration 2 正式任务](https://app.notion.com/p/4165421e690b81308f13da32581c9e54)、[Oraculum 2.0](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[六组反馈与八图审阅](https://docs.google.com/document/d/1Cwg-3mGpaIp5hGYczW0zVOERo0-Fn8M3oEV8pT6fBfQ/edit)。最新任务已授权实施，覆盖问题文档较早的“仅记录”阶段说明。旧 Web/Bridge 只作交互参考，不引入 WebView/CSS/React，不迁移旧状态。

## 1. 六组意见到实现的映射

| 反馈 / 旧版行为与证据 | 2.0 开工现状 | 真实能力 / 数据边界 | 本轮落点或明确降级 |
| --- | --- | --- | --- |
| **主对话：Composer「+」**。旧 [main.tsx](../../../apps/web/src/main.tsx) 1076–1088 的 `more` 菜单实际只有“添加图片或文档”；项目切换/添加在相邻 `project` 菜单。原 [05 主对话设计](../../../design/reference/05_Android_Conversation_Main_v0.2.png) 还画有图片、文件夹与 @ 图标，不能据此声称全是已实现原生能力。 | `OraculumScreen.kt` 的附件图标直接启动选择器，项目浏览入口在导航。 | 已有 Gateway 上传、主机目录/注册、项目文件查询/下载；Android 已有相应回调。没有任意 Codex 命令入口。 | 「+」打开真正动作菜单，包含本机图片/文档与已实现项目/文件入口；复用现有授权、上传状态与系统选择器。不要只换图标；不添加无对应契约的 @、插件执行、斜杠命令。 |
| **主对话：品牌与内部提示**。旧 `OracleLogo` 与品牌文案构成视觉焦点；Stitch 主对话顶栏只有导航/Inspector。 | 自绘眼睛；右上角有重复设置；正常 HTTPS/WSS、原生校正文字占据界面。 | 品牌是本地资源，状态来自现有连接/恢复逻辑；缩短文字不能改变安全判断。 | 用户 SVG 完整版用于大品牌，紧凑版用于小尺寸。设置只留导航；正常连接轻量展示，协议细节留连接页；异常、离线与 unknown 继续可访问。正式 Launcher 不动。 |
| **设置：强调色与三主题**。旧 [themes.tsx](../../../apps/web/src/themes.tsx) 有 Trusted CSS 主题选择，`tokens.css` 有 accent token；当前旧源码未发现独立强调色选择器。Stitch [设置稿](../../../upgrade/stitch_oraculum_android_workspace/oraculum_2.0_3/code.html) 明确设计了“强调色与动态配色”。 | 原生 Light/Dark/OLED 以 `FlowRow` 按内容宽度换行；只有阅读字号，没有强调色偏好。 | 完全属于 Android 本地 ColorScheme/DataStore，不需要 Gateway；动态配色并非强制范围。 | 按已批准需求补齐持久化强调色与统一主题选择组。普通宽度同组呈现，小屏/大字可适配；验证文字与容器对比度，OLED 背景保持纯黑。不要写成“已核实旧版有调色滑杆”。 |
| **设置：头像与昵称**。旧 [identity-ui.tsx](../../../apps/web/src/identity-ui.tsx)、[identity.ts](../../../apps/web/src/identity.ts) 将用户/助手头像与昵称一起预览、保存；图片有类型/大小/解码限制，损坏时默认头像仍可见，身份不发 Bridge。 | 只有两个昵称输入框和保存，消息使用通用用户图标/品牌图标。 | Android SAF/系统 Picker → 有界解码 → 应用私有存储；与服务器身份、审批主体及 Codex 配置无关。 | 恢复昵称和头像的可视关联、选择/移除/默认回退、进程恢复；取消选择不清旧头像，外部 URI 失效不破坏身份显示。无需复制旧 localStorage 或照搬 Web 裁切器。 |
| **设置：Gateway 与缓存**。连接属于日常入口；缓存是可恢复的本地存储。 | `SettingsPanel` 将“重新连接”“刷新原生状态”“清理可重建历史缓存”平级放置。`PocViewModel.clearCache()` 调用 `local.cache.clearAll()`，然后刷新当前读取视图。 | 清理作用于本机缓存 DB 的全部记录，包括其他连接的缓存；草稿/回执在独立 state DB，Codex 历史不被删除。它不是解除 unknown 的手段。 | 日常按钮缩短为连接/重连/刷新；缓存移入存储/高级入口并确认，解释全设备缓存范围及离线历史需要重新下载；保留草稿、配对、未知操作。 |
| **Inspector：MCP 优先**。旧 [extensions.tsx](../../../apps/web/src/extensions.tsx)、[bridge/extensions.ts](../../../bridge/src/extensions.ts) 将名称/状态本地化，MCP 查询是真实接口；旧 Plugins 曾调用 `plugin/list`。 | 扩展按 `skills/mcp/apps/plugins` 呈现，`enabled/callable` 和原因码直接混入正文。 | 新 Gateway [extensions.ts](../../../gateway/src/extensions.ts) 已有 MCP/Skills/Apps 只读摘要，逐节可用性独立；Plugins 明确返回稳定性未验证，**不继承旧 `plugin/list`**。 | MCP 优先且名称明确；用简洁人类状态、工具/资源数和受限提示，详情按需展开。未稳定开放的 Plugins 明示暂不可用，不渲染内部原因码，不增加安装/启用/执行控制。 |
| **Inspector：Token 与缓存图形**。旧 [usage.tsx](../../../apps/web/src/usage.tsx) 有紧凑数值、输入/输出构成条、缓存率；缓存输入是输入子集，推理输出是输出子集。 | `InspectorProjection` 仅将真实 token 事件格式化成长字符串；没有结构化图形。 | 已透传 `thread/tokenUsage/updated`，具有数据时可展示 `total/last/modelContextWindow`。累计 Token 不等于当前上下文占用；Gateway 没有账户额度读取契约。 | 紧凑绝对数值；仅当 `input > 0` 且 `0 ≤ cached ≤ input` 时计算缓存率；仅在输入/输出/总计关系成立时画构成。不得将累计 total 除以窗口容量伪装上下文占比，不伪造账户额度或未知的 0%。 |
| **权限与模型：底部选择**。旧 `main.tsx` 1090–1110 先显示模型/effort 摘要，再选择选项，模型说明没有常驻挤占整个面板；权限也从 Composer 打开。 | 模型/权限复用右侧面板，模型长列表把 effort 推到下方。 | Gateway `model/list` 与已有支持 effort 交集；权限是下一次请求的 preset，回读是独立事实。 | 原生 Material 3 ModalBottomSheet；当前模型与 effort 靠近、列表可滚动、系统返回/IME 正常；“下次选择”与“最近已确认”分开。Full access 保留明确确认；不增加 schema 外的 effort。 |
| **真实审批**。旧 [native-request.tsx](../../../apps/web/src/native-request.tsx) 与原 [06 审批](../../../design/reference/06_Android_Operation_Command_Approval.png)、[07 Diff](../../../design/reference/07_Android_Operation_File_Diff.png) 是具体请求，不等同权限预设。 | 已有独立 `NativeInteractionPanel` 和完整 fileChange 证据校验。 | 只允许真实请求的 supported decisions；epoch/generation/operationId 及单次占用继续生效。 | 可用 BottomSheet 或适合完整证据的安全容器；完整路径、移动目标、Diff、缺证据禁批准与待确认禁重复响应保留。不照抄静态稿“总是允许”。 |
| **消息：完成后整轮折叠**。旧 [process.tsx](../../../apps/web/src/process.tsx) `groupTurns/TurnProcess` 按原生 Turn 分组；只有 completed 且无待审批才自动折叠。最终答复、未知 phase 的 agentMessage、异常过程继续可见。 | 按 item 卡片单独折叠，缺少整轮摘要；角色投影未保留 commentary phase。 | 原生 Turn ID/status 与 item phase 已在历史/事件数据；UI 投影不能成为执行状态权威。 | 按 Turn 汇总已完成过程，默认最终回答可见；运行/审批/失败/中断不被成功摘要藏住。展开仍能逐项看真实过程，历史分页不把同一 Turn 拆成重复摘要。 |
| **消息：时间与耗时**。旧 `process.tsx:26–40` 用原生 durationMs，或 completedAt-startedAt；普通消息时间在当前旧 `content.tsx` 未找到独立渲染，原 reference/05 与 Stitch 主对话稿明确有时间。 | `HistoryProjection` 丢弃时间，Turn 元信息只保留 status。 | 当前 Gateway 原生 Turn JSON / native.state 可包含时间；独立 message 的创建时间不保证存在。event 接收时间只表示本机观察时间。 | 优先保留并显示实际原生时间/耗时；仅有 Turn 起止时应标明其语义，不把接收时刻伪称原生消息时间。缺失时省略或简短说明，不能把命令 duration 求和当整轮耗时。 |
| **消息：已知用量**。旧 Web 用量页接收 Bridge `NativeUsage.thread`，不是每条消息都拥有独立 Token。 | 只有 Inspector 临时 token 字符串，消息摘要没有关联用量。 | `thread/tokenUsage/updated` 带 threadId/turnId；`last` 与 `total` 语义不同。旧 `account/usage/read` 不能自动移植为新公开能力。 | 仅按原生 ID 将 last 用量挂到对应 Turn；事件缺失/截断/不匹配则显示未知，不跨 Turn 借用或均摊。累计与单轮量明确区分。 |
| **空状态**。旧 [brand-copy.ts](../../../apps/web/src/brand-copy.ts) 根据无项目、未建会话、新建空会话、既有空会话给出品牌文案；`main.tsx:1032–1041` 为 Logo/品牌/标题/行动的整体构图。 | 正文“准备就绪”靠上；首轮未物化历史的正常状态重复出现在横幅与 Composer。 | 空状态不需要写操作；新建仍必须明确点击。已接受新建但尚无历史与“读取失败”必须区分，不能以无历史推断 unknown 成功。 | 完整 SVG + 品牌标题 + 一句引导，按有无项目/线程给出明确入口；恢复原有文案关系与居中留白。只隐藏已知正常提示；异常、安全屏障仍可见，不自动建线程或发送。 |

## 2. 值得保留的旧版细节

- `process.tsx.isProcessItem` 仅将 `agentMessage.phase === commentary` 认定为过程，未知 phase 默认保留答案；`needsAttention` 使非零退出码、失败 MCP/动态工具、子代理错误不随成功过程一起隐藏。
- `TurnProcess` 的展开状态属于本机阅读偏好；原版展开/收起还补偿滚动位置。Compose 应保留稳定 native ID 与阅读锚点，避免完成自动折叠后突然滚到错误位置。
- `usage.tsx.tokenSplit` 要求 `input + output === total`；缓存与推理分别为各自子集。即使原生数字有效，也不应堆叠相加造成重复计数。
- 旧身份设置完全本地化。新 Android 头像应同样不进入上传附件、Gateway 请求、原生消息或通知敏感正文；原 SVG 仍是没有自定义 AI 头像时的品牌回退。
- 旧空状态文案是“万象俯首，静候神谕。”“谕章初启，诸界屏息。”“万象无疆，诸界未名。”“谕令未书，万象屏息。”；输入提示“意志将临…”，新建行动“启封神谕”。文案只作呈现，不取代错误或审批。

## 3. 能力证据与明确停止线

能力依据为当前 [Gateway adapter](../../../gateway/src/codex.ts)、[service](../../../gateway/src/service.ts)、[历史投影](../../../gateway/src/history.ts)、[Phase 3 能力矩阵](../CAPABILITIES.md)，而非旧版“曾调用过”或静态设计“画出来了”。本表没有额外启动 App Server 探针；真机运行时证据由本轮主交付记录。

1. Gateway adapter 禁用实验 API并限制方法白名单。`turn/start`、`turn/interrupt`、thread start/resume/read/list、历史、模型及既有扩展只读能力可沿用；旧 Web 的 steer、fork、revert、review、compact 等没有现成 2.0 公共写契约，本轮不借「+」菜单虚构入口。
2. `service.nativeNotification` 已有 `native.state` 对 turn/started、turn/completed、thread/tokenUsage/updated 的有界转发；历史页保留原生 Turn JSON。先扩展 Android 的可替换显示投影；确需 Gateway 小增量时须指向被丢失的真实字段、保留原生来源并测试，不能生成新事实。
3. MCP/Skills/Apps 可读与 Plugins 生产稳定性是不同结论。新 Gateway 对 Plugins 已设停止线；旧 Bridge 的 `plugin/list` 只说明旧实现，不构成恢复授权。MCP 超时与空目录也不得混写成“没有 MCP”。
4. 正常状态文案精简不等于放开写入；「对账过严」须单独复现 scope/receipt/原生读取/传输问题。未知结果不自动重发、不换 operationId、不清回执；本表不预判根因。
5. Stitch 的型号、百分比、耗时、私有样例目录、审批选项是设计占位，不能复制成产品数据。保留系统字体与原定 Light/Dark/OLED 设计；不移植四套旧 CSS 主题或增加旧协议兼容。

## 4. 设计输入核对

- 原 `design/reference/05_Android_Conversation_Main_v0.2.png`：宽文本、用户/助手头像、次级时间、过程/文件记录、底部 + / 图片 / 文件夹 / 模型入口；仅作历史视觉证据。
- 定稿 `oraculum_2.0_1/screen.png` 与 `code.html`：紧凑顶栏、用户与助手容器分层、完成摘要、最终回答、底部 + / 权限 / 模型；恢复关系与密度，不复制静态数值。
- 定稿 `oraculum_2.0_3/code.html`：身份头像、MCP/Skills/Apps/Plugins 分类、强调色、阅读字号、简短“重连”及系统通知入口。颜色模式以最新批准的三种为准，静态“跟随系统”不自动成为额外交付项。
- 原件保持在既有路径。本表没有修改 design/reference、Stitch 原稿、用户 SVG 压缩包或 Launcher 资源。
