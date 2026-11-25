# Android Device Runner

在 VSCode 左侧边栏里替代「切到 Android Studio → 确认设备 → 点运行」这一整套动作：**一个面板看设备、编译、安装、启动、看日志**。

不绑定任何具体项目：Gradle 工程根目录、adb、Android SDK、JDK、模块、包名、APK 路径都会自动探测，只有探测不到时才需要改设置项。

- 扩展 ID：`notto-work.android-device-runner`
- 最低 VSCode：1.70
- 支持 macOS / Windows / Linux

## 安装

已发布到 VS Code Marketplace，在编辑器扩展面板搜 **Android Device Runner** 即可，或命令行：

```bash
code --install-extension notto-work.android-device-runner
```

也可以从 [Releases](https://github.com/menggod/android-runner/releases) 下载 `.vsix` 离线安装：

```bash
code --install-extension android-device-runner-<版本>.vsix
```

或在 VSCode 里：`扩展` → 右上角 `...` → **从 VSIX 安装** → 选择文件 → 执行 `Developer: Reload Window`。

## 界面

安装后左侧活动栏会多一个 Android Runner 图标，点开即用，不需要任何快捷键。

```text
┌──────────────────────────────┐
│ N▶  Android Runner         ⟳ │
│     by menggod              │
│                              │
│ 目标设备          2 台已连接 │
│ ┌──────────────────────────┐ │
│ │ 设备型号               ▾ │ │
│ │ 真机 / Android 15        │ │
│ │ 序列号        ● 应用运行中│ │
│ └──────────────────────────┘ │
│ 模块 [app ▾]  变体 [Debug ▾] │
│ work.notto.android           │
│       ▶ 运行到设备           │
│       编译 → 安装 → 启动      │
│                              │
│ 常用操作            构建输出 │
│  编译       │ 安装 APK       │
│  重启应用   │ 设备日志       │
│  停止应用   │ 环境自检       │
│                              │
│ ✓ 编译 → ✓ 安装 → ✓ 启动    │
│ 已安装并启动           13 秒 │
│ app-debug.apk        17.5 MB │
│ ▸ 构建环境            已识别 │
│ ▸ 应用管理                   │
│ menggod              v1.2.5 │
└──────────────────────────────┘
```

界面跟随 VS Code 主题，支持浅色、深色、高对比度主题和窄侧栏。活动栏使用「N + 运行箭头」单色图标，扩展主图标使用相同图形的品牌彩色版本。

- 面板内直接选择应用模块与 Debug / Release，配置写入当前工作区文件夹。下方同步显示实际 Gradle 任务与包名；当前已有的自定义变体也会保留在下拉框中。
- 模块从 settings.gradle(.kts) 与应用 build.gradle(.kts) 静态识别，支持常见嵌套模块和 projectDir 映射；通过自定义 Gradle 插件动态生成的模块，请在扩展设置中指定。
- 若显式固定了 Gradle 任务、APK 路径或包名，面板会说明固定项并锁定配置切换，提供设置入口，避免选择与实际执行内容不一致。
- 点击设备卡片选择设备；支持键盘 Tab / Enter 操作，Esc 收起列表。
- 「构建环境」集中展示 SDK、JDK、Gradle、任务、包名和 APK；长路径悬停可查看完整内容，也可直接打开扩展设置。
- 「应用管理」折叠收纳清数据与卸载，执行前仍会弹出原有确认框。
- 折叠状态会保留；运行任务按真实命令显示编译、安装、启动阶段和各阶段耗时，失败或取消会停在对应阶段并提供详细输出入口。进行中锁定配置与重复操作，不推测完成百分比。
- APK 区展示文件名、文件时间和大小，悬停查看完整路径；单独安装成功后可直接启动应用。

### 按钮说明

| 按钮 | 行为 |
|---|---|
| 运行到设备 | 编译 → 安装（保留数据）→ 启动 |
| 停止 | `am force-stop` 当前应用 |
| 重启 | 先停应用再冷启动，不重新编译 |
| 编译 | 只跑 Gradle 任务，不需要连接设备 |
| 日志 | 新开终端跑 logcat（默认只过滤本应用进程） |
| 安装 | 用已有 APK 重装，不重新编译 |
| 卸载 | **弹确认框**，卸载后设备上的应用数据一并清除 |
| 清数据 | **弹确认框**，执行 `pm clear`，登录态等本地数据会丢失 |
| 自检 | 在输出面板打印 SDK / JDK / adb / Gradle / 设备 / AVD 的完整探测结果 |
| 构建输出 | 打开 Android Runner 输出面板 |
| 取消 | 编译中才出现，终止当前 Gradle 进程 |

### 设备区

- 显示真实型号、序列号、Android 版本、真机/模拟器，以及应用是否正在运行。
- 点击卡片展开完整列表：已连接设备、未授权/离线设备、本机已创建的 AVD 模拟器。
- 设备选择按工程根目录保存在 VS Code workspaceState，重载后继续使用；目标断开时不会自动切到另一台设备，重连后恢复选择。
- 选中 AVD 会启动或复用同名模拟器，面板显示等待状态；同时校验 AVD 名称与 Android `sys.boot_completed=1` 后切换目标，不会误选等待期间新接入的 USB 设备。最多等待 180 秒，可在 VS Code 进度通知中取消等待。

## 自动探测（正常情况下无需配置）

| 项 | 探测顺序 |
|---|---|
| 工程根目录 | 从工作区目录向上最多 6 层寻找 `gradlew` |
| adb | 设置项 → `local.properties` 的 `sdk.dir` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → `~/Library/Android/sdk` 等常见目录 → `PATH` |
| Android SDK | `local.properties` → `ANDROID_HOME` → `ANDROID_SDK_ROOT` → 常见目录 |
| JAVA_HOME | 设置项 → `.idea/gradle.xml` 的 `gradleJvm`（支持 Android Studio 自带 JBR）→ `JAVA_HOME` → `/usr/libexec/java_home` |
| 包名 | 设置项 → 匹配当前变体的 APK `output-metadata.json` → `<module>/build.gradle(.kts)` 的 `applicationId` |
| Gradle 任务 | 设置项 → `:<module>:assemble<Variant>` |
| APK | 设置项 → 匹配变体的 `output-metadata.json`（优先无过滤的通用 APK）→ `<module>/build/outputs/apk/<variant>/` 下最新的 apk |
| 设备 | `adb devices -l`，解析状态、型号、Android 版本、真机/模拟器 |
| 模拟器 | `<SDK>/emulator -list-avds` |

额外自动化：

- `gradlew` 缺执行权限时自动 `chmod +x`；
- 缺 `local.properties` 时按探测到的 SDK 自动生成（该文件通常已在 `.gitignore` 中）；
- 编译时把 `JAVA_HOME` / `ANDROID_HOME` / `ANDROID_SERIAL` 注入 Gradle 进程，避免与 Android Studio 的环境不一致；
- **Android 11+ 使用 `adb install --fastdeploy` 增量安装**，只传输 APK 中变化的块（170 MB 的包改几行代码后通常只传几 MB）；失败会自动回退到全量安装；
- 安装遇到签名不一致 / 版本回退时，询问后可一键卸载重装。

## 设置项

`设置 → Android Runner`，默认值适配通用场景，一般不用改：

| 设置 | 默认 | 说明 |
|---|---|---|
| `androidRunner.module` | `app` | 构建模块 |
| `androidRunner.buildVariant` | `debug` | `debug` / `release` |
| `androidRunner.gradleTask` | 空 | 留空自动为 `:<module>:assemble<Variant>` |
| `androidRunner.extraGradleArgs` | `[]` | 追加参数，如 `["-Papi_env=prod"]` |
| `androidRunner.apkPath` | 空 | 留空自动查找 |
| `androidRunner.applicationId` | 空 | 留空自动读取 |
| `androidRunner.adbPath` | 空 | 留空自动探测 |
| `androidRunner.javaHome` | 空 | 留空自动探测 |
| `androidRunner.autoCreateLocalProperties` | `true` | 缺 `local.properties` 时自动生成 |
| `androidRunner.pollIntervalMs` | `10000` | 面板与状态栏的设备刷新间隔（3–60 秒） |

## 命令面板

面板按钮都有对应的命令，需要时可在命令面板执行：`Android: 运行到设备`、`Android: 仅编译`、`Android: 运行环境自检` 等。**没有绑定任何快捷键。**

## 隐私与权限

**不联网。** 扩展不发起任何网络请求，不收集、不上报任何数据，也没有遥测。所有逻辑都在本机通过 `adb` 和项目自带的 `gradlew` 完成。

**只读的文件**（用于自动探测）：

- `local.properties`、`.idea/gradle.xml` —— SDK 路径与 Gradle JDK
- `settings.gradle(.kts)`、`build.gradle(.kts)` —— 模块、变体、包名
- `gradle/wrapper/gradle-wrapper.properties` —— Gradle 版本
- `build/outputs/apk/**` —— 定位产物 APK

**会修改的文件**，仅两处：

- `gradlew` 缺少执行权限时补 `chmod +x`
- 缺少 `local.properties` 时写入 `sdk.dir`（可用 `androidRunner.autoCreateLocalProperties` 关闭；该文件通常已在 `.gitignore` 中）

**会执行的外部命令**：项目自带的 `gradlew`，SDK 中的 `adb` 与 `emulator`。

**会修改的设备状态**：安装、启动、停止应用；「清数据」与「卸载」属于破坏性操作，执行前一律弹确认框。

## 常见问题

- **面板显示「未连接设备」**：会区分「未检测到设备」「未授权（请在手机上点允许 USB 调试）」「offline（拔插 USB 或 `adb kill-server`）」。
- **编译失败**：输出面板「Android Runner」有完整 Gradle 日志，报错行可直接点击跳转。
- **和 Android Studio 同时构建**：两边共用 `~/.gradle` 的 daemon，通常没问题；卡住时点「取消编译」。
- **改完代码没有生效**：确认设备区是目标设备；安装日志会打印所用 APK 的构建时间与大小。

## 开发与打包

```bash
npm test                # 运行状态与宿主逻辑回归检查
bash build.sh            # 只打包，输出 android-device-runner-<版本>.vsix
bash build.sh --install  # 打包并覆盖安装到本机 VSCode
```

改完源码执行上面命令，再 `Developer: Reload Window` 生效。

文件结构：

```
extension.js    主逻辑（环境探测、设备、编译、安装、启动）
webview.js      侧边栏容器与 HTML 外壳
operation.js    实际命令阶段、结果与耗时
project-info.js 模块、APK 元信息探测
test/           状态与宿主回归检查
media/view.js   面板前端交互
media/view.css  面板样式（跟随 VSCode 主题）
media/icons.js  共用线性图标
media/icon.svg  活动栏 N + 运行箭头图标
media/brand-icon.svg  扩展主图标矢量源文件
icon.png        扩展主图标（128 × 128）
LICENSE         MIT 许可证
```

## 许可证

MIT © menggod（完整文本见扩展包内 `LICENSE` 文件）

发布到 VSCode Marketplace 时，把 `package.json` 与 `build.sh` 里的 `publisher` 换成自己已注册的发布者 ID。
