importScripts('common.js');

const FILES = ['common.js', 'content.js']; // 격리 world(확장 전용 실행 공간)에서 돈다
const ID = 'gw-content';

// 「모든 사이트」가 켜져 있고 권한이 있으면 전체에, 아니면 켜진 사이트 중 권한 있는 곳에만 등록한다.
// 사이트별로 끈 곳은 등록은 되더라도 content.js 가 규칙을 null 로 보고 아무것도 안 한다.
async function wantedMatches() {
  const s = await chrome.storage.sync.get(GW_DEFAULTS);
  if (s.all?.enabled && (await chrome.permissions.contains({ origins: [GW_ALL_PATTERN] }))) return [GW_ALL_PATTERN];
  const out = [];
  for (const site of s.sites) {
    // 다른 기기에서 동기화된 이상한 주소 하나 때문에 등록 전체가 실패하지 않게 형식부터 거른다.
    if (!site.enabled || !gwValidHost(site.host)) continue;
    const p = gwPattern(site.host);
    if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) out.push(p);
  }
  return [...new Set(out)].sort();
}

// 등록을 지웠다가 다시 만들면 그 사이 열린 페이지가 스크립트를 못 받는다. 범위가 바뀐 경우에만 제자리에서 고친다.
async function doSync() {
  const matches = await wantedMatches();
  const [cur] = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  const before = cur ? [...cur.matches].sort() : [];
  if (JSON.stringify(before) === JSON.stringify(matches)) return;
  const base = { matches, allFrames: true, matchOriginAsFallback: true, runAt: 'document_idle', js: FILES };
  if (!matches.length) { if (cur) await chrome.scripting.unregisterContentScripts({ ids: [ID] }); }
  else if (cur) await chrome.scripting.updateContentScripts([{ id: ID, ...base }]);
  else await chrome.scripting.registerContentScripts([{ id: ID, ...base }]);
  // 새로 범위에 들어온 사이트의 열린 탭에는 새로고침 없이 바로 붙인다.
  const added = matches.filter((m) => !before.includes(m));
  if (added.length) injectOpenTabs(added);
}

// 이벤트가 겹쳐 오면 등록이 엉키므로 한 줄로 세운다.
let chain = Promise.resolve();
function sync() { chain = chain.then(doSync).catch((e) => console.warn('[translate-switch] sync', e)); return chain; }

chrome.runtime.onInstalled.addListener(async () => {
  await sync();
  const [cur] = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  if (cur?.matches.length) await injectOpenTabs(cur.matches);
});
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((c, area) => { if (area === 'sync' && (c.sites || c.all)) sync(); });
chrome.permissions.onAdded.addListener(async (p) => {
  // 접근 허용 화면이 권한 창을 띄운 사이 사라졌어도(페이지 이동 등) 허용된 사이트의 사용·자동 번역을 켠다.
  // 요청 번호별 기록 중 이번에 허용된 범위와 맞는 것만 마무리한다(창 여러 개에서 동시에 요청해도 서로 덮지 않는다).
  const all = await chrome.storage.session.get(null);
  for (const [k, g] of Object.entries(all)) {
    if (!k.startsWith('gwGrantPending:') || !g) continue;
    const want = g.all ? GW_ALL_PATTERN : gwPattern(g.host);
    if (Date.now() - g.at > 10 * 60 * 1000) { chrome.storage.session.remove(k); continue; }
    if (!(p.origins || []).includes(want)) continue;
    await chrome.storage.session.remove(k);
    // grant.js 와 같은 마무리(둘 다 돌아도 결과는 같다)
    await gwUpdate((s) => {
      if (g.all) { Object.assign(s.all, { enabled: true, auto: true }); s.sites = s.sites.filter((x) => x.host !== g.host); return; }
      let rule = s.sites.find((x) => x.host === g.host);
      if (!rule) { rule = { ...GW_RULE, host: g.host }; s.sites.unshift(rule); }
      Object.assign(rule, { enabled: true, auto: true });
    }).catch((e) => console.warn('[translate-switch] grant save', e));
  }
  sync();
});
chrome.permissions.onRemoved.addListener(sync);

// 범위에 들어온 사이트의 열린 탭에 새로고침 없이 바로 붙인다(content.js 는 두 번 붙어도 한 번만 돈다).
async function injectOpenTabs(origins) {
  // 대기 시간은 복구 지연 상한일 뿐이다(3초는 UNVERIFIED 정책값). Chrome 요청 자체는 취소되지 않는다.
  async function bounded(p) {
    let timer;
    try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('frame recovery timeout')), 3000); })]); }
    finally { clearTimeout(timer); }
  }
  async function children(tabId) {
    try {
      // 권한을 추가하지 않고 프레임을 찾는다. 이 탐침이 멈춰도 최상위 복구는 이미 끝났다.
      const probes = await bounded(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: gwProbe, injectImmediately: true }));
      await Promise.all(probes.filter(({ frameId, result }) => frameId !== 0 && (result === 'none' || result === 'torn')).map(async ({ frameId }) => {
        try { await bounded(chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['common.js', 'content.js'] })); }
        catch (e) { console.warn('[translate-switch] inject frame', frameId, e); }
      }));
    } catch (e) { console.warn('[translate-switch] child probe', e); }
  }
  const tabs = await chrome.tabs.query({ url: origins }).catch(() => []);
  // 한 탭의 탐침·주입 대기가 다른 탭의 복구를 막지 않는다.
  await Promise.all(tabs.map(async (tb) => {
    try {
      const probes = await bounded(chrome.scripting.executeScript({ target: { tabId: tb.id, frameIds: [0] }, func: gwProbe, injectImmediately: true }));
      const top = probes.find(({ frameId }) => frameId === 0);
      if (!top) throw new Error('top frame probe missing');
      if (top.result === 'legacy') console.info('[translate-switch] legacy 1.5.0 instance, refresh needed');
      if (top.result === 'none' || top.result === 'torn') {
        await bounded(chrome.scripting.executeScript({ target: { tabId: tb.id, frameIds: [0] }, files: FILES }));
      }
      await children(tb.id);
    } catch (e) { console.warn('[translate-switch] inject', e); }
  }));
}
