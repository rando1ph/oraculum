# Iteration 2｜用户 Oracle Eye 资产接入

依据：[Iteration 2 正式任务](https://app.notion.com/p/4165421e690b81308f13da32581c9e54)。唯一新图形来源为用户提供的 [Oraculum_Oracle_Eye_SVG.zip](https://drive.google.com/file/d/1qRvZ9IywsUhv8zjfjc-Ge3Uyx3C6MYH8/view)，121,421 bytes，SHA-256 `928caf16833d3fbcb95f76d2546a200ae63f88d2270ce0086e25affb681dc227`。未重新设计或使用图像生成。原 ZIP 保留在本机本轮输入目录；以下四个解压原件逐字节保存于 [design/brand/oracle-eye-user](../../../design/brand/oracle-eye-user)。

| 原件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `oraculum_oracle_eye_outline.svg` | 2,878 bytes | `e0a6f6929764743544dbde7f39f1086b2fc922c64d482a62f7233ae2c69d7ba6` |
| `oraculum_oracle_eye_compact.svg` | 1,158 bytes | `451a39b12384fc7503f1e339003e44b18eed68be5c3d330c23a5c8e1abde6650` |
| `oraculum_oracle_eye_preview.png` | 93,653 bytes | `e4552a35e1cb653672eeac305918cc4197916778fbe7ca713089b68ba000d1f8` |
| `oraculum_oracle_eye_compact_preview.png` | 29,632 bytes | `2672dc2b8249d7bc6a73e86b1ba7797b2211046ab5cf21b09491237b6c4ce99d` |

## Android 转换与调用

- [oracle_eye_full.xml](../../../apps/android/app/src/main/res/drawable/oracle_eye_full.xml)：256×256 viewport，完整 24 个几何元素；用于空状态等大尺寸品牌区域。
- [oracle_eye_compact.xml](../../../apps/android/app/src/main/res/drawable/oracle_eye_compact.xml)：64×64 viewport，紧凑 9 个几何元素；用于 Toolbar、导航和助手头像。
- [OracleEyeMark](../../../apps/android/app/src/main/java/dev/oraculum/poc/ui/OraculumIcon.kt) 默认选择 `OracleEyeVariant.Compact`；大图显式传入 `variant = OracleEyeVariant.Full`。大小由场景的 `size` 决定；颜色来自 `MaterialTheme.colorScheme.primary` 或调用处适合容器的语义颜色。
- 原 SVG 的所有 `path d` 原样保留；`circle` 转为相同圆心和半径的两个半圆弧。描边宽度、圆头/圆角、各图形透明度保持，`currentColor` 由 Compose tint 提供。背景透明，未加入实色底板。无 transform、滤镜、字体或远程资源依赖。
- 原先自绘的 `oracle_eye_line.xml` 被这两份用户资产替代；正式应用 `@drawable/oracle_eye` PNG、启动背景、BrandSplash 和 Manifest 图标指向不变。

## 已执行的资产验证

2026-11-12：四份仓库原件与已核验 ZIP 中对应文件字节完全相同。Android SDK 35.0.0 `aapt2 compile` 成功编译两个 XML；差异空白检查通过。

已逐张查看用户两份原始预览，并将 VectorDrawable 几何/颜色/透明度回转为 SVG，用 CairoSVG 与原 SVG 在深色、浅色、纯黑三种背景分别渲染比较（完整图 512px、紧凑图 128px）。六组图形位置、比例、细节及透明背景一致；圆形路径与分组透明度的栅格化存在抗锯齿差异，未声称像素完全一致：0–255 通道的平均差异范围为 0.0179–0.0451，单通道最大差异 15。已目视检查完整深色与紧凑浅色渲染，保留外环缺口、星芒、四向圆点与原描边层级。该验证检查转换本身，不代替 Android 真机绘制或用户视觉验收。

本机可复核证据位于 `.local/iteration2/oracle-verification/`（六张生成验证图、`results.json`、资源编译结果）；生成验证图不作为真机截图交付。最终 Compose/一加 6T 画面的验证由本轮主交付记录与视觉索引承接。

转换资源 SHA-256：

- Full：`a4550b61a56e786e139ac183d7e7a70f00d8e1f6e9b9fab74ef842740f478ded`
- Compact：`31031fc8055cd6eba02f0f145e23840a37abeee1691917cf260a00c7dc29f6ac`
