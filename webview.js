'use strict';

const vscode = require('vscode');
const icon = require('./media/icons');

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * 左侧活动栏的图形化面板。
 * 只负责渲染与消息转发，业务逻辑全部由 extension.js 通过 api 注入。
 */
class RunnerViewProvider {
  constructor(extensionUri, api) {
    this.extensionUri = extensionUri;
    this.api = api;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.webview.html = this.render(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || !msg.type) {
        return;
      }
      try {
        await this.api.onAction(msg.type, msg);
      } catch (e) {
        if (this.api.onError) {
          this.api.onError(e);
        }
      } finally {
        webviewView.webview.postMessage({ type: 'actionComplete', action: msg.type });
      }
    });

    webviewView.onDidDispose(() => {
      this.view = null;
    });

    this.refresh();
  }

  /** 主动拉一次最新状态（首次打开面板时用）。 */
  refresh() {
    Promise.resolve()
      .then(() => this.api.getState())
      .then((s) => this.push(s))
      .catch(() => {});
  }

  push(state) {
    if (this.view && state) {
      this.view.webview.postMessage({ type: 'state', state });
    }
  }

  postRuntime(runtime) {
    if (this.view) this.view.webview.postMessage({ type: 'runtime', runtime });
  }

  render(webview) {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.js'));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icons.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Android Runner</title>
</head>
<body>
  <main class="runner" aria-label="Android Runner 控制台">
    <header class="topbar">
      <div class="brand-mark">${icon('brand')}</div>
      <div class="brand-text"><h1>Android Runner</h1><span>by menggod</span></div>
      <button class="icon-btn" id="refreshBtn" data-action="refresh" title="刷新设备与环境" aria-label="刷新设备与环境">${icon('refresh')}</button>
    </header>

    <section class="device-section" aria-labelledby="deviceHeading">
      <div class="section-heading"><h2 id="deviceHeading">目标设备</h2><span id="deviceCount" class="meta">正在检测</span></div>
      <div id="deviceArea" aria-busy="true"><div class="device-card loading-card"><span class="skeleton skeleton-icon"></span><span class="skeleton-lines"><span class="skeleton"></span><span class="skeleton short"></span></span></div></div>
    </section>

    <section class="build-config" aria-label="构建配置">
      <div class="config-fields">
        <label>模块<select id="moduleSelect" aria-label="构建模块" disabled><option>app</option></select></label>
        <label>变体<select id="variantSelect" aria-label="构建变体" disabled><option>Debug</option></select></label>
      </div>
      <div id="packageLabel" class="config-package" title="当前应用包名">等待识别包名</div>
      <div id="taskLabel" class="config-task"></div>
      <div id="configNote" class="config-note" hidden></div>
    </section>

    <section class="run-section" aria-label="运行应用">
      <button class="action primary" id="runBtn" data-action="run" disabled>${icon('play')}<span id="runLabel">运行到设备</span></button>
      <div class="run-hint" id="runHint">编译 <span>→</span> 安装 <span>→</span> 启动</div>
    </section>

    <section id="statusBox" class="status idle" aria-live="polite" aria-atomic="true">${icon('clock')}<div class="status-copy"><strong>等待首次构建</strong><span>构建结果会显示在这里</span></div></section>
    <button class="action cancel" id="cancelBtn" data-action="cancel" hidden>${icon('close')}<span>取消编译</span></button>

    <section class="actions-section" aria-labelledby="actionsHeading">
      <div class="section-heading"><h2 id="actionsHeading">常用操作</h2><button class="text-btn" data-action="showOutput" title="打开 Android Runner 输出面板">构建输出 ${icon('log')}</button></div>
      <div class="action-grid">
        <button class="action secondary" id="buildBtn" data-action="build" title="仅编译，不安装到设备" disabled>${icon('build')}<span>编译</span></button>
        <button class="action secondary" id="installBtn" data-action="install" title="安装已有 APK，保留应用数据" disabled>${icon('download')}<span>安装 APK</span></button>
        <button class="action secondary" id="restartBtn" data-action="restart" title="停止后重新启动应用，不重新编译" disabled>${icon('refresh')}<span>重启应用</span></button>
        <button class="action secondary" id="logcatBtn" data-action="logcat" title="打开设备 logcat 日志" disabled>${icon('log')}<span>设备日志</span></button>
        <button class="action secondary" id="stopBtn" data-action="stop" title="停止当前应用" disabled>${icon('stop')}<span>停止应用</span></button>
        <button class="action secondary" id="doctorBtn" data-action="doctor" title="检查 Android SDK、JDK 和设备环境">${icon('doctor')}<span>环境自检</span></button>
      </div>
    </section>

    <section id="apkSection" class="apk-section" aria-label="APK 信息"></section>

    <details class="disclosure" id="envDetails">
      <summary>${icon('settings')}<span>构建环境</span><span id="envSummary" class="meta"></span>${icon('chevron', 'disclosure-chevron')}</summary>
      <div id="envBody" class="env-body"></div>
      <button class="text-btn env-settings" data-action="settings">打开扩展设置 ${icon('chevron')}</button>
    </details>

    <details class="disclosure management" id="manageDetails">
      <summary>${icon('phone')}<span>应用管理</span>${icon('chevron', 'disclosure-chevron')}</summary>
      <p class="management-hint">以下操作会清除设备上的应用数据。</p>
      <div class="action-grid management-grid">
        <button class="action danger" id="clearDataBtn" data-action="clearData" disabled>${icon('clear')}<span>清除数据</span></button>
        <button class="action danger" id="uninstallBtn" data-action="uninstall" disabled>${icon('trash')}<span>卸载应用</span></button>
      </div>
    </details>

    <footer class="footer"><span class="wordmark">menggod</span><span id="versionLabel" class="meta">Android tools</span></footer>
  </main>
  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

module.exports = { RunnerViewProvider };
