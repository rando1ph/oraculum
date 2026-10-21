# Phase 2 受控部署与收尾证据

状态：2026-10-21 15:36–15:55 UTC 执行；实际公网链路和本次隧道恢复通过，提交独立审阅，**Task 保持 In progress，不自行标 Done**。用户本轮明确延期 Android 脱离 USB/ADB reverse、关闭 Wi-Fi、移动数据／独立外网真机验收，不再将它作为本次阶段收尾阻碍；不开展长期日常测试或 Phase 3 UI/UX。

## 版本与范围

- A 通用 Origin/Base Path 实现 `1a0b793e63ae62ecade5c1bf4c7020096c3d0788`，部署批准材料 `2263bce502292ba7b768ffa1acf7180608a25f6e`，均保留。默认 `/`、Electron 和 Android 本地兼容未重新开发。
- 公网负向测试发现并修复升级连接清理问题：`04e7c2ffb9e3bc61cd3281f7ab8c8e09ac1f8aba`。仅提前注册 WebSocket 插件，未放宽认证／Origin 规则。真实 TCP 用例先在旧代码失败，修复后通过；56/56 tests、类型检查、Web build 通过。该步已安全合并 main 并正常 push。
- 官方 Codex 0.160.0、本机正常 Bridge、原有私有信任／回执数据库、受控工作区不变。仅一次真实模型 turn，gpt-6-luna / low；未修改用户 Codex 配置。
- 用户部署入口为 `https://47.107.28.193/oraculum/`。这些值仍只作为部署参数，未成为产品源码依赖。未新增域名、服务器、守护服务、SSH 身份或防火墙规则。

## 实际部署与回滚记录

首次部署前 Caddy 磁盘与运行配置完全相等，原 hash 未漂移，目标端口空闲，证书经系统 CA 和 IP SAN 验证。Caddy/SSH/DSH active，CodeG 原隧道 active；可用内存约308 MiB。候选始终是已批准的原文件，没有新增配置差异。

1. 首次备份：`/root/oraculum-backups/20261021T153746Z/`。目录0700；原 Caddyfile、运行 JSON、元数据及记录0600；暂存候选 root:caddy0640，使用实际 caddy 用户及 HOME=/var/lib/caddy validate。以 root:root0644 原子替换并 reload，未 restart 服务。
2. 公网负向 WSS 检查发现真实缺陷：早期安全钩子拒绝升级请求后，插件尚未标记该连接；403 响应留下不可复用的 keep-alive socket，Caddy 后续复用超时。三次整体取证均在模型调用前失败，不计通过。测试侧关闭顺序／独立客户端连接的调整不能修复该上游生命周期问题。
3. 发现根因后立即恢复原 Caddyfile、validate/reload，核验原 hash 和运行配置、全部公网基线响应及证书。只停止本次 SSH PID44399、Bridge PID44145。**回滚已真实执行成功**，没有重启或改动 DSH/CodeG。
4. 最小修复测试、commit→main→push 后，在同一批准范围内重新复核：原配置无漂移，端口空闲，可用内存约322 MiB。新备份为 **`/root/oraculum-backups/20261021T155031Z/`**，权限同上；相同候选 validate 和 reload 成功。
5. 最终 Caddy 磁盘与运行配置一致；移除 route 字段后，前后运行 JSON 完全相同，TLS、admin、监听等非路由配置未改变。现有证书未更换（到期2026-10-26 10:05:36 UTC，继续原自动续期策略）。VPS 仅新增127.0.0.1:17860，无新增公网监听。最终可用内存约315 MiB。

| 文件 | SHA-256 |
| --- | --- |
| 原 `/etc/caddy/Caddyfile`／备份原件 | `802503ca76f80399f1d5daac930e0fc95a3eb3a2c4bab4d397b9d814ed7ed9de` |
| 已批准候选／当前生效配置 | `a7c80dad7c968832fd3e13019a2e952088eea94350be73b98cac70806c7f5492` |
| 公网实际证书 DER | `73921b2bb35cc2613eeb5d57199e439c36b140c29b8ceaa96af8f0626f4f8565` |

