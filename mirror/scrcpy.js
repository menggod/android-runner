'use strict';

/**
 * scrcpy 内嵌投屏的服务端对接层。
 *
 * 只负责「把 server 推到设备并跑起来、读出视频流」，画面解码与输入注入由 webview 侧完成。
 * 协议细节全部来自 5.0.1 的实测，勿凭记忆改：
 *   - scid 按十六进制解析成 int，必须 ≤ 0x7FFFFFFF，否则 server 直接 NumberFormatException
 *   - 视频流头：1 字节 dummy + 64 字节设备名 + 16 字节 codec 元数据（codec/flags/width/height）
 *   - 帧：8 字节 pts（高 2 位是 config / keyframe 标志）+ 4 字节长度 + Annex-B 数据
 */

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const SERVER_VERSION = '5.0.1';
const DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar';
const DUMMY_BYTES = 1;
const NAME_BYTES = 64;
const CODEC_ID_BYTES = 4;
const VIDEO_HEADER_BYTES = DUMMY_BYTES + NAME_BYTES + CODEC_ID_BYTES;
const SESSION_BYTES = 12;
const FRAME_HEADER_BYTES = 12;

// 帧头是 8 字节 pts + 4 字节长度；session 包是 4 字节 flag + 4 字节宽 + 4 字节高。
// 把 session 的 4 字节 flag 当 8 字节大端读，最高位一定是 1，用它区分两类包。
const SESSION_FLAG = 1n << 63n;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;

/** scid 走十六进制解析，必须落在正整数范围内；用 30 位避免任何符号位歧义。 */
function randomScid() {
  return Math.floor(Math.random() * 0x3fffffff) + 1;
}

/**
 * 增量解析视频流。Node 侧只做拆包，不碰解码。
 *
 * 流的结构（实测 5.0.1）：
 *   头：1 字节 dummy + 64 字节设备名 + 4 字节 codec id
 *   之后是包序列，两类：
 *     - session 包（12 字节）：flag(4) 宽(4) 高(4)，首次连接和每次编码器重启（reset / 旋转）都会发
 *     - 帧包：8 字节 pts+flags + 4 字节长度 + Annex-B 数据
 * 漏掉 session 包会把它的宽度当帧长度，整个流从那一刻起永久错位。
 */
class VideoStreamParser {
  constructor() {
    this.header = null;
  }

  /** 推入一块数据，返回本次解析出的条目数组。 */
  push(chunk) {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
    const items = [];
    for (;;) {
      if (!this.header) {
        if (this.buffer.length < VIDEO_HEADER_BYTES) break;
        this.header = {
          deviceName: this.buffer.slice(DUMMY_BYTES, DUMMY_BYTES + NAME_BYTES).toString('utf8').replace(/\0+$/, ''),
          codecId: this.buffer.slice(DUMMY_BYTES + NAME_BYTES, VIDEO_HEADER_BYTES).toString('ascii'),
          width: 0,
          height: 0
        };
        this.buffer = this.buffer.slice(VIDEO_HEADER_BYTES);
        items.push({ type: 'header', header: this.header });
        continue;
      }
      if (this.buffer.length < 8) break;
      const raw = this.buffer.readBigUInt64BE(0);
      if ((raw & SESSION_FLAG) !== 0n) {
        if (this.buffer.length < SESSION_BYTES) break;
        const width = Number(raw & 0xffffffffn);
        const height = this.buffer.readUInt32BE(8);
        this.buffer = this.buffer.slice(SESSION_BYTES);
        this.header.width = width;
        this.header.height = height;
        items.push({ type: 'session', width, height });
        continue;
      }
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const size = this.buffer.readUInt32BE(8);
      if (this.buffer.length < FRAME_HEADER_BYTES + size) break;
      const data = this.buffer.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size);
      this.buffer = this.buffer.slice(FRAME_HEADER_BYTES + size);
      items.push({
        type: 'frame',
        config: (raw & FLAG_CONFIG) !== 0n,
        keyFrame: (raw & FLAG_KEY_FRAME) !== 0n,
        pts: Number(raw & PTS_MASK) / 1000000,
        ptsUs: Number(raw & PTS_MASK),
        data
      });
    }
    return items;
  }
}

