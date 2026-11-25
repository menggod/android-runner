'use strict';

const fs = require('fs');
const path = require('path');

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function settingsText(root) {
  return (read(path.join(root, 'settings.gradle')) + '\n' + read(path.join(root, 'settings.gradle.kts')))
    .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
}

function moduleDirectory(root, module) {
  const text = settingsText(root);
  const mappings = /project\s*\(\s*['"]([^'"]+)['"]\s*\)\.projectDir\s*=\s*(?:new\s+File\s*\(\s*(?:rootDir|settingsDir)\s*,|file\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(mappings)) {
    if (match[1].replace(/^:/, '') === module.replace(/^:/, '')) return path.resolve(root, match[2]);
  }
  return path.join(root, ...module.replace(/^:/, '').split(':'));
}

/** Static discovery avoids executing Gradle just to draw a selector. */
function discoverModules(root, configured = 'app') {
  if (!root) return [configured];
  const candidates = new Set([configured]);
  let declared = false;
  for (const include of settingsText(root).matchAll(/\binclude\s*(?:\(([^)]*)\)|([^\n;]+))/g)) {
    for (const match of (include[1] || include[2] || '').matchAll(/['"](:?[\w:.-]+)['"]/g)) {
      candidates.add(match[1].replace(/^:/, ''));
      declared = true;
    }
  }
  try {
    for (const entry of declared ? [] : fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) candidates.add(entry.name);
    }
  } catch (_) { /* root may have been removed */ }
  return Array.from(candidates).filter((module) => {
    if (module === configured) return true;
    const dir = moduleDirectory(root, module);
    const source = read(path.join(dir, 'build.gradle')) + read(path.join(dir, 'build.gradle.kts'));
    return /com\.android\.application|libs\.plugins\.android\.application|\bapplicationId\b/.test(source);
  }).sort((a, b) => a.localeCompare(b));
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/* ------------------------------------------------------------------ */
/* 多渠道（productFlavors）探测                                         */
/* ------------------------------------------------------------------ */

/** 去掉注释，字符串内容原样保留，避免把注释里的示例渠道当成真实声明。 */
function stripComments(text) {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next || '';
        i++;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 返回 text 中 openIndex 处左花括号所配对的块内容；未闭合返回空串。 */
function blockAt(text, openIndex) {
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return '';
}

/** Gradle DSL 上的同名方法，不是渠道名。 */
const FLAVOR_DSL_WORDS = new Set([
  'configureEach', 'all', 'each', 'create', 'register', 'maybeCreate', 'getByName', 'getAt',
  'withType', 'matching', 'named', 'whenObjectAdded', 'whenObjectRemoved'
]);

/** 收集 productFlavors 块内顶层的渠道名，兼容 official { } 与 create("official") 两种写法。 */
function collectFlavorNames(block, names) {
  const add = (name) => {
    if (!name || FLAVOR_DSL_WORDS.has(name)) return;
    if (!/^[\w$.-]+$/.test(name)) return;
    if (!names.some((item) => item.toLowerCase() === name.toLowerCase())) names.push(name);
  };
  for (const match of block.matchAll(/\b(?:create|register|maybeCreate|getByName)\s*\(\s*['"]([^'"]+)['"]/g)) {
    add(match[1].trim());
  }
  let depth = 0;
  let quote = '';
  let word = '';
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word = '';
      continue;
    }
    if (ch === '{') {
      if (depth === 0) add(word.trim());
      word = '';
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      word = '';
      continue;
    }
    if (depth === 0) {
      if (/[\w$]/.test(ch)) {
        word += ch;
      } else if (!/\s/.test(ch)) {
        word = '';
      }
    }
  }
  return names;
}

/** 静态解析模块 build.gradle(.kts) 里声明的渠道。 */
function declaredFlavors(source) {
  const names = [];
  for (const match of source.matchAll(/\bproductFlavors\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    collectFlavorNames(blockAt(source, open), names);
  }
  return names;
}

const NOT_FLAVOR_DIRS = new Set(['debug', 'release', 'androidtest', 'test', 'rebuildchannel', 'channel']);

/** 已构建过的工程可以从产物目录反推动态生成的渠道。 */
function artifactFlavors(root, module) {
  const base = path.join(moduleDirectory(root, module), 'build', 'outputs', 'apk');
  const names = [];
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return names; }
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!entry.isDirectory() || lower.startsWith('.') || NOT_FLAVOR_DIRS.has(lower)) continue;
    try {
      const children = fs.readdirSync(path.join(base, entry.name), { withFileTypes: true });
      if (children.some((child) => child.isDirectory() && NOT_FLAVOR_DIRS.has(child.name.toLowerCase()))) {
        names.push(entry.name);
      }
    } catch (_) { /* 目录可能正在被 Gradle 重建 */ }
  }
  return names;
}

