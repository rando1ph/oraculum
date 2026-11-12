# Iteration 2｜一加 6T 视觉审阅索引

本轮重点是视觉美观和交互。请先审阅下列原图，再结合功能边界判断是否接受；Phase 3 与本任务保持 **In progress**。

推荐先看：[空状态](https://drive.google.com/file/d/166m7dMZd465X8AX8r1UqAbLJAAunx_pJ/view?usp=drivesdk) · [主对话](https://drive.google.com/file/d/1r6o_1nBVdBttnBZBjv7xPGem0VHY7K0H/view?usp=drivesdk) · [＋菜单](https://drive.google.com/file/d/1Zt1ArwgWUZbqLF2iUdJ5vvppD73DIJ5f/view?usp=drivesdk) · [浅色](https://drive.google.com/file/d/1lAESjOfEXf-rzTZD6XaDjsCdj7-P4_5l/view?usp=drivesdk) · [深色](https://drive.google.com/file/d/1F1JGg6i3KwszWUPVzvnBanZO-SndXe36/view?usp=drivesdk) · [OLED](https://drive.google.com/file/d/1-fvIrczS6WYxpFNX_UHpnLEZpBlOLh-K/view?usp=drivesdk) · [头像](https://drive.google.com/file/d/1S8lXPtVfWruAfR2ymGAFV4cYkkt8RdKk/view?usp=drivesdk) · [模型与强度](https://drive.google.com/file/d/1onNNC1mZhWn5i1b7TNAKkvMKXiedXBpr/view?usp=drivesdk)。

所有 PNG 均来自 ADB 现场确认的一加 6T（`e5ee4f28`，ONEPLUS A6013，Android 15 / API 35，1080×2340、font scale 1.0；横屏为 2340×1080），没有拼接、修图或以模拟器代替。实际安装产品源码为 `7c37855f1ebf67bcad75fcba0793b54c68f7b870`，APK SHA 与下载见 [ARTIFACTS.md](ARTIFACTS.md)。专用线程中的英文提示及蓝色头像为非敏感测试输入；模型回复、时间、耗时、用量和审批均来自真实 Gateway/Codex。

## 原图

| 图像 | 审阅内容与实际边界 |
| --- | --- |
| [i2-01-native-empty-state.png](https://drive.google.com/file/d/166m7dMZd465X8AX8r1UqAbLJAAunx_pJ/view?usp=drivesdk) | 空状态；完整 Oracle Eye、标题与引导。 |
| [i2-02-native-conversation.png](https://drive.google.com/file/d/1r6o_1nBVdBttnBZBjv7xPGem0VHY7K0H/view?usp=drivesdk) | 真实 Codex 答复；紧凑标志、消息时间、原生耗时和在线用量。 |
| [i2-03-settings-dark.png](https://drive.google.com/file/d/1F1JGg6i3KwszWUPVzvnBanZO-SndXe36/view?usp=drivesdk) | Dark；普通宽度主题选项单行。 |
| [i2-03-settings-light.png](https://drive.google.com/file/d/1lAESjOfEXf-rzTZD6XaDjsCdj7-P4_5l/view?usp=drivesdk) | Light；三主题同组、强调色与身份。 |
| [i2-03-settings-oled.png](https://drive.google.com/file/d/1-fvIrczS6WYxpFNX_UHpnLEZpBlOLh-K/view?usp=drivesdk) | OLED Dark；纯黑外背景。 |
| [i2-04-settings-accent.png](https://drive.google.com/file/d/1AGBCmfBRLOFA0ZOGRivYwJuwkKY9pr3R/view?usp=drivesdk) | 海蓝强调色，保留统一组件与对比度。 |
| [i2-05-settings-identity.png](https://drive.google.com/file/d/1JcAfek1FHaZdJls9TX72M0GdwZh-H4jr/view?usp=drivesdk) | 昵称与本机身份关联。 |
| [i2-06-settings-notifications.png](https://drive.google.com/file/d/1tyUwwmqF4Tt5IJBkssh-wxfA6y6UW49J/view?usp=drivesdk) | 通知入口；使用现有系统授权。 |
| [i2-07-gateway-storage.png](https://drive.google.com/file/d/1pcMYoZVTMdy62BtLsz5FXpOb0E6hD6J0/view?usp=drivesdk) | 连接/重连/刷新；存储与修复入口。 |
| [i2-08-cache-confirmation.png](https://drive.google.com/file/d/1s1GZh_iCRUai5F5ZsAb52u-uaDGwVCq_/view?usp=drivesdk) | 缓存范围确认；实际取消，没有清除缓存。 |
| [i2-09-composer-actions.png](https://drive.google.com/file/d/1Zt1ArwgWUZbqLF2iUdJ5vvppD73DIJ5f/view?usp=drivesdk) | 「+」真实菜单：附件、项目文件、项目/会话。 |
| [i2-10-composer-project-files.png](https://drive.google.com/file/d/1HKzFi1YK6nEXUoJQ7HJ1nLj-8Dapg0bH/view?usp=drivesdk) | 真实授权测试项目文件；未显示私人目录。 |
| [i2-11-model-effort-sheet.png](https://drive.google.com/file/d/1pXVwPasaq16Xf1N0Wu00w7HdBFV_rLu9/view?usp=drivesdk) | 无显式模型选择时的原生模型目录 BottomSheet。 |
| [i2-12-model-catalog.png](https://drive.google.com/file/d/1ZPJS_l5ZEE-h-cJOrNkNzUYrda7guC6-/view?usp=drivesdk) | 展开原生支持的模型目录。 |
| [i2-13-permission-sheet.png](https://drive.google.com/file/d/1cWIzb7yqqvXZWLHdLFOi706KzjUeK1Za/view?usp=drivesdk) | 下次执行权限；系统返回可用。 |
| [i2-14-full-access-confirmation.png](https://drive.google.com/file/d/13Thoto3c8epnhzGShAs6n0zo_MMDpxN7/view?usp=drivesdk) | Full access 确认；实际取消，没有授权。 |
| [i2-15-mcp-capabilities.png](https://drive.google.com/file/d/1LX0bGFMz2kJuSkWT9Z-qQQz-sgfGWP4l/view?usp=drivesdk) | MCP 读取不可用的真实降级；Skills 实际目录。 |
| [i2-16-native-usage-live-values.png](https://drive.google.com/file/d/1CguSpUtMc1CmVyMH2m9Pa_bp7UbYYbNt/view?usp=drivesdk) | 先前在线原图：24,143 tokens，13,056 缓存输入，真实比例。 |
| [i2-16-native-usage.png](https://drive.google.com/file/d/1osXRgf4bOBe8zp6o96nD8M0qtO4ehQOG/view?usp=drivesdk) | 重读历史后用量缺失的真实降级，不补造百分比。 |
| [i2-17-custom-avatar.png](https://drive.google.com/file/d/1S8lXPtVfWruAfR2ymGAFV4cYkkt8RdKk/view?usp=drivesdk) | SAF 导入专用蓝色测试 PNG 后的私有头像预览。 |
| [i2-18-avatar-conversation.png](https://drive.google.com/file/d/1enoMBv0kTb20A9ViK4CQfc-0kbVRNLwl/view?usp=drivesdk) | 同一私有头像与昵称关联到消息；不是 Gateway 附件。 |
| [i2-19-turn-completed-collapsed.png](https://drive.google.com/file/d/1dcDS09xtZJW19JHivNU2m2w_-5FUK_8U/view?usp=drivesdk) | 原生 Turn 完成后过程收起，最终答复可见。 |
| [i2-20-turn-process-expanded.png](https://drive.google.com/file/d/1pFzT6Mpzij7fMDiuAWEkd-DoxwUlDpqf/view?usp=drivesdk) | 展开过程组，逐项思考/命令记录可继续展开。 |
| [i2-21-final-answer-visible.png](https://drive.google.com/file/d/1ivo7F_T53AEnW9L1wMKEyE1GGYnNC_DV/view?usp=drivesdk) | 再次收起后最终答复仍可见。 |
| [i2-22-real-native-approval.png](https://drive.google.com/file/d/1worrLf3jVEGnpKEmr-HllBVX3Co9QSnd/view?usp=drivesdk) | 真实命令审批及本应用通知；实际取消，目标文件未写入。 |
| [i2-25-native-ime.png](https://drive.google.com/file/d/1usgYs3qVX2qTtVdT_UyigRBCAOLSvHv4/view?usp=drivesdk) | 真机输入法；输入框和发送入口可见。 |
| [i2-26-landscape.png](https://drive.google.com/file/d/1gLErBLKKNZJLFd7StAab_EsH26cqs7VW/view?usp=drivesdk) | 稳定横屏原图；草稿和所选会话保留。 |
| [i2-27-real-attachment-ready.png](https://drive.google.com/file/d/1iSz4M2Q09k_W5QPxf5PNQVCamHek6qID/view?usp=drivesdk) | 真实 SAF 文本附件已上传，可移除；没有重复上传。 |
| [i2-28-unknown-write-held.png](https://drive.google.com/file/d/1yg59LLSpHBn-86b3pMxy2UlnES-jJv7I/view?usp=drivesdk) | 请求期间断连；原草稿、unknown 和 held 附件保留。 |
| [i2-29-unknown-process-restored.png](https://drive.google.com/file/d/1Tk5daByiVjaxirifmD0CpCVBxpf9BPy4/view?usp=drivesdk) | 进程重启仍保护同一未知写入；传输中断被现有提示泛化为 TLS 错误。 |
| [i2-30-unrecorded-receipt-protected.png](https://drive.google.com/file/d/1M4xqdZa54XZPx_9hsqfltCIkbD0xZAk7/view?usp=drivesdk) | 在线查询原回执仍 404，继续保护；不是 accepted 恢复成功。 |
| [i2-31-background-notification-routed.png](https://drive.google.com/file/d/1UadSr62qzMZ8HzAr6t4qFeo8oL5vHLzH/view?usp=drivesdk) | Home 后真实通知 PendingIntent 回到对应会话 Inspector。 |
| [i2-32-model-effort-selected.png](https://drive.google.com/file/d/1onNNC1mZhWn5i1b7TNAKkvMKXiedXBpr/view?usp=drivesdk) | 实际原生模型与支持的 low effort 同屏；仅设置下次执行。 |

## 尚需独立审阅的限制

- 当前 MCP 目录不可读取，账户额度没有已开放契约；用量只在原生返回时显示。原图 16 保留“在线有数值”和“历史重读无数值”两种真实状态。
- 完成摘要中“最近用量”不是整轮累计总量；无数据时不显示伪造数字。头像导入后已恢复原设置，原正式 Launcher/启动图标未改动。
- unknown 注入过早切断转发，Gateway 没有原回执；已证明断连/重启/重连后原草稿、附件和 UUID 保留、没有重发。**真实 accepted 回执恢复没有得到本次真机证明**，一条专用测试 unknown 仍被保留并阻止该线程写入及同项目新建。图 30 不能被当作恢复成功图。详细经过见 [RECONCILIATION.md](RECONCILIATION.md)。普通离线草稿改写阶段未继续，避免覆盖这条未知操作的原草稿，因此没有图 23/24。
- 通知已验证实际 Home、同一存活进程和真实 PendingIntent 回跳；没有宣称强制停止或进程死亡后继续投递。真实命令审批已取消；本轮没有新增真机 fileChange 全 Diff 批准场景。
- 原图 29 的 TLS 提示来自连接在握手期间被测试代理切断，不代表证书被修改。中途测试框架/截图时机失败保留在报告中，不计作通过结果。

逐图大小、SHA-256 和链接保存在 [visual-manifest.json](visual-manifest.json)。原始用户八张反馈、Iteration 1 及原 SVG 均保留。[工程与设备交付报告](README.md)。
