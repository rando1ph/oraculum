# 阶段 B：双 DEB 与 Bridge 更新交接

项目规格与授权以 Notion 正典、阶段 B Task 和关联方案为准。本阶段交付源码、候选包及隔离演练；任务保持 In progress。正式安装、生产服务入口切换与 Android 真机验收属于另行批准的阶段 D。

## 文件归属与兼容

| 内容 | 新归属 |
| --- | --- |
| Bridge 程序、Node 24、共享 Web UI、主题和许可 | `oraculum-bridge` DEB，`/usr/lib/oraculum-bridge` |
| Bridge 稳定命令 | `/usr/bin/oraculum-bridge` |
| Bridge user unit | `/usr/lib/systemd/user/oraculum-bridge.service`，安装不启动、不 enable |
| Electron、通知、splash、图标和桌面许可 | 原 `oraculum` DEB，`/usr/lib/oraculum/resources/desktop` |
| 配置、信任/项目/Receipts、主题、附件、Desktop profile | 保留实际用户路径，不属于两个 DEB |

Bridge 与 Desktop 各自从 `release.json.components` 读取版本，初始均为 `0.2.0`。Android 保留 `0.1.2 / code 4`，本阶段不构建、签名或安装 APK。Web UI 随 Bridge 更新；客户端协议仍为 1，数据库支持显式 schema 0–1，当前 schema 为 1，没有增加新 migration。

新版 Desktop 从自身携带的只读配置解析器读取原 `runtime.json`，环境覆盖优先；不从 Bridge 目录加载执行代码。健康 Bridge 无需启动第二份；仅在既有管理政策允许且已注册独立入口时启动该用户服务。缺失、不兼容或旧入口通过本地 splash 提供修复提示。桌面关闭不会停止 Bridge。

旧 `oraculum` 0.1.2 内的 runtime 仍由旧包拥有。先安装独立 Bridge 不会删除它，也不会启动新实例。**升级 Desktop 会按 dpkg 的正常文件归属删除旧内置 runtime，因此必须先切换服务，再升级 Desktop。** 推荐步骤用 `desktop-preflight` 阻断旧入口，仅允许单个 `/usr/bin/oraculum-bridge` 或独立包默认的 `/usr/lib/oraculum-bridge/bin/oraculum-bridge` 启动入口，不接受任意自定义命令路径；直接绕过工具运行 APT 不具备这一用户服务预检。新安装的两 DEB 可以任意顺序装入，Desktop 在 Bridge 尚未安装时显示引导。

## 构建与隔离验证

独立候选流程、版本及手动 GitHub Actions 配置见 [组件发行流程](COMPONENT_RELEASES.md)。候选工作流只上传审阅 artifact，不创建公开 Release。

```sh
pnpm check
pnpm test
pnpm build:bridge:deb
pnpm build:desktop:deb
node scripts/verify-bridge-deb.mjs dist/bridge/oraculum-bridge_0.2.0_amd64.deb
node scripts/verify-deb.mjs dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb
node scripts/stage-b-acceptance.mjs dist/releases/0.1.2-4-1ddca33/oraculum_0.1.2_amd64.deb dist/bridge/oraculum-bridge_0.2.0_amd64.deb dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb dist/android/oraculum-0.1.2-4.apk
```

包级脚本在 bubblewrap namespace 的临时 root/dpkg 数据库安装包，安装期间宿主文件系统只读；不向真实 `/usr` 安装，不操作真实用户服务。测试包含旧包→Bridge→Desktop、反向新装顺序、独立卸载、Bridge-only 更新、失败 postinst 夹具及二进制回滚后保留新回执。夹具包不能用于安装或发行。依赖使用 `--force-depends` 以验证文件归属；宿主动态库、运行入口和 GUI 另由真实包校验，不能将其称为全新 Ubuntu 系统的 APT 依赖安装测试。

