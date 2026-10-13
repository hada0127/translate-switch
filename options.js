gwLocalize();
gwWarmUp();
$('newHost').setAttribute('aria-label', t('addPlaceholder'));
$('hlColor').setAttribute('aria-label', t('highlightColor'));
let state = structuredClone(GW_DEFAULTS);
const fill = (id, el) => { $(id).textContent = ''; $(id).append(el); };

function warnRow(text) {
  const tr = document.createElement('tr');
  const c = document.createElement('td');
  c.className = 'warn';
  c.colSpan = 3;
  c.textContent = text;
  tr.append(c);
  return tr;
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  renderModels();
  $('shortcut').checked = state.shortcut;
  $('hlOn').checked = state.highlight;
  $('hlColor').value = state.hlColor || GW_HL_DEFAULT;
  $('hlRow').classList.toggle('off', !state.highlight);
  $('hlPreview').style.cssText = gwHlCss(state.hlColor);
  $('pill').checked = state.pill;
  $('grid').classList.toggle('disabled', !state.pill);
  for (const b of document.querySelectorAll('#grid [data-pos]')) b.classList.toggle('sel', b.dataset.pos === state.position);

  // 모든 사이트
  const allGranted = await chrome.permissions.contains({ origins: [GW_ALL_PATTERN] });
  const a = state.all;
  fill('allOn', gwCheck(a.enabled && allGranted, async (v, box) => {
    if (v && !(await gwGrant(GW_ALL_PATTERN))) { box.checked = false; return; }
    const ok = await save((x) => { x.all.enabled = v; x.all.auto = false; });
    // 끄면 넓은 권한을 돌려준다(사이트별로 켜 둔 곳이 없을 때만 — 그 사이트들이 이 권한에 기대고 있을 수 있다).
    if (ok && !v && !state.sites.some((x) => x.enabled)) chrome.permissions.remove({ origins: [GW_ALL_PATTERN] }).catch(() => {});
  }, t('allSitesUse')));
  fill('allSrc', gwLangSelect(a.source, { withAuto: true, label: `${t('allSites')} ${t('source')}` }, (v) => save((x) => { x.all.source = v; })));
  fill('allTgt', gwLangSelect(a.target, { withBrowser: true, label: `${t('allSites')} ${t('target')}` }, (v) => save((x) => { x.all.target = v; })));
  $('allSrc').parentElement.classList.toggle('off', !(a.enabled && allGranted));

  // 사이트별
  const granted = await Promise.all(state.sites.map((s) => chrome.permissions.contains({ origins: [gwPattern(s.host)] })));
  if (seq !== renderSeq) return;
  const body = $('sites');
  body.textContent = '';
  $('empty').style.display = state.sites.length ? 'none' : '';
  for (const [i, s] of state.sites.entries()) {
    const tr = document.createElement('tr');
    const host = document.createElement('div');
    host.textContent = s.host;
    if (!granted[i] && !(state.all.enabled && allGranted)) {
      const w = document.createElement('div');
      w.className = 'warn';
      w.textContent = `${t('noAccess')} `;
      const allow = document.createElement('button');
      allow.className = 'btn primary';
      allow.textContent = t('grantBtn');
      allow.addEventListener('click', async () => {
        if (await gwGrant(gwPattern(s.host)) && (await save(site(s.host, (r) => Object.assign(r, { enabled: true, auto: true }))))) flash(t('grantedOn'));
      });
      w.append(allow);
      host.append(w);
    }
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = t('delete');
    del.setAttribute('aria-label', `${s.host} ${t('delete')}`);
    del.addEventListener('click', async () => {
      // 지운 사이트의 접근 권한도 돌려준다 — 저장이 성공했고, 「모든 사이트」로 쓰는 중이 아니고,
      // 남은 규칙 중 이 권한에 기대는 사이트(예: *.example.com 을 지울 때 sub.example.com)가 없을 때만.
      const ok = await save((x) => { x.sites = x.sites.filter((y) => y.host !== s.host); });
      const leaning = state.sites.some((y) => gwHostMatches(s.host, y.host.replace(/^\*\./, '')));
      if (ok && !state.all.enabled && !leaning) chrome.permissions.remove({ origins: [gwPattern(s.host)] }).catch(() => {});
    });
    tr.append(
      td(gwCheck(s.enabled, async (v, box) => {
        if (v && !(await gwGrant(gwPattern(s.host)))) { box.checked = false; return; }
        save(site(s.host, (r) => { r.enabled = v; if (v) r.auto = true; }));
      }, `${s.host} ${t('colUse')}`), 'c'),
      td(host),
      td(gwLangSelect(s.source, { withAuto: true, label: `${s.host} ${t('source')}` }, (v) => save(site(s.host, (r) => { r.source = v; })))),
      td(arrow()),
      td(gwLangSelect(s.target, { withBrowser: true, label: `${s.host} ${t('target')}` }, (v) => save(site(s.host, (r) => { r.target = v; })))),
      td(gwCheck(s.auto, (v) => save(site(s.host, (r) => { r.auto = v; })), `${s.host} ${t('colAuto')}`), 'c'),
      td(del),
    );
    body.append(tr);
  }
}