/** 统计 flavorDimensions 的维度数；未声明时用各 flavor 的 dimension 值兜底。 */
function dimensionCount(source, flavors) {
  const names = new Set();
  for (const match of source.matchAll(/\bflavorDimensions\b[^\n]*/g)) {
    for (const literal of match[0].matchAll(/['"]([^'"]+)['"]/g)) names.add(literal[1].toLowerCase());
  }
  if (names.size) return names.size;
  for (const match of source.matchAll(/\bdimension\s*=?\s*['"]([^'"]+)['"]/g)) names.add(match[1].toLowerCase());
  return names.size || (flavors.length > 1 ? 1 : 0);
}

/** 产物目录里出现 apk/<a>/<b>/<debug|release>/ 即为多维度组合，单看声明可能漏掉动态生成的维度。 */
function hasMultiDimensionOutputs(root, module) {
  const base = path.join(moduleDirectory(root, module), 'build', 'outputs', 'apk');
  let first = [];
  try { first = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return false; }
  for (const entry of first) {
    if (!entry.isDirectory() || NOT_FLAVOR_DIRS.has(entry.name.toLowerCase())) continue;
    let children = [];
    try { children = fs.readdirSync(path.join(base, entry.name), { withFileTypes: true }); } catch (_) { continue; }
    for (const child of children) {
      if (child.isDirectory() && !NOT_FLAVOR_DIRS.has(child.name.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * 识别多渠道工程：静态解析优先（无需构建），解析不到才用产物反推（应对循环生成的动态渠道）。
 * 两者不做合并——残留的构建产物不该改变一个已经声明清楚的工程。
 */
function discoverFlavors(root, module) {
  if (!root) return { flavors: [], source: 'none', dimensionCount: 0, multiDimension: false };
  const dir = moduleDirectory(root, module);
  const declared = [];
  let dimensions = 0;
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const raw = read(path.join(dir, file));
    if (!raw) continue;
    const source = stripComments(raw);
    const names = declaredFlavors(source);
    declared.push(...names);
    dimensions = Math.max(dimensions, dimensionCount(source, names));
  }
  const unique = (names) => {
    const result = [];
    for (const name of names) {
      if (!result.some((item) => item.toLowerCase() === name.toLowerCase())) result.push(name);
    }
    return result;
  };
  const flavors = declared.length ? unique(declared) : unique(artifactFlavors(root, module));
  const source = declared.length ? 'gradle' : flavors.length ? 'artifacts' : 'none';
  return {
    flavors,
    source,
    dimensionCount: dimensions,
    multiDimension: dimensions >= 2 || hasMultiDimensionOutputs(root, module)
  };
}

/* ------------------------------------------------------------------ */
/* APK 定位                                                            */
/* ------------------------------------------------------------------ */

/**
 * 定位 APK。
 * flavor 非空时只看包含该渠道的产物目录，绝不回退到无渠道的 outputs/apk/<variant>——
 * 那是旧包，装上会掩盖真实的定位失败。
 * relaxed 用于多维度渠道（产物是 f1/f2/<variant>）：精确匹配失败后接受任一以 variant 结尾的产物，
 * 保证这种情况下仍能装上一个包，而不是直接报错。
 */
function findApk(root, module, variant, explicit, flavor, relaxed) {
  if (!root) return null;
  if (explicit) return { path: path.resolve(root, explicit), applicationId: '' };
  variant = (variant || 'debug').trim();
  flavor = (flavor || '').trim();
  const full = flavor ? capitalize(flavor) + capitalize(variant) : variant;
  const base = path.join(moduleDirectory(root, module), 'build', 'outputs', 'apk');
  const inFlavor = (file) => !flavor || path.relative(base, path.resolve(file)).split(path.sep)
    .some((part) => part.toLowerCase() === flavor.toLowerCase());
  const matches = (name) => {
    const lower = String(name || '').toLowerCase();
    return !!lower && (lower === full.toLowerCase() || (!!flavor && lower === (flavor + variant).toLowerCase()));
  };
  const candidates = [];
  const loose = [];
  const collect = (list, file, applicationId, universal) => {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(base + path.sep) || !inFlavor(resolved)) return;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        list.push({ path: resolved, applicationId: applicationId || '', universal, modifiedAt: stat.mtimeMs });
      }
    } catch (_) { /* Gradle may be replacing outputs while the sidebar refreshes. */ }
  };
  const visit = (dir, depth) => {
    if (depth > 4) return;
    // AGP 4+ 的产物清单
    const metadata = read(path.join(dir, 'output-metadata.json'));
    if (metadata) {
      try {
        const data = JSON.parse(metadata);
        const exact = matches(data.variantName);
        const near = !exact && relaxed && String(data.variantName || '').toLowerCase().endsWith(variant.toLowerCase());
        if (exact || near) {
          for (const element of data.elements || []) {
            if (!element.outputFile || !/\.apk$/i.test(element.outputFile)) continue;
            collect(exact ? candidates : loose, path.resolve(dir, element.outputFile), data.applicationId, !(element.filters || []).length);
          }
        }
      } catch (_) { /* incomplete metadata during build */ }
    }
    // AGP 3.x 的产物清单是 output.json（数组）
    const legacy = read(path.join(dir, 'output.json'));
    if (legacy) {
      try {
        const list = JSON.parse(legacy);
        for (const item of Array.isArray(list) ? list : []) {
          const apkData = item.apkData || {};
          const name = apkData.fullName || apkData.baseName || item.outputFile;
          const exact = matches(name);
          const near = !exact && relaxed && String(name || '').toLowerCase().endsWith(variant.toLowerCase());
          if (!exact && !near) continue;
          const relative = item.path || apkData.outputFile;
          if (relative) collect(exact ? candidates : loose, path.resolve(dir, relative), '', true);
        }
      } catch (_) { /* incomplete metadata during build */ }
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(path.join(dir, entry.name), depth + 1);
      }
    } catch (_) { /* not built yet */ }
  };
  visit(base, 0);
  const newest = (list) => list.slice().sort((a, b) => Number(b.universal) - Number(a.universal) || b.modifiedAt - a.modifiedAt)[0];
  if (candidates.length) {
    return newest(candidates);
  }
  if (loose.length) {
    return newest(loose);
  }
  // 目录回退：多渠道工程的自定义输出目录不一定写元数据
  const dirs = flavor ? [path.join(base, flavor, variant), path.join(base, flavor)] : [path.join(base, variant)];
  for (const dir of dirs) {
    try {
      const apks = fs.readdirSync(dir).filter((file) => /\.apk$/i.test(file)).map((file) => path.join(dir, file));
      apks.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (apks.length) return { path: apks[0], applicationId: '' };
    } catch (_) { /* missing output */ }
  }
  if (flavor) return { path: '', applicationId: '', flavorMissing: true };
  return { path: path.join(base, variant, module.split(':').pop() + '-' + variant + '.apk'), applicationId: '' };
}

function apkInfo(candidate) {
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate.path);
    return stat.isFile() ? { path: candidate.path, name: path.basename(candidate.path), size: stat.size, modifiedAt: stat.mtimeMs } : null;
  } catch (_) { return null; }
}

module.exports = { discoverModules, moduleDirectory, discoverFlavors, findApk, apkInfo };
