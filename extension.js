'use strict';

/**
 * Android Runner —— 在 VSCode 内完成「检查设备 → 探测环境 → 编译 → 安装 → 启动」。
 *
 * 设计原则：
 *  1. 零配置优先：adb / SDK / JDK / 模块 / 包名 / APK 全部自动探测，探测失败才回落到设置项。
 *  2. 不重复造轮子：编译走项目自己的 gradlew，安装/启动走 adb。
 *  3. 任何一步失败都要把原因写进输出面板，并给出可执行的修复建议。
 */

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RunnerViewProvider } = require('./webview.js');
const { OperationTracker } = require('./operation');
const { discoverModules, moduleDirectory, discoverFlavors, findApk, apkInfo } = require('./project-info');
const mirror = require('./mirror.js');
const { ScrcpySession } = require('./mirror/scrcpy.js');
const { MirrorPanel } = require('./mirror/panel.js');

const CFG = 'androidRunner';

// 用于状态栏 tooltip，方便区分同时存在的旧实例
const VERSION = (() => {
  try {
    return require('./package.json').version;
  } catch (e) {
    return '';
  }
})();

let output;
let statusItem;
let pollTimer = null;
let currentProc = null;
let refreshing = false;

const cache = {
  root: undefined,
  adb: null,
  javaHome: undefined,
  pkg: undefined,
  serial: null
};

/** adb 的 model 字段会把空格写成下划线，这里用设备自己上报的型号做展示。 */
const modelCache = new Map();
const androidCache = new Map();

let viewProvider = null;
let building = false;
let buildTask = '';
let lastBuild = null;
let refreshQueued = false;
let avdCache = { list: [], at: 0 };
let extensionContext;
let activeConfiguration = null;
let configuring = false;
let buildCancelled = false;
let avdStartup = null;
const operations = new OperationTracker(publishRuntime);
const configurationKeys = ['module', 'flavor', 'buildVariant', 'gradleTask', 'extraGradleArgs', 'apkPath', 'applicationId', 'adbPath', 'javaHome', 'autoCreateLocalProperties', 'pollIntervalMs'];

function configurationResource() {
  const folders = vscode.workspace.workspaceFolders || [];
  const root = projectRoot();
  const folder = folders.find((item) => item.uri.fsPath === root || (root && item.uri.fsPath.startsWith(root + path.sep))) || folders[0];
  return folder && folder.uri;
}

function configurationKey() {
  return [projectRoot(), cfg().get('module') || 'app', cfg().get('flavor') || '', cfg().get('buildVariant') || 'debug', cfg().get('gradleTask') || '', cfg().get('apkPath') || '', cfg().get('applicationId') || ''].join('|');
}

/** 极简运行环境可能没有 workspaceState，统一在这里兜底，避免各处重复判断。 */
function workspaceStateStore() {
  const state = extensionContext && extensionContext.workspaceState;
  return state && typeof state.get === 'function' && typeof state.update === 'function' ? state : null;
}

function devicePreference() {
  const store = workspaceStateStore();
  if (!store) {
    return null;
  }
  const all = store.get('devicesByProject', {});
  return (all && all[projectRoot()]) || null;
}

async function rememberDevice(device) {
  cache.serial = device.serial;
  const store = workspaceStateStore();
  if (!store || !projectRoot()) {
    return;
  }
  const all = Object.assign({}, store.get('devicesByProject', {}));
  all[projectRoot()] = { serial: device.serial, model: device.model || device.serial };
  await store.update('devicesByProject', all);
}

function currentDevice(ready) {
  const preferred = devicePreference();
  return preferred ? ready.find((device) => device.serial === preferred.serial) || null
    : ready.find((device) => device.serial === cache.serial) || ready[0] || null;
}

function runtimeState() {
  return { operation: operations.snapshot(), avdStartup: avdStartup && Object.assign({}, avdStartup), building, buildTask, lastBuild };
}

function publishRuntime() {
  if (viewProvider) viewProvider.postRuntime(runtimeState());
}

function isBusy() { return operations.busy || building || configuring || !!avdStartup; }

async function withOperation(kind, steps, body) {
  if (isBusy()) {
    vscode.window.showWarningMessage('已有任务正在进行，请等待完成。');
    return;
  }
  const root = projectRoot();
  const config = cfg();
  const values = Object.fromEntries(configurationKeys.map((key) => [key, config.get(key)]));
  activeConfiguration = { root, get: (key) => values[key] };
  try {
    return await operations.run(kind, steps, body, { configKey: configurationKey(), packageName: resolvePackage() || '' });
  } finally {
    activeConfiguration = null;
    resetCache();
    publishRuntime();
    await updateStatusBar();
  }
}

function attachOperationDevice(device, operation) {
  operation.deviceSerial = device.serial;
  operation.deviceLabel = device.model || device.serial;
  publishRuntime();
}

async function updateBuildConfiguration(msg) {
  if (isBusy()) throw new Error('任务进行中，暂时不能切换构建配置。');
  if (!projectRoot()) throw new Error('请先打开 Android 工程。');
  const info = buildConfiguration();
  if (info.locked) throw new Error('当前使用固定配置，请先在扩展设置中调整。');
  let value = msg.value;
  if (msg.field === 'flavor') {
    // 渠道名允许自由输入（含留空＝自动），但不能带出 shell / Gradle 无法识别的字符
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && !/^[\w.-]+$/.test(text)) throw new Error('渠道名只能包含字母、数字、下划线、点和短横线。');
    value = text;
  } else {
    const options = msg.field === 'module' ? info.modules : msg.field === 'buildVariant' ? info.variants : [];
    if (typeof msg.value !== 'string' || !options.includes(msg.value)) throw new Error('无效的构建配置。');
  }
  configuring = true;
  try {
    await cfg().update(msg.field, value, vscode.ConfigurationTarget.WorkspaceFolder);
    resetCache();
    await updateStatusBar();
  } finally {
    configuring = false;
  }
}

function buildConfiguration() {
  const c = cfg();
  const module = (c.get('module') || 'app').trim().replace(/^:/, '');
  const variant = (c.get('buildVariant') || 'debug').trim();
  const flavor = flavorState();
  const overrides = [['gradleTask', '任务'], ['apkPath', 'APK'], ['applicationId', '包名']].filter(([key]) => (c.get(key) || '').trim()).map(([, label]) => label);
  return {
    module,
    variant,
    flavor: (c.get('flavor') || '').trim(),
    flavors: flavor.flavors,
    resolvedFlavor: flavor.name,
    flavorSource: flavor.source,
    flavorAuto: flavor.source === 'auto-first',
    flavorMultiDimension: flavor.source === 'multi-dimension',
    flavorUnknown: flavor.source === 'unknown',
    modules: discoverModules(projectRoot(), module),
    variants: Array.from(new Set(['debug', 'release', variant])),
    locked: overrides.length > 0,
    overrides,
    key: configurationKey()
  };
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function cfg() {
  return activeConfiguration || vscode.workspace.getConfiguration(CFG, configurationResource());
}

function isWin() {
  return process.platform === 'win32';
}

function execFileP(file, args, options) {
  return new Promise((resolve) => {
    const opts = Object.assign(
      { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      options || {}
    );
    cp.execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        message: err ? err.message : ''
      });
    });
  });
}

function execFileSyncSafe(file, args, options) {
  try {
    return cp
      .execFileSync(file, args, Object.assign({ encoding: 'utf8', timeout: 5000, windowsHide: true }, options || {}))
      .toString()
      .trim();
  } catch (e) {
    return '';
  }
}

