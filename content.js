// 고른 사이트에서 정한 언어의 글자만 Chrome 내장 번역기(Translator API, 이 컴퓨터 안에서 처리)로 바꿔 보여 준다.
// 격리 world(확장 전용 실행 공간)에서 돈다 — 페이지 스크립트는 이 코드의 변수·설정에 손댈 수 없다.
// 원래 Text 노드는 떼어 내지 않고 글자(nodeValue)만 바꾼다. 노드를 갈아 끼우면 React 같은 프레임워크가
// 들고 있던 노드 참조가 끊겨 페이지가 깨진다. 표시는 CSS Custom Highlight API 로 칠한다(DOM 변경 없음).
(() => {
  if (globalThis.__gwTS) return;
  globalThis.__gwTS = true;

  const MSG = '__gwJa2Ko';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const HAN = '㐀-䶿一-鿿';
  // 원문 언어를 고정했을 때 그 언어의 글자가 있는 텍스트만 고른다(문자 체계 기준). 표에 없으면 라틴 문자.
  const SCRIPT = {
    ja: new RegExp(`[぀-ヿㇰ-ㇿｦ-ﾟ${HAN}]`),
    zh: new RegExp(`[${HAN}]`), 'zh-Hant': new RegExp(`[${HAN}]`),
    ko: /[가-힣ㄱ-ㆎ]/,
    ar: /[؀-ۿ]/, he: /[֐-׿]/,
    ru: /[Ѐ-ӿ]/, bg: /[Ѐ-ӿ]/, uk: /[Ѐ-ӿ]/,
    el: /[Ͱ-Ͽ]/, th: /[฀-๿]/,
    hi: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/,
    ta: /[஀-௿]/, te: /[ఀ-౿]/, kn: /[ಀ-೿]/,
  };
  const LATIN = /\p{Script=Latin}{2,}/u;
  // 글자 두 개 이상, 또는 한자·가나·한글 한 글자(「买」 같은 한 글자 단어)
  const ANY_LETTERS = new RegExp(`\\p{L}.*\\p{L}|[぀-ヿ${HAN}가-힣]`, 'su');
  const KANA = /[぀-ゟァ-ヺー-ヿㇰ-ㇿｦ-ﾟ]/; // ・(30FB)·゠(30A0) 제외
  const HANGUL = /[가-힣]/;
  const HAN_ANY = new RegExp(`[${HAN}]`);
  const SKIP_SEL = 'script,style,noscript,textarea,input,select,svg,math,[contenteditable],[data-gw-ja2ko-ui]';
  const scriptOf = (lang) => SCRIPT[lang] || LATIN;
  const isTop = window === window.top;
  const isMac = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  // HTML 문서에서만 동작한다(SVG·XML 문서는 body 가 없다).
  if (!(document instanceof HTMLDocument)) return;

  // 페이지가 선언한 언어(<html lang>) — 자동 감지의 기준점
  const pageLang = (() => {
    const l = (document.documentElement.lang || '').toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-Hant';
    const b = l.split('-')[0];
    return b === 'iw' ? 'he' : b;
  })();

  let settings = null;   // { shortcut, pill, position, highlight, hlColor, site }
  let ruleKey = '';      // 사이트 규칙이 바뀌었는지(자동 번역 재시작 판단)
  let langKey = '';      // '원문>번역' — 바뀌면 번역기·캐시를 새로
  let RE = ANY_LETTERS;
  let TGT_RE = null;
  let on = false;
  let gen = 0;
  let ready = false;
  let autoDone = false;
  let observer = null;
  const roots = new Set();             // 관찰 중인 shadow root
  const translators = new Map();       // 'ja>ko' -> Promise<Translator|null>
  const failedPairs = new Set();       // 만들지 못해 null 로 끝난 쌍 — 잠시 뒤·껐다 켜면 다시 시도
  let detectorP = null;
  const cache = new Map();             // 'ja>ko|줄' -> 번역(최근 3000개까지)
  const CACHE_MAX = 3000;
  const done = new Map();              // Text -> { orig, text, lines:[{s,e,orig,lang}] }
  const langSeen = new Map();          // 감지기 결과: 언어 -> 그 언어로 본 서로 다른 줄
  let held = [];                       // [언어, Text] — 감지기 결과가 아직 3줄이 안 돼 미룬 노드
  let waiting = [];                    // 클릭이 있어야 시작할 수 있어 기다리는 노드
  let needClick = false;
  let childNeedClick = false; // 같은 출처 하위 프레임이 클릭을 기다린다(최상위 자신의 번역은 막지 않는다)
  let btn = null;
  let failed = [];            // 번역 도중 오류가 난 노드(자동 재시도용)
  let lastErr = null;         // 마지막 오류 { name, message }
  let retries = 0;            // 전부 실패했을 때의 자동 재시도 횟수(켤 때마다 0)

  const t = (k, ...a) => (chrome.i18n.getMessage(k) || k).replace(/\{(\d)\}/g, (_, n) => String(a[n - 1] ?? ''));
  const langName = (code) => { try { return new Intl.DisplayNames([chrome.i18n.getUILanguage()], { type: 'language' }).of(code) || code; } catch { return code; } };
  const status = (text) => { if (btn) btn.textContent = text; };
  function pillLabel() {
    const r = settings?.site;
    if (!r) return t('pillTranslate');
    return `${r.source === 'auto' ? t('pillAuto') : r.source.toUpperCase()}→${r.target.toUpperCase()}`;
  }
  const restoreStatus = () => { if (needClick || (childNeedClick && idle())) status(t('clickToStart')); else if (!on) status(pillLabel()); else if (ready) status(t('pillOriginal')); };
  const idle = () => !queue.length && !workers;

  // ── 표시(하이라이트) ──
  const HL = 'gw-translate-switch';
  const highlight = 'Highlight' in self ? new Highlight() : null;
  if (highlight) CSS.highlights.set(HL, highlight);
  const ranges = new Map(); // Text -> Range[]
  const styles = new Set();  // 문서·shadow root 에 넣은 <style>
  function hlCss() {
    if (settings && settings.highlight === false) return '';
    const m = /^#?([0-9a-f]{6})$/i.exec(settings?.hlColor || '') || [, 'ED3424'];
    const n = parseInt(m[1], 16);
    const rgb = `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`;
    return `::highlight(${HL}){background-color:rgba(${rgb},.12);text-decoration:underline dotted rgba(${rgb},.8)}`;
  }
  function addStyle(root) {
    const s = document.createElement('style');
    s.dataset.gwJa2koUi = '1';
    s.textContent = hlCss();
    (root === document ? document.documentElement : root).append(s);
    styles.add(s);
  }
  const restyle = () => { const c = hlCss(); for (const s of styles) s.textContent = c; };
  function unmark(n) {
    for (const r of ranges.get(n) || []) highlight?.delete(r);
    ranges.delete(n);
  }
  function mark(n, rec) {
    unmark(n);
    if (!highlight) return;
    const list = rec.lines.map((l) => { const r = new Range(); r.setStart(n, l.s); r.setEnd(n, l.e); highlight.add(r); return r; });
    ranges.set(n, list);
  }

  // ── 대상 고르기 ──
  function eligible(n) {
    if (n.nodeType !== Node.TEXT_NODE || !n.isConnected || done.has(n)) return false;
    // shadow root 바로 아래 글자는 부모 요소가 없어 host 로 판단한다.
    const p = n.parentElement || n.parentNode?.host;
    if (!p || p.namespaceURI !== XHTML || p.closest(SKIP_SEL) || p.isContentEditable) return false;
    return RE.test(n.nodeValue);
  }
  function collect(root) {
    const out = [];
    const walk = (r) => {
      if (r.nodeType === Node.TEXT_NODE) { if (eligible(r)) out.push(r); return; }
      if (r.nodeType === Node.ELEMENT_NODE && (r.namespaceURI !== XHTML || r.closest(SKIP_SEL))) return;
      // 넣어질 때 이미 shadow root 를 가진 요소는 TreeWalker 가 자기 자신을 거르지 않으므로 여기서 본다.
      if (r.nodeType === Node.ELEMENT_NODE && r.shadowRoot) { watchRoot(r.shadowRoot); walk(r.shadowRoot); }
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) => {
          if (n.nodeType === Node.ELEMENT_NODE) {
            if (n.namespaceURI !== XHTML || n.matches(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
            if (n.shadowRoot) { watchRoot(n.shadowRoot); walk(n.shadowRoot); }
            return NodeFilter.FILTER_SKIP;
          }
          return eligible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      while (w.nextNode()) out.push(w.currentNode);
    };
    walk(root);
    return out;
  }
  // 이미 붙어 있는 요소에 나중에 붙인 shadow root 는 MutationObserver 에 잡히지 않는다(attachShadow 는 변경으로 안 친다).
  // 그래서 켜져 있는 동안 화면이 바뀐 뒤 쉬는 틈에 새 shadow root 를 훑어 찾는다(3초에 한 번까지).
  let scanTimer = 0;
  function scanShadows() {
    if (scanTimer || !on) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (!on) return;
      scanShadows(); // 켜져 있는 동안 계속 — 화면 변화가 없어도 나중에 붙은 shadow root 를 찾는다
      if (document.hidden) return;
      const found = [];
      const look = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && !roots.has(el.shadowRoot) && el.namespaceURI === XHTML && !el.closest(SKIP_SEL)) {
            found.push(...collect(el));
          }
          if (el.shadowRoot && roots.has(el.shadowRoot)) look(el.shadowRoot);
        }
      };
      look(document);
      if (found.length) enqueue(found);
    }, 5000);
  }
  // 열린 shadow root 도 번역하고 관찰한다(닫힌 shadow root 는 확장이 들어갈 수 없다).
  function watchRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    addStyle(root);
    observer?.observe(root, { childList: true, subtree: true, characterData: true });
  }

  // ── 번역기·감지기 ──
  // 크롬은 사이트마다 처음 번역기·감지기를 만들 때 그 페이지 안의 클릭(사용자 활성화)을 요구한다(모델을 받아 둬도).
  // 클릭이 없어서 거절되면 오류가 아니라 「눌러서 시작」으로 다룬다. 클릭이 있었는데도 거절되면(정책 차단 등) 진짜 오류다.
  function needsGesture(message, need) { const e = new Error(message); e.needsGesture = true; e.need = need; return e; }
  let pendingNeed = null;     // 클릭을 기다리게 만든 모델 { kind:'tr', src, tgt } 또는 { kind:'det' }
  let waitingDetect = [];     // 감지기가 아직 없어 미룬 노드(감지기 클릭은 맨 마지막에 한 번)
  // 모델 만들기는 한 번에 하나씩 — 클릭 하나로는 모델 하나만 만들 수 있어(크롬이 비동기로 활성화를 쓴다),
  // 동시에 여러 개를 시작하면 클릭이 엉뚱한 쪽에 쓰인다.
  let createChain = Promise.resolve();
  function create(api, opts, label, gestureMsg, feature, need) {
    const run = createChain.then(() => createNow(api, opts, label, gestureMsg, feature, need));
    createChain = run.catch(() => {});
    return run;
  }
  async function createNow(api, opts, label, gestureMsg, feature, need) {
    // 페이지의 권한 정책이 이 기능을 막으면 클릭으로도 풀리지 않는 진짜 오류다.
    const pp = document.permissionsPolicy || document.featurePolicy;
    if (pp?.allowsFeature && !pp.allowsFeature(feature)) throw new Error(t('noTranslatorApi'));
    let mon = true;
    try {
      let x;
      for (let attempt = 1; ; attempt++) {
        try {
          x = await api.create({
            ...opts,
            monitor(m) { m.addEventListener('downloadprogress', (e) => { if (mon && e.loaded < 1) status(e.loaded > 0 ? t(label, Math.min(99, Math.round(e.loaded * 100))) : t('slowDownload')); }); },
          });
          break;
        } catch (e) {
          // 번역 서비스가 막 뜰 때 생성이 간헐적으로 실패한다(「Unable to create translator…」 등) — 잠깐 쉬고 다시 시도한다.
          // 클릭이 필요하다는 거절(NotAllowedError)은 재시도로 풀리지 않는다.
          if (e?.name === 'NotAllowedError' || attempt >= 4) throw e;
          console.warn('[translate-switch] create retry', attempt, e.message);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      return x;
    } catch (e) {
      // 클릭이 없거나 이미 다른 모델에 쓰였으면 거절된다 — 몇 번이든 다시 누르면 된다(정책 차단은 위에서 따로 걸렀다).
      if (e?.name === 'NotAllowedError') throw needsGesture(gestureMsg, need);
      if (e?.name === 'NotSupportedError' && api === Translator) return null; // 이 언어 쌍은 번역하지 않는다
      throw e;
    } finally {
      mon = false; // 다 만들어진 뒤에 오는 진행률(0→100%)로 알약이 「받는 중」에 머물지 않게
      restoreStatus();
    }
  }
  function getTranslator(src, tgt) {
    const key = `${src}>${tgt}`;
    if (translators.has(key)) return translators.get(key);
    const p = (async () => {
      if (!self.isSecureContext) throw new Error(t('needHttps'));
      if (!('Translator' in self)) throw new Error(t('noTranslatorApi'));
      const opts = { sourceLanguage: src, targetLanguage: tgt };
      if ((await Translator.availability(opts).catch(() => 'unavailable')) === 'unavailable') return null;
      return create(Translator, opts, 'modelDownloading', t('needClickPair', langName(src), langName(tgt)), 'translator', { kind: 'tr', src, tgt });
    })();
    translators.set(key, p);
    p.catch(() => translators.delete(key));
    p.then((v) => {
      if (v !== null) return;
      failedPairs.add(key);
      setTimeout(() => { if (translators.get(key) === p) { translators.delete(key); failedPairs.delete(key); } }, 60000);
    }, () => {});
    return p;
  }
  function getDetector() {
    if (detectorP) return detectorP;
    detectorP = (async () => {
      if (!self.isSecureContext) throw new Error(t('needHttps'));
      if (!('LanguageDetector' in self)) throw new Error(t('noDetectorApi'));
      if ((await LanguageDetector.availability().catch(() => 'unavailable')) === 'unavailable') throw new Error(t('detectorUnavailable'));
      return create(LanguageDetector, {}, 'detectorDownloading', t('needClickDetect'), 'language-detector', { kind: 'det' });
    })();
    detectorP.catch(() => { detectorP = null; });
    return detectorP;
  }

  // 줄의 원문 언어. { lang, sure } — sure 는 글자만 보고 확실히 정한 경우(감지기 안 씀).
  const kanaSeen = new Set(); // 이 페이지에서 가나로 일본어라고 확정한 서로 다른 줄
  async function sourceOf(line) {
    const r = settings?.site;
    if (!r) return null;
    if (r.source !== 'auto') return { lang: r.source, sure: true };
    if (TGT_RE && !/\p{L}/u.test(line.replace(new RegExp(TGT_RE.source, 'gu'), ''))) return null;
    if (KANA.test(line)) {
      // 일본어가 3줄 확정되는 순간, 감지기를 기다리던 줄을 다시 본다(한자만 있는 줄은 이제 감지기 없이 일본어로 처리된다).
      const before = kanaSeen.size;
      if (kanaSeen.size < 50) kanaSeen.add(line);
      if (before < 3 && kanaSeen.size >= 3 && waitingDetect.length) for (const x of waitingDetect.splice(0)) retryOnce(x);
      return { lang: 'ja', sure: true };
    }
    if (HANGUL.test(line)) return { lang: 'ko', sure: true };
    // 한자가 있고 페이지가 일본어·중국어면 페이지 언어로 본다(「PayPay残高確認」처럼 영문이 섞인 짧은 문구 포함).
    if (HAN_ANY.test(line) && ['ja', 'zh', 'zh-Hant'].includes(pageLang)) return { lang: pageLang, sure: true };
    // 페이지 언어는 아니지만 이 페이지에서 일본어(가나)가 이미 여러 줄 보였으면, 한자만 있는 줄도 일본어로 본다
    // (예: 한국어 그룹웨어 안의 일본어 메일 — 「件名」「添付資料」 같은 줄). 감지기를 안 써서 클릭도 덜 필요하다.
    if (HAN_ANY.test(line) && kanaSeen.size >= 3) return { lang: 'ja', sure: true };
    // 감지기는 필요할 때만 만든다(만들 때도 클릭이 필요할 수 있어 아낀다).
    const d = await getDetector();
    const top = (await d.detect(line))[0];
    const letters = (line.match(/\p{L}/gu) || []).length;
    // 글자가 적을수록 감지가 불안정해 더 높은 확신을 요구한다.
    if (!top || top.detectedLanguage === 'und' || top.confidence < (letters < 15 ? 0.9 : 0.6)) return null;
    let lang = top.detectedLanguage;
    if (lang === 'iw') lang = 'he';
    if (lang.startsWith('zh')) lang = lang === 'zh-Hant' ? 'zh-Hant' : 'zh';
    return { lang, sure: false };
  }

  // ── 번역 작업 ──
  const queue = [];
  let workers = 0;
  let wGen = -1;
  function enqueue(nodes) {
    if (wGen !== gen) { wGen = gen; workers = 0; }
    queue.push(...nodes);
    while (on && !needClick && workers < 4 && queue.length) {
      workers++;
      const g = gen;
      work(g).finally(() => {
        if (wGen !== g) return;
        workers--;
        if (on && !needClick && queue.length) enqueue([]);
        else if (on && !needClick && !workers) onDrain();
      });
    }
    // 넣을 노드가 없어 작업자가 안 떴으면(재시도 목록이 전부 빠진 경우 등) 바로 마무리 판정을 한다.
    if (on && !needClick && !workers && !queue.length) onDrain();
  }
  // 큐가 비고 작업자도 없을 때: 실패 재시도 → 실패 알림 → 감지기 대기 처리 → 하위 프레임 요청 표시 순으로 «모두» 본다.
  let draining = false;
  function onDrain() {
    if (draining) return;
    draining = true;
    try {
      if (failed.length && retries < 2) {
        // 번역 실패가 남아 있다 — 모델을 막 받은 직후 번역기가 잠깐 불안정한 경우가 있어, 번역기를 새로 만들어 다시 시도한다.
        retries++;
        const again = failed.splice(0);
        translators.clear();
        failedPairs.clear();
        setTimeout(() => { if (on) enqueue(again.filter((x) => x.isConnected)); }, 1500);
        return;
      }
      if (failed.length && lastErr) {
        // 재시도해도 실패가 남음 — 대부분 실패면 조용히 넘기지 않고 실제 오류 문구를 보여 준다(원인 파악용).
        const n = failed.length;
        failed = [];
        if (isTop && n >= done.size) alertBox(`${lastErr.name || 'Error'}: ${lastErr.message}`);
      }
      if (waitingDetect.length || waiting.length) {
        const pend = waitingDetect.splice(0);
        let retried = false;
        for (const x of pend) {
          if (kanaSeen.size >= 3 && !kanaRetried.has(x)) retried = retryOnce(x) || retried;
          else if (x.isConnected) waiting.push(x);
        }
        if (retried) { draining = false; enqueue([]); return; }
        if (waiting.length) { askClick(t('needClickDetect'), { kind: 'det' }); return; }
      }
      if (childNeedClick) { applyPill(); restoreStatus(); }
    } finally { draining = false; }
  }
  function remember(k, v) {
    cache.set(k, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  async function work(myGen) {
    const rule = settings.site; // 이 실행이 시작될 때의 규칙
    while (on && gen === myGen && queue.length && !needClick) {
      const n = queue.shift();
      if (!eligible(n)) continue;
      const src = n.nodeValue;
      try {
        // 한 덩어리 텍스트(텍스트 메일 본문 등)는 줄 단위로 번역해 줄바꿈을 지킨다.
        const parts = src.split(/(\r?\n)/);
        const out = [];      // 문자열 또는 { pre, tr, post, orig, lang }
        let any = false;
        const heldLangs = new Set(); // 이 노드에서 미룬 언어(여럿일 수 있다)
        let detDeferred = false;     // 감지기를 기다려 미룬 줄이 있다
        for (const part of parts) {
          const line = part.trim();
          if (!line || !RE.test(line)) { out.push(part); continue; }
          let so;
          try { so = await sourceOf(line); } catch (e) {
            if (e?.needsGesture && e.need?.kind !== 'det') throw e; // 번역기 클릭 대기는 위에서 처리
            // 감지기 문제는 이 줄만의 문제다 — 클릭이 필요하면 미루고, 쓸 수 없으면(지원 안 함 등) 원문 그대로 둔다.
            // 같은 노드의 다른 줄(가나 줄 등)은 계속 번역한다.
            if (e?.needsGesture) detDeferred = true;
            else console.warn('[translate-switch] detector', e);
            out.push(part);
            continue;
          }
          if (!on || gen !== myGen) return;
          if (!so || so.lang === rule.target) { out.push(part); continue; }
          const pair = `${so.lang}>${rule.target}`;
          // 감지기로만 정한 언어는 서로 다른 3줄에서 나와야 번역기를 만든다(잘못 감지된 한두 줄로 엉뚱한 모델을 받지 않게).
          if (!so.sure && so.lang !== pageLang && !translators.has(pair)) {
            const seen = langSeen.get(so.lang) || new Set();
            seen.add(line);
            langSeen.set(so.lang, seen);
            if (seen.size < 3) { heldLangs.add(so.lang); out.push(part); continue; }
            releaseHeld(so.lang);
          }
          const ck = `${pair}|${line}`;
          let tr = cache.get(ck);
          if (tr === undefined) {
            const tl = await getTranslator(so.lang, rule.target);
            if (!on || gen !== myGen) return;
            if (!tl) { out.push(part); continue; }
            tr = await tl.translate(line);
            if (!on || gen !== myGen) return;
            remember(ck, tr);
          }
          any = true;
          out.push({ pre: part.match(/^\s*/)[0], tr, post: part.match(/\s*$/)[0], orig: line, lang: so.lang });
        }
        if (!on || gen !== myGen) return;
        if (!any || n.nodeValue !== src) {
          if (n.nodeValue !== src) queue.push(n);
          else { settleHeld(n, heldLangs, rule); if (detDeferred) deferDetect(n); }
          continue;
        }
        if (!eligible(n)) continue;
        let text = '';
        const lines = [];
        for (const o of out) {
          if (typeof o === 'string') { text += o; continue; }
          text += o.pre;
          lines.push({ s: text.length, e: text.length + o.tr.length, orig: o.orig, lang: o.lang });
          text += o.tr + o.post;
        }
        const rec = { orig: src, text, lines };
        done.set(n, rec);
        n.nodeValue = text; // 노드는 그대로, 글자만 바꾼다
        mark(n, rec);
        if (done.size === 1) maybeShowGrant(false);
        settleHeld(n, heldLangs, rule);
        if (detDeferred) deferDetect(n); // 감지기가 생기면(또는 가나가 3줄 모이면) 원문으로 되돌려 다시 번역
      } catch (e) {
        if (!on || gen !== myGen) return; // 이미 꺼졌거나 다시 시작된 실행의 늦은 오류는 무시
        if (e?.needsGesture && e.need?.kind === 'det') {
          // 감지기만 없는 노드는 따로 미룬다 — 확실한 언어(일본어 등) 번역은 계속하고, 남으면 마지막에 클릭을 한 번 더 받는다.
          waitingDetect.push(n);
          continue;
        }
        if (e?.needsGesture) {
          // 이 페이지에서 처음 만나는 언어라 클릭이 있어야 번역기를 만들 수 있다 — 켜 둔 채로 클릭을 기다린다.
          waiting.push(n);
          askClick(e.message, e.need);
          return;
        }
        // 크롬 번역기가 문장·언어 쌍을 처리하지 못한 경우(「Unable to translate…」 등) — 이 노드는 재시도 후보로 둔다.
        lastErr = { name: e?.name, message: e?.message || String(e) };
        failed.push(n);
        console.warn('[translate-switch] skipped', e);
      }
    }
  }
  // 이 노드에서 미룬 언어를 등록한다. 처리하는 사이 3줄이 찼거나 번역기가 생겼으면 바로 다시 번역한다.
  function settleHeld(n, langs, rule) {
    for (const l of langs) {
      held.push([l, n]);
      if ((langSeen.get(l)?.size || 0) >= 3 || translators.has(`${l}>${rule.target}`)) releaseHeld(l);
    }
  }
  // 번역 기록을 지우고 원문으로 되돌린 뒤 다시 처리 대상으로 돌린다(일부 줄만 번역된 노드 포함).
  function restore(x) {
    const rec = done.get(x);
    if (rec) { done.delete(x); unmark(x); if (x.nodeValue === rec.text) x.nodeValue = rec.orig; }
    return x.isConnected;
  }
  function requeue(x) { if (restore(x)) queue.push(x); }
  // 가나 근거가 생긴 뒤 한 번만 다시 처리한다(영어처럼 여전히 감지기가 필요한 줄 때문에 끝없이 돌지 않게).
  const kanaRetried = new WeakSet();
  function retryOnce(x) {
    if (kanaRetried.has(x)) { waitingDetect.push(x); return false; }
    kanaRetried.add(x);
    requeue(x);
    return true;
  }
  function deferDetect(n) {
    if (kanaSeen.size >= 3 && !kanaRetried.has(n)) retryOnce(n);
    else waitingDetect.push(n);
  }
  // 감지기로 본 언어가 3줄이 되면, 그 언어 때문에 미뤄 둔 노드를 원문으로 되돌려 다시 번역한다.
  function releaseHeld(lang) {
    const back = held.filter(([l]) => l === lang).map(([, x]) => x);
    held = held.filter(([l]) => l !== lang);
    for (const x of back) requeue(x);
  }
  function askClick(message, need) {
    if (need && !pendingNeed) pendingNeed = need;
    if (!isTop && sameOriginWin(window.top)) window.top.postMessage({ [MSG + 'NeedClick']: message }, self.origin);
    needClick = true;
    waiting.push(...queue.splice(0));
    status(t('clickToStart'));
    if (btn) { btn.title = message; btn.style.display = ''; }
  }
  // 「눌러서 시작」 상태에서 알약 클릭·단축키 → 그 클릭으로 번역기를 만들고 기다리던 노드를 이어서 번역한다.
  async function resume() {
    needClick = false;
    applyPill();
    const back = waiting.splice(0);
    const need = pendingNeed;
    pendingNeed = null;
    restoreStatus();
    // 클릭 하나로는 모델 하나만 만들 수 있다 — 멈추게 한 그 모델을 지금(클릭이 살아 있을 때) 먼저 만든다.
    const myGen = gen;
    if (need) {
      try {
        if (need.kind === 'det') await getDetector();
        else await getTranslator(need.src, need.tgt);
        if (!on || gen !== myGen) return; // 그사이 꺼졌으면 아무것도 하지 않는다
      } catch (e) {
        if (!on || gen !== myGen) return;
        if (e?.needsGesture) { waiting.push(...back); askClick(e.message, e.need); return; }
        console.warn('[translate-switch] resume', e);
      }
    }
    const again = back.filter((x) => restore(x));
    enqueue(again.length ? again : collect(document.body || document.documentElement));
  }

  // 페이지가 우리가 바꾼 글자를 다시 쓰면 그 노드는 새 원문으로 보고 다시 번역한다.
  function onMutations(muts) {
    const nodes = [];
    for (const m of muts) {
      if (m.type === 'characterData') {
        const rec = done.get(m.target);
        if (rec && m.target.nodeValue === rec.text) continue; // 우리가 쓴 것
        if (rec) { done.delete(m.target); unmark(m.target); }
        if (on) nodes.push(...collect(m.target));
      } else {
        if (m.removedNodes.length) prune();
        if (on) for (const a of m.addedNodes) nodes.push(...collect(a));
      }
    }
    if (nodes.length) enqueue(nodes);
    scanShadows();
  }
  // 페이지에서 빠진 노드의 기록·표시를 지운다(무한 스크롤에서 메모리가 쌓이지 않게).
  let pruneTimer = 0;
  function prune() {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = 0;
      for (const [n, rec] of [...done]) if (!n.isConnected) { if (n.nodeValue === rec.text) n.nodeValue = rec.orig; done.delete(n); unmark(n); }
      held = held.filter(([, x]) => x.isConnected);
      waiting = waiting.filter((x) => x.isConnected);
      waitingDetect = waitingDetect.filter((x) => x.isConnected);
      for (const r of [...roots]) if (!r.host.isConnected) roots.delete(r);
      for (const st of [...styles]) if (!st.isConnected) styles.delete(st);
    }, 1000);
  }

  async function enable() {
    if (!settings) { wantOn = true; return; }
    if (on || !settings.site) return;
    on = true;
    const myGen = ++gen;
    status(t('preparing'));
    if (!observer) {
      observer = new MutationObserver(onMutations);
      // <body> 를 통째로 바꾸는 화면 전환(Turbo 등)도 잡게 <html> 을 본다 — 새 body 가 「추가됨」으로 들어온다.
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      for (const r of roots) observer.observe(r, { childList: true, subtree: true, characterData: true });
    }
    try {
      const slow = setTimeout(() => { if (gen === myGen) status(t('slowDownload')); }, 4000);
      try {
        const r = settings.site;
        // 한 번의 클릭으로는 모델 하나만 만들 수 있다 — 페이지 언어 번역기를 먼저(가장 많이 쓰인다), 감지기는 필요할 때.
        const first = r.source === 'auto' ? pageLang : r.source;
        if (first && first !== r.target) {
          let tl = null;
          try { tl = await getTranslator(first, r.target); } catch (e) {
            // 자동 감지면 페이지 언어 모델을 미리 못 만들어도 줄마다 번역을 이어 간다(크롬 원문 오류는 띄우지 않는다).
            if (e.needsGesture || r.source !== 'auto') throw e.needsGesture ? e : new Error(t('pairUnsupported', langName(r.source), langName(r.target)));
            console.warn('[translate-switch] page pair', e);
          }
          if (tl === null && r.source !== 'auto') throw new Error(t('pairUnsupported', langName(r.source), langName(r.target)));
        }
      } finally { clearTimeout(slow); }
      if (gen !== myGen) return;
      ready = true;
      applyPill();
      status(t('pillOriginal'));
      broadcast();
      enqueue(collect(document.body || document.documentElement));
      scanShadows();
    } catch (e) {
      if (gen !== myGen) return;
      if (e.needsGesture) {
        // 빨간 경고 대신 스위치 글자로 다음 할 일을 알린다. 알약을 누르면 그 클릭으로 바로 시작된다.
        // 하위 프레임은 알약이 없으니 최상위에 알린다(최상위에서 누르면 다시 켜라는 신호가 온다).
        if (!isTop && sameOriginWin(window.top)) window.top.postMessage({ [MSG + 'NeedClick']: e.message }, self.origin);
        disable();
        needClick = true; // 꺼진 상태지만 클릭을 기다린다 — setState(true) 가 resume 대신 enable 로 간다
        pendingNeed = e.need || null;
        status(t('clickToStart'));
        if (btn) { btn.title = e.message; btn.style.display = ''; }
        return;
      }
      disable();
      if (isTop) alertBox(e.message);
      console.warn('[translate-switch]', e);
    }
  }

  function disable() {
    childNeedClick = false;
    clearTimeout(scanTimer);
    scanTimer = 0;
    ready = false;
    wantOn = false;
    needClick = false;
    on = false;
    gen++;
    queue.length = 0;
    waiting = [];
    waitingDetect = [];
    failed = [];
    retries = 0;
    for (const k of failedPairs) translators.delete(k);
    failedPairs.clear();
    pendingNeed = null;
    held = [];
    langSeen.clear();
    hideTip();
    for (const [n, rec] of done) { if (n.nodeValue === rec.text) n.nodeValue = rec.orig; unmark(n); }
    done.clear();
    highlight?.clear();
    ranges.clear();
    applyPill();
    status(pillLabel());
    broadcast();
  }

  // ── 같은 출처 하위 프레임과 켜기/끄기 맞추기 ──
  // 다른 출처 프레임은 번역 API 자체가 막혀 있어(권한 정책 기본값 self) 같은 출처끼리만 주고받는다.
  const sameOriginWin = (w) => { try { return w.location.origin === location.origin || w.origin === self.origin; } catch { return false; } };
  const childFrames = () => { const out = []; for (let i = 0; i < window.frames.length; i++) if (sameOriginWin(window.frames[i])) out.push(window.frames[i]); return out; };
  function broadcast() { for (const f of childFrames()) f.postMessage({ [MSG]: on }, self.origin); }
  function setState(next) {
    if (next && needClick && !on) { needClick = false; pendingNeed = null; enable(); broadcast(); return; }
    if (next && (needClick || childNeedClick)) {
      if (needClick) resume();
      childNeedClick = false;
      broadcast(); // 하위 프레임에 켜라고 보낸다 — 클릭의 활성화는 같은 출처 하위 프레임에도 전해진다
      applyPill(); // 숨겨 둔 알약이었으면 다시 숨긴다
      if (!needClick) restoreStatus();
      return;
    }
    next ? enable() : disable();
    broadcast();
  }
  let wantOn = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || e.origin !== self.origin) return;
    if (typeof d[MSG] === 'boolean' && e.source === window.parent && !isTop) {
      parentWants = d[MSG]; // 내 설정이 아직 옛것이어도 부모의 뜻은 따로 기억했다가 설정 반영 뒤 맞춘다
      setState(d[MSG]); // true 이고 클릭 대기 중이면 setState 가 이어서 시작한다
    }
    // 자식 → 부모: 새로 뜬 같은 출처 iframe 이 현재 상태를 묻는다 / 하위 프레임에서 단축키
    const fromChild = childFrames().includes(e.source);
    // 새로 뜬(또는 설정이 바뀐) 하위 프레임이 상태를 물으면 켜짐·꺼짐을 그대로 알려 준다.
    if (d[MSG + 'Ready'] === true && fromChild) e.source.postMessage({ [MSG]: on }, self.origin);
    // 단축키는 몇 단계 아래 프레임에서든 최상위로 바로 온다 — 같은 출처이고 이 창이 그 프레임의 top 인지 본다.
    let fromDesc = false;
    try { fromDesc = !!e.source && e.source !== window && e.source.top === window && sameOriginWin(e.source); } catch {}
    if (d[MSG + 'Toggle'] === true && isTop && fromDesc) toggle();
    // 하위 프레임이 클릭을 기다린다 — 최상위 자신의 번역은 그대로 두고, 놀고 있을 때 알약만 「눌러서 시작」으로 바꾼다.
    // 누르면 하위 프레임에 켜라는 신호를 보내고, 그 클릭의 활성화가 같은 출처 하위 프레임에도 전해진다.
    if (typeof d[MSG + 'NeedClick'] === 'string' && isTop && fromDesc && on) {
      childNeedClick = true;
      if (btn && !needClick) btn.title = d[MSG + 'NeedClick'];
      applyPill();
      restoreStatus();
    }
  });
  let readySent = false;
  let parentWants = false; // 하위 프레임: 부모가 마지막으로 보낸 켜기/끄기
  function announceReady() {
    if (isTop || readySent || !sameOriginWin(window.parent)) return;
    readySent = true;
    window.parent.postMessage({ [MSG + 'Ready']: true }, self.origin);
  }
  // 「모델 준비 중…」(켜는 중)에 누른 클릭은 무시한다 — 이미 시작하고 있는데 꺼져 버리면 헷갈린다.
  const toggle = () => { if (on && !ready && !needClick && !childNeedClick) return; setState(needClick || childNeedClick ? true : !on); };

  // ── 설정 ──
  async function loadSettings() {
    let host = '';
    try { host = new URL(self.origin).hostname; } catch {}
    const s = await chrome.storage.sync.get(GW_DEFAULTS).catch(() => GW_DEFAULTS);
    applySettings({ shortcut: s.shortcut, pill: s.pill, position: s.position, highlight: s.highlight, hlColor: s.hlColor, site: gwResolve(s, host) });
  }
  function applySettings(next) {
    const key = next.site ? `${next.site.source}>${next.site.target}` : '';
    const rk = JSON.stringify(next.site);
    if (key !== langKey) {
      // 사이트 언어가 바뀌면 지금 번역은 되돌리고 번역기를 새로 만든다.
      const want = wantOn;
      if (on) disable();
      wantOn = want;
      translators.clear();
      cache.clear();
      langKey = key;
      const src = next.site?.source;
      RE = !src || src === 'auto' ? ANY_LETTERS : scriptOf(src);
      // 그 문자를 쓰는 언어가 목록에 하나뿐일 때만(한글·태국 문자 등) 감지 없이 건너뛴다 — 한자·키릴 문자는 감지에 맡긴다.
      const UNIQUE = ['ko', 'th', 'he', 'el', 'bn', 'ta', 'te', 'kn', 'ar'];
      TGT_RE = next.site && UNIQUE.includes(next.site.target) ? SCRIPT[next.site.target] : null;
    }
    // 규칙이 바뀌면(사이트를 다시 켜거나 언어를 바꾸면) 자동 번역을 다시 시작할 수 있게 한다.
    // 하위 프레임은 부모에게 현재 상태를 다시 묻는다(부모가 먼저 재시작해 보낸 신호를 놓쳤을 수 있다).
    if (rk !== ruleKey) { ruleKey = rk; if (!on) autoDone = false; readySent = false; }
    settings = next;
    restyle();
    if (!settings.site && on) disable();
    if (!on) restoreStatus();
    applyPill();
    if (wantOn && !on && settings.site) { wantOn = false; setState(true); }
    if (isTop && settings.site?.auto && !autoDone && !on) { autoDone = true; setState(true); }
    if (!isTop && parentWants && settings.site && !on) enable(); // 부모는 켜져 있는데 내 쪽만 꺼진 경우를 맞춘다
    announceReady();
  }
  chrome.storage.onChanged.addListener((_, area) => { if (area === 'sync') loadSettings(); });

  // ── 단축키: 맥 ⌘K, 윈도우 Ctrl+K ──
  // 물리 키(code)로 본다 — 한글(ㅏ)·일본어(の) 자판, Caps Lock·Shift 에서도 같은 K 자리면 동작.
  window.addEventListener('keydown', (e) => {
    const isK = e.code === 'KeyK' || e.keyCode === 75 || ['k', 'K', 'ㅏ', 'の'].includes(e.key);
    if (!settings?.site || !settings.shortcut || e.repeat || !isK || e.altKey) return;
    if (isMac ? !(e.metaKey && !e.ctrlKey) : !(e.ctrlKey && !e.metaKey)) return;
    if (!isTop && !sameOriginWin(window.top)) return; // 처리할 수 없는 프레임은 페이지 단축키를 빼앗지 않는다
    e.preventDefault();
    e.stopImmediatePropagation();
    if (isTop) toggle();
    else if (sameOriginWin(window.top)) window.top.postMessage({ [MSG + 'Toggle']: true }, self.origin);
  }, true);

  // ── 원문 툴팁: 마우스 아래 글자를 찾아 그 줄의 원문을 보여 준다 ──
  let tip = null;
  let tipLine = null;
  function hideTip() { if (tip) tip.style.display = 'none'; tipLine = null; }
  function lineAt(x, y) {
    const pos = document.caretPositionFromPoint?.(x, y, { shadowRoots: [...roots] });
    const n = pos?.offsetNode;
    const rec = n && done.get(n);
    if (!rec) return null;
    const l = rec.lines.find((v) => pos.offset >= v.s && pos.offset <= v.e);
    if (!l) return null;
    // 글자 옆 빈 곳이 아니라 실제 글자 위에 있을 때만
    const r = new Range();
    r.setStart(n, l.s);
    r.setEnd(n, l.e);
    for (const b of r.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return l;
    return null;
  }
  let raf = 0;
  document.addEventListener('mousemove', (e) => {
    if (!done.size || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const l = lineAt(e.clientX, e.clientY);
      if (!l) return hideTip();
      if (!tip) {
        tip = document.createElement('div');
        tip.dataset.gwJa2koUi = '1';
        tip.setAttribute('role', 'tooltip');
        Object.assign(tip.style, { all: 'initial', position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
          maxWidth: '480px', maxHeight: '50vh', overflow: 'hidden', whiteSpace: 'pre-wrap',
          background: 'rgba(30,30,30,.95)', color: '#fff', padding: '8px 10px', borderRadius: '6px',
          font: '13px/1.5 sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.3)' });
        document.documentElement.appendChild(tip);
      }
      if (tipLine !== l) {
        tipLine = l;
        tip.textContent = `${t('tipOriginal', langName(l.lang))} · ${l.orig}`;
        tip.lang = l.lang;
      }
      tip.style.display = 'block';
      const pad = 14, r = tip.getBoundingClientRect();
      let left = e.clientX + pad, top = e.clientY + pad;
      if (left + r.width > innerWidth - 8) left = Math.max(8, e.clientX - r.width - pad);
      if (top + r.height > innerHeight - 8) top = Math.max(8, e.clientY - r.height - pad);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    });
  }, true);
  document.addEventListener('mouseleave', hideTip);

  // ── 스위치(알약) ──
  const POS = {
    'top-left': { top: '16px', left: '16px' },
    'top-center': { top: '16px', left: '50%', transform: 'translateX(-50%)' },
    'top-right': { top: '16px', right: '16px' },
    'middle-left': { top: '50%', left: '16px', transform: 'translateY(-50%)' },
    'middle-right': { top: '50%', right: '16px', transform: 'translateY(-50%)' },
    'bottom-left': { bottom: '16px', left: '16px' },
    'bottom-center': { bottom: '16px', left: '50%', transform: 'translateX(-50%)' },
    'bottom-right': { bottom: '16px', right: '16px' },
  };
  function applyPill() {
    if (!isTop || !settings) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.dataset.gwJa2koUi = '1';
      btn.type = 'button';
      btn.setAttribute('aria-live', 'polite');
      btn.textContent = pillLabel();
      btn.addEventListener('click', (e) => {
        if (e.shiftKey) { copyDiag(); return; } // Shift+클릭: 진단 정보 복사(문제 신고용)
        toggle();
      });
      // body 에 transform 이 걸린 사이트에서도 화면 기준으로 뜨게 <html> 바로 아래에 둔다.
      document.documentElement.appendChild(btn);
    }
    const base = { all: 'initial', position: 'fixed', zIndex: 2147483647, padding: '8px 12px', border: '0', borderRadius: '20px',
      background: '#ED3424', color: '#fff', font: 'bold 13px sans-serif', cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)', opacity: '.9' };
    btn.removeAttribute('style');
    Object.assign(btn.style, base, POS[settings.position] || POS['bottom-right']);
    // 알약을 숨겨 둬도 클릭이 필요해지면(자기 것이든 하위 프레임 것이든) 보여 준다.
    btn.style.display = (settings.pill || needClick || (childNeedClick && idle())) && settings.site ? '' : 'none';
    if (!needClick) btn.title = t('pillTitle', settings.shortcut ? ` (${isMac ? '⌘K' : 'Ctrl+K'})` : '');
  }

  // 진단 정보(문제 신고용) — 개인 정보 없이 상태 수치와 마지막 오류만.
  function diag() {
    return { v: chrome.runtime.getManifest().version, url: location.origin, lang: document.documentElement.lang, pageLang, on, ready, needClick,
      pendingNeed, waiting: waiting.length, waitingDetect: waitingDetect.length, held: held.length, queue: queue.length, workers,
      translators: [...translators.keys()], failedPairs: [...failedPairs], done: done.size, failed: failed.length, retries, lastErr,
      kana: kanaSeen.size, site: settings?.site, api: { tr: 'Translator' in self, det: 'LanguageDetector' in self, hl: !!highlight, secure: self.isSecureContext } };
  }
  async function copyDiag() {
    const text = JSON.stringify(diag(), null, 1);
    try { await navigator.clipboard.writeText(text); toast(t('diagCopied')); } catch { console.log('[translate-switch] diag', text); toast(t('diagConsole')); }
  }
  function toast(text) {
    const d = document.createElement('div');
    d.dataset.gwJa2koUi = '1';
    d.setAttribute('role', 'status');
    d.textContent = text;
    Object.assign(d.style, { all: 'initial', position: 'fixed', right: '16px', bottom: '64px', zIndex: 2147483647,
      background: 'rgba(30,30,30,.9)', color: '#fff', padding: '6px 10px', borderRadius: '6px', font: '12px sans-serif' });
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 3000);
  }
  function alertBox(text) {
    const d = document.createElement('div');
    d.dataset.gwJa2koUi = '1';
    d.setAttribute('role', 'alert');
    d.textContent = `${t('alertPrefix')} ${text}`;
    Object.assign(d.style, { all: 'initial', position: 'fixed', right: '16px', bottom: '64px', zIndex: 2147483647,
      background: '#c62828', color: '#fff', padding: '8px 12px', borderRadius: '8px', font: '13px sans-serif' });
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }

  // ── 접근 허용 레이어(페이지 위 iframe) ──
  // 팝업에서 「이 사이트에서 사용」을 켜면 이 함수에 허용 화면 주소를 맡긴다. 크롬은 사이트에서 처음 번역기를 만들 때
  // 페이지 안의 클릭을 요구하므로, 먼저 알약 클릭으로 번역을 시작하게 두고 번역이 뜬 뒤에 레이어를 띄운다
  // (그래야 「허용」을 누른 시점에 이미 번역된 화면이 보인다). 20초가 지나도록 시작하지 않으면 그냥 띄운다.
  let grantUrl = null;
  let grantTimer = 0;
  globalThis.__gwTSGrant = (url, immediate) => {
    grantUrl = url;
    clearTimeout(grantTimer);
    if (immediate) { maybeShowGrant(true); return; }
    grantTimer = setTimeout(() => maybeShowGrant(true), 20000);
    maybeShowGrant(false);
  };
  function maybeShowGrant(force) {
    if (!grantUrl) return;
    if (!force && !(on && ready && done.size > 0)) return;
    const u = grantUrl;
    grantUrl = null;
    clearTimeout(grantTimer);
    showGrantLayer(u);
  }
  function showGrantLayer(src) {
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
  }

  // 확장 팝업의 「지금 번역 켜기/끄기」가 부른다(격리 world 안이라 페이지는 이 함수를 볼 수 없다).
  globalThis.__gwTSToggle = () => { if (isTop) toggle(); };
  // 팝업의 「켜기」가 부른다 — 꺼져 있으면 켠다(이미 켜져 있으면 아무것도 안 한다). 설정이 아직 안 왔으면 오는 대로 켠다.
  globalThis.__gwTSStart = () => {
    if (!isTop || on) return;
    wantOn = true;          // 켜진 규칙이 적용될 때까지 의도를 들고 있는다(applySettings 가 소비한다)
    loadSettings();         // 팝업이 방금 저장한 규칙을 다시 읽는다
  };
  // 진단용(격리 world 안에서만 보인다): 지금 상태 요약
  globalThis.__gwTSState = diag;

  addStyle(document);
  loadSettings();
})();
