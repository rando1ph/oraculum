# P4.2｜Ubuntu Desktop 架构与审阅指南

P4.2 在已接受的 P4.1 独立 Electron 客户端上接入现有 Gateway 协议和真实业务。依据：[2.0 正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[P4.2 Task](https://app.notion.com/p/41a5421e690b81668bbbd49e17e7d400)、[P4.0 设计](../README.md)。**实现与下述验证已交付，任务保持 In progress，等待用户审阅。**

本阶段没有修改 Gateway 实现、部署、服务或配置。正式 Codex App Server 仍是唯一执行权威；新版 Desktop 不导入旧 Web、Bridge、主题系统或服务生命周期代码。

## 实现入口

| 源码 | 职责 |
| --- | --- |
| [main/index.ts](../../../apps/desktop/src/main/index.ts)、[bundle.ts](../../../apps/desktop/src/main/bundle.ts)、[profile.ts](../../../apps/desktop/src/main/profile.ts) | 独立资源、隔离 Profile、窗口、安全和原生恢复 |
| [endpoint.ts](../../../apps/desktop/src/main/endpoint.ts)、[credentials.ts](../../../apps/desktop/src/main/credentials.ts)、[gateway-transport.ts](../../../apps/desktop/src/main/gateway-transport.ts) | Endpoint、配对与设备身份、HTTP/WS、契约和响应范围校验 |
| [workspace.ts](../../../apps/desktop/src/main/workspace.ts)、[workspace-actions.ts](../../../apps/desktop/src/main/workspace-actions.ts) | 有限业务意图、读取调度、当前范围、写入前置条件与恢复 |
| [projection.ts](../../../apps/desktop/src/main/projection.ts)、[journal.ts](../../../apps/desktop/src/main/journal.ts) | Snapshot/历史/事件收敛；发送前持久化 operationId，unknown 查询与核实 |
| [file-change-context.ts](../../../apps/desktop/src/main/file-change-context.ts)、[file-transfer.ts](../../../apps/desktop/src/main/file-transfer.ts) | 完整文件变更审批证明；原生选取/保存与字节校验 |
| [ipc.ts](../../../apps/desktop/src/main/ipc.ts)、[preload](../../../apps/desktop/src/preload/index.ts)、[workspace 契约](../../../apps/desktop/src/contracts/workspace.ts) | 可信主 frame 检查、固定命名能力、有界 UI DTO |
| [App.tsx](../../../apps/desktop/src/renderer/App.tsx)、[store.ts](../../../apps/desktop/src/renderer/store.ts) | 三栏工作区、连接/项目/会话、内存草稿与显示状态 |
| [Native.tsx](../../../apps/desktop/src/renderer/Native.tsx)、[Interactions.tsx](../../../apps/desktop/src/renderer/Interactions.tsx)、[FileChangeEvidence.tsx](../../../apps/desktop/src/renderer/FileChangeEvidence.tsx)、[Inspector.tsx](../../../apps/desktop/src/renderer/Inspector.tsx) | GFM/原生条目、审批表单与补丁审阅、Diff/文件/过程/用量/扩展 |

Desktop 复用 [Gateway 协议契约](../../../packages/gateway-protocol/src/index.ts)。操作 `accepted` 与原生执行结果分开：接收回执不代表 Turn 已成功完成。模型/effort/preset 的选择与服务端确认值也分别显示。

## 数据归属和恢复

| 数据 | 保存与恢复边界 |
| --- | --- |
| 项目、Thread、Turn、历史、审批 | Gateway / Codex App Server 是权威来源；客户端重新连接或切换后核实当前状态 |
| 长期设备凭据 | main 用 `safeStorage` 加密到独立 Profile，绑定 Endpoint / installation / device；Ubuntu 当前要求 `gnome_libsecret`，不可用或弱后端时拒绝保存 |
| 短期令牌 | 仅 main 内存，不进入 renderer、诊断日志或源码 |
| 未决操作 | main 私有 `operations.json`；保存原 operationId、范围、意图摘要和必要附件元数据，不保存消息正文或文件内容 |
| Snapshot、历史页、流、Plan/Diff/用量、文件变更证明 | main 内存投影，renderer 接收显示副本；旧历史或预览不能授权新审批 |
| 草稿、所选模型/effort/preset | Zustand 内存，按 Endpoint / installation / device / project / thread 隔离；跨进程持久化属于 P4.3。启动后须重新输入 Endpoint；输入相同 Endpoint 可重用已保存身份 |
| 外观和 Chromium 数据 | 独立 `oraculum-desktop-v2` Profile；开发/生产和可选 Profile slug 隔离，无旧应用状态迁移 |

写入先落盘 journal，再发送。丢失回执、连接中断或重启后的 `prepared` 进入 `unknown` 恢复，仅查询原 operationId；404、暂时离线或查不到不能证明未执行，也不触发自动重发。相关范围的未决操作继续约束后续写入；停止活动 Turn 等安全例外仍检查范围和重复发送。

设备 WS 序号在项目/会话切换时保留。重复事件忽略；缺号、错误身份/epoch、未知状态使投影失效并重新同步。Snapshot 观察序号不是事件消费水位。读取票据阻止过时响应覆盖后来选择/事件。Snapshot 最近 5 个 Turn 与后续 `limit: 5` 分页使用同一 opaque `historyRevision`：同修订保留已载旧页，变更修订重建。

普通会话写入要求新鲜状态。活动 Turn 的停止、steer 和 pending interaction 另有当前范围校验。刚创建但尚未物化历史的 Thread，仅在接受创建和重新读取空闲元数据等限定条件下允许首轮发送，不伪造 `current` Snapshot。

**Ctrl+Shift+0** / 原生菜单仅恢复外观与缩放，不清除凭据或 journal。损坏偏好保留原字节；不安全 Profile 或损坏 bundle 拒绝启动。关闭最后窗口即退出，无 Tray/后台服务，同 Profile 二次启动聚焦已有窗口。

## 安全与文件变更批准

main 独占网络、认证、文件访问与 journal。preload 没有任意 URL/method/header、IPC channel、文件路径、shell 或凭据接口；main 检查活窗口、主 frame、固定入口 URL 和 action 白名单。renderer 启用 sandbox、context isolation、web security，禁用 Node、webview、popup、导航、权限请求与浏览器直接下载。CSP 禁止网络连接、远程资源、内联脚本/eval/frame；图片仅允许打包资源及文件预览 data URI。Markdown 不执行 HTML 或自动拉取远程图片。

bundle 开窗前校验路径、大小、SHA-256，运行时仅服务固定资源；清单不是发行签名。远程配置要求 HTTPS/WSS，明文 HTTP/WS 仅精确 loopback；Origin / Base Path 可配置，没有内置私人部署地址。

审批必须匹配当前 pending interaction 的 epoch、project/thread、generation 和原生请求。旧状态、未知形式或不能完整表达的权限请求不能批准。文件变更采用完整受限证明：

- 来自当前接受且未截断的 Snapshot 中活动 Turn 的完整 `fileChange` item；历史分页、流式摘要和详情预览不能建立证明。
- 最多 20 个变更、累计 256 行补丁、16 KiB 上下文；校验字段、路径、移动目标、不可见字符和完整补丁。越界、歧义或隐藏内容不提供批准能力。
- renderer 完整展示上下文并返回摘要；main 再核对签发证明、SHA-256、generation 和请求范围。相关事件、断线、切换或新 Snapshot 使旧证明失效。`grantRoot` 扩权不由该证明批准。

命令批准还必须确认实际 cwd 与所选注册项目根目录完全一致；renderer 只获得安全的相对目录标记。归档状态来自当前授权列表查询，不能从 Snapshot 字段缺失推断；未知状态保持受限。

附件仅由原生选择器选取并校验类型/大小/字节。下载核对 FileGrant、范围、到期时间、MIME、长度、名称和 Content-Digest，原生保存只创建新文件，拒绝覆盖和符号链接重定向，落盘后回读校验。崩溃可能留下未完成的新文件，不会报告成功。文本/图片提供受限预览；当前没有原生分享对话框。

## 运行与检查

仓库根目录使用 Node 24 与锁定的 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm check:desktop
pnpm exec vitest run apps/desktop/src/main apps/desktop/src/renderer
pnpm build:desktop
ORACULUM_DESKTOP_PROFILE=p42-review pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

Profile 参数是 slug，不是任意路径。审阅使用专用 Profile，不依赖本地 Web 服务。当前主机需要 [P4.1 已验证的 sandbox helper](../p41/README.md) 时可使用下列命令；这些路径是主机验收环境，不是产品默认配置，不关闭 sandbox 或修改系统权限。

```bash
ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
ORACULUM_DESKTOP_PROFILE=p42-review \
pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

[P4.2 fixture harness](../../../scripts/desktop-p42-fixtures.ts) 使用实际 Electron、隔离 Profile 与真实 preload/IPC，业务显示注入 fixture，禁止 Gateway 连接。构建完成、无其他 GUI 验证并行时运行：

```bash
ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
pnpm exec tsx scripts/desktop-p42-fixtures.ts
```

产物在 `.local/desktop-p42-fixtures/`，须标注 fixture。`test:desktop:gui` 是 P4.1 历史脚本；旧 `build:desktop:deb`、`test:phase3:*` 和 Bridge 工作流不适用于新版。真实联调只用已授权的现有 Gateway，不创建测试 Gateway。本阶段不构建/安装正式 DEB、不发布 Release。

## 验证记录

验证源码为 `7d34e16b54ecc1280656d15b06c8ff87bfc66245`，已正常推送并核对 `main` 与 `origin/main` 一致。`pnpm check`、814/814 测试和 Desktop build 通过。构建及文件摘要见 [evidence-manifest.json](evidence-manifest.json)，测试与真实联调范围见 [validation.json](validation.json)。后续文档归档提交不改变该已验证源码基线。最终视觉复核修正了 HTML 与响应头的双重 CSP 差异，并用真实图片解码及独立 GUI fixture 验证。

| 证据类型 | 已核实结果 |
| --- | --- |
| 实际 Electron fixture | 16/16 通过；无 Gateway 连接，TCP 尝试为 0。覆盖三主题、窄窗、CSP、伪造 frame 拒绝、受限审批、完整文件变更证明及摘要传递。见 [fixture-results.json](fixture-results.json) |
| 原生桌面与身份 | GNOME/Wayland 应用运行，原生 portal 窗口截图成功；原生配对、`gnome_libsecret` safeStorage 身份保存及最终构建重启后同身份、24 条回执与六轮历史恢复已验证 |
| 本机 HTTP/WS 原生会话 | 文本和附件发送、原生工具输出、steer/stop、fileChange Diff、命名/fork/revert，以及 6 个 Turn 的历史分页 |
| 会话生命周期 | 本次自建临时根会话经过确认对话框执行 archive、unarchive、delete，操作被接受；不把其他原生用户会话作为删除样本 |
| 文件与附件 | 原生选择器上传；图片上传/移除被接受；文本预览与下载，落地 SHA-256 与源文件一致；真实图片解码宽度为 32 px |
| 断线恢复 | 断线前、离线及重连后保持同一身份；24 个原 operationId 的记录保持一致，没有自动重放 |

[screenshots/](screenshots/) 分别保存真实桌面与 fixture 图；以文件标注和证据清单为准。fixture 的审批/Plan 显示不构成真实 Gateway 审批或 Plan 工具执行证据。真实联调未修改现有 Gateway 实现、服务、部署或配置，测试操作限本次自建资源。

## 已知限制与审阅状态

- 真实原生会话未提供 Plan 工具，Plan 展示只有 fixture 证据；真实 pending approval 未触发。审批校验、完整文件变更证明与 UI 有单测/fixture 覆盖，真实批准链路尚未验证。
- 启动后需要重新输入 Endpoint。P4.3 的持久草稿、历史/详情缓存与 IndexedDB 尚未实现；内存草稿与可跨进程恢复的 journal 不同。
- Plan/Diff/thread token usage 的部分数据仅来自 WS 事件，Snapshot 不包含全部内容，重连后可能缺失。未观察到的值保持未知，不用账号限额替代 thread token usage。
- Plan Mode、review-start、完整子代理浏览等未提供的接口不补造；子代理仅展示已有协作摘要。空、受限、不可用和未验证分别表达。模型存在未消费下一页时不宣称列表完整。
- 没有原生分享和关闭后的后台通知保证。HTTPS/WSS 保留安全入口；本阶段真实验收限 Notion 授权的本机 HTTP/WS，fixture/本机连接不是公网 TLS 证据。

任务保持 **In progress**，用户审阅结论尚待确认；未进入 P4.3 或正式发行阶段。
