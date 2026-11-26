# Android Device Runner

在 VSCode 左侧边栏里替代「切到 Android Studio → 确认设备 → 点运行」这一整套动作：**一个面板看设备、编译、安装、启动、投屏、看日志**。

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
│ 渠道 [official ▾]            │
│ work.notto.android           │
│       ▶ 运行到设备           │
│       编译 → 安装 → 启动      │
│                              │
│ 常用操作            构建输出 │
│  编译       │ 安装 APK       │
│  重启应用   │ 设备日志       │
│  停止应用   │ 投屏           │
│  环境自检                    │
│ ✓ 编译 → ✓ 安装 → ✓ 启动    │
│ 已安装并启动           13 秒 │
│ app-debug.apk        17.5 MB │
│ ▸ 构建环境            已识别 │
│ ▸ 应用管理                   │
│ menggod              v1.5.0 │
└──────────────────────────────┘
```

界面跟随 VS Code 主题，支持浅色、深色、高对比度主题和窄侧栏。活动栏使用「N + 运行箭头」单色图标，扩展主图标使用相同图形的品牌彩色版本。

- 面板内直接选择应用模块、渠道（`productFlavors`）与 Debug / Release，配置写入当前工作区文件夹。下方同步显示实际 Gradle 任务与包名；当前已有的自定义变体也会保留在下拉框中。
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
| 投屏 | 用 scrcpy 打开手机实时画面窗口，可用鼠标键盘操作（需先安装 scrcpy） |
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

## 投屏

面板「投屏」按钮会在电脑上显示手机画面并可直接操作：点击、滑动、滚轮、常用按键。等价命令：`Android: 投屏到电脑 (scrcpy)`；内嵌面板单独用命令 `Android: 投屏（内嵌面板 · 实验）` 触发。

两种模式，由 `androidRunner.mirrorMode` 控制：

| 模式 | 依赖 | 说明 |
|---|---|---|
| `window`（默认） | 需本机安装 scrcpy | 外部 scrcpy 窗口，与 Android Studio 的设备镜像同为 scrcpy 内核；画质、延迟、音频最好，最稳 |
| `panel` | 无 | 画面嵌在 VSCode 面板里的实验路径，扩展自带 scrcpy server，零安装 |
| `auto` | — | 优先内嵌，解码不可用时自动回退到外部窗口 |

### 内嵌模式（panel）

- **零安装（实验）**：`bin/scrcpy-server` 随插件分发，投屏时自动推送到设备并启动，不依赖本机安装 scrcpy。该路径仍在打磨，画面异常时把 `androidRunner.mirrorMode` 切回 `window` 即可。
- 用 WebCodecs 硬解 H.264；解码器的 codec 参数从码流 SPS 推导，不同机型的 profile / level 都适配，不硬编码。
- 暂不支持音频、剪贴板同步和文件拖拽；画面延迟略高于原生 scrcpy。
- 侧栏隐藏或面板切走时自动暂停解码，回来时重新请求关键帧。

### 外部窗口模式（window）

- 依赖开源工具 [scrcpy](https://github.com/Genymobile/scrcpy)，需要单独安装：
  - macOS：`brew install scrcpy`
  - Windows：`winget install --id Genymobile.scrcpy -e`
  - Ubuntu：`sudo apt install scrcpy`

  未安装时点击「投屏」会提示安装命令，可直接复制到终端执行，无需查文档。
- 找不到 scrcpy 时按「设置项 → `PATH` → Homebrew / 常见安装目录」顺序探测；装在非常规位置时用 `androidRunner.scrcpyPath` 指定。
- 启动参数为 `-s <序列号> --window-title <型号 (序列号)>` + `androidRunner.scrcpyArgs`（默认 `--stay-awake`，投屏期间保持设备唤醒；改成空数组即用 scrcpy 默认行为）。
- 插件探测到的 adb 路径会通过 `ADB` 环境变量传给 scrcpy，SDK 不在默认位置也能用。
- 每台设备只开一个窗口，重复点击会提示已打开；关闭窗口即可释放。

## 多渠道工程（productFlavors）

原则是「总能跑起来」：识别有歧义时给一个可执行的默认值，而不是把操作禁掉。

渠道取值优先级：

1. 显式设置（`androidRunner.flavor` 或面板「渠道」输入框）；
2. 多维度渠道（两个及以上 `flavorDimensions`）→ 组合名无法静态推断，按普通 `assembleDebug` 构建；
3. 只识别到一个渠道 → 用它；
4. 识别到 `official` → 用它，其次是 `dev`；
5. 识别到多个渠道且都没有 `official` / `dev` → 自动取第一个，面板会提示已默认使用哪个。

- **识别来源**：模块 `build.gradle(.kts)` 的 `productFlavors { ... }`（支持 `official { }` 与 `create("official")`），以及已构建过的 `build/outputs/apk/<flavor>/` 目录。循环生成的动态渠道在首次构建前无法静态列出，手填一次即可——选择按工程写入工作区设置。
- **任务名**：`assemble<Flavor><Variant>`，如 `assembleOfficialDebug`、`assembleBaiduDebug`、`assemble_360Debug`（下划线保留，不做清洗）。
- **APK 定位**：指定渠道后只在 `outputs/apk/<flavor>/<variant>/` 及其子目录里找，**不会**回退到无渠道的 `outputs/apk/debug`——那是旧包，装上会掩盖真实的定位失败。多维度构建时会接受任一以变体名结尾的产物（取最新），保证能装上一个包。
- **卸载重装**：签名冲突时先用 `pm list packages` 核对设备上的实际包名，`applicationIdSuffix` 的渠道包会卸载正确的那个。

## 自动探测（正常情况下无需配置）

| 项 | 探测顺序 |
|---|---|
| 工程根目录 | 从工作区目录向上最多 6 层寻找 `gradlew` |
| adb | 设置项 → `local.properties` 的 `sdk.dir` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → `~/Library/Android/sdk` 等常见目录 → `PATH` |
| Android SDK | `local.properties` → `ANDROID_HOME` → `ANDROID_SDK_ROOT` → 常见目录 |
| JAVA_HOME | 设置项 → `.idea/gradle.xml` 的 `gradleJvm`（支持 Android Studio 自带 JBR）→ `JAVA_HOME` → `/usr/libexec/java_home` |
| 包名 | 设置项 → 匹配当前渠道 + 变体的 APK `output-metadata.json` / `output.json` → `<module>/build.gradle(.kts)` 的 `applicationId` |
| Gradle 渠道 | 设置项 → `productFlavors` 静态解析 → 已构建产物目录反推 → 都没有则不使用渠道 |
| Gradle 任务 | 设置项 → `:<module>:assemble<Flavor><Variant>` |
| APK | 设置项 → 匹配渠道 + 变体的 `output-metadata.json`（优先无过滤的通用 APK）→ `output.json`（AGP 3.x）→ `<module>/build/outputs/apk/<flavor>/<variant>/` 下最新的 apk |
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
| `androidRunner.flavor` | 空 | 渠道名（`productFlavors`），留空自动判断 |
| `androidRunner.buildVariant` | `debug` | `debug` / `release` |
| `androidRunner.gradleTask` | 空 | 留空自动为 `:<module>:assemble<Flavor><Variant>` |
| `androidRunner.extraGradleArgs` | `[]` | 追加参数，如 `["-Papi_env=prod"]` |
| `androidRunner.apkPath` | 空 | 留空自动查找 |
| `androidRunner.applicationId` | 空 | 留空自动读取 |
| `androidRunner.adbPath` | 空 | 留空自动探测 |
| `androidRunner.scrcpyPath` | 空 | 投屏用的 scrcpy 路径，留空自动探测 |
| `androidRunner.scrcpyArgs` | `["--stay-awake"]` | 追加给 scrcpy 的参数 |
| `androidRunner.mirrorMode` | `window` | `window`（外部 scrcpy 窗口，推荐）/ `panel`（内嵌，实验性）/ `auto` |
| `androidRunner.javaHome` | 空 | 留空自动探测 |
| `androidRunner.autoCreateLocalProperties` | `true` | 缺 `local.properties` 时自动生成 |
| `androidRunner.pollIntervalMs` | `10000` | 面板与状态栏的设备刷新间隔（3–60 秒） |

## 命令面板

面板按钮都有对应的命令，需要时可在命令面板执行：`Android: 运行到设备`、`Android: 仅编译`、`Android: 运行环境自检` 等。投屏另有 `Android: 投屏到电脑 (scrcpy)`（外部窗口）与 `Android: 投屏（内嵌面板 · 实验）`。**没有绑定任何快捷键。**

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

**会执行的外部命令**：项目自带的 `gradlew`，SDK 中的 `adb` 与 `emulator`。投屏时还会执行本机安装的 `scrcpy`（`window` 模式）；`panel` 模式不依赖本机 scrcpy，而是把扩展自带的 `bin/scrcpy-server` 推送到设备并在设备上运行。

**会修改的设备状态**：安装、启动、停止应用；投屏会把 `scrcpy-server` 写入设备的 `/data/local/tmp/` 并启动该进程，关闭投屏时结束该进程并移除端口转发；「清数据」与「卸载」属于破坏性操作，执行前一律弹确认框。

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
extension.js    主逻辑（环境探测、设备、编译、安装、启动、投屏入口）
webview.js      侧边栏容器与 HTML 外壳
operation.js    实际命令阶段、结果与耗时
project-info.js 模块、渠道、APK 元信息探测
mirror.js       外部 scrcpy 窗口的探测与启动
mirror/         内嵌投屏（scrcpy 协议、控制消息、H.264 参数、面板）
media/view.js   面板前端交互
media/view.css  面板样式（跟随 VSCode 主题）
media/mirror-player.js  内嵌投屏的 WebCodecs 渲染与输入
media/mirror.css        内嵌投屏样式
media/icons.js  共用线性图标
media/icon.svg  活动栏 N + 运行箭头图标
media/brand-icon.svg  扩展主图标矢量源文件
bin/            scrcpy-server 及其 Apache 2.0 许可证
test/           状态、协议与宿主回归检查
icon.png        扩展主图标（128 × 128）
LICENSE         MIT 许可证
```

## 许可证

MIT © menggod（完整文本见扩展包内 `LICENSE` 文件）

## 第三方组件

- [scrcpy](https://github.com/Genymobile/scrcpy) — Apache License 2.0。扩展包内的 `bin/scrcpy-server`（v5.0.1）是它的 Android 端服务端，用于投屏；许可证全文见 `bin/scrcpy-server.LICENSE`。凡是使用了投屏功能，就会把该文件推送到设备并在设备上运行。

发布到 VSCode Marketplace 时，把 `package.json` 与 `build.sh` 里的 `publisher` 换成自己已注册的发布者 ID。