## 实际验证与边界

| 项目 | 证据与结论 |
| --- | --- |
| R 公网 TLS、路径、资源 | 系统信任校验和实际 Chromium 正常 TLS 校验；`/oraculum`308、目录／health200、匿名session401；JS、CSS、Diff chunk200且与本机构建逐字节hash一致。没有证书忽略选项。 |
| R 认证与 WSS | 公网页面一次性配对成功，重复码401；Cookie为独立 `__Secure-oraculum_session`，Secure/HttpOnly/Strict，Path=/oraculum/。缺少／错误Origin403，未认证／假DSH凭据401，重复自身Cookie401，远程Cookie不能认证本地会话。撤销后活动WSS关闭、UI清空、新HTTP/WSS401。测试设备均已撤销，凭据未记录。 |
| R 官方 Codex、审批、同步 | 公网 Chromium 发送一轮，官方App Server流式事件到达；公网允许精确 `printf ORACULUM_PUBLIC_ALLOW_OK`，Electron拒绝精确 `printf ORACULUM_PUBLIC_DECLINE_OK`，两端审批同时消失。最终completed，两端实时Thread/Turn/Item及回执一致。额外原生只读查询确认允许命令exit0及精确输出、pending0、同一completed回执。 |
| R 隧道故障与恢复 | 仅停止本次SSH PID49790；公网Oraculum502，浏览器显示断开，本地Bridge200且Electron保持状态。重建同一127.0.0.1转发后重连，恢复同一原生ID与回执；整个浏览器记录只有一次turn/start，无自动重发。该故障发生在turn完成后，不冒充在途丢ACK实测。 |
| R 既有服务回归 | 部署前、部署后、回滚后、隧道关闭及恢复时：DSH根401、health200、pair404、management/relay403、未认证events.mux401，响应body hash一致。Caddy PID8201、SSH PID19518、DSH PID8531及启动时间未变；CodeG隧道PID5361未变，本地CodeG HTTP3080返回200。证书前后相同。 |
| U DSH 已登录客户端 | 当前工具没有可访问的原已配对DSH客户端，已请用户人工确认，记录时尚未收到反馈。**上面的服务／匿名协议证据不等于已登录会话／WS功能实测**；未提取DSH凭据或新增DSH配对来补证。此项明确交给独立审阅确认。 |
| 保留既有 R/S | Android USB真机、本地认证、Electron/Android恢复、Base Path适配及原生限制沿用已审成果。并发审批、unknown回执、丢ACK等S证据维持原分类；没有重复开发或冒充本次公网故障矩阵。 |
| 延期 | Android无USB／ADB reverse、移动数据／独立外网、实际手机网络切换及锁屏公网验收。本次没有执行，也不阻碍用户调整后的阶段收尾。 |

原生thread：`01a15f29-3b59-7a02-a131-898e75a7f35c`；turn：`01a15f29-3f6e-7aa2-b9a8-aba395b7d19c`；operation：`c39bb25d-a9f3-40c1-9688-9376a5b79156`。允许item：`exec-56ff0d5f-fda9-47c2-b6ad-c23a70edc1b0`；拒绝item：`exec-9c6659b6-c380-4460-ba47-f242b566161f`。

原生历史边界仍然存在：稍后的 `native-pages` 查询保留允许命令、completed turn和回执，但不返回被拒绝item；UI已明确提示原生持久历史可能缺少审批／拒绝／工具事件。额外只读诊断最初把“两条命令均持久化”当作断言，失败后据实际返回确认这一既有边界，未放宽产品规则、补造第二份历史或新增模型调用。不能把当前窗口保留的实时item等同于完整持久历史。

## 复验入口与证据

`scripts/public-live.ts` 是显式启用的真实公网验收入口，默认不随单元测试运行；需要已获准运行的正常Bridge和隧道，会使用一次真实模型turn。HTTPS Origin/Base Path从环境输入，测试不会写VPS配置、管理SSH或安装APK。配对码／Cookie仅在内存中使用，测试结束撤销本次设备。

