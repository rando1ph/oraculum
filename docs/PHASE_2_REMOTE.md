# Phase 2：Android 真机、远程接入与恢复

实施日期：2026-10-21（Asia/Shanghai）。**阶段 In progress；当前仅完成基线发布与本地构建检查，2A 真机未验收。**

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

## 当前检查证据

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

## 2A 真机阻碍与继续方式

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
- 2A 真机缺少真实证据，2B/2C 尚未进入。Task 保持 In progress，阶段未完成，不能标记 Done。
