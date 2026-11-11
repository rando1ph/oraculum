# Oraculum 2.0 Phase 1｜Gateway 工程交付与验收

交付日期：2026-11-11。**P1.1–P1.5 工程成果已交付，正式 Task 保持 In progress，等待独立技术审阅和用户接受。** 本阶段不进入 Phase 2，不等同正式安装、生产部署或对外发行。

正典：[升级子项目](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、[Phase 0 结项](https://app.notion.com/p/4155421e690b81829fe6ce746cff195d)、[Phase 1 正式任务](https://app.notion.com/p/4155421e690b818b8d19e6ab806641bd)。开工直接读取以上页面和 `AGENTS.md`，先同步最新主题/设计裁定，再施工。Notion 优先于旧报告。

## 1. 里程碑覆盖

| 里程碑 | 实现与证据 | 工程状态 |
| --- | --- | --- |
| P1.1 公共协议/职责拆分 | Draft-07 单源、HTTP/WSS/错误/能力/安装与代次契约；67 个生成 DTO；同一组 TS/Kotlin fixture；Gateway 不含 UI/主题托管 | 已实现并验证 |
| P1.2 新状态/CLI/认证 | 独立配置和 SQLite、6 张最小表、内核单实例锁、init/status/pair/devices、配对竞争/ACK 恢复、短 access 与撤销 | 已实现并验证 |
| P1.3 官方通信 | 官方 stdio、experimentalApi=false；项目/Thread 列表、读取、新建、显式恢复，Turn 发送/流式/中断、当前原生交互 | 真实 Codex 核心路径通过；被动 input/MCP 形态另见限制 |
| P1.4 可靠性/主机文件 | 持久操作回执及 unknown 屏障、审批竞争、epoch/设备序号/回补、快照校正、原生历史分页/详情、inode/描述符文件授权、上传与认领 | 单测/故障注入/真实核心路径通过 |
| P1.5 独立候选 | 自包含 Node 的 Gateway DEB、CLI、未启用 user unit、旧 CLI 冲突预检、8 组隔离验包，包内主入口直接运行 | 候选交付；未正式安装或启用 |

实现入口：[Gateway 运行说明](../../gateway/README.md)、[公共协议与接入](../../packages/gateway-protocol/README.md)、[Schema](../../packages/gateway-protocol/schema/v2.json)、[服务协调](../../gateway/src/service.ts)、[HTTP/WSS](../../gateway/src/server.ts)。

## 2. Git 与构建来源

全程只在原工作区 `main` 开发；未创建分支/worktree、合并或重写历史。开工 fetch 后本地/远端为 `e05317d0e09f9234ad711819140b57e38f9f81ae`，ahead/behind=0/0。仅有用户未跟踪的 Stitch 目录，始终保留并排除提交/构建。

| 提交 | 内容 |
| --- | --- |
| `6146de82c5259b6aba3c0bcb8410409e8ef14292` | 同步 Phase 0 最终主题、设计与阶段授权裁定 |
| `a60ef1928e0514b9019ae688d95aca97a1887dfe` | 独立 Gateway、协议、新状态/认证、Codex 适配、文件/恢复、测试 |
| `3f7ecce6d13c0d221eb48705ce9a93366eee3648` | 独立 DEB、私有 runtime、清单/许可证与隔离校验工具 |
| `d07c7596f66be0978d2a7439faed9594f3011e1a` | 修正隔离验证器的 namespace 祖先目录归属 |
| `db54fbc70701d3b2cd9f1feb40c2ad2d310cb423` | 收窄原生分页未实现错误分类，限定只读恢复重试 |
| `9709e9547e21848b9bde42267d5f4e3620604a68` | 实际运行包内 Gateway 主入口，核验真实流/历史与恢复收敛 |
| `86775102c41335b424c1b3fcb4a19aec1ad216b6` | 未知原生状态与压缩通知使历史/游标失效，未知正文不透传 |

**最终候选构建来源：`86775102c41335b424c1b3fcb4a19aec1ad216b6`，sourceDirty=false。** 每步均正常推送，并核对 HEAD、origin/main 和实时远端 SHA 一致；证据逐步回写 Notion。本报告之后的归档提交不改变上述候选的运行源码；最终仓库同步 SHA 在正式 Task 回写。

## 3. 关键实现取舍

- 沿用 Node 24、TypeScript、Fastify 5.12.7、@fastify/websocket 11.3.4、SQLite。新服务包/入口 `oraculum-gateway`，用户 CLI `oraculum`。运行链路没有 React、静态页面或主题服务。
- JSON Schema 为 DTO 唯一字段来源。锁定 quicktype-core 24.0.0、既有 Ajv 8.20.0；生成器按 Schema 语义给 Kotlin 必填属性加 `@Required`，TS 任意 JSON 收窄为 unknown；生成结果不手改。Kotlin 编译器 2.1.20、kotlinx.serialization 1.8.1 的公开 artifact/SHA-256 也已锁定。
- 新库只有 gateway_meta、devices、pairing_codes、projects、operations、attachments。没有原生会话/消息/工具/审批历史、客户端草稿、主题或持久事件表。未建立未经真实需要证明的权限提示表。
- 目录 0700、配置/库/配对文件 0600，检查 UID、符号/硬链接、祖先路径和 schema。SQLite foreign_keys=ON、synchronous=FULL、短事务、有限 busy_timeout。flock 仅锁 Gateway 进程，CLI 可并发短事务；崩溃后由内核释放。
- 项目路径仅在 active 注册中唯一，注销墓碑保留；显式重新注册分配新 ID 与新 inbox。注销前检查 unknown，回执预留也复查项目仍 active。项目注册回执的 project_id 可在事务内暂为空，插入项目后同事务绑定并确认，不复制旧注册。
- 配对码有 160 位随机性、5 分钟 TTL、事务内一次消费；客户端预生成 UUIDv4/32 字节秘密。长期凭据只存摘要，access 仅内存、最多 10 分钟，长期信任无自然到期。ACK 丢失后 token 交换可重试，不做 refresh rotation。
- 所有业务写先持久预留 operationId，才可调用原生。重复 POST 一律 409；不存正文/摘要来猜测 payload 是否相同。unknown 新线程阻塞项目，unknown Turn 阻塞线程，其他设备共同遵守。原生 ACK 与本地持久化之间崩溃仍 unknown。
- 审批只对应当前 epoch/原生请求/generation；无 await 的单次占用阻止多端竞争。stdin 写完成不等于原生接受，匹配 resolved 才校正回执。只使用原生实际提供的决定，未知形态 fail closed；不推测执行成功或永久授权。
- 事件先过滤到设备再分配 seq，避免跨设备回执泄露和假缺口。重启/丢失连续性要求 reset；快照观察序号不是原生水位。恢复基线与活动 delta 分开，完整终态按原生 Item ID 覆盖。
- 未知原生 thread/turn/item 通知只产生保守同步失效信号，不转发未知正文；相关游标失效，原生压缩 Item 更新历史修订。
- 主机访问固定授权根/项目/祖先目录与文件身份，逐级使用描述符/O_NOFOLLOW。文件 grant 绑定设备/项目/可选线程/文件版本，下载有 Content-Digest 并持续复查撤销和变化。上传只写本安装及项目的新 inbox；附件认领与 Turn 回执预留同一事务，held/unknown/sent 不因 TTL 删除。

## 4. 验证结果与证据性质

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 通过 | 7 个 workspace，无浮动依赖更新 |
| `pnpm check` | 通过 | 全仓严格 TS 检查 |
| `pnpm test` | 820/820，71 个测试文件 | 原有 594 项；新增 Gateway/协议 222 项和打包 4 项 |
| `pnpm verify:gateway:protocol` | 通过 | 67 个 Kotlin DTO 实际编译；75 组 TS/Ajv/Kotlin 往返、20 组非法输入拒绝；重新生成逐字比较 |
| `pnpm test:gateway:faults` | 4/4 实际 SIGKILL 切点通过 | 上游明确模拟，SQLite 和进程崩溃真实；不以它替代官方模型验收 |
| `pnpm test:gateway:live` | 通过 | 官方 CLI codex-cli 0.167.1，专用临时项目/线程；隔离 HTTPS/WSS、自签 CA 仅被测试客户端信任 |
| 独立 DEB 校验 | 8/8 组通过 | 真实 dpkg/一次性 root/只读宿主；包内 CLI 与主入口实际运行；主入口使用有限 stdio 夹具 |
| Stitch 原件 | 12 个 SHA-256 不变 | 不移动、不重命名、不修改、不提交 |

复验命令：在仓库根目录运行 `pnpm check`、`pnpm test`、`pnpm verify:gateway:protocol`、`pnpm test:gateway:faults` 和 `pnpm test:gateway:live`；真实联调会创建新的专用临时项目和原生线程。隔离验包为 `pnpm verify:gateway:deb dist/gateway/86775102c41335b424c1b3fcb4a19aec1ad216b6/oraculum-gateway_2.0.0_amd64.deb 86775102c41335b424c1b3fcb4a19aec1ad216b6`。构建命令为 `pnpm build:gateway:deb`；它要求已提交的干净 main，新构建将记录当时的源码 SHA。

HTTP/WSS 单测实际监听临时 loopback，覆盖 root/非 root Base Path、Host/Origin/协议头、匿名/撤销拒绝、无任意 RPC/页面/主题、重复写、跨设备回执/审批、快照/原生分页、上传 ACK 恢复和文件授权。额外验证未 resume WS 的连接预算和下载内容摘要。

文件负例覆盖 symlink、祖先/文件替换、hardlink、FIFO、编码/穿越、敏感名称、嵌套项目、跨设备/线程/草稿附件、限额、撤销中止以及 held/unknown/sent 保留。大历史/宽数组/大 Item 以受控 fixture 验证内存与输出预算，不能据此宣称真实超长项目的性能基准已经完成。

### 实际崩溃切点

| 切点 | 重启前原生接收次数 | 恢复结果 | 重复/跨设备新 ID |
| --- | --- | --- | --- |
| 预留前 | 0 | 无记录 | 测试知道明确未发送，显式执行一次后 accepted；没有自动重发 |
| 预留提交后 | 0 | unknown | 同/跨设备重复 ID 和新 ID 的项目冲突写均被阻止 |
| 模拟原生接收后 | 1 | unknown | 不再派发 |
| 原生 ACK 后、本地结果提交前 | 1 | unknown | 不再派发 |

每例用独立子进程 SIGKILL，重开新库后 integrity_check=ok。**客户端不能从“没有回执”推导未执行**；预留前重试仅是具有明确故障切点证据的测试动作。

### 真实 Codex 闭环

1. 全新 SQLite/配置，两个设备经 HTTPS 配对；故意丢弃 pair 响应，使用预存身份换 token 恢复。
2. 注册专用目录，新建官方 Thread/Turn；WSS 接到真实 delta，原生历史与 Item 详情含预期内容，重复 operationId 被拒，另一设备不能查该回执。
3. 真实 WSS completed Item 与原生历史同 ID 内容相等；恢复终态快照后重放 11 条真实迟到 delta，不重复拼接，最终投影完整且与原生一致。
4. 断开 WSS 后用保留游标回补；新 Turn 立即 interrupt，原生历史确认 interrupted。
5. 当前 Codex 审批实际只提供 accept/策略对象/cancel；第二设备选择 cancel，原生确认 interrupted，resolved 使该响应回执收敛为 accepted（仅确认交付/生命周期，不表示执行了命令）。
6. 主机文件 list/select/download、越界/敏感/symlink/跨设备 grant 负例通过。文档上传回执可找回附件 ID；认领进入新 Turn，Codex 原生只读工具读到了测试文档内容。
7. Gateway/App Server 重启后 installationId、信任、回执保持，epoch 改变、旧游标 reset；显式 resume 原线程，重新读到原生历史。撤销设备使 HTTP 和现有 WSS 失效。

真实验收的 Codex config 哈希前后不变；清理无错误。仅创建专用测试线程，保留这些原生测试记录，没有删除已有用户线程、项目或配置。TLS 代理只监听本机临时地址/端口，不修改系统证书、VPS、Caddy、SSH、隧道或正式服务。

## 5. 调试中失败与处理

- quicktype 默认 Kotlin nullable 属性会在序列化时遗漏必填 null：改为 Schema 驱动的 `@Required`，共享往返 fixture 真实复验通过；生成文件末尾空行由生成脚本统一规范。
- 早期集成测试仍期待旧字段、非 UUID draft、不存在的 product fault hook 或错误 mock 方法名：对齐新 Schema/真实方法，故障注入通过测试层拦截及实际 SIGKILL 实现，产品没有远程故障开关。
- 早期真实审批脚本强求 decline，被 Gateway 正确拒绝：改为只选择原生提供的负向决定；当前为 cancel。未放宽审批边界。
- 早期真实复验有活动快照返回 NATIVE_UNSUPPORTED；专用 stdio 探针确认原生分页会明确返回未实现。精确分类已收窄，保留有界原生后备；协议测试客户端最多 3 次只读恢复并记录安全错误码，不重发任何写。具体 native/store 支持仍受运行时限制。
- user namespace 中 root 映射为 uid 65534，首次 packaged CLI 验证被私有祖先检查拒绝：只给验证器增加独立 tmpfs `/tmp`，产品权限检查保持严格；完整隔离复验通过。
- 归档核对补齐未知原生状态通知的失效处理与压缩修订，回归验证游标拒绝陈旧版本，避免默默保留旧投影。
- 高并发全仓测试曾使固定 700ms 的启动夹具早于监听退出：改为父进程观察实际 ready 后通知原生夹具退出；初始化使用独立 8 秒预算，短读超时测试不再误伤启动。

最终命令均通过；上述失败保留于本地调试证据，没有用改 Done 或自动重试写入掩盖。

## 6. 最终候选清单

候选目录：`dist/gateway/86775102c41335b424c1b3fcb4a19aec1ad216b6/`（Git 忽略）。构建前后检查已提交 main、sourceDirty=false，仅排除用户原始 Stitch 目录；没有复制该目录。

| 文件 | 大小/校验 |
| --- | --- |
| `oraculum-gateway_2.0.0_amd64.deb` | 30182380 bytes；SHA-256 `69a11fe62cdb40498d667b18525b17a1922f897ebdc5a516081cd1cd4a66a37f` |
| `manifest.json` | 880 bytes；SHA-256 `d587b6afd4b11dcf737bb5ab8af4ad66d87354351ae89743f8c58ec5ea1cd6ab` |
| 包内许可证清单 | 57 个实际 bundled 依赖；SHA-256 `7d16eb1f512aa4fc41204a5b5600a70d9ea28378144768f6b338a862bcdaa6a1` |

协议 2.0、minClientMinor=0；新状态 schema=1、读范围 1–1；私有 Node 24.21.0。DEB 仅含 `/usr` 程序文件、CLI 与 user unit，无 UI/主题/旧状态、秘密或服务自启脚本。包清单验证每个 payload 文件与许可证摘要、root 归属、权限和相对 symlink。

8 组验包包括：候选身份/全部 hash、实际 bundle 许可证、真实 dpkg 首装/重装保全、旧 Desktop CLI 归属冲突拒绝、未托管 CLI 拒绝、包内 CLI 全新私有初始化、包内主入口配对及认证 HTTP、移除仅删除程序且保留合成 Codex/旧状态。dpkg 预期拒绝的日志属于通过的负例。

只读宿主预检：当前 `oraculum 0.2.0` 持有 `/usr/bin/oraculum`。**正式安装前仍须另行审阅该文件归属冲突及服务/网络计划；本任务没有覆盖、卸载或替换它。** 旧 Bridge 无需为本次隔离测试停服。

本地证据：`.local/evidence/phase1/86775102c41335b424c1b3fcb4a19aec1ad216b6/`，含单测、协议、故障、真实通信与验包报告；包验证原始报告目录：`.local/evidence/phase1/gateway-package/verification-5uD6Ig`。原始配对码、凭据、TLS 私钥不进入这些汇总或公开报告。候选 DEB/缓存/日志/数据库不提交 Git。

## 7. 已知限制与 Phase 2 前置

- 官方 App Server 是唯一执行权威；当前实测 0.167.1，未改既有 0.160.0 协议锁，也不声称所有版本兼容。官方命令成熟度与默认协议面不同；`experimentalApi=false` 不等于上游全部 API 已获稳定承诺。[官方文档](https://learn.chatgpt.com/docs/app-server)
- Plan 模式、未验证 Plugin 目录与 Turn steer 首版能力关闭；没有插件市场/任意 RPC/额外执行系统。可选扩展读取失败不影响核心通信。被动 requestUserInput、权限子集、MCP form/URL 交互有结构/负例夹具；本次真实模型只触发了 command 审批，不冒充全部形态真实验收。
- 原生历史读取最多并发 2、预算 12 秒、原生帧 8 MiB；后备仍会读整段原生历史。投影 Item 约 16 KiB、页约 256 KiB；详情每页 64 KiB、单 Item 8 MiB、最多扫描 32 个原生 Item 页。过限显式失败，不解析 rollout 或建权威历史副本。
- 事件每设备 1024 条/2 MiB/5 分钟，全局 32 MiB；缺口/reset 必须重新读取。WS 每设备最多 4 个、全局 64 个，未 resume 有超时；断网很久不承诺完整回补。
- 永久 unknown 暂无人工强制清除入口，只提供查询与停止已观察活动 Turn；不重新编号、换设备或注销项目来绕过。后续客户端必须把 unknown 与草稿/可清理缓存分开持久化。
- 文件最多 64 MiB、grant 5 分钟、无 Range；目录最多扫描 4000 项并标 limited。上传最多 20 MiB/文件、6 个及 50 MiB/草稿，另有总量/设备/并发预算；已被原生历史引用的材料不按时间删除。
- 本次真实网络是隔离本机 HTTPS/WSS 代理，未做 Android 真机、Ubuntu GUI、真实公网空闲连接/断网、平台安全存储或生产性能验收。真实超长会话、客户端恢复/存储与平台行为留在对应已规划阶段。

进入 Phase 2 的前置是：独立审阅并接受本阶段契约、安全/恢复语义、候选与上述限制，用户另行明确批准 Phase 2。届时 Android 应按既定新身份/Keystore/Room/DataStore 及 Stitch token 开发；本阶段没有创建或启动该客户端任务，也没有修改 Stitch 原件。
