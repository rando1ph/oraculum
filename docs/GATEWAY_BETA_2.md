# Oraculum Gateway 2.0.0 Beta 2

Gateway-only Pre-release，标签 `gateway-v2.0.0-beta.2`。Debian 包版本为 `2.0.0~beta.2`，公开下载文件名为 `oraculum-gateway_2.0.0-beta.2_amd64.deb`；包内版本、字节和 SHA-256 不因文件名规范化改变。

## 本次更新

- 开放原生命名、归档／恢复／确认永久删除、分叉、历史撤回、同 Turn 插话和手动上下文压缩。
- 省略设置时继承原生模型、思考强度及权限；提供脱敏有效配置、账户额度和累计用量读取。
- 请求链路支持 ultra 及未来原生目录声明的强度，仍按真实选定模型验证。
- MCP 使用轻量发现与有界超时；Skills／Apps 独立返回，未请求的资源数量不显示为零。
- 优先采用最新原生会话配置，保留 operationId、回执、unknown 不重放和多端失效语义。
- Gateway user unit 支持可选的私有 network.env；安装包不设置代理、不自动启用或重启服务。

## 兼容性和范围

协议为 2.1，最低客户端 minor 为 0，状态 schema 仍为 1。Gateway、Android 独立发行；本次不包含新 APK，Android Beta 1 资产不变。客户端若显式发送模型／权限覆盖，仍优先执行该覆盖；新入口、ultra 解禁等客户端修改留待 Android 更新。

归档／删除对普通无子依赖根会话可用；活动执行、待处理审批、子会话依赖或范围无法核实时拒绝该次操作。删除必须 confirm:true。压缩的 accepted 只确认触发，完成由原生事件报告；历史撤回不回滚工作区文件，旧存储可能不支持。所有原生能力仍受已安装 Codex 和账户可用性限制。

自动生成会话标题暂不可用：当前原生协议没有稳定标题生成入口；手动命名及原生名称更新同步正常。Plan 模式与未验证 Plugin 能力继续关闭。详细能力证据见 [Gateway 原生能力记录](../gateway/NATIVE_CAPABILITIES.md)。

构建只包含 Gateway、私有 Node 24 和实际依赖许可证；用户的 Stitch、Android Studio 和明确列出的 Gradle wrapper 原件留在工作区，不参与 Gateway 打包。已跟踪修改及其他未提交源码仍会阻断发行。

本次发行不执行主机安装、服务替换／重启、配对、数据迁移或网络变更。Beta 1 tag、Release 与公开资产保持不变。安装和启用新版本属于独立部署步骤。

## 发行资产

- `oraculum-gateway_2.0.0-beta.2_amd64.deb`
- `gateway-release.json`：完整来源 SHA、原构建名、公开文件名、大小、SHA-256、协议与 schema。
- `RELEASE_NOTES.md`
- `SHA256SUMS`

公开发布前验证实际 DEB、隔离 dpkg／打包运行身份；发布后从无登录公开下载重新验证全部资产、嵌入来源、校验和及 Pre-release 状态。正式结果以发布后的清单与 Notion 发行记录为准。
