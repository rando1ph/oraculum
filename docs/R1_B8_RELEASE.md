# Oraculum 0.1.2 — R1-B8 发布交接

日期：2026-10-30。Codex 工程阶段交付；B8 Task 保持 In progress，等待用户亲自签名、正式双端安装与验收。

## 版本与产物

- 基线：`cdac1ad0581e9478645f177a9e74396023fcf498`。
- 构建源码：`1ddca336bd48e049e7d34387d3cdaa6a75079a5b`；双端嵌入该 SHA，`sourceDirty=false`。
- 版本 `0.1.2`；Android `versionCode=4`，applicationId `dev.oraculum.poc`，minSdk 26 / targetSdk 35；DEB `amd64`。
- 固定目录：`dist/releases/0.1.2-4-1ddca33/`。同目录 `SHA256SUMS`、`release-manifest.json`、`evidence/` 与本说明供复核。

| 文件 | SHA-256 |
| --- | --- |
| `oraculum_0.1.2_amd64.deb` | `be2022bf8473255591441deb0647942f5bd42aa275a2db076dde584f6b741657` |
| `oraculum-0.1.2-4-unsigned.apk` | `6b12fa97ee622d3866f0b9ef68865882b708bc0f4fe5c71d0e069e8e688e0757` |

DEB 是真实构建的安装包；APK 是对齐且非调试的 **未签名 Release**，尚不能作为正式安装包。没有签名、安装或替换任何正式应用。

## 本版整合

整合已接受的 B1 消息/移动体验修复、B2 GFM 表格、B3 原生协议与用量、B4 原生会话和运行控制、B5 图片/文档上传及主机成果预览下载、B6 只读扩展总览与子代理树、B7 通知及恢复。四套主题、模型与思考强度策略、唯一官方 Codex Harness 保持原有设计；不新增搜索、Queue、Provider 切换或部署功能。Plan 等可选能力继续按真实接口可用性显示，不能把未支持接口当成完整功能。

B8 增加干净构建来源校验与权限核验，修复签名流程对离线备份的日常依赖；修正两处随 B7 变化而失效的旧测试断言及主题资源 URL 校验。未重写既有功能。

## 实际验证

- TypeScript 检查、Web 构建、51 个测试文件共 537 项通过；无密钥的签名脚本模拟测试 11 项通过。
- 16 组源码 GUI 回归通过：主题加载、移动菜单、消息/GFM、用量、会话控制、附件、成果、扩展/子代理、输入、执行过程、原生请求、权限、生命周期、设备信任、香港霓虹、旧终端。生命周期旧 sessionStorage 断言与信任测试遗漏 bridge/ping 已修正后复跑通过；没有修改对应产品逻辑。
- 最终 DEB：完整包结构、依赖和许可证/原始品牌资源、root 归属和 4755 helper 元数据、无用户数据/密钥/开发工具、便携独立 Node/SQLite/Bridge、根路径及可配置 HTTPS 子路径的鉴权与主题字节校验通过。只解压到临时目录，未执行安装。
- 最终 DEB 的实际 Electron/Web/主题：真实配对的附件、成果、扩展/子代理三组 GUI 合约通过（6 + 7 + 10 项）；覆盖流式传输、取消、文件字节、PDF Canvas、图片/GFM、四主题、窄屏、鉴权撤销、原生层级及重连。BridgeService 和原生回复为受控夹具；保存/外部打开对话框为测试替身，不能当作真实 Android SAF/Office 验收。
- OS 沙箱：使用字节一致的既有 root:root 4755 helper，仅在临时解压目录创建引用；未改系统文件。正式程序显式启用沙箱，渲染器 `Seccomp=2`、`NoNewPrivs=1`、`CapEff=0`，内核 NSpid 证明独立 PID 命名空间。普通用户原样解压时 helper 不归 root，启动会拒绝；通过结果以本机既有相同 helper 为条件，不是已安装升级证明。
- 最终 Android：`lintRelease`、`testReleaseUnitTest`（14 项）、`assembleRelease` 通过；校验源码 SHA/干净状态、非调试、无签名、zipalign、品牌字节、完整许可证、禁备份/明文、精确四项权限、私有 remoteMessaging Service 与私有 ArtifactFileProvider。
- 真实 Codex CLI `0.165.0`：独立 runtime 在临时 HOME/CODEX_HOME 只读初始化成功；扩展盘点成功（MCP 在无 thread 时 8 项运行状态未知，正确显示部分信息）；离线附件 localImage/文档路径及原生 workspace 沙箱读取通过；继承模型/effort 的一次无工具通知回合完成，0 次审批请求，原配置哈希不变。没有升级本机 Codex。构建协议 schema 仍为已审阅的 0.160.0；运行时按稳定接口兼容，而非强制相等。
- 全部最终重建/验证按顺序执行，结果和耗时见 `evidence/final-summary.json`。Android ADB 无连接设备；本轮手机界面均为 Chromium 触屏仿真，**未进行 Release 真机安装或验证**。真实多层 Codex 子代理模型执行、OAuth 外部流程亦未冒充为已测。

