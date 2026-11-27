(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const icon = window.runnerIcon;
  const saved = vscode.getState() || {};
  let state = null;
  let listOpen = !!saved.listOpen;
  let pendingAction = '';
  let pendingConfiguration = null;
  let earlyRuntime = null;
  const $ = (id) => document.getElementById(id);
  const pendingLabels = { run: '正在运行…', install: '正在安装…', restart: '正在重启…', build: '正在编译…', cleanBuild: '正在清理并编译…', startAvd: '正在启动模拟器…' };

  ['envDetails', 'manageDetails'].forEach((id) => {
    $(id).open = !!saved[id];
    $(id).addEventListener('toggle', persist);
  });

  function persist() {
    vscode.setState({ listOpen, envDetails: $('envDetails').open, manageDetails: $('manageDetails').open });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'state') {
      state = Object.assign({}, msg.state, earlyRuntime || {});
      earlyRuntime = null;
      render();
    } else if (msg.type === 'runtime') {
      if (state) { state = Object.assign({}, state, msg.runtime); render(); }
      else earlyRuntime = msg.runtime;
    } else if (msg.type === 'actionComplete' && msg.action === pendingAction) {
      pendingAction = '';
      pendingConfiguration = null;
      render();
    }
  });

  document.addEventListener('change', (event) => {
    const field = event.target.id === 'moduleSelect' ? 'module'
      : event.target.id === 'variantSelect' ? 'buildVariant'
      : event.target.id === 'flavorInput' ? 'flavor'
      : null;
    if (!field || pendingAction || hostBusy()) return;
    const value = field === 'flavor' ? String(event.target.value || '').trim() : event.target.value;
    if (field === 'flavor' && value === ((state.configuration || {}).flavor || '')) return;
    pendingConfiguration = { field, value };
    pendingAction = 'setConfiguration';
    render();
    vscode.postMessage({ type: 'setConfiguration', ...pendingConfiguration });
  });

  function hostBusy() { return !!state && (!!state.building || !!state.avdStartup || !!(state.operation && state.operation.status === 'running')); }

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const action = el.getAttribute('data-action');
    if (action === 'toggleList') {
      listOpen = !listOpen;
      persist();
      render();
      $('deviceToggle').focus();
      return;
    }
    if ((pendingAction || hostBusy()) && !['cancel', 'showOutput', 'settings', 'toggleList', 'mirror'].includes(action)) return;
    const message = { type: action };
    if (action === 'selectDevice') {
      message.serial = el.getAttribute('data-serial');
      listOpen = false;
      persist();
    }
    if (action === 'startAvd') message.name = el.getAttribute('data-name');
    if (!['cancel', 'showOutput', 'settings'].includes(action)) pendingAction = action;
    render();
    if (action === 'selectDevice' && $('deviceToggle')) $('deviceToggle').focus();
    vscode.postMessage(message);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'flavorInput') {
      event.target.blur();
      return;
    }
    if (event.key === 'Escape' && listOpen) {
      listOpen = false;
      persist();
      render();
      const toggle = $('deviceToggle');
      if (toggle) toggle.focus();
    }
  });

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function deviceList(devices, avds, standalone) {
    const ready = devices.filter((d) => d.state === 'device');
    const bad = devices.filter((d) => d.state !== 'device');
    let html = '';
    if (ready.length) {
      const ordered = ready.slice().sort((a, b) => Number(a.isEmulator) - Number(b.isEmulator));
      let group = '';
      for (const d of ordered) {
        const label = d.isEmulator ? '已启动的模拟器' : '真机';
        if (label !== group) { html += '<div class="list-label">' + label + '</div>'; group = label; }
        const active = state.current && d.serial === state.current.serial;
        html += '<button class="device-row' + (active ? ' active' : '') + '" data-action="selectDevice" data-serial="' + esc(d.serial) + '" aria-pressed="' + !!active + '"' + (pendingAction || hostBusy() ? ' disabled' : '') + '>' +
          icon(d.isEmulator ? 'monitor' : 'phone') + '<span class="row-main"><strong>' + esc(d.model || d.serial) + '</strong><small>' + esc(d.serial) + '</small></span>' + (active ? icon('check') : '') + '</button>';
      }
    }
    if (bad.length) {
      html += '<div class="list-label">需要处理</div>';
      for (const d of bad) {
        const hint = d.state === 'unauthorized' ? '请在手机上允许 USB 调试' : d.state === 'offline' ? '设备离线，请重新连接 USB' : d.state;
        html += '<div class="device-row">' + icon('warning') + '<span class="row-main"><strong>' + esc(d.model || d.serial) + '</strong><small>' + esc(hint) + '</small></span></div>';
      }
    }
    if (avds.length) {
      html += '<div class="list-label">可启动的模拟器</div>';
      for (const name of avds) {
        html += '<button class="device-row" data-action="startAvd" data-name="' + esc(name) + '"' + (pendingAction || hostBusy() ? ' disabled' : '') + '>' + icon('monitor') +
          '<span class="row-main" title="' + esc(name) + '"><strong>' + esc(name) + '</strong></span><span class="row-tag">启动</span>' + icon('play') + '</button>';
      }
    }
    return html ? '<div id="deviceList" class="device-list' + (standalone ? ' standalone' : '') + '">' + html + '</div>' : '';
  }

  function deviceHtml() {
    if (!state.isProject) {
      return '<div class="device-card empty-card">' + icon('folder') + '<strong class="empty-title">打开 Android 工程</strong><span class="empty-hint">请打开包含 gradlew 的项目目录<br>设备与构建环境将在这里自动识别</span></div>';
    }
    const cur = state.current;
    const devices = state.devices || [];
    const avds = state.avds || [];
    if (!cur) {
      const title = state.error ? '无法连接 adb' : state.preferredDisconnected ? '目标设备已断开' : '连接你的设备';
      const hint = state.error ? '检查 SDK 与 adb 配置后重试' : state.preferredDisconnected ? esc((state.preferredDevice || {}).model) + '<br>重新连接后将自动恢复选择<br>也可在下方切换到其他设备' : '通过 USB 连接并开启「USB 调试」<br>也可以启动下方的模拟器';
      return '<div class="device-card empty-card">' + icon(state.error ? 'warning' : 'phone') + '<strong class="empty-title">' + title + '</strong><span class="empty-hint">' + hint + '</span><button class="text-btn" data-action="refresh"' + (pendingAction ? ' disabled' : '') + '>' + icon('refresh') + '重新检测</button></div>' + deviceList(devices, avds, true);
    }
    const running = cur.appRunning;
    const appLabel = !state.packageName ? '包名未识别' : running ? '应用运行中' : '应用未运行';
    return '<button id="deviceToggle" class="device-card" data-action="toggleList" aria-label="选择目标设备：' + esc(cur.model || cur.serial) + '" aria-expanded="' + listOpen + '"' + (listOpen ? ' aria-controls="deviceList"' : '') + '>' +
      '<span class="device-head"><span class="device-glyph">' + icon(cur.isEmulator ? 'monitor' : 'phone') + '</span><span class="device-text"><strong class="device-name" title="' + esc(cur.model || cur.serial) + '">' + esc(cur.model || cur.serial) + '</strong><span class="device-sub">' +
      (cur.isEmulator ? '模拟器' : '真机') + (cur.android ? '<span class="separator">/</span>Android ' + esc(cur.android) : '') + '</span></span>' + icon('chevron', 'device-chevron') + '</span>' +
      '<span class="device-bottom"><span class="device-serial" title="' + esc(cur.serial) + '">' + esc(cur.serial) + '</span><span class="app-state' + (running ? ' on' : '') + '"><span class="dot' + (running ? '' : ' off') + '"></span>' + appLabel + '</span></span></button>' +
      (listOpen ? deviceList(devices, avds, false) : '');
  }

  function duration(start, end) {
    if (end && end - start < 1000) return '<1秒';
    const seconds = Math.max(0, Math.floor(((end || Date.now()) - start) / 1000));
    return seconds >= 60 ? Math.floor(seconds / 60) + '分' + seconds % 60 + '秒' : seconds + '秒';
  }

  function elapsed(start, end, className) {
    return '<span class="' + (className || '') + '" data-start="' + Number(start) + '" data-end="' + Number(end || 0) + '">' + duration(start, end) + '</span>';
  }

  function updateElapsed() {
    document.querySelectorAll('[data-start]').forEach((el) => {
      const text = duration(Number(el.dataset.start), Number(el.dataset.end));
      if (el.textContent !== text) el.textContent = text;
    });
  }

  function statusHtml() {
    if (state.avdStartup) {
      const startup = state.avdStartup;
      return { kind: 'building', html: icon('monitor') + '<div class="status-copy"><strong>' + (startup.phase === 'booting' ? '等待 Android 启动完成' : '正在启动模拟器') + '</strong><span>' + esc(startup.name) + '</span></div>' + elapsed(startup.startedAt, 0, 'operation-time') + '<div class="bar" role="progressbar" aria-label="等待模拟器就绪"></div>' };
    }
    if (pendingAction === 'setConfiguration') {
      return { kind: 'building', html: icon('settings') + '<div class="status-copy"><strong>正在切换构建配置…</strong><span>同步任务、包名与 APK</span></div>' };
    }
    const operation = state.operation;
    const config = state.configuration || {};
    if (operation && operation.configKey === config.key) {
      const running = operation.status === 'running';
      const failed = operation.steps.find((step) => step.status === 'failed' || step.status === 'cancelled');
      const active = operation.steps.find((step) => step.status === 'running');
      const successTitles = { run: '已安装并启动', build: '编译成功', cleanBuild: '已清理并编译成功', install: '安装成功', launch: '应用已启动', restart: '应用已重启' };
      const title = running ? active ? '正在' + active.label + '…' : '正在准备运行…' : operation.status === 'success' ? successTitles[operation.kind] || '任务完成' : operation.status === 'cancelled' ? (failed ? failed.label : '任务') + '已取消' : (failed ? failed.label : '任务') + '失败';
      const steps = operation.steps.map((step) => '<div class="operation-step ' + esc(step.status) + '">' + icon(step.status === 'success' ? 'check' : step.status === 'failed' ? 'warning' : step.status === 'cancelled' ? 'close' : step.status === 'running' ? 'clock' : 'info') + esc(step.label) + '<small>' + (step.startedAt ? elapsed(step.startedAt, step.endedAt) : '等待') + '</small></div>').join('');
      const detail = operation.detail || (failed && failed.detail) || (active && active.key === 'build' ? state.buildTask : operation.deviceLabel) || (running ? '等待选择设备或任务开始' : 'Gradle 构建');
      const outputLink = operation.status === 'failed' || operation.status === 'cancelled' ? '<button class="text-btn" data-action="showOutput">查看详细输出 ' + icon('chevron') + '</button>' : '';
      return { kind: 'status-operation ' + (running ? 'building' : operation.status === 'success' ? 'ok' : operation.status === 'cancelled' ? 'idle' : 'err'), html: '<div class="operation-steps" aria-label="运行阶段">' + steps + '</div>' + icon(running ? 'clock' : operation.status === 'success' ? 'check' : 'warning') + '<div class="status-copy"><strong>' + esc(title) + '</strong><span>' + esc(detail) + '</span>' + outputLink + '</div>' + elapsed(operation.startedAt, operation.endedAt, 'operation-time') + (running ? '<div class="bar" role="progressbar" aria-label="任务进行中"></div>' : '') };
    }
    if (state.error) return { kind: 'err', html: icon('warning') + '<div class="status-copy"><strong>设备连接异常</strong><span>' + esc(state.error) + '</span></div>' };
    if (state.building || pendingLabels[pendingAction]) {
      return { kind: 'building', html: icon('clock') + '<div class="status-copy"><strong>' + (state.building ? '正在编译…' : pendingLabels[pendingAction]) + '</strong><span>' + esc(state.buildTask || '') + '</span></div><div class="bar" role="progressbar" aria-label="任务进行中"></div>' };
    }
    if (state.lastBuild && state.lastBuild.configKey === config.key) {
      return { kind: state.lastBuild.ok ? 'ok' : 'err', html: icon(state.lastBuild.ok ? 'check' : 'warning') + '<div class="status-copy"><strong>' + (state.lastBuild.ok ? '最近编译成功' : state.lastBuild.cancelled ? '编译已取消' : '最近编译失败') + '</strong><span>' + esc(state.lastBuild.task) + '</span></div>' };
    }
    return { kind: 'idle', html: icon('clock') + '<div class="status-copy"><strong>等待运行</strong><span>' + (state.isProject ? '选择配置与设备，即可开始' : '打开 Android 工程即可开始') + '</span></div>' };
  }

  function flavorNote(config) {
    const flavors = config.flavors || [];
    if (config.flavorMultiDimension) {
      return '检测到多维度渠道，组合名无法静态推断，暂按 assembleDebug 构建（会编译全部组合）；可在「渠道」中指定一个渠道名。';
    }
    if (config.flavorAuto) {
      return '检测到多个渠道，已默认使用「' + esc(config.resolvedFlavor) + '」；可在「渠道」中切换。';
    }
    if (config.flavorUnknown) {
      return '未识别到 productFlavors，将按 assembleDebug 构建；若工程有多渠道，可手动填写渠道名。';
    }
    const chosen = (config.flavor || '').toLowerCase();
    if (config.flavorSource === 'configured' && flavors.length && !flavors.some((name) => name.toLowerCase() === chosen)) {
      return '已指定渠道「' + esc(config.flavor) + '」，但未在工程中识别到，请确认拼写。';
    }
    return '';
  }

  function configurationHtml() {
    const config = state.configuration || { module: 'app', variant: 'debug', modules: ['app'], variants: ['debug', 'release'] };
    [['moduleSelect', config.modules, config.module, 'module'], ['variantSelect', config.variants, config.variant, 'buildVariant']].forEach(([id, options, selected, field]) => {
      const html = options.map((value) => '<option value="' + esc(value) + '">' + esc(field === 'buildVariant' ? value.charAt(0).toUpperCase() + value.slice(1) : value) + '</option>').join('');
      updateHtml(id, html);
      $(id).value = pendingConfiguration && pendingConfiguration.field === field ? pendingConfiguration.value : selected;
      $(id).disabled = !state.isProject || hostBusy() || !!pendingAction || config.locked;
    });
    // 渠道：datalist 下拉 + 自由输入，留空表示自动
    const flavorInput = $('flavorInput');
    if (document.activeElement !== flavorInput) {
      const pending = pendingConfiguration && pendingConfiguration.field === 'flavor';
      flavorInput.value = pending ? pendingConfiguration.value : (config.flavor || '');
    }
    flavorInput.placeholder = config.resolvedFlavor || '自动';
    flavorInput.disabled = !state.isProject || hostBusy() || !!pendingAction || config.locked;
    updateHtml('flavorOptions', (config.flavors || []).map((name) => '<option value="' + esc(name) + '"></option>').join(''));
    const note = flavorNote(config);
    $('flavorNote').hidden = !note;
    updateHtml('flavorNote', note);
    $('packageLabel').textContent = state.packageName || '包名未识别';
    $('packageLabel').title = state.packageName || '可在扩展设置中指定 applicationId';
    $('taskLabel').textContent = (state.env || {}).task || '';
    $('taskLabel').title = (state.env || {}).task || '';
    $('configNote').hidden = !config.locked;
    updateHtml('configNote', config.locked ? '已固定' + esc((config.overrides || []).join(' / ')) + '，切换前请先调整<button class="text-btn" data-action="settings">扩展设置</button>' : '');
  }

  function apkHtml() {
    const apk = state.apk;
    if (!apk) return '<div class="apk-heading">' + icon('download') + '<span class="apk-name">尚无可安装的 APK</span></div><div class="apk-meta">编译完成后显示文件信息</div>';
    const operation = state.operation;
    const installed = operation && operation.kind === 'install' && operation.status === 'success' && state.current && operation.deviceSerial === state.current.serial && operation.configKey === (state.configuration || {}).key && !!state.packageName;
    return '<div class="apk-heading">' + icon('download') + '<span class="apk-name" title="' + esc(apk.path) + '">' + esc(apk.name) + '</span><span class="meta">' + (apk.size / 1024 / 1024).toFixed(1) + ' MB</span></div><div class="apk-meta" title="文件修改时间">' + esc(new Date(apk.modifiedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })) + ' 构建</div>' + (installed ? '<button class="text-btn apk-launch" data-action="launch">' + icon('play') + '启动应用</button>' : '');
  }

  function envHtml() {
    const env = state.env || {};
    const rows = [
      ['SDK', env.sdk, '未探测到'], ['JDK', env.jdk, '未探测到'],
      ['Gradle', env.gradle, '未识别'], ['任务', env.task, '未识别'],
      ['包名', state.packageName, '未识别'], ['APK', env.apk, '尚未构建']
    ];
    return rows.map(([key, value, fallback]) => {
      const display = key === 'APK' && value ? value.split(/[\\/]/).pop() : value;
      return '<div class="env-row"><span class="env-key">' + key + '</span><span class="env-val' + (value ? '' : ' missing') + '" title="' + esc(value || fallback) + '">' + esc(display || fallback) + '</span></div>';
    }).join('');
  }

  function updateHtml(id, html) {
    if ($(id).innerHTML !== html) $(id).innerHTML = html;
  }

  function render() {
    if (!state) return;
    // Keep keyboard focus in the device picker when a polling update changes its markup.
    const focus = document.activeElement;
    const focusedAction = focus && $('deviceArea').contains(focus) && focus.getAttribute('data-action');
    const focusedKey = focusedAction && (focus.getAttribute('data-serial') || focus.getAttribute('data-name') || '');
    updateHtml('deviceArea', deviceHtml());
    if (focusedAction) {
      const replacement = Array.from($('deviceArea').querySelectorAll('[data-action]')).find((el) =>
        el.getAttribute('data-action') === focusedAction && (el.getAttribute('data-serial') || el.getAttribute('data-name') || '') === focusedKey);
      if (replacement && !replacement.disabled) replacement.focus();
    }
    $('deviceArea').setAttribute('aria-busy', 'false');
    configurationHtml();
    updateHtml('envBody', envHtml());
    updateHtml('apkSection', apkHtml());
    const status = statusHtml();
    $('statusBox').className = 'status ' + status.kind;
    updateHtml('statusBox', status.html);
    const hasDevice = !!state.current;
    const busy = hostBusy() || !!pendingAction;
    const project = !!state.isProject;
    const hasPackage = !!state.packageName;
    const disabled = {
      runBtn: !project || !hasDevice || busy,
      buildBtn: !project || busy,
      cleanBtn: !project || busy,
      installBtn: !project || !hasDevice || !state.apk || busy,
      stopBtn: !hasDevice || !hasPackage || busy,
      restartBtn: !hasDevice || !hasPackage || busy,
      logcatBtn: !hasDevice || busy,
      mirrorBtn: !hasDevice,
      doctorBtn: busy,
      uninstallBtn: !hasDevice || !hasPackage || busy,
      clearDataBtn: !hasDevice || !hasPackage || busy,
      refreshBtn: busy
    };
    Object.keys(disabled).forEach((id) => { $(id).disabled = disabled[id]; });
    $('installBtn').title = state.apk ? '安装已有 APK，保留应用数据' : '尚无可安装的 APK，请先编译';
    $('refreshBtn').classList.toggle('spinning', pendingAction === 'refresh');
    $('cancelBtn').hidden = !state.building;
    const activeStep = state.operation && state.operation.status === 'running' && state.operation.steps.find((step) => step.status === 'running');
    $('runLabel').textContent = activeStep ? '正在' + activeStep.label + '…' : state.building ? '正在编译…' : pendingAction === 'run' ? '正在运行…' : '运行到设备';
    $('runHint').innerHTML = !project ? '请先打开 Android 工程' : !hasDevice ? '连接设备后即可运行 · 也可单独编译' : '编译 <span>→</span> 安装 <span>→</span> 启动';
    const count = (state.devices || []).filter((d) => d.state === 'device').length;
    $('deviceCount').textContent = count ? count + ' 台已连接' : project ? '未连接' : '未检测';
    const env = state.env || {};
    const found = [env.sdk, env.jdk, env.gradle].filter(Boolean).length;
    $('envSummary').textContent = found === 3 ? '已识别' : found + '/3 已识别';
    $('versionLabel').textContent = state.version ? 'v' + state.version : 'Android tools';
  }

  setInterval(updateElapsed, 1000);
  vscode.postMessage({ type: 'ready' });
})();
