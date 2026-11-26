'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { OperationTracker } = require('../operation');
const { discoverModules, moduleDirectory, discoverFlavors, findApk, apkInfo } = require('../project-info');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-runner-test-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(root,file)), {recursive:true}); fs.writeFileSync(path.join(root,file),content); };
  write('gradlew', '#!/bin/sh\n');
  write('settings.gradle.kts', 'include(":app", ":features:demo", ":library")\nproject(":features:demo").projectDir = file("demo-app")');
  write('app/build.gradle', 'plugins { id "com.android.application" }\nandroid { defaultConfig { applicationId "work.notto.base" } }');
  write('demo-app/build.gradle.kts', 'plugins { alias(libs.plugins.android.application) }\nandroid { defaultConfig { applicationId = "work.notto.demo" } }');
  write('library/build.gradle', 'plugins { id "com.android.library" }');
  write('local.properties', 'sdk.dir=' + path.join(root, 'sdk'));
  write('sdk/platform-tools/adb', '');
  write('sdk/emulator/emulator', '');
  write('gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip');
  return {root,write};
}

function metadata(f, module = 'app', variant = 'debug', pkg = 'work.notto.debug') {
  const dir = module + '/build/outputs/apk/' + variant;
  f.write(dir + '/app.apk', 'apk bytes');
  f.write(dir + '/output-metadata.json', JSON.stringify({variantName:variant,applicationId:pkg,elements:[{outputFile:'app.apk',filters:[]}]}));
}

test('module discovery supports nested/mapped apps and excludes Android libraries', (t) => {
  const f = fixture(t);
  assert.deepEqual(discoverModules(f.root), ['app','features:demo']);
  assert.equal(moduleDirectory(f.root, 'features:demo'), path.join(f.root,'demo-app'));
});

test('APK metadata resolves the exact variant and applicationId suffix', (t) => {
  const f = fixture(t);
  metadata(f);
  metadata(f, 'app', 'release', 'work.notto.release');
  const debug = findApk(f.root,'app','debug','');
  assert.equal(debug.applicationId, 'work.notto.debug');
  assert.equal(findApk(f.root,'app','release','').applicationId, 'work.notto.release');
  assert.equal(apkInfo(debug).size, 9);
  assert.equal(apkInfo(findApk(f.root,'app','missing','')), null);
});

test('flavored metadata and explicit APK paths resolve without mixing variants', (t) => {
  const f = fixture(t);
  f.write('app/build/outputs/apk/demo/debug/demo.apk', 'demo');
  f.write('app/build/outputs/apk/demo/debug/output-metadata.json', JSON.stringify({variantName:'demoDebug',applicationId:'work.notto.demo.debug',elements:[{outputFile:'demo.apk',filters:[]}]}));
  assert.equal(findApk(f.root,'app','demoDebug','').applicationId, 'work.notto.demo.debug');
  assert.equal(findApk(f.root,'app','debug','').applicationId, '');
  f.write('custom.apk','custom');
  assert.equal(findApk(f.root,'app','debug','custom.apk').path, path.join(f.root,'custom.apk'));
});

test('flavor discovery parses nested blocks and ignores DSL helpers and comments', (t) => {
  const f = fixture(t);
  f.write('app/build.gradle', [
    'android {',
    '  flavorDimensions "channel"',
    '  productFlavors {',
    '    official { dimension "channel"; applicationIdSuffix ".official" }',
    '    baidu { dimension "channel" }',
    '    create("_360") { dimension "channel" }',
    '    configureEach { /* 不是渠道 */ }',
    '  }',
    '  // productFlavors { commented { } }',
    '}'
  ].join('\n'));
  const result = discoverFlavors(f.root, 'app');
  assert.deepEqual(result.flavors.slice().sort(), ['_360', 'baidu', 'official'].sort());
  assert.equal(result.source, 'gradle');
  assert.equal(result.dimensionCount, 1);
  assert.equal(result.multiDimension, false);
});

