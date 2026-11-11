# Oraculum Android 原生 PoC

本模块为 Oraculum 2.0 Phase 2 的 Kotlin + Jetpack Compose 客户端，经独立 Gateway 的 HTTP/WSS 与官方 Codex App Server 通信。正式 ID 保留 `dev.oraculum.poc`；本阶段仅使用 `.debug` 后缀的独立调试包。旧 WebView 状态、配对、缓存和主题不迁移。

工程边界、Room/DataStore/Keystore 设计、隔离 Gateway + Emulator 复现、验收记录及产物位置见 [Phase 2 工程报告](../../upgrade/phase2/README.md)。协议来源见 [Gateway 公共契约](../../packages/gateway-protocol/README.md)，服务端说明见 [Gateway](../../gateway/README.md)。决策以 [Phase 2 正式任务](https://app.notion.com/p/4155421e690b81d6bd42e4dcd321cd56) 为准。

从仓库根目录构建和检查：

```bash
bash scripts/android-build.sh :app:assembleDebugAndroidTest :app:testDebugUnitTest
```

本机隔离证书通过 `-PoraculumDebugCa=/absolute/path/to/current-fixture-ca.pem` 仅注入 Debug 构建。常规构建使用系统 CA；产品不允许明文流量或关闭证书验证。APK 默认输出在 `app/build/outputs/apk/debug/app-debug.apk`，该路径相对于本模块。

Phase 3 的完整三面板 UI、主题与通知尚未在本阶段交付。不要把历史 `scripts/android-live.ts` 等 WebView 验收脚本当作原生 PoC 的测试入口，也不要使用正式签名脚本构建本轮 Debug 测试包。
