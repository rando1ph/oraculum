# Phase 3 Visual Refinement｜Iteration 1 视觉索引

**26 张真实 Emulator 原始 PNG，等待用户视觉审阅；子任务与 Phase 3 母任务均保持 In progress。**

- Build：`ba4ead96f68d8d3464528c97a541e44b768dfb19`，`sourceDirty=false`。所有下列 PNG 均来自这份源码的隔离 fixture CA Debug 构建，不是设计图或合成图。
- 设备：`emulator-5554`，API 36，420 dpi；竖屏 1080 × 2400，横屏 2400 × 1080。默认系统字体；标注 200% 的图片使用系统 `font_scale=2.0`，其余 1.0。阅读字号维持 100%。
- [本轮文件夹](https://drive.google.com/drive/folders/1Q0-1wjg7atr5iEoCqn1nQxcsxJvPPTH6) · [第一轮原图](https://drive.google.com/drive/folders/1Goib8sSQzkKOb_z-lSC7MdaZcIJ0pIGY) · [完整产物 manifest](https://drive.google.com/file/d/1plpIAKWPbboCf2Y_I0veVIKPIa6WkHOK/view?usp=drivesdk) · [系统 CA Debug APK](https://drive.google.com/file/d/1QMtF5OPSG5bOV_p1uQZyMZC03_GWS2uf/view)

先审阅 01–11：同一专用真实 Codex 会话覆盖三主题、三主界面、设置/模型/权限、代码与 IME；12–26 补充渐进展开、文件、安全与适配状态。

| # | 实际截图 | 重点 | Stitch |
| --- | --- | --- | --- |
| 01 | [Dark 主对话](https://drive.google.com/file/d/1B7j5CgS38NWhUUGm_LBTILY8YluJQZGv/view?usp=drivesdk) | 助手/用户/代码与 Composer 的层级 | S1 |
| 02 | [Light 主对话](https://drive.google.com/file/d/1M41c5dFcmD0uVBnyXYJzzKj3-9B0qGHD/view?usp=drivesdk) | 同一真实回复和滚动位置 | S1 |
| 03 | [OLED Dark 主对话](https://drive.google.com/file/d/1IC_m31IU329Uk9QpX5ttpsl2zRnDe2o5/view?usp=drivesdk) | 纯黑根背景与内容容器层次 | S1 |
| 04 | [左侧导航](https://drive.google.com/file/d/169FXb1wzUcD7-MtOitFMLVfqx_Mji1my/view?usp=drivesdk) | 品牌、紧凑列表、按需搜索入口 | S2 |
| 05 | [Inspector 输出](https://drive.google.com/file/d/19bKnhlivHl_avaYI0CJhoxOnivFa3m29/view?usp=drivesdk) | 状态先行、短 ID、真实失败状态可见 | I2 |
| 06 | [设置](https://drive.google.com/file/d/1X5uGBNDYwgg0rEZuuCKP8sOBvN6eDpon/view?usp=drivesdk) | 外观、字号、称呼与通知分组 | S3 |
| 07 | [模型与思考强度入口](https://drive.google.com/file/d/1saA80nkva7wLMNTCFTv8FcYt_inQsAWN/view?usp=drivesdk) | 真实模型目录与当前原生模型 | S3 |
| 08 | [执行权限](https://drive.google.com/file/d/1MStNIsLmrHi9nck7oGOVyDtt0oMPO9EV/view?usp=drivesdk) | 完整风险说明、原生回读边界 | S3 |
| 09 | [Full access 确认](https://drive.google.com/file/d/1PIqbqBVT3W99FWvzFx6AVjOPDPQ01BqD/view?usp=drivesdk) | 本次展示后取消，未授权 Full access | S3 |
| 10 | [真实 Kotlin 代码块](https://drive.google.com/file/d/1eoF9DpsGimKhNa_Wm4Vw-ugXIV0gSy5z/view?usp=drivesdk) | 独立标题/内容层与复制操作 | S1 |
| 11 | [真实 Android IME](https://drive.google.com/file/d/1ASxjo2IBX6jFLCMiOk_qYf3IhHKuc-hF/view?usp=drivesdk) | 键盘弹出后草稿、附件与发送仍可达 | S1 |
| 12 | [展开完整 ID](https://drive.google.com/file/d/1aVZ2zN8uPpuPhb8E0pVxSIpBL7jwOKxU/view?usp=drivesdk) | 完整 Turn ID 和复制入口 | I2 |
| 13 | [真实 Diff](https://drive.google.com/file/d/12OXKgF2P24UPU8FZK0Oc8_WBMS7mSaIp/view?usp=drivesdk) | 原生实际文件变更；有界横向预览 | I3 |
| 14 | [用量空状态](https://drive.google.com/file/d/13WX5EpSCqxm4PaWdfLqHtFieRd7dYHMD/view?usp=drivesdk) | 当前原生未提供 token 值，如实显示 | I3 |
| 15 | [展开本地筛选](https://drive.google.com/file/d/1IYEwLA1pDdpFait-cgKkgfBzl4pEUBr7/view?usp=drivesdk) | 无匹配状态；只筛选已加载列表 | S2 |
| 16 | [200% 字号对话](https://drive.google.com/file/d/1s7YwmMueHZfkLhCGwIOn6Qn5qjQtDDr0/view?usp=drivesdk) | 发送可达；附件横向滚动 | S1 |
| 17 | [200% 字号导航](https://drive.google.com/file/d/1esh4ZBN6t2QXmP9IjsJlZxF9ZC2bLxqS/view?usp=drivesdk) | 品牌、搜索、关闭与新建可达 | S2 |
| 18 | [200% 字号确认框](https://drive.google.com/file/d/13P9tYe34LYZlfSGmBvsEUXi14jxIG97I/view?usp=drivesdk) | 完整风险文案和确认/取消均可见 | S3 |
| 19 | [横屏 + 200% 字号](https://drive.google.com/file/d/1Osz4ndljqZfeCv_CqQnsS3Qz7pwOgZYN/view?usp=drivesdk) | 可滚动 Inspector；会话和草稿保持 | S1/I2 |
| 20 | [文件与校验后预览](https://drive.google.com/file/d/1TK_qAGiiUVkW_LM8gGrfmRwpUSYSClkF/view?usp=drivesdk) | 真实 Markdown 文件、摘要验证与分享操作 | I1 |
| 21 | [200% 真实原生审批](https://drive.google.com/file/d/1u_9Hm1hihRy9U_aGp9EzijUzSRilakmi/view?usp=drivesdk) | 实际 cancel；保留系统审批通知横幅 | S4 |
| 22 | [上传回执丢失](https://drive.google.com/file/d/1LL3ySAz6tNpdoR5lCVCexPmDRIrJjB85/view?usp=drivesdk) | 附件 unknown、禁止重新上传/发送 | S1/I1 |
| 23 | [Turn 回执丢失](https://drive.google.com/file/d/1bXrovYfUHyg8Z4aLXFErNNlBVBKZiwvu/view?usp=drivesdk) | 原操作待核对、附件认领 held | S1/I1 |
| 24 | [进程重启后的 unknown](https://drive.google.com/file/d/1V8V02xdXEXRapirZeoqaWDUpfH-z8hsO/view?usp=drivesdk) | 原操作及附件保持；未重发 | S1/I1 |
| 25 | [离线草稿](https://drive.google.com/file/d/1R95aT6Z0a5faT2w9NXPr9Q34PA8nIIGs/view?usp=drivesdk) | 缓存可读、草稿可编辑、写入口关闭 | S1 |
| 26 | [重新连接](https://drive.google.com/file/d/1ASZWpKIgGFm1Ial9nVNszya4FbvAVsQH/view?usp=drivesdk) | 恢复原线程和草稿，不自动发送 | S1 |

## Stitch 对照与差异

只读参考根目录：`upgrade/stitch_oraculum_android_workspace/`。S1=`oraculum_2.0_1`；S2=`oraculum_2.0_2`；S3=`oraculum_2.0_3`；S4=`oraculum_2.0_4`；I1/I2/I3=`oraculum_2.0_right_inspector_1/2/3`。每项参考目录的 `code.html`；S1、S3、I1、I3 另有 `screen.png`。7 HTML、4 PNG、DESIGN.md 及正式品牌原件哈希未变。

本轮沿用定稿结构和抹茶气质，以统一 Outlined 本地图标、原创线条 Oracle Eye、语义 Surface、紧凑列表和渐进展开补足 Compose 落地。导航筛选仍仅覆盖已加载列表；主对话保留真实执行与错误；Inspector 不再由裸 UUID 主导。系统字体和原正式 App 图标不变。安全/离线/unknown 状态无单独 Stitch 页，沿用 S1/I1 结构并保留已批准行为。

用量图如实显示原生未返回 token 值；模型图展示实际目录，不表示每个模型都已调用。200% 附件栏和长命令使用横向滚动，横屏 Inspector 使用纵向滚动。真实审批图保留系统通知横幅，实际执行的是取消；它不证明 fileChange 正向批准路径。重启 unknown 图的 TLS 错误提示来自本轮隔离代理断网状态，不曾绕过证书验证。触控及无障碍标签已检查，但没有 TalkBack 实听或物理手机验收。

## PNG SHA-256

以下按原始文件字节计算；Drive 名称、字节数和目标父文件夹另经读取核对。原图没有裁剪、拼接或修饰。

```text
a69fab2090d6c0cc11b1672560750d58fd6444ebc913da2a4ecb27b8517f0748  02-theme-dark.png
f0853601a9bd76e012df14ce6c0d3a8dcf7beeaa1ece3205896881eec5564d6c  02-theme-light.png
345dad0abd52903b95607f5715367d9b0c8ad76e83b47f9c4adcf3f82ba06966  02-theme-oled.png
f87ca349133d2203f468585de323380e40da4c91442ac45e009979b558c8864f  visual-01-navigation-compact.png
41a494e0a53fb7b9f819e8fc9f374df50ee50cdb5d24d6407181e6a79a2ce4b3  visual-14-inspector-settled.png
df67f26a9294d06f8cd953168f575d8464427d08db4d1149faaefeda026832d9  visual-03-settings-appearance.png
3f90a577714c04882a6597e16173f43ba81ae59bfdcf3d5c7fb64e8c45488a85  visual-06-models.png
b53e3e000c171525855a80fc6be7029c0f65efdd75414b41e0f65c23d8fd575c  visual-08-permissions.png
701cca34d531421d08ab636c7df3c3bb6b7cc27e253630d96be0cd10430b4e6b  visual-09-full-access-confirmation.png
9de7aeaec43825670408b1687064161a2b7ab144ff96dc0026532325afe19197  visual-10-native-code-block.png
1a1afdbb0bac72aff8fa58c4a909ea8a674467d9be2f4eb62277ca23d3e3355f  05-native-ime.png
447ac22774f9a90258238013b4cc362d58178ace5712108084be21b814426abc  visual-15-inspector-expanded-id.png
5c02972e0265ba194634c4a4c8c95c4042d622a502918b6160fd233209ce6733  visual-16-native-diff.png
3ab703245708b46793fac1b39f1ad5a4015c30f514bf48db871c4ae1f446e979  visual-17-native-usage.png
4494a609e8d8e02b2247781304be3f657bbe75e5791229bfdbbe99ca66e9ba64  visual-02-navigation-local-filter.png
07855fac362a23eeae86f1ea276eb94fb7f7f5355c80d7b2e7654fde181f266c  visual-11-large-font-conversation.png
a0fd35e576898fa0914d0119c6d13e7e87680c17acfbaefd8baf623fc6dde2b3  visual-12-large-font-navigation.png
bd8bba06658d72d21d574adf2bef7814958ec2c6963b8478e27177ffd2f55b4b  visual-13-large-font-permission-confirmation.png
d2c72adc6e0049ef02b7d08ccbfcfd1d7d4ceca9a39a5b9c42f77f85dcc63935  06-landscape-large-font.png
0b0f4197d972adbf6dcaf534e283684a67655c954c9165214a0d4d4bec20a235  14-verified-host-preview.png
9bf5811b590272e9559e940c23ff41d4f2291aaf62980221352e2c39abf648d0  07-real-native-approval-cancel.png
f89b7c6147a738558c84156bd7d3d756e5e4fced4cc84b2252023bbba7ea263c  16-upload-unknown.png
724996e95d1a420e193c5c13e18911db5a8d60513694175f6392cb7d1505580f  09-unknown-details.png
40813733cb4adf7cb28cb2094209bd47fa93702916f3a53a015cb4a5f110d10b  10-unknown-restored.png
6462d726efe1d961769e8c3660c2328ab22d3f6fc6edf3b536a95e171cdda385  20-offline-draft-readonly.png
35552998422d9646976e5f3ae3ce763aac8433c5f1fb0c5624326f87bfd0120d  21-reconnected-original-thread.png
```
