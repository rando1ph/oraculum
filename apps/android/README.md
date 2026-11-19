# Oraculum Android 2.0

本模块是 Oraculum 2.0 的原生 Kotlin + Jetpack Compose 客户端，经独立 Gateway 的 HTTP/WSS 与官方 Codex App Server 通信。正式 ID 保留 `dev.oraculum.poc`，调试包使用独立 `.debug` 后缀。客户端拥有三面板工作区、Light / Dark / OLED Dark、Room/DataStore/Keystore、本地历史与草稿；不依赖退役的共享 Web UI、Bridge 或 Theme API v1，也不迁移旧 WebView 应用状态。

当前决策以 [Oraculum 2.0 正典](https://app.notion.com/p/4135421e690b815eb404c3024c860134) 和对应任务为准。[Phase 3 工程记录](../../upgrade/phase3/README.md) 及其后续视觉迭代目录保留实现与验收证据；[Android Studio 交接](../../upgrade/phase3/ANDROID_STUDIO_AGENT_HANDOFF.md) 规定用户主导的视觉调整流程。[Phase 2 工程报告](../../upgrade/phase2/README.md) 是 PoC 阶段的历史资料，不代表当前功能范围。协议来源见 [Gateway 公共契约](../../packages/gateway-protocol/README.md)，服务端说明见 [Gateway](../../gateway/README.md)。

从仓库根目录构建和检查：

```bash
bash scripts/android-build.sh :app:testDebugUnitTest
```

本机隔离证书通过 `-PoraculumDebugCa=/absolute/path/to/current-fixture-ca.pem` 仅注入 Debug 构建。常规构建使用系统 CA；产品不允许明文流量或关闭证书验证。APK 默认输出在 `app/build/outputs/apk/debug/app-debug.apk`，该路径相对于本模块。

构建脚本已包含 Debug APK 和 lint；需要测试 APK 时额外指定 `:app:assembleDebugAndroidTest`。这些主机端命令不安装 APK、不连接实机或模拟器，也不操作正在运行的 Gateway。正式版本名称和 code 来自根 `release.json`，签名流程见 [Release guide](../../docs/RELEASE.md)。Debug 构建不使用正式签名身份。P4.3.5 只清理退役代码与构建入口，不改变本模块的业务逻辑或用户数据。
