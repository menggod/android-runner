'use strict';

/**
 * 内嵌投屏面板：一个 WebviewPanel + 一条 ScrcpySession。
 *
 * 分工：
 *   - 面板负责把 H.264 帧转发给 webview（一次一帧、一个 ArrayBuffer）
 *   - webview 用 WebCodecs 解码、canvas 绘制，并把鼠标键盘转成语义化输入消息
 *   - 这里把语义消息翻译成 scrcpy control 协议的二进制写回设备
 */

const vscode = require('vscode');
const control = require('./control');
const { findNalUnits, nalType, avc1CodecString } = require('./h264');

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Node 的 Buffer 可能来自共享内存池，必须按实际长度拷贝，否则会把相邻数据一起发过去。 */
function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function renderHtml(webview, extensionUri) {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mirror.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mirror-player.js'));
  const nonceValue = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    // 同时给 cspSource：外部脚本带 nonce 通常就够，但不同 VSCode 版本对资源源校验宽严不一
    `script-src 'nonce-${nonceValue}' ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>投屏</title>
</head>
<body>
  <canvas id="screen" width="1" height="1"></canvas>
  <div id="overlay">正在连接设备…</div>
  <script nonce="${nonceValue}" src="${scriptUri}"></script>
</body>
</html>`;
}

class MirrorPanel {
  constructor(options) {
    this.session = options.session;
    this.device = options.device;
    this.log = options.log || (() => {});
    this.onFallback = options.onFallback || (() => {});
    this.width = 0;
    this.height = 0;
    this.disposed = false;
    this.ready = false;
    this.pendingKeyframe = false;
    this.pendingConfig = null;

    this.panel = vscode.window.createWebviewPanel(
      'androidRunner.mirror',
      `投屏 · ${options.device.model || options.device.serial}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')]
      }
    );
    if (options.iconPath) {
      this.panel.iconPath = options.iconPath;
    }
    this.panel.webview.html = renderHtml(this.panel.webview, options.extensionUri);

    this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
    this.panel.onDidChangeViewState(() => this.syncVisibility());
    this.panel.onDidDispose(() => this.dispose());

    this.attachVideo();
    this.syncVisibility();
  }

  attachVideo() {
    this.session.onVideo((item) => {
      if (this.disposed) return;
      if (item.type === 'header') {
        this.codecId = item.header.codecId;
        this.log(`设备 ${item.header.deviceName}，编码 ${item.header.codecId}`);
        return;
      }
      // session 包在首次连接和每次编码器重启（reset / 旋转）时都会来，尺寸以它为准
      if (item.type === 'session') {
        if (this.width && (this.width !== item.width || this.height !== item.height)) {
          this.log(`视频尺寸变为 ${item.width}x${item.height}`);
        }
        this.width = item.width;
        this.height = item.height;
        return;
      }
      if (item.config) {
        // 先缓存参数集：webview 可能还没就绪，就绪后再补发，避免白屏等下一次重启
        const sps = findNalUnits(item.data).find((nal) => nalType(nal) === 7);
        if (!sps) return;
        this.pendingConfig = {
          codec: avc1CodecString(sps),
          width: this.width,
          height: this.height,
          paramSets: toArrayBuffer(item.data)
        };
        if (this.ready) this.flushConfigure();
        return;
      }
      if (!this.ready) return;
      this.post({
        type: 'mirror:frame',
        key: item.keyFrame,
        ptsUs: item.ptsUs,
        data: toArrayBuffer(item.data)
      });
    });

    this.session.onClosed(() => {
      if (this.disposed) return;
      this.log('投屏连接已断开');
      vscode.window.showWarningMessage('投屏连接已断开，请重新点击「投屏」。');
      this.dispose();
    });
  }

  flushConfigure() {
    if (!this.pendingConfig || this.disposed) return;
    const config = this.pendingConfig;
    this.pendingConfig = null;
    this.post({
      type: 'mirror:configure',
      codec: config.codec,
      width: config.width,
      height: config.height,
      paramSets: config.paramSets
    });
  }

  syncVisibility() {
    if (this.disposed) return;
    this.post({ type: this.panel.visible ? 'mirror:resume' : 'mirror:pause' });
    if (this.panel.visible) this.requestKeyframe();
  }

  /** 立刻要一个 IDR，避免等 10 秒的自然关键帧间隔。 */
  requestKeyframe() {
    if (this.pendingKeyframe || this.disposed) return;
    this.pendingKeyframe = true;
    this.session.sendControl(control.resetVideo());
    setTimeout(() => { this.pendingKeyframe = false; }, 1500);
  }

  post(message) {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  onMessage(message) {
    if (!message || !message.type || this.disposed) return;
    switch (message.type) {
      case 'mirror:ready':
        this.log('webview 已就绪');
        this.ready = true;
        if (this.pendingConfig) {
          this.flushConfigure();
        } else {
          this.post({ type: 'mirror:status', text: '已连接，正在等待画面…' });
          this.requestKeyframe();
        }
        return;
      case 'mirror:touch':
        this.session.sendControl(control.touch({
          action: message.action,
          pointerId: 0,
          x: message.x,
          y: message.y,
          screenWidth: this.width,
          screenHeight: this.height,
          pressure: message.pressure,
          actionButton: message.actionButton,
          buttons: message.buttons
        }));
        return;
      case 'mirror:key':
        this.session.sendControl(control.key({ action: message.action, keycode: message.keycode, metaState: message.metaState }));
        return;
      case 'mirror:scroll':
        this.session.sendControl(control.scroll({
          x: message.x,
          y: message.y,
          screenWidth: this.width,
          screenHeight: this.height,
          hScroll: message.hScroll,
          vScroll: message.vScroll,
          buttons: message.buttons || 0
        }));
        return;
      case 'mirror:back':
        this.session.sendControl(control.backOrScreenOn(0));
        this.session.sendControl(control.backOrScreenOn(1));
        return;
      case 'mirror:need-keyframe':
        this.requestKeyframe();
        return;
      case 'mirror:unsupported':
        this.log(`内嵌解码不可用：${message.reason || message.codec || '未知原因'}`);
        this.dispose();
        this.onFallback(message);
        return;
      case 'mirror:error':
        this.log(`解码异常：${message.message}`);
        return;
      default:
        return;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.session.stop(); } catch (e) { /* 已断开 */ }
    try { this.panel.dispose(); } catch (e) { /* 已关闭 */ }
  }
}

module.exports = { MirrorPanel, renderHtml };