/** 从工作区目录向上寻找带 gradle wrapper 的工程根目录。 */
function findProjectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    return null;
  }
  const hasWrapper = (dir) =>
    fs.existsSync(path.join(dir, 'gradlew')) || fs.existsSync(path.join(dir, 'gradlew.bat'));

  for (const folder of folders) {
    let dir = folder.uri.fsPath;
    for (let i = 0; i < 6 && dir; i++) {
      if (hasWrapper(dir)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

function projectRoot(force) {
  if (activeConfiguration) return activeConfiguration.root;
  if (force) {
    cache.root = undefined;
  }
  if (cache.root === undefined) {
    cache.root = findProjectRoot();
  }
  return cache.root;
}

function gradlewPath() {
  const root = projectRoot();
  if (!root) {
    return null;
  }
  const file = path.join(root, isWin() ? 'gradlew.bat' : 'gradlew');
  return fs.existsSync(file) ? file : null;
}

/* ------------------------------------------------------------------ */
/* 环境探测：adb / SDK / JDK / Gradle                                  */
/* ------------------------------------------------------------------ */

function existsFile(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** 读取 local.properties 中的 sdk.dir。 */
function readSdkDirFromLocalProperties() {
  const root = projectRoot();
  if (!root) {
    return null;
  }
  const lp = path.join(root, 'local.properties');
  if (!fs.existsSync(lp)) {
    return null;
  }
  try {
    const m = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(lp, 'utf8'));
    return m ? m[1].replace(/\\:/g, ':').replace(/\\\\/g, '\\') : null;
  } catch (e) {
    return null;
  }
}

/** 探测 Android SDK 根目录。 */
function detectSdkDir() {
  const candidates = [];
  const fromProps = readSdkDirFromLocalProperties();
  if (fromProps) {
    candidates.push(fromProps);
  }
  if (process.env.ANDROID_HOME) {
    candidates.push(process.env.ANDROID_HOME);
  }
  if (process.env.ANDROID_SDK_ROOT) {
    candidates.push(process.env.ANDROID_SDK_ROOT);
  }
  candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  candidates.push(path.join(os.homedir(), 'Android', 'sdk'));

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return path.resolve(c);
    }
  }
  return null;
}

function detectAdbUsable() {
  const adb = detectAdb();
  if (existsFile(adb)) {
    return true;
  }
  return !!execFileSyncSafe(adb, ['version']);
}

/** 探测 adb。 */
function detectAdb() {
  if (cache.adb) {
    return cache.adb;
  }
  const configured = (cfg().get('adbPath') || '').trim();
  const candidates = [];
  if (configured) {
    candidates.push(configured);
  }
  const sdk = detectSdkDir();
  if (sdk) {
    candidates.push(path.join(sdk, 'platform-tools', isWin() ? 'adb.exe' : 'adb'));
  }
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[key]) {
      candidates.push(path.join(process.env[key], 'platform-tools', isWin() ? 'adb.exe' : 'adb'));
    }
  }
  candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
  candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'));

  for (const c of candidates) {
    if (existsFile(c)) {
      cache.adb = c;
      return cache.adb;
    }
  }
  // 回落到 PATH，最后才承认失败
  cache.adb = isWin() ? 'adb.exe' : 'adb';
  return cache.adb;
}

function javaHomeForVersion(version) {
  if (process.platform === 'darwin') {
    const out = execFileSyncSafe('/usr/libexec/java_home', ['-v', version]);
    if (out && fs.existsSync(out)) {
      return out;
    }
  }
  const roots = [
    '/Library/Java/JavaVirtualMachines',
    path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines')
  ];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      const home = path.join(dir, name, 'Contents', 'Home');
      if (name.indexOf(version) !== -1 && fs.existsSync(home)) {
        return home;
      }
    }
  }
  return null;
}

/** 读取 .idea/gradle.xml 中 Android Studio 实际使用的 Gradle JDK。 */
function readGradleJvmFromIdea() {
  const root = projectRoot();
  if (!root) {
    return null;
  }
  const gxml = path.join(root, '.idea', 'gradle.xml');
  if (!fs.existsSync(gxml)) {
    return null;
  }
  try {
    const m = /name="gradleJvm"[^>]*value="([^"]+)"/.exec(fs.readFileSync(gxml, 'utf8'));
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/** 把 .idea 的 gradleJvm 取值解析成 JAVA_HOME。 */
function resolveGradleJvmValue(value) {
  if (!value) {
    return null;
  }
  const v = value.trim();
  if (path.isAbsolute(v) && fs.existsSync(v)) {
    return v;
  }
  const jbr = /^jbr-(\d+)/.exec(v);
  if (jbr) {
    const asJbr = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
    if (fs.existsSync(asJbr)) {
      return asJbr;
    }
    return javaHomeForVersion(jbr[1]);
  }
  const numeric = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (numeric) {
    return javaHomeForVersion(numeric[1]);
  }
  return null;
}

function detectJavaHomeDetail() {
  const configured = (cfg().get('javaHome') || '').trim();
  if (configured && fs.existsSync(configured)) {
    return { home: configured, source: '设置项 androidRunner.javaHome' };
  }
  const jvmValue = readGradleJvmFromIdea();
  const fromIdea = resolveGradleJvmValue(jvmValue);
  if (fromIdea) {
    return { home: fromIdea, source: `.idea/gradle.xml 中的 gradleJvm="${jvmValue}"` };
  }
  const envHome = process.env.JAVA_HOME;
  if (envHome && fs.existsSync(envHome)) {
    return { home: envHome, source: '环境变量 JAVA_HOME' };
  }
  if (process.platform === 'darwin') {
    const out = execFileSyncSafe('/usr/libexec/java_home', []);
    if (out && fs.existsSync(out)) {
      return { home: out, source: '系统默认 JDK（/usr/libexec/java_home）' };
    }
  }
  return { home: null, source: '未找到' };
}

function detectJavaHome() {
  if (cache.javaHome !== undefined) {
    return cache.javaHome;
  }
  cache.javaHome = detectJavaHomeDetail().home;
  return cache.javaHome;
}

