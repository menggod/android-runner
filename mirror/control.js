'use strict';

/**
 * scrcpy control socket 的客户端消息编码。
 *
 * 格式来自对 scrcpy 5.0.1 server (classes.dex) 的 ControlMessageReader 反汇编，
 * 每条消息都标注了字段顺序与总长度；改任何一条前先重新核对字节码，不要凭印象调整。
 * 全部为 big-endian（对应 Java DataInputStream）。
 */

const TYPE = {
  KEYCODE: 0,
  TEXT: 1,
  TOUCH: 2,
  SCROLL: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  RESET_VIDEO: 17
};

const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

/** 触摸：type(1) action(1) pointerId(8) x(4) y(4) w(2) h(2) pressure(2) actionButton(4) buttons(4) = 32 */
function touch(options) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(TYPE.TOUCH, 0);
  buffer.writeUInt8(options.action & 0xff, 1);
  buffer.writeBigInt64BE(BigInt(options.pointerId || 0), 2);
  buffer.writeInt32BE(options.x | 0, 10);
  buffer.writeInt32BE(options.y | 0, 14);
  buffer.writeUInt16BE(options.screenWidth & 0xffff, 18);
  buffer.writeUInt16BE(options.screenHeight & 0xffff, 20);
  buffer.writeUInt16BE(pressureToFixed(options.pressure), 22);
  buffer.writeInt32BE(options.actionButton || 0, 24);
  buffer.writeInt32BE(options.buttons || 0, 28);
  return buffer;
}

/**
 * 压力是 16 位定点：0xFFFF 表示 1.0，其余按 /65536。
 * 普通触摸固定 1.0，避免按压力度影响点击判定。
 */
function pressureToFixed(pressure) {
  if (pressure === undefined || pressure === null) return 0xffff;
  const clamped = Math.max(0, Math.min(1, pressure));
  return clamped >= 1 ? 0xffff : Math.round(clamped * 0xffff);
}

/** 键盘：type(1) action(1) keycode(4) repeat(4) metaState(4) = 14 */
function key(options) {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(TYPE.KEYCODE, 0);
  buffer.writeUInt8(options.action & 0xff, 1);
  buffer.writeInt32BE(options.keycode | 0, 2);
  buffer.writeInt32BE(options.repeat || 0, 6);
  buffer.writeInt32BE(options.metaState || 0, 10);
  return buffer;
}

/** 文本：type(1) length(4) utf8(length) */
function text(value) {
  const data = Buffer.from(String(value), 'utf8');
  const buffer = Buffer.alloc(5 + data.length);
  buffer.writeUInt8(TYPE.TEXT, 0);
  buffer.writeUInt32BE(data.length, 1);
  data.copy(buffer, 5);
  return buffer;
}

/** 滚动：type(1) x(4) y(4) w(2) h(2) hScroll(2 定点) vScroll(2 定点) buttons(4) = 21 */
function scroll(options) {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt8(TYPE.SCROLL, 0);
  buffer.writeInt32BE(options.x | 0, 1);
  buffer.writeInt32BE(options.y | 0, 5);
  buffer.writeUInt16BE(options.screenWidth & 0xffff, 9);
  buffer.writeUInt16BE(options.screenHeight & 0xffff, 11);
  buffer.writeInt16BE(scrollToFixed(options.hScroll), 13);
  buffer.writeInt16BE(scrollToFixed(options.vScroll), 15);
  buffer.writeInt32BE(options.buttons || 0, 17);
  return buffer;
}

/** 滚动量是 16 位定点：0x7FFF 表示 1.0，其余按 /32768。 */
function scrollToFixed(amount) {
  if (!amount) return 0;
  const clamped = Math.max(-1, Math.min(1, amount));
  return clamped >= 1 ? 0x7fff : Math.round(clamped * 0x7fff) || (clamped > 0 ? 1 : -1);
}

/** 返回/唤醒屏幕：type(1) action(1) = 2 */
function backOrScreenOn(action) {
  return Buffer.from([TYPE.BACK_OR_SCREEN_ON, action & 0xff]);
}

/** 无载荷消息（展开通知栏 / 展开设置 / 收起面板 / 旋转 / 重置视频）。 */
function empty(type) {
  return Buffer.from([type & 0xff]);
}

/** 开机后立刻要一个 IDR，避免等 10 秒的自然关键帧间隔。 */
function resetVideo() {
  return empty(TYPE.RESET_VIDEO);
}

module.exports = {
  TYPE,
  ACTION_DOWN,
  ACTION_UP,
  ACTION_MOVE,
  touch,
  key,
  text,
  scroll,
  backOrScreenOn,
  empty,
  resetVideo
};
