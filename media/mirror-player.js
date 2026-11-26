(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('screen');
  const overlay = document.getElementById('overlay');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let decoder = null;
  let config = null;
  let paramSets = null;
  let awaitingKey = true;
  let paused = true;
  let lastTs = -1;
  let videoWidth = 0;
  let videoHeight = 0;
  let dropped = 0;
  let resumeTimer = null;

  const KEYCODES = {
    Backspace: 67, Tab: 61, Enter: 66, NumpadEnter: 66, Escape: 111, Delete: 112,
    ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    Home: 3, End: 123, PageUp: 92, PageDown: 93,
    Space: 62, Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72,
    Backslash: 73, Semicolon: 74, Quote: 75, Comma: 55, Period: 56, Slash: 76,
    '`': 68, Insert: 124
  };
  const SHIFTED = {
    ')': 9, '!': 8, '@': 77, '#': 18, '$': 11, '%': 12, '^': 13, '&': 14, '*': 17,
    '(': 10, '~': 68, '{': 71, '}': 72, '|': 73, ':': 74, '"': 75, '<': 55, '>': 56, '?': 76, '_': 69, '+': 70
  };

  function keycodeFor(event) {
    if (KEYCODES[event.code]) return KEYCODES[event.code];
    if (event.code && event.code.indexOf('Numpad') === 0 && event.code.length === 7) {
      const digit = event.code.charAt(6);
      if (digit >= '0' && digit <= '9') return 131 + digit.charCodeAt(0) - 48;
    }
    const key = event.key;
    if (!key || key.length !== 1) return 0;
    if (SHIFTED[key]) return SHIFTED[key];
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return 29 + upper.charCodeAt(0) - 65;
    if (key >= '0' && key <= '9') return 7 + key.charCodeAt(0) - 48;
    return 0;
  }

  function send(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  function nextTimestamp(ptsUs) {
    lastTs = ptsUs > lastTs ? ptsUs : lastTs + 1;
    return lastTs;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function draw(frame) {
    try {
      failures = 0;
      if (!paused) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          videoWidth = frame.displayWidth;
          videoHeight = frame.displayHeight;
          send('mirror:size', { width: videoWidth, height: videoHeight });
        }
        ctx.drawImage(frame, 0, 0);
        hideOverlay();
      }
    } finally {
      frame.close();
    }
  }

  let failures = 0;

  function onDecoderError(error) {
    console.error('[mirror] decode error', error);
    failures++;
    // 连续失败说明流或解码器状态已经坏了，继续重建只会无限循环
    if (failures > 5) {
      send('mirror:unsupported', { reason: 'decode-failed', message: String(error && error.message ? error.message : error) });
      return;
    }
    send('mirror:error', { message: String(error && error.message ? error.message : error) });
    scheduleResume(Math.min(failures * 800, 4000));
  }

  function scheduleResume(delay) {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      rebuild();
      send('mirror:need-keyframe', {});
    }, delay);
  }

  function rebuild() {
    if (!config) {
      send('mirror:unsupported', { reason: 'missing-config' });
      return;
    }
    try {
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = new VideoDecoder({ output: draw, error: onDecoderError });
      decoder.configure(config);
      awaitingKey = true;
      lastTs = -1;
      showOverlay('解码器就绪，等待关键帧…');
    } catch (e) {
      send('mirror:unsupported', { reason: String(e && e.message ? e.message : e) });
      showOverlay('解码器初始化失败：' + String(e && e.message ? e.message : e));
    }
  }

  function configure(message) {
    paramSets = new Uint8Array(message.paramSets);
    config = {
      codec: message.codec,
      codedWidth: message.width,
      codedHeight: message.height,
      optimizeForLatency: true,
      hardwareAcceleration: 'no-preference'
      // 不传 description：这是 Annex-B 模式的开关，传了就必须是 avcC
    };
    paused = false;
    showOverlay('已收到编码参数（' + message.codec + '），正在初始化解码器…');
    if (typeof VideoDecoder === 'undefined') {
      send('mirror:unsupported', { reason: 'no-webcodecs' });
      showOverlay('当前环境不支持 WebCodecs');
      return;
    }
    VideoDecoder.isConfigSupported(config).then((support) => {
      if (!support.supported) {
        send('mirror:unsupported', { reason: 'codec-unsupported', codec: message.codec });
        showOverlay('解码器不支持该编码：' + message.codec);
        return;
      }
      rebuild();
    }).catch((e) => {
      send('mirror:unsupported', { reason: String(e && e.message ? e.message : e) });
      showOverlay('解码器探测失败：' + String(e && e.message ? e.message : e));
    });
  }

  function drawFrame(message) {
    if (paused || !config || !decoder || decoder.state !== 'configured') return;
    const key = !!message.key;
    if (awaitingKey && !key) { dropped++; return; }
    if (!key && decoder.decodeQueueSize > 2) { dropped++; return; }
    const payload = key && paramSets ? concat(paramSets, new Uint8Array(message.data)) : new Uint8Array(message.data);
    try {
      decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: nextTimestamp(message.ptsUs || 0),
        data: payload
      }));
      awaitingKey = false;
    } catch (e) {
      onDecoderError(e);
    }
  }

  function setPaused(next) {
    paused = next;
    if (next) {
      if (decoder && decoder.state === 'configured') decoder.reset();
      awaitingKey = true;
      showOverlay('已暂停');
    } else {
      hideOverlay();
    }
  }

  function showOverlay(text) {
    overlay.textContent = text;
    overlay.hidden = !text;
  }

  function hideOverlay() {
    overlay.hidden = true;
  }

  // 一眼能看出卡在哪一步：页面一直显示「正在连接设备…」说明脚本没执行（CSP/加载问题），
  // 显示「播放器已加载」说明脚本执行了但没收到流。
  showOverlay(
    typeof VideoDecoder === 'undefined'
      ? '播放器已加载，但当前环境没有 WebCodecs'
      : '播放器已加载，等待视频流…'
  );

  /* ---------------- 输入 ---------------- */

  function toDevice(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.round((event.clientX - rect.left) / rect.width * videoWidth);
    const y = Math.round((event.clientY - rect.top) / rect.height * videoHeight);
    if (x < 0 || y < 0 || x >= videoWidth || y >= videoHeight) return null;
    return { x, y };
  }

  let pointerDown = false;
  let pointerId = 1;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point = toDevice(event);
    if (!point) return;
    canvas.setPointerCapture(event.pointerId);
    pointerDown = true;
    send('mirror:touch', Object.assign({ action: 0, actionButton: 1, buttons: 1 }, point));
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!pointerDown) return;
    const point = toDevice(event);
    if (!point) return;
    send('mirror:touch', Object.assign({ action: 2, actionButton: 0, buttons: 1 }, point));
  });

  function releasePointer(event) {
    if (!pointerDown) return;
    pointerDown = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* 已释放 */ }
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) / rect.width * videoWidth);
    const y = Math.round((event.clientY - rect.top) / rect.height * videoHeight);
    send('mirror:touch', { action: 1, x, y, actionButton: 0, buttons: 0 });
  }

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = toDevice(event);
    if (!point) return;
    let h = 0;
    let v = 0;
    if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) v = event.deltaY > 0 ? 1 : -1;
    else h = event.deltaX > 0 ? 1 : -1;
    send('mirror:scroll', Object.assign({ hScroll: h, vScroll: v, buttons: 0 }, point));
  }, { passive: false });

  window.addEventListener('keydown', (event) => {
    const special = { F1: 131, F2: 132 };
    let keycode = keycodeFor(event);
    if (event.key === 'Escape') { event.preventDefault(); send('mirror:back', {}); return; }
    if (event.key === 'Home') { event.preventDefault(); send('mirror:key', { action: 0, keycode: 3 }); send('mirror:key', { action: 1, keycode: 3 }); return; }
    if (event.key === 'F2') { event.preventDefault(); send('mirror:key', { action: 0, keycode: 187 }); send('mirror:key', { action: 1, keycode: 187 }); return; }
    if (!keycode || special[event.key]) {
      if (special[event.key]) keycode = special[event.key];
      else return;
    }
    event.preventDefault();
    send('mirror:key', { action: 0, keycode, metaState: event.altKey ? 2 : event.shiftKey ? 1 : 0 });
    send('mirror:key', { action: 1, keycode, metaState: 0 });
  });

  /* ---------------- 消息 ---------------- */

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || !message.type) return;
    if (message.type === 'mirror:configure') configure(message);
    else if (message.type === 'mirror:frame') drawFrame(message);
    else if (message.type === 'mirror:pause') setPaused(true);
    else if (message.type === 'mirror:resume') { setPaused(false); scheduleResume(0); }
    else if (message.type === 'mirror:status') showOverlay(message.text || '');
  });

  if (typeof VideoDecoder === 'undefined') {
    send('mirror:unsupported', { reason: 'no-webcodecs' });
  } else {
    send('mirror:ready', {});
  }
})();