test('flavor discovery falls back to built artifacts for dynamically generated flavors', (t) => {
  const f = fixture(t);
  f.write('app/build/outputs/apk/official/debug/app.apk', 'x');
  f.write('app/build/outputs/apk/baidu/debug/app.apk', 'x');
  const result = discoverFlavors(f.root, 'app');
  assert.equal(result.source, 'artifacts');
  assert.deepEqual(result.flavors.slice().sort(), ['baidu', 'official']);
});

test('declared flavors win over stale build artifacts', (t) => {
  const f = fixture(t);
  f.write('app/build.gradle', 'android { productFlavors { official { } } }');
  f.write('app/build/outputs/apk/official/debug/app.apk', 'x');
  f.write('app/build/outputs/apk/removed/debug/app.apk', 'x');
  assert.deepEqual(discoverFlavors(f.root, 'app').flavors, ['official']);
});

test('flavored APK lookup never falls back to the unflavored debug output', (t) => {
  const f = fixture(t);
  metadata(f);
  f.write('app/build/outputs/apk/official/debug/app.apk', 'official');
  f.write('app/build/outputs/apk/official/debug/output-metadata.json', JSON.stringify({variantName:'officialDebug',applicationId:'work.notto.official',elements:[{outputFile:'app.apk',filters:[]}]}));
  const found = findApk(f.root, 'app', 'debug', '', 'official');
  assert.equal(found.applicationId, 'work.notto.official');
  assert.ok(found.path.includes(path.join('official', 'debug')));
  const missing = findApk(f.root, 'app', 'debug', '', 'nonexistent');
  assert.equal(missing.path, '');
  assert.equal(missing.flavorMissing, true);
});

test('AGP 3.x output.json resolves the APK when no metadata exists', (t) => {
  const f = fixture(t);
  f.write('app/build/outputs/apk/debug/app-debug.apk', 'legacy');
  f.write('app/build/outputs/apk/debug/output.json', JSON.stringify([
    {apkData:{fullName:'debug',baseName:'debug',outputFile:'app-debug.apk'},path:'app-debug.apk'}
  ]));
  assert.equal(findApk(f.root,'app','debug','').path, path.join(f.root,'app/build/outputs/apk/debug/app-debug.apk'));
});

test('flavor drives the exact AGP task and unresolved flavors still run', async (t) => {
  const h = host(t);
  h.config.flavor = 'official';
  assert.equal(h.api.gradleTaskFor(), ':app:assembleOfficialDebug');
  h.config.flavor = '_360';
  assert.equal(h.api.gradleTaskFor(), ':app:assemble_360Debug');
  h.config.flavor = '';
  assert.equal(h.api.gradleTaskFor(), ':app:assembleDebug');

  // 多渠道工程里含 official 时按优先级自动选中，不需要用户干预
  h.write('app/build.gradle', 'plugins { id "com.android.application" }\nandroid { productFlavors { baidu { } official { } } }');
  h.api.resetCache();
  assert.equal(h.api.gradleTaskFor(), ':app:assembleOfficialDebug');

  // 多个渠道且都没有 official/dev：自动取第一个，保证「默认能跑起来」
  h.write('app/build.gradle', 'plugins { id "com.android.application" }\nandroid { productFlavors { baidu { } xiaoju { } } }');
  h.api.resetCache();
  assert.equal(h.api.gradleTaskFor(), ':app:assembleBaiduDebug');

  h.config.flavor = 'xiaoju';
  assert.equal(h.api.gradleTaskFor(), ':app:assembleXiaojuDebug');
});

const { createMirror } = require('../mirror.js');

