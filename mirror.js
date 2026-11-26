'use strict';

/**
 * 投屏（scrcpy）集成。
 *
 * 只做三件事：找到 scrcpy、拼参数、拉起进程。
 * 不自带二进制、不解析视频流、不注入输入事件——画面与控制全部交给 scrcpy 自己的窗口，
 * 这样兼容性和体验都最好，也不必承担跨平台二进制的分发与协议维护。
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

const CANDIDATES = {
  darwin: ['/opt/homebrew/bin/scrcpy', '/usr/local/bin/scrcpy', '/opt/local/bin/scrcpy'],
  linux: ['/usr/bin/scrcpy', '/usr/local/bin/scrcpy', '/snap/bin/scrcpy', path.join(os.homedir(), '.local/bin/scrcpy')],
  win32: []
};

/** PATH 里的 scrcpy。 */
function fromPath() {
  try {
    const out = cp
      .execFileSync(IS_WIN ? 'where' : 'which', ['scrcpy'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return out[0] || '';
  } catch (_) {
    return '';
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch (_) {
    return false;
  }
}

function installHint() {
  if (process.platform === 'darwin') return 'brew install scrcpy';
  if (IS_WIN) return 'winget install --id Genymobile.scrcpy -e';
  return 'sudo apt install scrcpy';
}

function createMirror(deps = {}) {
  const exists = deps.exists || isFile;
  const lookup = deps.lookup || fromPath;
  const spawn = deps.spawn || cp.spawn;

  /** 显式设置优先；其次 PATH；最后常见安装目录。 */
  function findScrcpy(configured) {
    const explicit = (configured || '').trim();
    if (explicit) {
      return exists(explicit) ? explicit : '';
    }
    const resolved = lookup();
    if (resolved && exists(resolved)) {
      return resolved;
    }
    for (const candidate of CANDIDATES[process.platform] || []) {
      if (exists(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  /** scrcpy 1.19+ 通用参数；其余交给用户配置。 */
  function buildArgs(options = {}) {
    const args = [];
    if (options.serial) {
      args.push('-s', options.serial);
    }
    if (options.title) {
      args.push('--window-title', options.title);
    }
    return args.concat(options.extraArgs || []);
  }

  /** scrcpy 不认 PATH 里的 adb 时靠环境变量 ADB 指定。 */
  function launch(options = {}) {
    const env = Object.assign({}, process.env);
    if (options.adb) {
      env.ADB = options.adb;
    }
    return spawn(options.scrcpy, options.args || [], { env, stdio: 'ignore', windowsHide: false });
  }

  return { findScrcpy, buildArgs, launch, installHint };
}

module.exports = createMirror();
module.exports.createMirror = createMirror;
