# Iteration 2｜产物与构建身份

设备：OnePlus 6T / ONEPLUS A6013，ADB `e5ee4f28`，Android 15 / API 35，LineageOS 22.2。产物用于 Phase 3 独立审阅，任务保持 In progress。

| 产物 | 链接或核验值 |
| --- | --- |
| 交付文件夹 | [Google Drive Iteration 2](https://drive.google.com/drive/folders/1RFMOnE7UJHXPF98NL4213ul1Ui3trLdK) |
| 真机 Debug APK | [oraculum-7c37855-oneplus-debug.apk](https://drive.google.com/file/d/1I-Hhk71kvQ458AHEP_KdXb5sCmjY_kKp/view) |
| 产品源码 | `7c37855f1ebf67bcad75fcba0793b54c68f7b870`，内嵌 `sourceDirty=false` |
| APK 大小 | 14,893,980 bytes |
| APK SHA-256 | `0acbb047ce623d6d45921f3b1e4cfdc6d85fe624ba04fc10513680d698035494` |
| 包与版本 | `dev.oraculum.poc.debug`；Android versionName `0.1.2-debug` / versionCode 4；内嵌源码版本基线 `0.1.2` |
| Debug 证书 SHA-256 | `e4bb888b2c73da57e9484e5a9e2a792e733902cdf102c847228c044d93b1b1fb` |

APK 的本地归档、设备已安装 base.apk 和从 Drive 重新下载的完整内容，SHA-256 与大小一致。签名与设备既有 Debug 包一致，采用 `adb -s e5ee4f28 install -r` 更新；首次安装时间仍为 2026-11-12 14:48:54，未清除应用数据或重新配对。

本包包含现有隔离测试 CA，同时保留系统证书验证；用于本轮审阅，不作为正式发行包。后续测试脚本和文档提交不改变此 APK 的产品源码身份，不将它冒称为后续提交重新构建的产物。正式 Launcher/启动图标保持原有版本，没有正式签名或发行。

真机原图、逐图 SHA-256、功能观察及限制见 [VISUAL_REVIEW.md](VISUAL_REVIEW.md)，实现和工程检查见 [README.md](README.md)。所有截图为设备原始 PNG；私有凭据、备份、完整原生会话标识、私有测试配置与配对输入、原始网络日志及 ntfy 地址不进入交付。
