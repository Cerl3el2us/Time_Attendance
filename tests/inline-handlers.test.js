// Every inline handler must call a function that actually exists (2026-09-28).
//
// This frontend wires its UI with inline attributes -- `onclick="openOTModal()"` in index.html and
// in the HTML strings app.js builds. There are hundreds of them, and JavaScript has no compile step,
// so a handler naming a function that does not exist fails ONLY when a user clicks that control, in
// production, with a bare "X is not defined" in the console.
//
// This suite reads every handler attribute out of both files, pulls out the functions they call, and
// asserts each one is defined in app.js. It is cheap insurance today, and it is the safety net that
// makes a future split of app.js into several files checkable instead of hopeful: the moment a moved
// function stops being reachable by name, this fails.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// Language keywords and host/browser globals a handler may legitimately name. Anything else has to
// be a function this app defines.
const NOT_OURS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'else', 'do',
  'delete', 'void', 'in', 'of', 'instanceof', 'try', 'finally', 'throw', 'case', 'break', 'continue',
  'alert', 'confirm', 'prompt', 'console', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'JSON', 'Math', 'Date', 'RegExp', 'Set', 'Map', 'Promise', 'Error', 'isNaN',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'document', 'window', 'event', 'this', 'fetch', 'encodeURIComponent', 'decodeURIComponent',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history', 'FormData', 'URL', 'Blob',
  // CSS value syntax, not JavaScript: handlers that tweak `this.style` carry things like
  // `background='rgba(0,0,0,.1)'` and `transform='scale(1.02)'`.
  'rgba', 'rgb', 'hsl', 'hsla', 'scale', 'scaleX', 'scaleY', 'translate', 'translateX', 'translateY',
  'rotate', 'calc', 'var', 'url', 'blur', 'brightness', 'saturate', 'opacity',
]);

// Identifiers that are CALLED inside a handler body: `name(` not preceded by a dot (so `a.b()` and
// `this.x()` are method calls on a value, not a bare global we need to resolve).
function calledNames(code) {
  const out = new Set();
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[2];
    if (!NOT_OURS.has(name)) out.add(name);
  }
  return out;
}

// Handler attributes in a source file. The value may be single- or double-quoted; app.js builds its
// HTML inside template literals, so its attributes are usually double-quoted inside backticks.
function handlersIn(src) {
  const found = [];
  const re = /\son([a-z]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Skip things that are not DOM event attributes (e.g. a stray `one=` in prose).
    if (!/^(click|change|input|submit|keydown|keyup|keypress|focus|blur|mouseover|mouseout|mouseenter|mouseleave|load|error|scroll|paste|dblclick|contextmenu|wheel|toggle)$/.test(m[1])) continue;
    // Skip handlers written inside a comment: app.js documents this very pattern in prose above
    // escapeJsAttr(), and that example is not code anyone can click.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index).trim();
    if (before.startsWith('//') || before.startsWith('*')) continue;
    found.push({ event: m[1], code: m[3], index: m.index });
  }
  return found;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Everything app.js exposes by name at the top level: function declarations plus top-level
// const/let/var bindings (an arrow function assigned to a const is callable from a handler too).
function definedNames(src) {
  const out = new Set();
  let m;
  const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = fnRe.exec(src)) !== null) out.add(m[1]);
  const varRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = varRe.exec(src)) !== null) out.add(m[1]);
  const winRe = /^\s*window\.([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = winRe.exec(src)) !== null) out.add(m[1]);
  return out;
}

const DEFINED = definedNames(APP_SRC);
const htmlHandlers = handlersIn(HTML_SRC);
const appHandlers = handlersIn(APP_SRC);

console.log(`Inline handlers — ${htmlHandlers.length} in index.html, ${appHandlers.length} built in app.js`);

test('index.html and app.js still wire the UI through inline handlers', () => {
  // If this ever drops to zero the suite is silently checking nothing -- most likely the attribute
  // shape changed and the parser needs updating, not that the handlers are gone.
  assert.ok(htmlHandlers.length > 100, `only ${htmlHandlers.length} handlers found in index.html`);
  assert.ok(appHandlers.length > 50, `only ${appHandlers.length} handlers found in app.js`);
});

function checkAll(handlers, src, label) {
  const missing = [];
  handlers.forEach(h => {
    calledNames(h.code).forEach(name => {
      if (!DEFINED.has(name)) {
        missing.push(`${label}:${lineOf(src, h.index)} on${h.event} calls ${name}()`);
      }
    });
  });
  return missing;
}

test('the checker itself actually catches a broken handler', () => {
  // A guard that has never been seen to fail is not a guard. Feed it a handler naming a function
  // that does not exist and one that does, and confirm it reports exactly the broken one.
  const fake = '<button onclick="thisFunctionDoesNotExist_9182()">x</button>\n' +
               '<button onclick="openOTModal()">y</button>';
  const found = checkAll(handlersIn(fake), fake, 'fake');
  assert.strictEqual(found.length, 1, `expected exactly one failure, got ${JSON.stringify(found)}`);
  assert.ok(found[0].includes('thisFunctionDoesNotExist_9182'), found[0]);
});

test('every function an index.html handler calls is defined in app.js', () => {
  const missing = checkAll(htmlHandlers, HTML_SRC, 'index.html');
  assert.strictEqual(missing.length, 0, `\n      ${missing.join('\n      ')}`);
});

test('every function a handler built by app.js calls is defined in app.js', () => {
  const missing = checkAll(appHandlers, APP_SRC, 'app.js');
  assert.strictEqual(missing.length, 0, `\n      ${missing.join('\n      ')}`);
});

console.log(`\n${passed} passed`);
