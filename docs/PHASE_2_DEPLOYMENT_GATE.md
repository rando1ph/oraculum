# B：一次部署批准清单

状态：**待用户明确批准，尚未执行任何 VPS 写入、Caddy reload 或 SSH -R。** 对应 [原 Phase 2 Task 的 B/C 要求](https://app.notion.com/p/3ff5421e690b81adba14c1594346bc1d)。用户已接受同源信任关系，A 产品适配已发布为 `1a0b793e63ae62ecade5c1bf4c7020096c3d0788`，不再重复选型审批。

## 本次最新现场复核

2026-10-21 15:15–15:17 UTC（北京时间 23:15–23:17），只读检查结果：

- Caddy 2.11.7，实际二进制 `/usr/local/bin/caddy`；caddy/ssh/dsh-web active。Caddyfile root:root 0644，磁盘 adapt 与运行 JSON 完全相等。
- 原 Caddyfile SHA-256 仍为 `802503ca76f80399f1d5daac930e0fc95a3eb3a2c4bab4d397b9d814ed7ed9de`，审计前后未变；不存在需要重新设计的路由漂移。
- TLS 1.3，经系统信任库和 IP SAN 验证；现有 Let's Encrypt YE2 证书截至 2026-10-26 10:05:36 UTC，维持原自动续期。匿名根 401、DSH health 200、management/relay 403；当前 Oraculum 两个探测路径的 401 仍来自 DSH。
- 远端 127.0.0.1:17860 空闲，本机 17860/17861 在清理本次 A 测试进程后空闲。现有 CodeG reverse-tunnel active，不受本方案管理。
- SSH alias 为既有 dsh-vps / root / 22，未配置附带 Forward，ForwardAgent=no / ControlMaster=false；服务器 GatewayPorts=no，允许 TCP 转发。身份和 sshd 配置均不改。
- 资源：load 5.75/5.88/5.97，可用内存约 290 MiB、swap 已用约 2065 MiB。不会在 VPS 运行 Codex 或新增守护进程；仍须在 reload 前复查，明显恶化则停止。
- 证据忽略目录 `configurable-entry/predeploy-vps.json` SHA-256 `956bfdac0367b3d7dfa32c2cbd754bb5ffea1b12d8839331e851af644bc4ac3c`；`predeploy-public.json` SHA-256 `f903f2983f0e24b83d32c8f6c6903d433e61c1ff07fa1fe0fa70fe3b597029bd`。已认证 DSH 客户端仍须在部署窗口做实际回归，匿名探针不能替代。

## 申请批准的精确范围

1. 复用现有 Caddyfile 的候选 [phase2-ip443.Caddyfile](phase2-ip443.Caddyfile)，完整逐行差异见 [既有方案第 3 节](PHASE_2_IP443_PLAN.md#3-精确-caddy-差异)。**本次相对已审候选无新增 diff**，目标 SHA-256 为 `a7c80dad7c968832fd3e13019a2e952088eea94350be73b98cac70806c7f5492`。新增 `/oraculum/` 专用分支和双向已知 Cookie 过滤；保留 management 403、DSH fallback、443、TLS 和证书策略。与 A 的新 Cookie 名称及保留前缀行为相符，本机同版本 adapt 再次通过。
2. 经批准后在 VPS 创建唯一 `/root/oraculum-backups/<UTC>/`（0700，umask 077），备份原 Caddyfile、owner/mode/hash、运行配置 JSON（0600）、版本和健康摘要；记录实际路径。备份及运行配置不进 Git/Notion，不复制 TLS 私钥或用户会话。
3. 候选上传到该目录核对 hash；安全暂存到 `/etc/caddy/Caddyfile.oraculum.candidate`（root:caddy 0640），以 caddy 身份、HOME=/var/lib/caddy 执行 `/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile.oraculum.candidate --adapter caddyfile`。保留现有证书 storage，不主动换证书／重签。
4. 小新以正常 Bridge 启动临时验收进程，配置为下方值；只监听 127.0.0.1:17860，保留已有私密信任／回执数据库，官方 App Server 仍为本地 stdio。建立下方单独前台 SSH -R，并记录本机 PID；复查远端只监听 127.0.0.1:17860。
5. 再核对原配置／运行配置无漂移，按 root:root 0644 在同一文件系统原子替换 `/etc/caddy/Caddyfile`，执行 `/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address 127.0.0.1:2019`。不 restart Caddy／DSH，不改 SSH 身份、sshd、systemd、防火墙或 DNS，不新增公网端口。
6. 安装已构建的远程 APK，按 C 逐项验证；需要时停止／重启本次 SSH、Bridge 及其 App Server，模拟自身链路故障。不得停止、重启或清理 CodeG/DSH/PROXY。任何关键回归按下方方案恢复原 Caddyfile；该恢复也纳入本次批准范围。

```text
本机工作目录：/home/randolph/Projects/Oraculum-phase2
ORACULUM_REMOTE_ORIGIN=https://47.107.28.193
ORACULUM_REMOTE_BASE_PATH=/oraculum/
ORACULUM_PORT=17860
ORACULUM_WORKSPACE=/home/randolph/.cache/oraculum/workspaces/phase2-android-zd4op9
ORACULUM_STATE_DIR=/home/randolph/Projects/Oraculum-phase2/.local/runtime
启动：node --import tsx bridge/src/main.ts
远程 APK SHA-256：70a6e1580670fc99f3dd4fdf264362896f856b943869d92ae5083d2f717e2024
```

```bash
ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UpdateHostKeys=no -o ControlMaster=no -o ControlPath=none \
  -o ForwardAgent=no -o ForwardX11=no -o RequestTTY=no \
  -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:17860:127.0.0.1:17860 dsh-vps
```

使用既有 root SSH 身份仅用于本阶段临时验收，承认权限较宽；不新增受限身份或长期 systemd 服务。本次批准只涵盖以上具体操作和自身测试进程的故障恢复，不是长期生产托管或任意 VPS 管理授权。

## 风险、回滚与停止条件

- Caddy reload 可能短暂断开现有 DSH WS，选择无关键任务窗口并验证重连；DSH Cookie／Origin 和原路由保持原约束。共享 origin 风险已由用户接受，仍保留独立配对、撤销、TLS 和 Cookie 过滤。
- 备份/替换前任何配置 hash 或运行配置漂移、端口被占、TLS 验证异常，立即停止并汇报，不覆盖变化或自动换端口。负载／资源明显恶化也暂停部署。
- DSH 已认证功能／WS／health 回归、management 阻断失效、路由或凭据串用、意外公网监听、reload 失败时：将本次备份原件按原 owner/mode 原子恢复，validate 后 reload；核对原 hash、运行配置语义、health 和实际 DSH WS。候选 reload 被拒时也恢复磁盘，防下次启动误加载。
- 恢复确认后只停止记录 PID 的本次 SSH／Bridge，保留数据库、原生 thread 和备份，清理本次候选暂存文件；不使用 pkill ssh、不删信任／回执数据库、不恢复整个系统目录。若回滚失败，停止并报告，不擅自扩大操作范围。

## C 的验收与用户操作

先记录 DSH 现有已配对客户端的登录／WS／会话可达性，再验证部署后与 Oraculum 隧道关闭时仍正常；不提取 DSH Cookie／设备凭据或假造已认证证据。

手机须安装部署 APK 后拔 USB、移除本次 ADB reverse、关闭 Wi-Fi 并使用移动数据。公网路径要验证首次配对、创建／继续／中断真实 Codex、流式消息、允许／拒绝审批、与 Electron 相同 Thread/Turn/Item；再覆盖切网络、短暂断网、锁屏重开、隧道与 Bridge/App Server 重启、未知不自动重发和审批失效。手机切换到移动网络后可能需要用户直接操作界面，不能以失去 ADB 控制为理由把 USB 测试改称公网通过。

记录 R/S/U 证据和残留边界，完整结果写回原 Task、按步骤 commit→merge→push；未经正式审阅，Phase 2 不标 Done。
