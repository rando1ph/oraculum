# Phase 1：本地 Codex GUI 实施与验证

实施日期：2026-10-21（Asia/Shanghai）。**本轮实施与验证完成，等待独立审阅；Notion Task 保留 In progress，不自行标记 Done。**

- [Project 正典](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)
- [原 Phase 1 Task／审阅入口](https://app.notion.com/p/3ff5421e690b81e799abddca8a48e24b)
- 从 Phase 0B 的 `5e9f4de` 增量实施；分支 `feat/phase-1-local-gui`。仅本地 commits，未 push。
- 本文记录实现和证据，不构成第二份架构正典。Android 真机验收延期至 Phase 2 开始前或初期；本轮未执行 Android 真机、远程部署或 Live UI 发布。

## 范围对照

| Task | 实施结果 | 验证与边界 |
| --- | --- | --- |
| 1A 原生会话 | 官方 thread/start、thread/list、thread/read、thread/resume、turn/start、turn/interrupt；会话列表支持原生游标；固定工作区过滤及恢复前 cwd 复核 | 真实 GUI 新建、选择、重开、Bridge/App Server 重启后恢复同一线程及继续／中断通过。无自建对话历史或 Agent Loop |
| 1A 模型／配置 | model/list 动态分页与 effort 选项；config/read 仅投影模型、effort、provider；显示继承和显式覆盖、最近查询配置 | 真实目录 7 个模型；配置初始 gpt-6-astra/high，测试显式 gpt-6-luna/low，原生历史查询确认 low。未逐模型测试权限；不写全局配置 |
| 1A 消息／状态 | 安全 Markdown、代码复制、原生 turn 状态／错误、工具流、连接与同步状态分别展示；按线程、轮次、item 归属和去重 | 真实流式输出和 interrupted；failed 及旧事件／快照竞态为模拟测试。查询期间重叠 delta 不重复追加，并提示可能缺片段 |
| 1B 工具／文件 | 可折叠命令、cwd、输出、exitCode、耗时；文件状态与路径；可收起右侧只读 CodeMirror 6 Diff，复制；原生轮次 diff 与计划 | 真实 apply_patch、node 测试、fileChange、原生 diff、最终恢复后复制通过。没有 GUI 自行改文件、计算替代执行事实或调度工具 |
| 1B 审批 | 原始 JSON-RPC server request ID＋本 Bridge 审批 token 校验，响应只带原生 ID 和 decision；先移除 pending 防重复 | 真实命令 accept/decline；文件 allow、过期、重复及不支持请求为模拟测试。token 仅防旧审批误用，不是持久发送幂等凭据 |
| 1B 历史 | 优先 thread/turns/list + thread/items/list；明确能力错误时降级 thread/read；GUI 可加载更早轮次 | 0.160.0 无 experimental opt-in 即可分页，但被拒绝命令仍不在持久历史。界面明确“部分历史未能恢复”；实时缓存不持久化、不冒充历史 |
| 1C 验证／交付 | 协议锁、30 项 unit/contract、Electron 模拟 UI、真实订阅 E2E、本文和原 Task 回写 | 本地可复现；没有 VPS 依赖。正式阶段验收由审阅者确认 |

## 启动与复现

环境：Node 24.21.0、pnpm 10.34.7、Codex CLI 0.160.0、Electron 44.9.1（Chromium 152.0.7977.167）。沿用 0B 的 React 19.3.1、Vite 8.3.4、TypeScript 5.9.3、Vitest 3.2.7、Playwright 1.64.1。新增精确版本：react-markdown 10.1.0、@codemirror/view 6.43.15、@codemirror/state 6.7.6；仍为一个 pnpm lockfile。

在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm protocol
pnpm check
pnpm test
pnpm build
pnpm bridge
```

另一个终端运行：

```bash
pnpm desktop
```

Bridge 独立于 Electron，默认仅监听 `127.0.0.1:17860`，默认工作区为 `~/.cache/oraculum/workspaces/local`。它现在是稳定目录，不再每次启动随机换目录；原生线程可跨 Bridge 重启找回。新建空线程尚未产生 rollout 时使用原生 start 响应展示，尚未发送的空线程不承诺跨进程持久化。

可通过 `ORACULUM_WORKSPACE` 显式选择该缓存根目录下的测试子目录，通过 `ORACULUM_PORT` 改本机开发端口；Electron 对应使用 `ORACULUM_URL=http://127.0.0.1:端口`。不接受 renderer 传入任意 cwd、配置写入或权限覆盖。当前启动范围仍是受控工作区，不是任意项目选择器或正式常驻服务。

```bash
# 无模型请求；实际启动 Electron，Codex 事件由夹具模拟
pnpm test:ui:mock

# 有限真实订阅 E2E；自动创建隔离工作区、临时 Bridge 和 Electron
# 默认 gpt-6-luna / low；三轮（第三轮立即中断），不会随 pnpm test 自动运行
pnpm test:phase1

# 只读历史探针：不 resume、不发起推理，限制为 Oraculum 测试线程
ORACULUM_PROBE_THREAD=<原生测试线程ID> pnpm test:history
```

需要可用的 Ubuntu 图形会话。Electron 二进制安装沿用 0B 文档；未进行系统级安装。`test:live` / `test:ui` 保留为旧 0B 脚本，需要其原有 fixture 工作区；本轮复现入口是 `test:phase1`，不应把旧脚本当作新验收入口。

## 真实 E2E 证据

真实订阅最终运行：`scripts/phase1-live.ts`，exit 0。隔离目录：`~/.cache/oraculum/workspaces/phase1-b8aCOH`。所有模型测试限制于目录中的 `sum.mjs`、`sum.test.mjs` 和明确的无副作用 printf；没有其他项目修改。

线程：`01a15a44-93d0-7233-88a5-eae4251a80bf`。

| turn ID | 事实 |
| --- | --- |
| `01a15a44-9450-7460-97d1-ddc0ecea14f7` | completed：读 fixture → apply_patch 将减法改成加法 → node --test 成功 → GUI 允许／拒绝 → Markdown 最终回复；GUI 显示文件 Diff |
| `01a15a44-e94d-77b0-90fb-28ebe39a7076` | completed：执行 sleep 4 + cat；执行中关闭整个 Electron 进程，重新打开仍恢复同一线程并看到 ORACULUM_REOPEN_OK |
| `01a15a45-1398-72d1-bb92-fb68dc40855a` | interrupted：停止并重建 Bridge/App Server 后，从原生列表 resume 同一线程；通过 GUI 继续发送并立即停止 |

审批证据：

- request ID **0**，item `exec-91f69158-2309-48af-a027-ebdd77e3552f`，`/bin/bash -lc 'printf ORACULUM_ALLOW_OK'` → GUI **accept** → command completed、exitCode 0、输出 ORACULUM_ALLOW_OK。
- request ID **1**，item `exec-86d5ef35-a06b-4fd9-a0c4-9eda16e76bda`，`/bin/bash -lc 'printf ORACULUM_DECLINE_OK'` → GUI **decline** → command declined；模型未换路重试。
- 脚本只允许预先列出的精确无副作用命令，遇到其他审批会失败退出，不自动放行。
- 真实节点事件包括 turn/started、item/started、item/agentMessage/delta、item/commandExecution/outputDelta、item/completed、turn/diff/updated、serverRequest/resolved、turn/completed。
- `node --test sum.test.mjs` 的原生命令 exitCode=0；脚本另在同目录独立运行一次测试，实际输出 `tests 1 / pass 1 / fail 0`。
- GUI renderer 中 `require`、`process` 均为 undefined；真实 E2E 没有 renderer pageerror。

最终版本另做**零推理**原生恢复验证：重新启动 App Server、Bridge、Electron，恢复上述三个 turn；新建空原生线程，再从侧栏选择原持久线程；原生历史恢复 fileChange Diff、最近查询配置 gpt-6-luna/low、interrupted 状态，Diff 复制成功。见 `final-native-recovery.json` 和 `final-native-recovery.png`。

本轮总共触发 **4 个受控模型 turn**：首个测试脚本同步问题导致提前结束的尝试 1 轮；最终通过的 E2E 3 轮，其中 1 轮立即中断。只读历史／最终恢复探针、模拟 UI 不产生推理请求。没有批量调用模型。

## 历史能力核验与诚实降级

对 0B 原线程 `01a15a0d-ec4c-73a3-b74b-d3ed121578e5` 分别以 `experimentalApi=false` 和 `true` 握手，实际调用 thread/read(includeTurns=true)、thread/turns/list、thread/items/list；后两者均以 limit=1 验证游标。两种 capability 设置均可读取，无需默认开启实验接口。本轮保持 `experimentalApi=false`。

三个原生读取路径都没有恢复 0B 的被拒绝 item `exec-1bcec9f7-eb14-45fd-986b-95350e14a370`。最终 Phase 1 实测被拒绝 item 也未进入原生分页结果。因此：

- 优先读取官方分页；不是声称找到了完整持久事件日志。
- 普通网络／RPC 错误如实显示；只有明确不支持分页／能力／存储模式的原生错误才降级为 thread/read，并说明来源。
- 每页 20 个 turn；逐 turn 获取 item 页，每页 100 个 item、最多 50 页。超长轮次达到上限会明确提示截断；尚无完整长会话压力测试。
- 同一窗口保留已收到的原生实时事件，并标记“实时事件 · 未确认持久化”；切换／重开后只从原生接口查询，不写入独立历史数据库。
- 待审批保存在当前 Bridge 进程；Bridge/App Server 在审批中重启后的恢复、故障时持久回执与跨端争抢矩阵仍属于 Phase 2，未宣称完成。

## 检查输出与故障记录

最终 `pnpm install --frozen-lockfile --offline` exit 0，lockfile up to date；之后 `pnpm check`、`pnpm test`、`pnpm build`、`pnpm test:ui:mock` 均 exit 0。

```text
Test Files  5 passed (5)
Tests       30 passed (30)
Vite        188 modules transformed
index JS    358.12 kB (gzip 111.60 kB)
Diff JS     208.81 kB (gzip 67.40 kB)
```

CodeMirror 按需加载；最初超过 500 kB 的主包告警已通过按需加载消除，没有调高告警阈值。测试覆盖线程/cwd 边界、原生审批 ID／token／重复、unsupported 输入／MCP elicitation／权限请求安全拒绝、Host/Origin、原生分页和降级、版本/schema 指纹、失败／中断、晚到事件与查询竞态、断线／超时不自动重发。Electron 模拟 UI 另验证 Markdown/HTML 与不安全 URL、防重复 item、工具输出、只读 Diff、复制、失败提示、393px 无横向溢出；移动 viewport **不是 Android 真机证据**。

保留的失败与修复：

1. 历史测试夹具将 nextCursor 推断成 null，导致一次 TypeScript 检查失败；修正测试声明后通过。
2. 首次 live 已完成读、改、测试和 allow；等待下一次审批时误读了第一张尚未退场的卡，脚本精确命令断言阻止继续操作并关闭测试进程。调整为等待原生下一条命令／审批后，完整 E2E 通过。失败证据为 `live-attempt1.json`，不计为通过的完整 E2E。
3. 两项新增 turn 安全测试先失败：晚到的旧 turn/completed 会解除新 turn busy，interrupt 未检查 active turn。现按原生 ID 校验，并防止旧查询结果覆盖更新的终态；回归通过。
4. 实际复制检查先失败：0B 的全拒绝权限 handler 拦截 clipboard-sanitized-write。现只允许可信 loopback 主 frame 写剪贴板；实际按钮显示“已复制”，clipboard-read 反向测试仍拒绝。未添加 Node、preload 系统权限或任意 IPC。

## 安全、限制与后续

- 全程未 push、未 sudo、未登录或改动 VPS/Caddy/SSH/网络映射／持久服务，未改其他项目。现有 Android 源码与构建成果保留。
- `AGENTS.md` 与 `~/.codex/config.toml` 的开工／结束 SHA-256 对比均 OK；未读取或复制认证文件。官方认证只由 Codex 使用。
- 沿用 0B 的测试子进程限制：MCP、plugins、apps、multi-agent、web search 禁用；线程固定 workspace-write / on-request / user reviewer。这些是进程／线程参数，不写回全局配置。workspace-write 不是完整读取隔离；实际测试命令和提示只限测试 cwd。
- 不支持的原生交互返回 JSON-RPC error 并在 UI 提示安全拒绝，不授予权限，不静默等待。MCP elicitation、用户输入、权限变更的完整 UI 尚未实现；文件 approval 的真实模型触发未覆盖，只有模拟 allow/ID/过期验证。
- Electron 仍启用 sandbox/contextIsolation/webSecurity，关闭 nodeIntegration/webviewTag，拒绝外部导航和新窗口。为 CodeMirror 动态样式允许 CSS inline；script-src 仍仅 self，没有 unsafe-inline 或 unsafe-eval 脚本权限。
- 未确认发送不会自动重发；Bridge 内保留 unknown-send 阻塞，已明确拒绝的原生 RPC 错误可在查询后手动继续。JSON-RPC id、clientUserMessageId 和审批 token 均**不是跨进程持久幂等保证**。未知发送跨 Bridge 重启的完整对账尚未验证。
- 真实 failed 模型 turn 未主动制造；UI failed 状态由模拟验证。长会话性能、移动输入法／锁屏、远程 WSS、配对、多设备、Live UI 原子发布回滚和正式打包不在本轮验收内。
- 测试用 17860／17861／17862 本机服务已在结束时停止；再次使用需按上方命令启动。后续 Phase 2 必须先通过 Android 真机最小加载／输入／审批门槛。

## 证据与 Git

本地生成证据位于 `.local/evidence/phase1/`（被 Git 忽略，不提交日志、截图或构建产物）：

- `live-e2e.json`、`live-accept.png`、`live-decline.png`、`live-diff.png`、`live-restored.png`：真实完整 E2E。
- `final-native-recovery.json/png`：最终版本零推理恢复、会话选择、Diff 和复制。
- `history-probe.json/log`：原生 stable/experimental 两种握手下的只读分页对照。
- `ui-contract.json`、`simulated-diff.png`、`simulated-mobile.png`：模拟 Codex + 实际 Electron。
- `final-checks.log`：最终检查输出；`live-attempt1.json`、`ui-copy-failure.json`：失败记录；`baseline.sha256`：未改动边界核验。

实施提交（本地、未 push）：

1. `9ed62b638f8583be6872269737f766f544da26bd` — feat: restore native local sessions and expose model settings
2. `b864ffb1cfd40faf46d56e7b9357ad50721d9999` — feat: display native tools diffs approvals and paginated history
3. `ef1a30c272f418a0a2aff2ca6f11e0abe04dfc63` — test: validate local Codex GUI lifecycle and recovery boundaries

本文的独立文档提交 hash 与最终证据指纹写回原 Notion Task，避免在文件中自引用其自身 commit。回退可逐提交 revert；原 `AGENTS.md` 修改不在这些提交中。未推送的本地证据不能被远端审阅者视作已独立复跑。

技术依据：[官方 App Server](https://learn.chatgpt.com/docs/app-server)、[Electron permission handlers](https://github.com/electron/electron/blob/main/docs/api/session.md)、[react-markdown](https://github.com/remarkjs/react-markdown)、[CodeMirror 只读界面](https://codemirror.net/examples/readonly/)。具体能力以上述 0.160.0 现场证据为准。
