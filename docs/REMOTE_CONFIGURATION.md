# 远程入口配置

Oraculum 的产品代码不依赖任何 VPS、云厂商、代理软件、域名或固定子路径。Bridge 仍只监听本机 `127.0.0.1`，通过用户自己的 HTTPS/WSS 代理和受保护隧道访问；官方 Codex 凭据始终留在执行主机。当前用户的基础设施方案另见 [IP:443 部署方案](PHASE_2_IP443_PLAN.md)。

## 产品参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `ORACULUM_REMOTE_ORIGIN` | 未启用远程 | 精确 HTTPS origin，可含端口，不含 userinfo、路径、查询或片段 |
| `ORACULUM_REMOTE_BASE_PATH` | `/` | 远程 UI、资源、HTTP API、WS 和 Cookie 的共同目录 |
| Android `-PoraculumOrigin` | 空；仅 debug 支持本地入口 | 与 Bridge 的远程 origin 相同 |
| Android `-PoraculumBasePath` | `/` | 与 Bridge 的远程 base 相同 |
| `ORACULUM_PORT` | `17860` | 本机 Bridge 环回端口；本阶段 Android 本地调试沿用 17860 |
| `ORACULUM_STATE_DIR` | `.local/runtime` | 私密信任和最小发送回执；目录 0700、文件 0600 |

Base Path 必须以 `/` 开头；省略末尾 `/` 会规范化补齐。只允许 ASCII 字母、数字、`-._~` 和路径分隔符；拒绝空段、`.` / `..` 段、百分号编码、反斜线、空白、查询及片段。未配置 origin 时不允许配置非根远程 base。反向代理必须保留该前缀，不要剥离路径。

以下使用保留示例地址，不能直接用于当前用户的部署：

```bash
ORACULUM_REMOTE_ORIGIN=https://example.test:9443 \
ORACULUM_REMOTE_BASE_PATH=/team/console/ \
pnpm bridge

bash scripts/android-build.sh \
  -PoraculumOrigin=https://example.test:9443 \
  -PoraculumBasePath=/team/console/
```

更换服务器只需更换这些参数及用户自己的代理／隧道配置，不修改 TS、React 或 Kotlin。Android Phase 2 的地址在构建时确定，因此可能需要重建 APK；运行时设置界面属于 Phase 3。

## 同一构建、两个入口

- `pnpm build` 的同一份静态资源使用相对路径。Web 从服务器提供的规范目录入口（或该目录的 index.html）生成认证和 WS URL，动态 Diff chunk 也保持相对路径；不需要为每个远程地址重建 Web。
- Electron 与 debug Android 继续访问 `http://127.0.0.1:17860/`；其 API、WS、Cookie 和设备信任行为保持本地模式。公网故障不阻止本机连接。
- 远程示例入口为 `https://example.test:9443/team/console/`，API 是该目录下的 `auth/session`、`auth/pair`、`auth/logout`、`health`，WS 为 `wss://example.test:9443/team/console/ws`。
- Bridge 将精确 Host、Origin、代理覆盖的 X-Forwarded-Proto=https、规范 Base Path 一起验证；远程不能借未加前缀的本地路由访问。错误 API／静态资源不返回 SPA HTML 成功页；原始编码／目录穿越路径被拒绝。
- 用户的代理应保留客户端 Host/Origin，覆盖 TLS 转发头，只把请求送到受保护的环回隧道；不要通过伪造 localhost Host 绕过远程认证。HTTPS 私钥、代理配置、隧道和可用性由部署层管理。

## 信任和迁移

本地使用 `oraculum_local; HttpOnly; SameSite=Strict; Path=/`；远程使用 `__Secure-oraculum_session; Secure; HttpOnly; SameSite=Strict; Path=<base>`，无 Domain，24 小时有效。短期配对码、限流、重复 Cookie 拒绝、撤销断开和发送回执机制保持有效。

远程信任绑定 origin 与 base，换地址／路径后须重新配对。配对和注销仅清理 Oraculum 的旧 `__Host-oraculum` 及新名称的祖先路径 Cookie，避免从 `/` 迁移后重复附带会话 Cookie；不清理其他应用 Cookie，不使用 Clear-Site-Data。旧远程名称不再接受。多应用／多实例强隔离不是本阶段产品目标。

共享 origin 下两个应用的 JS 仍可互访；Cookie Path 和代理的已知 Cookie 过滤不能构成强浏览器隔离。此风险由用户部署选择承担，不能据此停用认证或 TLS。Android 限制精确 HTTPS host/有效端口及规范 base 路径，阻断跨域／跨路径导航，使用系统 TLS 信任，不忽略 SSL 错误；重定向与 WS 的完整边界仍由产品服务端约束及部署验收共同验证。

## 验证命令与证据含义

```bash
pnpm check
pnpm test
pnpm build
pnpm test:ui:mock
ORACULUM_TEST_REMOTE_BASE=/ pnpm test:ui:mock
ORACULUM_TEST_REMOTE_BASE=/team/console/ pnpm test:ui:mock
bash scripts/android-build.sh
```

`test:ui:mock` 的默认模式是真实 Electron + 模拟原生事件；远程模式是真实 Chromium + 仅环回的临时 TLS 反代 + 正常设备认证 + 模拟原生事件，验证资源／懒加载、HTTP、WS、审批、重载和撤销。远程夹具使用一次性自签证书，仅该隔离测试浏览器接受证书例外；**不改系统、Android 或产品的 TLS 验证，不代表正式公网证书／WSS 验收**。密钥随夹具删除，证据写入忽略目录。

真实手机与 Electron 的本地认证／原生历史复验使用既有 `test:auth:android` / `test:auth:ui`，需要正常 Bridge 及应用专用 CDP，凭据不导出。正式远程必须另行取得部署批准，然后在没有 USB／ADB reverse、移动数据路径下完成真实原生会话、审批、同步和故障恢复。