gwOnModelDone = () => renderModels();
let modelSeq = 0;
async function renderModels() {
  const seq = ++modelSeq;
  const body = $('models');
  if (!('Translator' in self)) {
    body.innerHTML = '';
    body.append(warnRow(t('noTranslator')));
    return;
  }
  const rules = [state.all, ...state.sites].filter((r) => r.enabled);
  const needDetector = rules.some((r) => r.source === 'auto');
  const pairs = [...new Set(rules.filter((r) => r.source !== 'auto').map((r) => `${r.source}>${r.target || gwBrowserLang()}`))];
  const rows = await Promise.all(pairs.map(async (p) => {
    const [source, target] = p.split('>');
    let a = source === target ? 'same' : await Translator.availability({ sourceLanguage: source, targetLanguage: target }).catch(() => 'unavailable');
    if (a === 'unavailable' && await gwUnavailableReason(source, target) === 'service') a = 'service';
    return { source, target, a };
  }));
  const det = needDetector && 'LanguageDetector' in self ? await LanguageDetector.availability().catch(() => 'unavailable') : null;
  if (seq !== modelSeq) return;
  body.textContent = '';
  gwForgetViews();
  if (needDetector) {
    body.append(det ? modelRow(t('langDetect'), 'detector', det, createDetector()) : warnRow(t('noDetector')));
  }
  for (const r of rows) {
    if (r.a === 'same') continue;
    body.append(modelRow(`${gwLangName(r.source)} → ${gwLangName(r.target)}`, `${r.source}>${r.target}`, r.a, createTranslator(r.source, r.target)));
  }
  // 규칙에 없는 쌍을 「미리 받기」 중이거나 실패했으면 그 행도 남긴다(오류 문구가 보이게).
  for (const key of new Set([...downloads.keys(), ...gwLastFail.keys()])) {
    if (key === 'detector' || pairs.includes(key)) continue;
    const [s, t] = key.split('>');
    body.append(modelRow(`${gwLangName(s)} → ${gwLangName(t)}`, key, downloads.has(key) ? 'downloading' : 'downloadable', createTranslator(s, t)));
  }
}

// 「미리 받기」 — 자동 감지로 자주 만나는 언어를 골라 미리 받는다
let preSrc = 'ja';
let preTgt = '';
$('preSrc').append(gwLangSelect(preSrc, { label: t('source') }, (v) => { preSrc = v; }));
$('preTgt').append(gwLangSelect(preTgt, { withBrowser: true, label: t('target') }, (v) => { preTgt = v; }));
// 이 크롬에 내장 번역기가 없으면 미리 받기를 막는다.
if (!('Translator' in self)) $('preBtn').disabled = true;
$('preBtn').addEventListener('click', async () => {
  if (!('Translator' in self)) return flash(t('noTranslator'));
  const tgt = preTgt || gwBrowserLang();
  if (preSrc === tgt) return flash(t('sameLang'));
  const a = await Translator.availability({ sourceLanguage: preSrc, targetLanguage: tgt }).catch(() => 'unavailable');
  if (a === 'available') return flash(t('alreadyHave', gwLangName(preSrc), gwLangName(tgt)));
  if (a === 'unavailable') return flash(t(await gwUnavailableReason(preSrc, tgt) === 'service' ? 'serviceUnavailable' : 'unsupportedPair'));
  startDownload(`${preSrc}>${tgt}`, createTranslator(preSrc, tgt));
  renderModels();
});

let timer;
function flash(msg) {
  $('saved').textContent = msg;
  clearTimeout(timer);
  timer = setTimeout(() => ($('saved').textContent = ''), 2500);
}
// 저장 직전 최신 설정을 읽어 바꿀 것만 바꾼다(다른 화면·다른 기기 변경을 덮어쓰지 않게). 실패(용량 초과 등)는 알린다.
async function save(mutate) {
  let ok = true;
  try {
    state = await gwUpdate(mutate);
    flash(t('saved'));
  } catch {
    ok = false;
    flash(t('saveFailed'));
    state = await chrome.storage.sync.get(GW_DEFAULTS);
  }
  await render();
  return ok;
}
// 사이트 하나만 고치는 저장 함수를 만든다.
const site = (host, fn) => (x) => { const r = x.sites.find((y) => y.host === host); if (r) fn(r); };
const arrow = () => Object.assign(document.createElement('span'), { className: 'arrow', textContent: '→', ariaHidden: 'true' });

$('addBtn').addEventListener('click', async () => {
  let h = $('newHost').value.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname; } catch {}
  h = h.replace(/\/.*$/, '');
  if (!gwValidHost(h)) return flash(t('badHost'));
  if (state.sites.some((s) => s.host === h)) return flash(t('dupHost'));
  if (!(await gwGrant(gwPattern(h)))) return flash(t('needGrantToAdd'));
  $('newHost').value = '';
  save((x) => { if (!x.sites.some((y) => y.host === h)) x.sites.push({ host: h, ...GW_RULE, auto: true }); });
});
$('newHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });
$('hlOn').addEventListener('change', (e) => save((x) => { x.highlight = e.target.checked; }));
$('hlColor').addEventListener('change', (e) => save((x) => { x.hlColor = e.target.value; }));
$('hlColor').addEventListener('input', (e) => { $('hlPreview').style.cssText = gwHlCss(e.target.value); });
$('hlReset').addEventListener('click', () => save((x) => { x.hlColor = GW_HL_DEFAULT; }));
$('shortcut').addEventListener('change', (e) => save((x) => { x.shortcut = e.target.checked; }));
$('pill').addEventListener('change', (e) => save((x) => { x.pill = e.target.checked; }));
$('grid').addEventListener('click', (e) => { const p = e.target.dataset?.pos; if (p) save((x) => { x.position = p; }); });
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'sync') return;
  gwLoadDone().then(() => chrome.storage.sync.get(GW_DEFAULTS)).then((s) => { state = s; render(); });
});

gwLoadDone().then(() => chrome.storage.sync.get(GW_DEFAULTS)).then((s) => { state = s; render(); });
