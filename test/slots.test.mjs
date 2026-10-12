import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const common = fs.readFileSync(new URL('../common.js', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(common, ctx);
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const resource = () => ({ count: 0, destroy() { this.count++; } });

test('pending release destroys exactly once', async () => {
  const slots = ctx.gwSlots(), d = deferred(), x = resource();
  const p = slots.get('a', () => d.p);
  assert.equal(slots.release('a'), true); assert.equal(slots.release('a'), false);
  d.resolve(x); await p; assert.equal(x.count, 1);
});
test('stale rejection preserves replacement', async () => {
  const slots = ctx.gwSlots(), d = deferred(), x = resource();
  const a = slots.get('a', () => d.p); slots.release('a');
  const b = slots.get('a', () => x);
  d.reject(new Error('old')); await assert.rejects(a); await b;
  assert.equal(slots.promiseOf('a'), b); assert.equal(x.count, 0);
});
test('stale resolution destroys only the old resource', async () => {
  const slots = ctx.gwSlots(), d = deferred(), x = resource(), y = resource();
  const a = slots.get('a', () => d.p); slots.release('a');
  const b = slots.get('a', () => y);
  d.resolve(x); await a; await b;
  assert.equal(x.count, 1); assert.equal(y.count, 0); assert.equal(slots.promiseOf('a'), b);
});
test('settled release is synchronous and exact once', async () => {
  const slots = ctx.gwSlots(), x = resource(); await slots.get('a', () => x);
  assert.equal(slots.release('a'), true); assert.equal(x.count, 1);
  assert.equal(slots.release('a'), false); assert.equal(x.count, 1);
});
test('owner rejection removes its entry and permits a new creation', async () => {
  const slots = ctx.gwSlots();
  await assert.rejects(slots.get('a', () => { throw new Error('failed'); }));
  assert.equal(slots.has('a'), false);
  const x = resource(); assert.equal(await slots.get('a', () => x), x);
});
test('releaseAll counts pending entries and destroys each once on settlement', async () => {
  const slots = ctx.gwSlots(), a = deferred(), b = deferred(), x = resource(), y = resource();
  const pa = slots.get('a', () => a.p), pb = slots.get('b', () => b.p);
  assert.equal(slots.releaseAll(), 2); assert.equal(slots.size, 0); assert.equal(slots.releaseAll(), 0);
  a.resolve(x); b.resolve(y); await Promise.all([pa, pb]);
  assert.equal(x.count, 1); assert.equal(y.count, 1);
});
test('null settlement never calls the destroy helper', async () => {
  const c = vm.createContext({}); vm.runInContext(common, c);
  vm.runInContext('var calls = 0; gwDestroy = () => calls++;', c);
  const slots = c.gwSlots(); await slots.get('a', () => null); slots.release('a'); assert.equal(c.calls, 0);
});
test('serialized probe handles alive, torn, none, and legacy worlds', () => {
  let calls = 0;
  for (const [globals, expected] of [
    [{ __gwTS2: { alive: () => true } }, 'alive'],
    [{ __gwTS2: { alive: () => false, teardown: () => calls++ } }, 'torn'],
    [{}, 'none'], [{ __gwTS: true }, 'legacy'],
  ]) assert.equal(vm.runInNewContext(`(${ctx.gwProbe.toString()})()`, globals), expected);
  assert.equal(calls, 1);
});
// 실제 함수 본문을 실행하고 브라우저 의존 호출만 가짜로 바꾼다.
const resumeSource = content.slice(content.indexOf('  async function resume()'), content.indexOf('  // 페이지가 우리가 바꾼'));
const workSource = content.slice(content.indexOf('  async function work(myGen)'), content.indexOf('  // 이 노드에서 미룬 언어'));
for (const outcome of ['resolve', 'reject']) for (const kind of ['tr', 'det']) test(`suspended resume ${outcome} preserves ${kind} request for visibility restore`, async () => {
  const d = deferred(), node = {}, requested = [];
  const need = kind === 'tr' ? { kind, src: 'ja', tgt: 'ko' } : { kind };
  const c = vm.createContext({ torn: false, suspended: false, needClick: true, on: true, gen: 1, releaseEpoch: 0,
    waiting: [node], pendingNeed: need, applyPill() {}, restoreStatus() {}, restoreNeedClick() {},
    getDetector: () => { requested.push('det'); return d.p; },
    getTranslator: (s, t) => { requested.push(`${s}>${t}`); return d.p; },
    console, restore: () => true, enqueue() {}, collect: () => [], document: {}, askClick() { assert.fail('hidden prompt'); },
  });
  vm.runInContext(resumeSource, c);
  const run = c.resume(); c.suspended = true; if (outcome === 'resolve') d.resolve({}); else d.reject(new Error('creation rejected')); await run;
  assert.equal(c.waiting[0], node); assert.deepEqual(JSON.parse(JSON.stringify(c.pendingNeed)), need); assert.equal(c.needClick, true);
  // 실제 복귀 함수가 클릭 대기로 돌리고, 다음 클릭이 같은 모델을 요청한다.
  const unsuspendSource = content.slice(content.indexOf('  function unsuspend()'), content.indexOf('  function syncVisibility()'));
  Object.assign(c, { releaseWanted: true, deferredEnable: false, retries: 2, scanShadows() {}, setState() {} });
  vm.runInContext(unsuspendSource, c); c.unsuspend(); assert.equal(c.needClick, true);
  const next = deferred(); c.getDetector = () => { requested.push('det'); return next.p; };
  c.getTranslator = (s, t) => { requested.push(`${s}>${t}`); return next.p; };
  const second = c.resume(); c.on = false; next.resolve({}); await second;
  assert.deepEqual(requested, [kind === 'det' ? 'det' : 'ja>ko', kind === 'det' ? 'det' : 'ja>ko']);
});
for (const change of ['disable', 'generation']) test(`stale sourceOf rejection after ${change} does not requeue`, async () => {
  const d = deferred(), n = { nodeValue: 'foreign text' };
  const c = vm.createContext({ settings: { site: { target: 'ko' } }, on: true, suspended: false, gen: 1, releaseEpoch: 0,
    queue: [n], needClick: false, document: { hidden: false }, eligible: () => true, RE: /./, sourceOf: () => d.p });
  vm.runInContext(workSource, c);
  const run = c.work(1); c.suspended = true;
  if (change === 'disable') c.on = false; else c.gen++;
  d.reject(new Error('detector failed')); await run; assert.equal(c.queue.length, 0);
});
test('current sourceOf rejection while suspended preserves the node', async () => {
  const d = deferred(), n = { nodeValue: 'foreign text' };
  const c = vm.createContext({ settings: { site: { target: 'ko' } }, on: true, suspended: false, gen: 1, releaseEpoch: 0,
    queue: [n], needClick: false, document: { hidden: false }, eligible: () => true, RE: /./, sourceOf: () => d.p });
  vm.runInContext(workSource, c);
  const run = c.work(1); c.suspended = true; d.reject(new Error('detector failed')); await run;
  assert.equal(c.queue[0], n);
});
test('unavailable reason distinguishes unsupported pairs and service failure without throwing', async () => {
  const c = vm.createContext({ Translator: { availability: async () => 'available' } }); vm.runInContext(common, c);
  assert.equal(await c.gwUnavailableReason('invalid', 'ko'), 'pair');
  assert.equal(await c.gwUnavailableReason('ja', 'ko'), 'pair');
  c.Translator.availability = async () => 'unavailable'; assert.equal(await c.gwUnavailableReason('ja', 'ko'), 'service');
  c.Translator.availability = async () => { throw new Error('unavailable'); }; assert.equal(await c.gwUnavailableReason('ja', 'ko'), 'service');
});

const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const popup = fs.readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
const functionSlice = (src, start, end) => src.slice(src.indexOf(start), end ? src.indexOf(end, src.indexOf(start)) : undefined);
test('legacy callers skip injection and popup start/grant actions; none injects', async () => {
  for (const probe of ['legacy', 'none']) {
    const calls = [], notices = [];
    const chrome = { tabs: { query: async () => [{ id: 1 }] }, scripting: { executeScript: async (opts) => {
      calls.push(opts); return [{ frameId: 0, result: probe }];
    } } };
    const c = vm.createContext({ setTimeout, clearTimeout, chrome, gwProbe: ctx.gwProbe, FILES: ['common.js', 'content.js'], console: { info: (s) => notices.push(s), warn() {} } });
    vm.runInContext(functionSlice(background, 'async function injectOpenTabs('), c);
    await c.injectOpenTabs(['https://example.test/*']);
    assert.equal(calls.filter((x) => x.files).length, probe === 'legacy' ? 0 : 1);
    calls.length = 0;
    Object.assign(c, { tab: { id: 1 }, legacyBlocked: false, msg: (s) => notices.push(s), t: (s) => s,
      editSite: async () => true, render() {}, crypto: { randomUUID() { assert.fail('legacy grant'); } } });
    vm.runInContext(functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
    assert.equal(await c.injectNow(), probe !== 'legacy');
    assert.equal(calls.filter((x) => x.files).length, probe === 'legacy' ? 0 : 1);
    if (probe === 'legacy') {
      vm.runInContext(functionSlice(popup, 'async function showGrantLayer(', '// 이 호스트 전용'), c);
      vm.runInContext(functionSlice(popup, 'async function turnOn(', 'async function render()'), c);
      await c.turnOn(); assert.equal(await c.showGrantLayer(), false);
      // 최초 켜기에서 legacy 를 발견한 경우도 start/grant 로 넘어가지 않는다.
      c.legacyBlocked = false; await c.turnOn();
      assert.equal(calls.length, 4); assert.ok(notices.includes('legacyRefresh'));
      const handler = popup.slice(popup.indexOf("$('useAll').addEventListener"), popup.indexOf('(async () =>'));
      c.$ = () => ({ addEventListener: (_, fn) => { c.useAll = fn; } });
      vm.runInContext(handler, c); await c.useAll();
      assert.equal(calls.length, 4); // 이미 확인한 옛 최상위는 다시 주입하지 않는다.
    }
  }
});
const lifecycleSource = functionSlice(content, '  function releaseAll()', '  const cache =');
for (const kind of ['det', 'tr']) for (const outcome of ['resolve', 'reject']) test(`${kind} creation ${outcome} after release and visible resume requeues the node`, async () => {
  const d = deferred(), n = { nodeValue: 'foreign text' }, slots = ctx.gwSlots(), x = resource();
  let used = 0;
  x.detect = x.translate = () => { used++; throw new Error('destroyed object used'); };
  const c = vm.createContext({ settings: { site: { source: kind === 'det' ? 'auto' : 'ja', target: 'ko' } },
    on: true, suspended: false, gen: 1, releaseEpoch: 0, released: 0, torn: false, queue: [n], needClick: false,
    eligible: () => true, RE: /./, TGT_RE: null, KANA: /あ/, HANGUL: /가/, HAN_ANY: /漢/, kanaSeen: new Set(), pageLang: '',
    translators: kind === 'tr' ? slots : ctx.gwSlots(), detector: kind === 'det' ? slots : ctx.gwSlots(),
    failedPairs: new Set(), getDetector: () => slots.get('det', () => d.p), getTranslator: () => slots.get('ja>ko', () => d.p),
    cache: new Map(), document: { hidden: false }, hideTimer: 0, clearTimeout() {}, releaseWanted: false,
    deferredEnable: false, pendingNeed: null, retries: 0, scanShadows() {}, enqueue() {}, console,
  });
  vm.runInContext(lifecycleSource, c);
  vm.runInContext(functionSlice(content, '  async function sourceOf(', '  // ── 번역 작업'), c);
  vm.runInContext(workSource, c);
  const run = c.work(1); await Promise.resolve(); await Promise.resolve();
  c.suspendNow(); c.syncVisibility(); assert.equal(c.suspended, false);
  if (outcome === 'resolve') d.resolve(x); else d.reject(new Error('creation failed'));
  await run; assert.equal(c.queue[0], n); assert.equal(used, 0);
  assert.equal(x.count, outcome === 'resolve' ? 1 : 0);
});
for (const elapsed of [false, true]) test(`initial hidden enable defers without prompt and preserves hide timer (elapsed=${elapsed})`, async () => {
  const timers = new Map(); let id = 0, creates = 0;
  const c = vm.createContext({ torn: false, suspended: false, deferredEnable: false, releaseWanted: false,
    initializing: false, workers: 0, released: 0, releaseEpoch: 0, hideTimer: 0, HIDE_RELEASE_MS: 60000,
    document: { hidden: true }, on: false, needClick: false, settings: { site: { source: 'ja', target: 'ko' } },
    translators: ctx.gwSlots(), detector: ctx.gwSlots(), failedPairs: new Set(),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (key) => timers.delete(key),
    getTranslator: () => { creates++; return Promise.reject(Object.assign(new Error('click'), { needsGesture: true })); },
    status() { assert.fail('hidden UI'); }, setState: (next) => { assert.equal(next, true); creates++; },
  });
  vm.runInContext(lifecycleSource, c);
  vm.runInContext(functionSlice(content, '  async function enable()', '  function disable()'), c);
  await c.enable(); assert.equal(c.deferredEnable, true); assert.equal(c.needClick, false); assert.equal(creates, 0);
  assert.equal(timers.get(c.hideTimer).ms, 60000);
  if (elapsed) { timers.get(c.hideTimer).fn(); assert.equal(c.suspended, true); }
  c.document.hidden = false; c.syncVisibility();
  assert.equal(c.deferredEnable, false); assert.equal(c.suspended, false); assert.equal(creates, 1);
});

test('redundant hidden enable resumes queued work and shadow scanning', async () => {
  const node = {}, calls = [];
  const c = vm.createContext({ torn: false, suspended: true, on: true, deferredEnable: false,
    document: { hidden: true }, hideTimer: 0, releaseWanted: false, pendingNeed: null, retries: 2,
    queue: [node], clearTimeout() {}, scanShadows: () => calls.push('shadows'),
    enqueue: (nodes) => { assert.equal(nodes.length, 0); calls.push('enqueue'); },
    setState() { assert.fail('redundant enable must not defer'); },
  });
  vm.runInContext(lifecycleSource, c);
  vm.runInContext(functionSlice(content, '  async function enable()', '  function disable()'), c);
  await c.enable(); assert.equal(c.deferredEnable, false);
  c.document.hidden = false; c.syncVisibility();
  assert.equal(c.suspended, false); assert.equal(c.retries, 0);
  assert.equal(c.queue[0], node); assert.deepEqual(calls, ['shadows', 'enqueue']);
});

for (const pill of [false, true]) for (const kind of ['det', 'tr']) test(`resume rejection after visible restoration shows ${kind} click control (pill=${pill})`, async () => {
  const d = deferred(), node = {}, need = kind === 'det' ? { kind } : { kind, src: 'ja', tgt: 'ko' };
  const c = vm.createContext({ torn: false, suspended: false, on: true, gen: 1, releaseEpoch: 0,
    waiting: [node], pendingNeed: need, needClick: true, settings: { pill, site: {}, position: 'bottom-right' },
    isTop: true, btn: { style: {}, removeAttribute() {} }, POS: {}, childNeedClick: false,
    idle: () => true, t: (key) => key, isMac: false, ready: true, pillLabel: () => 'original',
    status: (text) => { c.label = text; }, getDetector: () => d.p, getTranslator: () => d.p,
    document: { hidden: false }, hideTimer: 0, clearTimeout() {}, deferredEnable: false,
    releaseWanted: false, retries: 0, scanShadows() {}, enqueue() {}, console,
    translators: ctx.gwSlots(), detector: ctx.gwSlots(), failedPairs: new Set(), released: 0,
  });
  vm.runInContext(functionSlice(content, '  function applyPill()', '  // 진단 정보'), c);
  vm.runInContext(content.slice(content.indexOf('  const restoreStatus ='), content.indexOf('\n', content.indexOf('  const restoreStatus ='))), c);
  vm.runInContext(functionSlice(content, '  function restoreNeedClick()', '  // 「눌러서 시작」 상태에서'), c);
  vm.runInContext(lifecycleSource, c); vm.runInContext(resumeSource, c);
  const run = c.resume();
  assert.equal(c.btn.style.display, pill ? '' : 'none');
  c.suspendNow(); c.syncVisibility(); assert.equal(c.suspended, false);
  d.reject(new Error('creation rejected')); await run;
  assert.equal(c.needClick, true); assert.equal(c.waiting[0], node);
  assert.deepEqual(JSON.parse(JSON.stringify(c.pendingNeed)), need);
  assert.equal(c.btn.style.display, ''); assert.equal(c.label, 'clickToStart');
});

for (const top of ['alive', 'torn', 'legacy']) test(`per-frame callers replace stale children with ${top} top frame`, async () => {
  for (const caller of ['background', 'popup']) {
    const calls = [], dead = { __gwTS2: { alive: () => false, teardown() { delete dead.__gwTS2; } } };
    const worlds = new Map([[0, top === 'legacy' ? { __gwTS: true } : { __gwTS2: { alive: () => top === 'alive', teardown() {} } }],
      [4, dead], [7, { __gwTS: true }], [9, {}], [12, { __gwTS2: { alive: () => true } }]]);
    const chrome = { tabs: { query: async () => [{ id: 1 }] }, scripting: { executeScript: async (opts) => {
      calls.push(opts);
      if (opts.func) {
        assert.equal(opts.injectImmediately, true);
        return [...worlds].filter(([id]) => opts.target.allFrames || opts.target.frameIds.includes(id)).map(([frameId, world]) => ({ frameId, result: vm.runInNewContext(`(${opts.func.toString()})()`, world) }));
      }
      if (opts.target.frameIds[0] !== 0) assert.equal(dead.__gwTS2, undefined, 'takeover must precede child guard');
      assert.equal(opts.target.allFrames, undefined);
      assert.equal(opts.target.frameIds.length, 1);
      return [];
    } } };
    const c = vm.createContext({ setTimeout, clearTimeout, chrome, gwProbe: ctx.gwProbe, FILES: ['common.js', 'content.js'],
      tab: { id: 1 }, legacyBlocked: false, msg() {}, t: (s) => s, console: { info() {}, warn() {} } });
    if (caller === 'background') {
      vm.runInContext(functionSlice(background, 'async function injectOpenTabs('), c); await c.injectOpenTabs(['https://example.test/*']);
    } else {
      vm.runInContext(functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
      assert.equal(await c.injectNow(), top !== 'legacy'); assert.equal(c.legacyBlocked, top === 'legacy');
    }
    await new Promise(setImmediate);
    assert.deepEqual(calls.filter((x) => x.files).map((x) => x.target.frameIds[0]), top === 'torn' ? [0, 4, 9] : [4, 9]);
  }
});

const restoreNeedSource = functionSlice(content, '  function restoreNeedClick()', '  // 「눌러서 시작」 상태에서');
for (const outcome of ['resolve', 'reject']) for (const beforeVisible of [true, false]) for (const kind of ['det', 'tr']) for (const pill of [false, true]) test(`child ${kind} ${outcome}, settlement before visibility=${beforeVisible}, pill=${pill} re-notifies parent and resumes same model`, async () => {
  const d = deferred(), need = kind === 'det' ? { kind } : { kind, src: 'ja', tgt: 'ko' }, node = {}, requests = [], messages = [];
  const origin = 'https://example.test';
  const parentWindow = { frames: [] }, childWindow = { top: parentWindow, parent: parentWindow };
  const parent = vm.createContext({ torn: false, isTop: true, window: parentWindow, self: { origin }, MSG: '__gwJa2Ko',
    on: true, ready: true, needClick: false, childNeedClick: false, btn: { style: {}, removeAttribute() {} },
    settings: { pill, site: {}, position: 'bottom-right' }, POS: {}, isMac: false, idle: () => true,
    sameOriginWin: () => true, childFrames: () => [childWindow], t: (k) => k, status() {},
    disable() { assert.fail('parent toggle must not disable translation'); }, enable() {},
  });
  const child = vm.createContext({ torn: false, isTop: false, window: childWindow, self: { origin }, MSG: '__gwJa2Ko',
    on: true, gen: 1, releaseEpoch: 0, suspended: false, waiting: [node], pendingNeed: need, needClick: true,
    settings: { pill, site: {} }, document: { hidden: false }, hideTimer: 0, clearTimeout() {},
    releaseWanted: false, deferredEnable: false, retries: 0, released: 0,
    translators: ctx.gwSlots(), detector: ctx.gwSlots(), failedPairs: new Set(), scanShadows() {},
    sameOriginWin: () => true, t: (k) => k, restoreStatus() {}, childNeedClick: false,
    getDetector: () => { requests.push('det'); return d.p; },
    getTranslator: (src, tgt) => { requests.push(`${src}>${tgt}`); return d.p; },
    restore: () => true, enqueue() {}, collect: () => [], console,
  });
  vm.runInContext(functionSlice(content, '  function applyPill()', '  // 진단 정보'), parent);
  vm.runInContext(functionSlice(content, '  function broadcast()', '  let wantOn ='), parent);
  parent.alive = () => true;
  vm.runInContext(functionSlice(content, '  function onMessage(', "  window.addEventListener('message'"), parent);
  vm.runInContext(content.slice(content.indexOf('  const toggle ='), content.indexOf('\n', content.indexOf('  const toggle ='))), parent);
  parent.restoreStatus = () => {};
  parentWindow.postMessage = (data, target) => { messages.push(data); assert.equal(target, origin); parent.onMessage({ data, origin, source: childWindow }); };
  childWindow.postMessage = (data) => { if (data.__gwJa2Ko) child.setState(true); };
  vm.runInContext(functionSlice(content, '  function applyPill()', '  // 진단 정보'), child);
  vm.runInContext(restoreNeedSource + lifecycleSource + resumeSource, child);
  vm.runInContext(functionSlice(content, '  function setState(', '  let wantOn ='), child);
  child.broadcast = () => {};
  const run = child.resume();
  child.document.hidden = true; child.suspendNow();
  if (!beforeVisible) { child.document.hidden = false; child.syncVisibility(); }
  if (outcome === 'resolve') d.resolve({}); else d.reject(new Error('creation failed'));
  await run;
  if (beforeVisible) { assert.equal(messages.length, 0); child.document.hidden = false; child.syncVisibility(); }
  assert.equal(messages.length, 1); assert.equal(parent.childNeedClick, true); assert.equal(parent.btn.style.display, '');
  assert.deepEqual(JSON.parse(JSON.stringify(child.pendingNeed)), need); assert.equal(child.waiting[0], node);
  child.getDetector = () => { requests.push('det'); return Promise.resolve({}); };
  child.getTranslator = (src, tgt) => { requests.push(`${src}>${tgt}`); return Promise.resolve({}); };
  vm.runInContext('toggle()', parent); await Promise.resolve(); await Promise.resolve();
  assert.equal(parent.on, true); assert.equal(parent.childNeedClick, false); assert.equal(child.needClick, false);
  assert.deepEqual(requests, [kind === 'det' ? 'det' : 'ja>ko', kind === 'det' ? 'det' : 'ja>ko']);
});

// 실제 teardown 과 호출자를 실행하고 정리 후 재연결을 센다.
for (const failure of ['preparing', 'pillAuto', 'pillTitle', 'alertPrefix', 'enable-pillAuto', 'enable-pillTitle']) test(`localization failure at ${failure} leaves no observer, UI, listeners or timers`, async () => {
  const attached = new Set(), listeners = new Set(), timers = new Set(), observers = new Set(); let observed = 0, constructed = 0;
  const element = () => ({ dataset: {}, style: {}, setAttribute() {}, removeAttribute() {},
    addEventListener(_, fn) { listeners.add(fn); }, remove() { attached.delete(this); } });
  const document = { hidden: false, documentElement: { appendChild: (el) => attached.add(el) },
    createElement: element, getElementById: () => null, removeEventListener() {} };
  const c = vm.createContext({ torn: false, on: false, gen: 0, suspended: false, initializing: false, releaseWanted: false, workers: 0,
    settings: { pill: false, site: { source: 'auto', target: 'ko' } }, pageLang: '', observer: null,
    roots: new Set(), styles: new Set(), btn: null, tip: null, document, isTop: true, POS: {}, isMac: false,
    chrome: { i18n: { getMessage(k) { if (k === failure.replace('enable-', '')) throw new Error('Extension context invalidated'); return k; } } },
    syncVisibility() {}, status() {}, onMutations() {},
    MutationObserver: class { constructor() { constructed++; } observe() { observed++; observers.add(this); } disconnect() { observers.delete(this); } },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    scanTimer: 0, pruneTimer: 0, grantTimer: 0, hideTimer: 0, aliveTimer: 0, raf: 0, cancelAnimationFrame() {},
    grantClose: null, highlight: null, CSS: { highlights: { delete() {} } }, HL: 'test',
    window: { removeEventListener() {} }, BOOT_EVENT: '__gwTranslateSwitchBoot_v1', onInstanceBoot() {}, alive: () => true, onMessage() {}, onKeydown() {}, onMousemove() {}, hideTip() {},
    onPageShow() {}, suspendNow() {}, grant() {}, popupToggle() {}, start() {}, diag() {}, instance: {},
    disable() { c.on = false; c.gen++; }, childNeedClick: false, needClick: false, idle: () => true,
    toggle() {}, broadcast() { assert.fail('broadcast after teardown'); }, enqueue() { assert.fail('enqueue after teardown'); },
    collect() { assert.fail('collect after teardown'); }, scanShadows() { assert.fail('scan after teardown'); },
  });
  vm.runInContext(functionSlice(content, '  const t =', '  const restoreStatus ='), c);
  vm.runInContext(functionSlice(content, '  function teardown()', '  const aliveTimer ='), c);
  vm.runInContext(functionSlice(content, '  function applyPill()', '  // 진단 정보'), c);
  vm.runInContext(functionSlice(content, '  async function enable()', '  function disable()'), c);
  vm.runInContext(functionSlice(content, '  function alertBox(', '  // ── 접근 허용'), c);
  if (failure === 'preparing' || failure.startsWith('enable-')) await c.enable();
  else if (failure === 'alertPrefix') c.alertBox('error');
  else { c.applyPill(); await c.enable(); }
  assert.equal(c.torn, true); assert.equal(c.observer, null); assert.equal(constructed, failure.startsWith('enable-') ? 1 : 0); assert.equal(observed, failure.startsWith('enable-') ? 1 : 0); assert.equal(observers.size, 0);
  assert.equal(attached.size, 0); assert.equal(timers.size, 0);
  // pillTitle 은 연결 후 실패하므로, 그 전에 붙인 버튼 리스너는 정리된 버튼에만 남는다.
  if (!failure.endsWith('pillTitle')) assert.equal(listeners.size, 0);
});

for (const pill of [false, true]) for (const isTop of [false, true]) for (const gesture of [false, true]) test(`hide during enable rejection preserves deadline and operation (pill=${pill}, top=${isTop}, gesture=${gesture})`, async () => {
  const d = deferred(), timers = new Map(), messages = []; let id = 0, creates = 0;
  const c = vm.createContext({ torn: false, suspended: false, deferredEnable: false, releaseWanted: false,
    initializing: false, workers: 0, released: 0, releaseEpoch: 0, hideTimer: 0, HIDE_RELEASE_MS: 60000,
    document: { hidden: false, documentElement: {} }, on: false, ready: false, gen: 0, needClick: false,
    settings: { pill, site: { source: 'ja', target: 'ko' } }, pageLang: 'ja', isTop, observer: null, roots: new Set(),
    translators: ctx.gwSlots(), detector: ctx.gwSlots(), failedPairs: new Set(), onMutations() {},
    MutationObserver: class { observe() {} }, t: (k) => k,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (key) => timers.delete(key),
    getTranslator: () => { creates++; return d.p; }, status() { assert.equal(c.document.hidden, false, 'hidden status'); },
    disable() { assert.fail('hidden failure must not disable or cancel timer'); }, alertBox() { assert.fail('hidden alert'); },
    window: { top: { postMessage: (m) => messages.push(m) } }, sameOriginWin: () => true, self: { origin: 'test' }, MSG: 'test',
    console: { warn() {} }, setState: (next) => { assert.equal(next, true); creates++; },
  });
  vm.runInContext(lifecycleSource, c);
  vm.runInContext(functionSlice(content, '  async function enable()', '  function disable()'), c);
  const run = c.enable(); assert.equal(creates, 1);
  c.document.hidden = true; c.syncVisibility(); const deadline = c.hideTimer;
  assert.equal(timers.get(deadline).ms, 60000);
  d.reject(Object.assign(new Error('creation rejected'), { name: gesture ? 'NotAllowedError' : 'Error', needsGesture: gesture })); await run;
  assert.equal(c.suspended, false); assert.equal(c.initializing, false); assert.equal(c.deferredEnable, true);
  assert.equal(c.on, false); assert.equal(c.needClick, false); assert.equal(c.hideTimer, deadline);
  assert.equal(timers.has(deadline), true); assert.equal(messages.length, 0);
  // 거부 뒤에도 원래 마감에서 해제되고, 복귀 때 켜기 의도가 남는다.
  timers.get(deadline).fn(); assert.equal(c.suspended, true); assert.equal(c.deferredEnable, true);
  assert.equal(c.releaseEpoch, 1);
  c.document.hidden = false; c.syncVisibility(); assert.equal(creates, 2); assert.equal(c.deferredEnable, false);
});

for (const kind of ['tr', 'det']) test(`resume gesture rejection while hidden before deadline preserves ${kind} request`, async () => {
  const d = deferred(), node = {}, need = kind === 'tr' ? { kind, src: 'ja', tgt: 'ko' } : { kind };
  const c = vm.createContext({ torn: false, suspended: false, document: { hidden: false }, on: true, gen: 1, releaseEpoch: 0,
    waiting: [node], pendingNeed: need, needClick: true, applyPill() {}, restoreStatus() {},
    getDetector: () => d.p, getTranslator: () => d.p, restoreNeedClick() { assert.fail('hidden parent notification'); },
    askClick() { assert.fail('hidden click prompt'); }, console,
  });
  vm.runInContext(resumeSource, c); const run = c.resume(); c.document.hidden = true;
  d.reject(Object.assign(new Error('click'), { needsGesture: true, need })); await run;
  assert.equal(c.waiting[0], node); assert.equal(c.needClick, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.pendingNeed)), need);
});

for (const stage of ['source', 'translator']) test(`worker gesture rejection while hidden before deadline preserves node (${stage})`, async () => {
  const d = deferred(), n = { nodeValue: 'foreign text' };
  const c = vm.createContext({ settings: { site: { target: 'ko' } }, on: true, suspended: false, gen: 1, releaseEpoch: 0,
    queue: [n], needClick: false, eligible: () => true, RE: /./, document: { hidden: false }, cache: new Map(),
    sourceOf: () => stage === 'source' ? d.p : { lang: 'ja', sure: true }, getTranslator: () => d.p,
    askClick() { assert.fail('hidden prompt'); },
  });
  vm.runInContext(workSource, c); const run = c.work(1); await Promise.resolve(); c.document.hidden = true;
  d.reject(Object.assign(new Error('click'), { needsGesture: true, need: { kind: 'tr', src: 'ja', tgt: 'ko' } })); await run;
  assert.equal(c.queue[0], n); assert.equal(c.needClick, false);
});

test('hidden child askClick defers parent notification until visibility restore', () => {
  const messages = [], need = { kind: 'tr', src: 'ja', tgt: 'ko' };
  const c = vm.createContext({ pendingNeed: null, needClick: false, waiting: [], queue: [{}], suspended: false, torn: false,
    document: { hidden: true }, isTop: false, window: { top: { postMessage: (m) => messages.push(m) } },
    sameOriginWin: () => true, self: { origin: 'test' }, MSG: 'test', t: (k) => k,
    status() { assert.fail('hidden status'); }, applyPill() {}, restoreStatus() {},
  });
  vm.runInContext(functionSlice(content, '  function askClick(', '  // 「눌러서 시작」 상태에서'), c);
  c.askClick('click', need); assert.equal(messages.length, 0); assert.equal(c.pendingNeed, need);
  c.document.hidden = false; c.restoreNeedClick(); assert.equal(messages.length, 1);
});

test('old instance teardown preserves replacement highlight registration', () => {
  const highlights = new Map(), old = {}, replacement = {}, HL = 'gw-translate-switch';
  const c = vm.createContext({ torn: false, disable() {}, observer: null, scanTimer: 0, pruneTimer: 0, grantTimer: 0,
    hideTimer: 0, aliveTimer: 0, raf: 0, clearTimeout() {}, clearInterval() {}, cancelAnimationFrame() {},
    grantClose: null, btn: null, tip: null, styles: new Set(), roots: new Set(),
    document: { getElementById: () => null, removeEventListener() {} }, window: { removeEventListener() {} },
    CSS: { highlights }, HL, highlight: old, BOOT_EVENT: '__gwTranslateSwitchBoot_v1', onInstanceBoot() {}, alive: () => true, onMessage() {}, onKeydown() {}, onMousemove() {}, hideTip() {},
    syncVisibility() {}, suspendNow() {}, onPageShow() {}, instance: {}, grant() {}, popupToggle() {}, start() {}, diag() {},
  });
  vm.runInContext(functionSlice(content, '  function teardown()', '  const aliveTimer ='), c);
  highlights.set(HL, old); highlights.set(HL, replacement); c.teardown();
  assert.equal(highlights.get(HL), replacement);
  c.torn = false; c.highlight = replacement; c.teardown(); assert.equal(highlights.has(HL), false);
});

// 별도 world 는 문서·창을 공유하지만 정리할 자원은 각 인스턴스가 가진다.
function teardownContext(document, window) {
  const c = vm.createContext({ document, window, torn: false, on: true, gen: 0,
    hideTimer: 0, scanTimer: 0, pruneTimer: 0, grantTimer: 0, aliveTimer: 0, raf: 0,
    clearTimeout() {}, clearInterval() {}, cancelAnimationFrame() {}, observer: null,
    releaseWanted: false, initializing: false, deferredEnable: false, childNeedClick: false,
    ready: true, wantOn: true, needClick: false, queue: [], waiting: [], waitingDetect: [], failed: [], retries: 0,
    cache: new Map(), failedPairs: new Set(), pendingNeed: null, held: [], langSeen: new Map(), done: new Map(),
    releaseAll() {}, hideTip() {}, unmark() {}, highlight: null, ranges: new Map(), applyPill() {}, status() {}, pillLabel() {},
    grantClose: null, btn: null, tip: null, styles: new Set(), roots: new Set(), CSS: { highlights: new Map() }, HL: 'test',
    BOOT_EVENT: '__gwTranslateSwitchBoot_v1', onInstanceBoot() {}, alive: () => true, onMessage() {}, onKeydown() {}, onMousemove() {}, syncVisibility() {}, suspendNow() {}, onPageShow() {},
    instance: {}, grant() {}, popupToggle() {}, start() {}, diag() {}, MSG: '__gwJa2Ko', self: { origin: 'test' },
    childFrames: () => window.frames || [],
  });
  vm.runInContext(functionSlice(content, '  function disable()', '  // ── 같은 출처'), c);
  vm.runInContext(functionSlice(content, '  function broadcast()', '  function setState('), c);
  vm.runInContext(functionSlice(content, '  function teardown()', '  const aliveTimer ='), c);
  return c;
}

for (const orphan of [true, false]) test(`${orphan ? 'orphan teardown preserves' : 'normal disable turns off'} replacement children using real disable`, () => {
  const document = { removeEventListener() {}, getElementById: () => null };
  const top = { removeEventListener() {}, frames: [] };
  const old = teardownContext(document, top), replacement = teardownContext(document, top);
  const childWindow = { parent: top, frames: [], removeEventListener() {} };
  const child = teardownContext(document, childWindow);
  Object.assign(child, { isTop: false, parentWants: true, sameOriginWin: () => true,
    setState(next) { if (!next) child.disable(); }, toggle() {}, restoreStatus() {} });
  vm.runInContext(functionSlice(content, '  function onMessage(', "  window.addEventListener('message'"), child);
  const messages = [];
  top.frames.push({ postMessage(data) { messages.push(data); child.onMessage({ data, origin: 'test', source: top }); } });
  assert.equal(replacement.on, true); assert.equal(child.on, true);
  if (orphan) old.teardown(); else replacement.disable();
  assert.equal(child.on, orphan); assert.equal(child.parentWants, orphan);
  assert.equal(replacement.on, orphan); assert.equal(messages.length, orphan ? 0 : 1);
  assert.equal(old.on, !orphan);
});

test('old teardown preserves replacement overlay and its close listeners', () => {
  const attached = new Set(), listeners = new Map();
  const document = { removeEventListener() {}, getElementById: (id) => [...attached].find((el) => el.id === id),
    documentElement: { append: (el) => attached.add(el) },
    createElement: () => ({ dataset: {}, style: {}, contentWindow: {}, append() {}, addEventListener() {},
      remove() { attached.delete(this); } }) };
  const window = { removeEventListener() {} };
  const old = teardownContext(document, window), replacement = teardownContext(document, window);
  for (const c of [old, replacement]) {
    c.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
    c.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    vm.runInContext(functionSlice(content, '  function showGrantLayer(', '  // 확장 팝업'), c);
  }
  old.showGrantLayer('old'); replacement.showGrantLayer('replacement');
  const overlay = document.getElementById('gw-ja2ko-grant'), close = replacement.grantClose;
  old.teardown();
  assert.equal(document.getElementById('gw-ja2ko-grant'), overlay);
  assert.equal(replacement.grantClose, close);
  assert.equal(listeners.get('message').size, 1); assert.equal(listeners.get('keydown').size, 1);
  for (const fn of [...listeners.get('keydown')]) fn({ key: 'Escape' });
  assert.equal(attached.size, 0); assert.equal(replacement.grantClose, null);
  assert.equal(listeners.get('message').size, 0); assert.equal(listeners.get('keydown').size, 0);
});


for (const caller of ['background', 'popup']) test(`${caller} replaces torn top and surviving child when another child disappears`, async () => {
  const attempted = [], replaced = [], warnings = [];
  const chrome = { tabs: { query: async () => [{ id: 1 }] }, scripting: { executeScript: async (opts) => {
    if (opts.func) return [{ frameId: 4, result: 'torn' }, { frameId: 9, result: 'none' }, { frameId: 0, result: 'torn' }];
    assert.equal(opts.target.frameIds.length, 1);
    const [id] = opts.target.frameIds; attempted.push(id);
    if (id === 4) throw new Error('frame disappeared');
    replaced.push(id); return [];
  } } };
  const c = vm.createContext({ setTimeout, clearTimeout, chrome, gwProbe: ctx.gwProbe, FILES: ['common.js', 'content.js'],
    tab: { id: 1 }, legacyBlocked: false, msg() {}, t: (s) => s, console: { info() {}, warn: (...args) => warnings.push(args) } });
  if (caller === 'background') {
    vm.runInContext(functionSlice(background, 'async function injectOpenTabs('), c); await c.injectOpenTabs(['https://example.test/*']);
  } else {
    vm.runInContext(functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
    assert.equal(await c.injectNow(), true);
  }
  await new Promise(setImmediate);
  assert.deepEqual(attempted, [0, 4, 9]); assert.deepEqual(replaced, [0, 9]);
  assert.equal(warnings.length, 1); assert.equal(warnings[0][1], 4);
});

test('popup blocks legacy start and grant before a child injection rejects', async () => {
  const notices = [], calls = [], warnings = [];
  const c = vm.createContext({ setTimeout, clearTimeout, tab: { id: 1 }, legacyBlocked: false, gwProbe: ctx.gwProbe,
    msg: (s) => notices.push(s), t: (s) => s, editSite: async () => true, render() {},
    crypto: { randomUUID() { assert.fail('legacy grant must not be created'); } },
    console: { info() {}, warn: (...args) => warnings.push(args) } });
  c.chrome = { scripting: { executeScript: async (opts) => {
    calls.push(opts);
    if (opts.func === ctx.gwProbe) return [{ frameId: 4, result: 'none' }, { frameId: 0, result: 'legacy' }];
    assert.ok(opts.files, 'no start or grant script');
    assert.equal(c.legacyBlocked, true, 'guard precedes child injection');
    assert.equal(notices.at(-1), 'legacyRefresh');
    throw new Error('frame disappeared');
  } } };
  vm.runInContext(functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
  vm.runInContext(functionSlice(popup, 'async function showGrantLayer(', '// 이 호스트 전용'), c);
  vm.runInContext(functionSlice(popup, 'async function turnOn(', 'async function render()'), c);
  await c.turnOn(); assert.equal(await c.showGrantLayer(), false);
  assert.equal(c.legacyBlocked, true); assert.equal(notices.at(-1), 'legacyRefresh');
  await new Promise(setImmediate);
  assert.equal(calls.length, 3); assert.equal(warnings.length, 1);
});

test('fresh popup direct grant link blocks legacy top before request creation', async () => {
  const elements = new Map(), calls = [], notices = [];
  let closed = 0, requests = 0, grants = 0, link;
  const element = () => ({ textContent: '', classList: { toggle() {} }, append() {} });
  const c = vm.createContext({ setTimeout, clearTimeout, tab: { id: 1 }, host: 'example.test', legacyBlocked: null, allOn: false,
    state: { sites: [{ host: 'example.test', enabled: true }], all: { enabled: false } },
    gwProbe: ctx.gwProbe, gwSiteFor: (sites) => sites[0], GW_ALL_PATTERN: '<all_urls>', GW_RULE: {},
    gwPattern: (host) => `https://${host}/*`, t: (s) => s, msg: (s) => notices.push(s),
    renderModels() {}, fill() {}, gwLangSelect() {}, gwCheck() {},
    $: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: { createElement() { link = { addEventListener(_, fn) { this.click = fn; } }; return link; } },
    window: { close() { closed++; } }, crypto: { randomUUID() { requests++; return 'request'; } },
    chrome: { permissions: { contains: async () => false },
      storage: { session: { set: async () => { requests++; } } },
      runtime: { getURL: (s) => s }, scripting: { executeScript: async (opts) => {
        calls.push(opts);
        if (opts.func === ctx.gwProbe) return [{ frameId: 0, result: 'legacy' }];
        grants++; return [{ result: true }];
      } } } });
  vm.runInContext(functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
  vm.runInContext(functionSlice(popup, 'async function showGrantLayer(', '// 이 호스트 전용'), c);
  vm.runInContext(functionSlice(popup, 'async function render()', "$('openOptions')"), c);
  await c.render();
  assert.equal(link.textContent, 'grantBtn');
  let prevented = false;
  await link.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(notices, ['legacyRefresh']);
  assert.equal(closed, 0); assert.equal(requests, 0); assert.equal(grants, 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].func, ctx.gwProbe);
});

// 실제 시간을 기다리지 않고 대기 상한과 최상위 우선 순서를 검증한다.
for (const caller of ['background', 'popup']) for (const failure of ['pending', 'error'])
  test(`${caller} isolates ${failure} child probe from top recovery and later tabs`, async () => {
    const injected = [], timers = new Map(), warnings = [];
    let timerId = 0;
    const chrome = { tabs: { query: async () => [{ id: 1 }, { id: 2 }] }, scripting: { executeScript: (opts) => {
      if (opts.files) { injected.push([opts.target.tabId, opts.target.frameIds[0]]); return Promise.resolve([]); }
      if (!opts.target.allFrames) {
        assert.deepEqual(Array.from(opts.target.frameIds), [0]);
        assert.equal(opts.injectImmediately, true);
        return Promise.resolve([{ frameId: 0, result: 'none' }]);
      }
      assert.ok(injected.some(([id, frame]) => id === opts.target.tabId && frame === 0));
      return failure === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('Frame with ID 452 is showing error page'));
    } } };
    const c = vm.createContext({ setTimeout, clearTimeout, chrome, gwProbe: ctx.gwProbe, FILES: ['common.js', 'content.js'],
      tab: { id: 1 }, legacyBlocked: null, msg() {}, t: (s) => s,
      setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); }, console: { info() {}, warn: (...args) => warnings.push(args) } });
    vm.runInContext(caller === 'background' ? functionSlice(background, 'async function injectOpenTabs(')
      : functionSlice(popup, 'async function injectNow()', '// 접근 허용 화면'), c);
    const recovery = caller === 'background' ? c.injectOpenTabs(['https://example.test/*']) : c.injectNow();
    await new Promise(setImmediate);
    assert.deepEqual(injected, caller === 'background' ? [[1, 0], [2, 0]] : [[1, 0]]);
    if (caller === 'popup') assert.equal(await recovery, true);
    for (const fn of [...timers.values()]) fn();
    await recovery; await new Promise(setImmediate);
    assert.equal(timers.size, 0);
    assert.equal(warnings.length, caller === 'background' ? 2 : 1);
  });

// 문서는 공유하고 변수는 격리한 두 world 에서 실제 부팅 신호·정리 함수를 실행한다.
function bootDocument() {
  const listeners = new Map();
  return {
    hidden: false, documentElement: { appendChild() {} },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); },
    count(type) { return listeners.get(type)?.size || 0; },
    createElement() { return { dataset: {}, style: {}, setAttribute() {}, removeAttribute() {}, remove() {},
      addEventListener(type, fn) { this[type] = fn; } }; },
  };
}
function bootWorld(document, token) {
  const c = teardownContext(document, { removeEventListener() {}, frames: [] });
  Object.assign(c, { chrome: { runtime: { id: 'test' } }, crypto: { getRandomValues: () => ({ join: () => token }) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  vm.runInContext(functionSlice(content, '  const BOOT_EVENT =', '  function releaseAll()'), c);
  vm.runInContext(functionSlice(content, '  function alive()', '  function hiddenRelease()'), c);
  return c;
}
function announceBoot(c) {
  vm.runInContext(functionSlice(content, '  document.addEventListener(BOOT_EVENT', '\n\n  try { chrome.storage'), c);
}
test('new world boot tears down orphan synchronously and removes its boot listener', () => {
  const document = bootDocument(), old = bootWorld(document, 'old');
  announceBoot(old); old.chrome.runtime.id = undefined;
  const replacement = bootWorld(document, 'new'); announceBoot(replacement);
  assert.equal(old.torn, true); assert.equal(old.on, false);
  assert.equal(replacement.torn, false); assert.equal(document.count('__gwTranslateSwitchBoot_v1'), 1);
  replacement.teardown(); assert.equal(document.count('__gwTranslateSwitchBoot_v1'), 0);
});
test('live world ignores another boot and each world ignores its own token', () => {
  const document = bootDocument(), first = bootWorld(document, 'first'), second = bootWorld(document, 'second');
  announceBoot(first); announceBoot(second);
  assert.equal(first.torn, false); assert.equal(second.torn, false);
  // 자기 신호에는 생존 검사도 하지 않는다.
  first.chrome.runtime.id = undefined;
  document.dispatchEvent({ type: '__gwTranslateSwitchBoot_v1', detail: 'first' });
  assert.equal(first.torn, false); assert.equal(second.torn, false);
  first.teardown(); second.teardown(); assert.equal(document.count('__gwTranslateSwitchBoot_v1'), 0);
});
for (const input of ['pill', 'shift-pill', 'shortcut', 'popup-toggle', 'popup-start', 'frame-message']) {
  test(`orphan ${input} tears down without toggling or consuming input`, () => {
    const document = bootDocument(), c = bootWorld(document, input);
    Object.assign(c, { isTop: true, isMac: true, settings: { site: {}, shortcut: true, pill: true },
      POS: {}, pillLabel: () => 'test', t: () => 'test', idle: () => true,
      toggle() { assert.fail('orphan toggled'); }, copyDiag() { assert.fail('orphan copied diagnostics'); },
      loadSettings() { assert.fail('orphan loaded settings'); },
    });
    announceBoot(c);
    vm.runInContext(functionSlice(content, '  function applyPill()', '  // 진단 정보'), c);
    c.applyPill(); const button = c.btn;
    vm.runInContext(functionSlice(content, '  function onKeydown(', "  window.addEventListener('keydown'"), c);
    vm.runInContext(functionSlice(content, '  const popupToggle =', '  // 진단용'), c);
    vm.runInContext(functionSlice(content, '  function onMessage(', "  window.addEventListener('message'"), c);
    c.chrome.runtime.id = undefined;
    const event = { code: 'KeyK', metaKey: true, shiftKey: input === 'shift-pill',
      preventDefault() { assert.fail('orphan consumed default'); },
      stopImmediatePropagation() { assert.fail('orphan stopped propagation'); },
    };
    if (input.includes('pill')) button.click(event);
    else if (input === 'shortcut') c.onKeydown(event);
    else if (input === 'popup-toggle') vm.runInContext('popupToggle()', c);
    else if (input === 'popup-start') vm.runInContext('start()', c);
    else c.onMessage({ data: { __gwJa2KoToggle: true }, origin: 'test', source: {} });
    assert.equal(c.torn, true); assert.equal(c.on, false);
    assert.equal(document.count('__gwTranslateSwitchBoot_v1'), 0);
  });
}
