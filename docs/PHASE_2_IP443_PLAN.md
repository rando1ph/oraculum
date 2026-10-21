# Phase 2：复用 DSH 公网 IP:443 的审阅方案

**2026-10-21；仅完成只读审计、候选配置及本地验证，未批准部署。** 本方案依据 [Phase 2 Task 最新决定](https://app.notion.com/p/3ff5421e690b81adba14c1594346bc1d)：优先复用现有 IP HTTPS、Caddy、证书，不再等待独立域名。Task 保持 In progress。

结论：`https://47.107.28.193/oraculum/` 可以作为专用路由；**它与 DSH 共享浏览器 origin，不能构成两应用之间的强安全隔离**。建议仅在用户明确接受这项同源信任关系、完成下述应用适配和验收后批准上线。当前代码不能直接套代理部署。

## 1. 本轮现场事实

只读窗口：2026-10-21 13:38–13:49 UTC（北京时间 21:38–21:49）。没有写入 VPS 文件、创建隧道、reload/restart 服务、操作证书、SSH 身份或防火墙；没有登录／配对 DSH、提取现有凭据或调用其修改接口。

| 项目 | 证据与结论 |
| --- | --- |
| Git | 原工作区仍为 Phase 1 分支，仅原有 `M AGENTS.md`，与备份字节一致；隔离工作区从干净 main `0ee8dfd` 开始，fetch 后与远端无差异 |
| Caddy | 2.11.7；caddy、ssh、dsh-web active；admin 仅 127.0.0.1:2019；HTTP h1/h2，现有 HTTPS :443 |
| 当前路由 | IP host → 127.0.0.1:3444；`/api/mobile-access` 及其子路径、`/relay` 及其子路径返回 403；磁盘 adapt 与运行 JSON 语义相等 |
| 配置保护 | `/etc/caddy/Caddyfile` root:root 0644；前后 SHA-256 均 `802503ca76f80399f1d5daac930e0fc95a3eb3a2c4bab4d397b9d814ed7ed9de` |
| IP TLS | 使用系统信任库，无跳过验证；TLS 1.3，SAN 为该 IP；Let's Encrypt YE2；本次证书有效期 2026-10-19 18:05:37 至 2026-10-26 10:05:36 UTC。保留既有 shortlived ACME 自动续期配置，不复制／替换私钥、不另签证书 |
| 匿名 HTTP | `/` 401；`/mobile-access/health` 200；`/mobile-access/pair` 404；上述管理路径 403；`/oraculum/` 与 `/oraculum/auth/session` 当前也是 DSH 的 401，**不是 Oraculum 已部署**。本次响应未发 Cookie、未出现 Basic challenge |
| DSH Mobile | VPS 已安装 0.6.13；入口 bundle SHA-256 `85af02b60f09394fa4e0b9d25f2ee12789d221ef3f87b1903e19f5308a71e2d5`，与本机同版本发布包一致；外部 origin 是该 IP HTTPS，内层监听 127.0.0.1:3444 |
| 资源与端口 | 已有 TCP 22/443/3443、环回 2019/3080/3444；VPS 17860 未监听。末次 load 6.60/6.19/6.05，可用内存约 461 MiB、swap 已用约 2094 MiB，只是快照，部署前复查 |
| 既有链路 | 小新 CodeG reverse-tunnel active，仍是 PROXY 的 13080→小新 3080；本方案不改其服务、SSH 身份或代理 7897。VPS SSH allowtcpforwarding=yes、gatewayports=no |

Cookie 规则依据部署包代码及已配置 publicOrigin，未为取证签发真实 DSH Cookie：

| Cookie | 既有属性／范围 | 与 Oraculum 的关系 |
| --- | --- | --- |
| `dsh_ma_session`、`__Host-dsh_ma_session` | HttpOnly、Secure、SameSite=Strict、Path=/、无 Domain | 名称不碰撞，但浏览器会发送到 `/oraculum/` |
| `dsh_ma_csrf`、`__Host-dsh_ma_csrf` | Secure、SameSite=Strict、Path=/；供 JS 读取 | 同源 Oraculum 页面也能读取这个 CSRF Cookie；它不是独立认证边界 |
| `__Host-dsh_ma_device_id` | HttpOnly、Secure、Path=/；非秘密设备绑定标识 | 同样需避免转发到另一个后端 |
| `dsh_ma_device` | HttpOnly、Secure、SameSite=Strict、Path=/mobile-access/auth/renew | 正常不会发到 Oraculum 路径；候选代理仍过滤，防手工请求夹带 |
| 当前 Oraculum `__Host-oraculum` | HttpOnly、Secure、SameSite=Strict、Path=/ | 不适合直接复用为子路径 Cookie；`__Host-` 要求 Path=/ |
| 拟采用 `__Secure-oraculum_session` | HttpOnly、Secure、SameSite=Strict、Path=/oraculum/、无 Domain，24h | 需改应用实现；减少误传，**不提供同源隔离** |

DSH 认证入口为 `/mobile-access/...`，其 WS 包含 `/api/events.mux`、`/api/events.host`、`/api/remote.mux`、`/sidebar/ws/terminal`；保留原路由和鉴权。Oraculum 不接入 DSH 的配对、CSRF 或会话存储，不修改 DSH 程序。没有在检查的 Mobile 源码中发现 service worker 注册；未据此排除上游 GUI、自定义插件或既有浏览器 profile 中的根 scope worker。

## 2. 推荐的条件方案与边界

```text
Android Oraculum APK
  HTTPS/WSS https://47.107.28.193/oraculum/...
    → 现有 Caddy :443（复用证书）
      → VPS 127.0.0.1:17860
        → 小新主动 SSH -R
          → 小新 127.0.0.1:17860 Bridge → 官方 Codex App Server

其余 DSH URL → 原 Caddy 路由 → 127.0.0.1:3444
Ubuntu Electron → 小新环回 Bridge（无 VPS 时仍可用）
```

| 公网请求 | 上游请求／处理 |
| --- | --- |
| `/oraculum` | 308 到 `/oraculum/`；不携带配对码或 token 查询参数 |
| `/oraculum/` | Oraculum UI，保留前缀 |
| `/oraculum/assets/*` | Oraculum 静态资源／懒加载 chunk，保留前缀 |
| `/oraculum/auth/session`、`pair`、`logout` | Oraculum 自己的鉴权 |
| `/oraculum/ws` | Oraculum WSS；认证和精确 Origin 校验在 Upgrade 前完成 |
| 原 DSH 路径、根 `/assets/*` | 原 DSH 后端；不为 Oraculum 抢占 `/auth/*`、`/ws` 或根静态资源 |
| Oraculum 上游不可用 | 返回 502；不能降级转给 DSH |

使用 `handle` 保留前缀，不用 `handle_path` 剥离；应用按 `/oraculum/` 正确提供资源与 API，避免隐藏的路径重写。[Caddy handle](https://caddyserver.com/docs/caddyfile/directives/handle)、[handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)。

**必须审阅的风险：** 同 scheme/host/port 的 DSH JS 可以 fetch Oraculum API、打开其 WS；浏览器会自动附带目标路径的 HttpOnly Cookie。Origin、SameSite、CSRF header 不能辨别这两个同源应用。反方向也成立；共享 localStorage / IndexedDB / Cache / service worker 范围也是同源风险。一个应用的恶意定制或 XSS 会扩大另一个应用的暴露面。Caddy 的 Cookie 过滤仅减少凭据被转交给错误后端，无法阻止这样的浏览器请求。[同源策略](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)、[Cookie 安全限制](https://datatracker.ietf.org/doc/html/rfc6265#section-8.5)。

本机 Chromium 156 的拦截夹具已复现：根页 JS 看不到 HttpOnly Cookie，但能读取 `/oraculum/auth/session` 的模拟私有响应；该请求同时带 DSH 根 Cookie 与 Oraculum 路径 Cookie。没有使用生产凭据或向生产发此攻击验证。

优先使用 Oraculum 专用 APK 的独立应用数据目录，Ubuntu 继续本地 Electron；不把通用浏览器中两个已登录应用的共享 profile 宣称为隔离方案。APK 路径限制有帮助，但不能替代浏览器 origin 或覆盖服务端被攻陷的情形。VPS 本身是既有 TLS 终止和转发信任节点；Codex OAuth 仍只在小新。

若用户不接受上述同源信任关系，**不能批准该路径方案上线**。最小待比较替代是同 VPS、同 IP、现有 Caddy/证书增加独立 HTTPS 端口，例如待现场复核的 8443，形成不同 origin；仍须 Cookie 过滤／凭据作用域设计，因为 Cookie 不按端口隔离，并单独审阅防火墙和新监听。此为备选，不新增域名／服务器，也未申请或执行它。强隔离要求不能靠换 Cookie 名、Path 或端口的单一改动解决。

## 3. 精确 Caddy 差异

完整目标文件：[phase2-ip443.Caddyfile](phase2-ip443.Caddyfile)。目标 SHA-256：`a7c80dad7c968832fd3e13019a2e952088eea94350be73b98cac70806c7f5492`。它是**尚未批准的审阅材料**，应用适配前禁止部署。

以第 1 节基线 hash 的 `/etc/caddy/Caddyfile` 为唯一应用基线：全局配置、IP、TLS issuer/profile/challenge、h1/h2、admin 和现有 management matcher 完全保留。将原站点末尾的 `respond @management 403` 与单个 `reverse_proxy 127.0.0.1:3444` 替换为目标文件的 `route { ... }` 块。

以下零上下文 diff 由上述已核验基线与候选逐字节比较生成，仅供审阅，不是执行指令：

```diff
--- a/etc/caddy/Caddyfile
+++ b/etc/caddy/Caddyfile
@@ -19,3 +19,21 @@
-	respond @management 403
-	reverse_proxy 127.0.0.1:3444 {
-		header_up Host {http.request.hostport}
+	route {
+		respond @management 403
+		redir /oraculum /oraculum/ 308
+		handle /oraculum/* {
+			reverse_proxy 127.0.0.1:17860 {
+				header_up Host {http.request.hostport}
+				header_up X-Forwarded-Proto https
+				header_up -Authorization
+				header_up -Proxy-Authorization
+				header_up -X-DSH-Mobile-CSRF
+				header_up Cookie "(^|;[[:blank:]]*)(__Host-dsh_ma_session|__Host-dsh_ma_csrf|__Host-dsh_ma_device_id|dsh_ma_session|dsh_ma_csrf|dsh_ma_device)=[^;]*" ""
+				header_up Cookie "^[;[:blank:]]+|[;[:blank:]]+$" ""
+			}
+		}
+		handle {
+			reverse_proxy 127.0.0.1:3444 {
+				header_up Host {http.request.hostport}
+				header_up Cookie "(^|;[[:blank:]]*)(__Secure-oraculum_session|__Host-oraculum)=[^;]*" ""
+				header_up Cookie "^[;[:blank:]]+|[;[:blank:]]+$" ""
+			}
+		}
```

- `route` 固定执行次序：原管理路径 403 → 精确 slash redirect → `/oraculum/*` → DSH fallback。
- 原 DSH 上游与 Host 转发不变；只增加剔除 Oraculum 新旧 Cookie 的两条规则。
- 新分支上游仅 VPS 环回 17860；保留客户端 Host，覆盖 X-Forwarded-Proto=https；不改 Origin，不伪造来源来绕过鉴权。
- 新分支移除 Authorization、Proxy-Authorization、X-DSH-Mobile-CSRF 及已核实的六个 DSH Cookie 名。保留 Oraculum 重复 Cookie，交给 Bridge 原有严格重复拒绝逻辑处理。
- 过滤是已核实名称的清单，**不是通用 Cookie 白名单**；其他未知 Cookie 不保证被移除，DSH 升级新增凭据名必须复查。不会把真正凭据写入配置。
- 不添加新的 Caddy listener、ACME policy、日志体、Basic Auth、第三方网关、手工 Connection/Upgrade 头或代理重试策略。现有 reverse_proxy 已支持 WS；reload 默认可能关闭已有 WS，因此有计划地执行并验证恢复。[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

本机同版本 `caddy adapt` 通过；模拟运行检查了执行次序、双向 Cookie 清理、重复 Cookie 保留、HTTP 资源和双 WS 路由、匿名模拟 WS=401、上游关闭后的 502 与 DSH 持续可达。**不是 VPS 配置验证、生产鉴权或公网 WSS 验收。**

## 4. 批准部署前必须完成的仓库适配（本轮未实施）

| 位置 | 最小改动与验收要求 |
| --- | --- |
| `apps/web/vite.config.ts` / URL helper | 拟用相对 `base: './'` 复用同一构建；规范入口只有本地 `/` 与远程 `/oraculum/`。认证、health、logout、WS 全部基于明确 app base 构造；禁止继续使用硬编码根 `/auth/*`、`/ws`。检查 CSS URL、动态 Diff chunk、字体和所有网络请求。Vite 不会替你修改运行时拼接 URL [官方说明](https://vite.dev/guide/build#public-base-path) |
| `bridge/src/server.ts` / `main.ts` | 保留环回监听及本地路径；显式 `ORACULUM_REMOTE_ORIGIN=https://47.107.28.193` 与独立固定 remote base `/oraculum/`，origin 参数不能含路径。远程只注册／允许该前缀；API 404 不返回 HTML；本地信任不能用作远程信任 |
| Cookie / 会话 | 远程切换为 `__Secure-oraculum_session; Secure; HttpOnly; SameSite=Strict; Path=/oraculum/`，无 Domain；logout 必须以同名同 Path 清除。若旧远程 `__Host-oraculum` 曾存在，仅清该名称 Path=/；不清 DSH Cookie、不用 Clear-Site-Data。仍保留重复拒绝、短期会话、撤销断开、配对限流；禁 token URL [Cookie 前缀规则](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) |
| Android Gradle / MainActivity | 当前 origin 校验仅允许无路径 origin，entry 强制加 `/`，会打开 DSH。需要把 origin 和固定 entry base 分开，入口变为 `/oraculum/`；导航和资源检查同时限制 HTTPS、精确 IP/有效端口、规范路径边界，拒绝 `/oraculum-other`、编码斜线／反斜线／目录穿越；错误页文案改为远程连接提示 |
| Android TLS / 内容边界 | 使用系统信任和 IP SAN；不忽略 SSL 错误、不导入自签 CA、不关闭校验、不 pin 会短期轮换的叶证书。保持无任意 JS 原生接口、无文件访问、混合内容禁用、备份禁用。资源 redirect 和 WS 不能仅靠 shouldInterceptRequest 视为完全受控；该回调只覆盖初始 redirect URL，需 CSP、服务器路径约束和实机测试补齐 [Android API](https://developer.android.com/reference/android/webkit/WebViewClient) |
| 两端与回归 | Electron 原本地流程、48 项既有检查、本地 auth/recovery 均保留；新加子路径／错误 Host-Origin／DSH Cookie 不可登录 Oraculum／反向亦然／重复 Cookie、撤销、资源404测试。APK 真机需复验 IP HTTPS 与 WSS；目前只能确认代码兼容条件和桌面系统证书链，不能据此宣称手机远程通过 |

## 5. SSH 与服务的精确影响范围

候选转发：VPS **127.0.0.1:17860 → 小新 127.0.0.1:17860**。部署前重新检查两端端口；不是预留，不覆盖任何占用。只为 Oraculum 创建一个独立、前台、有明确 PID 的 SSH 进程，不复用 CodeG 控制连接。

以下是**待批准后**的临时验收命令，不是本轮已执行内容：

```bash
ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UpdateHostKeys=no -o ControlMaster=no -o ControlPath=none \
  -o ForwardAgent=no -o ForwardX11=no -o RequestTTY=no \
  -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:17860:127.0.0.1:17860 dsh-vps
```

当前 `dsh-vps` 是既有 root:22 SSH 身份；本次建议仅用于获批后的临时验收，明确承认其权限较宽，不复制私钥、不改 authorized_keys／sshd_config／known_hosts。运行前核验 alias 没有附带其他 Forward；转发失败立即退出，不能改绑 0.0.0.0 或换用已有服务端口。[OpenSSH -R](https://man.openbsd.org/ssh#R)。长期驻留不能默认沿用 root 登录：是否增加受限专用 key、是否采用用户级 systemd 均另作精确方案和单独审批；本次系统服务 diff 为 **空**，没有 enable/restart 指令。

## 6. 备份、上线顺序与回滚（均未执行）

批准应覆盖：新增受保护备份目录、候选文件上传／替换、一次 Caddy validate/reload、临时 SSH 转发；不包括重启 DSH、修改 SSH 身份、持久 systemd、防火墙或证书。先完成第 4 节仓库实现与本地验证，再提交其最终 commit、APK 和本配置 hash 复核；不能只批准一个抽象方案就跳过这些前置。

1. 在部署窗口重复只读检查：基线 hash、磁盘/运行 JSON 相等、证书有效期、端口、负载、DSH health；任一漂移就停止，重新给差异。既有 DSH 长任务／WS 可能受 reload 影响，应选无关键任务的窗口。
2. 经批准后，以既有 root 身份创建唯一 `/root/oraculum-backups/<UTC>/`，0700，`umask 077`。保存 Caddyfile 原件及 owner/mode/SHA、运行 JSON（GET 127.0.0.1:2019/config/，0600）、Caddy 版本和安全健康摘要。运行 JSON 和备份不进 Git/Notion；不复制 TLS 私钥或用户会话。
3. 将已审阅候选文件上传到该目录，核对目标 hash。因备份目录只允许 root，先将候选以 root:caddy 0640 安全暂存到 `/etc/caddy/Caddyfile.oraculum.candidate`；以 caddy 身份和实际 HOME=/var/lib/caddy 执行 `caddy validate --config /etc/caddy/Caddyfile.oraculum.candidate --adapter caddyfile`。此验证与暂存也是获批后的写入；本轮只做了本地 adapt。
4. 启动受控本机 Bridge 和上述临时隧道，确认远端只出现 127.0.0.1:17860，HTTP 可连预期 Bridge，未经配对仍无法访问模型／会话。先确认原 DSH health 不变。
5. 再检查生产 Caddyfile 未漂移，用 `/etc/caddy/Caddyfile.oraculum.new` root:root 0644 同文件系统原子替换；执行 `/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address 127.0.0.1:2019`。不 restart Caddy／DSH，不改 TLS 存储。
6. 立即运行第 7 节公网检查；同版本 reload 也可能断开 DSH WS，必须验证可重新连接。任何关键回归即回滚，不继续叠加修补。

**回滚触发：** Caddy reload 失败、DSH health/管理阻断/登录/WS 异常、路由或凭据串用、意外公网监听、证书校验失败、资源明显恶化。

**回滚动作：** 用该次备份 Caddyfile 的原 owner/mode 写临时文件并原子恢复到 `/etc/caddy/Caddyfile`；对原文件 validate 后按相同地址 reload；确认原 hash、运行 JSON 语义、DSH health 与 WS 恢复。若 reload 拒绝候选且运行配置仍是原配置，也恢复磁盘，防下次重启加载候选。仅在恢复后终止本次记录 PID 的 SSH／Bridge 进程并移除本次候选临时文件；保留取证和备份。不可 `pkill ssh`、停止 CodeG tunnel、删除信任/回执数据库或恢复整个系统目录。回滚自身也可能断开 WS；失败时停止操作并报告，不擅自 restart 或重建证书。

证书 storage、DSH systemd/unit/config、现有 SSH 身份都没有预期修改，因此没有必要为本次路由变更恢复它们。若出现磁盘与运行配置原本不一致，禁止套用此回滚计划，须先重新审阅。

## 7. 获批后的验收门槛

- 既有服务：TLS IP 验证；DSH health 200；原受限管理路径仍 403；原 DSH 已配对客户端正常进入、流式输出和 WS 断后恢复。匿名 health 不能代替已认证功能验收；不新建 DSH 配对来偷换此证据。
- 路由：`/oraculum` 308；页面、CSS、JS、动态 Diff chunk 均在正确前缀；错误 API 路径 404 JSON；其他路径仍走 DSH；隧道断开时 Oraculum 502，DSH 可用。
- 认证：仅各自 Cookie 不能互相登录；无凭据 401；恶意／缺失 Origin 的 WS、错误 Host、重复 Cookie、过期和撤销均拒绝；Cookie/Authorization 不出现在 URL／日志／截图。主动检验 Cookie 转发过滤，保留同源信任风险说明，不把这些检查叫作同源隔离测试。
- 真机：新版 APK IP 证书验证、资源加载、配对、WSS、真实创建／继续／中断和双端 thread/turn/item 一致性；分别标明公网路径与 ADB 路径。
- 恢复：实际暂断／Wi-Fi 切换、锁屏、隧道重连、Bridge/App Server 重启、pending 审批丢失和双端竞争。完成／失败／未知分类准确，未知不自动重发；历史缺口仍提示。保留 Phase 2 In progress，等待正式审阅。

## 8. 本轮验证记录与审阅范围

本轮不改运行应用代码；只交付本方案及候选配置。测试环境为用户级本机短时 Caddy 2.11.7 + 两个模拟 HTTP/WS 后端、独立 Chromium 拦截夹具；没有接入真实 Codex、修改手机或触及生产配置。

初稿 adapt 暴露默认指令排序问题，已改成 route；首轮探针又发现 Node fetch 没有发送自定义 Host，得到无匹配站点的 200，不能当作路由结果。改用 HTTP request 显式 Host 后，最终候选全部检查通过。没有把失败输出或模拟认证当作生产成功。

忽略目录 `.local/evidence/phase2/ip443-design/`：

| 证据 | SHA-256 |
| --- | --- |
| vps-readonly.json | `21c04793282b346612532162d907f6f08bb5544669a2a83319b9a97157d832a3` |
| dsh-package.json | `c1d01117c9f0de92e23a7c13f9f84ff19f34b29240fa8c2f5cbcc81dd5c5758b` |
| probe.json | `30246ffa3cf5cb06fc2087ad79ebc9891fec871ff83ddbf10ec3bf241570ba6a` |
| cookie-browser.json | `ef2f25681a83024845912c7512eb85c00c31c946e513d0979009cc1c6971e993` |

本方案提交／main 合并／push hash 写回原 Task。**本轮结束等待方案审阅；不存在 VPS 配置执行授权，Phase 2 不标 Done。**
