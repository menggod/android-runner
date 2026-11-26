'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VideoStreamParser, randomScid } = require('../mirror/scrcpy');

const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const SESSION_FLAG = 0x80000000;

/** 视频头：1 字节 dummy + 64 字节设备名 + 4 字节 codec id = 69 */
function header(name = 'LNA-AL00', codec = 'h264') {
  const buf = Buffer.alloc(69);
  buf[0] = 0;
  buf.write(name, 1, 'utf8');
  buf.write(codec, 65, 'ascii');
  return buf;
}

/** session 包：4 字节 flag + 4 字节宽 + 4 字节高 = 12 */
function session(width, height) {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(SESSION_FLAG, 0);
  buf.writeUInt32BE(width, 4);
  buf.writeUInt32BE(height, 8);
  return buf;
}

function frame(data, { config = false, keyFrame = false, pts = 0 } = {}) {
  const buf = Buffer.alloc(12 + data.length);
  let raw = BigInt(Math.round(pts * 1000000));
  if (config) raw |= FLAG_CONFIG;
  if (keyFrame) raw |= FLAG_KEY_FRAME;
  buf.writeBigUInt64BE(raw, 0);
  buf.writeUInt32BE(data.length, 8);
  data.copy(buf, 12);
  return buf;
}

test('video parser reads header, session and frames across arbitrary chunk boundaries', () => {
  const parser = new VideoStreamParser();
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33]);
  const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee]);
  const stream = Buffer.concat([
    header(),
    session(1220, 2700),
    frame(sps, { config: true }),
    frame(pps, { keyFrame: true, pts: 1.5 })
  ]);

  const items = [];
  for (let i = 0; i < stream.length; i += 7) {
    items.push(...parser.push(stream.slice(i, i + 7)));
  }

  assert.equal(items[0].type, 'header');
  assert.equal(items[0].header.deviceName, 'LNA-AL00');
  assert.equal(items[0].header.codecId, 'h264');

  assert.equal(items[1].type, 'session');
  assert.equal(items[1].width, 1220);
  assert.equal(items[1].height, 2700);
  assert.equal(items[0].header.width, 1220, 'header mirrors the latest session size');

  assert.equal(items[2].type, 'frame');
  assert.equal(items[2].config, true);
  assert.equal(items[2].keyFrame, false);
  assert.deepEqual(Array.from(items[2].data), Array.from(sps));

  assert.equal(items[3].keyFrame, true);
  assert.equal(items[3].config, false);
  assert.equal(items[3].pts, 1.5);
});

test('mid-stream session packets are consumed instead of derailing frame parsing', () => {
  const parser = new VideoStreamParser();
  const first = frame(Buffer.from([0, 0, 0, 1, 0x67]), { config: true });
  const afterReset = frame(Buffer.from([0, 0, 0, 1, 0x65]), { keyFrame: true });

  const items = [];
  items.push(...parser.push(Buffer.concat([header(), session(1220, 2700), first])));
  // 编码器重启（resetVideo / 旋转）后 server 会在流中间再发一个 session 包
  items.push(...parser.push(Buffer.concat([session(2700, 1220), afterReset])));

  const sessions = items.filter((item) => item.type === 'session');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].width, 2700);
  assert.equal(sessions[1].height, 1220);

  const frames = items.filter((item) => item.type === 'frame');
  assert.equal(frames.length, 2, 'the trailing frame must still parse after a session packet');
  assert.deepEqual(Array.from(frames[1].data), [0, 0, 0, 1, 0x65]);
});

test('video parser waits for a complete frame instead of emitting partial data', () => {
  const parser = new VideoStreamParser();
  const payload = Buffer.from([1, 2, 3, 4, 5, 6]);
  const whole = frame(payload);
  assert.equal(parser.push(header()).length, 1);
  assert.equal(parser.push(session(1080, 1920)).length, 1);
  assert.equal(parser.push(whole.slice(0, 12)).length, 0);
  assert.equal(parser.push(whole.slice(12, 15)).length, 0);
  const rest = parser.push(whole.slice(15));
  assert.equal(rest.length, 1);
  assert.deepEqual(Array.from(rest[0].data), [1, 2, 3, 4, 5, 6]);
});

test('random scid stays inside the hex-safe int range', () => {
  for (let i = 0; i < 500; i++) {
    const value = randomScid();
    assert.ok(value >= 1 && value <= 0x3fffffff);
    assert.ok(Number.isInteger(parseInt(value.toString(16), 16)));
  }
});