打包 GUI 使用私有 Xvfb/D-Bus，读用与候选字节一致的现存 root-owned sandbox helper；不修改 helper：

```sh
bash scripts/isolated-ui.sh node scripts/package-sandbox-check.mjs dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb --sandbox-helper /usr/lib/oraculum/chrome-sandbox
bash scripts/isolated-ui.sh node scripts/desktop-recovery-contract.mjs dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb --sandbox-helper /usr/lib/oraculum/chrome-sandbox
bash scripts/isolated-ui.sh node scripts/package-ui-contract.mjs dist/desktop/out/make/deb/x64/oraculum_0.2.0_amd64.deb dist/bridge/oraculum-bridge_0.2.0_amd64.deb --sandbox-helper /usr/lib/oraculum/chrome-sandbox
ORACULUM_STAGE_B_DEB="$PWD/dist/bridge/oraculum-bridge_0.2.0_amd64.deb" bash scripts/isolated-ui.sh pnpm exec tsx scripts/stage-b-native.ts
```

真实 Codex 脚本只使用临时私密原生配置/登录副本、独立 native HOME、项目、配对和状态库，退出删除凭据副本并核对原文件指纹。公网用现有部署的 URL/port 输入；占用生产端口需显式允许并确认正式服务 inactive，脚本不改变隧道或代理。现有 APK 的字节、原生源码身份与认证/通知协议做只读检查；Chromium 手机尺寸不能替代阶段 D Android 真机验收。

证据位于 `.local/evidence/stage-b`，最终候选 SHA256 和具体报告目录写入 Notion Task。正式状态副本含私密数据，不上传数据库、profile、配置或凭据；只上传脱敏结果和合成/受控截图。

## 用户正式安装步骤（阶段 D 单独批准后）

以下命令会替换已安装软件并切换用户服务，本阶段没有执行。影响仅为本机两个包和 `oraculum-bridge.service`；不需要修改 VPS/Caddy/SSH 或 Android APK。先经独立审阅批准候选，并保留旧 `0.1.2` DEB、两个新 DEB、校验文件、原配置与回滚位置。确认官方 Codex 继续独立安装且可用。

1. 关闭 Desktop，确保没有正在进行的写操作。进入收到的 Bridge 候选目录，以日常用户运行，核对交接 SHA256；脚本只在调用 APT 时使用 sudo，不要用 sudo 启动整个脚本。

```sh
sha256sum --check SHA256SUMS
python3 ./bridge-update.py status
mkdir -m 700 "$HOME/oraculum-upgrade-backups"
systemctl --user stop oraculum-bridge.service
```

`status` 显示有效配置、状态、profile 与服务来源，不输出环境值或凭据。若发现路径与预期不同，先停止升级。`EnvironmentFile` 等只支持明确的非执行语法；不能确定的用户服务环境会拒绝操作，需人工复核。备份前也必须关闭 Desktop，避免 profile 正在写入。若有效 `ORACULUM_WEB_DIR` 或 `ORACULUM_THEME_SOURCE_DIR` 仍指向旧 `/usr/lib/oraculum/resources/runtime`，工具会在安装、服务切换及 Desktop 预检前拒绝操作，不能用候选资源掩盖该配置。需在阶段 D 获准窗口内复核并去除旧包路径覆盖，让新启动器使用独立包默认资源；有效的外部自定义资源目录会原样保留并参与预检，缺失时停止，不自动改写配置。

2. 按独立审阅交接的 **Bridge DEB SHA256** 安装第一包。用 `sha256sum` 现场重算只能检查传输，不能代替对交接值的核对。此处将 `REVIEWED_BRIDGE_SHA256` 换成已核对的 64 位值：

```sh
python3 ./bridge-update.py install --version 0.2.0 --deb "$PWD/oraculum-bridge_0.2.0_amd64.deb" --sha256 REVIEWED_BRIDGE_SHA256 --backup-dir "$HOME/oraculum-upgrade-backups/before-bridge-0.2.0"
```