test('scrcpy discovery prefers configured path, then PATH, then known install dirs', () => {
  const make = (present, lookupResult) => createMirror({
    exists: (target) => present.includes(target),
    lookup: () => lookupResult,
    spawn: () => ({})
  });
  assert.equal(make(['/custom/scrcpy'], '').findScrcpy('/custom/scrcpy'), '/custom/scrcpy');
  assert.equal(make(['/custom/scrcpy'], '').findScrcpy('/missing/scrcpy'), '');
  assert.equal(make(['/path/scrcpy'], '/path/scrcpy').findScrcpy(''), '/path/scrcpy');
  assert.equal(createMirror({exists:()=>false, lookup:()=>'', spawn:()=>{}}).findScrcpy(''), '');
});

test('scrcpy arguments carry the device serial and user extras', () => {
  const m = createMirror({exists:()=>false, lookup:()=>'', spawn:()=>{}});
  assert.equal(m.buildArgs({serial:'S1', title:'Phone (S1)', extraArgs:['--stay-awake']}).join(' '), '-s S1 --window-title Phone (S1) --stay-awake');
  assert.equal(m.buildArgs({}).length, 0);
  assert.ok(m.installHint().length > 0);
});

test('pipeline records real stage boundaries and freezes finished durations', async () => {
  let now = 1000;
  const states = [];
  const tracker = new OperationTracker(() => states.push(tracker.snapshot()), () => now);
  await tracker.run('run', [['build','编译'],['install','安装'],['launch','启动']], async (step) => {
    for (const key of ['build','install','launch']) assert(await step(key,async () => { now += 500; return true; }));
    return true;
  });
  assert.equal(tracker.state.status,'success');
  assert.deepEqual(tracker.state.steps.map(s => s.endedAt - s.startedAt),[500,500,500]);
  assert.equal(tracker.state.endedAt,2500);
  assert(states.some(s => s.steps[1].status === 'running' && s.steps[0].status === 'success'));
});

test('failure stops later steps; cancellation stays distinct from failure', async () => {
  const tracker = new OperationTracker(() => {});
  await tracker.run('run',[['build','编译'],['install','安装']], async step => step('build',async () => ({ok:false,cancelled:true})));
  assert.equal(tracker.state.status,'cancelled');
  assert.equal(tracker.state.steps[1].status,'pending');
  await assert.rejects(tracker.run('install',[['install','安装']], async step => step('install',async () => {throw Error('device disconnected');})), /device disconnected/);
  assert.equal(tracker.state.status,'failed');
  assert.equal(tracker.state.steps[0].detail,'device disconnected');
});