function javaVersionOf(home) {
  if (!home) {
    return '';
  }
  const javaBin = path.join(home, 'bin', 'java');
  if (!existsFile(javaBin)) {
    return '';
  }
  try {
    // java -version 输出到 stderr，必须两个流都读
    const r = cp.spawnSync(javaBin, ['-version'], { encoding: 'utf8', timeout: 5000 });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const m = /version "([^"]+)"/.exec(text);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function gradleVersionFromWrapper() {
  const root = projectRoot();
  if (!root) {
    return '';
  }
  const props = path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!fs.existsSync(props)) {
    return '';
  }
  try {
    const m = /gradle-([\d.]+)-(all|bin)\.zip/.exec(fs.readFileSync(props, 'utf8'));
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function ensureGradlewExecutable() {
  if (isWin()) {
    return;
  }
  const file = gradlewPath();
  if (!file) {
    return;
  }
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch (e) {
    try {
      fs.chmodSync(file, 0o755);
      output.appendLine(`已补上执行权限：${file}`);
    } catch (e2) {
      output.appendLine(`无法为 gradlew 添加执行权限：${e2.message}`);
    }
  }
}

/** 缺少 local.properties 时自动生成（该文件在 .gitignore 中）。 */
function ensureLocalProperties() {
  if (!cfg().get('autoCreateLocalProperties')) {
    return;
  }
  const root = projectRoot();
  if (!root) {
    return;
  }
  const lp = path.join(root, 'local.properties');
  if (fs.existsSync(lp)) {
    return;
  }
  const sdk = detectSdkDir();
  if (!sdk) {
    return;
  }
  try {
    const content = `## 由 Android Runner 自动生成，用于本机构建\nsdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`;
    fs.writeFileSync(lp, content, 'utf8');
    output.appendLine(`已自动生成 local.properties（sdk.dir=${sdk}）`);
  } catch (e) {
    output.appendLine(`自动生成 local.properties 失败：${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

async function listDevices() {
  const adb = detectAdb();
  const r = await execFileP(adb, ['devices', '-l'], { timeout: 10000 });
  if (!r.ok) {
    return { error: r.message || r.stderr || 'adb 执行失败', devices: [] };
  }
  const devices = [];
  const lines = r.stdout.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('*')) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const modelPart = parts.find((p) => p.startsWith('model:'));
    devices.push({
      serial: parts[0],
      state: parts[1],
      model: modelPart ? modelPart.slice(6).replace(/_/g, ' ') : ''
    });
  }
  return { devices };
}

function deviceLabel(d) {
  return d.model ? `${d.model} (${d.serial})` : d.serial;
}

/** 按终端显示宽度补齐（中文占 2 格），用于自检报告对齐。 */
function padLabel(text, width) {
  let w = 0;
  for (const ch of text) {
    w += /[一-龥（）：，]/.test(ch) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emulatorPath() {
  const sdk = detectSdkDir();
  if (!sdk) {
    return null;
  }
  const file = path.join(sdk, 'emulator', isWin() ? 'emulator.exe' : 'emulator');
  return existsFile(file) ? file : null;
}

async function listAvds() {
  const emu = emulatorPath();
  if (!emu) {
    return [];
  }
  const r = await execFileP(emu, ['-list-avds'], { timeout: 8000 });
  if (!r.ok) {
    return [];
  }
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function resolveModel(dev) {
  if (modelCache.has(dev.serial)) {
    return modelCache.get(dev.serial);
  }
  const r = await execFileP(detectAdb(), ['-s', dev.serial, 'shell', 'getprop', 'ro.product.model'], {
    timeout: 5000
  });
  const model = (r.ok ? r.stdout.trim() : '') || dev.model || '';
  if (model) {
    modelCache.set(dev.serial, model);
  }
  return model;
}

/** 读取单台设备的展示信息：机型 / Android 版本 / 真机还是模拟器。 */
async function describeDevice(dev) {
  const adb = detectAdb();
  const [rel, mdl] = await Promise.all([
    execFileP(adb, ['-s', dev.serial, 'shell', 'getprop', 'ro.build.version.release'], { timeout: 5000 }),
    execFileP(adb, ['-s', dev.serial, 'shell', 'getprop', 'ro.product.model'], { timeout: 5000 })
  ]);
  return {
    android: rel.ok ? rel.stdout.trim() : '',
    model: (mdl.ok ? mdl.stdout.trim() : '') || dev.model,
    isEmulator: dev.serial.indexOf('emulator-') === 0
  };
}

/** 启动 AVD 并等待它上线，返回可用设备。 */
async function startAvd(name) {
  const emu = emulatorPath();
  if (!emu || !name) {
    vscode.window.showErrorMessage('未找到指定的 AVD，请刷新设备与环境。');
    return null;
  }
  if (avdStartup) return null;
  let launchError = null;
  let targetSerial = null;
  async function findTarget(devices) {
    if (targetSerial) return devices.find((d) => d.serial === targetSerial && d.state === 'device');
    for (const device of devices.filter((d) => d.serial.startsWith('emulator-') && d.state === 'device')) {
      const result = await execFileP(detectAdb(), ['-s', device.serial, 'emu', 'avd', 'name'], { timeout: 5000 });
      if (result.ok && result.stdout.split(/\r?\n/)[0].trim() === name) {
        targetSerial = device.serial;
        return device;
      }
    }
    return null;
  }
  avdStartup = { name, startedAt: Date.now(), phase: 'starting' };
  publishRuntime();
  try {
    if (!(await getAvds(false)).includes(name)) throw new Error('指定的 AVD 已不存在，请刷新后重试。');
    const existing = await findTarget((await listDevices()).devices);
    if (!existing) {
      output.appendLine(`▶ ${emu} -avd ${name}`);
      const proc = cp.spawn(emu, ['-avd', name], { detached: true, stdio: 'ignore' });
      proc.once('error', (error) => { launchError = error; });
      proc.unref();
    }
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `启动模拟器 ${name}`, cancellable: true },
      async (progress, token) => {
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          if (token.isCancellationRequested) return null;
          if (launchError) throw launchError;
          const target = await findTarget((await listDevices()).devices);
          if (target) {
            avdStartup.phase = 'booting';
            avdStartup.serial = target.serial;
            const boot = await execFileP(detectAdb(), ['-s', target.serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5000 });
            if (boot.ok && boot.stdout.trim() === '1') {
              await rememberDevice(target);
              return target;
            }
          }
          const message = target ? '设备已上线，等待 Android 启动完成…' : '等待目标模拟器上线…';
          progress.report({ message });
          publishRuntime();
          await sleep(3000);
        }
        vscode.window.showErrorMessage('模拟器 180 秒内未就绪，请检查 AVD 是否正常。');
        return null;
      }
    );
  } finally {
    avdStartup = null;
    publishRuntime();
  }
}

function reportNoDevice(unavailable) {
  const unauthorized = unavailable.filter((d) => d.state === 'unauthorized');
  const offline = unavailable.filter((d) => d.state === 'offline');
  if (unauthorized.length) {
    vscode.window.showErrorMessage('设备已连接但未授权：请在手机上点「允许 USB 调试」。');
  } else if (offline.length) {
    vscode.window.showErrorMessage('设备处于 offline 状态：请拔插 USB 或执行 adb kill-server 后重试。');
  } else {
    vscode.window.showErrorMessage('没有检测到设备：请检查 USB 线、开发者选项与 USB 调试开关。');
  }
}

async function chooseDevice(interactive) {
  const { devices, error } = await listDevices();
  if (error) {
    vscode.window.showErrorMessage(`adb 执行失败：${error}`);
    return null;
  }
  const ready = devices.filter((d) => d.state === 'device');
  const unavailable = devices.filter((d) => d.state !== 'device');

  // 非交互（直接运行）时优先复用当前设备，避免每次都弹框
  if (!interactive) {
    const preferred = devicePreference();
    const remembered = currentDevice(ready);
    if (remembered) {
      await rememberDevice(remembered);
      return remembered;
    }
    if (preferred) {
      vscode.window.showWarningMessage(`目标设备 ${preferred.model} 已断开，请重新连接或在面板中选择另一台设备。`);
      return null;
    }
    if (ready.length === 0) {
      if (unavailable.length) {
        reportNoDevice(unavailable);
        return null;
      }
      const avds = await listAvds();
      if (!avds.length) {
        reportNoDevice([]);
        return null;
      }
      const avd = await vscode.window.showQuickPick(
        avds.map((name) => ({ label: name, description: '启动模拟器' })),
        { placeHolder: '没有连接真机，选择一个模拟器启动' }
      );
      return avd ? startAvd(avd.label) : null;
    }
  }

  // 交互（或首次多设备）：完整列表，对标 Android Studio 的设备下拉
  const items = [];
  if (ready.length) {
    items.push({ label: '已连接设备', kind: vscode.QuickPickItemKind.Separator });
    for (const d of ready) {
      const info = await describeDevice(d);
      items.push({
        label: `${d.serial === cache.serial ? '$(check) ' : ''}${d.serial}`,
        description: [info.model, info.android ? `Android ${info.android}` : '', info.isEmulator ? '模拟器' : '真机']
          .filter(Boolean)
          .join(' · '),
        device: d
      });
    }
  }
  if (unavailable.length) {
    items.push({ label: '不可用设备', kind: vscode.QuickPickItemKind.Separator });
    for (const d of unavailable) {
      items.push({
        label: d.serial,
        description:
          d.state === 'unauthorized'
            ? '未授权：请在手机上点「允许 USB 调试」'
            : d.state === 'offline'
              ? '离线：拔插 USB 或执行 adb kill-server'
              : d.state,
        unavailableDevice: d
      });
    }
  }
  const avds = await listAvds();
  if (avds.length) {
    items.push({ label: '模拟器', kind: vscode.QuickPickItemKind.Separator });
    for (const name of avds) {
      items.push({ label: `$(debug-start) ${name}`, description: '启动 AVD', avd: name });
    }
  }
  if (!items.length) {
    reportNoDevice([]);
    return null;
  }

  const pick = await vscode.window.showQuickPick(items, { placeHolder: '选择目标设备，或启动一个模拟器' });
  if (!pick) {
    return null;
  }
  if (pick.avd) {
    return startAvd(pick.avd);
  }
  if (pick.unavailableDevice) {
    reportNoDevice([pick.unavailableDevice]);
    return null;
  }
  if (pick.device) {
    await rememberDevice(pick.device);
    return pick.device;
  }
  return null;
}

async function updateStatusBar() {
  if (!statusItem) {
    return;
  }
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const s = await collectViewState();
    applyStatusBar(s);
    if (viewProvider) {
      viewProvider.push(s);
    }
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      setImmediate(() => {
        updateStatusBar().catch(() => {});
      });
    }
  }
}

function applyStatusBar(s) {
  if (!s.isProject) {
    statusItem.hide();
    return;
  }
  if (s.error) {
    statusItem.text = '$(warning) adb 异常';
    statusItem.tooltip = `无法执行 adb：${s.error}\n点击打开设备列表`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.command = 'androidRunner.showPanel';
    statusItem.show();
    return;
  }
  if (!s.current) {
    const unauthorized = (s.devices || []).filter((d) => d.state === 'unauthorized');
    statusItem.text = s.preferredDisconnected ? '$(debug-disconnect) 目标设备已断开' : '$(debug-disconnect) 未连接设备';
    statusItem.tooltip = s.preferredDisconnected ? `${s.preferredDevice.model} 已断开，重新连接后恢复选择；也可点击切换到其他设备。` : unauthorized.length
      ? '设备未授权，请在手机上允许 USB 调试\n点击打开面板'
      : '未检测到设备，点击打开面板 / 启动模拟器';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.command = 'androidRunner.showPanel';
    statusItem.show();
    return;
  }
  statusItem.text = `$(device-mobile) ${s.current.model || s.current.serial}`;
  statusItem.tooltip = [
    `Android Runner${VERSION ? ' v' + VERSION : ''}`,
    `设备：${s.current.serial}${s.current.model ? ' · ' + s.current.model : ''}`,
    `App：${s.packageName || '未知'} · ${s.current.appRunning ? '运行中' : '未运行'}`,
    `SDK：${s.env.sdk || '未探测到'}`,
    `JDK：${s.env.jdk || '未探测到'}`,
    `任务：${s.env.task || '请先选择渠道'}`,
    '',
    '点击打开左侧面板'
  ].join('\n');
  statusItem.backgroundColor = undefined;
  statusItem.command = 'androidRunner.showPanel';
  statusItem.show();
}

/** 汇总面板需要的全部状态，同时供状态栏与侧边栏使用。 */
async function collectViewState() {
  const root = projectRoot();
  const state = {
    version: VERSION,
    configuration: buildConfiguration(),
    apk: apkInfo(findApkForConfiguration()),
    isProject: !!root,
    error: null,
    devices: [],
    avds: [],
    current: null,
    packageName: (root && resolvePackage()) || '',
    env: {
      sdk: detectSdkDir() || '',
      jdk: detectJavaHome() || '',
      gradle: gradleVersionFromWrapper() || '',
      flavor: root ? flavorState().name : '',
      task: root ? gradleTaskFor() : '',
      apk: (root && resolveApk()) || ''
    },
    building: !!building,
    buildTask: buildTask,
    lastBuild: lastBuild
  };
  if (!root) {
    return Object.assign(state, runtimeState());
  }

  const { devices, error } = await listDevices();
  if (error) {
    state.error = error;
    return Object.assign(state, runtimeState());
  }
  // 面板用 isEmulator 区分真机/模拟器图标；adb 原始列表没有该字段，这里补全
  state.devices = devices.map((d) => ({
    serial: d.serial,
    state: d.state,
    model: d.model,
    isEmulator: d.serial.indexOf('emulator-') === 0
  }));

  const ready = devices.filter((d) => d.state === 'device');
  const current = currentDevice(ready);
  state.preferredDevice = devicePreference();
  state.preferredDisconnected = !!state.preferredDevice && !current;
  if (current) {
    cache.serial = current.serial;
    const model = await resolveModel(current);
    const android = await resolveAndroidVersion(current.serial);
    let appRunning = false;
    if (state.packageName) {
      const r = await execFileP(detectAdb(), ['-s', current.serial, 'shell', 'pidof', state.packageName], {
        timeout: 5000
      });
      appRunning = r.ok && !!r.stdout.trim();
    }
    state.current = {
      serial: current.serial,
      model: model || current.model,
      android,
      isEmulator: current.serial.indexOf('emulator-') === 0,
      appRunning
    };
    const self = state.devices.find((d) => d.serial === current.serial);
    if (self) {
      self.model = state.current.model;
    }
  }

  state.avds = await getAvds(false);
  return Object.assign(state, runtimeState());
}

async function resolveAndroidVersion(serial) {
  if (androidCache.has(serial)) {
    return androidCache.get(serial);
  }
  const r = await execFileP(detectAdb(), ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], {
    timeout: 5000
  });
  const version = r.ok ? r.stdout.trim() : '';
  if (version) {
    androidCache.set(serial, version);
  }
  return version;
}

async function getAvds(force) {
  if (!force && Date.now() - avdCache.at < 30000) {
    return avdCache.list;
  }
  const list = await listAvds();
  avdCache = { list, at: Date.now() };
  return list;
}

async function pickReadyDevice() {
  const { devices, error } = await listDevices();
  if (error) {
    vscode.window.showErrorMessage(`adb 执行失败：${error}`);
    return null;
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (!ready.length) {
    reportNoDevice(devices.filter((d) => d.state !== 'device'));
    return null;
  }
  const device = currentDevice(ready);
  if (!device) {
    vscode.window.showWarningMessage('目标设备已断开，请在面板中选择设备。');
    return null;
  }
  await rememberDevice(device);
  return device;
}

/* ------------------------------------------------------------------ */
/* 工程信息探测：任务 / APK / 包名                                      */
/* ------------------------------------------------------------------ */

function cap(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/**
 * 解析当前要用的渠道（productFlavors）。
 *
 * 优先级：显式设置 → 多维度降级（按普通 debug）→ 唯一渠道 → official → dev → 自动取第一个。
 * 原则是「总能跑起来」：识别有歧义时挑一个可执行的默认值，而不是把操作禁掉。
 */
function flavorState() {
  const root = projectRoot();
  const module = (cfg().get('module') || 'app').trim().replace(/^:/, '');
  const configured = (cfg().get('flavor') || '').trim();
  const info = root ? discoverFlavors(root, module) : { flavors: [], source: 'none', dimensionCount: 0, multiDimension: false };
  const result = (name, source) => Object.assign({}, info, { name, source });
  if (configured) return result(configured, 'configured');
  // 多维度渠道的组合名静态推不出来，直接按普通 debug 构建
  if (info.multiDimension) return result('', 'multi-dimension');
  if (info.flavors.length === 1) return result(info.flavors[0], 'single');
  const official = info.flavors.find((item) => item.toLowerCase() === 'official');
  if (official) return result(official, 'official');
  const dev = info.flavors.find((item) => item.toLowerCase() === 'dev');
  if (dev) return result(dev, 'dev');
  if (info.flavors.length > 1) return result(info.flavors[0], 'auto-first');
  return result('', 'unknown');
}

/**
 * 任务名必须和 AGP 的变体命名一致：assemble + flavor 首字母大写 + variant 首字母大写。
 * 渠道为空时就是 assemble<variant>（普通 debug）。
 */
function gradleTaskFor() {
  const c = cfg();
  const explicit = (c.get('gradleTask') || '').trim();
  if (explicit) {
    return explicit;
  }
  const module = (c.get('module') || 'app').trim().replace(/^:/, '');
  const variant = (c.get('buildVariant') || 'debug').trim();
  return `:${module}:assemble${cap(flavorState().name)}${cap(variant)}`;
}

function findApkForConfiguration() {
  const c = cfg();
  const module = (c.get('module') || 'app').trim();
  const variant = (c.get('buildVariant') || 'debug').trim();
  const flavor = flavorState();
  const relaxed = flavor.source === 'multi-dimension';
  return findApk(projectRoot(), module, variant, (c.get('apkPath') || '').trim(), flavor.name, relaxed);
}

function resolveApk() {
  const candidate = findApkForConfiguration();
  return candidate && candidate.path;
}

function resolvePackage() {
  const explicitId = (cfg().get('applicationId') || '').trim();
  if (explicitId) return explicitId;
  const artifact = findApkForConfiguration();
  if (artifact && artifact.applicationId) return artifact.applicationId;
  if (cache.pkg !== undefined) {
    return cache.pkg;
  }
  const explicit = (cfg().get('applicationId') || '').trim();
  if (explicit) {
    cache.pkg = explicit;
    return cache.pkg;
  }
  const root = projectRoot();
  if (!root) {
    cache.pkg = null;
    return null;
  }
  const module = (cfg().get('module') || 'app').trim();
  const candidates = [
    path.join(moduleDirectory(root, module), 'build.gradle'),
    path.join(moduleDirectory(root, module), 'build.gradle.kts')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = /applicationId\s*[=]?\s*['"]([^'"]+)['"]/.exec(text);
      if (m) {
        cache.pkg = m[1];
        return cache.pkg;
      }
    } catch (e) {
      /* 忽略，继续 */
    }
  }
  cache.pkg = null;
  return null;
}

/* ------------------------------------------------------------------ */
/* 编译                                                                */
/* ------------------------------------------------------------------ */

/**
 * 增量构建缓存残留导致的经典失败：AGP 的 Transform 输出目录只追加不清理，
 * 依赖版本变化后旧产物（如两个版本的同一个库）会一起进入 dex 输入，
 * D8 报 "Type xxx is defined multiple times"。
 */
const STALE_ERROR_PATTERNS = [
  /defined multiple times/i,
  /Duplicate class/i,
  /DexArchiveMergerException/,
  /multiple dex files define/i
];

/** 只清理这些目录即可修掉重复类问题，且比全量 clean 快得多。 */
const STALE_ARTIFACT_DIRS = [
  'transforms',
  'mixed_scope_dex_archive',
  'project_dex_archive',
  'sub_project_dex_archive',
  'external_libs_dex_archive',
  'external_libs_dex_archive_with_artifact_transforms',
  'dex',
  'dex_archive_input_jar_hashes',
  'dex_number_of_buckets_file'
];

/** 最近一次 Gradle 输出的末尾片段，用于失败后判断是否为缓存残留。 */
let gradleLogTail = '';

function looksLikeStaleArtifactError(text) {
  if (!text) {
    return false;
  }
  return STALE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function moduleBuildDir() {
  const root = projectRoot();
  const module = (cfg().get('module') || 'app').trim().replace(/^:/, '');
  if (!root || !module) {
    return null;
  }
  return path.join(root, ...module.split(':'), 'build');
}

/** 递归统计目录体积，只用于清理后给用户一个直观反馈。 */
function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch (e) {
        /* 文件可能已被其他进程删除 */
      }
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (!bytes) {
    return '0B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

/**
 * 清理构建产物。
 * @param {string} [scope] stale（默认，只清 transform/dex 缓存）| intermediates | gradle
 */
async function cleanBuildOutputs(scope) {
  const mode = scope || cfg().get('cleanScope') || 'stale';
  const buildDir = moduleBuildDir();
  const module = (cfg().get('module') || 'app').trim().replace(/^:/, '');
  if (!buildDir) {
    throw new Error('未找到 Gradle 工程根目录或模块名，无法清理。');
  }
  if (mode === 'gradle') {
    const task = `:${module}:clean`;
    const r = await runGradleProcess([task], null, null);
    if (!r.ok) {
      throw new Error(`gradlew ${task} 执行失败，详见输出面板。`);
    }
    return { mode, task, removed: [], bytes: 0 };
  }
  const targets =
    mode === 'intermediates'
      ? [path.join(buildDir, 'intermediates')]
      : STALE_ARTIFACT_DIRS.map((dir) => path.join(buildDir, 'intermediates', dir));
  const removed = [];
  let bytes = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      continue;
    }
    bytes += directorySize(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.basename(target));
  }
  return { mode, removed, bytes };
}

async function commandCleanBuild() {
  if (!projectRoot()) {
    vscode.window.showErrorMessage('当前工作区不是 Gradle 工程（未找到 gradlew）。');
    return;
  }
  return withOperation('cleanBuild', [['clean', '清理'], ['build', '编译']], async (step) => {
    const cleaned = await step('clean', async () => {
      const r = await cleanBuildOutputs();
      const what = r.task || r.removed.join('、') || '无残留';
      output.appendLine(`🧹 已清理构建缓存：${what}（释放 ${formatBytes(r.bytes)}）`);
      return true;
    });
    if (!cleaned) {
      return false;
    }
    const device = await peekDevice();
    const ok = await step('build', () => build(device));
    if (ok) {
      vscode.window.showInformationMessage('已清理构建缓存并编译成功。');
    }
    return ok;
  });
}

function runGradleProcess(args, device, token) {
  return new Promise((resolve) => {
    const root = projectRoot();
    const gradlew = gradlewPath();
    if (!root || !gradlew) {
      resolve({ ok: false, reason: 'no-wrapper', cancelled: false });
      return;
    }
    gradleLogTail = '';
    const env = Object.assign({}, process.env);
    const javaHome = detectJavaHome();
    if (javaHome) {
      env.JAVA_HOME = javaHome;
    }
    const sdk = detectSdkDir();
    if (sdk && fs.existsSync(sdk)) {
      env.ANDROID_HOME = sdk;
      env.ANDROID_SDK_ROOT = sdk;
    }
    if (device) {
      env.ANDROID_SERIAL = device.serial;
    }

    output.appendLine('');
    output.appendLine(`▶ ${path.basename(gradlew)} ${args.join(' ')}`);
    output.appendLine(`  cwd=${root}`);
    if (javaHome) {
      output.appendLine(`  JAVA_HOME=${javaHome}`);
    }
    if (env.ANDROID_SERIAL) {
      output.appendLine(`  ANDROID_SERIAL=${env.ANDROID_SERIAL}`);
    }

    const proc = cp.spawn(
      isWin() ? 'cmd.exe' : gradlew,
      isWin() ? ['/c', gradlew].concat(args) : args,
      {
        cwd: root,
        env,
        detached: !isWin(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    currentProc = proc;
    // Only the process exit code determines Gradle success.

    const onData = (buf) => {
      const text = buf.toString();
      output.append(text);
      // 保留末尾 200KB，足够匹配失败原因又不至于占内存
      gradleLogTail = (gradleLogTail + text).slice(-204800);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const sub = token
      ? token.onCancellationRequested(() => {
          output.appendLine('\n⏹ 收到取消请求，正在终止编译…');
          killProcessTree(proc, 'SIGINT');
          const timer = setTimeout(() => { if (currentProc === proc) killProcessTree(proc, 'SIGKILL'); }, 8000);
          if (timer.unref) timer.unref();
        })
      : null;

    proc.on('error', (e) => {
      if (currentProc === proc) currentProc = null;
      if (sub) {
        sub.dispose();
      }
      output.appendLine(`启动 Gradle 失败：${e.message}`);
      resolve({ ok: false, reason: 'spawn-error', cancelled: false });
    });

    proc.on('close', (code, signal) => {
      if (currentProc === proc) currentProc = null;
      if (sub) {
        sub.dispose();
      }
      const cancelled = buildCancelled || !!(token && token.isCancellationRequested);
      output.appendLine(`◀ Gradle 退出：code=${code} signal=${signal || '-'}`);
      resolve({ ok: code === 0 && !cancelled, cancelled, log: gradleLogTail });
    });
  });
}

function killProcessTree(proc, sig) {
  if (!proc || proc.killed) {
    return;
  }
  if (isWin()) {
    // Windows 没有进程组语义，按进程树强杀
    cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(isWin() ? proc.pid : -proc.pid, sig);
  } catch (e) {
    try {
      proc.kill(sig);
    } catch (e2) {
      /* 进程可能已结束 */
    }
  }
}

async function build(device) {
  const flavor = flavorState();
  if (flavor.source === 'multi-dimension') {
    output.appendLine('');
    output.appendLine('⚠️ 检测到多维度渠道，组合名无法静态推断，按 assembleDebug 构建（会编译全部组合）。可在 androidRunner.flavor 指定一个渠道。');
  } else if (flavor.source === 'auto-first') {
    output.appendLine('');
    output.appendLine(`⚠️ 检测到多个渠道（${flavor.flavors.join(' / ')}），已默认使用「${flavor.name}」。可在面板「渠道」中切换。`);
  }
  const task = gradleTaskFor();
  const extra = cfg().get('extraGradleArgs') || [];
  const args = [task].concat(extra);

  ensureGradlewExecutable();
  ensureLocalProperties();

  building = true;
  buildCancelled = false;
  buildTask = task;
  publishRuntime();
  updateStatusBar();

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `编译 ${task}`,
        cancellable: true
      },
      async (progress, token) => {
        output.show(true);
        progress.report({ message: 'Gradle 构建中…' });
        const r = await runGradleProcess(args, device, token);
        lastBuild = { ok: !!r.ok && !r.cancelled, cancelled: !!r.cancelled, at: Date.now(), task, configKey: configurationKey() };
        if (r.reason === 'no-wrapper') {
          vscode.window.showErrorMessage('当前工作区没有找到 gradlew，请在 Gradle 工程根目录打开 VSCode。');
        } else if (r.cancelled) {
          vscode.window.showWarningMessage('已取消编译。');
        } else if (!r.ok) {
          if (looksLikeStaleArtifactError(r.log)) {
            output.appendLine('');
            output.appendLine('💡 重复类/重复定义多数是增量构建缓存残留：AGP 的 Transform 输出目录不会清理旧产物，');
            output.appendLine('   依赖版本变化后同一个类的两份历史 dex 会一起进入合并。可执行「Android: 清理缓存并重新编译」。');
            vscode.window
              .showErrorMessage('编译失败：检测到重复类/重复定义，通常是构建缓存残留。', '清理缓存并重试', '查看输出')
              .then((choice) => {
                if (choice === '查看输出') {
                  output.show(true);
                } else if (choice === '清理缓存并重试') {
                  // 等 build() 的收尾（building/operation 复位）走完再起新任务
                  setTimeout(() => {
                    commandCleanBuild();
                  }, 200);
                }
              });
          } else {
            vscode.window
              .showErrorMessage('编译失败。', '查看输出')
              .then((choice) => choice === '查看输出' && output.show(true));
          }
        }
        return r;
      }
    );
  } finally {
    building = false;
    cache.pkg = undefined;
    publishRuntime();
    updateStatusBar();
  }
}

/* ------------------------------------------------------------------ */
/* 安装 / 启动 / 日志                                                   */
/* ------------------------------------------------------------------ */

const apiLevelCache = new Map();

/** 设备 SDK 级别；取不到时返回 0，按不支持增量安装处理。 */
async function deviceApiLevel(serial) {
  if (apiLevelCache.has(serial)) {
    return apiLevelCache.get(serial);
  }
  const r = await execFileP(detectAdb(), ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], {
    timeout: 5000
  });
  const level = parseInt((r.stdout || '').trim(), 10);
  if (Number.isFinite(level) && level > 0) {
    apiLevelCache.set(serial, level);
    return level;
  }
  return 0;
}

/** 执行一次 adb install，附带耗时，便于对比增量安装效果。 */
async function runInstall(adb, serial, apk, extraArgs) {
  const args = ['-s', serial, 'install', '-r', '-t'].concat(extraArgs || []).concat([apk]);
  output.appendLine(`▶ adb ${args.join(' ')}`);
  const started = Date.now();
  const r = await execFileP(adb, args, { timeout: 300000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  output.append(text.endsWith('\n') ? text : `${text}\n`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  output.appendLine(`  安装用时 ${seconds}s`);
  return { ok: r.ok && /Success/i.test(text), text, seconds };
}

/**
 * 用设备上实际存在的包名。渠道包的 applicationId 常带 suffix，
 * 与 build.gradle 里的声明不一致，直接卸载声明值会卸错包。
 */
async function devicePackageFor(adb, serial, declared) {
  const r = await execFileP(adb, ['-s', serial, 'shell', 'pm', 'list', 'packages'], { timeout: 15000 });
  const packages = (r.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, '').trim())
    .filter(Boolean);
  if (!packages.length) {
    return declared;
  }
  if (packages.includes(declared)) {
    return declared;
  }
  const suffixed = packages.filter((name) => name.startsWith(declared + '.'));
  return suffixed.length === 1 ? suffixed[0] : declared;
}

async function installApk(device) {
  const adb = detectAdb();
  const apk = resolveApk();
  if (!apk || !fs.existsSync(apk)) {
    const flavor = flavorState().name;
    const detail = flavor
      ? `渠道「${flavor}」的产物不存在，请先编译该渠道（任务 ${gradleTaskFor() || '未确定'}）。`
      : '未定位到输出目录，请先编译。';
    output.appendLine(`❌ 找不到 APK：${apk || detail}`);
    vscode.window.showErrorMessage(`找不到 APK。${detail}`);
    return false;
  }
  const stat = fs.statSync(apk);
  const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);

  output.appendLine('');
  output.appendLine(
    `导出 APK：${(stat.size / 1024 / 1024).toFixed(1)} MB，构建于 ${new Date(stat.mtimeMs).toLocaleString()}（${ageMin} 分钟前）`
  );

  const api = await deviceApiLevel(device.serial);
  let result;

  if (api >= 30) {
    // Android 11+ 支持增量安装：只传输 APK 中变化的块
    result = await runInstall(adb, device.serial, apk, ['--fastdeploy']);
    if (!result.ok) {
      output.appendLine('  --fastdeploy 未成功（常见于签名变化或首次安装），回退到全量安装');
      result = await runInstall(adb, device.serial, apk, []);
    }
  } else {
    result = await runInstall(adb, device.serial, apk, []);
  }

  if (result.ok) {
    return true;
  }

  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(result.text)) {
    const declared = resolvePackage();
    const pkg = declared ? await devicePackageFor(adb, device.serial, declared) : '';
    const choice = await vscode.window.showWarningMessage(
      '安装被拒绝（签名不一致或版本回退）。是否卸载后重装？设备上的应用数据会被清空。',
      '卸载并重装',
      '取消'
    );
    if (choice !== '卸载并重装' || !pkg) {
      return false;
    }
    output.appendLine(`▶ adb -s ${device.serial} uninstall ${pkg}`);
    await execFileP(adb, ['-s', device.serial, 'uninstall', pkg], { timeout: 60000 });
    const again = await runInstall(adb, device.serial, apk, []);
    return again.ok;
  }

  vscode.window.showErrorMessage('安装失败，详情见输出面板。');
  return false;
}

async function resolveLauncherActivity(device, pkg) {
  const adb = detectAdb();
  const r = await execFileP(
    adb,
    ['-s', device.serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg],
    { timeout: 10000 }
  );
  if (!r.ok) {
    return '';
  }
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.indexOf('/') !== -1);
  return lines.length ? lines[lines.length - 1] : '';
}

async function launchApp(device) {
  const adb = detectAdb();
  const pkg = resolvePackage();
  if (!pkg) {
    vscode.window.showWarningMessage(
      '未能从 build.gradle 识别 applicationId，无法自动启动。可在设置 androidRunner.applicationId 中指定。'
    );
    return false;
  }
  output.appendLine('');
  const activity = await resolveLauncherActivity(device, pkg);
  if (activity) {
    output.appendLine(`▶ adb -s ${device.serial} shell am start -n ${activity}`);
    const r = await execFileP(
      adb,
      ['-s', device.serial, 'shell', 'am', 'start', '-n', activity],
      { timeout: 20000 }
    );
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    output.append(text.endsWith('\n') ? text : `${text}\n`);
    if (r.ok && !/^\s*Error/im.test(text)) {
      return true;
    }
  }
  output.appendLine(`▶ adb -s ${device.serial} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  const m = await execFileP(
    adb,
    ['-s', device.serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
    { timeout: 20000 }
  );
  const mText = `${m.stdout || ''}${m.stderr || ''}`;
  output.append(mText.endsWith('\n') ? mText : `${mText}\n`);
  return m.ok && /Events injected:\s*[1-9]/.test(mText) && !/No activities found|monkey aborted|Error:/i.test(mText);
}

function openLogcat(device) {
  const adb = detectAdb();
  const pkg = resolvePackage();
  const term = vscode.window.createTerminal({ name: `logcat ${device.serial}` });
  term.show(true);
  // Windows 终端没有 POSIX 变量展开，直接输出全量日志
  if (isWin() || !pkg) {
    term.sendText(`${adb} -s ${device.serial} logcat -v time`);
    return;
  }
  // 优先只看本应用进程；多进程时取第一个 pid；拿不到 pid 时回落全量日志
  const pidExpr = '${PID:+--pid=$PID}';
  term.sendText(
    `PID=$(${adb} -s ${device.serial} shell pidof ${pkg} | awk '{print $1}'); ${adb} -s ${device.serial} logcat -v time ${pidExpr}`
  );
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 投屏（scrcpy）                                                       */
/* ------------------------------------------------------------------ */

/** 每台设备一个投屏窗口/面板，避免重复点击开出多个。 */
const mirrorProcs = new Map();
const mirrorPanels = new Map();
/** 正在启动中的设备，防止 await start() 期间并发点击开出两套会话。 */
const mirrorPending = new Set();

async function commandMirror() {
  const device = await chooseDevice(false);
  if (!device) {
    return;
  }
  const mode = (cfg().get('mirrorMode') || 'window').trim();
  if (mode !== 'window') {
    const opened = await openMirrorPanel(device, mode === 'panel');
    if (opened || mode === 'panel') {
      return;
    }
  }
  await launchScrcpyWindow(device);
}

/** 内嵌面板：只依赖 server jar，不需要本机安装 scrcpy。 */
/** 独立命令：强制走内嵌面板，便于在不改默认设置的情况下验证。 */
async function commandMirrorPanel() {
  const device = await chooseDevice(false);
  if (!device) {
    return;
  }
  await openMirrorPanel(device, true);
}

async function openMirrorPanel(device, strict) {
  const existing = mirrorPanels.get(device.serial);
  if (existing) {
    existing.panel.reveal(undefined, false);
    return true;
  }
  if (mirrorPending.has(device.serial)) {
    return true;
  }
  const extensionUri = extensionContext && extensionContext.extensionUri;
  if (!extensionUri) {
    output.appendLine('内嵌投屏不可用：扩展上下文缺失。');
    return false;
  }
  mirrorPending.add(device.serial);
  try {
    const session = new ScrcpySession({
      adb: detectAdb(),
      serial: device.serial,
      serverFile: path.join(extensionUri.fsPath, 'bin', 'scrcpy-server'),
      log: (line) => output.appendLine(`[scrcpy] ${line}`)
    });
    try {
      await session.start();
    } catch (e) {
      // start() 内部会回收已有资源，这里再兜一层，避免半途失败留下 forward 或设备端进程
      try { session.stop(); } catch (_) { /* 已清理 */ }
      const message = e && e.message ? e.message : String(e);
      output.appendLine(`内嵌投屏启动失败：${message}`);
      if (strict) {
        vscode.window.showErrorMessage(`内嵌投屏不可用：${message}`);
      }
      return false;
    }
    const panel = new MirrorPanel({
      session,
      device,
      extensionUri,
      iconPath: vscode.Uri.joinPath(extensionUri, 'icon.png'),
      log: (line) => output.appendLine(`[mirror] ${line}`),
      onFallback: () => {
        mirrorPanels.delete(device.serial);
        vscode.window.showInformationMessage('内嵌解码不可用，已切换为 scrcpy 投屏窗口。');
        launchScrcpyWindow(device);
      }
    });
    mirrorPanels.set(device.serial, panel);
    panel.panel.onDidDispose(() => mirrorPanels.delete(device.serial));
    return true;
  } finally {
    mirrorPending.delete(device.serial);
  }
}

async function launchScrcpyWindow(device) {
  if (mirrorProcs.has(device.serial)) {
    vscode.window.showInformationMessage(`${deviceLabel(device)} 的投屏窗口已经打开。`);
    return;
  }
  const scrcpy = mirror.findScrcpy((cfg().get('scrcpyPath') || '').trim());
  if (!scrcpy) {
    const hint = mirror.installHint();
    const choice = await vscode.window.showWarningMessage(`未找到 scrcpy，投屏需要先安装：${hint}`, '复制安装命令', '打开安装说明');
    if (choice === '复制安装命令' && vscode.env && vscode.env.clipboard) {
      await vscode.env.clipboard.writeText(hint);
      vscode.window.showInformationMessage('安装命令已复制，粘贴到终端执行后重试。');
    } else if (choice === '打开安装说明') {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/Genymobile/scrcpy#get-the-app'));
    }
    return;
  }
  const args = mirror.buildArgs({
    serial: device.serial,
    title: `${device.model || device.serial} (${device.serial})`,
    extraArgs: cfg().get('scrcpyArgs') || []
  });
  output.appendLine('');
  output.appendLine(`▶ ${scrcpy} ${args.join(' ')}`);
  let proc;
  try {
    proc = mirror.launch({ scrcpy, adb: detectAdb(), args });
  } catch (e) {
    vscode.window.showErrorMessage(`启动 scrcpy 失败：${e && e.message ? e.message : e}`);
    return;
  }
  mirrorProcs.set(device.serial, proc);
  proc.on('error', (e) => {
    mirrorProcs.delete(device.serial);
    output.appendLine(`投屏启动失败：${e && e.message ? e.message : e}`);
    vscode.window.showErrorMessage('启动 scrcpy 失败，详情见输出面板。');
  });
  proc.on('exit', (code) => {
    mirrorProcs.delete(device.serial);
    output.appendLine(code ? `投屏进程退出（code=${code}）` : '投屏窗口已关闭。');
  });
}

async function commandRun() {
  if (!projectRoot()) {
    vscode.window.showErrorMessage('当前工作区不是 Gradle 工程（未找到 gradlew）。');
    return;
  }
  return withOperation('run', [['build', '编译'], ['install', '安装'], ['launch', '启动']], async (step, operation) => {
    const device = await chooseDevice(false);
    if (!device) return false;
    attachOperationDevice(device, operation);
    if (!(await step('build', () => build(device)))) return false;
    operation.packageName = resolvePackage() || '';
    if (!(await step('install', () => installApk(device)))) return false;
    return step('launch', () => launchApp(device));
  });
}

async function commandSelectDevice() {
  const device = await chooseDevice(true);
  if (device) {
    vscode.window.setStatusBarMessage(`Android 目标设备：${deviceLabel(device)}`, 3000);
  }
  updateStatusBar();
}

async function peekDevice() {
  const { devices } = await listDevices();
  const ready = devices.filter((d) => d.state === 'device');
  if (!ready.length) {
    return null;
  }
  return currentDevice(ready);
}

async function commandBuildOnly() {
  return withOperation('build', [['build', '编译']], async (step) => {
    const device = await peekDevice();
    const ok = await step('build', () => build(device));
    if (ok) vscode.window.showInformationMessage('编译成功。');
    return ok;
  });
}

async function commandInstallOnly() {
  return withOperation('install', [['install', '安装']], async (step, operation) => {
    const device = await chooseDevice(false);
    if (!device) return false;
    attachOperationDevice(device, operation);
    const ok = await step('install', () => installApk(device));
    if (ok) vscode.window.showInformationMessage(`已安装到 ${deviceLabel(device)}`);
    return ok;
  });
}

async function commandLaunchOnly() {
  return withOperation('launch', [['launch', '启动']], async (step, operation) => {
    const device = await chooseDevice(false);
    if (!device) return false;
    attachOperationDevice(device, operation);
    return step('launch', () => launchApp(device));
  });
}

async function commandLogcat() {
  const device = await chooseDevice(false);
  if (!device) {
    return;
  }
  openLogcat(device);
}

async function commandCancel() {
  if (!currentProc) {
    vscode.window.showInformationMessage('当前没有进行中的编译任务。');
    return;
  }
  buildCancelled = true;
  const proc = currentProc;
  killProcessTree(proc, 'SIGINT');
  const timer = setTimeout(() => { if (currentProc === proc) killProcessTree(proc, 'SIGKILL'); }, 8000);
  if (timer.unref) timer.unref();
}

/** 环境自检：把所有自动探测结果摊开，缺失项给出可执行的修复建议。 */
async function commandDoctor() {
  output.show(true);
  output.appendLine('');
  output.appendLine('════════ Android Runner 环境自检 ════════');

  const root = projectRoot();
  const sdk = detectSdkDir();
  const adb = detectAdb();
  const adbVer = detectAdbUsable() ? execFileSyncSafe(adb, ['version']).split(/\r?\n/)[0] : '';
  const javaDetail = detectJavaHomeDetail();
  const javaVer = javaVersionOf(javaDetail.home);
  const gradleVer = gradleVersionFromWrapper();
  const { devices, error } = await listDevices();
  const flavor = flavorState();
  const flavorText = flavor.source === 'multi-dimension'
    ? `多维度（${flavor.flavors.join(' / ')}），按 assembleDebug 构建`
    : flavor.flavors.length
      ? `${flavor.name || '⚠️ 未选择'}（可选：${flavor.flavors.join(' / ')}）`
      : '未识别（按普通 debug 构建）';

  const rows = [
    ['工程根目录', root || '❌ 未找到 gradlew（请在 Gradle 工程内打开）'],
    ['Gradle', gradlewPath() || '❌ 缺少 gradlew'],
    ['Gradle 版本', gradleVer || '未知'],
    ['渠道', flavorText],
    ['Gradle 任务', gradleTaskFor() || '⚠️ 需先选择渠道'],
    ['Android SDK', sdk || '❌ 未探测到（检查 local.properties / ANDROID_HOME）'],
    ['adb', `${detectAdbUsable() ? adb : '❌ 未找到（检查 androidRunner.adbPath）'}${adbVer ? '  ' + adbVer : ''}`],
    ['JAVA_HOME', `${javaDetail.home || '❌ 未探测到'}（来源：${javaDetail.source}${javaVer ? '，' + javaVer : ''}）`]
  ];
  for (const [k, v] of rows) {
    output.appendLine(`  ${padLabel(k, 14)}: ${v}`);
  }

  output.appendLine('');
  if (error) {
    output.appendLine(`  设备          : ❌ ${error}`);
  } else if (!devices.length) {
    output.appendLine('  设备          : ⚠️ 无设备，请连接 USB 并开启 USB 调试');
  } else {
    for (const d of devices) {
      const flag = d.state === 'device' ? '✅' : d.state === 'unauthorized' ? '🔒 未授权' : `⚠️ ${d.state}`;
      output.appendLine(`  设备          : ${flag} ${d.serial}${d.model ? ' · ' + d.model : ''}`);
    }
  }

  output.appendLine('');
  const avds = await listAvds();
  output.appendLine(
    `  模拟器        : ${
      !emulatorPath()
        ? '未安装 emulator（SDK 下无 emulator 目录）'
        : avds.length
          ? avds.join('、')
          : '未创建 AVD'
    }`
  );
  output.appendLine(`  包名          : ${resolvePackage() || '⚠️ 未能从 build.gradle 识别'}`);
  const apk = resolveApk();
  output.appendLine(
    `  APK           : ${apk && fs.existsSync(apk) ? `${apk}（${new Date(fs.statSync(apk).mtimeMs).toLocaleString()}）` : '尚未构建' }`
  );
  output.appendLine('══════════════════════════════════════');

  const problems = [];
  if (!root) {
    problems.push('找到 Gradle 工程根目录');
  }
  if (!sdk) {
    problems.push('探测 Android SDK');
  }
  if (!detectAdbUsable()) {
    problems.push('探测 adb');
  }
  if (!javaDetail.home) {
    problems.push('探测 JDK');
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (!ready.length) {
    problems.push('连接一台可用设备');
  }

  if (problems.length) {
    vscode.window.showWarningMessage(`环境自检发现 ${problems.length} 项待处理：${problems.join('、')}。详情见输出面板。`);
  } else {
    vscode.window.showInformationMessage('环境自检通过：工程、SDK、JDK、adb、设备均就绪。');
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 侧边栏面板：动作分发与新增的 App 级操作                              */
/* ------------------------------------------------------------------ */

async function handleViewAction(type, msg) {
  const mutations = ['selectDevice', 'startAvd', 'setConfiguration', 'run', 'build', 'cleanBuild', 'install', 'launch', 'stop', 'restart', 'uninstall', 'clearData'];
  if (mutations.includes(type) && isBusy()) throw new Error('已有任务正在进行，请等待完成。');
  switch (type) {
    case 'ready':
    case 'refresh':
      if (type === 'refresh') {
        resetCache();
        avdCache = { list: [], at: 0 };
      }
      await updateStatusBar();
      return;
    case 'setConfiguration':
      await updateBuildConfiguration(msg);
      return;
    case 'selectDevice': {
      const { devices } = await listDevices();
      const device = devices.find((item) => item.serial === msg.serial && item.state === 'device');
      if (!device) throw new Error('设备已断开，请刷新后重试。');
      await rememberDevice(device);
      await updateStatusBar();
      return;
    }
    case 'startAvd': {
      const device = await startAvd(msg.name);
      if (device) {
        await rememberDevice(device);
      }
      await updateStatusBar();
      return;
    }
    case 'run':
      await commandRun();
      break;
    case 'build':
      await commandBuildOnly();
      break;
    case 'cleanBuild':
      await commandCleanBuild();
      break;
    case 'install':
      await commandInstallOnly();
      break;
    case 'launch':
      await commandLaunchOnly();
      break;
    case 'logcat':
      await commandLogcat();
      break;
    case 'mirror':
      await commandMirror();
      break;
    case 'doctor':
      await commandDoctor();
      break;
    case 'cancel':
      await commandCancel();
      break;
    case 'showOutput':
      output.show(true);
      return;
    case 'settings':
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:notto-work.android-runner');
      return;
    case 'stop':
      await commandStopApp();
      break;
    case 'restart':
      await commandRestartApp();
      break;
    case 'uninstall':
      await commandUninstallApp();
      break;
    case 'clearData':
      await commandClearData();
      break;
    default:
      return;
  }
  await updateStatusBar();
}

async function commandStopApp() {
  const device = await pickReadyDevice();
  if (!device) {
    return;
  }
  const pkg = resolvePackage();
  if (!pkg) {
    vscode.window.showWarningMessage('未识别 applicationId，无法停止应用。');
    return;
  }
  await execFileP(detectAdb(), ['-s', device.serial, 'shell', 'am', 'force-stop', pkg], { timeout: 10000 });
  output.appendLine(`已停止 ${pkg}（${device.serial}）`);
}

async function commandRestartApp() {
  return withOperation('restart', [['stop', '停止'], ['launch', '启动']], async (step, operation) => {
    const device = await pickReadyDevice();
    const pkg = resolvePackage();
    if (!device || !pkg) return false;
    attachOperationDevice(device, operation);
    if (!(await step('stop', async () => {
      const result = await execFileP(detectAdb(), ['-s', device.serial, 'shell', 'am', 'force-stop', pkg], { timeout: 10000 });
      output.appendLine(`停止 ${pkg}：${result.ok ? '成功' : '失败'}`);
      return result.ok;
    }))) return false;
    return step('launch', () => launchApp(device));
  });
}

async function commandUninstallApp() {
  const device = await pickReadyDevice();
  if (!device) {
    return;
  }
  const pkg = resolvePackage();
  if (!pkg) {
    vscode.window.showWarningMessage('未识别 applicationId，无法卸载。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `确定从 ${deviceLabel(device)} 卸载 ${pkg} 吗？设备上的应用数据会一并清除。`,
    { modal: true },
    '卸载'
  );
  if (choice !== '卸载') {
    return;
  }
  const r = await execFileP(detectAdb(), ['-s', device.serial, 'uninstall', pkg], { timeout: 60000 });
  output.append(`${r.stdout || ''}${r.stderr || ''}`);
  if (r.ok && /Success/i.test(r.stdout || '')) {
    vscode.window.showInformationMessage(`已从 ${deviceLabel(device)} 卸载 ${pkg}`);
  } else {
    vscode.window.showErrorMessage('卸载失败，详情见输出面板。');
  }
}

async function commandClearData() {
  const device = await pickReadyDevice();
  if (!device) {
    return;
  }
  const pkg = resolvePackage();
  if (!pkg) {
    vscode.window.showWarningMessage('未识别 applicationId，无法清数据。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `确定清除 ${pkg} 在 ${deviceLabel(device)} 上的应用数据吗？登录态等本地数据会丢失。`,
    { modal: true },
    '清除数据'
  );
  if (choice !== '清除数据') {
    return;
  }
  const r = await execFileP(detectAdb(), ['-s', device.serial, 'shell', 'pm', 'clear', pkg], { timeout: 30000 });
  output.append(`${r.stdout || ''}${r.stderr || ''}`);
  if (r.ok && /Success/i.test(r.stdout || '')) {
    vscode.window.showInformationMessage('已清除应用数据。');
  } else {
    vscode.window.showErrorMessage('清除数据失败，详情见输出面板。');
  }
}

function activate(context) {
  extensionContext = context;
  // 扩展热重载 / 重复激活时，先回收上一次创建的状态栏项，避免状态栏出现两个设备图标
  const prev = global.__androidRunnerPrev;
  if (prev) {
    try {
      prev.dispose();
    } catch (e) {
      /* 旧实例可能已失效 */
    }
  }

  output = vscode.window.createOutputChannel('Android Runner');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  global.__androidRunnerPrev = {
    dispose() {
      try {
        statusItem.dispose();
      } catch (e) {
        /* ignore */
      }
      try {
        output.dispose();
      } catch (e) {
        /* ignore */
      }
    }
  };

  const wrap = (fn) => async (...args) => {
    try {
      const guarded = [commandSelectDevice, commandStopApp, commandUninstallApp, commandClearData];
      if (guarded.includes(fn) && isBusy()) throw new Error('已有任务正在进行，请等待完成。');
      await fn(...args);
    } catch (e) {
      output.appendLine(`\n[未捕获异常] ${e && e.stack ? e.stack : e}`);
      vscode.window.showErrorMessage(`Android Runner 出错：${e && e.message ? e.message : e}`);
    }
  };

  viewProvider = new RunnerViewProvider(context.extensionUri, {
    getState: collectViewState,
    onAction: wrap(handleViewAction),
    onError: (e) => output.appendLine(`[面板异常] ${e && e.stack ? e.stack : e}`)
  });

  context.subscriptions.push(
    output,
    statusItem,
    vscode.window.registerWebviewViewProvider('androidRunner.main', viewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('androidRunner.run', wrap(commandRun)),
    vscode.commands.registerCommand('androidRunner.selectDevice', wrap(commandSelectDevice)),
    vscode.commands.registerCommand('androidRunner.doctor', wrap(commandDoctor)),
    vscode.commands.registerCommand('androidRunner.buildOnly', wrap(commandBuildOnly)),
    vscode.commands.registerCommand('androidRunner.cleanBuild', wrap(commandCleanBuild)),
    vscode.commands.registerCommand('androidRunner.installOnly', wrap(commandInstallOnly)),
    vscode.commands.registerCommand('androidRunner.launchOnly', wrap(commandLaunchOnly)),
    vscode.commands.registerCommand('androidRunner.logcat', wrap(commandLogcat)),
    vscode.commands.registerCommand('androidRunner.mirror', wrap(commandMirror)),
    vscode.commands.registerCommand('androidRunner.mirrorPanel', wrap(commandMirrorPanel)),
    vscode.commands.registerCommand('androidRunner.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('androidRunner.cancel', wrap(commandCancel)),
    vscode.commands.registerCommand('androidRunner.refresh', wrap(updateStatusBar)),
    vscode.commands.registerCommand('androidRunner.showPanel', () => {
      vscode.commands.executeCommand('androidRunner.main.focus');
    }),
    vscode.commands.registerCommand('androidRunner.stopApp', wrap(commandStopApp)),
    vscode.commands.registerCommand('androidRunner.restartApp', wrap(commandRestartApp)),
    vscode.commands.registerCommand('androidRunner.uninstallApp', wrap(commandUninstallApp)),
    vscode.commands.registerCommand('androidRunner.clearData', wrap(commandClearData)),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resetCache();
      setupPolling(context);
      updateStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CFG)) {
        resetCache();
        setupPolling(context);
        updateStatusBar();
      }
    }),
    {
      dispose() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
    }
  );

  setupPolling(context);
  updateStatusBar();
}

function resetCache() {
  cache.root = undefined;
  cache.adb = null;
  cache.javaHome = undefined;
  cache.pkg = undefined;
}

function setupPolling(context) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!projectRoot()) {
    return;
  }
  let interval = Number(cfg().get('pollIntervalMs')) || 10000;
  interval = Math.max(3000, Math.min(60000, interval));
  pollTimer = setInterval(updateStatusBar, interval);
  if (pollTimer.unref) {
    pollTimer.unref();
  }
}

function deactivate() {
  viewProvider = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (currentProc) {
    killProcessTree(currentProc, 'SIGKILL');
  }
  for (const proc of mirrorProcs.values()) {
    try {
      proc.kill();
    } catch (e) {
      /* 投屏窗口可能已被用户关闭 */
    }
  }
  mirrorProcs.clear();
  for (const panel of mirrorPanels.values()) {
    try {
      panel.dispose();
    } catch (e) {
      /* 面板可能已被用户关闭 */
    }
  }
  mirrorPanels.clear();
}

module.exports = { activate, deactivate };
