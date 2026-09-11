/* Odyssey — app logic.
   Screens: email gate → map → region → chapter (study/recap/trial/victory), flashcards,
   ship's log. Chapter content is fetched from content/<subjectId>/ch<N>.json at runtime.
   Progress persists to localStorage and, once an email is set, syncs to a Cloudflare
   Worker + KV backend (no auth — see README). */

(function () {
  'use strict';

  /* ---------------- helpers ---------------- */

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const iso = d => {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const today = () => iso(new Date());
  const addDays = (isoStr, n) => {
    const [y, m, d] = isoStr.split('-').map(Number);
    return iso(new Date(y, m - 1, d + n));
  };
  const daysBetween = (a, b) => {
    const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((p(b) - p(a)) / 86400000);
  };
  const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

  const bars = (on, total, onCls, offCls) => {
    let h = '';
    for (let i = 0; i < total; i++) h += '<i class="' + (i < on ? onCls : offCls) + '"></i>';
    return h;
  };

  const key = (subjectId, n) => subjectId + '-' + n;
  const subjectOf = id => SUBJECTS.find(s => s.id === id);

  /* ---------------- persistence ---------------- */

  const STORE = 'odyssey.v2';
  const EMAIL_STORE = 'odyssey.email';

  /* A brand new navigator starts at the very beginning: no XP, nothing cleared,
     only the first chapter of the first sea open. */
  function freshState() {
    return {
      v: 2,
      xp: 0,
      startedOn: today(),   // days before this are "not yet sailing", not "missed"
      cleared: {},        // 'ba-1' -> {score, on}
      pos: {},            // 'ba-1' -> {stage, qi, answers:[]}
      titles: {},         // 'ba-1' -> 'Nature of Business'  (so regions render without refetching)
      studied: [],        // ISO dates on which something was completed
      sched: {},          // cardId -> {due, ivl, last}
      cardsReviewed: 0,
      perfectTrial: false
    };
  }

  let S = freshState();
  let EMAIL = null;

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.v === 2) {
          S = parsed;
          if (!S.startedOn) S.startedOn = S.studied && S.studied.length ? S.studied.slice().sort()[0] : today();
        }
      }
      EMAIL = localStorage.getItem(EMAIL_STORE) || null;
    } catch (e) { /* private mode — run in memory */ }
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORE, JSON.stringify(S));
      if (EMAIL) localStorage.setItem(EMAIL_STORE, EMAIL);
    } catch (e) { /* private mode */ }
  }

  /* ---------------- cloud sync (no auth, keyed by email) ---------------- */

  let pushTimer = null;
  let syncState = 'off';   // off | ok | error

  function progressUrl(email) {
    return WORKER_URL + '/progress?email=' + encodeURIComponent(email);
  }

  async function pullRemote(email) {
    const res = await fetch(progressUrl(email), { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data;   // null when this email has never synced
  }

  function pushRemote() {
    if (!EMAIL) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        const res = await fetch(progressUrl(EMAIL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(S)
        });
        syncState = res.ok ? 'ok' : 'error';
      } catch (e) {
        syncState = 'error';   // stay local-only, never block the user
      }
    }, 1200);
  }

  /* Every mutation goes through save(): local first, cloud on a debounce. */
  function save() {
    saveLocal();
    pushRemote();
  }

  function markStudiedToday() {
    const t = today();
    if (S.studied.indexOf(t) === -1) S.studied.push(t);
  }

  /* ---------------- content loading ---------------- */

  const chapterCache = new Map();   // 'ba-1' -> chapter object, or null when uncharted

  async function loadChapter(subjectId, n) {
    const k = key(subjectId, n);
    if (chapterCache.has(k)) return chapterCache.get(k);

    let data = null;
    try {
      const res = await fetch('content/' + subjectId + '/ch' + n + '.json');
      if (res.ok) {
        const parsed = await res.json();
        if (parsed && Array.isArray(parsed.quiz) && parsed.quiz.length) data = parsed;
      }
      /* a 404 (or a malformed file) leaves data null — the island is uncharted */
    } catch (e) {
      data = null;   // offline or blocked; fall back to the placeholder
    }

    chapterCache.set(k, data);
    if (data && data.title && S.titles[k] !== data.title) {
      S.titles[k] = data.title;
      saveLocal();
    }
    return data;
  }

  /* Run an async job over a list a few at a time, so warming a 19-chapter sea doesn't
     open nineteen sockets at once. */
  async function mapLimit(items, limit, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  /* Region grids show every chapter's real title, locked ones included — a sealed island
     you can name is a better invitation than a row of "Uncharted". Titles are cached into
     saved state, so this full sweep costs one pass per sea and nothing after that. */
  async function warmSubject(subjectId) {
    const sub = subjectOf(subjectId);
    if (!sub) return false;
    const wanted = [];
    for (let n = 1; n <= sub.chapters; n++) {
      const k = key(subjectId, n);
      if (!S.titles[k] && !chapterCache.has(k)) wanted.push(n);
    }
    if (!wanted.length) return false;
    await mapLimit(wanted, 4, n => loadChapter(subjectId, n));
    saveLocal();
    return true;
  }

  /* ---------------- derived state ---------------- */

  const isCleared = (subjectId, n) => !!S.cleared[key(subjectId, n)];

  function firstOpenChapter(subjectId) {
    const s = subjectOf(subjectId);
    for (let n = 1; n <= s.chapters; n++) if (!isCleared(subjectId, n)) return n;
    return s.chapters;
  }

  function chapterStatus(subjectId, n) {
    if (isCleared(subjectId, n)) return 'done';
    return n === firstOpenChapter(subjectId) ? 'ready' : 'locked';
  }

  function subjectClearedCount(subjectId) {
    const s = subjectOf(subjectId);
    let c = 0;
    for (let n = 1; n <= s.chapters; n++) if (isCleared(subjectId, n)) c++;
    return c;
  }
  const subjectPercent = id =>
    Math.round(subjectClearedCount(id) / subjectOf(id).chapters * 100);
  const subjectDone = id => subjectClearedCount(id) === subjectOf(id).chapters;

  /* Sequential across subjects too: a sea opens once the one before it is finished. */
  function subjectState(subjectId) {
    const i = SUBJECTS.findIndex(s => s.id === subjectId);
    if (subjectDone(subjectId)) return 'done';
    for (let j = 0; j < i; j++) if (!subjectDone(SUBJECTS[j].id)) return 'locked';
    return 'current';
  }
  const currentSubject = () => SUBJECTS.find(s => subjectState(s.id) === 'current') || SUBJECTS[0];

  const totalCleared = () => Object.keys(S.cleared).length;
  const totalChapters = () => SUBJECTS.reduce((a, s) => a + s.chapters, 0);
  const voyagePercent = () => Math.round(totalCleared() / totalChapters() * 100);

  function levelOf(xp) { let lv = 1; for (let i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i]) lv = i + 1; return lv; }
  function xpToNext(xp) { const n = LEVELS[levelOf(xp)]; return n === undefined ? 0 : n - xp; }
  function levelFill(xp) {
    const lv = levelOf(xp), floor = LEVELS[lv - 1], next = LEVELS[lv];
    if (next === undefined) return 10;
    return Math.max(0, Math.min(10, Math.round((xp - floor) / (next - floor) * 10)));
  }

  function streakLength() {
    const set = new Set(S.studied);
    let d = today();
    if (!set.has(d)) d = addDays(d, -1);
    let n = 0;
    while (set.has(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  function badgeState() {
    return {
      clearedCount: totalCleared(),
      streak: streakLength(),
      cardsReviewed: S.cardsReviewed,
      subjectsCleared: SUBJECTS.filter(s => subjectDone(s.id)).length,
      perfectTrial: S.perfectTrial
    };
  }

  /* ---------------- flashcard deck ----------------
     Cards are derived from the quiz of every chapter already cleared, so the deck
     grows as the voyage does and needs nothing extra from the content files. */

  function deckCards() {
    const out = [];
    Object.keys(S.cleared).forEach(k => {
      const ch = chapterCache.get(k);
      if (!ch) return;
      ch.quiz.forEach((q, i) => out.push({
        id: k + '-q' + i,
        front: q.q,
        back: q.opts[q.correct],
        src: (subjectOf(ch.subject) || {}).roman + ' · CH ' + ch.chapter
      }));
    });
    return out;
  }

  async function warmDeck() {
    const missing = Object.keys(S.cleared).filter(k => !chapterCache.has(k));
    if (!missing.length) return;
    await Promise.all(missing.map(k => {
      const [sid, n] = [k.slice(0, k.lastIndexOf('-')), k.slice(k.lastIndexOf('-') + 1)];
      return loadChapter(sid, Number(n));
    }));
  }

  /* ---------------- routing ---------------- */

  let route = { name: 'map' };
  let cardSession = null;
  let pending = false;        // an async load is in flight for the current view

  function parseHash() {
    const h = (location.hash || '#/map').replace(/^#\/?/, '');
    const p = h.split('/').filter(Boolean);
    if (!p.length || p[0] === 'map') return { name: 'map' };
    if (p[0] === 'counsel' || p[0] === 'cards') return { name: 'counsel' };
    if (p[0] === 'stats') return { name: 'stats' };
    if (p[0] === 'crew') return { name: 'crew' };
    if (p[0] === 'sea' && p[1]) {
      if (p[2] === 'ch') return { name: 'chapter', sea: p[1], n: Number(p[3]) };
      return { name: 'region', sea: p[1] };
    }
    return { name: 'map' };
  }
  const go = hash => { location.hash = hash; };

  /* ---------------- toast ---------------- */

  let toastTimer;
  function toast(msg, variant) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('levelup', variant === 'levelup');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), variant === 'levelup' ? 3600 : 2800);
  }

  /* ---------------- ambient score ----------------
     Browsers refuse to start audio without a user gesture, so playback is armed on the
     first click or keypress. The preference is per-device (localStorage, not synced) —
     it travels with the browser, not the navigator. */

  const MUSIC_STORE = 'odyssey.music';
  const MUSIC_VOL = 0.34;

  let musicOn = true;
  let fadeTimer = null;
  const bgm = () => document.getElementById('bgm');

  function loadMusicPref() {
    try {
      const v = localStorage.getItem(MUSIC_STORE);
      musicOn = v === null ? true : v === 'on';
    } catch (e) { musicOn = true; }
  }

  function fadeTo(target, ms) {
    const el = bgm();
    if (!el) return;
    clearInterval(fadeTimer);
    const from = el.volume, steps = Math.max(1, Math.round(ms / 50));
    let i = 0;
    fadeTimer = setInterval(() => {
      i++;
      el.volume = Math.max(0, Math.min(1, from + (target - from) * (i / steps)));
      if (i >= steps) {
        clearInterval(fadeTimer);
        if (target === 0) el.pause();
      }
    }, 50);
  }

  function startMusic() {
    const el = bgm();
    if (!el || !musicOn) return;
    el.volume = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* still blocked — the gesture hook will retry */ });
    fadeTo(MUSIC_VOL, 1600);
  }

  function stopMusic() { fadeTo(0, 500); }

  function renderMusicBtn() {
    const btn = document.getElementById('musicBtn');
    const lbl = document.getElementById('musicState');
    if (!btn || !lbl) return;
    lbl.textContent = musicOn ? 'ON' : 'OFF';
    btn.setAttribute('aria-pressed', musicOn ? 'true' : 'false');
    btn.classList.toggle('on', musicOn);
  }

  function toggleMusic() {
    musicOn = !musicOn;
    try { localStorage.setItem(MUSIC_STORE, musicOn ? 'on' : 'off'); } catch (e) {}
    if (musicOn) startMusic(); else stopMusic();
    renderMusicBtn();
    toast(musicOn ? 'MUSIC ON' : 'MUSIC OFF');
  }

  /* One-shot: the first real interaction unlocks audio. */
  function armMusic() {
    const go = () => {
      document.removeEventListener('click', go, true);
      document.removeEventListener('keydown', go, true);
      if (musicOn && EMAIL) startMusic();
    };
    document.addEventListener('click', go, true);
    document.addEventListener('keydown', go, true);
  }

  /* ---------------- chrome ---------------- */

  function tabFor(r) {
    if (r.name === 'counsel') return 'counsel';
    if (r.name === 'stats') return 'stats';
    if (r.name === 'crew') return 'crew';
    return 'map';
  }

  function renderChrome() {
    const tab = tabFor(route);
    document.querySelectorAll('[data-tab]').forEach(b => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    const lv = levelOf(S.xp), brand = $('#brand'), meta = $('#topbarMeta');

    if (route.name === 'counsel') {
      brand.textContent = "ATHENA'S COUNSEL";
      const done = cardSession ? cardSession.done : 0;
      const total = cardSession ? cardSession.total : 0;
      meta.innerHTML = '<span>' + (total ? Math.min(done + 1, total) + ' / ' + total : '0 / 0') + '</span>';
    } else if (route.name === 'stats') {
      brand.textContent = "CAPTAIN'S LOG";
      const d = daysBetween(today(), EXAM_DATE);
      meta.innerHTML = '<span>' + (d > 0 ? 'EXAM IN ' + d + ' DAYS' : 'EXAM DAY') + '</span>';
    } else if (route.name === 'chapter') {
      const s = subjectOf(route.sea);
      brand.textContent = 'ODYSSEY';
      meta.innerHTML = '<span>SEA ' + esc(s ? s.roman : '?') + ' · CH ' + route.n + '</span>' +
        '<span class="accent dt-only">+' + CHAPTER_XP + ' XP</span>';
    } else {
      const st = streakLength();
      brand.textContent = 'ODYSSEY';
      meta.innerHTML =
        '<span class="dt-only">LV ' + lv + ' · ' + S.xp.toLocaleString('en-US') + ' XP</span>' +
        '<span class="dt-only accent">' + st + ' DAY STREAK</span>' +
        '<span class="mb-only">LV ' + lv + '</span>' +
        '<span class="mb-only accent">' + st + '<span style="color:var(--parch)">D</span></span>';
    }
  }

  /* ---------------- screen: email gate ---------------- */

  function renderGate(busy, errorMsg) {
    return '<div class="shell"><div class="gate">' +
      '<div class="gate-mark">⚓</div>' +
      '<h1>Name your navigator</h1>' +
      '<p>Your progress is saved against your email so you can pick the voyage up on any device. ' +
      'There is no password — anyone who knows the address can see the progress under it.</p>' +
      '<form class="gate-form" id="gateForm">' +
      '<input class="gate-input" id="gateEmail" type="email" inputmode="email" autocomplete="email" ' +
      'placeholder="you@example.com" aria-label="Email address"' + (busy ? ' disabled' : '') + '>' +
      '<button class="btn pxs pop" type="submit"' + (busy ? ' disabled' : '') + '>' +
      (busy ? 'CHECKING…' : 'SET SAIL ▶') + '</button>' +
      '</form>' +
      (errorMsg ? '<div class="gate-err">' + esc(errorMsg) + '</div>' : '') +
      '</div></div>';
  }

  async function signIn(email) {
    EMAIL = email;
    view(renderGate(true, null));

    let remote = null, failed = false;
    try {
      remote = await pullRemote(email);
    } catch (e) {
      failed = true;
    }

    if (remote && remote.v === 2) {
      S = remote;                       // returning navigator — continue where they left off
      if (!S.titles) S.titles = {};
      if (!S.studied) S.studied = [];
      if (!S.sched) S.sched = {};
      if (!S.startedOn) S.startedOn = S.studied.length ? S.studied.slice().sort()[0] : today();
      syncState = 'ok';
    } else if (!failed) {
      S = freshState();                 // known-good backend, no data yet — begin the voyage
      syncState = 'ok';
    } else {
      syncState = 'error';              // offline: keep whatever is local, carry on
    }

    saveLocal();
    if (!failed) pushRemote();

    render();
    hydrate();
    startMusic();          // sign-in is a user gesture, so this is allowed to begin
    if (failed) toast('COULD NOT REACH THE BACKEND — SAVING LOCALLY');
    else if (remote && remote.v === 2) toast('WELCOME BACK · ' + totalCleared() + ' CHAPTERS CLEARED');
  }

  /* On boot with a remembered email, refresh from the cloud — but only adopt the remote
     copy when it is strictly ahead, so work done offline on this device is never clobbered. */
  async function refreshFromCloud() {
    if (!EMAIL) return false;
    let remote;
    try { remote = await pullRemote(EMAIL); }
    catch (e) { syncState = 'error'; return false; }
    syncState = 'ok';
    if (!remote || remote.v !== 2) { pushRemote(); return false; }
    const mine = Object.keys(S.cleared).length;
    const theirs = Object.keys(remote.cleared || {}).length;
    if (theirs > mine || (theirs === mine && (remote.xp || 0) > S.xp)) {
      S = remote;
      if (!S.titles) S.titles = {};
      if (!S.studied) S.studied = [];
      if (!S.sched) S.sched = {};
      if (!S.startedOn) S.startedOn = S.studied.length ? S.studied.slice().sort()[0] : today();
      saveLocal();
      return true;
    }
    pushRemote();   // this device is ahead (or equal) — make sure the cloud has it
    return false;
  }

  function signOut() {
    stopMusic();
    EMAIL = null;
    syncState = 'off';
    try { localStorage.removeItem(EMAIL_STORE); } catch (e) {}
    S = freshState();
    chapterCache.clear();
    cardSession = null;
    saveLocal();
    go('#/map');
    render();
  }

  /* ---------------- screen: map ---------------- */

  function markers() {
    const list = SUBJECTS.map(s => ({ s: s, st: subjectState(s.id) }));
    const allDone = SUBJECTS.every(s => subjectDone(s.id));
    list.push({ s: ITHACA, st: allDone ? 'current' : 'goal' });
    return list.map(m => ({
      s: m.s, st: m.st,
      bg: m.st === 'done' ? 'var(--sea)' : m.st === 'current' ? 'var(--gold)'
        : m.st === 'goal' ? 'var(--deep)' : 'rgba(28,57,64,.85)',
      fg: m.st === 'current' ? 'var(--ink)' : m.st === 'goal' ? 'var(--gold)' : 'var(--parch)',
      bd: m.st === 'goal' ? 'var(--gold)' : 'var(--ink)',
      glyph: m.st === 'done' ? '✓' : m.st === 'current' ? m.s.roman : m.st === 'goal' ? '✦' : '✖',
      labelBg: m.st === 'current' ? 'var(--gold)' : 'rgba(28,57,64,.9)',
      labelFg: m.st === 'current' ? 'var(--ink)' : 'var(--parch)'
    }));
  }

  function markerHTML(m, useLongName) {
    const s = m.s;
    return '<button class="mk' + (m.st === 'locked' ? ' locked' : '') + '" data-sea="' + s.id + '"' +
      ' style="left:' + s.x + '%;top:' + s.y + '%" aria-label="' + esc(s.port + ' — ' + s.name) + '">' +
      (m.st === 'current' && !s.goal ? '<img class="ship bob" src="assets/ship.png" alt="">' : '') +
      '<span class="dotwrap">' + (m.st === 'current' ? '<span class="ring"></span>' : '') +
      '<span class="dot" style="background:' + m.bg + ';border-color:' + m.bd + ';color:' + m.fg + '">' + esc(m.glyph) + '</span></span>' +
      '<span class="tag" style="background:' + m.labelBg + ';color:' + m.labelFg + '">' +
      esc(useLongName ? s.port : s.short) + '</span></button>';
  }

  function renderMap() {
    const ms = markers();
    const pct = voyagePercent();
    const sub = currentSubject();
    const n = firstOpenChapter(sub.id);
    const title = S.titles[key(sub.id, n)];

    const mapHTML = long => '<div class="mapwrap px">' +
      '<img class="mapart" src="assets/map.png" alt="Pixel-art world map of the voyage">' +
      ms.map(m => markerHTML(m, long)).join('') + '</div>';

    const voyage = '<div class="voyagebar">' +
      '<div class="bar">' + bars(Math.round(pct / 100 * 9), 9, 'on', '') + '</div>' +
      '<div class="pct">' + pct + '%</div></div>';

    const nextCard = '<div class="panel panel--parch nextport">' +
      '<div class="label">NEXT PORT OF CALL</div>' +
      '<h2>' + esc(sub.title) + ' — Ch. ' + n + '</h2>' +
      '<p>' + (title
        ? esc(title) + '. Study, recap, then the trial — ' + PASS_MARK + '% to break the seal on Chapter ' + (n + 1) + '.'
        : esc(sub.name) + '. Chapter ' + n + ' has not been charted yet.') + '</p>' +
      '<button class="btn pxs pop" data-go="#/sea/' + sub.id + '/ch/' + n + '">SET SAIL ▶</button></div>';

    const voyagePanel = '<div class="panel panel--deep">' +
      '<div class="label">VOYAGE TO ITHACA</div>' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      '<div class="bar bar--tall" style="flex:1">' + bars(Math.round(pct / 100 * 9), 9, 'on', '') + '</div>' +
      '<div class="mono" style="font-size:var(--px-md);color:var(--gold)">' + pct + '%</div></div>' +
      '<div class="txt txt--sm txt--parch" style="margin-top:12px">' +
      totalCleared() + ' of ' + totalChapters() + ' chapters cleared</div></div>';

    const ledger = '<div class="panel panel--parch" style="flex:1">' +
      '<div class="label label--ink">SHIP\'S LEDGER</div><div class="ledger">' +
      ms.map(m => '<button class="ledger-row' + (m.st === 'locked' ? ' locked' : '') + '" data-sea="' + m.s.id + '">' +
        '<span class="dot" style="background:' + m.bg + ';border-color:' + m.bd + ';color:' + m.fg + '">' + esc(m.glyph) + '</span>' +
        '<span style="flex:1"><span class="nm" style="display:block">' + esc(m.s.port) + '</span>' +
        '<span class="sb" style="display:block">' + esc(m.s.name) +
        (m.s.goal ? '' : ' · ' + subjectClearedCount(m.s.id) + '/' + m.s.chapters) + '</span></span></button>').join('') +
      '</div></div>';

    return '<div class="shell">' +
      '<div class="mb-only">' + voyage + mapHTML(false) + nextCard + '</div>' +
      '<div class="dt-only cols cols--map"><div class="main">' + mapHTML(true) + '</div>' +
      '<div class="side">' + voyagePanel + nextCard + ledger + '</div></div></div>';
  }

  /* ---------------- screen: region ---------------- */

  function isleHTML(subjectId, n) {
    const st = chapterStatus(subjectId, n);
    const rec = S.cleared[key(subjectId, n)];
    const title = S.titles[key(subjectId, n)];
    const status = st === 'done' ? 'CLEARED ' + rec.score + '%' : st === 'ready' ? 'READY' : 'SEALED';
    const icon = st === 'done' ? '✓' : st === 'ready' ? '▶' : '✖';
    const pos = S.pos[key(subjectId, n)];
    const filled = st === 'done' ? 5 : (pos ? Math.min(pos.stage, 4) : 0);
    return '<button class="isle ' + st + '" data-ch="' + n + '" data-sea="' + subjectId + '">' +
      '<span class="row"><span>CH ' + String(n).padStart(2, '0') + '</span><span>' + icon + '</span></span>' +
      '<span class="ttl">' + (title ? esc(title)
        : (st === 'locked' ? '<span class="uncharted">Not yet charted</span>' : 'Chapter ' + n)) + '</span>' +
      '<span class="track">' + bars(filled, 5,
        st === 'ready' ? 'style-deep' : 'style-gold',
        st === 'ready' ? 'style-light' : 'style-deep') + '</span>' +
      '<span class="st">' + status + '</span></button>';
  }

  function renderRegion(subjectId) {
    const sub = subjectOf(subjectId);
    if (!sub) return renderMap();

    const clearedN = subjectClearedCount(subjectId);
    const scores = [];
    for (let n = 1; n <= sub.chapters; n++) if (isCleared(subjectId, n)) scores.push(S.cleared[key(subjectId, n)].score);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

    const stats = '<div class="stats3">' +
      '<dl class="stat"><dt>CHAPTERS</dt><dd>' + clearedN + '/' + sub.chapters + '</dd></dl>' +
      '<dl class="stat"><dt>AVG SCORE</dt><dd class="gold">' + avg + '%</dd></dl>' +
      '<dl class="stat"><dt>XP</dt><dd>' + (clearedN * CHAPTER_XP) + '</dd></dl></div>';

    let isles = '';
    for (let n = 1; n <= sub.chapters; n++) isles += isleHTML(subjectId, n);

    const nextN = firstOpenChapter(subjectId);
    const allDone = subjectDone(subjectId);
    const nextTitle = S.titles[key(subjectId, nextN)];

    const seal = '<div class="seal"><span class="star">✱</span><p>' + esc(allDone
      ? 'Every chapter of this sea is cleared. The next sea is open.'
      : 'Pass Chapter ' + nextN + '’s Trial at ' + PASS_MARK + '% or better to break the seal on Chapter ' + (nextN + 1) + '.') +
      '</p></div>';

    const resume = allDone ? '' : '<div class="panel panel--parch">' +
      '<div class="label">RESUME</div>' +
      '<div class="serif" style="font-size:19px;color:var(--ink)">Ch. ' + nextN +
      (nextTitle ? ' — ' + esc(nextTitle) : '') + '</div>' +
      '<p style="font-size:14px;line-height:1.55;color:rgba(38,34,26,.75);margin:8px 0 14px">' +
      (nextTitle ? (S.pos[key(subjectId, nextN)] ? 'You left off mid-voyage.' : 'Not yet begun.')
                 : 'This chapter has not been charted yet.') + '</p>' +
      '<button class="btn pxs pop" data-go="#/sea/' + subjectId + '/ch/' + nextN + '">CONTINUE ▶</button></div>';

    const deckPanel = '<div class="panel panel--deep">' +
      '<div class="label label--gold">COUNSEL FROM THIS SEA</div>' +
      '<div class="txt txt--parch">' +
      'Cards are drawn from the trials of chapters you have cleared. ' +
      (allDone ? 'This sea is fully charted.' : 'Clear Ch. ' + nextN + ' to add more.') + '</div></div>';

    return '<div class="subhead subhead--sea">' +
      '<button class="back" data-go="#/map" aria-label="Back to map">◀</button>' +
      '<div><div class="eyebrow">SEA ' + esc(sub.roman) + ' · ' + esc(sub.port) + '</div>' +
      '<h1>' + esc(sub.name) + '</h1></div>' +
      '<div class="spacer"></div><div class="dt-only">' + stats + '</div></div>' +
      '<div class="shell"><div class="mb-only">' + stats + '</div>' +
      '<div class="cols"><div class="main"><div class="isles">' + isles + '</div>' +
      '<div class="mb-only">' + seal + '</div></div>' +
      '<div class="side dt-only">' + resume + seal + deckPanel + '</div></div></div>';
  }

  /* ---------------- celebration ---------------- */

  let celebrateFor = null;   // chapter key that just cleared, so the party fires once

  const CONFETTI_TINTS = ['var(--gold)', 'var(--bronze)', 'var(--sea)', 'var(--clay)', 'var(--parch)'];

  function confettiHTML() {
    let h = '';
    for (let i = 0; i < 22; i++) {
      const a = (Math.PI * 2) * (i / 22) + (Math.random() - 0.5) * 0.45;
      const d = 95 + Math.random() * 125;
      h += '<i style="' +
        '--cf-x:' + Math.round(Math.cos(a) * d) + 'px;' +
        '--cf-y:' + Math.round(Math.sin(a) * d) + 'px;' +
        '--cf-rot:' + Math.round(Math.random() * 720 - 360) + 'deg;' +
        '--cf-delay:' + (Math.random() * 0.25).toFixed(2) + 's;' +
        '--cf-dur:' + (0.9 + Math.random() * 0.5).toFixed(2) + 's;' +
        'background:' + CONFETTI_TINTS[i % CONFETTI_TINTS.length] + '"></i>';
    }
    return h;
  }

  /* Ticks a number up to its target so XP feels earned rather than printed. */
  function countUp(el, to, ms) {
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = '+' + Math.round(to * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------------- screen: chapter ---------------- */

  const STAGE_NAMES = ['STUDY', 'RECAP', 'TRIAL', 'VICTORY'];

  function chapterPos(subjectId, n) {
    const k = key(subjectId, n);
    if (!S.pos[k]) S.pos[k] = { stage: 0, qi: 0, answers: [] };
    if (!S.pos[k].answers) S.pos[k].answers = [];
    return S.pos[k];
  }

  function trialScore(ch, p) {
    const qs = ch.quiz;
    const right = p.answers.filter((a, i) => qs[i] && a === qs[i].correct).length;
    return { right: right, total: qs.length, pct: Math.round(right / qs.length * 100) };
  }

  function renderChapter(subjectId, n) {
    const sub = subjectOf(subjectId);
    if (!sub || n < 1 || n > sub.chapters) return renderMap();

    if (chapterStatus(subjectId, n) === 'locked') {
      return chapterFrame(sub, n, null,
        '<div class="empty"><h2>Sealed</h2>' +
        '<p>Pass the trial of the chapter before this one to break the seal.</p>' +
        '<button class="btn pxs pop btn--inline" data-go="#/sea/' + subjectId + '" style="margin:0 auto">BACK TO THE ISLES</button></div>');
    }

    const ch = chapterCache.get(key(subjectId, n));

    if (ch === undefined) {   // still loading
      return chapterFrame(sub, n, null,
        '<div class="empty"><h2>Charting…</h2><p>Reading the ship\'s charts for Chapter ' + n + '.</p></div>');
    }

    if (ch === null) {        // 404 / failed fetch — the documented placeholder
      return chapterFrame(sub, n, null,
        '<div class="empty"><h2>This island hasn\'t been charted yet</h2>' +
        '<p>Chapter ' + n + ' of ' + esc(sub.name) + ' has no content file yet. ' +
        'Once <code>content/' + esc(subjectId) + '/ch' + n + '.json</code> is added it will appear here — ' +
        'nothing else in the voyage changes.</p>' +
        '<button class="btn pxs pop btn--inline" data-go="#/sea/' + subjectId + '" style="margin:0 auto">BACK TO THE ISLES</button></div>');
    }

    const p = chapterPos(subjectId, n);
    let body;
    if (p.stage === 0) body = renderStudy(ch);
    else if (p.stage === 1) body = renderRecap(ch);
    else if (p.stage === 2) body = renderTrial(ch, p);
    else body = renderVictory(sub, ch, p);

    return chapterFrame(sub, n, p, body, ch);
  }

  function chapterFrame(sub, n, p, body, ch) {
    const stages = p ? '<div class="stages">' + STAGE_NAMES.map((label, i) => {
      const cls = i === p.stage ? 'current' : i < p.stage ? 'past' : '';
      return '<button class="stage ' + cls + '" data-stage="' + i + '"' +
        (i <= p.stage ? '' : ' disabled') + '>' + label + '</button>';
    }).join('') + '</div>' : '';

    const goal = '<div class="panel panel--parch"><div class="label label--ink">CHAPTER GOAL</div>' +
      '<div style="font-size:14px;line-height:1.55;color:rgba(38,34,26,.8)">' +
      'Score ' + PASS_MARK + '% or better in the Trial to unseal Chapter ' + (n + 1) +
      (ch ? ' and add ' + ch.quiz.length + ' cards to your review deck.' : '.') + '</div></div>';

    const objectives = (ch && ch.objectives && ch.objectives.length)
      ? '<div class="panel panel--deep"><div class="label label--gold">OBJECTIVES</div>' +
        '<ul class="objlist">' + ch.objectives.map(o => '<li>' + esc(o) + '</li>').join('') + '</ul></div>'
      : '';

    return '<div class="subhead subhead--deep" style="display:block">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
      '<button class="back" data-go="#/sea/' + sub.id + '" aria-label="Back to chapters">◀ CH ' + n + '</button>' +
      '<span class="mono" class="pixnum pixnum--gold">+' + CHAPTER_XP + ' XP</span></div>' +
      (stages ? '<div class="mb-only" style="margin-top:12px">' + stages + '</div>' : '') +
      '</div><div class="shell"><div class="cols cols--narrowside">' +
      (p ? '<div class="side dt-only"><div class="panel panel--deep"><div class="label">STAGES</div>' +
        stages + '</div>' + goal + objectives + '</div>' : '') +
      '<div class="main paper">' + body + '</div></div></div>';
  }

  function renderStudy(ch) {
    return '<div class="prose">' +
      '<div class="label">STAGE 1 · STUDY</div>' +
      '<h2>' + esc(ch.title) + '</h2>' +
      (ch.objectives && ch.objectives.length
        ? '<div class="objbox mb-only"><div class="label label--ink">OBJECTIVES</div><ul>' +
          ch.objectives.map(o => '<li>' + esc(o) + '</li>').join('') + '</ul></div>'
        : '') +
      '<div class="studybody">' + ch.study + '</div>' +
      '<button class="btn pxs pop btn--inline" data-next="1">TO THE RECAP ▶</button></div>';
  }

  function renderRecap(ch) {
    return '<div class="prose">' +
      '<div class="label">STAGE 2 · RECAP</div>' +
      '<h2>Recap Scroll</h2>' +
      '<div class="recapbody">' + ch.recap + '</div>' +
      '<button class="btn pxs pop btn--inline" data-next="1" style="margin-top:24px">ENTER THE TRIAL ▶</button></div>';
  }

  function renderTrial(ch, p) {
    const qs = ch.quiz;
    const qi = Math.min(p.qi, qs.length - 1);
    const q = qs[qi];
    const picked = p.answers[qi];
    const answered = picked !== undefined && picked !== null;
    const correct = answered && picked === q.correct;
    const last = qi === qs.length - 1;

    const options = q.opts.map((text, i) => {
      let cls = '';
      if (answered) cls = i === q.correct ? 'correct' : i === picked ? 'wrong' : 'dim';
      return '<button class="opt ' + cls + '" data-pick="' + i + '"' + (answered ? ' disabled' : '') + '>' +
        '<span class="k">' + 'ABCDEFGH'[i] + '</span><span class="t">' + esc(text) + '</span></button>';
    }).join('');

    const feedback = answered ? '<div class="verdictrow">' +
      '<div class="verdict px"><div class="v">' + (correct ? 'TRUE COURSE' : 'OFF COURSE') + '</div>' +
      '<div class="e">' + esc(correct
        ? 'That is the right heading.'
        : 'The true answer is “' + q.opts[q.correct] + '”.') + '</div></div>' +
      '<button class="btn pxs pop" data-next="1">' + (last ? 'CLAIM VICTORY ▶' : 'NEXT TRIAL ▶') + '</button></div>' : '';

    return '<div class="prose">' +
      '<div class="trialhead"><span class="q">TRIAL · Q' + (qi + 1) + '/' + qs.length + '</span>' +
      '<span class="pass">PASS ' + PASS_MARK + '%</span></div>' +
      '<div class="bar">' + bars(qi + (answered ? 1 : 0), qs.length, 'on', '') + '</div>' +
      '<div class="question">' + esc(q.q) + '</div>' +
      '<div class="options">' + options + '</div>' + feedback + '</div>';
  }

  function renderVictory(sub, ch, p) {
    const sc = trialScore(ch, p);
    const passed = sc.pct >= PASS_MARK;
    const k = key(sub.id, ch.chapter);
    const rec = S.cleared[k];                     // reflects this run — clearChapter ran first
    const stillCleared = !!rec;                   // cleared now, or cleared on an earlier run
    const attempts = rec ? (rec.attempts || 1) : 1;
    const isRetake = attempts > 1;
    const best = rec ? rec.score : 0;
    const nextN = ch.chapter + 1;
    const hasNext = nextN <= sub.chapters;
    const celebrate = passed && celebrateFor === k;
    /* Confetti is for a first clear or a new personal best; a repeat run that
       matched or fell short of the best gets the staged reveal without the burst. */
    const burst = celebrate && (!isRetake || lastRunWasBest);
    const tier = !passed ? 'fail' : sc.pct >= 85 ? 'gold' : 'bronze';

    let eyebrow, heading, sub_;
    if (passed && !isRetake) {
      eyebrow = 'CHAPTER CLEARED';
      heading = 'The strait is calm';
      sub_ = sc.right + ' of ' + sc.total + ' trials answered true. ' +
        (hasNext ? 'Chapter ' + nextN + ' is now unsealed.' : 'This sea is cleared.');
    } else if (passed && isRetake) {
      eyebrow = lastRunWasBest ? 'A NEW BEST' : 'SAILED AGAIN';
      heading = lastRunWasBest ? 'Your finest crossing yet' : 'The strait is calm';
      sub_ = sc.right + ' of ' + sc.total + ' answered true on attempt ' + attempts + '. ' +
        (lastRunWasBest ? 'That is your best run.' : 'Your best stands at ' + best + '%.');
    } else if (!passed && stillCleared) {
      eyebrow = 'A ROUGHER CROSSING';
      heading = 'The chapter still stands cleared';
      sub_ = 'Only ' + sc.right + ' of ' + sc.total + ' this time, but nothing is lost — ' +
        'Chapter ' + ch.chapter + ' stays cleared at your best of ' + best + '%.';
    } else {
      eyebrow = 'THE STRAIT HOLDS';
      heading = 'Turn about and try again';
      sub_ = sc.right + ' of ' + sc.total + ' trials answered true. ' +
        'You need ' + PASS_MARK + '% to break the seal — sail the trial once more.';
    }

    const tally = passed ? '<div class="tally">' + (isRetake
      ? '<div><span>THIS RUN</span><span>' + sc.pct + '%</span></div>' +
        '<div><span>BEST</span><span>' + best + '%</span></div>' +
        '<div><span>ATTEMPTS</span><span>' + attempts + '</span></div>'
      : '<div><span>XP EARNED</span><span data-count="' + CHAPTER_XP + '">+' +
        (celebrate ? 0 : CHAPTER_XP) + '</span></div>' +
        '<div><span>NEW CARDS</span><span>+' + ch.quiz.length + '</span></div>' +
        '<div><span>STREAK</span><span>' + streakLength() + ' DAYS</span></div>') +
      '</div>' : '';

    const back = '<button class="btn pxs pop btn--inline btn--deep" data-go="#/sea/' + sub.id + '">BACK TO THE ISLES</button>';
    const again = '<button class="btn pxs pop btn--inline" data-redo="1">SAIL IT AGAIN ▶</button>';
    const retry = '<button class="btn pxs pop btn--inline" data-retry="1">RETRY THE TRIAL ▶</button>';
    const buttons = '<div class="btnrow">' +
      (passed ? back + again : stillCleared ? back + retry : retry) + '</div>';

    return '<div class="victory' + (celebrate ? ' celebrate' : '') + '">' +
      '<div class="eyebrow">' + eyebrow + '</div>' +
      '<div class="medalwrap">' +
      (burst ? '<div class="confetti" aria-hidden="true">' + confettiHTML() + '</div>' : '') +
      '<div class="medal px tier-' + tier +
      (String(sc.pct).length > 2 ? ' medal--wide' : '') + '">' + sc.pct + '%</div></div>' +
      (sc.pct === 100 ? '<div class="medalribbon">★ PERFECT VOYAGE ★</div>' : '') +
      '<h2>' + heading + '</h2>' +
      '<div class="sub">' + esc(sub_) + '</div>' +
      tally + buttons + '</div>';
  }

  let lastRunWasBest = false;   // did the run just finished beat the previous best?

  function clearChapter(sub, ch, p) {
    const sc = trialScore(ch, p);
    const k = key(sub.id, ch.chapter);
    const prev = S.cleared[k];
    lastRunWasBest = false;

    /* A failed run never downgrades anything. If the chapter was already cleared it
       stays cleared at its best score; only the attempt count moves. */
    if (sc.pct < PASS_MARK) {
      if (prev) { prev.attempts = (prev.attempts || 1) + 1; save(); }
      return;
    }

    if (!prev) {
      const lvBefore = levelOf(S.xp);
      S.cleared[k] = { score: sc.pct, on: today(), attempts: 1 };
      S.xp += CHAPTER_XP;                         // XP is earned once, never farmed
      if (sc.pct === 100) S.perfectTrial = true;
      lastRunWasBest = true;
      markStudiedToday();
      save();
      celebrateFor = k;
      const lvAfter = levelOf(S.xp);
      if (lvAfter > lvBefore) setTimeout(() => toast('LEVEL UP — LV ' + lvAfter, 'levelup'), 1300);
    } else {
      prev.attempts = (prev.attempts || 1) + 1;
      if (sc.pct > prev.score) { prev.score = sc.pct; prev.on = today(); lastRunWasBest = true; }
      if (sc.pct === 100) S.perfectTrial = true;
      markStudiedToday();
      save();
      celebrateFor = k;
    }
  }

  /* ---------------- screen: Athena's Counsel (flashcard review) ---------------- */

  function startSession() {
    const t = today();
    const due = deckCards().filter(c => {
      const s = S.sched[c.id];
      return !s || s.due <= t;
    });
    cardSession = { cards: due, queue: due.map(c => c.id), total: due.length, done: 0, flipped: false, xp: 0 };
  }

  function renderCounsel() {
    if (!cardSession) return '<div class="shell"><div class="empty"><h2>Shuffling…</h2></div></div>';
    const cs = cardSession;

    if (!cs.queue.length) {
      const cleared = totalCleared();
      return '<div class="shell"><div class="empty">' +
        '<h2>' + (cs.total ? 'Deck cleared' : cleared ? 'Nothing due' : 'No cards yet') + '</h2>' +
        '<p>' + (cs.total
          ? 'You reviewed ' + cs.total + ' card' + (cs.total === 1 ? '' : 's') + ' and earned ' + cs.xp + ' XP.'
          : cleared
            ? 'No cards are due right now. Come back tomorrow.'
            : 'Cards are drawn from the trials of chapters you have cleared. Clear your first chapter to start the deck.') +
        '</p><button class="btn pxs pop btn--inline" data-go="#/map" style="margin:0 auto">BACK TO THE MAP</button></div></div>';
    }

    const card = cs.cards.find(c => c.id === cs.queue[0]);

    const cardEl = '<button class="card px' + (cs.flipped ? ' flipped' : '') +
      (cs.turn ? ' turn' : '') + '" data-flip="1">' +
      '<span class="side">' + (cs.flipped ? 'ANSWER' : 'PROMPT') + '</span>' +
      '<span class="tx">' + esc(cs.flipped ? card.back : card.front) + '</span>' +
      (cs.flipped ? '' : '<span class="hint">TAP TO REVEAL · SPACE</span>') +
      '<span class="src">SEA ' + esc(card.src) + '</span></button>';

    const rates = cs.flipped ? '<div><div class="rates">' +
      '<button class="rate again pop" data-rate="again">AGAIN</button>' +
      '<button class="rate hard pop" data-rate="hard">HARD</button>' +
      '<button class="rate easy pop" data-rate="easy">EASY</button></div>' +
      '<div class="ratehints"><div>&lt;1 MIN</div><div>2 DAYS</div><div>6 DAYS</div></div></div>' : '';

    const deckStats = '<dl class="deckstats">' +
      '<div><dt>DUE</dt><dd>' + cs.queue.length + '</dd></div>' +
      '<div><dt>DONE</dt><dd>' + cs.done + '</dd></div>' +
      '<div><dt>XP</dt><dd>' + cs.xp + '</dd></div></dl>';

    const side =
      '<div class="panel panel--sea"><div class="label label--gold">TODAY\'S DECK</div>' +
      [['DUE', cs.queue.length], ['DONE', cs.done], ['XP', cs.xp]].map(([k, v]) =>
        '<div class="rowbetween" style="margin-bottom:13px">' +
        '<span class="mono" class="pixnum pixnum--parch">' + k + '</span>' +
        '<span class="mono" class="pixnum pixnum--gold">' + v + '</span></div>').join('') + '</div>' +
      '<div class="panel panel--parch"><div class="label label--ink">DECK SOURCE</div>' +
      '<div style="font-size:14px;line-height:1.6;color:rgba(38,34,26,.8)">Every question from a cleared trial becomes a card. ' +
      totalCleared() + ' of ' + totalChapters() + ' chapters cleared so far.</div></div>' +
      '<div class="panel panel--deep"><div class="label label--gold">SHORTCUTS</div>' +
      '<div class="txt txt--parch">Space — flip<br>1 / 2 / 3 — again · hard · easy</div></div>';

    const out = '<div class="shell"><div class="cols cols--narrowside">' +
      '<div class="main" class="vstack vstack--lg">' +
      '<div class="bar">' + bars(cs.done, Math.max(cs.total, 1), 'on', 'off') + '</div>' +
      cardEl + rates + '<div class="mb-only">' + deckStats + '</div></div>' +
      '<div class="side dt-only">' + side + '</div></div></div>';
    cs.turn = false;
    return out;
  }

  function rateCard(kind) {
    const cs = cardSession;
    if (!cs || !cs.flipped || !cs.queue.length) return;
    const id = cs.queue.shift();
    const t = today();
    const ivl = kind === 'again' ? 0 : kind === 'hard' ? 2 : 6;
    S.sched[id] = { due: addDays(t, ivl), ivl: ivl, last: t };
    if (kind === 'again') cs.queue.push(id); else cs.done++;
    cs.turn = true;
    S.cardsReviewed++;
    S.xp += CARD_XP;
    cs.xp += CARD_XP;
    cs.flipped = false;
    markStudiedToday();
    save();
    render();
  }

  /* ---------------- screen: ship's log ---------------- */

  function renderStats() {
    const lv = levelOf(S.xp), fill = levelFill(S.xp), togo = xpToNext(S.xp), streak = streakLength();

    const now = new Date();
    const end = addDays(today(), 6 - now.getDay());
    const set = new Set(S.studied);
    const t = today();
    const began = S.startedOn || t;
    let cells = '';
    for (let i = 27; i >= 0; i--) {
      const d = addDays(end, -i);
      let cls;
      if (d > t) cls = 'future';            // hasn't happened yet
      else if (d < began) cls = 'future';   // before this navigator set out — not a miss
      else if (set.has(d)) cls = '';
      else cls = 'missed';
      cells += '<i class="' + cls + '" title="' + d + '"></i>';
    }

    const navigator = '<div class="panel panel--sea"><div class="navigator">' +
      '<div><div class="label label--gold" style="margin:0">NAVIGATOR</div><div class="lv">LV ' + lv + '</div></div>' +
      '<div style="text-align:right"><div class="xp">' + S.xp.toLocaleString('en-US') + ' XP</div>' +
      '<div class="togo">' + (togo ? togo + ' TO LV ' + (lv + 1) : 'MAX RANK') + '</div></div></div>' +
      '<div class="bar bar--tall">' + bars(fill, 10, 'on', 'lvoff') + '</div></div>';

    const streakPanel = '<div class="panel panel--parch">' +
      '<div class="streakhead"><span>STREAK</span><span class="days">' + streak + ' DAY' + (streak === 1 ? '' : 'S') + '</span></div>' +
      '<div class="streakgrid">' + cells + '</div>' +
      '<div class="legend"><span><i style="background:var(--gold)"></i>STUDIED</span>' +
      '<span><i style="background:var(--clay)"></i>MISSED</span>' +
      '<span><i style="background:var(--mute)"></i>NOT SAILING</span></div></div>';

    const seasPanel = '<div class="panel panel--parch"><div class="label label--ink">THE FIVE SEAS</div>' +
      '<div class="vstack vstack--md">' +
      SUBJECTS.map(s => {
        const pct = subjectPercent(s.id);
        return '<div><div class="seasrow"><span class="nm">' + esc(s.name) + '</span>' +
          '<span class="pc">' + subjectClearedCount(s.id) + '/' + s.chapters + '</span></div>' +
          '<div class="bar" style="height:13px;gap:2px;padding:2px">' + bars(Math.round(pct / 10), 10, 'on', 'off') + '</div></div>';
      }).join('') + '</div></div>';

    const bs = badgeState();
    const relicsPanel = '<div class="panel panel--deep"><div class="label label--gold">RELICS</div>' +
      '<div class="relics">' + BADGES.map(b => {
        const on = b.test(bs);
        return '<div class="relic' + (on ? '' : ' off') + '"><div class="ic pxs">' + b.icon + '</div>' +
          '<div class="nm">' + b.name + '</div></div>';
      }).join('') + '</div></div>';

    const syncLabel = syncState === 'ok' ? 'SYNCED' : syncState === 'error' ? 'LOCAL ONLY' : 'OFF';
    const syncColor = syncState === 'ok' ? 'var(--gold)' : syncState === 'error' ? 'var(--clay)' : 'var(--parch)';
    const syncPanel = '<div class="panel panel--deep"><div class="label label--gold">SYNC ACROSS DEVICES</div>' +
      '<div class="txt txt--parch">Signed in as <b>' + esc(EMAIL || '—') + '</b><br>' +
      'Status: <span style="color:' + syncColor + '">' + syncLabel + '</span></div>' +
      '<div style="font-size:13px;line-height:1.6;color:rgba(233,224,201,.7);margin-top:10px">' +
      'Progress saves to this browser and pushes to the cloud after every trial. No password — anyone with this address sees this progress.</div>' +
      '<button class="btn pxs pop" data-signout="1" style="margin-top:14px;background:var(--clay);color:var(--cream)">SWITCH NAVIGATOR</button></div>';

    return '<div class="shell"><div class="stack" style="margin-bottom:14px">' +
      '<div class="cols cols--wide"><div class="main">' + navigator + '</div>' +
      '<div class="side">' + streakPanel + '</div></div>' +
      '<div class="cols cols--wide"><div class="main">' + seasPanel + '</div>' +
      '<div class="side">' + relicsPanel + syncPanel + '</div></div></div></div>';
  }

  /* ---------------- screen: crew ---------------- */

  let crewRoster = null;    // null = not loaded yet
  let crewError = false;

  async function loadCrew() {
    crewError = false;
    try {
      const res = await fetch(WORKER_URL + '/crew?email=' + encodeURIComponent(EMAIL || ''));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      crewRoster = Array.isArray(list) ? list : [];
    } catch (e) {
      crewRoster = [];
      crewError = true;
    }
  }

  /* Placeholder sprites: a deterministic colour + monogram per navigator,
     standing in until the real character art lands. */
  const CREW_TINTS = ['var(--sea)', 'var(--bronze)', 'var(--clay)', 'var(--deep)', 'var(--gold)'];
  function tintFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return CREW_TINTS[h % CREW_TINTS.length];
  }

  function crewCard(m) {
    const lv = levelOf(m.xp);
    const tint = tintFor(m.name);
    const onGold = tint === 'var(--gold)';
    const pct = Math.round(m.cleared / totalChapters() * 100);
    return '<div class="crewcard' + (m.you ? ' you' : '') + '">' +
      '<div class="crewsprite" style="background:' + tint + ';color:' +
      (onGold ? 'var(--ink)' : 'var(--parch)') + '">' +
      esc(m.name.slice(0, 1).toUpperCase()) + '</div>' +
      '<div class="crewbody">' +
      '<div class="crewname">' + esc(m.name) + (m.you ? ' <span class="youtag">YOU</span>' : '') + '</div>' +
      '<div class="crewmeta">LV ' + lv + ' · ' + m.xp.toLocaleString('en-US') + ' XP</div>' +
      '<div class="bar crewbar">' + bars(Math.max(m.cleared ? 1 : 0, Math.round(pct / 100 * 10)), 10, 'on', 'off') + '</div>' +
      '<div class="crewsub">' + m.cleared + ' of ' + totalChapters() + ' chapters' +
      (m.lastStudied ? ' · last seen ' + esc(m.lastStudied) : ' · not yet sailed') + '</div>' +
      '</div></div>';
  }

  function renderCrew() {
    if (crewRoster === null) {
      return '<div class="shell"><div class="empty"><h2>Mustering the crew…</h2></div></div>';
    }
    if (crewError) {
      return '<div class="shell"><div class="empty"><h2>The roster is out of reach</h2>' +
        '<p>Could not read the crew from the backend. Your own voyage is unaffected.</p>' +
        '<button class="btn pxs pop btn--inline" data-crewretry="1" style="margin:0 auto">TRY AGAIN</button></div></div>';
    }
    if (!crewRoster.length) {
      return '<div class="shell"><div class="empty"><h2>You sail alone</h2>' +
        '<p>No other navigators have set out yet.</p>' +
        '<button class="btn pxs pop btn--inline" data-go="#/map" style="margin:0 auto">BACK TO THE MAP</button></div></div>';
    }
    return '<div class="shell">' +
      '<div class="panel panel--deep" style="margin-bottom:14px">' +
      '<div class="label label--gold">THE CREW</div>' +
      '<div class="txt txt--parch">' +
      crewRoster.length + ' navigator' + (crewRoster.length === 1 ? '' : 's') + ' on this voyage, ranked by XP. ' +
      'Character sprites are still being drawn — monograms stand in for now.</div></div>' +
      '<div class="crewgrid">' + crewRoster.map(crewCard).join('') + '</div></div>';
  }

  /* ---------------- render ---------------- */

  function view(html) { $('#view').innerHTML = html; }

  /* Identity of the current screen. Entrance animations fire when this changes, so
     stepping between stages animates but answering a question in place does not. */
  let lastViewKey = null;
  function viewKey() {
    /* The key also carries whether async content has landed, so the entrance fires
       again when a "loading" view is replaced by the real thing — but not when the
       same loaded view re-renders in place (answering a question, flipping a card). */
    if (route.name === 'chapter') {
      const k = key(route.sea, route.n);
      const p = S.pos[k];
      return 'chapter/' + k + '/' + (p ? p.stage : 0) + '/' + (chapterCache.has(k) ? 'r' : 'l');
    }
    if (route.name === 'region') {
      const sub = subjectOf(route.sea);
      const known = sub ? Object.keys(S.titles).filter(t => t.indexOf(route.sea + '-') === 0).length : 0;
      return 'region/' + route.sea + '/' + known;
    }
    if (route.name === 'counsel') return 'counsel/' + (cardSession ? 'r' : 'l');
    if (route.name === 'crew') return 'crew/' + (crewRoster ? 'r' : 'l');
    if (route.name === 'map') {
      const sub = currentSubject();
      return 'map/' + (S.titles[key(sub.id, firstOpenChapter(sub.id))] ? 'r' : 'l');
    }
    return route.name;
  }

  function render() {
    document.body.classList.toggle('gated', !EMAIL);
    renderMusicBtn();
    if (!EMAIL) { view(renderGate(false, null)); return; }

    let html;
    if (route.name === 'map') html = renderMap();
    else if (route.name === 'region') html = renderRegion(route.sea);
    else if (route.name === 'chapter') html = renderChapter(route.sea, route.n);
    else if (route.name === 'counsel') html = renderCounsel();
    else if (route.name === 'stats') html = renderStats();
    else html = renderCrew();
    view(html);
    renderChrome();

    const vk = viewKey();
    const el = $('#view');
    el.classList.remove('enter');
    if (vk !== lastViewKey) {
      void el.offsetWidth;          // restart the animation
      el.classList.add('enter');
      lastViewKey = vk;
    }

    const counter = el.querySelector('.victory.celebrate [data-count]');
    if (counter) countUp(counter, Number(counter.dataset.count), 900);
  }

  /* Load whatever the current route needs, then re-render. */
  async function hydrate() {
    if (!EMAIL) return;
    const r = route;
    pending = true;
    try {
      if (r.name === 'chapter') {
        if (chapterStatus(r.sea, r.n) !== 'locked') await loadChapter(r.sea, r.n);
      } else if (r.name === 'region') {
        await warmSubject(r.sea);
      } else if (r.name === 'map') {
        const sub = currentSubject();
        await loadChapter(sub.id, firstOpenChapter(sub.id));
      } else if (r.name === 'counsel') {
        await warmDeck();
        startSession();
      } else if (r.name === 'crew') {
        await loadCrew();
      }
    } catch (e) { /* loader already degrades to the placeholder */ }
    pending = false;
    if (route === r) render();
  }

  /* ---------------- events ---------------- */

  document.addEventListener('submit', e => {
    const form = e.target.closest('#gateForm');
    if (!form) return;
    e.preventDefault();
    const input = $('#gateEmail');
    const email = (input.value || '').trim().toLowerCase();
    if (!validEmail(email)) { view(renderGate(false, 'That does not look like an email address.')); return; }
    signIn(email);
  });

  document.addEventListener('click', e => {
    const t = e.target;

    if (t.closest('#musicBtn')) { toggleMusic(); return; }

    const goEl = t.closest('[data-go]');
    if (goEl && !goEl.disabled) { go(goEl.dataset.go); return; }

    const tabEl = t.closest('[data-tab]');
    if (tabEl) { go(tabEl.dataset.tab === 'map' ? '#/map' : '#/' + tabEl.dataset.tab); return; }

    if (t.closest('[data-signout]')) { signOut(); return; }

    if (t.closest('[data-crewretry]')) { crewRoster = null; render(); hydrate(); return; }

    const seaEl = t.closest('[data-sea]:not([data-ch])');
    if (seaEl) {
      const id = seaEl.dataset.sea;
      if (id === 'ithaca') { toast('ITHACA — EXAM DAY. FINISH THE FIVE SEAS FIRST.'); return; }
      if (subjectState(id) === 'locked') { toast('THAT SEA IS STILL SEALED'); return; }
      go('#/sea/' + id);
      return;
    }

    const isleEl = t.closest('[data-ch]');
    if (isleEl) {
      const sid = isleEl.dataset.sea, n = Number(isleEl.dataset.ch);
      if (chapterStatus(sid, n) === 'locked') { toast('CHAPTER ' + n + ' IS SEALED'); return; }
      go('#/sea/' + sid + '/ch/' + n);
      return;
    }

    if (route.name !== 'chapter') {
      const rateEl = t.closest('[data-rate]');
      if (rateEl) { rateCard(rateEl.dataset.rate); return; }
      if (t.closest('[data-flip]')) { if (cardSession) { cardSession.flipped = !cardSession.flipped; cardSession.turn = true; render(); } return; }
      return;
    }

    const ch = chapterCache.get(key(route.sea, route.n));
    const sub = subjectOf(route.sea);
    if (!ch) return;
    const p = chapterPos(route.sea, route.n);

    const stageEl = t.closest('[data-stage]');
    if (stageEl && !stageEl.disabled) {
      const want = Number(stageEl.dataset.stage);
      /* On a cleared chapter the saved answers belong to a finished run, so stepping
         back into the Trial starts a fresh attempt rather than dropping you on the
         last question with everything already answered. */
      if (want === 2 && isCleared(route.sea, route.n) && p.answers.length) {
        p.qi = 0; p.answers = [];
      }
      p.stage = want;
      celebrateFor = null;
      save(); render();
      return;
    }

    const pickEl = t.closest('[data-pick]');
    if (pickEl && !pickEl.disabled) {
      const qi = Math.min(p.qi, ch.quiz.length - 1);
      if (p.answers[qi] === undefined || p.answers[qi] === null) {
        p.answers[qi] = Number(pickEl.dataset.pick);
        markStudiedToday();
        save(); render();
      }
      return;
    }

    if (t.closest('[data-next]')) {
      if (p.stage === 2) {
        if (p.qi < ch.quiz.length - 1) p.qi++;
        else { p.stage = 3; clearChapter(sub, ch, p); }
      } else {
        p.stage = Math.min(p.stage + 1, 3);
        markStudiedToday();
      }
      save(); render();
      window.scrollTo(0, 0);
      return;
    }

    if (t.closest('[data-retry]')) {
      p.stage = 2; p.qi = 0; p.answers = [];
      celebrateFor = null;
      save(); render();
      return;
    }

    if (t.closest('[data-redo]')) {
      p.stage = 0; p.qi = 0; p.answers = [];    // re-read from the top, clean trial waiting
      celebrateFor = null;
      save(); render();
      window.scrollTo(0, 0);
      toast('SAILING CHAPTER ' + route.n + ' AGAIN');
      return;
    }
  });

  document.addEventListener('keydown', e => {
    if (route.name !== 'counsel' || !cardSession || !cardSession.queue.length || !EMAIL) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      cardSession.flipped = !cardSession.flipped;
      cardSession.turn = true;
      render();
    } else if (cardSession.flipped && ['1', '2', '3'].indexOf(e.key) !== -1) {
      e.preventDefault();
      rateCard({ '1': 'again', '2': 'hard', '3': 'easy' }[e.key]);
    }
  });

  window.addEventListener('hashchange', () => {
    route = parseHash();
    if (route.name !== 'counsel') cardSession = null;
    if (route.name !== 'crew') crewRoster = null;   // refetch the roster on each visit
    if (route.name !== 'chapter') celebrateFor = null;
    render();
    hydrate();
    window.scrollTo(0, 0);
  });

  /* ---------------- boot ---------------- */

  loadLocal();
  loadMusicPref();
  armMusic();
  route = parseHash();
  render();
  hydrate();
  if (EMAIL) {
    refreshFromCloud().then(adopted => {
      if (adopted) { chapterCache.clear(); cardSession = null; render(); hydrate(); toast('PROGRESS RESTORED FROM THE CLOUD'); }
      else renderChrome();
    });
  }
})();
