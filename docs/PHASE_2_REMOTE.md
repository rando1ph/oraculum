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
