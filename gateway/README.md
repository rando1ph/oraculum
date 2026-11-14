# Oraculum Gateway 2.0 Beta

独立 Node.js/TypeScript/Fastify 后端，提供设备认证的 HTTP/WSS 与主机文件接口；通过本机官方 `codex app-server --listen stdio://` 通信。Gateway 不托管客户端页面或主题，不执行模型、工具或代理循环。

## 隔离开发

需要 Node 24、pnpm 10.34.7、Ubuntu util-linux `flock` 和已配置的官方 Codex CLI。先安装锁定依赖，再明确创建独立配置/状态。以下是开发示例，不是正式安装或服务启用指令：

```bash
pnpm install --frozen-lockfile
pnpm gateway:cli init --config /tmp/gateway-test/config/config.json --state-dir /tmp/gateway-test/state --root projects=/absolute/test/workspaces --port 18990
pnpm gateway --config /tmp/gateway-test/config/config.json
pnpm gateway:cli status --config /tmp/gateway-test/config/config.json
pnpm gateway:cli pair --config /tmp/gateway-test/config/config.json
pnpm gateway:cli devices list --config /tmp/gateway-test/config/config.json
pnpm gateway:cli devices revoke DEVICE_UUID --config /tmp/gateway-test/config/config.json
```

`pair` 返回私有配对文件路径、到期时间和公开安装 ID；一次性码保存在该文件，不写入服务日志。客户端先生成并安全保存 UUIDv4 设备 ID 与 32 字节 CSPRNG 凭据，再配对；配对 ACK 丢失后只需交换 token，不重新消费配对码。长期信任没有自然到期，access 最多 10 分钟，仅存内存。CLI `status` 的 `serviceState=not-probed` 只说明本地状态，不冒充进程健康检查。

默认路径是 `$XDG_CONFIG_HOME/oraculum-gateway/config.json` 与 `$XDG_STATE_HOME/oraculum-gateway/gateway.sqlite`；XDG 未设置时使用标准用户目录。`ORACULUM_GATEWAY_CONFIG` 可显式指定配置。配置/状态必须为同 UID 私有路径；`init` 不覆盖现有配置，不导入旧 Bridge。旧 `trust.sqlite` 所在目录、未知 schema、符号链接和不安全权限会被拒绝。Gateway 用内核锁保证单实例，CLI 仍可并发短事务访问同一新库。

`allowedRoots` 由主机私有配置明确给出，HTTP 只能浏览并注册其子目录。配置中的 `externalOrigin`、`basePath`、loopback 端口是实例参数：默认根路径 `/`；远程要求 HTTPS、严格 Host/Origin 与受控本地代理覆写的协议头。仓库没有私人 endpoint 或代理默认值。候选包没有安装或启动任何正式服务。

## 初始化时确定 Codex 可执行路径

以运行 Gateway 的用户执行 `oraculum init`。初始化会按该用户当前 PATH 顺序寻找第一个可执行的 `codex` 文件，忽略依赖当前工作目录的空或相对 PATH 项。也可用 `oraculum init --codex /absolute/path/to/codex` 明确选择入口；有空格的路径须作为一个参数传入。两种方式都会先验证普通文件及执行权限，并以 5 秒／16 KiB 输出预算执行 `--version`、检查 `codex-cli` 版本格式，成功后才创建配置／SQLite；找不到或验证失败时给出明确错误，不留下新安装配置或数据库，也不输出子进程原始内容。

`codexCommand` 保存启动入口的绝对路径，不再依赖 systemd 启动时的 PATH；若入口是指向版本化目录的符号链接，保留稳定入口，不解析并固定其内部目标。`init` 和 `status` 的 JSON 输出均包含该字段，便于检查实际选择。版本探针不登录、不启动 App Server、不发送模型请求，也不证明推理服务可用；脚本入口的解释器仍须在服务环境中可用。

DEB 只安装程序文件和未启用的 user unit；root 安装脚本不替用户发现 Codex、不初始化用户状态，也不自动启用或重启服务。发现与持久保存属于上述用户级初始化步骤，程序包升级不会重写已有配置。

已有 `codexCommand: "codex"` 的配置仍可读取，不做静默迁移；`init` 在探测替代程序前就拒绝现有配置，不能用重新初始化修复旧安装。既有主机应先备份私有配置，在单独获准的维护中仅将该字段改为已核验的绝对启动入口，再恢复同一服务，保留数据库和配对。部署验收应覆盖脱离交互终端 PATH 的启动，并在获准后验证整机冷启动；不要将当前登录会话里的一次成功启动等同于冷启动通过。

## systemd 服务的可选网络环境

Gateway 将自身环境传给官方 Codex 子进程。终端或桌面 Codex 已能联网，不表示 systemd 启动的 Gateway 也获得了相同代理变量；`config.json` 没有代理字段，不能向其中添加未知配置项。