function execFileP(file, args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { encoding: 'utf8', timeout: timeout || 20000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

class ScrcpySession {
  constructor(options) {
    this.adb = options.adb;
    this.serial = options.serial;
    this.serverFile = options.serverFile;
    this.log = options.log || (() => {});
    this.scid = randomScid();
    this.port = 0;
    this.serverProc = null;
    this.video = null;
    this.control = null;
    this.parser = new VideoStreamParser();
    this.stopped = false;
  }

  /** server 端 socket 名固定 zero-pad 到 8 位十六进制。 */
  get socketName() {
    return `scrcpy_${this.scid.toString(16).padStart(8, '0')}`;
  }

  async start() {
    if (!fs.existsSync(this.serverFile)) {
      throw new Error(`缺少 scrcpy-server：${this.serverFile}`);
    }
    // scrcpy 客户端退出时会清理 /data/local/tmp，所以每次投屏都重新推一次
    const push = await execFileP(this.adb, ['-s', this.serial, 'push', this.serverFile, DEVICE_PATH], 60000);
    if (!push.ok) {
      throw new Error(`推送 scrcpy-server 失败：${push.stderr || push.stdout}`);
    }

    this.serverProc = cp.spawn(
      this.adb,
      ['-s', this.serial, 'shell',
        `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION} ` +
        `log_level=info video=true audio=false control=true tunnel_forward=true scid=${this.scid.toString(16)}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.serverProc.stdout.on('data', (d) => this.log(String(d).trim()));
    this.serverProc.stderr.on('data', (d) => this.log(String(d).trim()));

    // adb forward 对不存在的 localabstract 也会“成功”，必须等 server 真正监听后再转发，
    // 否则连上去只是一个空连接，永远等不到数据。
    const deadline = Date.now() + 15000;
    let listening = false;
    while (Date.now() < deadline && !this.stopped) {
      const probe = await execFileP(this.adb, ['-s', this.serial, 'shell', `cat /proc/net/unix | grep ${this.socketName}`]);
      if (probe.ok && probe.stdout.indexOf(this.socketName) !== -1) {
        listening = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!listening) {
      this.stop();
      throw new Error(`scrcpy server 未开始监听（${this.socketName}）`);
    }

    const fwd = await execFileP(this.adb, ['-s', this.serial, 'forward', 'tcp:0', `localabstract:${this.socketName}`]);
    const port = fwd.ok ? parseInt(fwd.stdout.trim(), 10) : 0;
    if (!port) {
      this.stop();
      throw new Error(`adb forward 失败：${fwd.stderr || fwd.stdout}`);
    }
    this.port = port;

    // video 与 control 是两个独立连接，缺一个 server 会一直阻塞
    try {
      this.video = await this.connect();
      this.control = await this.connect();
    } catch (e) {
      // 半途失败时已经占用了 adb forward 和设备端进程，必须回收再抛出
      this.stop();
      throw e;
    }
    return this;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  onVideo(listener) {
    this.video.on('data', (chunk) => {
      for (const item of this.parser.push(chunk)) listener(item);
    });
  }

  /** 控制消息走二进制协议，先原样写出，具体消息由上层构造。 */
  sendControl(buffer) {
    if (this.control && !this.control.destroyed) this.control.write(buffer);
  }

  /** 设备断连 / server 退出时通知上层，避免面板停在一帧死画面上。 */
  onClosed(listener) {
    let fired = false;
    const notify = () => {
      if (fired || this.stopped) return;
      fired = true;
      listener();
    };
    for (const socket of [this.video, this.control]) {
      if (!socket) continue;
      socket.on('close', notify);
      socket.on('error', notify);
    }
    if (this.serverProc) {
      this.serverProc.on('exit', notify);
    }
  }

  stop() {
    this.stopped = true;
    for (const socket of [this.video, this.control]) {
      try { socket && socket.destroy(); } catch (_) { /* 已断开 */ }
    }
    if (this.serverProc) {
      try { this.serverProc.kill(); } catch (_) { /* 已退出 */ }
      this.serverProc = null;
    }
    if (this.port) {
      execFileP(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {});
      this.port = 0;
    }
  }
}

module.exports = { ScrcpySession, VideoStreamParser, randomScid, VIDEO_HEADER_BYTES, FRAME_HEADER_BYTES, SERVER_VERSION, DEVICE_PATH };