## 本次桌面卡住与注销调查

确定的直接原因是 GNOME Shell/Wayland 合成器崩溃：10:57:28 记录 `meta_window_set_stack_position_no_sync` 的窗口栈断言，随即 `GNOME Shell crashed with signal 11`；10:57:51 用户服务记录 `status=11/SEGV` 和 core-dump，随后 Wayland 客户端断开并回到登录。未发生整机重启。同期成果 Electron 测试启动了窗口，GPU 日志含 VAAPI 初始化错误与 Wayland/Vulkan 不兼容提示；该测试因此中断，并非产品断言失败。

检查 10:52–10:58:30 的内核与用户日志，未发现 OOM/内存不足杀进程或 GPU reset 记录。未采集原生 core 栈，因此只能确定合成器 SIGSEGV 导致注销及时间关联，不能确定具体 Mutter/驱动/扩展缺陷，也不能宣称已修复 GNOME 本身。

处理方法：停止在活动桌面创建自动测试窗口，改用本地解压的 Xvfb、私有 Xauthority、不允许自动激活服务的私有 D-Bus、软件渲染；每个测试/构建用临时资源 scope 限制 2 核 CPU、6 GiB 内存、512 MiB swap，重型任务串行执行。隔离后的成果、扩展及其余 GUI 与正式包回归通过，未再观察到 GNOME Shell 崩溃。没有改 GNOME 配置、内核/AppArmor、安全策略或生产服务。只保存脱敏事件摘要，不上传 core、原始进程环境或完整系统日志。

## 用户以后签名：一条命令

在用户自己的本机终端执行，关闭终端录制和 shell tracing。日常签名不必挂载离线 JKS 备份。现有主 JKS、配置与原证书继续复用；本轮未读取或改动它们，也未建立自动密码存储。

```sh
cd ~/Projects/Oraculum && python3 scripts/android-signing.py release --apk "$PWD/dist/releases/0.1.2-4-1ddca33/oraculum-0.1.2-4-unsigned.apk"
```

脚本验证所选 APK 的干净构建版本与已知 Git 来源，在私有副本上检查后调用 SDK apksigner；密码只由签名工具从用户终端读取。完成后自动检查原证书指纹、v2/v3 签名、对齐及 Manifest，原子发布到 `dist/android/oraculum-0.1.2-4.apk`。`--apk` 不重建已审阅文件；输入及既有签名产物不会覆盖。当前仓库须干净，release.json 须仍为 0.1.2/code4。实际密钥解锁/签名没有在 Codex 阶段运行，留用户验证。

可先在产物目录运行 `sha256sum -c SHA256SUMS`。现有 0.1.1 正式 APK 经只读验证的公开证书 SHA-256 为：

