# Phase 0A：只读环境审计

审计日期：2026-10-20（Asia/Shanghai）。状态：审计完成，等待用户审阅；未进入 Phase 0B。

- 决策依据：[Oraculum 项目正典](https://app.notion.com/p/3ff5421e690b81bdae14c0675f0b3acf)。
- 完整报告、命令证据及提交记录：[Phase 0A Task](https://app.notion.com/p/3ff5421e690b810cbf9cd8e3fe05a76b)。
- 本文是环境快照，不替代正典，不代表双端或生产验收。

## 结论

既定架构具备进入最小技术验证的基础，未发现必须改变冻结架构的证据。官方
App Server 可由本机启动并通过 stdio 通信；原生 Schema 覆盖会话、模型、
reasoning effort、工具和审批。现有 DSH SSH/Caddy 可作为候选中转。

目前不能宣称真实模型调用、审批闭环、断线恢复、双端 GUI 或远程 WSS 已通过。
主要门槛是开发工具链补齐、原生状态恢复与操作去重验证、独立远程入口设计，以及
VPS 资源余量。Phase 0A 未安装依赖、开发业务代码、建立反向隧道或改动服务。

## 方法与证据等级

- **D（文档）**：已读取的官方说明，不等于本机验证。
- **S（Schema）**：本机 `codex 0.160.0` 导出的协议定义，不等于运行行为。
- **R（实测）**：本轮实际命令或请求结果；注明隔离环境及覆盖范围。
- **U（未验证）**：留待 Phase 0B 或后续授权阶段。

只读取现有配置中的必要非秘密字段；未输出认证文件、私钥、令牌或完整敏感配置。
Schema、类型和协议探针产物仅写入本轮临时目录，不入库。探针使用空的临时
`HOME`、`CODEX_HOME` 和 XDG 目录，精简环境变量；未复制现有认证或配置，
未执行 `thread/start`、`turn/start`、工具调用及审批响应。真实用户配置哈希前后相同。

## 小新环境（R）

| 项目 | 现场结果 | 影响 |
| --- | --- | --- |
| 系统 | Ubuntu 26.04.1 LTS，x86_64，内核 7.0.0-38-generic，Wayland | 仍需 Electron/输入法实机验证 |
| 资源快照 | 30 GiB 内存，约 22 GiB available；项目盘约 814 GiB 可用 | 非性能基准 |
| Codex | `codex-cli 0.160.0`，用户目录 standalone 安装 | 记录为 0B 协议基线候选 |
| 登录 | `codex login status`：ChatGPT 登录，exit 0 | 未验证令牌刷新、有效额度或模型请求 |
| 用户配置 | `model=gpt-6-astra`，effort=`high`；3 个 MCP 配置项 | 只读计数；MCP 连通性未测 |
| Node / npm | 24.21.0 / 11.19.0 | 可作为构建基线候选，未锁全依赖 |
| pnpm / Corepack | pnpm 不在 PATH；Corepack 0.36.0 已安装 | 未启用 shim、未触发下载 |
| Git / Python | 2.53.0 / 3.14.4 | 审计与版本控制可用 |
| 原生构建 | GCC 15.2.0、Make 4.4.1、pkg-config 2.5.1 | SQLite Node addon/打包未编译 |
| 桌面库 | GTK 3、NSS、GBM、ALSA 运行库已安装 | 不代表 Electron Forge 已就绪 |
| Java | OpenJDK **JRE** 25.0.4.1；`javac` 不在 PATH | 未找到完整 JDK |
| Android | ADB 1.0.41 / 34.0.5；系统 SDK 目录只有 platform-tools | 常用目录未找到 platform/build-tools/cmdline-tools |
| Android 构建 | Gradle、sdkmanager、kotlinc 不在 PATH；SDK 环境变量未设置 | 不具备已验证的 APK 构建链 |
| Gradle 缓存 | 8.9 仅见 `.zip.part` / `.lck`，未见完整分发 | 不当作已安装 Gradle |
| SQLite | 系统 libsqlite3 3.46.1；CLI 不在 PATH | 未安装/测试 better-sqlite3 |

依 [Gradle 官方兼容矩阵](https://docs.gradle.org/current/userguide/compatibility.html)，
Java 25 运行 Gradle 的支持始于 9.1.0；不能复用 8.9 缓存作为兼容证明。
0B 应选择并锁定 JDK、Gradle、AGP、Kotlin、SDK 的兼容组合，不修改其他项目。
未运行 ADB 设备枚举以避免启动 daemon；Android 真机/WebView 版本尚未核验。

本机 `3080` 已由 CodeG 监听；代理端口 `7897` 已占用，当前 HTTP(S)/ALL_PROXY
指向该端口。`codeg-reverse-tunnel.service` 正运行，目的地是 **PROXY VPS**，
远端环回端口 `13080` 映射本机 `3080`，不是 DSH。应保留这些现有链路。
用户服务 `Linger=yes` 为独立 Bridge 生命周期提供条件；休眠、重启和代理环境继承未测。

## App Server 协议核验

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 描述双向 JSON-RPC，
stdio 使用逐行 JSON，并省略 `jsonrpc` 字段。必须先 `initialize`，再
`initialized`；审批是服务端请求，需要客户端响应。公开 WebSocket 接口仍标为
实验性；本项目继续按正典采用本地 stdio。

| 能力 | D / S 支持 | R：本轮范围 | U：后续验证 |
| --- | --- | --- | --- |
| 启动/握手 | stdio、`initialize` / `initialized` | 隔离进程成功；退出码 0 | 真实配置与 MCP 初始化 |
| 会话 | `thread/start/list/read/resume/fork`、`turn/start/interrupt/steer` | 空 `thread/list`、`thread/loaded/list` 成功；不存在 ID 的 read 返回 -32600 | 创建、恢复、继续、中断真实会话 |
| 模型 | `model/list` 含分页、默认项、effort、service tiers | 未登录隔离环境返回 8 项、无下一页 | 订阅可用模型与实际推理 |
| 思考强度 | `supportedReasoningEfforts`；`turn/start.effort` | 目录返回各模型选项 | 切换及继承行为 |
| 模式 | `plan/default`；`collaborationMode/list` 属实验性方法 | 仅查 Schema | capability 协商与模式执行 |
| 工具/消息 | `item/started/completed`、文本/命令/文件增量、MCP progress、turn diff | 仅查 Schema；未触发模型/工具 | 真实流式事件及失败事件 |
| 审批 | 命令、文件、permissions、用户输入、MCP elicitation；`serverRequest/resolved` | 仅查 Schema | allow/deny/cancel、跨端抢占、重连 |
| 历史恢复 | `thread/read`、`thread/turns/list`、`thread/items/list` | 查字段与分页结构 | 历史分页、增量合并、待审批重建 |

隔离目录模型：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、
`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`。
`account/read(refreshToken=false)` 同时返回 `account=null`。因此这只是可返回的目录，
不能当作用户权限清单。GUI 必须动态消费目录，并以真实请求结果处理不可用模型。

本机 Schema 中 `ReasoningEffort` 是非空字符串，不能硬编码成旧的有限枚举。
`thread/read(includeTurns=true)` / resume 全历史装载对分页会话已有弃用提示。
`thread/list` 默认可能扫描并修复状态元数据；探针特意使用 `useStateDbOnly=true`，
且不访问用户真实会话库。

Schema 存在 `clientUserMessageId`，但本轮未找到 `turn/start` 的持久幂等保证。
JSON-RPC `id` 不能直接视为 exactly-once 依据。resume/read 响应未见独立持久待审批
列表；`serverRequest/resolved` 是通知，不是完整重放契约。审批须区分 RPC request ID、
`itemId` 与可选 `approvalId`，不能仅按 item 去重。以上均须用故障注入验证。

### 版本与校验（S / R）

- 默认 JSON Schema：314 文件；104 客户端方法、10 服务端请求、83 通知。
- 加 `--experimental`：440 JSON 文件、167 客户端方法、11 服务端请求、83 通知。
  “默认导出”不代表所有嵌套字段均已稳定；仍须检查字段说明及 capability。
- 默认 TypeScript 导出：734 文件，命令 exit 0；本轮未安装 tsc，未进行类型编译。
- 314 个默认 JSON 文件均可解析；4,311 个内部 `$ref` 均可解析。
- 5 个成功查询响应通过已安装 `jsonschema` 的 Draft 7 校验。
- 临时 `CODEX_HOME` 导出/启动提示拒绝在临时目录创建 PATH helper；上述操作仍成功。

| 对象 | SHA-256 |
| --- | --- |
| Codex 二进制 | `12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad` |
| 默认完整协议 bundle | `8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e` |
| 默认 v2 bundle | `81a88c04ae4984b16d73080f4109d0477682bc76c8adbe483e371175ce54c054` |
| 实验性完整 bundle | `7243ba241962af92ca60581f1a81808ebda4212a800f8b205f54703bcfd508c5` |

## DSH VPS（R）

通过本机现有 `dsh-vps` alias、root/22 和既有 host key 只读连接成功。
使用 BatchMode、StrictHostKeyChecking=yes、UpdateHostKeys=no、ClearAllForwardings=yes，
未建立转发、未改变 known_hosts 或 SSH 配置。

| 项目 | 现场结果 / 冲突 |
| --- | --- |
| 系统 / 资源 | Ubuntu 26.04.1，2 vCPU，1,735 MiB 内存；约 449 MiB available，swap 已用约 1.3 GiB；load 约 4.5–5.1 |
| Caddy | 2.11.7；`caddy.service` active，运行用户 caddy |
| 活跃入口 | 443/TCP，h1/h2；host 为 VPS IP；无 Oraculum host/path |
| TLS | Let's Encrypt YE2 IP SAN；本机直连 TLS 1.3 系统信任校验通过；证书截止 2026-10-26 10:05:36 UTC |
| HTTP | 对现有入口匿名 HEAD 返回 401；未认证进入应用 |
| Caddy 路由 | 到 `127.0.0.1:3444`；`/api/mobile-access`、`/relay` 及其子路径先返回 403 |
| 既有应用 | `dsh-web.service` active，root 运行；未发现名为 CodeG/Codex 的服务或进程 |
| 占用端口 | 公网绑定 22、443、3443；环回 2019（Caddy admin）、3080、3444；另有 DNS/NTP 等系统端口 |
| SSH 策略 | `allowtcpforwarding yes`、`gatewayports no`、`disableforwarding no`、`permitlisten any`、`permitopen any` |
| 密钥限制 | root authorized_keys 单条记录未见禁止端口转发标记；未输出公钥/私钥 |
| 防火墙可见层 | UFW inactive；iptables 基础策略 ACCEPT；云安全组与完整网络策略未核验 |

Caddy 磁盘配置与运行中 admin API 均已只读核对；配置哈希复查不变。
当前入口是 IP 证书，不是已准备的 Oraculum 专用域名。未确定域名时不能宣称 DNS 就绪。
3443 绑定所有 IPv4 接口，不能因此断言已穿过云安全组公网可达；本轮不改其暴露策略。
VPS 的高负载和 Chrome 多进程只是当时快照，未做性能归因或清理。

反向隧道在策略层面可行；`GatewayPorts=no` 符合环回监听目标，但尚未实测 bind、
自动恢复和 WSS。候选 **本机/远端环回 17860** 在本轮监听快照中未占用，仅供
0B 复核，不是已保留端口或部署决策。不得复用 3080/3443/3444/2019 或现有 PROXY 隧道。

依 [Caddy 官方说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)，
reverse_proxy 支持 WebSocket，默认配置卸载/reload 可关闭流连接。因此未来新增入口
仍需评估对现有 DSH 长连接的影响；本轮没有 reload、证书签发或配置修改。

## Phase 0B 的验证门槛

1. **工具链**：经下一阶段授权补齐 pnpm、JDK 和 Android SDK；锁定 Node、前端、
   Electron/Forge、Fastify、SQLite addon、Gradle/AGP/Kotlin 组合；双端最小构建通过。
2. **官方真实链路**：保留用户配置/认证，在隔离测试工作区验证创建/继续/恢复/中断、
   模型与 effort 切换、命令/文件/MCP 事件及审批。默认配置不一定会产生人工审批，
   需明确测试会话的权限策略，不改全局配置。
3. **恢复与去重**：GUI 断线、两端同时审批、丢 ACK、Bridge/App Server 分别重启，
   检查分页历史、pending 请求和原生 IDs；无法判定的发送结果显示“未知”，不重发。
4. **双端与 Live UI**：Electron/Android WebView 加载同一静态 UI；实测中文输入、
   键盘、锁屏/Doze、恢复；验证 CSS/JS/React 发布回滚与原生权限隔离，不限缩定制能力。
5. **远程条件**：明确独立域名或路由、可用环回端口、设备认证/Origin 校验、专用 SSH
   最小权限。任何 VPS 改动另行授权；验证 WSS、隧道断开和重建、既有业务不受影响。
6. **资源与生命周期**：Bridge 独立于 GUI；测量空闲/长任务开销、休眠/网络切换行为，
   特别关注 DSH 当前资源余量。仅将 VPS 用作入口，不迁移 Codex 执行。

## 交付边界

本轮只新增此报告并写回关联 Notion Task。原有 `AGENTS.md` 未提交变更保持原样，
不纳入本次 commit；未添加 README、业务代码、依赖、配置或生成产物，未 push。
任务状态保留为 In progress，并在正文注明“审计完成，待用户审阅”，不代替正式验收。
