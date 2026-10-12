gwLocalize();
gwWarmUp();
// 툴바 아이콘 팝업: 지금 탭의 사이트를 바로 추가·설정하고, 전체 설정으로 들어간다.
let state;
let tab;
let host = '';
let legacyBlocked = null; // null 이면 아직 최상위 탐침 전이다.
const msg = (t) => { $('msg').textContent = t; };
const fill = (id, el) => { $(id).textContent = ''; $(id).append(el); };

// 지금 탭에 스크립트를 바로 붙인다(새로고침 없이). 이미 붙어 있으면 건너뛴다.
async function injectNow() {
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
  try {
    const probes = await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: gwProbe, injectImmediately: true }));
    const top = probes.find(({ frameId }) => frameId === 0);
    if (!top) throw new Error('top frame probe missing');
    legacyBlocked = top.result === 'legacy';
    if (legacyBlocked) {
      msg(t('legacyRefresh'));
      console.info('[translate-switch] legacy 1.5.0 instance, refresh needed');
    }
    if (top.result === 'none' || top.result === 'torn') {
      await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['common.js', 'content.js'] }));
    }
    // 팝업 시작·권한 동작은 하위 프레임을 기다리지 않는다.
    void children(tab.id);
    return !legacyBlocked;
  } catch (e) {
    msg(t('injectFail', e.message));
    return false;
  }
}

// 페이지 동작 전에 최상위의 옛 인스턴스를 확인한다(직접 권한 링크도 같은 검사).
async function pageActionAllowed() {
  if (legacyBlocked === null) {
    try {
      const probes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: gwProbe });
      const top = probes.find(({ frameId }) => frameId === 0);
      if (!top) { msg(t('injectFail', 'top frame probe missing')); return false; }
      legacyBlocked = top.result === 'legacy';
    } catch (e) { msg(t('injectFail', e.message)); return false; }
  }
  if (legacyBlocked) { msg(t('legacyRefresh')); return false; }
  return true;
}