function host(t, options = {}) {
  const f = fixture(t);
  metadata(f);
  const config = {module:'app',flavor:'',buildVariant:'debug',scrcpyPath:'',scrcpyArgs:['--stay-awake'],mirrorMode:options.mirrorMode||'window',javaHome:f.root,autoCreateLocalProperties:false,pollIntervalMs:60000};
  const values = new Map();
  const calls = [];
  const messages = [];
  const notifications = [];
  let connected = ['USB-A'];
  let buildProc;
  const vscode = {
    workspace: {
      workspaceFolders:[{uri:{fsPath:f.root}}],
      getConfiguration: (_, resource) => {
        assert.equal(resource.fsPath,f.root);
        return {get:key=>config[key],update:async(key,value,target)=>{assert.equal(target,3);config[key]=value;}};
      }
    },
    ConfigurationTarget:{WorkspaceFolder:3},
    ProgressLocation:{Notification:1},
    window: {
      showErrorMessage: async (...args) => {notifications.push(args[0]);},
      showWarningMessage: async (...args) => {notifications.push(args[0]);},
      showInformationMessage: async () => {},
      withProgress: async (_, callback) => callback({report:()=>{}},{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})})
    },
    ThemeColor: class {},
    commands:{executeCommand:async()=>{}}
  };
  const cp = {
    execFileSync: () => '',
    execFile: (file,args,opts,callback) => {
      calls.push({file,args});
      let text=''; let error=null;
      if(args[0]==='devices') text='List of devices attached\n'+connected.map(s=>s+' device model:Phone').join('\n');
      else if(args.includes('-list-avds')) text='Pixel_Test\n';
      else if(args.includes('emu')) text='Pixel_Test\nOK\n';
      else if(args.includes('sys.boot_completed')) text='1';
      else if(args.includes('ro.product.model')) text='Test Phone';
      else if(args.includes('ro.build.version.release')) text='15';
      else if(args.includes('install')) {text=options.installFails?'Failure [INSTALL_FAILED_TEST]':'Success';if(options.installFails)error=Error('install failed');}
      else if(args.includes('resolve-activity')) text='work.notto.debug/.MainActivity';
      else if(args.includes('start')) text=options.launchFails?'Error: Activity not found':'Starting: Intent';
      else if(args.includes('monkey')) {text='No activities found to run, monkey aborted.';error=Error('no launcher');}
      queueMicrotask(()=>callback(error,text,''));
    },
    spawn: (file,args,opts) => {
      calls.push({file,args});
      const proc = new EventEmitter(); proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();proc.pid=99999999;proc.unref=()=>{};
      if(file.endsWith('gradlew')) {
        buildProc=proc;
        if(options.onBuild) options.onBuild(config);
        if(!options.holdBuild) setImmediate(()=>{proc.stdout.emit('data',Buffer.from('BUILD SUCCESSFUL'));proc.emit('close',options.buildFails?1:0,null);});
      } else if(file.endsWith('emulator')) {
        connected = ['USB-NEW','emulator-5554'];
      }
      return proc;
    }
  };
  const actualRequire = createRequire(path.join(__dirname,'../extension.js'));
  const { createMirror } = actualRequire('./mirror.js');
  const mirrorStub = createMirror({
    exists: (target) => !options.noScrcpy && !!target,
    lookup: () => (options.noScrcpy ? '' : (options.scrcpyPath || '/usr/local/bin/scrcpy')),
    spawn: (file, args, opts) => {
      calls.push({file, args, opts});
      const proc = new EventEmitter();
      proc.kill = () => {};
      return proc;
    }
  });
  const mirrorRequire = (name) => {
    if (name === './mirror.js') return mirrorStub;
    if (name === './mirror/panel.js') return { MirrorPanel: class { dispose() {} } };
    // 内嵌会话依赖真实设备，单测里固定失败，用来验证模式分发与回退
    if (name === './mirror/scrcpy.js') {
      return { ScrcpySession: class { async start() { throw new Error('session unavailable in tests'); } stop() {} } };
    }
    return actualRequire(name);
  };
  const context = {require:(name)=>name==='vscode'?vscode:name==='child_process'?cp:name==='./webview.js'?{RunnerViewProvider:class{}}:mirrorRequire(name),module:{exports:{}},console,process:{...process,kill:()=>{}},Buffer,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,global:{}};
  vm.createContext(context);
  const source=fs.readFileSync(path.join(__dirname,'../extension.js'),'utf8');
  vm.runInContext(source+`\nextensionContext = __context; output = {append(){},appendLine(){},show(){}}; viewProvider = {postRuntime:(state)=>__messages.push(JSON.parse(JSON.stringify(state))),push(){}}; module.exports.test = {collectViewState,commandRun,commandBuildOnly,commandInstallOnly,commandCancel,handleViewAction,updateBuildConfiguration,chooseDevice,resolvePackage,gradleTaskFor,resetCache,configurationKey,operations};`,Object.assign(context,{__context:{extensionUri:{fsPath:f.root},workspaceState:{get:(key,fallback)=>values.get(key)||fallback,update:async(key,value)=>values.set(key,value)}},__messages:messages}));
  const api=context.module.exports.test;
  return {...f,api,config,calls,messages,values,notifications,disconnect:()=>{connected=['USB-B'];},reconnect:()=>{connected=['USB-A'];},finishBuild:()=>buildProc.emit('close',0,null)};
}

