// 옵션·팝업이 같이 쓰는 화면 조각.
const $ = (id) => document.getElementById(id);

// 언어 선택 상자. withAuto = 「자동 감지」(원문용), withBrowser = 「브라우저 언어」(번역용)
function gwLangSelect(value, { withAuto = false, withBrowser = false, label = '' } = {}, onChange) {
  const sel = document.createElement('select');
  if (label) sel.setAttribute('aria-label', label); // 스크린리더용 이름
  if (withAuto) sel.add(new Option(t('autoDetect'), 'auto', false, value === 'auto'));
  if (withBrowser) sel.add(new Option(t('browserLang', gwLangName(gwBrowserLang())), '', false, value === ''));
  const sorted = [...GW_LANG_CODES].sort((a, b) => gwLangName(a).localeCompare(gwLangName(b), navigator.language));
  for (const code of sorted) sel.add(new Option(`${gwLangName(code)} (${code})`, code, false, code === value));
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function gwCheck(value, onChange, label = '') {
  const c = document.createElement('input');
  c.type = 'checkbox';
  if (label) c.setAttribute('aria-label', label);
  c.checked = value;
  c.addEventListener('change', () => onChange(c.checked, c));
  return c;
}
// data-i18n="키"(글자) · data-i18n-ph(placeholder) · data-i18n-title(title) 를 현지화 문구로 채운다.
function gwLocalize(root = document) {
  for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
  for (const e of root.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  document.documentElement.lang = chrome.i18n.getUILanguage();
  if (['ar', 'he'].includes(chrome.i18n.getUILanguage().split('-')[0])) document.documentElement.dir = 'rtl';
}
// 팝업·설정이 열릴 때 번역 서비스를 미리 깨운다 — 첫 「모델 받기」가 서비스가 뜨기 전이라 실패하는 일을 줄인다.
// 받아 둔 모델이 있으면 그것으로, 없으면 언어 감지기로 깨운다(둘 다 클릭이 필요 없다). 실패해도 무시.
async function gwWarmUp() {
  try {
    if (!('Translator' in self)) return;
    for (const src of GW_LANG_CODES) {
      const tgt = gwBrowserLang();
      if (src === tgt) continue;
      if ((await Translator.availability({ sourceLanguage: src, targetLanguage: tgt })) === 'available') {
        const x = await Translator.create({ sourceLanguage: src, targetLanguage: tgt }); x.destroy?.(); return;
      }
    }
    if ('LanguageDetector' in self && (await LanguageDetector.availability()) === 'available') {
      const x = await LanguageDetector.create(); x.destroy?.();
    }
  } catch {}
}
const gwGrant = (origin) => chrome.permissions.request({ origins: [origin] }).catch(() => false);

const td = (child, cls) => { const t = document.createElement('td'); if (cls) t.className = cls; if (child) t.append(child); return t; };

// ── 번역 모델 상태·받기 ──
const AVAIL = { available: t('availAvailable'), downloadable: t('availDownloadable'), downloading: t('availDownloading'), unavailable: t('availUnavailable') };
const downloads = new Map(); // 'ja>ko' 또는 'detector' -> { loaded, error, note, views: Set<갱신 함수> }
const gwLastFail = new Map(); // 받기에 실패한 모델 -> 마지막 오류 문구(다음 클릭까지 표시)
function startDownload(key, create) {
  if (downloads.has(key)) return;
  const d = { loaded: 0, error: '', views: new Set() };
  downloads.set(key, d);
  const paint = () => d.views.forEach((f) => f());
  const monitor = (m) => m.addEventListener('downloadprogress', (e) => { d.loaded = e.loaded; paint(); });
  // 번역 서비스가 막 뜰 때 생성이 간헐적으로 실패한다(「Unable to create translator…」 등) — 잠깐 쉬고 다시(최대 4번).
  // 클릭이 필요하다는 거절(NotAllowedError)만 바로 알린다.
  // ⚠️ 크롬은 클릭 하나를 모델 생성 한 번에만 쓰게 한다 — 첫 시도가 일시 오류로 실패하면 클릭은 이미 쓰인 뒤라,
  // 재시도는 「클릭 필요」로 거절된다. 그래서 재시도는 하되, 거절되면 원인(첫 오류)과 함께 「한 번 더 눌러 달라」고 알린다.
  const errs = [];
  const attempt = (n) => create(monitor).catch((e) => {
    errs.push(`${n}: ${e?.name || 'Error'}: ${e?.message || e}`);
    if (e?.name === 'NotAllowedError' || n >= 4) throw e;
    d.loaded = 0; d.note = `${t('retrying')} ${n}/3`; paint();
    return new Promise((r) => setTimeout(r, 1500 * n)).then(() => attempt(n + 1));
  });
  attempt(1)
    .then((x) => { x.destroy?.(); downloads.delete(key); gwMarkDone(key); gwOnModelDone(); })
    .catch((e) => {
      // 실패 문구는 지우지 않고 남긴다(원인 파악용). 버튼은 다시 누를 수 있다.
      const again = e?.name === 'NotAllowedError' && errs.length > 1;
      gwLastFail.set(key, (again ? `${t('clickAgain')} ` : '') + errs.join(' / '));
      downloads.delete(key);
      gwOnModelDone();
    });
}
const createTranslator = (src, tgt) => (monitor) => Translator.create({ sourceLanguage: src, targetLanguage: tgt, monitor });
const createDetector = () => (monitor) => LanguageDetector.create({ monitor });

// 다 받은 직후에도 크롬이 잠깐 「받기 필요」로 알려 주는 경우가 있어(같은 모델을 두 번 받게 됨),
// 이 확장이 받기에 성공한 쌍은 직접 기억해 「받아 둠」으로 본다. 세션 저장소라 브라우저를 끄면 다시 크롬 값을 믿는다.
const gwDone = new Set();
function gwMarkDone(key) { gwDone.add(key); chrome.storage.session?.set({ [`done:${key}`]: 1 }).catch(() => {}); }
async function gwLoadDone() {
  const all = await chrome.storage.session?.get(null).catch(() => ({})) || {};
  for (const k of Object.keys(all)) if (k.startsWith('done:')) gwDone.add(k.slice(5));
}
const gwAvail = (key, a) => (gwDone.has(key) ? 'available' : a);

function modelRow(label, key, avail, create) {
  avail = gwAvail(key, avail);
  const tr = document.createElement('tr');
  const st = document.createElement('span');
  st.textContent = AVAIL[avail] || avail;
  const cell = document.createElement('div');
  if (avail === 'downloadable' || avail === 'downloading' || downloads.has(key)) {
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = t('downloadModel');
    const bar = document.createElement('progress');
    bar.max = 1;
    // 표가 다시 그려져도 진행 중인 받기는 이 맵에서 상태를 이어받는다.
    const show = () => {
      const d = downloads.get(key);
      b.disabled = !!d;
      bar.hidden = !d;
      if (d) {
        // 진행률 이벤트가 오기 전(0%)에는 값 없는 막대(움직임)로 보여 굳은 것처럼 보이지 않게 한다.
        if (d.loaded > 0) bar.value = d.loaded; else bar.removeAttribute('value');
        st.textContent = d.error ? t('failed', d.error) : d.note ? d.note : d.loaded > 0 ? t('downloadingPct', Math.round(d.loaded * 100)) : t('availDownloading');
      }
      else if (gwLastFail.has(key)) { st.textContent = t('failed', gwLastFail.get(key)); st.classList.add('warn'); }
    };
    b.addEventListener('click', () => { gwLastFail.delete(key); st.classList.remove('warn'); startDownload(key, create); downloads.get(key)?.views.add(show); show(); });
    downloads.get(key)?.views.add(show);
    show();
    cell.append(b, ' ', bar);
  }
  tr.append(td(document.createTextNode(label)), td(st), td(cell));
  return tr;
}

let gwOnModelDone = () => {};
// 표를 다시 그리기 전에 옛 행의 갱신 함수를 버린다.
function gwForgetViews() { for (const d of downloads.values()) d.views.clear(); }