后续版本的打包 user unit 提供 `EnvironmentFile=-%E/oraculum-gateway/network.env`：`%E` 是 **user manager** 的 XDG 配置目录，通常为 `~/.config`，前缀 `-` 允许未配置环境文件的主机正常启动。不需要代理时无需创建文件；此入口不会主动设置代理或修改系统网络。路径与可选语义依据 [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Specifiers) 和 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=)。

需要代理时，在该目录创建或编辑私有 `oraculum-gateway/network.env`（目录 0700、文件 0600），保留已有内容。以下为示例，必须将 `.invalid` 占位地址替换为部署主机实际可用的代理：

```ini
HTTP_PROXY="http://proxy.example.invalid:8080"
HTTPS_PROXY="http://proxy.example.invalid:8080"
http_proxy="http://proxy.example.invalid:8080"
https_proxy="http://proxy.example.invalid:8080"
NO_PROXY="localhost,127.0.0.1,::1"
no_proxy="localhost,127.0.0.1,::1"
```

如部署需要，也可显式设置 `ALL_PROXY` / `all_proxy`；大小写变量应保持一致，NO_PROXY 按部署需要补充本地服务。文件使用逐行 `KEY=value`，不写 `export`、命令替换或依赖 `$HTTP_PROXY` 之类的变量展开。这里只放网络参数，Codex 登录凭据与设备配对密钥仍由各自安全存储管理。`ORACULUM_GATEWAY_CONFIG` 只改变 JSON 配置路径，不会自动移动 systemd 的环境文件入口；非默认位置使用 user drop-in 明确指定。

**已发布 Beta 1 的 unit 尚无此入口。** 对该版本，可在用户服务目录创建 drop-in（已有等效配置时保留，不重复添加）：

```ini
# ~/.config/systemd/user/oraculum-gateway.service.d/20-network-env.conf
[Service]
EnvironmentFile=%E/oraculum-gateway/network.env
```

此 drop-in 要求环境文件已存在。源模板的修改只会进入后续版本，不覆盖 Beta 1 的 Release、DEB 或校验资产。修改 unit/drop-in 后需 user daemon-reload；环境文件更新需重启对应 Gateway 才生效。正式服务变更应在确认活动 Turn、unknown 操作及回滚方案后获得部署授权；安装包本身仍不启用或重启任何服务。