test('host run emits build → install → launch and uses the variant metadata package',async(t)=>{
  const h=host(t);
  await h.api.commandRun();
  assert.equal(h.api.operations.state.status,'success');
  assert.equal(h.api.operations.state.packageName,'work.notto.debug');
  assert(h.calls.some(c=>c.args.includes('install') && c.args.includes('-r')));
  assert(h.calls.some(c=>c.args.includes('start') && c.args.includes('work.notto.debug/.MainActivity')));
  assert(h.messages.some(s=>s.operation && s.operation.steps[1].status==='running'));
});

test('flavored run builds and installs only the selected flavor', async (t) => {
  const h = host(t);
  h.write('app/build.gradle', 'plugins { id "com.android.application" }\nandroid { defaultConfig { applicationId "work.notto.base" } productFlavors { official { } baidu { } } }');
  h.write('app/build/outputs/apk/official/debug/app-official.apk', 'official-bytes');
  h.write('app/build/outputs/apk/official/debug/output-metadata.json', JSON.stringify({variantName:'officialDebug',applicationId:'work.notto.base.official',elements:[{outputFile:'app-official.apk',filters:[]}]}));
  h.api.resetCache();
  await h.api.commandRun();
  assert.equal(h.api.operations.state.status, 'success');
  const gradle = h.calls.find((c) => c.file && c.file.endsWith('gradlew'));
  assert.equal(gradle.args.join(' '), ':app:assembleOfficialDebug');
  const install = h.calls.find((c) => c.args.includes('install'));
  assert.ok(install.args.some((arg) => arg.includes('official')));
  assert.equal(h.api.operations.state.packageName, 'work.notto.base.official');
});

test('multi-dimension flavors degrade to plain debug and still install a package', async (t) => {
  const h = host(t);
  h.write('app/build.gradle', 'android { flavorDimensions "color", "size"\n productFlavors { red { dimension "color" } blue { dimension "color" } big { dimension "size" } } }');
  // 多维度产物是 outputs/apk/<f1>/<f2>/<variant>/
  fs.rmSync(path.join(h.root, 'app/build/outputs/apk/debug'), {recursive:true, force:true});
  h.write('app/build/outputs/apk/red/big/debug/app.apk', 'redbig');
  h.write('app/build/outputs/apk/red/big/debug/output-metadata.json', JSON.stringify({variantName:'redBigDebug',applicationId:'work.notto.red',elements:[{outputFile:'app.apk',filters:[]}]}));
  h.api.resetCache();
  assert.equal(h.api.gradleTaskFor(), ':app:assembleDebug');
  await h.api.commandRun();
  assert.equal(h.api.operations.state.status, 'success');
  const install = h.calls.find((c) => c.args.includes('install'));
  assert.ok(install.args.some((arg) => arg.includes(path.join('red', 'big', 'debug'))));
});

test('installation and launch failures remain attributed to their own stages',async(t)=>{
  const h=host(t,{installFails:true});
  await h.api.commandRun();
  assert.equal(h.api.operations.state.steps[1].status,'failed');
  assert.equal(h.api.operations.state.steps[2].status,'pending');
  assert(!h.calls.some(c=>c.args.includes('start')));
  const launch=host(t,{launchFails:true});
  await launch.api.commandRun();
  assert.equal(launch.api.operations.state.steps[2].status,'failed');
});

test('nonzero Gradle exit cannot become success from a success-looking log line',async(t)=>{
  const h=host(t,{buildFails:true});
  await h.api.commandRun();
  assert.equal(h.api.operations.state.steps[0].status,'failed');
  assert(!h.calls.some(c=>c.args.includes('install')));
});

test('configuration switches mapped modules and prevents stale fixed overrides',async(t)=>{
  const h=host(t);
  await h.api.updateBuildConfiguration({field:'module',value:'features:demo'});
  assert.equal(h.api.gradleTaskFor(),':features:demo:assembleDebug');
  assert.equal(h.api.resolvePackage(),'work.notto.demo');
  await h.api.updateBuildConfiguration({field:'buildVariant',value:'release'});
  assert.equal(h.api.gradleTaskFor(),':features:demo:assembleRelease');
  h.config.apkPath='fixed.apk';
  await assert.rejects(h.api.updateBuildConfiguration({field:'buildVariant',value:'debug'}),/固定配置/);
  await assert.rejects(h.api.updateBuildConfiguration({field:'module',value:'../../bad'}));
});

