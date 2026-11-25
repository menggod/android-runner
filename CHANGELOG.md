# Changelog

## 1.3.0

- 支持多渠道工程（`productFlavors`）：新增 `androidRunner.flavor` 设置与面板「渠道」输入框（下拉候选 + 自由输入，留空自动）
- 渠道识别：静态解析 `build.gradle(.kts)` 的 `productFlavors`（含 `create("x")` 写法），再从已构建的 `outputs/apk/<flavor>/` 反推动态生成的渠道
- 渠道选择优先级：显式设置 → 多维度降级 → 唯一渠道 → `official` → `dev` → 自动取第一个；原则是「总能跑起来」，不会因为渠道有歧义把按钮禁用
- **修复多渠道工程误触发全量构建**：未确定渠道时不再退回无意义的 `assembleDebug`（单维度多渠道会一次编译所有渠道），改为自动选中一个渠道
- **修复多渠道装错包**：指定渠道后只在 `outputs/apk/<flavor>/<variant>/` 下查找 APK，不再回退到无渠道的 `outputs/apk/debug`
- 多维度渠道（两个及以上 `flavorDimensions`）按普通 `assembleDebug` 构建，APK 定位放宽到「任一以变体名结尾的产物」，保证能装上一个包
- Gradle 任务名按 AGP 规则生成：`assemble<Flavor><Variant>`（如 `assembleOfficialDebug`、`assemble_360Debug`）
- 支持 AGP 3.x 的 `output.json` 产物清单
- 签名冲突重装前先用 `pm list packages` 核对设备实际包名，正确处理 `applicationIdSuffix`

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