部署验收需要在**实际服务环境**下依次确认 HTTPS health、原身份认证、WSS、Snapshot，再在专用项目显式发送一次受控消息，核验流式、官方 Turn 终态和最终回复。health、绿色连接、model/list 或 accepted 回执均不能单独证明推理成功。不在启动或健康检查时自动发送消息；失败后查询原 operationId 与原生状态，不自动重发。可使用 [已配对真机回归测试及运行边界](../upgrade/phase3/gateway-incident-20261113/README.md#回归测试与安全运行方式) 复核。

## 接口与恢复

公共字段、路由、TS/Kotlin DTO 与 fixture 见 [Gateway 协议](../packages/gateway-protocol/README.md)。所有 `/api/v2` 请求和 WS 握手携带 `X-Oraculum-Protocol: 2`；access 只放 Authorization。WS 只接收 resume/ping，业务写只走 HTTP。

协议 2.1 开放原生重命名、归档／恢复、确认删除、分叉、历史撤回、同 Turn 插话和手动上下文压缩。生命周期操作沿用旧 Bridge 的有界原生依赖盘点与最终状态复读：普通根会话可操作，有子会话依赖、活动执行、待处理审批或无法核实范围时明确拒绝该次操作。删除需要 `confirm:true`，由 Codex 永久删除会话历史；不使用本地文件清理替代。压缩回执只确认触发，完成仍以原生 `contextCompaction` Item／Turn 事件为准。`revert` 使用原生 `beforeTurnId`，不回滚工作区文件，旧会话存储不支持时返回原生拒绝。

省略 `model`、`effort` 和 `permissionPreset` 继续继承 Codex 设置；有效默认值可通过项目 `native-defaults` 读取，实际会话设置优先使用最新原生 `Thread` 事实。`ultra` 及未来强度值由选定模型的真实目录验证，不把目录推荐默认当成当前配置。新接口仅投影必要配置／来源类别及账户额度／用量，不返回凭据、账户身份、原始配置或私有路径。

MCP 使用 `toolsAndAuthOnly` 轻量发现与 20 秒预算（显式 adapter 读取超时仍优先）；未请求资源时标记 `MCP_RESOURCES_NOT_REQUESTED`，省略资源数量，避免把未发现当作零。Skills／Apps 的结果不被 MCP 失败替换。原生默认接口尚无自动标题生成 RPC；`thread.name.auto` 明确不可用，已有原生名称与 `thread/name/updated` 仍正常同步，不用首条消息 preview 冒充自动标题。

所有可派发写入先持久保存 UUIDv4 `operationId`。相同 ID 一律 409，随后只读查询 `/operations/{id}`。断线、超时、原生 ACK 与本地提交之间的崩溃保持 `unknown`，不自动重发；未知新建线程阻塞整个项目，未知 Turn 阻塞该线程，各设备共同遵守。首版未知操作没有人工强制清除入口：保留读取原生状态与停止已观察活动 Turn 的安全出口。新 ID、换设备或重新注册项目都不能绕过屏障。

原生审批只回答当前 epoch/generation 的真实请求，多设备竞争只向原生发送一次；必须使用原生提供的决定。写入 stdin 仅产生 unknown，匹配的原生 resolved 才校正为 accepted；这不代表工具成功或永久授权。未知交互形态关闭该交互能力，不能推测同意。

事件按设备过滤后分配序号，每设备最多 1024 条/2 MiB/5 分钟，全局 32 MiB；失去连续性后读取快照。快照观察序号不是原生历史水位；活动 delta 与恢复快照隔离，完整终态按 Item ID 覆盖。纯协议恢复 helper 位于 `reconcile.ts`，没有客户端 UI 或权威历史副本。

历史优先使用原生分页；仅对明确方法/存储不支持采用有界 `thread/read` 后备。并发最多 2、查询预算 12 秒、原生帧最多 8 MiB；后备仍有上游全量读取成本，超限明确失败。展示投影的 Item 上限约 16 KiB、页预算约 256 KiB，超大 Item 使用摘要绑定的 64 KiB 详情字节页读取。游标绑定设备/项目/线程/版本/代次，原生正文不进 SQLite。

文件操作逐级使用描述符与 `O_NOFOLLOW`，固定项目、祖先目录及文件身份；敏感名称、符号/硬链接、FIFO、跨项目替换被拒绝。grant 绑定设备、项目、可选线程与版本，每次重新认证，下载有 SHA-256 Content-Digest；撤销、变化或超时会中止。下载上限 64 MiB、grant 5 分钟，不支持 Range；目录扫描最多 4000 项并明确 `limited=true`。

上传只写本安装、本项目自己的新 inbox，单文件 20 MiB、每草稿最多 6 个/50 MiB；还有限定并发、全局及设备容量。`draftId` 是客户端预生成 UUIDv4。附件必须同时匹配 device/project/thread/draft，Turn 回执预留与认领同一事务提交；held/unknown/sent 不按 TTL 删除。图片转换为受控 localImage，文档提供已验证的主机路径引用，由 Codex 原生工具按其权限读取。

## 验证与交付边界

```bash
pnpm check
pnpm test
pnpm verify:gateway:protocol
pnpm test:gateway:faults
pnpm test:gateway:live
pnpm exec tsx gateway/test/native-capabilities-live.ts
pnpm build:gateway:deb
node scripts/verify-gateway-deb.mjs dist/gateway/SOURCE_SHA/oraculum-gateway_2.0.0~beta.1_amd64.deb SOURCE_SHA
```

真实验收只创建专用临时项目和原生线程。故障脚本明确使用模拟 Codex，加实际 SIGKILL；原生通信脚本使用真实官方 Codex、隔离 HTTPS/WSS 代理和每次生成的证书信任，不改系统证书或生产代理。单测夹具不替代真实验收。

DEB 含私有 Node 24.21.0、CLI 和未启用的 user systemd 单元，程序/配置/状态分离。构建要求已提交的 main，仅排除明确列出的未跟踪 Stitch、Android Studio 和 Gradle wrapper 原件；其他未提交源码仍阻断。产物与清单在忽略的 `dist/gateway/`，不提交二进制。校验器在 bubblewrap 只读宿主与一次性 dpkg root 内测试，旧 Desktop 或未托管 `/usr/bin/oraculum` 会被明确拒绝，不覆盖或卸载。

当前 Gateway Beta 2 使用 Debian `2.0.0~beta.2`（高于 Beta 1、低于后续 `2.0.0`）、`releaseChannel: beta` 和 `candidate: false`。这里 `candidate` 仅表示未发行的开发候选；false 表示按预发行契约准备的可分发包，不代表 Stable，也不代表已安装。实际发布状态以 GitHub Pre-release 为准，见 [Beta 2 发行说明](../docs/GATEWAY_BETA_2.md)。旧候选清单继续接受原 `candidate: true`、三段数字版本；所有清单和包内 `build.json` 必须一致。

实验 API、Plan 模式、未验证的 Plugin 目录继续关闭；协议 2.1 已开放 Turn steer。被动原生 input/MCP form 适配有夹具验证，不能据此宣称真实模型已触发所有形态。`native-capabilities-live.ts` 使用独立 HTTP/WebSocket 回环实例验证新增原生能力，报告经过脱敏；它不等于公网 HTTPS/WSS 或 Android 验收。正式 APK、Android/Desktop UI、Stitch 修改、旧状态迁移、VPS/网络变更和正式部署均不在本阶段。
