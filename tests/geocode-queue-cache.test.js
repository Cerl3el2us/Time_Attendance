// Reverse-geocode queue and cache (2026-10-17). No framework: `node tests/geocode-queue-cache.test.js`.
//
// Why this file exists. The address beside a GPS link never appeared on the live site, and the
// console blamed CORS. It was HTTP 429: the app asked Nominatim for the SAME coordinates on every
// single render, out of one office IP, because reverseGeocode() wrote its cache inside .then() and
// so remembered successes only. Every refusal was retried forever, which kept the rate limit alive
// that caused the refusals. Measured the same day: with the flood stopped, the same coordinates
// answered 200 with real addresses from the same network.
//
// None of that is visible from reading the code, and the browser cannot prove it either -- a
// coordinate asked twice looks exactly like a coordinate asked once, and the failure only shows up
// as a number in a network log. So the promises are pinned here instead:
//   - one request per unique coordinate, however many renders ask for it
//   - requests spaced by the usage policy's 1 request/second
//   - refusals remembered too, but with an expiry, so one rate-limited minute never blanks a place
//   - the cache survives a refresh, because the quota counts per IP and this office shares one
//   - every localStorage access survives a browser that refuses it
//
// Same approach as tests/checkout-review.test.js: the code is extracted from the real
// attendance/js/app.js and run in a sandbox, so this cannot drift from what ships.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