// 접근 허용 화면을 지금 페이지 위 레이어(가운데 카드 + 어두운 배경)로 띄운다.
// 확장 팝업에서 권한을 요청하면 권한 창이 뜰 때 팝업이 닫혀 허용이 버려지므로, 닫히지 않는 페이지 안 레이어에서 요청한다.
async function showGrantLayer(immediate = false) {
  if (!(await pageActionAllowed())) return false;
  // 접근 허용 화면은 웹 페이지가 열 수 있는 주소라, 주소에 사이트를 실으면 악성 페이지가 다른 사이트로 바꿔 띄울 수 있다.
  // 그래서 요청 내용은 확장만 읽는 세션 저장소에 두고, 주소에는 한 번 쓰고 버리는 번호만 싣는다.
  const req = crypto.randomUUID();
  await chrome.storage.session.set({ [`grant:${req}`]: { host, at: Date.now() } });
  const url = chrome.runtime.getURL(`grant.html?req=${req}&layer=1${immediate ? '&all=1' : ''}`);
  // 페이지의 content.js 가 번역이 시작된 뒤에 레이어를 띄운다(처음 쓰는 사이트는 알약 클릭이 먼저 필요하다).
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [url, immediate], func: (u, now) => { if (globalThis.__gwTSGrant) { globalThis.__gwTSGrant(u, now); return true; } return false; },
    });
    if (result) return true;
  } catch {}
  try {
    // content.js 가 없는 페이지면 레이어를 직접 띄운다.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [url],
      func: (src) => {
        document.getElementById('gw-ja2ko-grant')?.remove();
        const wrap = document.createElement('div');
        wrap.id = 'gw-ja2ko-grant';
        wrap.dataset.gwJa2koUi = '1';
        Object.assign(wrap.style, { all: 'initial', position: 'fixed', inset: '0', zIndex: 2147483647, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' });
        const f = document.createElement('iframe');
        f.src = src;
        f.allow = '';
        Object.assign(f.style, { width: '440px', maxWidth: 'calc(100vw - 32px)', height: '390px', border: '0',
          borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,.35)', background: '#fff', colorScheme: 'normal' });
        wrap.append(f);
        const close = () => { wrap.remove(); removeEventListener('message', onMsg); removeEventListener('keydown', onKey, true); };
        wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
        const onMsg = (e) => { if (e.source === f.contentWindow && e.data?.gwGrant === 'close') close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        addEventListener('message', onMsg);
        addEventListener('keydown', onKey, true);
        document.documentElement.append(wrap);
        f.addEventListener('load', () => f.focus());
      },
    });
    return true;
  } catch {
    // 레이어를 못 띄우는 페이지면 작은 창으로 연다.
    chrome.windows.create({ url: `grant.html?req=${req}`, type: 'popup', width: 440, height: 410, focused: true });
    return false;
  }
}

// 이 호스트 전용 규칙(없으면 지금 적용 중인 규칙을 복사해 만든다)을 고친다 — 사이트 자동 추가.
// 와일드카드(*.example.com) 규칙을 직접 고치지 않고 이 호스트 규칙을 맨 앞에 새로 둔다.
let allOn = false;
function siteRuleIn(s) {
  let r = s.sites.find((x) => x.host === host);
  if (!r) {
    const base = gwSiteFor(s.sites, host) || (allOn ? s.all : { ...GW_RULE, enabled: false });
    r = { ...GW_RULE, ...base, host };
    s.sites.unshift(r);
  }
  return r;
}
// 저장 직전 최신 설정을 읽어 이 사이트 규칙만 고친다(다른 화면·다른 기기의 변경을 덮어쓰지 않게).
async function editSite(fn) {
  try { state = await gwUpdate((s) => fn(siteRuleIn(s))); return true; } catch { msg(t('saveFailed')); return false; }
}

// ── 처음 설치: 이 사이트에 필요한 모델이 없으면 팝업에서 바로 받는다 ──
let pageLang = '';
async function readPageLang() {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: () => document.documentElement.lang || '',
  }).catch(() => [{}]);
  // 페이지를 못 읽으면(권한 없음 등) 주소의 국가 도메인으로 짐작한다.
  const TLD = { jp: 'ja', cn: 'zh', tw: 'zh-Hant', hk: 'zh-Hant', kr: 'ko', de: 'de', fr: 'fr', es: 'es', it: 'it', ru: 'ru',
    br: 'pt', pt: 'pt', nl: 'nl', pl: 'pl', tr: 'tr', vn: 'vi', th: 'th', id: 'id', in: 'hi', se: 'sv', dk: 'da', fi: 'fi',
    no: 'no', cz: 'cs', gr: 'el', il: 'he', ua: 'uk', ro: 'ro', hu: 'hu', bg: 'bg', sk: 'sk', si: 'sl', hr: 'hr', lt: 'lt' };
  const l = String(result || TLD[host.split('.').pop()] || '').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-Hant';
  const base = l.split('-')[0] === 'iw' ? 'he' : l.split('-')[0];
  return GW_LANG_CODES.includes(base) ? base : '';
}
// 크롬은 사이트(출처)마다 모델 상태를 따로 알려 준다 — 페이지에서 이미 쓰는 모델도 확장 쪽에서 물으면 「받기 필요」로 나온다.
// 그래서 모델 상태는 지금 탭의 페이지에 묻는다(팝업을 열면 받는 임시 권한으로). 못 물으면 확장 쪽 값을 쓴다.
async function pageAvail(kind, src, tgt) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, args: [kind, src || '', tgt || ''], // undefined 는 넘길 수 없다(직렬화 오류)
    func: async (k, s, tg) => {
      try {
        if (k === 'detector') return 'LanguageDetector' in self ? await LanguageDetector.availability() : null;
        return 'Translator' in self ? await Translator.availability({ sourceLanguage: s, targetLanguage: tg }) : null;
      } catch { return null; }
    },
  }).catch(() => [{}]);
  if (result) return result;
  if (kind === 'detector') return LanguageDetector.availability().catch(() => 'unavailable');
  return Translator.availability({ sourceLanguage: src, targetLanguage: tgt }).catch(() => 'unavailable');
}
gwOnModelDone = () => renderModels();
let modelSeq = 0;
async function renderModels() {
  const seq = ++modelSeq;
  const site = gwSiteFor(state.sites, host);
  const rule = site || (allOn ? state.all : GW_RULE);
  const source = rule.source || 'auto';
  const target = rule.target || gwBrowserLang();
  const rows = [];
  if (!('Translator' in self)) {
    rows.push(() => { const tr = document.createElement('tr'); const c = document.createElement('td'); c.className = 'warn'; c.textContent = t('noTranslator'); tr.append(c); return tr; });
  } else {
    if (source === 'auto' && 'LanguageDetector' in self) {
      const a = await pageAvail('detector');
      if (gwAvail('detector', a) !== 'available' || downloads.has('detector')) rows.push(() => modelRow(t('langDetect'), 'detector', a, createDetector()));
    }
    // 자동 감지면 페이지가 선언한 언어(<html lang>)를 원문으로 짐작해 그 쌍을 받는다.
    const src = source === 'auto' ? pageLang : source;
    if (src && src !== target) {
      const key = `${src}>${target}`;
      const a = await pageAvail('translator', src, target);
      if ((gwAvail(key, a) !== 'available' && a !== 'unavailable') || downloads.has(key)) {
        rows.push(() => modelRow(`${gwLangName(src)} → ${gwLangName(target)}`, key, a, createTranslator(src, target)));
      }
    }
  }
  if (seq !== modelSeq) return;
  gwForgetViews();
  const body = $('models');
  body.textContent = '';
  body.append(...rows.map((make) => make())); // 옛 갱신 함수를 버린 뒤에 행을 만든다
  $('modelBox').hidden = rows.length === 0;
}

