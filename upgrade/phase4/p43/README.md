# P4.3｜本地持久化、离线体验与桌面交互审阅指南

P4.3 在已验收的 P4.2 上增加可靠的本地阅读与编辑体验。依据：[Oraculum 2.0 正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[P4.3 Task](https://app.notion.com/p/41d5421e690b81f1a436d23dc3f30ba7)、[P4.0 设计基线](../README.md)及 [P4.2 交付](../p42/README.md)。P4.2 已于 2026-11-19 获用户接受，源码基线为 `85b303c1777f50932ade33525eec19880c033683`。

**P4.3 保持 In progress，等待用户审阅。** 本文记录实现、安全边界及分级验收证据；工程交付不代替用户对视觉和日常使用体验的最终接受。测试、性能采样和最终交付构建分别保留来源标识，完整归档见 [validation.json](validation.json)、[live-results.json](live-results.json) 与 [evidence-manifest.json](evidence-manifest.json)。

## 实现入口与数据归属

| 层次与入口 | 职责与边界 |
| --- | --- |
| Gateway / 官方 Codex App Server | 唯一执行与原生会话事实来源；P4.3 不修改其源码、协议、数据库、配置或运行服务 |
| [main/workspace.ts](../../../apps/desktop/src/main/workspace.ts)、[projection.ts](../../../apps/desktop/src/main/projection.ts) | 当前身份、HTTP/WS、事件与 Snapshot 收敛、原生写入和审批条件；本地缓存不能设置这些事实 |
| [credentials.ts](../../../apps/desktop/src/main/credentials.ts)、[connection-preferences.ts](../../../apps/desktop/src/main/connection-preferences.ts) | 系统保护的长期身份；独立保存非敏感 Endpoint、自动连接及退出标记 |
| [journal.ts](../../../apps/desktop/src/main/journal.ts) | 写前持久化原 operationId、作用域、摘要及草稿版本关联；不保存消息正文，不提供自动重发或清除接口 |
| [renderer/store.ts](../../../apps/desktop/src/renderer/store.ts) | Zustand 当前显示状态、异步读取票据、草稿编辑队列、本地保存与回执对账；区分在线状态与只读缓存 |
| [persistence/local-data.ts](../../../apps/desktop/src/renderer/persistence/local-data.ts)、[types.ts](../../../apps/desktop/src/renderer/persistence/types.ts) | IndexedDB 事务、记录校验、版本隔离、草稿 CAS、历史缓存与容量管理 |
| [Conversation.tsx](../../../apps/desktop/src/renderer/Conversation.tsx)、[conversation-scroll.ts](../../../apps/desktop/src/renderer/conversation-scroll.ts)、[Native.tsx](../../../apps/desktop/src/renderer/Native.tsx) | 有界消息渲染、稳定条目锚点、工具折叠与分段展开 |
| [App.tsx](../../../apps/desktop/src/renderer/App.tsx)、[desktop-interaction.ts](../../../apps/desktop/src/renderer/desktop-interaction.ts) | 三栏交互、面板缩放、快捷键、IME 与对话框焦点 |
| [close-guard.ts](../../../apps/desktop/src/main/close-guard.ts)、[ipc.ts](../../../apps/desktop/src/main/ipc.ts)、[preload](../../../apps/desktop/src/preload/index.ts) | 固定关闭保存握手；只传请求标识及保存结果，不传草稿正文或开放任意 IPC |

不迁移旧版 Web/Bridge、Android 或 Gateway 数据。正式 Codex 历史保留在其原有权威端；本地历史是可失效、可清除、可重新读取的显示副本。

## 本地存储与身份隔离

开发与生产 Profile 继续分开，`ORACULUM_DESKTOP_PROFILE` 只接受 slug。同 Profile 单实例；不同 Profile 的 Chromium 存储和 main 文件互不共用。

main 在 Profile 内保留独立的 `appearance.json`、`connection.json`、加密身份及 `operations.json`。Endpoint 包含规范化 Origin 与 Base Path；用户名、密码、查询令牌和非 loopback 明文 HTTP 均不能进入连接配置。长期凭据仍要求 `safeStorage` 的 `gnome_libsecret` 后端；access token 仅在 main 内存。

IndexedDB 使用单库 `oraculum-desktop-v2-local`，schema version 1，按用途划分六个 store：

| Store | 内容 | 生命周期 |
| --- | --- | --- |
| `drafts` | 正文、模型/effort/preset、clientDraftId、revision、提交关联 | 用户编辑数据；不参与历史 LRU，不被清历史或外观恢复删除 |
| `history` / `history-index` | 已载原生历史、显示中的流式条目、上次可见的 Plan/Diff/token 与 LRU 索引 | 可重建显示缓存，不保存审批、权限读回或操作回执 |
| `navigation` | 已访问的项目/会话列表和最后选择 | 以身份隔离的显示导航；恢复只执行选择/读取，不新建会话 |
| `reading` | 原生 Turn/item 键、相对偏移、是否跟随底部、历史 revision | 按会话隔离；用户明确清历史时一并清除该身份的阅读位置 |
| `preferences` | Navigation / Inspector 宽度及 Navigation 可见性 | Profile 的本机布局偏好；主题及 Inspector 可见性继续由 main 外观设置保存 |

身份键包含 **Endpoint（含 Base Path）+ installationId + deviceId**；会话键再包含 projectId / threadId。main 可从加密身份读取仅供显示的 `localScope`，因此断网启动不必依赖一次成功握手才能定位原缓存。该字段不是授权凭据。手动断开保留离线阅读范围且停止自动连接；退出、撤销或安装绑定不符会隐藏原身份显示并保留其本地数据。重新选择其他 Endpoint 不会沿用前一个范围。

记录包含 schema、作用域键和内容校验值。校验用于发现意外损坏，不是密码学身份认证。写入完成以 IndexedDB transaction complete 为准；草稿、阅读位置及布局请求 `strict` durability，显示缓存允许 `relaxed`。升级只增加已知 store；被旧连接阻塞、版本过新、结构损坏及配额失败有分别的错误，不删除数据库来掩盖失败。

## 草稿发送与两个持久化域

IndexedDB 与 main journal 没有跨库原子事务。实现明确保留两个域之间的中间状态，而不是假设一次 IPC 等同一次原子提交：

1. **先保存本地意图。** 每次编辑按会话队列写入；CAS 检查 expectedRevision，成功后递增 revision。发送先把确切 `clientDraftId + draftRevision` 标成 pending，并等待事务完成。只有已保存的这版内容才能送往 main；并发编辑产生的新版本保留。
2. **main 先记账再派发。** main 再次验证当前在线权限、范围、epoch、活动 Turn 和未决操作，将原 operationId 及草稿关联记入 journal，fsync 成功后才用于 Gateway 请求。草稿本地字段不发送给 Gateway。同身份/会话中的同一草稿版本不能获得第二个 operationId，即使第一次已经 accepted。
3. **按原回执核实。** renderer 只用精确匹配的草稿标识、revision 和 operationId 更新本地提交。prepared / unknown 保持 pending。accepted 只清除没有被继续编辑的原版本；rejected 保留正文，并进入可供用户明确重试的新版本。accepted 表示 Gateway 收到请求，绝不表示原生 Turn 已完成。

跨进程崩溃有两种不同恢复：

- IndexedDB 已 pending、main 尚无记录：只读 `checkDraft` 必须读到同一身份的完整 journal，才能返回 `draftDispatch: not-dispatched`。本地据此解除对应 pending；不会自动发送。journal 读失败不能生成该证明。
- journal 已 prepared 或请求可能已发出：继续保留原 operationId，查询原回执。丢 ACK、404、unknown、UI 崩溃或重连都不能转成未发送证明，也不会生成新操作来重放。

保存失败时保留窗口里的编辑并暂停发送。CAS 冲突、损坏草稿或较新数据版本不以“重试保存”强行覆盖；用户可先保留可见文本，再处理本地数据问题。清历史不承担草稿修复，也不清 journal。

## 启动、断线与关闭

启动先恢复 Endpoint 和本地身份显示范围；允许自动连接的配置随后走原 P4.2 身份验证、WS epoch/seq、Snapshot/原生会话及回执恢复。离线导航只显示本机曾加载的内容，标记上次可见时间，可编辑草稿；发送、新建、删除、审批等在线动作不会被缓存解锁。

恢复最后项目/会话只使用读取和选择请求。保存的会话即使不在列表第一页，也会通过 main 按原 ID 直接进行授权读取；仅在项目不可用、会话已删除或不可访问时降级到可用导航，不创建替代会话。不同身份、旧选择或旧异步读取票据的结果不能覆盖新工作区。

关闭窗口先发固定 `onBeforeClose` 请求，等待 renderer 刷新草稿、阅读位置和显示缓存队列。保存失败或 8 秒未收到匹配确认时显示原生对话框，默认取消退出；用户明确选择仍退出才继续。正常关闭不取消远端 Codex Turn，也不清未决回执。

**Ctrl+Shift+0 / 原生菜单恢复内置外观不再重载 renderer**，只发布外观重置事件并恢复本地布局，避免丢失尚在窗口里的编辑。renderer 自身崩溃后的明确“重新加载”只能恢复已提交数据，不能承诺追回未完成事务中的最近输入；突然断电或强制杀进程也有这一边界。没有 Tray 或后台客户端服务。

## 历史、阅读位置与长会话

历史 revision 是 opaque equality token，不按数字或时间排序。只有同一身份/会话、epoch 和 historyRevision 才合并旧页；新原生条目覆盖同 ID 的旧显示，修订变化重建缓存。renderer 提交缓存 cursor 时，main 要求它匹配当前 live revision，返回页仍经过原有 ticket / epoch / revision 校验。旧游标不能成为执行授权。

阅读位置使用 Turn/item 标识加相对偏移，而不是固定 scrollTop。切会话的卸载保存绑定原 scope；当前选择的阅读数据加载完成后才恢复位置。分页前插和条目高度变化按锚点校正；锚点自身缩短时限制偏移。用户向上阅读后，流式输出不会强制拉回底部；“回到最新消息”才恢复跟随。锚点已被原生修订移除或不在缓存内时明确提示并回到最新位置。

长列表只挂载可见区域和邻近缓冲，范围上限为 80 条；另保留正在获得键盘焦点的条目，因此可能为 81 条。小列表保留普通 DOM。工具输出默认折叠，正文、输出与 JSON 以 16,000 字符分段显示；本地展开不触发网络读取，原生缺失详情仍由用户明确载入。审批区域不藏在消息虚拟窗口中。

| 资源 | 实现中的边界 |
| --- | --- |
| IndexedDB 历史缓存 | 整个 Profile 最多 32 个历史条目 / 64 MiB 序列化内容，按 LRU 清除显示条目；单条最大 8 MiB |
| 单会话缓存窗口 | 合并后超过 2,000 个原生 item 时按最旧 Turn 修剪；标注截断，清空无法安全延续的旧 cursor，避免跳过被修剪区段 |
| renderer 热历史 | 最多保留 6 个会话；已保存草稿可按需重读，内存中限制已保存的非当前草稿数量，未保存或待核实草稿保留 |
| 导航 / 草稿 | 导航记录最大 2 MiB；草稿正文上限 100,000 个 JavaScript 字符，实际 IPC 另受 UTF-8 总字节限制 |
| 阅读 / 缓存落盘频率 | 阅读位置批量约 200 ms；显示缓存批量约 500 ms；正常关闭主动 flush，草稿保存独立于缓存批量 |

这些是源码边界，**不是浏览器总磁盘占用或进程 RSS 的保证**；Chromium 元数据、DOM、布局及 main 原生投影另占资源。超过单条缓存预算会报告保存失败而保留旧数据，不会清草稿腾空间。历史清理只影响当前身份的历史、LRU 和阅读位置。事件型 Plan/Diff/token 没有完整历史补读接口；相同 revision 的缓存回显标记“上次可见”，不能视为重新向原生端核实。

## 桌面交互与安全基线

保持 Navigation / Conversation / Inspector、Light / Dark / OLED Dark、完整 Outline Oracle Eye SVG 及原有 Diff 字号。增加面板拖动与键盘调宽、收起/恢复、搜索和 Composer 定位、菜单/对话框焦点恢复、中文 composition / `isComposing` / keyCode 229 发送保护。快捷键及窄窗行为以应用内提示和最终 GUI 记录为准。

P4.2 的 sandbox、contextIsolation、CSP、固定本地资源、主 frame 校验和有限业务 IPC 保持。renderer 不持有长期身份、access token、任意网络/主机路径/shell 能力；缓存不会恢复 pending approval、fileChange 批准证明或 permissionReadback。主进程继续核对原生审批 scope / epoch / generation 和完整证据。附件与文件保持原生选择器及既有字节完整性验证。

真实联调只用现有 Beta 3 的本地 HTTP/WS、原专用 `p42-review` Profile 和获准测试项目/会话。断网、lost ACK、重启/epoch 等破坏性条件使用客户端拦截或 fixture；不停止、重启、替换、升级或另起 Gateway。

## 运行与可重复检查

仓库根目录使用 Node 24 和锁定的 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm exec vitest run apps/desktop/src/main apps/desktop/src/renderer
pnpm build:desktop
ORACULUM_DESKTOP_PROFILE=p42-review pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

需要复用当前主机已验证的 sandbox helper 时，使用 [P4.1 验证环境](../p41/README.md)的开发调用：

```bash
ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
ORACULUM_DESKTOP_PROFILE=p42-review \
pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

这些路径仅描述该主机已存在的开发运行环境，不是产品默认值或安装指令。不使用 `--no-sandbox`，不修改 helper 权限、系统沙箱或 Gateway 服务。

[P4.3 fixture harness](../../../scripts/desktop-p43-fixtures.ts)使用实际 sandboxed Electron / GNOME Wayland、隔离 Profile、Chromium IndexedDB 和生成的业务样本；不连接 Gateway。构建完成后、无其他 GUI 验收并行时运行：

```bash
ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
pnpm exec tsx scripts/desktop-p43-fixtures.ts --output=.local/desktop-p43-fixtures
```

harness 的 `--baseline` 模式可对已经准备好的先前 bundle 运行同一合成负载；不可在正式源码或用户数据上倒退来制作对比。产物含结果、截图、构建 provenance 和性能采样。fixture、真实本机 HTTP/WS、原生 GNOME 操作三类证据需分别标注；合成 1,000 条历史不是向真实 Codex 发送 1,000 次请求。

## 提交与验证记录

| 已推送实现步骤 | 交付 |
| --- | --- |
| [`df9962e`](https://github.com/rando1ph/oraculum/commit/df9962e) | Endpoint / 离线身份、草稿派发关联及关闭恢复 |
| [`093a807`](https://github.com/rando1ph/oraculum/commit/093a807) | IndexedDB 数据隔离、CAS、事务及缓存预算 |
| [`02ef260`](https://github.com/rando1ph/oraculum/commit/02ef260) | 离线工作区、阅读恢复、有界会话及桌面交互 |
| [`9b3b277`](https://github.com/rando1ph/oraculum/commit/9b3b277) | 关闭前等待完整持久化批次、阅读与离线选择恢复收尾 |
| [`f2e7b67`](https://github.com/rando1ph/oraculum/commit/f2e7b67) | 会话图标不再挤占标题、连接中缓存状态的 Composer 文案校正 |

核心功能及真实联调验证源码为 `9b3b2775c2b737545459a72101ad7ccf69cb4198`；视觉收尾源码为 `f2e7b67f08303b8dd2ebce260c97fa43b6a8181a`。后者再次通过类型检查、**23 个文件 923/923 项 Desktop 单测**（其中工作区持久化集成测试 24 项）及 `pnpm build:desktop`，并完整复跑 P4.3 的 31 项 fixture 与 P4.2 的 16 项回归。两份最终 fixture 记录的 renderer manifest SHA-256 均为 `697ac0aa2606c89f2175f58d050291dcd5d853ac045563286d85d4d9fab101d2`。测试 bundle 的 `sourceDirty=true` 来自当时尚未提交的 harness 和交付资料；记录保留该事实，不改写为 clean build。最终清洁构建与 Git 发布信息单独记入 validation，不把早期真实联调和最终 renderer 清单混称为同一字节产物。

| 证据类型 | 已核实结果 |
| --- | --- |
| 源码与 Git | 上述独立实现步骤均在 main 正常提交、推送；最终交付 SHA、远端一致性及清洁重建摘要由 [validation.json](validation.json) 和 Notion 交付记录给出，避免在本文写入自指提交 SHA |
| 类型 / 单测 / 构建 | `pnpm check`、923/923 Desktop 单测及 Desktop 开发 bundle 构建通过；未构建或安装 DEB |
| 实际 Electron fixture | [P4.3 31 项](fixture-results.json)与 [P4.2 16 项回归](p42-regression.json)通过；sandbox、Seccomp、NoNewPrivileges、系统密钥后端及实际 Chromium IndexedDB 已检查，fixture 无 Gateway 流量。覆盖关闭/强退、配额、损坏、阻塞/较新 schema、CAS、unknown、跨 scope、清缓存、输入、焦点和 CSP |
| 长历史 | 相同 1,000 条合成样本的 [P4.2 基线](performance-baseline.json)与 [P4.3 采样](fixture-results.json)保留原始指标，见下表；不把合成数据当作 1,000 次真实 Codex 执行 |
| 真实本机 HTTP/WS | 原 `p42-review` 身份及 24 条 operation 保留；专用测试资源新增会话、命名、一次 Turn，共 27 条。原生 Codex 正确回复；draftRevision 1 被 accepted 后，新编辑草稿仍保留。正常关闭、在线/离线新进程启动、A/B 草稿隔离及重连核对见 [live-results.json](live-results.json) |
| 真实 GNOME/Wayland | 原生 Alt+F4 正常关闭；Rime 组合输入“你好”期间 Ctrl+Enter 未发送，Space 提交文本；Ctrl+K、窄窗 Ctrl+I / Esc 焦点恢复、Ctrl+Shift+0 保草稿重置经真实 ydotool 输入验证。1440×960 / 1000×760、三主题及离线状态见 [截图](screenshots/)；fixture 合成 composition 与真实输入法记录分别标识 |
| Gateway 保护与收尾 | 开始/结束只读快照中 ActiveState、SubState、MainPID、InvocationID、启动时间、NRestarts 六项完全一致，保持 active/running；未修改、重启或另部署 Gateway。客户端已退出，原 xkb 输入引擎已恢复，专用 Profile / 项目 / 会话 / journal 保留供审阅 |

真实重启与离线恢复中：在线重启自动恢复 Endpoint、同设备身份、会话和草稿；手动断开后 A/B 两会话草稿分别保留；离线新进程启动保留 B 及禁用发送状态，回到 A 精确恢复 400 px 阅读位置。离线选择 B 后重连仍停留在 B；操作清单摘要保持相同，没有自动重发。该链路使用现有正式本机 HTTP/WS，未通过停止 Gateway 制造故障。

### 长历史采样与解释

同一 Ubuntu GNOME/Wayland 主机，Electron 44.9.1 / Chromium 152.0.7977.167 / Node 24.22.0；两个 bundle 均使用 1,000 条、序列化约 1,667,378 bytes 的相同合成数据。每个 bundle 单次运行，滚动采样 60 帧：

| 指标 | P4.2 基线 | P4.3 最终视觉修正版 f2e7b67 |
| --- | ---: | ---: |
| 首次显示耗时 | 750 ms | 340 ms |
| 采样时挂载消息 | 1,000 | 5 |
| 页面 elements | 9,499 | 1,228 |
| Chromium DOM nodes | 24,950 | 12,995 |
| 首次显示后 JS heap used | 9,533,660 bytes | 10,041,228 bytes |
| 滚动后 JS heap used | 未采样 | 15,473,540 bytes |
| 滚动帧 p95 | 17 ms | 23.6 ms |
| 最长采样帧 | 89.7 ms | 43.7 ms |

本次样本的首屏、挂载元素数及最长帧改善，**p95 没有改善，首次显示后的 JS heap 也未降低**。JS heap 和 DOM 是即时 Chromium 计数，没有强制 GC，不代表稳定内存或进程 RSS；基线未记录滚动后 heap。基线的 LayoutDuration / RecalcStyleDuration 因采样启用时机为不可用值，不能拿零值与新构建作对比。这是可重现的描述性证据，不是多轮统计基准或对所有会话的性能承诺。

fixture 中正常关闭后新进程离线恢复耗时 1,082 ms；原锚点标识保持，偏移差约 0.0417 px。该值与真实会话恢复 400 px 的记录分开，后者证明授权本机链路，前者证明长历史样本的定位行为。

## 限制与审阅出口

- P4.4、正式 DEB 构建/安装、GitHub Release 及真实公网/TLS 不在本阶段。HTTPS/WSS 仍为安全配置入口，不以本地验证代替 TLS 验收。
- 本轮仍未稳定触发真实 pending approval，真实测试会话未提供 Plan 工具；相关能力继续明确标为单测/fixture 覆盖。真实锁屏/唤醒未单独验收，不以关闭/重启或合成事件冒充该证据。
- 本地数据库不是加密保险库；长期凭据由 main 系统安全存储保护。历史和草稿属于该本机 Profile 的客户端数据，不跨设备同步，也不保证在用户手动删除 Profile 后恢复。
- 未提交事务中的尾部编辑、历史缓存被逐出或超预算、原生条目已删除/压缩、缺少原生补读接口均有可见降级。磁盘故障若连退出/撤销标记也无法保存，会报告保存失败；不能声称所有磁盘故障下下次离线启动都已记住该隐藏状态。缓存始终不授予执行权限。
- 强制终止测试证明已确认提交的草稿可恢复，不承诺强退瞬间尚未提交的尾部编辑零丢失。最终交付保留专用测试 Profile、项目、会话及回执，不自行清理待审阅资源；Task 继续 **In progress**，用户接受后再决定 P4.4。
