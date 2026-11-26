'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findNalUnits, nalType, avc1CodecString } = require('../mirror/h264');
const control = require('../mirror/control');

test('NAL splitter accepts three- and four-byte start codes', () => {
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x33, 0xac]);
  const pps = Buffer.from([0x68, 0xee, 0x3c]);
  const stream = Buffer.concat([
    Buffer.from([0, 0, 0, 1]), sps,
    Buffer.from([0, 0, 1]), pps
  ]);
  const nals = findNalUnits(stream);
  assert.equal(nals.length, 2);
  assert.deepEqual(Array.from(nals[0]), Array.from(sps));
  assert.deepEqual(Array.from(nals[1]), Array.from(pps));
  assert.equal(nalType(nals[0]), 7);
  assert.equal(nalType(nals[1]), 8);
});

test('codec string is derived from SPS profile/level, not hardcoded', () => {
  // 实测华为设备：67 64 00 33 -> High / 5.1
  assert.equal(avc1CodecString(Buffer.from([0x67, 0x64, 0x00, 0x33])), 'avc1.640033');
  // Baseline 3.0
  assert.equal(avc1CodecString(Buffer.from([0x67, 0x42, 0x00, 0x1e])), 'avc1.42001E');
  // Level 1b 特例
  assert.equal(avc1CodecString(Buffer.from([0x67, 0x42, 0x10, 0x0b])), 'avc1.42101b');
  assert.throws(() => avc1CodecString(Buffer.from([0x68, 0x00, 0x00, 0x00])), /SPS/);
});

test('touch message matches the 32-byte wire format', () => {
  const buffer = control.touch({
    action: control.ACTION_DOWN,
    pointerId: 7,
    x: 300,
    y: 1200,
    screenWidth: 1220,
    screenHeight: 2700,
    pressure: 1,
    actionButton: 0,
    buttons: 1
  });
  assert.equal(buffer.length, 32);
  assert.equal(buffer.readUInt8(0), 2);
  assert.equal(buffer.readUInt8(1), 0);
  assert.equal(buffer.readBigInt64BE(2), 7n);
  assert.equal(buffer.readInt32BE(10), 300);
  assert.equal(buffer.readInt32BE(14), 1200);
  assert.equal(buffer.readUInt16BE(18), 1220);
  assert.equal(buffer.readUInt16BE(20), 2700);
  assert.equal(buffer.readUInt16BE(22), 0xffff, 'pressure 1.0 is 0xFFFF');
  assert.equal(buffer.readInt32BE(24), 0);
  assert.equal(buffer.readInt32BE(28), 1);
});

test('key message matches the 14-byte wire format', () => {
  const buffer = control.key({ action: control.ACTION_DOWN, keycode: 4, repeat: 0, metaState: 0 });
  assert.equal(buffer.length, 14);
  assert.equal(buffer.readUInt8(0), 0);
  assert.equal(buffer.readUInt8(1), 0);
  assert.equal(buffer.readInt32BE(2), 4);
  assert.equal(buffer.readInt32BE(6), 0);
  assert.equal(buffer.readInt32BE(10), 0);
});

test('scroll message matches the 21-byte wire format', () => {
  const buffer = control.scroll({ x: 10, y: 20, screenWidth: 1220, screenHeight: 2700, vScroll: 1, buttons: 0 });
  assert.equal(buffer.length, 21);
  assert.equal(buffer.readUInt8(0), 3);
  assert.equal(buffer.readInt32BE(1), 10);
  assert.equal(buffer.readInt32BE(5), 20);
  assert.equal(buffer.readUInt16BE(9), 1220);
  assert.equal(buffer.readUInt16BE(11), 2700);
  assert.equal(buffer.readInt16BE(13), 0);
  assert.equal(buffer.readInt16BE(15), 0x7fff, 'scroll 1.0 is 0x7FFF');
  assert.equal(buffer.readInt32BE(17), 0);
});

test('text and single-byte messages carry the documented payload', () => {
  const text = control.text('你好');
  assert.equal(text.length, 5 + Buffer.byteLength('你好'));
  assert.equal(text.readUInt8(0), 1);
  assert.equal(text.readUInt32BE(1), Buffer.byteLength('你好'));
  assert.equal(text.subarray(5).toString('utf8'), '你好');

  assert.deepEqual(Array.from(control.resetVideo()), [17]);
  assert.deepEqual(Array.from(control.backOrScreenOn(0)), [4, 0]);
  assert.deepEqual(Array.from(control.empty(control.TYPE.COLLAPSE_PANELS)), [7]);
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPanel() {
  const source = fs.readFileSync(path.join(__dirname, '../mirror/panel.js'), 'utf8');
  const vscodeMock = {
    Uri: { joinPath: (...parts) => ({ path: parts.map((p) => (p && p.path) || p).join('/') }) },
    ViewColumn: { Beside: -2 },
    window: { createWebviewPanel: () => ({ webview: {}, onDidDispose() {}, onDidChangeViewState() {} }) }
  };
  const context = {
    require: (name) => {
      if (name === 'vscode') return vscodeMock;
      if (name === './control') return require('../mirror/control.js');
      if (name === './h264') return require('../mirror/h264.js');
      return require(name);
    },
    module: { exports: {} },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Math
  };
  vm.createContext(context);
  vm.runInContext(source + '\nmodule.exports.__renderHtml = renderHtml;', context);
  return context.module.exports;
}

test('mirror panel html wires the canvas, player script and a nonce that matches CSP', () => {
  const panel = loadPanel();
  const html = panel.__renderHtml({
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri) => `https://webview${uri.path}`
  }, { path: '/ext' });
  assert.ok(html.includes('id="screen"'), 'canvas present');
  assert.ok(html.includes('mirror-player.js'), 'player script referenced');
  assert.ok(html.includes('mirror.css'), 'stylesheet referenced');
  const cspNonce = /script-src 'nonce-([^']+)'/.exec(html);
  const scriptNonce = /<script nonce="([^"]+)"/.exec(html);
  assert.ok(cspNonce && scriptNonce, 'nonce present in both places');
  assert.equal(cspNonce[1], scriptNonce[1], 'CSP nonce must match the script tag');
});
