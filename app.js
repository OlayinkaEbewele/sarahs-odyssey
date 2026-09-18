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
      sched: {},          // cardId -> {due, ivl, ease, reps, last}
      cardsReviewed: 0,
      perfectTrial: false,
      relics: {},         // relic name -> ISO date found
      mocks: [],          // finished mock exams, oldest first
      openWaters: false,  // false: seas open in order. true: every sea open at once.
      lastSea: null       // where the ship sits in open waters — the sea last studied
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
          if (!S.relics) S.relics = {};
          if (!S.mocks) S.mocks = [];
          if (S.openWaters === undefined) S.openWaters = false;
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
    checkRelics();
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
  const manifestTried = new Set();

  /* content/<sea>/index.json is written by scripts/validate-content.py — one small
     file carrying every chapter's title. If it's present the region page needs no
     chapter fetches at all; if it's missing or behind, the sweep below fills the gaps. */
  async function loadManifest(subjectId) {
    if (manifestTried.has(subjectId)) return;
    manifestTried.add(subjectId);
    try {
      const res = await fetch('content/' + subjectId + '/index.json');
      if (!res.ok) return;
      const m = await res.json();
      if (!m || !Array.isArray(m.chapters)) return;
      let changed = false;
      m.chapters.forEach(c => {
        if (c && c.n && c.title && S.titles[key(subjectId, c.n)] !== c.title) {
          S.titles[key(subjectId, c.n)] = c.title;
          changed = true;
        }
      });
      if (changed) saveLocal();
    } catch (e) { /* no manifest — fall through to the sweep */ }
  }

  async function warmSubject(subjectId) {
    const sub = subjectOf(subjectId);
    if (!sub) return false;
    await loadManifest(subjectId);
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

  /* Where the ship is. On the charted course that's the first unfinished sea; in open
     waters it's wherever you last studied (falling back to the first unfinished sea). */
  function currentSubject() {
    const unfinished = SUBJECTS.filter(s => !subjectDone(s.id));
    if (!unfinished.length) return SUBJECTS[0];
    if (S.openWaters && S.lastSea) {
      const last = unfinished.find(s => s.id === S.lastSea);
      if (last) return last;
    }
    return unfinished[0];
  }

  /* Charted course (default): a sea opens once the one before it is finished.
     Open waters: every sea is open at once; only the ship's sea reads as 'current'. */
  function subjectState(subjectId) {
    if (subjectDone(subjectId)) return 'done';
    if (S.openWaters) return subjectId === currentSubject().id ? 'current' : 'open';
    const i = SUBJECTS.findIndex(s => s.id === subjectId);
    for (let j = 0; j < i; j++) if (!subjectDone(SUBJECTS[j].id)) return 'locked';
    return 'current';
  }

  const totalCleared = () => Object.keys(S.cleared).length;
  const totalChapters = () => SUBJECTS.reduce((a, s) => a + s.chapters, 0);
  const voyagePercent = () => Math.round(totalCleared() / totalChapters() * 100);

  const rankOf = lv => RANKS[Math.min(lv, RANKS.length) - 1];
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
    const seasDone = {};
    SUBJECTS.forEach(s => { seasDone[s.id] = subjectDone(s.id); });
    return {
      clearedCount: totalCleared(),
      streak: streakLength(),
      cardsReviewed: S.cardsReviewed,
      subjectsCleared: SUBJECTS.filter(s => subjectDone(s.id)).length,
      perfectTrial: S.perfectTrial,
      seasDone: seasDone,
      bestMock: (S.mocks || []).reduce((m, r) => Math.max(m, r.pct), 0)
    };
  }

  /* Relics are earned by state, not by event — so a navigator who cleared a sea before
     this existed still gets the relic. New ones are dated and announced. */
  function checkRelics() {
    if (!S.relics) S.relics = {};
    const st = badgeState();
    const found = [];
    BADGES.forEach(b => {
      if (b.test(st) && !S.relics[b.name]) { S.relics[b.name] = today(); found.push(b); }
    });
    if (found.length) {
      saveLocal();
      found.forEach((b, i) => setTimeout(() => {
        toast('RELIC FOUND — ' + b.icon + ' ' + b.name, 'levelup');
        sfx('relic');
      }, 2000 + i * 3000));
    }
    return found;
  }

  /* ---------------- flashcard deck ----------------
     Cards are derived from the quiz of every chapter already cleared, so the deck
     grows as the voyage does and needs nothing extra from the content files. */

  function deckCards() {
    const out = [];
    Object.keys(S.cleared).forEach(k => {
      const ch = chapterCache.get(k);
      if (!ch) return;
      const src = (subjectOf(ch.subject) || {}).roman + ' · CH ' + ch.chapter;
      /* Authored cards are proper recall prompts; the quiz fallback keeps the deck
         alive for chapters written before `cards` existed in the schema. */
      if (Array.isArray(ch.cards) && ch.cards.length) {
        ch.cards.forEach((c, i) => { if (c && c.front && c.back) out.push({ id: k + '-c' + i, front: c.front, back: c.back, src: src }); });
      } else {
        ch.quiz.forEach((q, i) => out.push({ id: k + '-q' + i, front: q.q, back: q.opts[q.correct], src: src }));
      }
    });
    return out;
  }

  /* ---- scheduling ----
     A light SM-2. Intervals grow with every successful review, scaled by an ease that
     drifts with how hard the card has been; a lapse sends it back to today and dents
     the ease. Over a two-month runway this is what keeps easy cards out of the way. */
  function nextSchedule(prev, kind) {
    const ease = prev && prev.ease ? prev.ease : 2.5;
    const reps = prev && prev.reps ? prev.reps : 0;
    const ivl = prev && prev.ivl ? prev.ivl : 0;
    if (kind === 'again') return { ivl: 0, ease: Math.max(1.3, ease - 0.2), reps: 0 };
    if (kind === 'hard')  return { ivl: reps === 0 ? 1 : Math.max(ivl + 1, Math.round(ivl * 1.2)), ease: Math.max(1.3, ease - 0.15), reps: reps + 1 };
    /* easy */            return { ivl: reps === 0 ? 4 : reps === 1 ? 10 : Math.round(ivl * ease), ease: Math.min(3.0, ease + 0.05), reps: reps + 1 };
  }
  const ivlLabel = d => d === 0 ? '<1 MIN' : d === 1 ? '1 DAY' : d < 30 ? d + ' DAYS' : Math.round(d / 30) + ' MO';

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
    if (p[0] === 'ithaca') return { name: p[1] === 'exam' ? 'mockexam' : p[1] === 'result' ? 'mockresult' : 'ithaca' };
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

  /* ---------------- 8-bit sound effects ----------------
     Synthesised with WebAudio so there are no files to fetch. The AudioContext is
     created lazily inside a click, which is what browsers require. Follows the
     music toggle: muted is muted. */

  let actx = null;
  function ac() {
    if (!actx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      actx = new C();
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }

  /* One square-wave note. */
  function blip(freq, at, dur, type, gain) {
    const c = ac(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, c.currentTime + at);
    g.gain.setValueAtTime(0.0001, c.currentTime + at);
    g.gain.exponentialRampToValueAtTime(gain || 0.12, c.currentTime + at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + at);
    o.stop(c.currentTime + at + dur + 0.02);
  }

  const SFX = {
    right:   () => { blip(660, 0, .07); blip(990, .07, .10); },
    wrong:   () => { blip(160, 0, .18, 'sawtooth', .10); blip(120, .12, .16, 'sawtooth', .08); },
    tick:    () => { blip(880, 0, .035, 'square', .06); },
    victory: () => { [523, 659, 784, 1047].forEach((f, i) => blip(f, i * .09, .12)); blip(1319, .4, .28); },
    fail:    () => { [392, 349, 311].forEach((f, i) => blip(f, i * .16, .18, 'triangle', .1)); },
    relic:   () => { [1047, 1319, 1568, 2093].forEach((f, i) => blip(f, i * .06, .1, 'triangle', .09)); blip(2637, .28, .3, 'triangle', .07); },
    levelup: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => blip(f, i * .08, .14)); }
  };

  function sfx(name) {
    if (!musicOn) return;
    try { SFX[name] && SFX[name](); } catch (e) { /* audio is optional */ }
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
      meta.innerHTML = '<span class="dt-only">' + (d > 0 ? 'EXAM IN ' + d + ' DAYS' : 'EXAM DAY') + '</span>' +
        '<span class="mb-only">' + (d > 0 ? d + 'D' : 'EXAM') + '</span>';
    } else if (route.name === 'ithaca' || route.name === 'mockexam' || route.name === 'mockresult') {
      brand.textContent = 'ITHACA';
      meta.innerHTML = '<span class="dt-only">LV ' + lv + ' · ' + S.xp.toLocaleString('en-US') + ' XP</span>' +
        '<span class="mb-only">LV ' + lv + '</span>';
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
      if (!S.relics) S.relics = {};
      if (!S.mocks) S.mocks = [];
      if (S.openWaters === undefined) S.openWaters = false;
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
      if (!S.relics) S.relics = {};
      if (!S.mocks) S.mocks = [];
      if (S.openWaters === undefined) S.openWaters = false;
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
      bg: m.st === 'done' ? 'var(--sea)' : m.st === 'current' ? 'var(--gold)' : m.st === 'open' ? 'var(--bronze)'
        : m.st === 'goal' ? 'var(--deep)' : 'rgba(28,57,64,.85)',
      fg: m.st === 'current' ? 'var(--ink)' : m.st === 'goal' ? 'var(--gold)' : 'var(--parch)',
      bd: m.st === 'goal' ? 'var(--gold)' : 'var(--ink)',
      glyph: m.st === 'done' ? '✓' : (m.st === 'current' || m.st === 'open') ? m.s.roman : m.st === 'goal' ? '✦' : '✖',
      labelBg: m.st === 'current' ? 'var(--gold)' : m.st === 'open' ? 'var(--bronze)' : 'rgba(28,57,64,.9)',
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

    /* Two reasons to come back today, surfaced where the eye lands first. */
    const due = dueCards().length;
    const streak = streakLength();
    const studiedToday = S.studied.indexOf(today()) !== -1;
    const nudges = [];
    if (due > 0) nudges.push('<button class="nudge" data-go="#/counsel">✦ ' + due + ' card' + (due === 1 ? '' : 's') + ' due in Athena’s Counsel</button>');
    if (streak > 0 && !studiedToday) nudges.push('<span class="nudge nudge--warn">⚑ Your ' + streak + '-day streak ends tonight</span>');
    const nudgeHTML = nudges.length ? '<div class="nudges">' + nudges.join('') + '</div>' : '';

    const nextCard = '<div class="panel panel--parch nextport">' +
      '<div class="label">NEXT PORT OF CALL</div>' +
      '<h2>' + esc(sub.title) + ' — Ch. ' + n + '</h2>' +
      '<p>' + (title
        ? esc(title) + '. Study, recap, then the trial — ' + PASS_MARK + '% to break the seal on Chapter ' + (n + 1) + '.'
        : esc(sub.name) + '. Chapter ' + n + ' has not been charted yet.') + '</p>' +
      '<button class="btn pxs pop" data-go="#/sea/' + sub.id + '/ch/' + n + '">SET SAIL ▶</button>' +
      nudgeHTML + '</div>';

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

  function sealedSea(sub) {
    const i = SUBJECTS.findIndex(x => x.id === sub.id);
    const before = i > 0 ? SUBJECTS[i - 1] : null;
    return '<div class="subhead subhead--sea">' +
      '<button class="back" data-go="#/map" aria-label="Back to map">◀</button>' +
      '<div><div class="eyebrow">SEA ' + esc(sub.roman) + ' · ' + esc(sub.port) + '</div><h1>' + esc(sub.name) + '</h1></div></div>' +
      '<div class="shell"><div class="empty"><h2>This sea is still sealed</h2>' +
      '<p>On the charted course the seas open in order' + (before ? ' — finish ' + esc(before.title) + ' first' : '') +
      '. Or switch to open waters in the Ship’s Log to sail anywhere.</p>' +
      '<div class="btnrow"><button class="btn pxs pop btn--inline btn--deep" data-go="#/map">BACK TO THE MAP</button>' +
      '<button class="btn pxs pop btn--inline" data-go="#/stats">SHIP’S LOG</button></div></div></div>';
  }

  function renderRegion(subjectId) {
    const sub = subjectOf(subjectId);
    if (!sub) return renderMap();
    if (subjectState(subjectId) === 'locked') return sealedSea(sub);

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

  /* ---- trial ordering ----
     Every attempt shuffles the options of each question; retakes also shuffle the
     question order, so a second run tests the material rather than the memory of
     "it was C, then A". The permutations live in saved state so they survive a
     reload mid-trial. Answers are stored as ORIGINAL option indices — scoring and
     the missed-question review never have to know how things were displayed. */

  const identity = n => Array.from({ length: n }, (_, i) => i);
  function shuffled(n) {
    const a = identity(n);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function beginTrial(ch, p, retake) {
    p.stage = 2; p.qi = 0; p.answers = [];
    p.qOrder = retake ? shuffled(ch.quiz.length) : identity(ch.quiz.length);
    p.oOrder = ch.quiz.map(q => shuffled(q.opts.length));
  }

  /* Original question index shown at presentation slot k. */
  const qAt = (ch, p, k) => (p.qOrder && p.qOrder.length === ch.quiz.length) ? p.qOrder[k] : k;
  /* Display order of options for original question qi. */
  const optOrder = (ch, p, qi) =>
    (p.oOrder && p.oOrder[qi] && p.oOrder[qi].length === ch.quiz[qi].opts.length) ? p.oOrder[qi] : identity(ch.quiz[qi].opts.length);

  function trialScore(ch, p) {
    const qs = ch.quiz;
    let right = 0;
    for (let k = 0; k < qs.length; k++) {
      const a = p.answers[k];
      if (a !== undefined && a !== null && a === qs[qAt(ch, p, k)].correct) right++;
    }
    return { right: right, total: qs.length, pct: Math.round(right / qs.length * 100) };
  }

  /* The questions answered wrongly on this run, in the order they were shown. */
  function missedQuestions(ch, p) {
    const out = [];
    for (let k = 0; k < ch.quiz.length; k++) {
      const qi = qAt(ch, p, k), q = ch.quiz[qi], a = p.answers[k];
      if (a === undefined || a === null || a === q.correct) continue;
      out.push({ n: k + 1, q: q.q, picked: q.opts[a], truth: q.opts[q.correct], why: q.why || null });
    }
    return out;
  }

  function renderChapter(subjectId, n) {
    const sub = subjectOf(subjectId);
    if (!sub || n < 1 || n > sub.chapters) return renderMap();
    if (subjectState(subjectId) === 'locked') return sealedSea(sub);

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

  /* Said when a trial answer is right. Chosen deterministically from the question and
     its slot so a re-render never swaps the line mid-read, but no two questions in a
     row say the same thing. */
  const AFFIRMATIONS = [
    'True course — Athena nods.',
    'The wind is with you.',
    'Straight through the strait.',
    'A steady hand on the tiller.',
    'The stars agree with you.',
    'Well charted, navigator.',
    'Poseidon has no quarrel with that.',
    'The oars pull as one.',
    'Ithaca draws a little nearer.',
    'The sirens could not shake you.',
    'Nestor himself would approve.',
    'Land ho — that is the one.',
    'You read the chart right.',
    'Not a rock scraped.',
    'The crew cheers from the deck.',
    'A clean line through the reef.'
  ];
  const affirmation = (qi, k) => AFFIRMATIONS[(qi * 7 + k * 3) % AFFIRMATIONS.length];

  function renderTrial(ch, p) {
    const qs = ch.quiz;
    const k = Math.min(p.qi, qs.length - 1);      // presentation slot
    const qi = qAt(ch, p, k);                      // original question index
    const q = qs[qi];
    const order = optOrder(ch, p, qi);             // display slot j -> original option order[j]
    const picked = p.answers[k];                   // original option index, or undefined
    const answered = picked !== undefined && picked !== null;
    const correct = answered && picked === q.correct;
    const last = k === qs.length - 1;

    const options = order.map((orig, j) => {
      let cls = '';
      if (answered) cls = orig === q.correct ? 'correct' : orig === picked ? 'wrong' : 'dim';
      return '<button class="opt ' + cls + '" data-pick="' + orig + '"' + (answered ? ' disabled' : '') + '>' +
        '<span class="k">' + 'ABCDEFGH'[j] + '</span><span class="t">' + esc(q.opts[orig]) + '</span></button>';
    }).join('');

    /* A right answer earns a different word each time; with an authored `why` the
       explanation follows. A wrong answer is corrected, then explained if it can be. */
    let explain;
    if (correct) explain = affirmation(qi, k) + (q.why ? ' ' + q.why : '');
    else explain = 'The true answer is “' + q.opts[q.correct] + '”.' + (q.why ? ' ' + q.why : '');

    const feedback = answered ? '<div class="verdictrow">' +
      '<div class="verdict px"><div class="v">' + (correct ? 'TRUE COURSE' : 'OFF COURSE') + '</div>' +
      '<div class="e">' + esc(explain) + '</div></div>' +
      '<button class="btn pxs pop" data-next="1">' + (last ? 'CLAIM VICTORY ▶' : 'NEXT TRIAL ▶') + '</button></div>' : '';

    return '<div class="prose">' +
      '<div class="trialhead"><span class="q">TRIAL · Q' + (k + 1) + '/' + qs.length + '</span>' +
      '<span class="pass">PASS ' + PASS_MARK + '%</span></div>' +
      '<div class="bar">' + bars(k + (answered ? 1 : 0), qs.length, 'on', '') + '</div>' +
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

    /* What you missed — the moment right after a trial is when a student is most
       ready to learn from it, so the review lives here rather than behind a click. */
    const missed = missedQuestions(ch, p);
    const review = missed.length ? '<div class="review">' +
      '<div class="label" style="color:var(--clay)">WHAT YOU MISSED · ' + missed.length + ' OF ' + sc.total + '</div>' +
      '<ol class="missedlist">' + missed.map(m =>
        '<li><div class="mq"><span class="mn">Q' + m.n + '</span>' + esc(m.q) + '</div>' +
        '<div class="mrow mrow--picked"><span>YOU CHOSE</span>' + esc(m.picked) + '</div>' +
        '<div class="mrow mrow--truth"><span>TRUE COURSE</span>' + esc(m.truth) + '</div>' +
        (m.why ? '<div class="mwhy">' + esc(m.why) + '</div>' : '') + '</li>').join('') +
      '</ol></div>' : '';

    return '<div class="victory' + (celebrate ? ' celebrate' : '') + '">' +
      '<div class="eyebrow">' + eyebrow + '</div>' +
      '<div class="medalwrap">' +
      (burst ? '<div class="confetti" aria-hidden="true">' + confettiHTML() + '</div>' : '') +
      '<div class="medal px tier-' + tier +
      (String(sc.pct).length > 2 ? ' medal--wide' : '') + '">' + sc.pct + '%</div></div>' +
      (sc.pct === 100 ? '<div class="medalribbon">★ PERFECT VOYAGE ★</div>' : '') +
      '<h2>' + heading + '</h2>' +
      '<div class="sub">' + esc(sub_) + '</div>' +
      tally + review + buttons + '</div>';
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
      if (lvAfter > lvBefore) setTimeout(() => { toast('LEVEL UP — LV ' + lvAfter + ' · ' + rankOf(lvAfter), 'levelup'); sfx('levelup'); }, 1300);
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

  function dueCards() {
    const t = today();
    return deckCards().filter(c => { const s = S.sched[c.id]; return !s || s.due <= t; });
  }

  function startSession() {
    const due = dueCards();
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

    const prev = S.sched[card.id];
    const rates = cs.flipped ? '<div><div class="rates">' +
      '<button class="rate again pop" data-rate="again">AGAIN</button>' +
      '<button class="rate hard pop" data-rate="hard">HARD</button>' +
      '<button class="rate easy pop" data-rate="easy">EASY</button></div>' +
      '<div class="ratehints"><div>' + ivlLabel(nextSchedule(prev, 'again').ivl) + '</div>' +
      '<div>' + ivlLabel(nextSchedule(prev, 'hard').ivl) + '</div>' +
      '<div>' + ivlLabel(nextSchedule(prev, 'easy').ivl) + '</div></div></div>' : '';

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
      '<div class="txt txt--ink">Cards come from the chapters you have cleared — authored recall prompts where the chapter has them, its trial questions otherwise. ' +
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
    const nx = nextSchedule(S.sched[id], kind);
    S.sched[id] = { due: addDays(t, nx.ivl), ivl: nx.ivl, ease: nx.ease, reps: nx.reps, last: t };
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
      '<div><div class="label label--gold" style="margin:0">' + esc(rankOf(lv)) + '</div><div class="lv">LV ' + lv + '</div></div>' +
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
    const relicsPanel = '<div class="panel panel--deep"><div class="label label--gold">RELICS · ' +
      BADGES.filter(b => b.test(bs)).length + ' OF ' + BADGES.length + '</div>' +
      '<div class="relics">' + BADGES.map(b => {
        const on = b.test(bs);
        const when = S.relics && S.relics[b.name];
        return '<div class="relic' + (on ? '' : ' off') + '" title="' + esc(b.hint + (when ? ' — found ' + when : '')) + '">' +
          '<div class="ic pxs">' + b.icon + '</div><div class="nm">' + b.name + '</div></div>';
      }).join('') + '</div></div>';

    /* The log proper — every dated event, newest first. Old saves already carry the
       dates, so this fills in retroactively. */
    const events = [];
    Object.keys(S.cleared).forEach(k => {
      const rec = S.cleared[k];
      const sid = k.slice(0, k.lastIndexOf('-')), n = Number(k.slice(k.lastIndexOf('-') + 1));
      const sub = subjectOf(sid);
      if (rec.on) events.push({ on: rec.on, kind: 'chapter', text: 'Cleared ' + (sub ? sub.roman : sid) + '·' + n +
        (S.titles[k] ? ' — ' + S.titles[k] : '') + ' at ' + rec.score + '%' });
    });
    SUBJECTS.forEach(sub => {
      if (!subjectDone(sub.id)) return;
      let last = '';
      for (let n = 1; n <= sub.chapters; n++) { const r = S.cleared[key(sub.id, n)]; if (r && r.on > last) last = r.on; }
      if (last) events.push({ on: last, kind: 'sea', text: 'Left ' + sub.title + ' behind — every chapter charted' });
    });
    Object.keys(S.relics || {}).forEach(name => {
      const b = BADGES.find(x => x.name === name);
      events.push({ on: S.relics[name], kind: 'relic', text: 'Relic found — ' + (b ? b.icon + ' ' : '') + name });
    });
    (S.mocks || []).forEach(m => events.push({ on: m.on, kind: 'mock',
      text: paperLabel(m) + ' — ' + (m.marks !== undefined ? m.marks : m.right * MOCK_MARKS_PER_QUESTION) + '/' + (m.maxMarks || m.total * MOCK_MARKS_PER_QUESTION) + ' (' + m.pct + '%)' }));
    if (S.startedOn) events.push({ on: S.startedOn, kind: 'start', text: 'Set sail from the harbour' });
    events.sort((a, b) => (b.on > a.on ? 1 : b.on < a.on ? -1 : 0));
    const fmt = niceDate;
    const logPanel = '<div class="panel panel--parch"><div class="label label--ink">THE LOG</div>' +
      (events.length ? '<ul class="loglist">' + events.slice(0, 12).map(e =>
        '<li class="log-' + e.kind + '"><span class="logdate">' + fmt(e.on) + '</span><span class="logtext">' + esc(e.text) + '</span></li>').join('') +
        '</ul>' + (events.length > 12 ? '<div class="txt txt--sm txt--ink" style="margin-top:10px">… and ' + (events.length - 12) + ' earlier entries</div>' : '')
      : '<div class="txt txt--ink">Nothing written yet. Clear a chapter and the log begins.</div>') + '</div>';

    /* Mock exam history — the trend line that matters in the last month. */
    const mocks = (S.mocks || []).slice(-6);
    const mockPanel = '<div class="panel panel--sea"><div class="label label--gold">PAST PAPERS</div>' +
      (mocks.length ? '<div class="mocklist">' + mocks.map(m => {
        const sub = subjectOf(m.sid);
        const marks = m.marks !== undefined ? m.marks : m.right * MOCK_MARKS_PER_QUESTION;
        return '<div class="mockrow"><span class="pixnum pixnum--parch">' + fmt(m.on) + '</span>' +
          '<span class="pixnum pixnum--parch" style="width:22px;text-align:center">' + esc(sub ? sub.roman : '?') + '</span>' +
          '<div class="bar" style="flex:1;height:12px;gap:2px;padding:2px">' + bars(Math.round(m.pct / 10), 10, m.pct >= PASS_MARK ? 'on' : 'mockfail', '') + '</div>' +
          '<span class="pixnum ' + (m.pct >= PASS_MARK ? 'pixnum--gold' : 'pixnum--clay') + '">' + marks + '</span></div>';
      }).join('') + '</div>'
      : '<div class="txt txt--parch">No papers sat yet. Sail to Ithaca on the map to sit one.</div>') +
      '<button class="btn pxs pop" data-go="#/ithaca" style="margin-top:14px">' + (mocks.length ? 'SIT ANOTHER' : 'SAIL TO ITHACA') + '</button></div>';

    const open = !!S.openWaters;
    const coursePanel = '<div class="panel panel--parch"><div class="label label--ink">THE COURSE</div>' +
      '<div class="seg" role="group" aria-label="Sea unlocking">' +
      '<button class="segbtn' + (open ? '' : ' on') + '" data-course="charted" aria-pressed="' + (!open) + '">CHARTED COURSE</button>' +
      '<button class="segbtn' + (open ? ' on' : '') + '" data-course="open" aria-pressed="' + open + '">OPEN WATERS</button></div>' +
      '<div class="txt txt--ink" style="margin-top:12px">' + (open
        ? 'Every sea is open at once. Study the subjects in any order; the ship sits wherever you last studied. Chapters within a sea still unlock in sequence.'
        : 'The seas open in order — each when the one before it is finished. This is the voyage as designed.') + '</div>' +
      (open ? '' : '<div class="txt txt--sm txt--ink" style="margin-top:8px">Switching to open waters keeps all progress; switching back seals any later sea you had started until you reach it.</div>') +
      '</div>';

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
      '<div class="cols cols--wide"><div class="main vstack vstack--md">' + seasPanel + mockPanel + '</div>' +
      '<div class="side">' + relicsPanel + '</div></div>' +
      '<div class="cols cols--wide"><div class="main">' + logPanel + '</div>' +
      '<div class="side">' + coursePanel + syncPanel + '</div></div></div></div>';
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
      '<div class="crewmeta">' + esc(rankOf(lv)) + ' · LV ' + lv + ' · ' + m.xp.toLocaleString('en-US') + ' XP</div>' +
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

  /* ---------------- Ithaca: the exam papers ----------------
     One paper per sea, in the real CIPM shape: 50 questions, 2 marks each, out of 100.
     A paper draws from every charted chapter of its sea — cleared or not — so you can
     sit it as soon as the sea has content, and it's reshuffled every time. Timed, no
     feedback until the end, answers changeable until you submit. The paper lives in
     saved state with a wall-clock deadline, so a reload resumes with the time left. */

  let mockTimer = null;
  const manifests = {};   // sid -> [{n, title, questions}] from content/<sid>/index.json

  async function loadManifestData(sid) {
    if (manifests[sid]) return manifests[sid];
    try {
      const res = await fetch('content/' + sid + '/index.json');
      const m = res.ok ? await res.json() : null;
      manifests[sid] = (m && Array.isArray(m.chapters)) ? m.chapters : [];
      bankManifest[sid] = (m && m.bank) ? Number(m.bank) : 0;
    } catch (e) { manifests[sid] = []; }
    return manifests[sid];
  }

  /* A sea may carry a question bank — content/<sid>/bank.json — exam questions that
     aren't tied to a chapter. It's cached as a pseudo-chapter at number 0 so papers,
     scoring and the review treat it exactly like any other source of questions. */
  const BANK = 0;
  async function loadBank(sid) {
    const k = key(sid, BANK);
    if (chapterCache.has(k)) return chapterCache.get(k);
    let data = null;
    try {
      const res = await fetch('content/' + sid + '/bank.json');
      if (res.ok) {
        const b = await res.json();
        if (b && Array.isArray(b.questions) && b.questions.length) {
          data = { subject: sid, chapter: BANK, title: 'Question bank', quiz: b.questions, source: b.source || '' };
        }
      }
    } catch (e) { data = null; }
    chapterCache.set(k, data);
    return data;
  }
  const bankManifest = {};   // sid -> question count, from index.json

  /* What the lobby knows about a sea without loading its chapters. */
  function paperInfo(sid) {
    const sub = subjectOf(sid);
    const list = manifests[sid] || [];
    let charted = list.length, questions = list.reduce((a, c) => a + (c.questions || 0), 0);
    if (!charted) {   // no manifest yet — fall back to titles seen on region visits
      for (let n = 1; n <= sub.chapters; n++) if (S.titles[key(sid, n)]) charted++;
    }
    const bank = bankManifest[sid] || 0;
    return { charted: charted, total: sub.chapters, questions: questions + bank, bank: bank, available: charted > 0 || bank > 0 };
  }

  /* Load every charted chapter of a sea, plus its bank, so the paper can draw from all of it. */
  async function warmSea(sid) {
    const sub = subjectOf(sid);
    const wanted = [];
    for (let n = 1; n <= sub.chapters; n++) if (!chapterCache.has(key(sid, n))) wanted.push(n);
    await Promise.all([mapLimit(wanted, 4, n => loadChapter(sid, n)), loadBank(sid)]);
  }

  function seaPool(sid) {
    const sub = subjectOf(sid), pool = [];
    for (let n = BANK; n <= sub.chapters; n++) {
      const ch = chapterCache.get(key(sid, n));
      if (!ch) continue;
      ch.quiz.forEach((q, qi) => pool.push({ sid: sid, n: n, qi: qi }));
    }
    return pool;
  }

  /* Stratified draw: each chapter contributes in proportion to its share of the pool. */
  function drawPaper(pool, want) {
    if (pool.length <= want) return shuffled(pool.length).map(i => pool[i]);
    const byCh = {};
    pool.forEach(q => { (byCh[q.n] = byCh[q.n] || []).push(q); });
    const keys = Object.keys(byCh);
    const quota = {};
    let assigned = 0;
    /* Every chapter is examinable, so each gets at least one question when the paper
       is long enough; the rest is shared out in proportion to chapter size. */
    const floor = want >= keys.length ? 1 : 0;
    keys.forEach(k => { quota[k] = floor; assigned += floor; });
    const spare = want - assigned;
    keys.forEach(k => { const extra = Math.floor(spare * byCh[k].length / pool.length); quota[k] += extra; assigned += extra; });
    keys.sort((a, b) => byCh[b].length - byCh[a].length);
    for (let i = 0; assigned < want; i = (i + 1) % keys.length) {
      if (quota[keys[i]] < byCh[keys[i]].length) { quota[keys[i]]++; assigned++; }
    }
    const paper = [];
    keys.forEach(k => shuffled(byCh[k].length).slice(0, quota[k]).forEach(i => paper.push(byCh[k][i])));
    return shuffled(paper.length).map(i => paper[i]);
  }

  async function startMock(sid) {
    await warmSea(sid);
    const pool = seaPool(sid);
    if (!pool.length) { toast('THAT SEA HAS NO CHARTED CHAPTERS YET'); return; }
    const paper = drawPaper(pool, MOCK_QUESTIONS).map(q => ({
      sid: q.sid, n: q.n, qi: q.qi,
      order: shuffled(chapterCache.get(key(q.sid, q.n)).quiz[q.qi].opts.length)
    }));
    S.mock = { sid: sid, started: today(), deadline: Date.now() + MOCK_MINUTES * 60000, qs: paper, k: 0, answers: paper.map(() => null) };
    saveLocal();
    go('#/ithaca/exam');
  }

  function mockQuestion(i) {
    const q = S.mock.qs[i];
    const ch = chapterCache.get(key(q.sid, q.n));
    return ch ? ch.quiz[q.qi] : null;
  }

  function submitMock(reason) {
    const m = S.mock;
    if (!m) return;
    clearInterval(mockTimer); mockTimer = null;
    let right = 0;
    const byChapter = {};
    const missed = [];
    m.qs.forEach((q, i) => {
      const qq = mockQuestion(i);
      if (!qq) return;
      const b = byChapter[q.n] = byChapter[q.n] || { right: 0, total: 0 };
      b.total++;
      if (m.answers[i] === qq.correct) { right++; b.right++; }
      else missed.push({ sid: q.sid, n: q.n, qi: q.qi, picked: m.answers[i] });
    });
    const total = m.qs.length;
    const rec = {
      on: today(), sid: m.sid, total: total, right: right,
      marks: right * MOCK_MARKS_PER_QUESTION, maxMarks: total * MOCK_MARKS_PER_QUESTION,
      pct: Math.round(right / total * 100),
      minutes: Math.max(1, Math.round((MOCK_MINUTES * 60000 - Math.max(0, m.deadline - Date.now())) / 60000)),
      byChapter: byChapter, missed: missed, reason: reason || 'submitted'
    };
    if (!S.mocks) S.mocks = [];
    S.mocks.push(rec);
    const lvBefore = levelOf(S.xp);
    S.xp += right * MOCK_XP_PER_CORRECT;
    delete S.mock;
    markStudiedToday();
    save();
    const lvAfter = levelOf(S.xp);
    if (lvAfter > lvBefore) setTimeout(() => { toast('LEVEL UP — LV ' + lvAfter + ' · ' + rankOf(lvAfter), 'levelup'); sfx('levelup'); }, 1300);
    sfx(rec.pct >= PASS_MARK ? 'victory' : 'fail');
    celebrateFor = 'mock';
    go('#/ithaca/result');
  }

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const niceDate = d => { const [y, m, dd] = String(d).split('-'); return dd + ' ' + MONTHS[Number(m) - 1]; };
  const mmss = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };
  const paperLabel = r => { const s = subjectOf(r.sid); return s ? 'Paper ' + s.roman : 'Paper'; };

  function tickMock() {
    const m = S.mock;
    const el = document.getElementById('mockClock');
    if (!m || !el) { clearInterval(mockTimer); mockTimer = null; return; }
    const left = m.deadline - Date.now();
    el.textContent = mmss(left);
    el.classList.toggle('late', left < 5 * 60000);
    if (left <= 0) submitMock('time');
  }

  function bestFor(sid) { return (S.mocks || []).filter(r => r.sid === sid).reduce((b, r) => Math.max(b, r.marks || 0), 0); }

  function renderIthaca() {
    const inProgress = S.mock && S.mock.deadline > Date.now();
    const resume = inProgress ? '<div class="panel panel--clay"><div class="label">A PAPER IS OPEN</div>' +
      '<div class="txt">' + esc(paperLabel(S.mock)) + ' — <b>' + mmss(S.mock.deadline - Date.now()) + '</b> left, ' +
      S.mock.answers.filter(a => a !== null).length + ' of ' + S.mock.qs.length + ' answered.</div>' +
      '<button class="btn pxs pop" data-go="#/ithaca/exam" style="margin-top:14px">RESUME ▶</button></div>' : '';

    const papers = SUBJECTS.map(sub => {
      const info = paperInfo(sub.id);
      const ready = info.available && !inProgress;
      const best = bestFor(sub.id);
      const sat = (S.mocks || []).filter(r => r.sid === sub.id).length;
      return '<div class="panel panel--parch papercard' + (info.available ? '' : ' papercard--dim') + '">' +
        '<div class="rowbetween"><div class="label" style="margin:0">PAPER ' + esc(sub.roman) + '</div>' +
        (best ? '<span class="pixnum ' + (best >= PASS_MARK * MOCK_MARKS_PER_QUESTION * MOCK_QUESTIONS / 100 ? 'pixnum--gold' : 'pixnum--clay') + '" style="color:var(--bronze)">BEST ' + best + '/' + (MOCK_QUESTIONS * MOCK_MARKS_PER_QUESTION) + '</span>' : '') + '</div>' +
        '<div class="serif" style="font-size:19px;color:var(--ink);margin-top:8px">' + esc(sub.name) + '</div>' +
        '<div class="txt txt--sm txt--ink" style="margin-top:4px">' + esc(sub.title) + ' · ' + info.charted + ' of ' + info.total + ' chapters charted' +
        (info.bank ? ' · ' + info.bank + '-question bank' : '') +
        (info.questions ? ' · ' + Math.min(MOCK_QUESTIONS, info.questions) + ' on the paper from ' + info.questions + ' in the pool' : '') +
        (sat ? ' · sat ' + sat + '×' : '') + '</div>' +
        '<button class="btn pxs pop" data-mockstart="' + sub.id + '" style="margin-top:14px"' + (ready ? '' : ' disabled') + '>' +
        (info.available ? 'SIT THE PAPER ▶' : 'NOT YET CHARTED') + '</button></div>';
    }).join('');

    const about = '<div class="panel panel--deep"><div class="label label--gold">THE PAPERS</div>' +
      '<div class="txt txt--parch">Five papers, one per sea, in the real shape: <b>' + MOCK_QUESTIONS + ' questions, ' +
      MOCK_MARKS_PER_QUESTION + ' marks each, out of ' + (MOCK_QUESTIONS * MOCK_MARKS_PER_QUESTION) + '</b>, ' + MOCK_MINUTES + ' minutes. ' +
      'Each draws from every charted chapter of its sea, cleared or not, and is reshuffled every sitting. ' +
      'Nothing is given away as you go; you can change any answer until you submit. ' + PASS_MARK + '% is a pass. ' +
      'Every paper is kept in the Ship’s Log so you can watch the line climb.</div></div>';

    return '<div class="subhead subhead--deep">' +
      '<button class="back" data-go="#/map" aria-label="Back to map">◀</button>' +
      '<div><div class="eyebrow">✦ ITHACA</div><h1>The exam itself</h1></div></div>' +
      '<div class="shell"><div class="cols"><div class="main vstack vstack--md">' + resume + papers + '</div>' +
      '<div class="side">' + about + '</div></div></div>';
  }

  function renderMockExam() {
    const m = S.mock;
    if (!m) return renderIthaca();
    if (m.deadline <= Date.now()) { setTimeout(() => submitMock('time'), 0); return renderIthaca(); }
    const i = Math.max(0, Math.min(m.k, m.qs.length - 1));
    const q = mockQuestion(i);
    if (!q) return '<div class="shell"><div class="empty"><h2>Reading the charts…</h2><p>Loading the chapters this paper draws on.</p></div></div>';
    const spec = m.qs[i];
    const sub = subjectOf(m.sid);
    const picked = m.answers[i];
    const answered = m.answers.filter(a => a !== null).length;
    const last = i === m.qs.length - 1;

    const options = spec.order.map((orig, j) =>
      '<button class="opt' + (picked === orig ? ' chosen' : '') + '" data-mockpick="' + orig + '">' +
      '<span class="k">' + 'ABCDEFGH'[j] + '</span><span class="t">' + esc(q.opts[orig]) + '</span></button>').join('');

    return '<div class="subhead subhead--deep examhead">' +
      '<div class="rowbetween">' +
      '<span class="mono" style="font-size:var(--px-sm);color:var(--gold)">✦ ' + esc(paperLabel(m).toUpperCase()) + '</span>' +
      '<span class="mockclock" id="mockClock">' + mmss(m.deadline - Date.now()) + '</span></div>' +
      '<div class="bar" style="margin-top:12px">' + bars(answered, m.qs.length, 'on', '') + '</div></div>' +
      '<div class="shell"><div class="paper exam">' +
      '<div class="trialhead"><span class="q">Q' + (i + 1) + ' OF ' + m.qs.length + ' · ' + answered + ' ANSWERED</span>' +
      '<span class="pass" style="color:var(--bronze)">' + MOCK_MARKS_PER_QUESTION + ' MARKS · ' + (spec.n === BANK ? 'BANK' : 'CH ' + spec.n) + '</span></div>' +
      '<div class="question">' + esc(q.q) + '</div>' +
      '<div class="options">' + options + '</div>' +
      '<div class="examnav">' +
      '<button class="btn pxs pop btn--inline btn--deep" data-mocknav="-1"' + (i === 0 ? ' disabled' : '') + '>◀ PREV</button>' +
      (last ? '<button class="btn pxs pop btn--inline" data-mocksubmit="1">SUBMIT THE PAPER ▶</button>'
            : '<button class="btn pxs pop btn--inline" data-mocknav="1">NEXT ▶</button>') + '</div>' +
      (last ? '' : '<button class="linkbtn" data-mocksubmit="1">Finish early and submit ' + answered + ' of ' + m.qs.length + '</button>') +
      '</div></div>';
  }

  function renderMockResult() {
    const hist = S.mocks || [];
    const r = hist[hist.length - 1];
    if (!r) return renderIthaca();
    const sub = subjectOf(r.sid);
    const passed = r.pct >= PASS_MARK;
    const tier = !passed ? 'fail' : r.pct >= 85 ? 'gold' : 'bronze';
    const celebrate = celebrateFor === 'mock';
    const prevBest = hist.slice(0, -1).filter(x => x.sid === r.sid).reduce((b, x) => Math.max(b, x.marks || 0), 0);
    const newBest = prevBest > 0 && r.marks > prevBest;
    const marks = r.marks !== undefined ? r.marks : r.right * MOCK_MARKS_PER_QUESTION;
    const maxMarks = r.maxMarks || r.total * MOCK_MARKS_PER_QUESTION;

    /* Which chapters let you down — the useful part of a per-subject paper. */
    const chapters = Object.keys(r.byChapter || {}).map(Number).sort((a, b) => a - b);
    const breakdown = chapters.length ? '<div class="panel panel--parch" style="text-align:left;max-width:720px;margin:0 auto 18px">' +
      '<div class="label label--ink">BY CHAPTER</div><div class="vstack vstack--sm">' +
      chapters.map(n => {
        const b = r.byChapter[n], pct = Math.round(b.right / b.total * 100);
        const label = n === BANK ? 'Question bank' : 'Ch ' + n + (S.titles[key(r.sid, n)] ? ' — ' + esc(S.titles[key(r.sid, n)]) : '');
        return '<div><div class="seasrow"><span class="nm" style="font-size:var(--t-sm)">' + label + '</span>' +
          '<span class="pc">' + b.right + '/' + b.total + '</span></div>' +
          '<div class="bar" style="height:11px;gap:2px;padding:2px">' + bars(Math.round(pct / 10), 10, pct >= PASS_MARK ? 'on' : 'mockfail', 'off') + '</div></div>';
      }).join('') + '</div></div>' : '';

    const missed = (r.missed || []).map(x => {
      const ch = chapterCache.get(key(x.sid, x.n));
      const q = ch && ch.quiz[x.qi];
      if (!q) return null;
      return { n: x.n === BANK ? 'BANK' : 'CH ' + x.n, q: q.q, picked: x.picked === null || x.picked === undefined ? '— (unanswered)' : q.opts[x.picked], truth: q.opts[q.correct], why: q.why || null };
    }).filter(Boolean);
    const review = missed.length ? '<div class="review">' +
      '<div class="label" style="color:var(--clay)">WHAT YOU MISSED · ' + missed.length + ' OF ' + r.total + '</div>' +
      '<ol class="missedlist">' + missed.map(mm =>
        '<li><div class="mq"><span class="mn">' + esc(mm.n) + '</span>' + esc(mm.q) + '</div>' +
        '<div class="mrow mrow--picked"><span>YOU CHOSE</span>' + esc(mm.picked) + '</div>' +
        '<div class="mrow mrow--truth"><span>TRUE COURSE</span>' + esc(mm.truth) + '</div>' +
        (mm.why ? '<div class="mwhy">' + esc(mm.why) + '</div>' : '') + '</li>').join('') + '</ol></div>' : '';

    return '<div class="subhead subhead--deep">' +
      '<button class="back" data-go="#/ithaca" aria-label="Back to Ithaca">◀</button>' +
      '<div><div class="eyebrow">✦ ' + esc(paperLabel(r).toUpperCase()) + '</div><h1>' + esc(sub ? sub.name : 'Paper') + ' — ' + niceDate(r.on) + '</h1></div></div>' +
      '<div class="shell"><div class="paper"><div class="victory' + (celebrate ? ' celebrate' : '') + '">' +
      '<div class="eyebrow">' + (newBest ? 'A NEW BEST' : passed ? 'A PASSING PAPER' : 'THE PAPER HOLDS') + '</div>' +
      '<div class="medalwrap">' + (celebrate && passed ? '<div class="confetti" aria-hidden="true">' + confettiHTML() + '</div>' : '') +
      '<div class="medal px tier-' + tier + ' medal--marks">' + marks + '<span class="medalof">/' + maxMarks + '</span></div></div>' +
      '<h2>' + (passed ? 'You would have passed' : 'Not yet — but now you know where') + '</h2>' +
      '<div class="sub">' + r.right + ' of ' + r.total + ' answered true (' + r.pct + '%) in ' + r.minutes + ' minute' + (r.minutes === 1 ? '' : 's') +
      (r.reason === 'time' ? ' — time ran out.' : '.') + (r.right ? ' +' + (r.right * MOCK_XP_PER_CORRECT) + ' XP.' : '') + '</div>' +
      breakdown + review +
      '<div class="btnrow"><button class="btn pxs pop btn--inline btn--deep" data-go="#/map">BACK TO THE MAP</button>' +
      '<button class="btn pxs pop btn--inline" data-go="#/ithaca">SIT ANOTHER ▶</button></div>' +
      '</div></div></div>';
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
    if (route.name === 'mockexam') return 'mockexam/' + (S.mock ? S.mock.k : 'none');
    if (route.name === 'ithaca') return 'ithaca/' + SUBJECTS.filter(x => manifests[x.id]).length;
    if (route.name === 'mockresult') {
      const h = S.mocks || [], rec = h[h.length - 1];
      let cached = 0;
      if (rec) { const sub = subjectOf(rec.sid); for (let n = 1; sub && n <= sub.chapters; n++) if (chapterCache.has(key(rec.sid, n))) cached++; }
      return 'mockresult/' + h.length + '/' + cached;
    }
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
    else if (route.name === 'ithaca') html = renderIthaca();
    else if (route.name === 'mockexam') html = renderMockExam();
    else if (route.name === 'mockresult') html = renderMockResult();
    else html = renderCrew();
    view(html);
    renderChrome();
    if (route.name === 'mockexam' && S.mock) { if (!mockTimer) mockTimer = setInterval(tickMock, 1000); }
    else if (mockTimer) { clearInterval(mockTimer); mockTimer = null; }

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
        if (subjectOf(r.sea) && subjectState(r.sea) === 'locked') return;
        if (subjectOf(r.sea) && S.lastSea !== r.sea) { S.lastSea = r.sea; saveLocal(); }
        if (chapterStatus(r.sea, r.n) !== 'locked') await loadChapter(r.sea, r.n);
      } else if (r.name === 'region') {
        if (subjectState(r.sea) !== 'locked') await warmSubject(r.sea);
      } else if (r.name === 'map') {
        const sub = currentSubject();
        await Promise.all([loadChapter(sub.id, firstOpenChapter(sub.id)), warmDeck()]);
      } else if (r.name === 'counsel') {
        await warmDeck();
        startSession();
      } else if (r.name === 'crew') {
        await loadCrew();
      } else if (r.name === 'ithaca') {
        await Promise.all(SUBJECTS.map(sub => loadManifestData(sub.id)));
      } else if (r.name === 'mockexam' || r.name === 'mockresult') {
        const rec = r.name === 'mockexam' ? S.mock : (S.mocks || [])[(S.mocks || []).length - 1];
        if (rec && rec.sid) await warmSea(rec.sid);
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

    const courseEl = t.closest('[data-course]');
    if (courseEl) {
      const want = courseEl.dataset.course === 'open';
      if (want !== !!S.openWaters) {
        S.openWaters = want;
        save();
        sfx('tick');
        toast(want ? 'OPEN WATERS — EVERY SEA IS YOURS' : 'CHARTED COURSE — THE SEAS OPEN IN ORDER');
        render();
      }
      return;
    }

    if (t.closest('[data-crewretry]')) { crewRoster = null; render(); hydrate(); return; }

    const ms = t.closest('[data-mockstart]');
    if (ms && !ms.disabled) { sfx('tick'); ms.disabled = true; ms.textContent = 'READING THE CHARTS…'; startMock(ms.dataset.mockstart).then(() => { if (route.name === 'ithaca') render(); }); return; }
    const mp = t.closest('[data-mockpick]');
    if (mp && S.mock) { S.mock.answers[S.mock.k] = Number(mp.dataset.mockpick); sfx('tick'); saveLocal(); render(); return; }
    const mn = t.closest('[data-mocknav]');
    if (mn && !mn.disabled && S.mock) { S.mock.k = Math.max(0, Math.min(S.mock.qs.length - 1, S.mock.k + Number(mn.dataset.mocknav))); saveLocal(); render(); window.scrollTo(0, 0); return; }
    const msub = t.closest('[data-mocksubmit]');
    if (msub && S.mock) {
      const left = S.mock.answers.filter(a => a === null).length;
      if (left && !msub.dataset.armed) { msub.dataset.armed = '1'; msub.textContent = left + ' UNANSWERED — TAP AGAIN TO SUBMIT'; setTimeout(() => { if (msub.isConnected) { delete msub.dataset.armed; render(); } }, 4000); return; }
      submitMock('submitted'); return;
    }

    const seaEl = t.closest('[data-sea]:not([data-ch])');
    if (seaEl) {
      const id = seaEl.dataset.sea;
      if (id === 'ithaca') { go('#/ithaca'); return; }
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
      if (t.closest('[data-flip]')) { if (cardSession) { cardSession.flipped = !cardSession.flipped; cardSession.turn = true; sfx('tick'); render(); } return; }
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
      if (want === 2 && p.stage === 3) {
        beginTrial(ch, p, true);                  // any run after a victory screen is a retake
      } else {
        p.stage = want;
      }
      celebrateFor = null;
      save(); render();
      return;
    }

    const pickEl = t.closest('[data-pick]');
    if (pickEl && !pickEl.disabled) {
      const k = Math.min(p.qi, ch.quiz.length - 1);
      if (p.answers[k] === undefined || p.answers[k] === null) {
        p.answers[k] = Number(pickEl.dataset.pick);   // original option index
        sfx(p.answers[k] === ch.quiz[qAt(ch, p, k)].correct ? 'right' : 'wrong');
        markStudiedToday();
        save(); render();
      }
      return;
    }

    if (t.closest('[data-next]')) {
      if (p.stage === 2) {
        if (p.qi < ch.quiz.length - 1) p.qi++;
        else { p.stage = 3; clearChapter(sub, ch, p); sfx(trialScore(ch, p).pct >= PASS_MARK ? 'victory' : 'fail'); }
      } else if (p.stage === 1) {
        beginTrial(ch, p, !!S.cleared[key(route.sea, route.n)]);
        markStudiedToday();
      } else {
        p.stage = Math.min(p.stage + 1, 3);
        markStudiedToday();
      }
      save(); render();
      window.scrollTo(0, 0);
      return;
    }

    if (t.closest('[data-retry]')) {
      beginTrial(ch, p, true);
      celebrateFor = null;
      save(); render();
      return;
    }

    if (t.closest('[data-redo]')) {
      p.stage = 0; p.qi = 0; p.answers = []; p.qOrder = null; p.oOrder = null;   // re-read; beginTrial runs at Recap
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
    if (route.name !== 'chapter' && route.name !== 'mockresult') celebrateFor = null;
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
