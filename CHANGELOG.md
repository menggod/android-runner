# Changelog

## 1.2.5

- Android 11+（SDK ≥ 30）使用 `adb install --fastdeploy` 增量安装，只传输 APK 中变化的块，170 MB 的包改几行代码通常只传几 MB
- 增量安装失败时自动回退到全量安装，不影响成功率
- 安装日志输出实际耗时，便于对比增量与全量
- 修复：签名冲突提示中点「取消」后仍然继续启动应用的问题

## 1.2.4

- 扩展更名为 `android-device-runner` / "Android Device Runner"（原 `android-runner` 与 Marketplace 已有扩展同名，无法发布）

## 1.2.3

首个公开版本。

- 活动栏面板：设备列表、模块 / 变体选择、一键「运行到设备」
- 环境自动探测：`adb`、Android SDK、JDK、Gradle 工程根，探测不到才需要改设置
- 命令：编译并安装启动、仅编译、仅安装 APK、仅启动、查看 logcat、环境自检、取消编译
- 状态栏显示设备数量与应用运行状态，按可配置间隔轮询
- 签名不一致 / 版本回退时提示并支持一键卸载重装
- 支持 macOS / Windows / Linux，最低 VS Code 1.70