脚本对现有配置、状态/主题、Desktop profile 与 unit/drop-ins 做私密备份，SQLite 使用 Backup API（含 WAL 的一致快照）；在副本中运行候选只读预检，然后调用系统 APT。项目、Codex 配置和附件 inbox 保留原路径，不复制/迁移实际项目。脚本不启动或注册第二个 Bridge，不初始化空库。备份失败、schema 不兼容、哈希/来源/版本不符都会停止。

未来经批准的正式 Release 可用 `install --version X.Y.Z` 代替 `--deb/--sha256`，工具仅接受固定官方仓库对应 `bridge-vX.Y.Z` 的非 draft、非 prerelease Release 及匹配清单。阶段 B 尚无公开 Release，不能现在使用远程发布路径安装候选。

3. 在旧 Desktop 仍安装时，单独受控切换原服务入口：

```sh
python3 ./bridge-update.py service-switch --backup-dir "$HOME/oraculum-upgrade-backups/service-switch-0.2.0"
systemctl --user show oraculum-bridge.service -p ExecStart -p FragmentPath -p DropInPaths
systemctl --user start oraculum-bridge.service
python3 ./bridge-update.py status
```

`service-switch` 保留原 fragment/link 和全部既有 drop-ins，将旧链接实体化后只增加受管理的 ExecStart override，daemon-reload 后核验生效入口。不会 start/enable；已有 override 冲突时拒绝并恢复原入口。原配置/环境设置继续适用，不能恢复过时数据库快照。用本机 Desktop/独立浏览器核对配置、既有项目、配对及 Receipts，确认只有一个 Bridge 实例、官方 Codex 正常。

4. 进入 Desktop 候选目录，核对其 SHA256，再通过入口预检升级原包：

```sh
sha256sum --check SHA256SUMS
python3 /absolute/path/to/bridge-candidate/bridge-update.py desktop-preflight && sudo apt-get install ./oraculum_0.2.0_amd64.deb
```

启动「神谕」，检查原 profile、开屏、通知、主题、现有会话和附件。最后用原 Android Release 0.1.2 验证既有 HTTPS/WSS 入口、原配对、历史、发送/回执和前后台恢复；不要求重签或安装新 APK。不要把 Chromium 回归冒充手机结果。

## 后续 Bridge 升级与故障回滚

更新前保留当前已装版本的已校验 DEB和清单，关闭 Desktop并在获准维护窗口停止 Bridge。使用 `update --version 新版 --previous-deb 当前DEB --previous-sha256 当前SHA --previous-version 当前版本 --backup-dir 新目录`；本地候选另加 `--deb/--sha256`。工具要求升级版本递增，替换前验证新旧二进制均能读取当前状态副本；失败用 APT 恢复原包，并重新校验最新状态。

有必要主动降级时使用 `rollback`，参数与 `update` 相同，但目标为较旧版本、`--previous-*` 描述当前已装版本。降级通过 APT 的显式 allow-downgrades 完成。**始终保留最新 SQLite/Receipts，不恢复旧备份覆盖新写入。** 若 schema 超出目标程序声明范围，工具拒绝自动二进制回滚，需要独立迁移方案。

首轮双包切换失败且旧 Desktop 尚在时，可在停止 Bridge 后运行：

```sh
python3 ./bridge-update.py service-restore --backup-dir "$HOME/oraculum-upgrade-backups/service-switch-0.2.0"
```

它只恢复服务入口，不恢复数据、不自动启动。若新 Desktop 已删去旧 runtime，先以 APT 恢复保留的旧 Desktop DEB，再恢复旧链接；仍用最新状态做旧运行时兼容检查，不能将备份库直接覆盖回去。只有原程序/入口和数据核对完成后才启动；失败时保持停止，保存工具输出与原包，按原生 APT 状态诊断，不能强制覆盖或清库。