// 켜기: 규칙을 켜고 지금 탭에 붙인다. 영구 권한이 없으면 번역이 뜬 뒤 레이어에서 받는다.
async function turnOn(patch = {}) {
  if (!(await pageActionAllowed())) return;
  if (!(await editSite((r) => Object.assign(r, { enabled: true }, patch)))) return render();
  const injected = await injectNow();
  if (legacyBlocked) return;
  // 자동 번역 체크와 상관없이 지금 탭은 바로 번역을 시작한다.
  if (injected) await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__gwTSStart?.() }).catch(() => {});
  const granted = allOn || (await chrome.permissions.contains({ origins: [gwPattern(host)] }));
  if (!granted) { await showGrantLayer(); if (legacyBlocked === false) window.close(); return; }
  if (injected && $('msg').textContent !== t('legacyRefresh')) msg(t('addedApplied'));
  render();
}

async function render() {
  const site = gwSiteFor(state.sites, host);
  const allGranted = await chrome.permissions.contains({ origins: [GW_ALL_PATTERN] });
  allOn = state.all.enabled && allGranted;
  renderModels(); // allOn 을 정한 뒤에 — 적용 규칙과 같은 언어 쌍을 보여 준다
  const rule = site || (allOn ? state.all : null);
  // 규칙은 켜져 있는데 영구 권한이 없으면(창을 닫았거나 거절) 안내와 「접근 허용」 링크를 보여 준다.
  const hostGranted = allOn || (await chrome.permissions.contains({ origins: [gwPattern(host)] }));
  const on = !!rule?.enabled;
  if (on && !hostGranted) {
    // 켜 두었지만 영구 권한이 없음 — 이번 탭만 적용되고 다음 방문엔 안 붙는다.
    $('ruleFrom').textContent = `${t('noPermNote')} `;
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = t('grantBtn');
    a.addEventListener('click', async (e) => { e.preventDefault(); await showGrantLayer(); if (legacyBlocked === false) window.close(); });
    $('ruleFrom').append(a);
  } else $('ruleFrom').textContent = site ? (site.host === host ? t('ruleSite') : t('ruleSiteOf', site.host))
    : allOn ? t('ruleAll') : t('ruleNone');

  // 「켜기」 = 이 사이트에서 사용(규칙 켜기) + 지금 탭에 바로 적용. 「끄기」 = 규칙 끄기(탭의 번역도 꺼진다).
  const tb = $('toggle');
  tb.textContent = on ? t('turnOff') : t('turnOn');
  tb.classList.toggle('primary', !on);
  tb.onclick = async () => {
    if (!(await pageActionAllowed())) return;
    if (on) { if (await editSite((r) => { r.enabled = false; })) msg(t('turnedOff')); render(); return; }
    await turnOn();
  };
  const r = rule || { ...GW_RULE };
  fill('src', gwLangSelect(r.source, { withAuto: true, label: t('source') }, async (v) => { if (!(await pageActionAllowed())) return; await editSite((x) => { x.source = v; }); render(); }));
  fill('tgt', gwLangSelect(r.target, { withBrowser: true, label: t('target') }, async (v) => { if (!(await pageActionAllowed())) return; await editSite((x) => { x.target = v; }); render(); }));
  fill('auto', gwCheck(!!r.auto, async (v) => {
    if (!(await pageActionAllowed())) return;
    if (v && !on) { await turnOn({ auto: true }); return; } // 꺼진 사이트에서 자동 번역을 켜면 사이트도 켠다
    await editSite((x) => { x.auto = v; });
  }, t('autoThisSite')));
  $('langs').classList.toggle('off', !on);
  $('useAll').hidden = allOn; // 이미 모든 사이트에서 동작 중이면 숨긴다
}

$('openOptions').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
// 「모든 사이트에서 사용」: 지금 탭에 바로 붙이고 레이어를 즉시 띄운다(거기서 「모든 사이트 허용」을 누르면 어디서든 동작).
$('useAll').addEventListener('click', async () => {
  if (!(await pageActionAllowed())) return;
  if (!(await injectNow())) return;
  await showGrantLayer(true);
  window.close();
});

(async () => {
  // 개발용(압축 해제 설치에서만): popup.html?tabIndex=N&url=… 로 열면 이 창의 N번째 탭을 대상으로 한다.
  // 웹 스토어 설치본에는 update_url 이 붙어 이 경로가 꺼진다.
  const q = new URLSearchParams(location.search);
  const dev = !chrome.runtime.getManifest().update_url;
  if (dev && q.has('tabIndex')) [tab] = await chrome.tabs.query({ currentWindow: true, index: Number(q.get('tabIndex')) });
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (dev && !tab.url && q.get('url')) tab.url = q.get('url');
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol) && !/^chromewebstore\.google\.com$|^chrome\.google\.com$/.test(u.hostname)) host = u.hostname;
  } catch {}
  if (!host) { $('noPage').hidden = false; return; }
  $('page').hidden = false;
  $('host').textContent = host;
  state = await chrome.storage.sync.get(GW_DEFAULTS);
  await gwLoadDone();
  pageLang = await readPageLang();
  render();
  // 팝업이 열려 있는 동안 다른 화면·기기에서 바뀐 설정도 반영한다.
  chrome.storage.onChanged.addListener(async (_, area) => { if (area === 'sync') { state = await chrome.storage.sync.get(GW_DEFAULTS); render(); } });
})();
