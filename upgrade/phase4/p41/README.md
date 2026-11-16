# P4.1｜Ubuntu Desktop 独立客户端交付

本阶段实现 Desktop 自有资源、React 三栏基础、三主题、独立 Profile 与 Electron 安全/恢复。真实会话、配对、Gateway 通信和持久历史不属于本阶段。本页的应用样例均明确标注为本地样例。

依据：[P4.1 当前任务](https://app.notion.com/p/41a5421e690b81e0b07ff1000d8c8abc)、[2.0 正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134)、用户接受的 P4.0 `1feeddded8ad7ccf474f201b17347d7011b0c02e`。任务保持 **In progress**，交付后等待用户审阅，不进入 P4.2。

## 实现与取舍

- 新入口在 `apps/desktop/src/main`、`src/preload`、`src/renderer`，构建输出到该应用自己的 `dist/`。旧 `.cjs`、Bridge/Web 和历史主题文件保持原样，新构建不导入它们。根 `pnpm desktop` 已切换到新独立客户端。
- 继续使用锁定的 Electron 44.9.1、React 19.3.1、Vite 8.3.4、Tailwind 4.3.3。锁文件只新增 Desktop 对已有版本的引用，没有整仓依赖升级。
- 三主题 token 的值与已接受原型完全一致，仅源文件说明注释不同；完整 Outline SVG 与批准原件逐字节一致。原生窗口图标由同一完整 SVG 按 Light accent 栅格化，保留全部几何与透明度。Diff 保持 10px。
- 默认是未配置连接页面，提供外观调整和明确的本地预览。配对、消息、附件等业务按钮禁用并有原因；不接收配对码、不伪造连接或权限确认。窄窗口 Inspector 改为可键盘关闭的覆盖面板，宽屏仍保留三栏。
- main 保存主题与 Inspector 显隐即可满足本阶段需要。没有提前构建空的 Zustand 业务 store、IndexedDB 历史库或操作 journal；这些仍按已批准路线在后续阶段实现。窗口几何未持久化。
- renderer 只有 `getState`、`setPreferences`、`resetAppearance`、`onStateChanged` 四个固定接口。没有任意 IPC channel、文件/目录读取、网络请求代理、shell 或凭据入口。
- 构建记录 renderer 文件清单及 SHA-256/size。启动先验证，再将资源读为小型只读内存映射；协议 handler 按精确 URL 返回资源，不将请求路径拼成磁盘路径。清单是损坏检测，不等于防御能整体改写应用的本机攻击者的代码签名。
- 使用新的 `oraculum-desktop-v2/development`、`production` 及可选安全 slug Profile；0700 目录、0600 配置、owner/link/marker 检查，拒绝采用未知非空目录。坏偏好文件回落默认值，首次显式保存/恢复前保留其原始字节。
- 原生菜单和 `Ctrl+Shift+0` 可独立于页面 CSS 恢复外观与缩放；关闭最后窗口退出；同 Profile 第二实例聚焦已有窗口。没有 Tray、守护进程或任何服务生命周期管理。

完整开发说明见 [Desktop README](../../../apps/desktop/README.md)。

## 本机启动与沙箱前置条件

开发 bundle 构建不需要 Gateway 或本地 Web server：

```bash
pnpm install --frozen-lockfile
pnpm build:desktop
```

本次 Ubuntu 主机限制未授权 user namespace，npm Electron 自带的 `chrome-sandbox` 又不是 root/SUID 安装。因此直接执行下载分发会在 UI 之前被 Chromium 安全拒绝。本轮没有关闭沙箱，没有改 AppArmor/sysctl、辅助程序权限、系统服务或全局环境。

实际验证使用 `.local/desktop-p41/electron-runtime`：完整复制锁定的 Electron 分发，仅省略那份未配置的 `chrome-sandbox`，通过当前 Chromium 支持的开发 helper 回退入口使用本机已有 `/opt/google/chrome/chrome-sandbox`。后者 root:root、4755，双方 helper API 均为 1；源与副本 Electron 可执行文件 SHA-256 相同：`3ba9114b7fbaafaf548f72c5d1bc86b7dc81098a85361784359c2c1199625bfc`。副本属于本次本地调试资源，未写入 Git，保留供复核；共享 `node_modules` 分发未修改。

可从仓库根目录用本机保留的副本启动（环境只影响该命令）：

```bash
ELECTRON_OVERRIDE_DIST_PATH="$PWD/.local/desktop-p41/electron-runtime" \
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
ORACULUM_DESKTOP_PROFILE=review \
pnpm --filter @oraculum/desktop exec electron ./dist --ozone-platform=wayland
```

这里的 helper 路径是**本机验证条件**，没有写进产品逻辑或设为产品默认值。在其他主机应使用其正常沙箱环境；未来 DEB 正式安装的沙箱配置留待 P4.4，不能用本轮开发运行替代安装验收。

依据：[Chromium 当前 helper 选择源码](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/linux/suid/client/setuid_sandbox_host.cc)、[开发 helper 说明](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/suid_sandbox_development.md)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。旧文档中的环境参数示例必须结合当前“优先同目录 helper，再回退开发参数”的源码及本机运行验证理解。

## 验证与证据

验证日期：2026-11-17；Ubuntu 26.04.1、GNOME Wayland、150% 显示缩放。实际运行 Electron 44.9.1 / Chromium 152.0.7977.167 / Node 24.22.0。没有使用 Xvfb 或关闭 Chromium 沙箱。

| 检查 | 结果与证据 |
| --- | --- |
| `pnpm check` | 仓库与独立 Desktop TypeScript 检查通过 |
| Desktop 单测 | 4 文件 / 83 项通过：资源协议与清单、Profile 路径权限、偏好恢复、IPC 来源与 DTO 校验 |
| 历史 Desktop 回归 | 4 文件 / 31 项通过：artifacts、notifications、paths、runtime；只执行 fixture 单测，没有启动旧 Bridge 或 Gateway |
| `pnpm build:desktop` | 两次连续构建的全部 10 个输出文件逐字节相同；4 个 renderer 资源有 SHA-256/size 清单 |
| `pnpm test:desktop:gui` | 14 组真实、启用沙箱的 Electron GUI 场景通过，见 [原始结果](gui-results.json) |
| OS 沙箱 | 实际 renderer `/proc` 读回：`Seccomp=2`、`NoNewPrivs=1`，无禁用沙箱参数 |
| 原生桌面操作 | AT-SPI 切换三主题；经精确窗口聚焦确认的系统键盘 `Ctrl+Shift+0` 将 OLED 恢复 Light，并回到未配置首屏；界面和偏好 JSON 双重读回；`Alt+F4` 后进程退出码 0、原 PID 消失 |
| 视觉复核 | 1600×1000、1280×800、1000×680 窗口和 125% 应用缩放；三主题、窄窗 Inspector、焦点与滚动正常；完整 Outline 字节相同，Diff 为 10px，OLED 三栏计算背景均为纯黑 |
| 独立审查 | 安全与视觉 Subagents 只读复核通过，无剩余阻断项；主代理另做原生窗口核验 |
| Gateway 保护 | 开工和交付时只读查询服务元数据；ActiveState/SubState、MainPID、InvocationID、NRestarts、单调启动时间逐项相同，无 Gateway 网络请求或服务变更 |

GUI 场景覆盖：独立 Profile、单实例、跳转主内容链接保持固定 URL、主题/Inspector 跨重启持久化、窄窗键盘操作、非法/超大 IPC、CSP 的 fetch/WebSocket/inline script/frame 拦截、新窗口/外部导航/权限拒绝、实际下载取消、原生菜单恢复主题和缩放、损坏偏好保留原始字节、关闭即退出。正常交互期间记录到的外部请求与未捕获异常均为 0。

证据边界：请求监听在自动化启动返回后才附加，不把它描述为完整启动抓包；redirect/frame handler 的触发测试是合成事件，外部链接点击和下载点击是实际 renderer 动作。自动化恢复菜单直接调用原生 handler，系统级快捷键由另外一轮原生操作验证；快捷键轮直接验证了主题恢复，缩放恢复来自菜单测试。测试截图使用 Electron `capturePage()`；原生截图使用桌面 portal，包含窗口装饰。两者均是实际应用，不是 P4.0 浏览器原型。

最终归档前发现并修复了自动化截图的上一帧问题：DOM 主题变化不保证合成器已完成绘制。截图现在等待字体/图像解码和双绘制帧，再以原生 bitmap 像素核对当前三栏颜色，并断言两组三主题哈希分别互异；14 组场景重新全部通过。归档仅包含修正后的 11 张自动化图，每张的主题、尺寸、像素样本和 SHA-256 都记在结果 JSON。主代理另用 Pillow 按 PNG 内嵌 ICC 转到 sRGB 独立核对六张主题图，颜色与预期一致（容许 1/255 量化误差）；OLED 为纯黑。视觉审查代理也再次逐张确认了文件名、选中主题与实际外观一致。

原生操作摘要见 [native-validation.json](native-validation.json)，15 张归档图片的尺寸、字节数与 SHA-256 见 [evidence-manifest.json](evidence-manifest.json)。自动化截图原始文件名对应 `screenshots/automated/`。

| 审阅入口 | 截图 |
| --- | --- |
| 原生 Light 首屏 | [未配置连接页](screenshots/07-native-light-connect.png) |
| 原生 Dark 样例 | [完整三栏](screenshots/08-native-dark-preview.png) |
| 原生 OLED 样例 | [纯黑三栏](screenshots/09-native-oled-preview.png) |
| 原生快捷键恢复 | [恢复 Light 首屏](screenshots/10-native-restored.png) |
| 三主题首屏 | [Light](screenshots/automated/01-connect-light.png) / [Dark](screenshots/automated/01-connect-dark.png) / [OLED](screenshots/automated/01-connect-oled.png) |
| 三主题样例 | [Light](screenshots/automated/02-preview-light.png) / [Dark](screenshots/automated/02-preview-dark.png) / [OLED](screenshots/automated/02-preview-oled.png) |
| 宽度与缩放 | [1600](screenshots/automated/03-layout-1600-1.png) / [1280](screenshots/automated/03-layout-1280-1.png) / [1000](screenshots/automated/03-layout-1000-1.png) / [1000、125%](screenshots/automated/03-layout-1000-1.25.png) |

本机 `.local/desktop-p41/` 中的验证输出与沙箱运行时副本、专用 `development-review` Profile 保留供复核；没有提交运行时、缓存、偏好或构建产物。自动化自身创建的临时 Profile 已清理，测试与原生审阅窗口均已退出。

## 源码与审阅状态

实现提交：[4284560 — feat(desktop): add isolated P4.1 client foundation](https://github.com/rando1ph/oraculum/commit/42845608b5aed8230bcfb533cadeaa0e87a29f28)。所有源码检查、GUI 场景与原生操作对应这份产品实现。构建产物中的 `build-info.json` 记录实际构建时的 Git revision 和 dirty 状态；原生截图在实施提交之前拍摄，不冒称 clean-commit 构建证据。

截图验证修正：[18c5585 — test(desktop): verify painted pixels before GUI captures](https://github.com/rando1ph/oraculum/commit/18c55853d65fbd4eb2f6244035ab27392adf27f2)。仅改变测试同步和证据断言，产品源码保持不变。重新通过 `pnpm check`、14 组真实 GUI 场景及独立图像检查。

本页与截图的最终归档提交、各次正常 push 的远端 SHA 核对结果记入 [P4.1 Task](https://app.notion.com/p/41a5421e690b81e0b07ff1000d8c8abc)。没有合并分支、创建 worktree、覆盖发布基线或推进 P4.2；当前交付等待用户审阅。

## 范围限制

- 没有真实 Gateway HTTP/WS、配对、原生 Codex 写入/审批/文件操作或 HTTPS/WSS/TLS 证据；首屏与样例的相关动作均未开放。
- 没有长期凭据、持久草稿/历史、unknown 写 journal、通知、系统文件工作流或完整业务 UI。
- 没有构建正式 DEB、安装/Release、服务或网络变更。当前 Gateway Beta 3 保持运行。
- 工程和视觉自检不代替用户最终接受；Notion 保持 In progress。