```bash
ORACULUM_TEST_PUBLIC=1 \
ORACULUM_REMOTE_ORIGIN=https://<用户部署入口> \
ORACULUM_REMOTE_BASE_PATH=/<用户配置路径>/ \
ORACULUM_STATE_DIR=<正在运行的Bridge私有状态目录> \
ORACULUM_TEST_EVIDENCE=.local/evidence/<新的测试目录> \
pnpm exec tsx scripts/public-live.ts
```

脚本产生 `tunnel.ready` 后，操作者核对本次SSH PID及启动时间再停止；看到 `tunnel.disconnected` 后完成旧服务和本地Bridge检查，重建原隧道并核验公网，再创建 `tunnel.restored` 文件。脚本等待最多180秒，验证同一状态、不重发及撤销。不得把其他服务或任意SSH进程当故障对象。

本次私有证据位于 `.local/evidence/phase2/public-closeout/`，JSON、截图、数据库及APK不入Git：

| 文件 | SHA-256 |
| --- | --- |
| `live-verified/public-live.json` | `07eecacabf0f0cef1b79a1ab85287a9c24e2fb41827822f65332f2127ad86eb7` |
| `live-verified/native-result.json` | `a036ad9e60acc1ad399437d055d184b713bb9479a4498d54cd47d06e11dcc8a6` |
| `redeploy/final-vps.json` | `b2445e284a14a5ba8f73ed38fc0e3a58b0bd3fcdff4f82ded9b0f39479f2dfa8` |
| `redeploy/tunnel-down-public.json` | `0cc357d2c07d501509eafed6a1fd7a3585a1279bc804d7473a8473939605e4de` |
| `redeploy/tunnel-restored-public.json` | `e0fa1bb417c685850d495f6df15db80c51705edda15635f3480022e3ceac6cbf` |
| `rollback-public.json` | `4dba806dcfc4427095de5a6a2d499fe94fceda93e4a692409506f8286dfe01c1` |
| `public-assets.json` | `ef201ee1848074a5474ec7c55dfae6c7d5a60af7909bf1f39ba7bec58ce02f2f` |

## 当前运行与精确回滚

最终为已授权的临时进程：本机Bridge PID49609（startTicks839642）、独立SSH PID51135（startTicks850179）；身份记录在忽略目录 `redeploy/*-process.json`。未配置自动启动或长期守护，主机／进程退出会使该入口不可用；这不是长期生产托管承诺。Caddy仍将其余请求交给原DSH fallback。

需要回滚时，先核对当前Caddy hash仍为上述候选、运行配置无其他漂移，备份原件hash正确、owner/mode记录为root:root0644。漂移则停止，不覆盖后续操作者改动。沿用已批准步骤：

```bash
# 在VPS上以获准身份执行；先完成上文hash／运行配置复核。
test ! -e /etc/caddy/Caddyfile.oraculum.new
install -o root -g root -m 0644 \
  /root/oraculum-backups/20261021T155031Z/Caddyfile.original \
  /etc/caddy/Caddyfile.oraculum.new
runuser -u caddy -- env HOME=/var/lib/caddy /usr/local/bin/caddy validate \
  --config /etc/caddy/Caddyfile.oraculum.new --adapter caddyfile
mv /etc/caddy/Caddyfile.oraculum.new /etc/caddy/Caddyfile
/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile \
  --adapter caddyfile --address 127.0.0.1:2019
```

每一步成功后才进行下一步；失败则停止并检查，不批量盲跑。随后核对原hash、运行JSON、DSH健康／认证边界及可用的原已登录客户端；再核对本机PID、startTicks和命令行，仅SIGTERM本次SSH和Bridge，清理本次候选暂存。保留信任／回执库、原生thread及备份，不pkill、不删库、不改证书／身份、不restart其他服务。该恢复路径在首次部署中已实际验证；若回滚失败，停止并报告，不扩大操作范围。

原工作区 `~/Projects/Oraculum` 的用户未提交 `AGENTS.md` 与开工前私有备份逐字节一致；本轮继续使用隔离工作区完成提交和普通push，不覆盖用户修改、不force-push。
