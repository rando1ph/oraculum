# Phase 0B：真实 Codex 与双端最小 PoC

实施日期：2026-10-20 至 2026-10-21（Asia/Shanghai）。**代码与本轮检查完成，待审阅；不是正式验收。**

- [Project 正典](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)
- [Phase 0B Task／最终提交与审阅记录](https://app.notion.com/p/3ff5421e690b81a5a5f1da2b6deb0a21)
- 本文只记录实现及证据，不替代 Notion 的架构决策。未 push、未创建 README。

## 结果与证据等级

| 验收项 | 本轮结果 |
| --- | --- |
| 官方 App Server → Bridge | **实测通过**：现有 ChatGPT 登录，stdio initialize/initialized，原生 thread/start、turn/start、流式文本、工具和 turn/completed |
| 模型与 effort | **实测通过**：model/list 返回 7 项及 effort 选项；测试显式选择 gpt-6-luna，线程初始继承 high，turn 覆盖 low，native read 确认 low；未逐模型验证订阅权限 |
| 工具与审批 | **实测通过**：读取临时目录 fixture.txt，命令 exitCode=0；真实命令审批返回 decline，收到 serverRequest/resolved 和 commandExecution.status=declined |
| 共享 React UI | **实测通过**：从 Bridge 同源加载构建资源；发送、原生事件、审批、停止、会话选择和查询 |
| Electron | **实测通过**：Ubuntu 图形会话中启动真实窗口，渲染并拒绝真实审批，显示最终回复；renderer 的 require/process 都为 undefined |
| 基础断线恢复 | **实测通过**：WS 断开后查询同一线程最终结果；Electron 在第二个 turn 执行中关闭、重开，仍看到同一线程及完成结果 |
| 原生停止 | **实测通过**：UI 发出 turn/interrupt，收到完成事件，随后查询到 interrupted |
| Android | **构建通过，真机未验证**：debug APK、lint、签名与 manifest 检查完成；两次 adb devices -l 均无设备；未安装到真机或模拟器 |
| 移动布局 | Electron renderer 的 393×851 viewport 检查，无横向溢出；**不是 Android WebView 运行证据** |

真实推理共运行 5 个受控 turn（2 次 Bridge smoke、3 次 Electron smoke，其中一次立即中断），未批量测试模型。未使用模型 API 代替 Harness。

## 实现边界

- `bridge/src/codex.ts`：管理独立官方 App Server 子进程、JSONL 请求关联、超时与退出。没有 Agent Loop、提示词编排、工具执行器或上下文管理。
- `bridge/src/service.ts`：仅允许本 Bridge 进程创建的测试线程；新线程固定临时 cwd、workspace-write、on-request、user reviewer。只开放模型目录、创建、发送、查询、停止与两种基础审批。没有配置／凭据／任意工具 RPC 透传。
- `bridge/src/server.ts`：Fastify/WebSocket，只绑定 `127.0.0.1`；严格 Host 和 Origin 校验、消息大小上限、CSP；同源提供 `apps/web/dist`。没有公网入口或设备配对。
- `packages/shared` 与 `apps/web`：生成的官方协议类型、浏览器传输客户端、Zustand UI 投影和单套 React 页面。原生 ID 是事实标识。UI 断开不停止 App Server；发送与审批不自动重试。
- `apps/desktop`：隔离 renderer、sandbox、关闭 Node integration；拒绝新窗口、外部导航及权限请求。无 preload 特权接口。Bridge 生命周期独立于 Electron。
- `apps/android`：Kotlin WebView，只有 INTERNET 权限；无 JavaScript 原生桥、文件／content 访问；仅 debug 允许 `http://127.0.0.1:17860`，主资源配置默认禁止明文。release 不提供运行入口，本轮不交付正式安装包。
- 测试 cwd 位于 `~/.cache/oraculum/workspaces/poc-*`，内有无敏感内容的 fixture.txt。workspace-write 不是“禁止读取所有其他路径”的完整隔离；测试提示和实际命令均限定在该目录。
- App Server 沿用用户官方登录与默认模型配置；MCP、plugins、apps、web search、multi-agent 仅在 PoC 子进程禁用。未更改全局配置，也未读取认证文件内容。
- 本轮不需要持久化设备信任或回执，未引入 SQLite；shadcn/ui 丰富组件、Markdown/diff、CodeMirror、Forge 正式打包、Live UI 发布等留待对应阶段，没有替换冻结架构。

## 锁定版本

| 项目 | 本轮版本 |
| --- | --- |
| Codex / 协议 | 0.160.0；默认非 experimental 类型／schema |
| Node / pnpm / TypeScript | 24.21.0 / 10.34.7 / 5.9.3 |
| Fastify / websocket / ws / static | 5.12.7 / 11.3.4 / 8.22.0 / 8.3.0 |
| React / Vite / Zustand / Tailwind | 19.3.1 / 8.3.4 / 5.0.15 / 4.3.3 |
| Electron / Chromium | 44.9.1 / 152.0.7977.167 |
| Vitest / Playwright / tsx | 3.2.7 / 1.64.1 / 4.23.15 |
| JDK / Gradle / AGP / Kotlin | Temurin 21.0.12.1+1 / 8.13 / 8.13.2 / 2.2.21 |
| Android | command-line tools 22.0；compile/target 35，min 26；Build Tools 35.0.0；构建自动安装用户目录 Platform Tools 37.0.1 |

核心 npm 依赖使用精确版本及单一 `pnpm-lock.yaml`。运行和生成脚本拒绝非 0.160.0 Codex。
`pnpm protocol` 生成 314 份 JSON schema 及 TypeScript，放在被忽略的 `.local/`，不提交生成产物。
默认完整 bundle SHA-256：
`8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e`，与 0A 一致。

## 可复现运行

本机 pnpm 安装在 `~/.local/share/oraculum-tools/node_modules`，`~/.local/bin/pnpm` 是指向它的链接；未安装系统包。

```bash
cd ~/Projects/Oraculum
pnpm install --frozen-lockfile
pnpm protocol
pnpm check
pnpm test
pnpm build
# Electron 44 的安装器需单独运行；本机下载时需要现有代理环境：
ELECTRON_GET_USE_PROXY=1 node apps/desktop/node_modules/electron/install.js
pnpm bridge
# 另一个终端；Bridge 启动时输出本次临时工作区和 URL：
pnpm desktop
```

默认开发端口 17860，启动前须确认空闲；冲突时使用 `ORACULUM_PORT`，
Electron 同时设置对应 `ORACULUM_URL`。Android 原型入口固定为 17860。
Bridge 普通前台运行，不安装 systemd 服务。结束 Bridge 会终止其 App Server，关闭 GUI 则不会。

```bash
# 均需先启动 Bridge；会消耗真实订阅推理，勿并行批量运行：
pnpm test:live
pnpm test:ui
```

Android 工具链全部位于 `~/.local/share/oraculum-tools/`：
`jdk-21`、`gradle-8.13`、`android-sdk`、`gradle-cache`。
构建入口设置自身 JAVA_HOME/ANDROID_HOME/GRADLE_USER_HOME，不写全局设置：

```bash
bash scripts/android-build.sh
# 若 Gradle 未沿用本机已有代理，本次成功命令为：
bash scripts/android-build.sh \
  -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 \
  -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897
# 未来连接测试设备后执行；本轮未执行以下三条：
adb reverse tcp:17860 tcp:17860
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.oraculum.poc/.MainActivity
```

APK：`apps/android/app/build/outputs/apk/debug/app-debug.apk`，856,849 bytes，
SHA-256 `1a9b616022088f998f0b5f1e8982d89bb2215601b12667415f7d75ad1741f686`。
`apksigner verify --verbose`：Verifies，v2=true；`aapt dump badging` 确认包名
`dev.oraculum.poc`、versionCode=1、版本 `0.0.1-phase0b`、可启动 Activity 及仅 INTERNET 权限。
这是本机生成的 debug 签名产物，不入 Git。

## 检查证据

- `pnpm check`、`pnpm build`、`pnpm test`：exit 0；Vitest **2 个文件、7 项通过**。覆盖本进程线程边界、权限参数固定、原生审批 ID 路由与重复响应拒绝、未知发送不重发、unsupported 请求失败关闭、Host/Origin、UI item 去重和串线程过滤。
- 最终 Bridge smoke：thread `01a15a0d-ec4c-73a3-b74b-d3ed121578e5`；turn `01a15a0d-ec74-7fb3-aa65-86da9f7dc01d`；completed。
  成功命令 item `exec-7b066907-8ebe-4a76-9f15-3010f6674bbe`，exit 0；
  审批 RPC id **0**、item `exec-1bcec9f7-eb14-45fd-986b-95350e14a370`，declined。
- Electron smoke：thread `01a15a17-917a-73f3-9322-c86c0db44e28`；
  三个 turn 分别为 `01a15a17-920c-7c82-a302-65e23263723b`（审批／completed）、
  `01a15a17-ae4d-7d53-a8d9-d0b19795e1b1`（关闭／重开 GUI，completed）、
  `01a15a17-d882-7743-ac4a-d56eb72f797e`（interrupted）。
- `:app:assembleDebug :app:lintDebug`：exit 0，BUILD SUCCESSFUL，48 tasks；lint 0 errors、7 warnings。
  警告：旧 target/compile SDK、启用 JS、备份迁移规则、缺少图标、2 条原生字符串国际化。
  另有 Kotlin DSL/insets 弃用及 SDK XML 版本提示。未以关闭 lint 的方式隐藏警告。
- 本机原始证据（均忽略、不提交）：`.local/evidence/live-smoke.json`、
  `ui-smoke.json`、`electron-approval.png`、`electron-completed.png`、
  `mobile-layout.png`、`android-build.log`、`android-sdk-install.log`。
  APK 与 lint 报告在 `apps/android/app/build/`。截图仅含受控测试消息，不含账户凭据。
- `sha256sum -c .local/evidence/baseline.sha256`：原有 AGENTS.md 与
  `~/.codex/config.toml` 均 OK。未登录 VPS、未动 SSH/Caddy/证书/防火墙、
  既有 CodeG/DSH/PROXY 服务、全局 Codex 设置或系统软件。

## 发现、未覆盖与下一步

1. CLI 的 dotted override key 不能直接容纳带点的 MCP 名称，曾导致启动失败；空 MCP 表又会被合并，不能禁用已有集成。最终采用顶层 TOML 表逐项 `enabled=false`，并禁用 plugins；只读查询确认三项用户 MCP 均无可调用工具。最初一次 turn 曾出现 MCP 启动事件，但没有 MCP 调用；最终 smoke 没有该启动事件。
2. `thread/read(includeTurns=true)` 在当前 paginated thread 的短会话实测可读回最终文本和成功命令，但 API 已提示分页会话弃用该恢复路径。本次被拒绝的命令 item 未出现在随后返回的 full 历史中；实时审批/declined 事件成立，不宣称完整历史重放。
3. 只验证 **Bridge 与 App Server 均存活、GUI 断开**。Bridge/App Server 重启、历史分页、pending 持久重建、丢 ACK、跨设备审批争抢、恰好一次执行均未验收。JSON-RPC ID 不是持久幂等键；未知发送保持阻止，不自动重发。
4. command approval 的 decline 路径已实测；accept、文件审批及 failed turn 的完整真实链路未实测。权限请求、用户输入、MCP elicitation 等当前返回明确不支持，尚不能作为日用客户端。
5. Android **真机未验证**；中文 IME、软键盘、锁屏/Doze、设备 WebView 版本、返回导航、权限和恢复仍需设备实测。无设备不是双端实机通过。
6. 本轮未实现远程 WSS、设备配对、持久存储、Live UI 原子发布/回滚和正式打包。loopback/同源限制只服务本地 PoC，不能直接部署公网。
7. 初次下载工具未沿用环境代理，使用进程参数后成功；未改现有网络配置。工具包下载校验通过，Gradle/JDK/SDK 仅安装用户目录。

下一步先审阅 0B，再安排 Android 真机最小加载和 Phase 1 的本地可用性工作。
跨阶段建议新开 Codex Session，以已审阅 Task 和本报告交接；同一 0B 的小修复可沿用当前 Session。
不要将本文或构建成功自动转换为 Task Done。

## 本地提交与参考

- `3b132ef`：真实 stdio Bridge、协议生成与 smoke／边界测试。
- `5aabda1`：共享 React UI、Electron 薄壳和真实 UI smoke。
- `b60a8db`：Android WebView 源码、debug 构建入口和产物排除。
- 本报告提交的完整 SHA 记录在原 Notion Task，避免自引用。

技术参考：[官方 App Server](https://learn.chatgpt.com/docs/app-server)、
[Fastify WebSocket](https://github.com/fastify/fastify-websocket)、
[Electron 安全实践](https://www.electronjs.org/docs/latest/tutorial/security)、
[Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview)、
[AGP 8.13](https://developer.android.com/build/releases/agp-8-13-0-release-notes)、
[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config)。
