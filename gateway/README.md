# Oraculum Gateway 2.0 候选

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

## 接口与恢复

公共字段、路由、TS/Kotlin DTO 与 fixture 见 [Gateway 协议](../packages/gateway-protocol/README.md)。所有 `/api/v2` 请求和 WS 握手携带 `X-Oraculum-Protocol: 2`；access 只放 Authorization。WS 只接收 resume/ping，业务写只走 HTTP。

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
pnpm build:gateway:deb
node scripts/verify-gateway-deb.mjs dist/gateway/SOURCE_SHA/oraculum-gateway_2.0.0_amd64.deb SOURCE_SHA
```

真实验收只创建专用临时项目和原生线程。故障脚本明确使用模拟 Codex，加实际 SIGKILL；原生通信脚本使用真实官方 Codex、隔离 HTTPS/WSS 代理和每次生成的证书信任，不改系统证书或生产代理。单测夹具不替代真实验收。

DEB 含私有 Node 24.21.0、CLI 和未启用的 user systemd 单元，程序/配置/状态分离。构建要求已提交的 main，仅排除用户未跟踪的 Stitch 原件；产物与清单在忽略的 `dist/gateway/`，不提交二进制。校验器在 bubblewrap 只读宿主与一次性 dpkg root 内测试，旧 Desktop 或未托管 `/usr/bin/oraculum` 会被明确拒绝，不覆盖或卸载。

首版关闭实验 API、Plan 模式、未验证的 Plugin 目录和 Turn steer；被动原生 input/MCP form 适配有夹具验证，不能据此宣称真实模型已触发所有形态。正式 APK、Android/Desktop UI、Stitch 修改、旧状态迁移、VPS/网络变更和正式部署均不在本阶段。