test('workspace device selection survives reload, disconnects without fallback and restores on reconnect',async(t)=>{
  const h=host(t);
  await h.api.handleViewAction('selectDevice',{serial:'USB-A'});
  assert.equal(h.values.get('devicesByProject')[h.root].serial,'USB-A');
  h.api.resetCache();
  h.disconnect();
  const disconnected=await h.api.collectViewState();
  assert.equal(disconnected.current,null);
  assert.equal(disconnected.preferredDisconnected,true);
  assert.equal(await h.api.chooseDevice(false),null);
  h.reconnect();
  assert.equal((await h.api.collectViewState()).current.serial,'USB-A');
});

test('active runs freeze their configuration and reject concurrent actions; manual cancel is cancelled',async(t)=>{
  const h=host(t,{holdBuild:true,onBuild:config=>{config.buildVariant='release';}});
  const running=h.api.commandRun();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.api.gradleTaskFor(),':app:assembleDebug');
  await assert.rejects(h.api.handleViewAction('setConfiguration',{field:'buildVariant',value:'release'}),/任务/);
  await h.api.commandCancel();
  h.finishBuild();
  await running;
  assert.equal(h.api.operations.state.status,'cancelled');
  assert.equal(h.api.gradleTaskFor(),':app:assembleRelease');
  assert(!h.calls.some(c=>c.args.includes('install')));
});

test('mirror launches scrcpy for the selected device and passes the adb path', async (t) => {
  const h = host(t, {scrcpyPath:'/opt/bin/scrcpy'});
  await h.api.handleViewAction('mirror');
  const spawned = h.calls.find((c) => c.file === '/opt/bin/scrcpy');
  assert.ok(spawned, 'scrcpy spawned');
  assert.ok(spawned.args.includes('-s'));
  assert.ok(spawned.args.includes('USB-A'));
  assert.ok(spawned.args.includes('--stay-awake'));
  assert.ok(spawned.opts.env.ADB, 'adb path injected via ADB env');
});

test('mirror explains how to install scrcpy when it is missing', async (t) => {
  const h = host(t, {noScrcpy:true});
  await h.api.handleViewAction('mirror');
  assert.ok(h.notifications.some((n) => n && n.includes('未找到 scrcpy')));
  assert(!h.calls.some((c) => c.file && c.file.includes('scrcpy')));
});

test('mirror mode dispatch honours panel/window/auto', async (t) => {
  // 指定 panel 且启动失败：明确报错，不能悄悄换成窗口
  const panel = host(t, {mirrorMode:'panel'});
  await panel.api.handleViewAction('mirror');
  assert.ok(panel.notifications.some((n) => n && n.includes('内嵌投屏不可用')));
  assert(!panel.calls.some((c) => c.file && c.file.includes('scrcpy')));

  // auto 且内嵌失败：回退到外部窗口
  const auto = host(t, {mirrorMode:'auto', scrcpyPath:'/opt/bin/scrcpy'});
  await auto.api.handleViewAction('mirror');
  assert.ok(auto.calls.some((c) => c.file === '/opt/bin/scrcpy'));
});

test('AVD startup selects only the named emulator after boot completion, ignoring a new USB device',async(t)=>{
  const h=host(t);
  await h.api.handleViewAction('startAvd',{name:'Pixel_Test'});
  assert.equal(h.values.get('devicesByProject')[h.root].serial,'emulator-5554');
  assert(h.calls.some(c=>c.args.includes('sys.boot_completed')));
  assert(h.messages.some(s=>s.avdStartup && s.avdStartup.name==='Pixel_Test'));
});