function balancedFrom(src, start, label) {
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${label}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found in app.js`);
  return balancedFrom(src, m.index, name);
}
// Declarations are taken verbatim rather than restated, so renaming one here fails loudly instead
// of silently testing a copy that no longer matches the app.
function extractDecl(src, name) {
  const m = new RegExp(`^(?:const|let) ${name}\\b[^\\n]*$`, 'm').exec(src);
  if (!m) throw new Error(`declaration ${name} not found in app.js`);
  return m[0].replace(/^(const|let) /, 'var ');
}
function numericConst(name) {
  const m = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(APP_SRC);
  if (!m) throw new Error(`const ${name} not found in app.js`);
  // eslint-disable-next-line no-new-func
  return Function(`return (${m[1]})`)();
}

const DECLS = ['GEO_MIN_INTERVAL_MS', 'GEO_FAIL_LIMIT', 'GEO_PAUSE_MS', 'GEO_RETRY_AFTER_MS',
  'GEO_ADDRESS_TTL_MS', 'GEO_STORE_KEY', 'GEO_STORE_MAX', 'geoStore', 'geoStoreLoaded',
  'geoPending', 'geoQueue', 'geoQueueTimer', 'geoLastSentAt', 'geoConsecutiveFails', 'geoPausedUntil'];
const FNS = ['loadGeoStore', 'saveGeoStore', 'geoKnown', 'rememberGeo', 'reverseGeocode',
  'settleGeo', 'runGeoQueue'];

const REAL_INTERVAL_MS = numericConst('GEO_MIN_INTERVAL_MS');
const GEO_FAIL_LIMIT = numericConst('GEO_FAIL_LIMIT');
const GEO_RETRY_AFTER_MS = numericConst('GEO_RETRY_AFTER_MS');
const GEO_PAUSE_MS = numericConst('GEO_PAUSE_MS');
const TEST_INTERVAL_MS = 10;   // the spacing is asserted against the real value separately

// A localStorage that behaves like the real one, or refuses, on demand.
function makeStorage(opts) {
  const o = opts || {};
  const data = Object.assign({}, o.seed);
  return {
    store: data,
    writes: 0,
    getItem(k) { if (o.throwOnRead) throw new Error('read refused'); return k in data ? data[k] : null; },
    setItem(k, v) { this.writes++; if (o.throwOnWrite) throw new Error('quota exceeded'); data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
}

// One sandbox = one page load. `storage` is passed in so a second sandbox can be given the first
// one's storage, which is what "survives a refresh" means.
function load(storage, fetchImpl) {
  const calls = [];
  const ctx = {
    console,
    localStorage: storage,
    setTimeout,
    clearTimeout,
    Date,
    fetch: (url) => { calls.push({ url, at: Date.now() }); return fetchImpl(url); },
  };
  vm.createContext(ctx);
  const src = [
    ...DECLS.map(n => extractDecl(APP_SRC, n)),
    ...FNS.map(n => extractFunction(APP_SRC, n)),
  ].join('\n')
    // Only the wait between requests is shortened; everything else runs as written.
    .replace(`var GEO_MIN_INTERVAL_MS = ${REAL_INTERVAL_MS};`, `var GEO_MIN_INTERVAL_MS = ${TEST_INTERVAL_MS};`);
  if (!src.includes(`var GEO_MIN_INTERVAL_MS = ${TEST_INTERVAL_MS};`)) {
    throw new Error('could not shorten GEO_MIN_INTERVAL_MS for the test');
  }
  vm.runInContext(src, ctx);
  return { ctx, calls };
}

const ok = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({ display_name: 'Somewhere, Bangkok, Thailand' }) });
const refused = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.reject(new Error('html')) });
const noName = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'Unable to geocode' }) });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Asks for every coordinate and resolves once all callbacks have fired.
function askAll(ctx, coords) {
  return Promise.all(coords.map(([lat, lng]) => new Promise(res => {
    ctx.reverseGeocode(lat, lng, (text, isAddress) => res({ text, isAddress }));
  })));
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; }
}

const OFFICE = [
  [13.724704, 100.550299],
  [13.724489, 100.550333],
  [13.722165, 100.519368],
];

(async () => {
  console.log('reverse-geocode queue and cache');

  await test('the usage policy is still encoded: at least 1 second between requests', () => {
    assert.ok(REAL_INTERVAL_MS >= 1000,
      `GEO_MIN_INTERVAL_MS is ${REAL_INTERVAL_MS}ms; Nominatim allows at most 1 request/second`);
  });

  await test('one request per unique coordinate, not one per asker', async () => {
    const { ctx, calls } = load(makeStorage(), ok);
    // Two renders asking for the same three coordinates, the second starting before the first
    // has finished -- the shape that used to double every request.
    const first = askAll(ctx, OFFICE);
    const second = askAll(ctx, OFFICE);
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(calls.length, OFFICE.length, `sent ${calls.length} requests for ${OFFICE.length} coordinates`);
    assert.strictEqual(new Set(calls.map(c => c.url)).size, OFFICE.length, 'a URL was requested twice');
    assert.ok(a.every(r => r.isAddress) && b.every(r => r.isAddress), 'both askers must get the address');
  });

  await test('requests are spaced, never sent as a burst', async () => {
    const { ctx, calls } = load(makeStorage(), ok);
    await askAll(ctx, OFFICE);
    for (let i = 1; i < calls.length; i++) {
      assert.ok(calls[i].at - calls[i - 1].at >= TEST_INTERVAL_MS,
        `requests ${i} and ${i + 1} were ${calls[i].at - calls[i - 1].at}ms apart`);
    }
  });

  await test('a second render asks for nothing', async () => {
    const { ctx, calls } = load(makeStorage(), ok);
    await askAll(ctx, OFFICE);
    const afterFirst = calls.length;
    const again = await askAll(ctx, OFFICE);
    assert.strictEqual(calls.length, afterFirst, 'the second render went back to the network');
    assert.ok(again.every(r => r.isAddress), 'the cached answers must still be addresses');
  });

  await test('the cache survives a refresh: a fresh page asks for nothing', async () => {
    const storage = makeStorage();
    const first = load(storage, ok);
    await askAll(first.ctx, OFFICE);
    assert.strictEqual(first.calls.length, OFFICE.length);
    const second = load(storage, ok);          // same storage, new page
    const answers = await askAll(second.ctx, OFFICE);
    assert.strictEqual(second.calls.length, 0, 'a reloaded page asked again');
    assert.ok(answers.every(r => r.isAddress), 'the persisted answers must come back as addresses');
  });

  await test('a refusal is remembered, so the next render does not retry it', async () => {
    const { ctx, calls } = load(makeStorage(), refused);
    const answers = await askAll(ctx, [OFFICE[0]]);
    assert.strictEqual(answers[0].isAddress, false, 'a refusal must not be reported as an address');
    assert.ok(/13\.724704/.test(answers[0].text), 'the caller must get the coordinates to show');
    const afterFirst = calls.length;
    await askAll(ctx, [OFFICE[0]]);
    assert.strictEqual(calls.length, afterFirst, 'the refusal was retried on the next render');
  });

  await test('a refusal expires, so one bad minute never blanks a place for good', async () => {
    const storage = makeStorage();
    const first = load(storage, refused);
    await askAll(first.ctx, [OFFICE[0]]);
    // Age the stored refusal past its expiry, the way wall-clock time would.
    const saved = JSON.parse(storage.store.ta_geocache_v1);
    for (const k of Object.keys(saved)) saved[k].t -= GEO_RETRY_AFTER_MS + 1000;
    storage.store.ta_geocache_v1 = JSON.stringify(saved);
    const second = load(storage, ok);
    const answers = await askAll(second.ctx, [OFFICE[0]]);
    assert.strictEqual(second.calls.length, 1, 'an expired refusal must be asked about again');
    assert.strictEqual(answers[0].isAddress, true);
  });

  await test('after enough refusals in a row the queue stops asking, and still answers', async () => {
    const many = [];
    for (let i = 0; i < GEO_FAIL_LIMIT + 4; i++) many.push([13.70 + i / 1000, 100.50 + i / 1000]);
    const { ctx, calls } = load(makeStorage(), refused);
    const answers = await askAll(ctx, many);
    assert.strictEqual(calls.length, GEO_FAIL_LIMIT,
      `kept asking after ${GEO_FAIL_LIMIT} refusals (sent ${calls.length})`);
    assert.strictEqual(answers.length, many.length, 'every caller must still get an answer');
    assert.ok(answers.every(r => r.isAddress === false), 'none of these is an address');
    assert.ok(ctx.geoPausedUntil > Date.now(), 'the queue should be paused');
    assert.ok(ctx.geoPausedUntil - Date.now() <= GEO_PAUSE_MS, 'the pause must not be open-ended');
  });

  await test('a request already on the wire is joined, not pre-empted by the pause', async () => {
    // The queue spaces requests but does not wait for one to finish before sending the next, so a
    // slow request can still be in flight when later ones are refused and the queue pauses. A
    // render that asks for that coordinate during the pause must be attached to the request that
    // is already running: turning it away with coordinates loses the address for good, because
    // the answer only ever reaches the callbacks collected before the pause -- which belong to a
    // render that has since been replaced.
    const A = [1.5, 2.5];
    const doomed = [[13.701, 100.501], [13.702, 100.502], [13.703, 100.503]];
    assert.strictEqual(doomed.length, GEO_FAIL_LIMIT, 'this case needs exactly enough refusals to pause');
    let landA;
    const slowA = new Promise(res => { landA = res; });
    const { ctx, calls } = load(makeStorage(), url => (url.includes('lat=1.5') ? slowA : refused()));

    const firstAsker = new Promise(res => ctx.reverseGeocode(A[0], A[1], (text, isAddress) => res({ text, isAddress })));
    await sleep(TEST_INTERVAL_MS * 2);          // let A go out and stay unanswered
    await askAll(ctx, doomed);                  // these three are refused, which pauses the queue
    assert.ok(ctx.geoPausedUntil > Date.now(), 'the refusals should have paused the queue');

    const sentSoFar = calls.length;
    const secondAsker = new Promise(res => ctx.reverseGeocode(A[0], A[1], (text, isAddress) => res({ text, isAddress })));
    landA({ ok: true, json: () => Promise.resolve({ display_name: 'Later, Bangkok, Thailand' }) });
    const [first, second] = await Promise.all([firstAsker, secondAsker]);

    assert.strictEqual(calls.length, sentSoFar, 'joining an in-flight request must not send another');
    assert.strictEqual(first.isAddress, true, 'the original asker must get the address');
    assert.strictEqual(second.isAddress, true,
      'the asker during the pause was answered with coordinates instead of joining the live request');
    assert.strictEqual(second.text, first.text);
  });

  await test('a 200 with no place name is an answer, not a refusal: it does not pause the queue', async () => {
    const many = [];
    for (let i = 0; i < GEO_FAIL_LIMIT + 2; i++) many.push([13.70 + i / 1000, 100.50 + i / 1000]);
    const { ctx, calls } = load(makeStorage(), noName);
    const answers = await askAll(ctx, many);
    assert.strictEqual(calls.length, many.length, 'the service was answering; the queue stopped anyway');
    assert.ok(answers.every(r => r.isAddress === false));
    assert.strictEqual(ctx.geoPausedUntil, 0, 'an answered request must not count towards the pause');
  });

  await test('a browser that refuses localStorage still works', async () => {
    const dead = makeStorage({ throwOnRead: true, throwOnWrite: true });
    const { ctx, calls } = load(dead, ok);
    const answers = await askAll(ctx, [OFFICE[0]]);
    assert.ok(answers[0].isAddress, 'the address must still be fetched and delivered');
    assert.strictEqual(calls.length, 1);
    // And the in-memory copy still spares the second render.
    await askAll(ctx, [OFFICE[0]]);
    assert.strictEqual(calls.length, 1, 'the in-memory cache must still work without storage');
  });

  await test('corrupt or foreign data in storage is ignored, not thrown', async () => {
    for (const junk of ['not json at all', '[1,2,3]', 'null', '{"13.1,100.1":{"n":5}}']) {
      const storage = makeStorage({ seed: { ta_geocache_v1: junk } });
      const { ctx, calls } = load(storage, ok);
      const answers = await askAll(ctx, [OFFICE[0]]);
      assert.ok(answers[0].isAddress, `junk ${junk} broke the lookup`);
      assert.strictEqual(calls.length, 1);
    }
  });

  await test('an address does not expire as quickly as a refusal', () => {
    const ttl = numericConst('GEO_ADDRESS_TTL_MS');
    assert.ok(ttl > GEO_RETRY_AFTER_MS * 100,
      'an address should outlive a refusal by a wide margin; places do not move');
  });

  console.log(`geocode-queue-cache: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
