// 팝업은 권한 창이 뜨면 닫히고, 요청한 화면이 닫히면 「허용」을 눌러도 권한이 들어오지 않는다.
// 그래서 영구 권한 요청은 닫히지 않는 이 화면(페이지 위 레이어 또는 작은 창)에서 한다.
// 이 화면은 웹 페이지가 열 수 있는 주소라, 무엇을 허용할지는 주소가 아니라 팝업이 세션 저장소에 남긴 요청(req)으로만 정한다.
gwLocalize();
const params = new URLSearchParams(location.search);
const inLayer = params.has('layer');
const reqKey = `grant:${params.get('req') || ''}`;
// 레이어(페이지 위 iframe)면 부모 페이지에 닫으라고 알리고, 작은 창이면 창을 닫는다.
const closeMe = () => (inLayer ? parent.postMessage({ gwGrant: 'close' }, '*') : window.close());
document.getElementById('later').addEventListener('click', () => { chrome.storage.session.remove(reqKey); closeMe(); });
document.title = t('grantTitle');
// 레이어 안으로 포커스가 들어오므로 Esc 는 여기서 받아 닫는다.
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMe(); });

(async () => {
  const req = (await chrome.storage.session.get(reqKey))[reqKey];
  const go = document.getElementById('go');
  const goAll = document.getElementById('goAll');
  // 팝업의 「모든 사이트에서 사용」으로 열렸으면 「모든 사이트 허용」을 주 버튼으로 보여 준다(표시만 바뀐다).
  if (params.has('all')) { goAll.classList.add('primary'); go.classList.remove('primary'); goAll.parentNode.insertBefore(goAll, go); }
  // 같은 번호로 열린 창이 여럿이어도 한 번에 하나만 요청을 쓰게 잠근다.
  const withLock = (fn) => (navigator.locks ? navigator.locks.request(reqKey, fn) : fn());
  // 누르는 순간 요청을 다시 확인하고 선점한다 — 오래 열어 둔 창, 이미 쓰인 번호(같은 번호로 미리 띄운 다른 창 포함)는 쓸 수 없다.
  // 권한 요청은 사용자 동작이 살아 있는 지금 바로 해야 해서, 잠금 안에서는 선점만 하고 바로 나온다.
  const claim = () => withLock(async () => {
    const v = (await chrome.storage.session.get(reqKey))[reqKey];
    if (!v || Date.now() - v.at > 10 * 60 * 1000) return null;
    await chrome.storage.session.remove(reqKey);
    return v;
  });
  // 거절하면 다시 누를 수 있게 요청을 돌려놓는다(그사이 다른 창이 새로 쓴 값이 있으면 건드리지 않는다).
  const restore = (now) => withLock(async () => { if (!(await chrome.storage.session.get(reqKey))[reqKey]) await chrome.storage.session.set({ [reqKey]: now }); });
  const expired = () => { document.getElementById('body').textContent = t('grantExpired'); go.disabled = goAll.disabled = true; };
  if (!req || Date.now() - req.at > 10 * 60 * 1000 || !gwValidHost(req.host)) return expired(); // 처음부터 못 쓰는 요청이면 두 버튼 다 끈다
  document.getElementById('body').textContent = t('grantBody', req.host);
  // origins: 이 사이트만, 또는 모든 사이트(한 번 허용하면 그 뒤로는 어떤 사이트든 묻지 않는다 — 규칙은 여전히 사이트별로 켠다)
  async function ask(origins) {
    go.disabled = goAll.disabled = true;
    if (granted) return saveRule(); // 권한은 이미 받았고 저장만 다시 하는 경우
    const now = await claim();
    if (!now) return expired();
    // 권한 창이 떠 있는 동안 이 화면이 사라져도(페이지 이동 등) background 가 허용 결과를 보고 규칙을 켜도록 남겨 둔다.
    const all = origins[0] === GW_ALL_PATTERN;
    const pendKey = `gwGrantPending:${params.get('req')}`;
    await chrome.storage.session.set({ [pendKey]: { host: now.host, all, at: Date.now() } });
    const ok = await chrome.permissions.request({ origins }).catch(() => false);
    if (!ok) chrome.storage.session.remove(pendKey);
    if (!ok) {
      await restore(now);
      go.disabled = goAll.disabled = false;
      document.getElementById('msg').textContent = t('grantNo');
      return;
    }
    granted = now.host;
    grantedAll = origins[0] === GW_ALL_PATTERN;
    await saveRule();
  }
  go.addEventListener('click', () => ask([gwPattern(req.host)]));
  goAll.addEventListener('click', () => ask([GW_ALL_PATTERN]));

// 허용하면 그 사이트 사용·자동 번역을 켠다(규칙이 없으면 만든다). 저장에 실패하면 버튼으로 저장만 다시 할 수 있다.
let granted = '';
let grantedAll = false;
async function saveRule() {
  const go = document.getElementById('go');
  try {
    await gwUpdate((s) => {
      if (grantedAll) {
        // 모든 사이트 허용 = 어디서든 스위치가 붙는다. 처음 들어가는 사이트는 자동 번역하지 않는다(사이트별 규칙에서만 자동).
        Object.assign(s.all, { enabled: true, auto: false });
        return;
      }
      let rule = s.sites.find((x) => x.host === granted);
      if (!rule) { rule = { ...GW_RULE, host: granted }; s.sites.unshift(rule); }
      Object.assign(rule, { enabled: true, auto: true });
    });
  } catch {
    document.getElementById('msg').textContent = t('saveFailed');
    go.disabled = false; // 다시 누르면 저장만 다시 한다
    return;
  }
  document.getElementById('msg').textContent = t('grantOk');
  setTimeout(closeMe, 1200);
}
})();
