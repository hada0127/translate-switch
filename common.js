// 옵션 페이지·서비스 워커·bridge 가 같이 쓰는 기본값과 언어 목록.
// 언어 목록은 Chrome 154 Translator API 실측(2026-10-08)에서 「unavailable」 이 아닌 것만 — 별칭(iw·zh-CN 등)은 뺐다.
var GW_LANG_CODES = ['ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hr', 'hu',
  'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te',
  'th', 'tr', 'uk', 'vi', 'zh', 'zh-Hant'];

// source: 'auto' = 자동 감지 · target: '' = 브라우저 기본 언어
var GW_RULE = { enabled: true, source: 'auto', target: '', auto: false };
var GW_DEFAULTS = {
  shortcut: true,
  pill: true,
  position: 'bottom-right',
  highlight: true,       // 번역된 부분 표시(옅은 배경 + 점선 밑줄)
  hlColor: '#ED3424',    // 표시 색상
  all: { ...GW_RULE, enabled: false }, // 모든 사이트 기본 규칙
  sites: [],                           // 사이트별 규칙 — 모든 사이트 규칙보다 우선
};
var GW_ALL_PATTERN = '*://*/*';
var GW_HL_DEFAULT = '#ED3424';

// 번역된 부분 표시 스타일(옅은 배경 + 점선 밑줄). content.js 에도 같은 식이 있다(MAIN world 라 공유 불가).
function gwHlCss(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [, 'ED3424'];
  const n = parseInt(m[1], 16);
  const rgb = `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`;
  return `background:rgba(${rgb},.10);text-decoration:underline dotted rgba(${rgb},.75);text-underline-offset:3px`;
}

// 현지화 문구. _locales/<언어>/messages.json 의 {1}{2} 자리에 인자를 넣는다($ 기호는 크롬이 따로 해석해 쓰지 않는다).
function t(key, ...args) {
  const m = (typeof chrome !== 'undefined' && chrome.i18n?.getMessage(key)) || key;
  return m.replace(/\{(\d)\}/g, (_, n) => String(args[n - 1] ?? ''));
}

// 브라우저 언어를 지원 목록의 코드로 맞춘다 (zh-TW → zh-Hant, en-US → en, iw → he).
function gwBrowserLang() {
  for (const raw of navigator.languages || [navigator.language || 'en']) {
    const l = raw.toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-Hant';
    const base = l.split('-')[0] === 'iw' ? 'he' : l.split('-')[0];
    if (GW_LANG_CODES.includes(base)) return base;
  }
  return 'en';
}
function gwLangName(code, ui = navigator.language) {
  try { return new Intl.DisplayNames([ui], { type: 'language' }).of(code) || code; } catch { return code; }
}
var gwPattern = (host) => `*://${host}/*`;
// 사이트 주소 규칙: 영문·숫자·하이픈 이름이 점으로 이어진 것(*. 와일드카드 허용), localhost 허용. 국제 도메인은 punycode(xn--)로.
var gwValidHost = (h) => /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/.test(h) && (h.includes('.') || h === 'localhost');
// 설정 저장 — 각 화면이 들고 있던 옛 전체 값을 덮어쓰지 않게, 최신 값을 읽어 바꿀 것만 바꾸고 바뀐 키만 쓴다.
// 팝업·설정·접근 허용 화면은 모두 확장 출처라 Web Locks 로 한 줄로 세운다(동시에 저장하면 서로 덮어쓰지 않게).
async function gwUpdate(mutate) {
  const run = async () => {
    const before = await chrome.storage.sync.get(GW_DEFAULTS);
    const s = structuredClone(before);
    mutate(s);
    const changed = {};
    for (const k of Object.keys(s)) if (JSON.stringify(s[k]) !== JSON.stringify(before[k])) changed[k] = s[k];
    if (Object.keys(changed).length) await chrome.storage.sync.set(changed); // 용량 초과 등은 호출한 쪽에서 잡아 알린다
    return s;
  };
  return navigator.locks ? navigator.locks.request('gw-settings', run) : run();
}
function gwHostMatches(rule, hostname) {
  if (rule.startsWith('*.')) return hostname === rule.slice(2) || hostname.endsWith(rule.slice(1));
  return hostname === rule;
}
// 정확히 같은 호스트 규칙이 와일드카드(*.example.com) 규칙보다 우선
var gwSiteFor = (sites, hostname) => sites.find((x) => x.host === hostname) || sites.find((x) => gwHostMatches(x.host, hostname));
// 이 호스트에 적용할 규칙: 사이트별 규칙(꺼져 있으면 null) → 모든 사이트 규칙 → null
function gwResolve(s, hostname) {
  const site = gwSiteFor(s.sites, hostname);
  const rule = site || (s.all?.enabled ? s.all : null);
  if (!rule || !rule.enabled) return null;
  return { source: rule.source || 'auto', target: rule.target || gwBrowserLang(), auto: !!rule.auto };
}

// 슬롯의 엔트리가 자원을 소유한다 — 늦게 끝난 생성도 해제는 정확히 한 번.
function gwDestroy(x) { try { x?.destroy?.(); } catch {} }
function gwSlots() {
  const map = new Map();
  const owns = (key, entry) => map.get(key) === entry;
  function destroyOnce(entry) {
    if (entry.destroyed || !entry.settled || entry.value == null) return;
    entry.destroyed = true;
    gwDestroy(entry.value);
  }
  function release(key) {
    const entry = map.get(key);
    if (!entry) return false;
    map.delete(key);
    destroyOnce(entry);
    return true;
  }
  return {
    get(key, make) {
      if (map.has(key)) return map.get(key).p;
      const entry = { p: Promise.resolve().then(make), settled: false, value: undefined, destroyed: false };
      map.set(key, entry);
      entry.p.then((v) => { entry.settled = true; entry.value = v; if (!owns(key, entry)) destroyOnce(entry); },
        () => { entry.settled = true; if (owns(key, entry)) map.delete(key); });
      return entry.p;
    },
    owns, entryOf: (key) => map.get(key), promiseOf: (key) => map.get(key)?.p,
    has: (key) => map.has(key), keys: () => map.keys(), get size() { return map.size; }, release,
    releaseAll() { let n = 0; for (const key of map.keys()) if (release(key)) n++; return n; },
  };
}
var GW_PROBE_PAIR = { sourceLanguage: 'en', targetLanguage: 'es' }; // 서비스 포화 판별용 쌍의 신뢰도: UNVERIFIED (실 Chrome QA)
async function gwUnavailableReason(src, tgt) {
  if (!GW_LANG_CODES.includes(src) || !GW_LANG_CODES.includes(tgt)) return 'pair';
  try { return await Translator.availability(GW_PROBE_PAIR) === 'unavailable' ? 'service' : 'pair'; } catch { return 'service'; }
}
// executeScript 로 직렬화하므로 외부 클로저를 참조하지 않는다.
function gwProbe() {
  const n = globalThis.__gwTS2;
  if (n) {
    try { if (n.alive() === true) return 'alive'; } catch {}
    try { n.teardown(); } catch {}
    return 'torn';
  }
  return globalThis.__gwTS ? 'legacy' : 'none';
}
