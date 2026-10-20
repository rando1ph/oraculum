# Phase 2：Android 真机、远程接入与恢复

实施日期：2026-10-21（Asia/Shanghai）。**阶段 In progress；2A USB 真机 Smoke 已取得实测通过证据，整体 Phase 2 尚未验收。**

- [Project 正典](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)
- [Phase 2 Task／实施顺序与验收入口](https://app.notion.com/p/3ff5421e690b81adba14c1594346bc1d)
- 严格按 2A 真机 → 2B 安全远程入口 → 2C 双端与恢复 → 2D 交接；ADB reverse 不是公网 HTTPS/WSS 证据。
- R 表示现场实测，S 表示模拟／Schema，U 表示未验证。本文记录证据，不另设架构正典。

## 2A-1：基线保护与发布

原工作区 `~/Projects/Oraculum` 保持 `feat/phase-1-local-gui`，原有唯一未提交修改为 `AGENTS.md` 中用户新增的 Git 规则。原文件、binary diff、SHA-256 和初始状态已备份至该工作区被忽略的 `.local/evidence/phase2/baseline/`；SHA-256 复核通过，未 stash、覆盖、丢弃或提交该修改。

在独立工作区 `~/Projects/Oraculum-phase2` 完成集成。`git fetch origin` 和 `git ls-remote --heads origin` 确认远端当时无分支；将 `main` 从 `5e9f4de` 快进至已验收 Phase 1 HEAD `55680b3ef0a77b4a87e0fd2a77185b83d6e5dc87`。检查后正常 `git push -u origin main` 成功，独立远端查询确认同一完整 hash。未生成重复 Phase 1 提交或改写历史。

Phase 1 原四次提交均已进入该发布基线：

1. `9ed62b638f8583be6872269737f766f544da26bd`
2. `b864ffb1cfd40faf46d56e7b9357ad50721d9999`
3. `ef1a30c272f418a0a2aff2ca6f11e0abe04dfc63`
4. `55680b3ef0a77b4a87e0fd2a77185b83d6e5dc87`

后续工作分支为 `feat/phase-2-android`。独立工作区的 AGENTS Git 规则依据本轮明确授权和 Notion 最新规范添加；原工作区用户修改继续保留。每个完成步骤执行 Conventional Commit → 安全合并 main → 普通 push → 远端 hash 核对。该文档提交自身 hash 与同步结果写回原 Task，避免自引用。

## 首轮基线检查证据（USB 连接前）

| 类型 | 检查 | 本轮结果 |
| --- | --- | --- |
| R | frozen/offline install、protocol | exit 0；Codex 0.160.0，314 schemas，锁定指纹无变动 |
| S | `pnpm check` / `pnpm test` | exit 0；5 文件、30 tests passed |
| R | `pnpm build` | exit 0；Vite 188 modules |
| S | `pnpm test:ui:mock` | 实际 Electron＋模拟 Codex passed；覆盖 Markdown/XSS、Diff、复制、审批、去重、失败、393px 布局 |
| R | `bash scripts/android-build.sh` | assembleDebug / lintDebug 成功；0 errors、7 warnings |
| R | Git 安全检查 | diff whitespace 通过；扫描全部 87 个可达 blob 和跟踪路径，无敏感信息模式或产物路径命中 |
| R | SDK adb 37.0.1 | `devices -l` 与 `mdns services` 均为空；未连接、安装或启动手机 App |
| U | Android 真机 | 型号、API、ABI、WebView、React 渲染、中文 IME、原生 Thread/Turn、allow/decline、返回及前后台均待测 |
| U | 远程与恢复 | 无 HTTPS/WSS、SSH tunnel、设备信任、双端同步或故障恢复验收 |

本轮未发起新的模型推理。Git 敏感信息检查是启发式扫描，不构成穷尽证明。测试和构建结果不能替代手机真实操作。

Android 构建沿用用户目录工具链，不安装系统软件。既有警告包含 target/compile SDK、启用 JavaScript、Android 12 备份规则、缺图标和硬编码文字；另有 SDK XML 格式及旧 inset API 警告。JavaScript 用于共享 React，现有 WebView 限定 debug loopback 来源，关闭文件／content 访问与混合内容，不暴露 JS→原生权限接口。远程凭据加入前必须处理备份规则风险。

## 首轮 2A 连接阻碍（已由用户 USB 连接解除）

用户此前已完成无线配对；本轮 ADB 未发现设备。已请求手机「无线调试」主页面当前的连接 IP:端口及必要的系统授权操作。**不把历史配对端口作为连接端口，不索要或记录配对码、GUID、密钥。**

连接信息就绪后，在同一 Phase 2 Session 继续：

1. 依据当前连接地址执行 `adb connect`，确认目标为 `device`，后续每条设备命令显式指定 `-s`。
2. 仅查询型号/API/ABI/WebView；`adb install -r` 安装本地 debug APK。APK 位于 `apps/android/app/build/outputs/apk/debug/app-debug.apk`，不入 Git。
3. 建立该设备专用 `adb reverse tcp:17860 tcp:17860`；先确认本机端口可用，再启动仅 `127.0.0.1` 监听的测试 Bridge。Codex 只操作 `~/.cache/oraculum/workspaces/` 下独立测试目录。
4. 真机完成共享 React 渲染、中文 IME、原生 Thread/Turn、精确无副作用命令的 allow/decline、返回与前后台。截图和日志只采集 Oraculum；不读取手机私人数据或其他 App。
5. 保存脱敏证据到 `.local/evidence/phase2/`，记录原生 ID 与测试结果。清理本次临时测试进程及映射，不删除既有配对。

## 安全边界、回退及未验收项

- **未修改 VPS、Caddy、SSH、systemd、DNS、证书、防火墙或已有服务。** 未进行生产部署；没有远程入口可用的结论。
- 2B 先只读复核真实环境，再提出具体入口、端口和 tunnel 方案。涉及任何配置写入/reload/重启或系统操作，先列精确影响、受保护备份、校验方法、回退命令和既有服务健康检查，单独取得用户明确批准后才执行。当前未收集足够现场事实，不能预填端口或宣称备份完成。
- 本轮 Git 回退采用审阅后的 `git revert` 和普通 push，不 reset/force；原用户修改保存在原工作区及备份中。
- Phase 1 P0 风险继续有效：declined command 不保证可从原生历史恢复；experimental opt-in 与锁定版本契约需核验；pending 审批、丢 ACK、进程重启、双端竞争尚未完成验证。不得将内存缓存作为第二份历史正典，也不得声称 exactly-once。
- 首轮等待设备时 2A 缺少真实证据；下节记录 USB 接续结果。Task 保持 In progress，阶段未完成，不能标记 Done。

## 2A-2：USB 真机验证及生命周期修复（R）

用户随后明确提供 USB 已连接的现场事实。本轮检测到唯一已授权 USB 设备；每条设备命令均显式使用选定目标 `-s`。设备序列号未写入仓库或 Notion。

- HONOR REA-AN00；Android 15 / API 35；arm64-v8a；1200×2664；Google Android WebView 150.0.7871.181；SDK adb 37.0.1。
- `adb install -r` 成功；启动 `dev.oraculum.poc/.MainActivity`；USB `adb reverse tcp:17860 tcp:17860` 连到本机 `127.0.0.1:17860`。没有 LAN／公网监听。
- CDP 附着实际 Android WebView，标题「Oraculum · 神谕」，DOM 有模型目录、会话、输入框及实际状态。369 CSS px 下无横向溢出；这不是桌面移动 viewport 模拟。
- **中文 IME**：ADB 点击现有 Gboard 拼音键盘的 `zhongwen` 和首个「中文」候选，真实 textarea 收到 `input(data="中文")`，值为「中文」。键盘使 viewport 高度从 782 缩至 440；Back 收起键盘后仍保留文字。此项没有使用 DOM fill 冒充输入法。
- **真实 Codex**：仅一轮受控模型请求，gpt-6-luna / low，cwd 为 `~/.cache/oraculum/workspaces/phase2-android-zd4op9`。原生 thread `01a15ab7-a584-7ba3-827c-3cfc03b53f4a`，turn `01a15ab7-ad8a-7d03-a5d3-3e69e57937f6`，最终 completed。
- `cat hello.txt` 返回 `ORACULUM_ANDROID_FIXTURE` / exit 0；原生审批 ID 0 对精确 `printf ORACULUM_ANDROID_ALLOW` 经手机 WebView 允许，exit 0；ID 1 的精确 `printf ORACULUM_ANDROID_DECLINE` 经手机 WebView 拒绝，item 为 declined、无退出码或输出，未换路执行。测试脚本遇任何非预期命令即失败，不自动放行。
- 原生 allow item `exec-2a04412b-3843-4f2a-a5b1-e2bb73dabb71`；decline item `exec-bb8ddd68-f2ee-4b3b-b10c-650fde56a2b3`。完成回复标记 `ORACULUM_ANDROID_OK`。重新加载后恢复同一 thread 与完成结果，继续明确提示原生历史不完整。
- Home→短暂后台→前台，以及 Back 退出 Activity→重开，均恢复同一原生 thread／最终回复。重新安装修复版 APK 后的上述检查通过；未测试锁屏／断网完整矩阵，留待 2C。

真机发现 `WebView.destroy()` 在视图仍挂载时调用的警告；现在先从父 ViewGroup 移除再销毁，符合 [Android WebView.destroy 文档](https://developer.android.com/reference/android/webkit/WebView#destroy())。重装后 App 专属日志中未再发现该警告或 fatal crash。WebView 曾记录未附带请求地址的 SSL 握手错误；没有据此宣称环境日志全无错误，应用本地会话链路实测正常。

两次取证脚本问题如实保留：完整 input_method dump 超过默认缓冲区，改为设备侧仅筛选 `mInputShown`；Back 后立即启动时附着到了正在销毁的旧页面，改为等待旧 CDP page close 再 `am start -W`，重跑生命周期通过。两者不算成功测试，也未通过忽略断言来掩盖。

复验：`pnpm check`、`pnpm test`（30/30）、`pnpm build`、`git diff --check` 均通过；修复后 Android assembleDebug/lintDebug 成功。没有新依赖、系统安装、额外手机 App 或用户配置改动。

可重复真实 UI 测试：先按既有启动方式，以新建 `phase2-android-*` 隔离目录运行 Bridge，在其中准备只含测试标记的 `hello.txt`；构建安装 debug APK、设置 reverse、启动应用，然后把**该应用进程**的 `localabstract:webview_devtools_remote_<pid>` 通过 ADB `forward tcp:0` 映射至本机动态端口：

```bash
ORACULUM_ANDROID_CDP=http://127.0.0.1:<实际转发端口> pnpm test:android
```

该入口只附着已运行的 Oraculum WebView，发起一轮真实模型请求；不自动安装／改设备，不包含坐标依赖的 IME 操作。中文键盘与原生 Home/Back 验证是本轮另行执行的真机步骤。只有一个 USB 调试目标时才自动选择，否则必须明确目标；不得调试其他 App。

证据位于 `.local/evidence/phase2/`，均被忽略，不提交截图、日志或 APK：

| 文件 | SHA-256 |
| --- | --- |
| android-live.json | `52f29b8b0442e9254974e2651f1f88c42283d7bf5d4f5c19188e41d75ce238bf` |
| android-ime.json | `34cd8965f69be33a34d6bee6c8185ee257967f5dc254107884e2b08e9a7540a6` |
| android-lifecycle.json | `15da6ef86332c34f10d309678127ce56516084d08cf4456ee665d9d59324cde2` |

另有 device-environment.json、android-native.jsonl、android-accept/decline/completed/restored.png、键盘截图与 app 专属日志。本步骤提交／main 合并／push 状态写回原 Task。**2A 的本地 ADB reverse 验收不能替代 2B 的正式 HTTPS/WSS 或 2C 的双端恢复验收。**

2A 实施提交 `383ffdc293ed1fb0d32b3e172665b749b82843f2` 已安全合并并推送；远端完整 hash 核验一致。

## 2B：现场只读复核与本地鉴权

最新只读复核：DSH Caddy 2.11.7、SSH、dsh-web 均 active；Caddy 仍只有现有 IP 的 443 入口，转到 127.0.0.1:3444，既有 `/api/mobile-access`、`/relay` 拦截仍在。系统信任验证下匿名 HTTPS 为 401，`ssl_verify_result=0`。现有监听仍包含 22/443/3443、环回 2019/3080/3444；候选 17860/17861 未占用，**未据此保留端口或开放监听**。小新既有 CodeG reverse-tunnel 为 active，仍是远端环回 13080→本机 3080，代理 7897 不变。

DSH 当时 load 5.53/5.40/5.33，可用内存约 435 MiB，swap 已用约 1341 MiB；属于瞬时观测，不作性能保证或擅自清理。SSH 当前 allowtcpforwarding=yes、gatewayports=no。Caddyfile 只读前后 SHA-256 均为 `802503ca76f80399f1d5daac930e0fc95a3eb3a2c4bab4d397b9d814ed7ed9de`；未输出密钥、认证配置或修改服务。原始脱敏摘要在 `.local/evidence/phase2/vps-readonly.json`。

本地实现：

- 正常 `pnpm bridge` **必须配置设备信任存储**；没有 trust 的 server 构造默认失败。旧测试夹具必须显式使用 testOnlyUnauthenticated，且不能启用远程 origin；这不是可配置的生产旁路。
- 使用 Node 24 内置 SQLite，默认 `.local/runtime/`（0700），数据库 0600，拒绝目录／数据库 symlink 及宽松权限。只存配对码／会话凭据的 SHA-256 摘要和设备标签、ID、来源、有效期、撤销标志；不保存 OAuth、模型凭据或原生对话历史。未新增依赖。
- 主机 `pnpm trust pair` 生成 256-bit 随机、5 分钟一次性码，私密写入 `.local/runtime/pairing.txt`，不输出码。新码替换旧的未使用码。`pnpm trust list` 只列安全设备元数据；`pnpm trust revoke <device-id>` 撤销。
- UI 配对后获得 24 小时、绑定精确 origin 的 HttpOnly / SameSite=Strict Cookie；远程使用 Secure / `__Host-` 前缀。配对码不存 localStorage、URL 或日志。localhost 调试凭据仅适用于该本地 origin。
- 未配对者不能访问会话 API 或 WebSocket。Host、Origin、cross-site 请求、远程 X-Forwarded-Proto 均受校验；远程必须显式配置 `ORACULUM_REMOTE_ORIGIN=https://<独立可信入口>`。代理必须覆盖转发头，Bridge 仍只监听 127.0.0.1。配对失败限 5 次／分钟。
- 现有 socket 在每次收发前复核信任；撤销／过期后停止传输新事件与请求，最多一秒关闭空闲 socket。撤销不取消已经提交给官方 Harness 的任务。
- Android 增加可构建时指定的精确 HTTPS origin（`-PoraculumOrigin=https://<入口>`），保持同源导航／资源限制、禁止混合内容和任意原生桥接；禁第三方 Cookie 和地理位置。未配置入口的 release 不加载任何本地页面。追加 Android 12+ 云备份／设备迁移排除规则，旧系统仍禁止 backup。

本地验证：

- **S** `pnpm check/test/build` 通过，39 项测试；覆盖一次性消费、过期、origin 绑定、撤销跨 DB 连接、权限与 symlink、匿名 WS、错误 Host/Origin/TLS 标头、重复 Cookie、限流、已连接 socket 撤销后无事件泄漏与拒绝重连。
- **R** 实际 Electron + 正常鉴权 Bridge，零新模型调用：初始 401／无会话 UI；配对后通过原生查询恢复 2A thread；JS `document.cookie` 为空；重复码 401；主机撤销后 socket 关闭，界面移除私有会话并要求重新配对。见 `auth-electron.json` / `auth-electron-paired.png`。
- **S** 原 Electron 模拟 UI 回归通过。Android APK 构建和 lint 通过；第一次构建因 Gradle Kotlin DSL 的 java 扩展名遮蔽 `java.net.URI` 失败，改为显式 import 后成功。
- **U／设备阻碍** 新鉴权版 APK 的 `adb install -r` 返回 `INSTALL_FAILED_ABORTED: User rejected permissions`；未绕过或反复重试，已请用户解锁并确认系统安装授权。2A 已验收的版本保留；新备份／HTTPS 壳配置尚未实机复验。
- **U／入口阻碍** 现有 DSH 仅有 IP HTTPS，无 Oraculum 独立域名；已向用户询问可用独立域名／子域名。相同 IP 的不同端口并不能隔离 Cookie，因此不把换端口当作完整身份隔离方案。正式入口确定前不改 Caddy、不签发证书、不建隧道。

正式部署须另行审阅精确配置差异：保留现有入口，新增独立 host 与仅环回 SSH 端口；备份磁盘配置和运行中配置，验证配置后才获批 reload，评估既有长连接可能断开；失败恢复备份并验证旧入口。当前仅有候选设计，**没有执行备份写入、reload、SSH 配置改动或 systemd 操作**。缺少域名／授权时不宣称 2B 或 Phase 2 通过。

## 2B 接续：新版 Android 鉴权实机验证（R）

用户解锁并确认允许安装后，原命令 `adb install -r` 成功，未绕过系统授权。新 APK 在同一 HONOR 真机启动，经本机环回 Bridge + USB reverse 完成以下零新增模型调用的验证：

- 初始 `/auth/session` 为 401，页面只显示配对表单、没有模型／私有会话内容。
- 一次性码配对成功；Cookie 为 `oraculum_local`、HttpOnly、SameSite=Strict，页面 JS 无法读取。因本次仅走本地 HTTP，Secure=false，**不作为远程 TLS 证据**。
- 页面重载后保留授权，从官方 Harness 恢复原生 thread `01a15ab7-a584-7ba3-827c-3cfc03b53f4a`、completed 状态与 `ORACULUM_ANDROID_OK`；历史缺口提示仍保留。
- 已消费配对码重放返回 401；主机撤销后已打开的 socket 关闭，私有 UI 移除，HTTP 查询为 401。使用新码重新配对，获得新设备授权并恢复同一 thread。测试结束撤销全部本轮测试授权，不保留可用测试凭据。
- 安装后 package flags 未启用 ALLOW_BACKUP；仅检查 Oraculum PID 的最近日志，未见 FATAL EXCEPTION 或 attached-destroy 警告。此检查不等于已执行云备份／设备迁移。

新增可复验入口 `ORACULUM_ANDROID_CDP=http://127.0.0.1:<本次转发端口> pnpm test:auth:android`。需运行同一状态目录下的正常鉴权 Bridge、手机初始未配对、预先存在已完成的受控测试 thread。脚本仅附着本应用 WebView，覆盖配对、重载、重放拒绝、撤销和重新配对；不输出码／Cookie 值，不在失败时截图或转储可能含凭据的断言。截图只在配对提交后采集。

`pnpm check`、`pnpm test`（39/39）、`git diff --check` 通过；本步只有测试入口与文档变化，应用构建沿用上一已通过版本，实机安装的是该构建。

| 忽略目录证据文件 | SHA-256 |
| --- | --- |
| auth-android-8db3c16.json（首轮鉴权证据归档） | `2b0d1c9ce4a51dd5d20654cf33bede9620b9fa582d5739a4d94a89780c977f6a` |
| auth-android-package.json | `c9ab02272ba931fa5b061e013a32794ed80496520e0dac878fc148dff4f76fbd` |

另有配对成功／撤销后的真机截图；生成物不提交。APK 安装阻碍已解除；独立域名与正式配置授权仍待提供。2B 正式公网远程、2C 双端故障矩阵和整个阶段尚未验收，Status 保持 In progress。本步骤 commit／main 合并／push 状态写回原 Notion Task。

上述手机鉴权验证提交为 `8db3c16d2120c20fe4ff7196112f0ea1a3ae018a`，已安全快进 main 并普通 push，远端完整 hash 一致。

## 可独立验证的本地恢复保护（正式 2B／2C 仍未验收）

远程入口信息和服务变更授权尚未具备，依 Task 的边界继续完成本地部分：

- 正常 Bridge 使用同一私密 SQLite 的 `send_receipts` 表，只记录操作 UUID、工作区／thread、已认证设备 ID、时间、状态及已确认的 turn ID。不保存提示词、工具内容、审批或对话副本；设备 ID 来自服务端会话，不能由 UI 冒充。
- 客户端为每次显式 `turn/start` 创建操作 ID；Bridge 在调用官方 RPC **之前**同步事务记录 unknown。事务内检查该工作区／thread 是否仍有未确认发送，跨数据库连接也不能同时占用。同一操作 ID 永不再次执行；客户端断线／超时不自动重发。
- 官方成功 ACK 只表示 accepted，不能当作完成；仅匹配 turn ID 的原生 completed／failed／interrupted 可确认终态。明确原生 RPC 拒绝记为 rejected；丢 ACK、进程退出、超时继续 unknown，Bridge 重启或无关轮次完成不能自动解除。没有已确认 turn ID 时宁可保持阻断，用户需核查并使用新会话，不提供强制清空／重试按钮。
- UI 展示最近 20 条回执及各类状态。新发送仍需实时原生会话查询，持久回执不会代替原生历史。记录暂不自动清理，避免清理后旧 ID 被复用；规模管理留待真实使用量证据，不作 exactly-once 承诺。旧版本 Bridge 在回执写入前已执行的历史操作不在此保护范围内。
- 测试夹具可显式构造无回执服务；正常启动始终注入回执存储。数据库失败时先阻断发送，不能降级为无回执执行。Git 回退此功能需要停用远程入口并重新评估发送保护，不能把删库当作安全回退。

### 检查与实测

**S** `pnpm check`、`pnpm test`（7 文件，48 tests）、`pnpm build`、实际 Electron 的模拟 UI 回归通过。新增覆盖：先记回执后发 RPC、丢 ACK 后重新构造 Bridge／独立 DB 连接仍阻断、匹配原生三种终态、RPC 拒绝后仅允许新操作、永久拒旧 ID、存储失败时不转发、未知结果不被无关 completion 清除。两个已认证 WebSocket 同时发送只转发一次；同时竞争审批只向原生回一次；App Server unavailable 后复用 request ID 的旧 token 被拒绝。以上故障与竞争为模拟原生端证据，非公网或实际崩溃承诺。

**R** `pnpm test:recovery:local` 附着实际 Android WebView，同时启动实际 Electron，使用正常鉴权 Bridge + 官方 Codex 0.160.0，仅新增一轮 gpt-6-luna / low、无工具请求的受控回复：

- thread `01a15ad4-9177-7870-b12b-0b71c346f83a`
- turn `01a15ad4-9406-7773-b0d6-1227fb88e490`，completed
- operation `bfa01aed-ef06-4020-bbf5-980ef1f028cd`
- 两端的原生 user／assistant item ID 集合一致，最终标题 `ORACULUM_RECOVERY_OK`，回执均为「原生已确认完成」。
- 停止本次测试 Bridge 及其 App Server，两端显示已断开；以原工作区／状态目录重启后，两端手动重新连接恢复同一 thread、turn、item 集合和同一条回执，没有重发。历史缺口提示保留。
- 测试结束撤销本轮设备授权、关闭测试 Electron／Bridge、仅断开 CDP，不删除手机 App、配对或原生 thread。该脚本需要空闲 17860、现有 Oraculum CDP forward／ADB reverse 与受控工作区，重复运行会新增一轮真实推理。

证据 `.local/evidence/phase2/recovery-local.json` SHA-256 `0b0837a41948b0ac3313795fb45b9562eb1ad16ba963a0a1489df26adf5679d4`，另有双端恢复截图，均不入 Git。本步未改变 Kotlin／manifest，沿用已实机安装的新鉴权 APK，加载本次构建的共享 UI。

恢复功能加入后再次运行真机鉴权回归，通过配对／重放拒绝／撤销／重新配对，零新增模型调用，恢复本次 completed thread。鉴权脚本现在先重载，并验证当前已完成会话，不再依赖旧 2A 回复标题。最新 `auth-android.json` SHA-256 `013321b718f09b645b8f4c4fa11c17b2fdda96a11aed2584f09751ea6ddff286`；首轮证据已归档为 `auth-android-8db3c16.json`，原 SHA 不变。

**U** 正式 HTTPS/WSS、独立 SSH tunnel、既有服务变更后健康回归、远程创建／继续／中断、实际 Wi-Fi 切换、锁屏与隧道重连、真实 pending 审批跨进程丢失仍待后续获批环境验收。正式入口不能由本地测试替代；整体 Phase 2 保持 In progress，等待入口信息／配置授权以及后续审阅。