```text
8fea7a54440c7dd6de7b873903e5ae9bde0516e4d9c54616cfb57aac7269e994
```

此指纹来自旧 APK，不是读取 JKS。签名脚本仍以原有外部配置保存的公钥指纹校验；若与历史证书不一致，应停止检查，不能新建密钥。只有用户专门检查备份时才挂载原介质并执行 `python3 scripts/android-signing.py verify-backup`；不要为本次已有密钥运行 init/resume。

## 升级、数据与后续安装

本轮不修改正式运行配置。HTTPS Origin 与 Base Path 仍为配置/构建输入，新 APK 未预设私人服务器；现有用户设置的 HTTPS 入口继续由应用保存。Node 24.21.0、Electron 44.9.1、Forge 8.0.1、JDK 21、Gradle 8.13、Android Build Tools 35.0.0 沿用现有固定工具链。

Ubuntu 由用户后续执行：先确认实际选用的 runtime.json、Bridge state、工作目录、桌面 profile 与用户服务；保留旧安装包，并在停止写入或使用 SQLite 一致性备份的条件下备份数据库及相关数据（活跃 WAL 不能只复制主 db）。保留 Codex home、附件 inbox 和个人主题。不得通过 ORACULUM_INIT_STATE=1 新建空库替换已有数据。明确数据选择和备份后，用户可以从仓库目录安装：

```sh
sudo apt install ./dist/releases/0.1.2-4-1ddca33/oraculum_0.1.2_amd64.deb
```

这一步尚未执行。包不注册/enable 用户服务；已有 Bridge 进程不会因磁盘文件替换而升级，需由用户在实际生产验收阶段安排退出旧 GUI、停止/启动已确认的 Bridge 用户服务，再验证 `/health`、配对、会话历史和无重复发送。不要为新包另外新建数据路径或自动迁移旧 profile。原信任 schema v1/收据与 B5 附件表遵循现有校验，过旧 Bridge 未必接受新增表或空 expiry；不得把旧数据库备份覆盖到已产生新收据的活跃系统。

Android 正式安装的先决条件是签名完成。后续连接设备，用户先核对 `adb shell dumpsys package dev.oraculum.poc` 的 versionCode/debuggable，并通过 `adb shell pm path dev.oraculum.poc` 找到已装 APK、拉取到临时目录、用 SDK `apksigner verify --print-certs` 比对证书。历史 B7 报告的旧安装实际是可调试 0.1.0，不能假定等于保留的 0.1.1 正式签名包。

只有 applicationId 与证书均一致、现装 versionCode 小于 4，且用户确认备份/数据保留后，才可执行普通更新：

```sh
adb install -r dist/android/oraculum-0.1.2-4.apk
```

证书不匹配时停止，保留旧应用与私有数据；不卸载、不清数据、不强制降级，不把 Debug 转正式版当作正常覆盖升级。`dev.oraculum.poc.debug` 是独立测试 ID，本次未安装。新包 code4 上线后，旧 code3 APK 不能普通回退升级；优先用同一证书、更高 code 的修正版前滚。保留旧产物有助复核，不代表能无损降级。

用户验收重点：四主题与移动键盘/返回；GFM 宽表；模型/effort 与用量；重命名/Fork/Steer/Review/Compact 和不支持能力的提示；图片文档选择与发送；PDF/图片/文本预览、Office/SAF 保存分享；扩展状态、已有子代理详情；应用前台和返回桌面后的通知、点击恢复、断线重连、草稿/阅读位置和未知发送不重放。通知许可、前台服务的耗电与厂商后台策略须在正式设备确认；锁屏/Doze/杀进程恢复未测。生产 Bridge、VPS、Caddy、SSH、CodeG 等均未改动。

用户签名、正式双端安装/升级、视觉体验与独立源码审阅仍待完成。B8 不标 Done，不进入下一功能阶段。
