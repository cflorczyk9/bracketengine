/* ──────────────────────────────────────────────────────────────────────────
   Bracket Engine — March Madness 2026
   Single-file engine. Loads team data from data/teams.json on boot so updating
   ratings/injuries doesn't touch this script.
   ────────────────────────────────────────────────────────────────────────── */

// ── MODEL CONFIG ─────────────────────────────────────────────────────────────
// All tunable parameters live here. The old hardcoded values were scattered
// across wp(), modelPick(), and the display formatters.
const MODEL_CONFIG = {
  LOG5_SCALE: 12,        // Denominator in log5: P = 1/(1+10^(-diff/SCALE)).
                         // 12 maps a 10pt rating gap to ~80% win probability.
  BLEND_KP: 0.5,         // Weight on KenPom AdjEM in the blended rating.
  BLEND_TV: 0.5,         // Weight on Torvik T-Rank in the blended rating.
  DISPLAY_CAP: 99.9,     // Never show >99.9% — even chalk has tail risk.
};

// ── TURSO CONFIG ─────────────────────────────────────────────────────────────
// WARNING: this token is shipped to the browser. The deployed URL+token can
// READ and WRITE to the simulations table. Rotate when convenient and move the
// COUNT/INSERT behind a small edge function (Cloudflare Worker, Vercel
// function, etc.) that owns the secret and only exposes the two endpoints the
// page actually needs. Until then, treat the table as effectively public.
const TURSO_URL = 'https://bracketengine-cflorczyk9.aws-us-east-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzUxNDE2ODQsInAiOnsicm9hIjp7Im5zIjpbIjAxOWQ0ZWIwLTY1MDEtN2YyYS04N2JhLWVmMjQ4ZmI1MmI4OSJdfSwicnciOnsibnMiOlsiMDE5ZDRlYjAtNjUwMS03ZjJhLTg3YmEtZWYyNDhmYjUyYjg5Il19fSwicmlkIjoiMjBlNTMwNDktNTY0MS00NTVjLTg5YjEtZWYwNjMyNDJlODc2In0.A0KkCKTkNrSdbFiT4dkHnNzxGNgDRBQ5n2bkYpwg7_9DdZHdhkBgBj09834lXZNn6IMYNcCJqvD2SI1uXi99CQ';

// ── SEEDED PRNG ──────────────────────────────────────────────────────────────
// mulberry32 — small, fast, good enough for shareable bracket runs.
// Seed is encoded in location.hash as #seed=<uint32>. Clicking the seed chip
// rolls a new seed and re-renders.
let _seed = readOrCreateSeed();
let _rng = mulberry32(_seed);

function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readOrCreateSeed() {
  const m = /seed=(\d+)/.exec(location.hash || '');
  if (m) return parseInt(m[1], 10) >>> 0;
  const fresh = (Math.random() * 0xFFFFFFFF) >>> 0;
  history.replaceState(null, '', '#seed=' + fresh);
  return fresh;
}

function rerollSeed() {
  _seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  history.replaceState(null, '', '#seed=' + _seed);
  _rng = mulberry32(_seed);
  updateSeedChip();
}

function updateSeedChip() {
  const el = document.getElementById('seedVal');
  if (el) el.textContent = String(_seed);
}

// ── DATA (filled in once data/teams.json loads) ──────────────────────────────
let REGIONS = {};
let MODEL = {};
let TORVIK = {};
let INJURY_DATA = [];
let BRACKET_CONFIG = {};

function buildDataFromJson(data) {
  REGIONS = {};
  MODEL = {};
  TORVIK = {};
  INJURY_DATA = [];
  BRACKET_CONFIG = data.bracket;

  for (const [regionName, teams] of Object.entries(data.regions)) {
    if (teams.length !== 16) {
      console.warn(`Region ${regionName} has ${teams.length} teams, expected 16`);
    }
    // Pair up consecutive teams (1v16, 8v9, ...) into first-round matchups.
    const matchups = [];
    for (let i = 0; i < teams.length; i += 2) {
      const a = teams[i], b = teams[i + 1];
      matchups.push([a.seed, a.name, b.seed, b.name]);
    }
    REGIONS[regionName] = matchups;

    for (const t of teams) {
      if (MODEL[t.name]) {
        console.warn(`Duplicate team name across regions: ${t.name}`);
      }
      MODEL[t.name] = { em: t.kp, ii: t.injury_delta || 0 };
      TORVIK[t.name] = t.torvik;
      if (t.injury_delta && t.injury_delta < 0) {
        INJURY_DATA.push({ team: t.name, delta: t.injury_delta, detail: t.injury_note || '' });
      }
    }
  }
  // Sort injuries most-severe first, mirroring the original hardcoded order.
  INJURY_DATA.sort((a, b) => a.delta - b.delta);
}

// ── BRACKET STATE ────────────────────────────────────────────────────────────
const SIDE_ROUNDS = 4; // 8 → 4 → 2 → 1

let regions = {};
let ff = { semi1: {t1:null,t2:null,s1:null,s2:null,w:null}, semi2: {t1:null,t2:null,s1:null,s2:null,w:null}, champ: {t1:null,t2:null,s1:null,s2:null,w:null} };
let _skipRender = false;

function initRegion(name) {
  const teams = REGIONS[name];
  const rounds = [];
  const r0 = teams.map(t => ({ s1:t[0], t1:t[1], s2:t[2], t2:t[3], w:null }));
  rounds.push(r0);
  let n = 4;
  for (let r = 1; r < SIDE_ROUNDS; r++) {
    const round = [];
    for (let i = 0; i < n; i++) round.push({ s1:null, t1:null, s2:null, t2:null, w:null });
    rounds.push(round);
    n /= 2;
  }
  return rounds;
}

function initAll() {
  regions = {};
  for (const name of Object.keys(REGIONS)) {
    regions[name] = initRegion(name);
  }
  ff = {
    semi1: {t1:null,t2:null,s1:null,s2:null,w:null},
    semi2: {t1:null,t2:null,s1:null,s2:null,w:null},
    champ: {t1:null,t2:null,s1:null,s2:null,w:null}
  };
}

// Each pick mutates state, then calls only the rebuild functions for the
// match cells that actually changed. This keeps the rest of the DOM stable so
// only the freshly-decided games animate in.
function pickRegion(rName, ri, mi, tn) {
  const rounds = regions[rName];
  const m = rounds[ri][mi];
  const name = tn === 1 ? m.t1 : m.t2;
  const seed = tn === 1 ? m.s1 : m.s2;
  if (!name) return;
  m.w = name;

  let nextNi = null;
  if (ri < SIDE_ROUNDS - 1) {
    nextNi = Math.floor(mi / 2);
    const slot = mi % 2 === 0 ? 1 : 2;
    const next = rounds[ri + 1][nextNi];
    next['t' + slot] = name;
    next['s' + slot] = seed;
    cascadeRegion(rName, ri + 1, nextNi);
  } else {
    feedToFF(rName, name, seed);
  }
  if (!_skipRender) {
    rebuildMatch(rName, ri, mi);
    if (nextNi !== null) rebuildMatch(rName, ri + 1, nextNi);
    if (window.innerWidth <= 768) renderMobile();
  }
}

function cascadeRegion(rName, ri, mi) {
  const m = regions[rName][ri][mi];
  if (m.w) {
    m.w = null;
    if (ri < SIDE_ROUNDS - 1) {
      const ni = Math.floor(mi / 2);
      const slot = mi % 2 === 0 ? 1 : 2;
      const next = regions[rName][ri + 1][ni];
      next['t' + slot] = null;
      next['s' + slot] = null;
      cascadeRegion(rName, ri + 1, ni);
      if (!_skipRender) {
        rebuildMatch(rName, ri, mi);
        rebuildMatch(rName, ri + 1, ni);
      }
    } else {
      feedToFF(rName, null, null);
      if (!_skipRender) rebuildMatch(rName, ri, mi);
    }
  }
}

function feedToFF(rName, name, seed) {
  const cfg = BRACKET_CONFIG;
  let changed = null;
  if (rName === cfg.semi1[0]) { ff.semi1.t1 = name; ff.semi1.s1 = seed; clearSemi('semi1'); changed = 'semi1'; }
  if (rName === cfg.semi1[1]) { ff.semi1.t2 = name; ff.semi1.s2 = seed; clearSemi('semi1'); changed = 'semi1'; }
  if (rName === cfg.semi2[0]) { ff.semi2.t1 = name; ff.semi2.s1 = seed; clearSemi('semi2'); changed = 'semi2'; }
  if (rName === cfg.semi2[1]) { ff.semi2.t2 = name; ff.semi2.s2 = seed; clearSemi('semi2'); changed = 'semi2'; }
  if (changed && !_skipRender) rebuildSemi(changed);
}

function clearSemi(sKey) {
  if (ff[sKey].w) {
    ff[sKey].w = null;
    const cSlot = sKey === 'semi1' ? 1 : 2;
    ff.champ['t' + cSlot] = null;
    ff.champ['s' + cSlot] = null;
    if (ff.champ.w) ff.champ.w = null;
    if (!_skipRender) rebuildChamp();
  }
}

function pickSemi(sKey, tn) {
  const s = ff[sKey];
  const name = tn === 1 ? s.t1 : s.t2;
  const seed = tn === 1 ? s.s1 : s.s2;
  if (!name) return;
  s.w = name;
  const cSlot = sKey === 'semi1' ? 1 : 2;
  ff.champ['t' + cSlot] = name;
  ff.champ['s' + cSlot] = seed;
  if (ff.champ.w) ff.champ.w = null;
  if (!_skipRender) {
    rebuildSemi(sKey);
    rebuildChamp();
    if (window.innerWidth <= 768) renderMobile();
  }
}

function pickChamp(tn) {
  const name = tn === 1 ? ff.champ.t1 : ff.champ.t2;
  if (!name) return;
  ff.champ.w = name;
  if (!_skipRender) {
    document.getElementById('shareBtn').classList.add('on');
    rebuildChamp();
    if (window.innerWidth <= 768) renderMobile();
  }
}

// ── MODEL ────────────────────────────────────────────────────────────────────
function blendedRating(team) {
  const kp = MODEL[team] ? MODEL[team].em : 0;
  const tv = TORVIK[team] || 0;
  const inj = MODEL[team] ? MODEL[team].ii : 0;
  return (kp * MODEL_CONFIG.BLEND_KP + tv * MODEL_CONFIG.BLEND_TV) + inj;
}

function wp(a, b) {
  const diff = blendedRating(a) - blendedRating(b);
  return 1 / (1 + Math.pow(10, -diff / MODEL_CONFIG.LOG5_SCALE));
}

function pct0(a, b) { const v = Math.max(wp(a, b), 1 - wp(a, b)) * 100; return Math.min(v, MODEL_CONFIG.DISPLAY_CAP).toFixed(0); }
function pct1(a, b) { const v = Math.max(wp(a, b), 1 - wp(a, b)) * 100; return Math.min(v, MODEL_CONFIG.DISPLAY_CAP).toFixed(1); }
function pctRaw(prob) { const v = Math.max(prob, 1 - prob) * 100; return Math.min(v, MODEL_CONFIG.DISPLAY_CAP).toFixed(1); }

function modelPick(t1, t2) {
  if (!t1 || !t2) return 1;
  const p = wp(t1, t2);
  // Seeded coin flip — reproducible per URL seed.
  return _rng() < p ? 1 : 2;
}

// ── Unified upset helpers ───────────────────────────────────────────────────
function collectUpsets() {
  const roundNames = ['R64', 'R32', 'S16', 'E8'];
  const fullRoundNames = ['Round of 64', 'Round of 32', 'Sweet 16', 'Elite 8'];
  const upsets = [];
  for (const rName of ['EAST', 'WEST', 'SOUTH', 'MIDWEST']) {
    regions[rName].forEach((round, ri) => {
      round.forEach(m => {
        if (m.w && m.t1 && m.t2) {
          const winSeed = m.w === m.t1 ? m.s1 : m.s2;
          const loseSeed = m.w === m.t1 ? m.s2 : m.s1;
          const loser = m.w === m.t1 ? m.t2 : m.t1;
          if (winSeed > loseSeed) {
            const prob = wp(m.w, loser);
            upsets.push({ round: roundNames[ri], roundFull: fullRoundNames[ri], region: rName, winner: m.w, winSeed, wSeed: winSeed, loser, loseSeed, lSeed: loseSeed, pct: pctRaw(prob) });
          }
        }
      });
    });
  }
  ['semi1', 'semi2'].forEach(sk => {
    const s = ff[sk];
    if (s.w && s.t1 && s.t2) {
      const winSeed = s.w === s.t1 ? s.s1 : s.s2;
      const loseSeed = s.w === s.t1 ? s.s2 : s.s1;
      const loser = s.w === s.t1 ? s.t2 : s.t1;
      if (winSeed > loseSeed) {
        const prob = wp(s.w, loser);
        upsets.push({ round: 'FF', roundFull: 'Final Four', region: '', winner: s.w, winSeed, wSeed: winSeed, loser, loseSeed, lSeed: loseSeed, pct: pctRaw(prob) });
      }
    }
  });
  if (ff.champ.w && ff.champ.t1 && ff.champ.t2) {
    const winSeed = ff.champ.w === ff.champ.t1 ? ff.champ.s1 : ff.champ.s2;
    const loseSeed = ff.champ.w === ff.champ.t1 ? ff.champ.s2 : ff.champ.s1;
    const loser = ff.champ.w === ff.champ.t1 ? ff.champ.t2 : ff.champ.t1;
    if (winSeed > loseSeed) {
      const prob = wp(ff.champ.w, loser);
      upsets.push({ round: 'CHAMP', roundFull: 'Championship', region: '', winner: ff.champ.w, winSeed, wSeed: winSeed, loser, loseSeed, lSeed: loseSeed, pct: pctRaw(prob) });
    }
  }
  return upsets;
}

// ── DOM builders ────────────────────────────────────────────────────────────
function regionClass(name) {
  return 'region-' + name.toLowerCase();
}

function makeTeam(seed, name, isW, isL, cb) {
  const d = document.createElement('div');
  d.className = 'team' + (isW ? ' winner' : '') + (isL ? ' loser' : '') + (!name ? ' empty' : '');
  const seedEl = document.createElement('span');
  seedEl.className = 'seed';
  seedEl.textContent = seed || '';
  d.appendChild(seedEl);
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = name || 'TBD';
  d.appendChild(nameEl);
  if (name && cb) d.onclick = cb;
  return d;
}

function fillMatchPair(pair, rName, ri, mi) {
  // Idempotently (re)populate a .team-pair from the current state of
  // regions[rName][ri][mi]. Used by both initial build and per-pick rebuilds.
  const m = regions[rName][ri][mi];
  pair.innerHTML = '';
  pair.appendChild(makeTeam(m.s1, m.t1, m.w === m.t1, m.w && m.w !== m.t1 && m.t1, () => pickRegion(rName, ri, mi, 1)));
  pair.appendChild(makeTeam(m.s2, m.t2, m.w === m.t2, m.w && m.w !== m.t2 && m.t2, () => pickRegion(rName, ri, mi, 2)));
  if (m.w && m.t1 && m.t2) {
    const wSeed = m.w === m.t1 ? m.s1 : m.s2;
    const lSeed = m.w === m.t1 ? m.s2 : m.s1;
    if (wSeed > lSeed) {
      const pip = document.createElement('div');
      pip.className = 'upset-pip';
      const anims = ['glitch-flicker', 'glitch-flicker-2', 'glitch-flicker-3'];
      pip.style.animationName = anims[Math.floor(_rng() * 3)];
      pip.style.animationDuration = (3 + _rng() * 5).toFixed(1) + 's';
      pip.style.animationDelay = (_rng() * 6).toFixed(1) + 's';
      pip.textContent = 'UPSET';
      pair.appendChild(pip);
    }
  }
}

function rebuildMatch(rName, ri, mi) {
  const pair = document.querySelector(
    `.team-pair[data-region="${rName}"][data-round="${ri}"][data-match="${mi}"]`
  );
  if (pair) fillMatchPair(pair, rName, ri, mi);
}

function buildRound(rName, r) {
  const rc = document.createElement('div');
  rc.className = 'round ' + regionClass(rName);
  regions[rName][r].forEach((m, mi) => {
    const wrap = document.createElement('div');
    wrap.className = 'match-wrap';
    const pair = document.createElement('div');
    pair.className = 'team-pair';
    pair.dataset.region = rName;
    pair.dataset.round = r;
    pair.dataset.match = mi;
    fillMatchPair(pair, rName, r, mi);
    wrap.appendChild(pair);
    rc.appendChild(wrap);
  });
  return rc;
}

function buildCL(n, rName) {
  const c = document.createElement('div');
  c.className = 'conn-col ' + regionClass(rName);
  for (let i = 0; i < n; i++) { const p = document.createElement('div'); p.className = 'conn-pair'; p.innerHTML = '<div class="h-top"></div><div class="h-bot"></div>'; c.appendChild(p); }
  return c;
}

function buildCR(n, rName) {
  const c = document.createElement('div');
  c.className = 'conn-col-r ' + regionClass(rName);
  for (let i = 0; i < n; i++) { const p = document.createElement('div'); p.className = 'conn-pair-r'; p.innerHTML = '<div class="h-top"></div><div class="h-bot"></div>'; c.appendChild(p); }
  return c;
}

function buildFeed() { const f = document.createElement('div'); f.className = 'feed'; f.innerHTML = '<div class="fl"></div>'; return f; }
function buildFeedGF() { const f = document.createElement('div'); f.className = 'feed-gf'; f.innerHTML = '<div class="fl"></div>'; return f; }

function renderHalf(containerId, leftRegion, rightRegion) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';

  for (let r = 0; r < SIDE_ROUNDS; r++) {
    if (r > 0) el.appendChild(buildCL(regions[leftRegion][r].length, leftRegion));
    el.appendChild(buildRound(leftRegion, r));
  }

  const gap = document.createElement('div');
  gap.className = 'bracket-gap';
  el.appendChild(gap);

  for (let r = SIDE_ROUNDS - 1; r >= 0; r--) {
    el.appendChild(buildRound(rightRegion, r));
    if (r > 0) el.appendChild(buildCR(regions[rightRegion][r].length, rightRegion));
  }
}

function renderLabels(containerId, leftName, rightName) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  const l = document.createElement('div');
  l.className = 'region-label region-label-left ' + regionClass(leftName);
  l.textContent = leftName;
  const r = document.createElement('div');
  r.className = 'region-label region-label-right ' + regionClass(rightName);
  r.textContent = rightName;
  el.appendChild(l);
  el.appendChild(r);
}

function fillSemiPair(pair, sKey) {
  const s = ff[sKey];
  pair.innerHTML = '';
  pair.appendChild(makeTeam(s.s1, s.t1, s.w === s.t1, s.w && s.w !== s.t1 && s.t1, () => pickSemi(sKey, 1)));
  pair.appendChild(makeTeam(s.s2, s.t2, s.w === s.t2, s.w && s.w !== s.t2 && s.t2, () => pickSemi(sKey, 2)));
  if (s.w && s.t1 && s.t2) {
    const wSeed = s.w === s.t1 ? s.s1 : s.s2;
    const lSeed = s.w === s.t1 ? s.s2 : s.s1;
    if (wSeed > lSeed) {
      const pip = document.createElement('div');
      pip.className = 'upset-pip';
      const anims = ['glitch-flicker', 'glitch-flicker-2', 'glitch-flicker-3'];
      pip.style.animationName = anims[Math.floor(_rng() * 3)];
      pip.style.animationDuration = (3 + _rng() * 5).toFixed(1) + 's';
      pip.style.animationDelay = (_rng() * 6).toFixed(1) + 's';
      pip.textContent = 'UPSET';
      pair.appendChild(pip);
    }
  }
}

function rebuildSemi(sKey) {
  const pair = document.querySelector(`.team-pair[data-semi="${sKey}"]`);
  if (pair) fillSemiPair(pair, sKey);
}

function buildSemiMatch(sKey) {
  const round = document.createElement('div');
  round.className = 'round ff-round';
  const wrap = document.createElement('div');
  wrap.className = 'match-wrap';
  const pair = document.createElement('div');
  pair.className = 'team-pair ff-pair';
  pair.dataset.semi = sKey;
  fillSemiPair(pair, sKey);
  wrap.appendChild(pair);
  round.appendChild(wrap);
  return round;
}

function renderFinalFour() {
  const el = document.getElementById('finalFour');
  el.innerHTML = '';

  const labelRow = document.createElement('div');
  labelRow.className = 'ff-label-row';
  const l1 = document.createElement('div'); l1.className = 'ff-label'; l1.textContent = 'Final Four';
  const l2 = document.createElement('div'); l2.className = 'ff-label'; l2.textContent = 'Championship';
  const l3 = document.createElement('div'); l3.className = 'ff-label'; l3.textContent = 'Final Four';
  labelRow.appendChild(l1); labelRow.appendChild(l2); labelRow.appendChild(l3);
  el.appendChild(labelRow);

  const row = document.createElement('div');
  row.className = 'ff-bracket-row';

  row.appendChild(buildSemiMatch('semi1'));

  const feedL = buildFeedGF(); feedL.classList.add('feed-blue');
  row.appendChild(feedL);

  const champRound = document.createElement('div');
  champRound.className = 'round ff-round';
  const champWrap = document.createElement('div');
  champWrap.className = 'match-wrap';
  const cPair = document.createElement('div');
  cPair.className = 'team-pair ff-pair champ-pair';
  cPair.dataset.champ = 'true';
  fillChampPair(cPair);
  champWrap.appendChild(cPair);
  champRound.appendChild(champWrap);
  row.appendChild(champRound);

  const feedR = buildFeedGF(); feedR.classList.add('feed-red');
  row.appendChild(feedR);

  row.appendChild(buildSemiMatch('semi2'));

  el.appendChild(row);

  const champDisplay = document.createElement('div');
  champDisplay.className = 'grand-champ-wrap';
  champDisplay.id = 'grandChampWrap';
  fillGrandChamp(champDisplay);
  el.appendChild(champDisplay);
}

function fillChampPair(pair) {
  const c = ff.champ;
  pair.innerHTML = '';
  const ct1 = makeTeam(c.s1, c.t1, c.w === c.t1, c.w && c.w !== c.t1 && c.t1, () => pickChamp(1));
  ct1.classList.add('champ-t1');
  pair.appendChild(ct1);
  const ct2 = makeTeam(c.s2, c.t2, c.w === c.t2, c.w && c.w !== c.t2 && c.t2, () => pickChamp(2));
  ct2.classList.add('champ-t2');
  pair.appendChild(ct2);
  if (c.w && c.t1 && c.t2) {
    const wS = c.w === c.t1 ? c.s1 : c.s2;
    const lS = c.w === c.t1 ? c.s2 : c.s1;
    if (wS > lS) {
      const pip = document.createElement('div');
      pip.className = 'upset-pip';
      const anims = ['glitch-flicker', 'glitch-flicker-2', 'glitch-flicker-3'];
      pip.style.animationName = anims[Math.floor(_rng() * 3)];
      pip.style.animationDuration = (3 + _rng() * 5).toFixed(1) + 's';
      pip.style.animationDelay = (_rng() * 6).toFixed(1) + 's';
      pip.textContent = 'UPSET';
      pair.appendChild(pip);
    }
  }
}

function fillGrandChamp(wrap) {
  const c = ff.champ;
  wrap.innerHTML = '';
  const gcLabel = document.createElement('div');
  gcLabel.className = 'grand-champ-label';
  gcLabel.textContent = 'Champion';
  if (c.w && c.w === c.t1) gcLabel.style.color = '#00eeff';
  if (c.w && c.w === c.t2) gcLabel.style.color = '#ff2255';
  wrap.appendChild(gcLabel);
  const gcBox = document.createElement('div');
  const champColor = c.w ? (c.w === c.t1 ? 'champ-blue' : 'champ-red') : '';
  gcBox.className = 'grand-champ-box ' + (c.w ? 'has ' + champColor : 'none');
  gcBox.textContent = c.w || 'TBD';
  wrap.appendChild(gcBox);
}

function rebuildChamp() {
  const pair = document.querySelector('.team-pair.champ-pair');
  if (pair) fillChampPair(pair);
  const wrap = document.getElementById('grandChampWrap');
  if (wrap) fillGrandChamp(wrap);
}

function renderAll() {
  const cfg = BRACKET_CONFIG;
  renderLabels('top-labels', cfg.topLeft, cfg.topRight);
  renderHalf('topRow', cfg.topLeft, cfg.topRight);
  renderFinalFour();
  renderLabels('bot-labels', cfg.bottomLeft, cfg.bottomRight);
  renderHalf('botRow', cfg.bottomLeft, cfg.bottomRight);
  renderMobile();
}

function renderMobile() {
  if (window.innerWidth > 768) return;
  const el = document.getElementById('mobileBracket');
  if (!el) return;

  const roundNames = ['Round of 64', 'Round of 32', 'Sweet 16', 'Elite 8'];
  const regionOrder = ['EAST', 'WEST', 'SOUTH', 'MIDWEST'];
  let html = '';

  for (let ri = 0; ri < 4; ri++) {
    html += `<div class="mb-round"><div class="mb-round-header">${roundNames[ri]}</div>`;
    for (const rName of regionOrder) {
      const round = regions[rName][ri];
      const hasGames = round.some(m => m.t1 || m.t2);
      if (!hasGames && ri > 0) continue;

      html += `<div class="mb-region-label ${regionClass(rName)}">${rName}</div>`;

      round.forEach((m, mi) => {
        const probText = (m.t1 && m.t2 && MODEL[m.t1] && MODEL[m.t2]) ?
          pct0(m.t1, m.t2) + '%' : '';

        const t1w = m.w === m.t1;
        const t2w = m.w === m.t2;
        const t1l = m.w && !t1w && m.t1;
        const t2l = m.w && !t2w && m.t2;

        html += `<div class="mb-game ${regionClass(rName)}">`;
        if (m.w && m.t1 && m.t2) {
          const wS = m.w === m.t1 ? m.s1 : m.s2;
          const lS = m.w === m.t1 ? m.s2 : m.s1;
          if (wS > lS) html += `<div class="mb-upset-pip">UPSET</div>`;
        }
        html += mbTeamRow(m.s1, m.t1, t1w, t1l, rName, ri, mi, 1, t1w ? probText : '');
        html += mbTeamRow(m.s2, m.t2, t2w, t2l, rName, ri, mi, 2, t2w ? probText : '');
        html += `</div>`;
      });
    }
    html += `</div>`;
  }

  html += `<div class="mb-ff-section">`;
  html += `<div class="mb-round"><div class="mb-round-header" style="color:var(--mx)">Final Four</div>`;

  ['semi1', 'semi2'].forEach((sk, si) => {
    const s = ff[sk];
    const label = si === 0 ? `${BRACKET_CONFIG.semi1[0]} vs ${BRACKET_CONFIG.semi1[1]}` : `${BRACKET_CONFIG.semi2[0]} vs ${BRACKET_CONFIG.semi2[1]}`;
    html += `<div class="mb-region-label">${label}</div>`;

    const probText = (s.t1 && s.t2 && MODEL[s.t1] && MODEL[s.t2]) ?
      pct0(s.t1, s.t2) + '%' : '';

    const t1w = s.w === s.t1;
    const t2w = s.w === s.t2;

    html += `<div class="mb-game">`;
    if (s.w && s.t1 && s.t2) {
      const wS = s.w === s.t1 ? s.s1 : s.s2;
      const lS = s.w === s.t1 ? s.s2 : s.s1;
      if (wS > lS) html += `<div class="mb-upset-pip">UPSET</div>`;
    }
    html += `<div class="mb-team${t1w ? ' mb-winner' : ''}${s.w && !t1w && s.t1 ? ' mb-loser' : ''}${!s.t1 ? ' mb-empty' : ''}" onclick="pickSemi('${sk}',1)">`;
    html += `<span class="mb-seed">${s.s1 || ''}</span><span class="mb-name">${s.t1 || 'TBD'}</span>`;
    html += t1w ? `<span class="mb-prob">${probText}</span>` : '';
    html += `</div>`;
    html += `<div class="mb-team${t2w ? ' mb-winner' : ''}${s.w && !t2w && s.t2 ? ' mb-loser' : ''}${!s.t2 ? ' mb-empty' : ''}" onclick="pickSemi('${sk}',2)">`;
    html += `<span class="mb-seed">${s.s2 || ''}</span><span class="mb-name">${s.t2 || 'TBD'}</span>`;
    html += t2w ? `<span class="mb-prob">${probText}</span>` : '';
    html += `</div></div>`;
  });

  html += `<div class="mb-region-label">CHAMPIONSHIP</div>`;
  const c = ff.champ;
  const cProb = (c.t1 && c.t2 && MODEL[c.t1] && MODEL[c.t2]) ?
    pct0(c.t1, c.t2) + '%' : '';
  const ct1w = c.w === c.t1;
  const ct2w = c.w === c.t2;

  html += `<div class="mb-game">`;
  if (c.w && c.t1 && c.t2) {
    const wS = c.w === c.t1 ? c.s1 : c.s2;
    const lS = c.w === c.t1 ? c.s2 : c.s1;
    if (wS > lS) html += `<div class="mb-upset-pip">UPSET</div>`;
  }
  html += `<div class="mb-team${ct1w ? ' mb-winner' : ''}${c.w && !ct1w && c.t1 ? ' mb-loser' : ''}${!c.t1 ? ' mb-empty' : ''}" onclick="pickChamp(1)">`;
  html += `<span class="mb-seed">${c.s1 || ''}</span><span class="mb-name">${c.t1 || 'TBD'}</span>`;
  html += ct1w ? `<span class="mb-prob">${cProb}</span>` : '';
  html += `</div>`;
  html += `<div class="mb-team${ct2w ? ' mb-winner' : ''}${c.w && !ct2w && c.t2 ? ' mb-loser' : ''}${!c.t2 ? ' mb-empty' : ''}" onclick="pickChamp(2)">`;
  html += `<span class="mb-seed">${c.s2 || ''}</span><span class="mb-name">${c.t2 || 'TBD'}</span>`;
  html += ct2w ? `<span class="mb-prob">${cProb}</span>` : '';
  html += `</div></div>`;

  html += `<div class="mb-champ-box ${c.w ? 'has' : 'none'}">`;
  if (c.w) {
    html += `<div class="mb-champ-trophy">★</div>`;
    html += `<div class="mb-champ-label">Champion</div>`;
    html += `<div class="mb-champ-name">${c.w}</div>`;
  } else {
    html += `<div class="mb-champ-label">Champion</div>`;
    html += `<div class="mb-champ-name tbd">TBD</div>`;
  }
  html += `</div>`;

  html += `</div></div>`;

  el.innerHTML = html;
}

function mbTeamRow(seed, name, isW, isL, rName, ri, mi, tn, probText) {
  const cls = `mb-team${isW ? ' mb-winner' : ''}${isL ? ' mb-loser' : ''}${!name ? ' mb-empty' : ''}`;
  return `<div class="${cls}" onclick="pickRegion('${rName}',${ri},${mi},${tn})">` +
    `<span class="mb-seed">${seed || ''}</span>` +
    `<span class="mb-name">${name || 'TBD'}</span>` +
    (probText ? `<span class="mb-prob">${probText}</span>` : '') +
    `</div>`;
}

function resetAll() {
  initAll();
  renderAll();
  const bd = document.getElementById('breakdownSection');
  if (bd) bd.style.display = 'none';
  const sc = document.getElementById('simCount');
  if (sc) sc.textContent = '';
  const ub = document.getElementById('upsetBadge');
  if (ub) ub.classList.remove('on');
  const sb = document.getElementById('shareBtn');
  if (sb) sb.classList.remove('on');
}

// ── COUNTDOWN ───────────────────────────────────────────────────────────────
(function(){
  const TIP = new Date('2026-03-17T22:40:00Z');
  function pad(n){return String(n).padStart(2,'0')}
  function tick(){
    const d = TIP - new Date();
    if(d<=0){
      const bar = document.getElementById('cdBar');
      if (bar) bar.style.display='none';
      return;
    }
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('cdD', pad(Math.floor(d/864e5)));
    setText('cdH', pad(Math.floor(d%864e5/36e5)));
    setText('cdM', pad(Math.floor(d%36e5/6e4)));
    const s=Math.floor(d%6e4/1e3);
    const el=document.getElementById('cdS');
    if (el) {
      el.textContent=pad(s);
      el.style.color=s%2?'var(--mx)':'#fff';
    }
  }
  tick(); setInterval(tick,1000);
})();

// ── Probability tier helper ──────────────────────────────────────────────────
function probTier(pct) {
  if (pct >= 65) return 'tier-strong';
  if (pct >= 55) return 'tier-mid';
  return 'tier-weak';
}

function toggleProbRound(label) {
  label.classList.toggle('open');
  const body = label.nextElementSibling;
  if (body) body.classList.toggle('open');
}

function toggleBdCard(title) {
  title.classList.toggle('open');
  const body = title.nextElementSibling;
  if (body) body.classList.toggle('open');
}

function toggleGridCards() {
  const titles = document.querySelectorAll('.bd-grid .bd-card-title');
  const bodies = document.querySelectorAll('.bd-grid .bd-card-body');
  const isOpen = titles[0] && titles[0].classList.contains('open');
  titles.forEach(t => isOpen ? t.classList.remove('open') : t.classList.add('open'));
  bodies.forEach(b => isOpen ? b.classList.remove('open') : b.classList.add('open'));
}

function renderBreakdown() {
  // Injuries
  const injEl = document.getElementById('injuryTable');
  injEl.innerHTML = INJURY_DATA.map(i =>
    `<div class="inj-row">
      <span class="inj-team">${i.team}</span>
      <span class="inj-delta">${i.delta} pts</span>
      <span class="inj-detail">${i.detail}</span>
    </div>`
  ).join('');

  const upsets = collectUpsets();
  const roundLabels = ['R64', 'R32', 'S16', 'E8'];

  const upEl = document.getElementById('upsetTable');
  if (upsets.length === 0) {
    upEl.innerHTML = '<div style="font-size:0.6rem;color:rgba(255,255,255,0.25);padding:8px 0">No upsets predicted (chalk bracket)</div>';
  } else {
    upEl.innerHTML = upsets.map(u =>
      `<div class="upset-row">
        <span class="upset-round">${u.round}</span>
        <span class="upset-winner">(${u.winSeed}) ${u.winner}</span>
        <span class="upset-over">over</span>
        <span class="upset-loser">(${u.loseSeed}) ${u.loser}</span>
        <span class="upset-prob">${u.pct}%</span>
      </div>`
    ).join('');
  }

  const probEl = document.getElementById('probTable');
  let probHTML = '';

  for (let ri = 0; ri < 4; ri++) {
    probHTML += `<div class="prob-round-label" onclick="toggleProbRound(this)"><span>${roundLabels[ri]}</span><span class="prob-chevron">▶</span></div>`;
    probHTML += `<div class="prob-round-body">`;
    for (const rName of ['EAST', 'WEST', 'SOUTH', 'MIDWEST']) {
      const round = regions[rName][ri];
      round.forEach(m => {
        if (m.w && m.t1 && m.t2) {
          const prob = wp(m.w, m.w === m.t1 ? m.t2 : m.t1);
          const pct = pctRaw(prob);
          const loser = m.w === m.t1 ? m.t2 : m.t1;
          const tier = probTier(parseFloat(pct));
          probHTML += `<div class="prob-row ${tier} ${regionClass(rName)}">
            <span class="prob-region">${rName}</span>
            <span class="prob-matchup"><strong>${m.w}</strong> vs ${loser}</span>
            <span class="prob-pct">${pct}%</span>
            <span class="prob-bar-wrap"><span class="prob-bar-fill" style="width:${pct}%"></span></span>
          </div>`;
        }
      });
    }
    probHTML += `</div>`;
  }

  probHTML += `<div class="prob-round-label" onclick="toggleProbRound(this)"><span>Final Four</span><span class="prob-chevron">▶</span></div>`;
  probHTML += `<div class="prob-round-body">`;
  ['semi1', 'semi2'].forEach(sk => {
    const s = ff[sk];
    if (s.w && s.t1 && s.t2) {
      const prob = wp(s.w, s.w === s.t1 ? s.t2 : s.t1);
      const pct = pctRaw(prob);
      const loser = s.w === s.t1 ? s.t2 : s.t1;
      const tier = probTier(parseFloat(pct));
      probHTML += `<div class="prob-row ${tier}">
        <span class="prob-region">FF</span>
        <span class="prob-matchup"><strong>${s.w}</strong> vs ${loser}</span>
        <span class="prob-pct">${pct}%</span>
        <span class="prob-bar-wrap"><span class="prob-bar-fill" style="width:${pct}%"></span></span>
      </div>`;
    }
  });
  probHTML += `</div>`;

  const c = ff.champ;
  if (c.w && c.t1 && c.t2) {
    probHTML += `<div class="prob-round-label" onclick="toggleProbRound(this)"><span>Championship</span><span class="prob-chevron">▶</span></div>`;
    probHTML += `<div class="prob-round-body">`;
    const prob = wp(c.w, c.w === c.t1 ? c.t2 : c.t1);
    const pct = pctRaw(prob);
    const loser = c.w === c.t1 ? c.t2 : c.t1;
    probHTML += `<div class="prob-row tier-champ">
      <span class="prob-region">★</span>
      <span class="prob-matchup"><strong>${c.w}</strong> vs ${loser}</span>
      <span class="prob-pct">${pct}%</span>
      <span class="prob-bar-wrap"><span class="prob-bar-fill" style="width:${pct}%"></span></span>
    </div>`;
    probHTML += `</div>`;
  }

  probEl.innerHTML = probHTML;

  document.getElementById('breakdownSection').style.display = 'block';
}

// ── AUTO FILL ENGINE ────────────────────────────────────────────────────────
let simNum = 0;
async function runEngine(){
  const btn=document.getElementById('calcBtn');
  const bar=document.getElementById('progBar');
  const pw=document.getElementById('progWrap');
  const la=document.getElementById('logArea');
  const li=document.getElementById('logInner');

  resetAll();
  document.getElementById('breakdownSection').style.display = 'none';
  document.getElementById('upsetBadge').classList.remove('on');

  btn.classList.add('running');
  btn.querySelector('span').textContent='SIMULATING...';
  pw.classList.add('on');
  la.classList.add('on');
  li.innerHTML='';

  let elapsed=0;
  const MAX_LOG=4;

  function log(msg,cls){
    elapsed+=70;
    const ts=(elapsed/1000).toFixed(2)+'s';
    const d=document.createElement('div');
    d.className='ll';
    d.innerHTML=`<span class="ts">[${ts}]</span> <span class="${cls||''}">${msg}</span>`;
    li.appendChild(d);
    while(li.children.length>MAX_LOG)li.removeChild(li.firstChild);
  }

  function prog(p){bar.style.width=p+'%';}

  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

  log(`Initializing bracket engine (seed ${_seed})...`); prog(3); await wait(80);
  log('Loading 68-team field...'); prog(6); await wait(70);
  log('Parsing KenPom adjusted efficiency margins...'); prog(12); await wait(80);
  log('Loading Torvik T-Rank recency-weighted ratings...',''); prog(18); await wait(70);

  log(`Blending KenPom + Torvik ratings (${(MODEL_CONFIG.BLEND_KP*100)|0}/${(MODEL_CONFIG.BLEND_TV*100)|0})...`); prog(24); await wait(80);
  log('Scanning injury reports...'); prog(28); await wait(70);
  // Log the top injuries from the data, not a hardcoded list.
  const topInjuries = INJURY_DATA.slice(0, 6);
  for (const inj of topInjuries) {
    log(`${inj.team}: ${inj.delta}`, 'warn');
    prog(prog._p = (prog._p || 28) + 2);
    await wait(60);
  }
  log('Injury deltas applied to blended ratings','ok'); prog(45); await wait(70);

  log(`Log5: P(A) = 1/(1+10^(-ΔEM/${MODEL_CONFIG.LOG5_SCALE}))`,'hi'); prog(48); await wait(80);

  const regionOrder = ['EAST','WEST','SOUTH','MIDWEST'];
  let pct = 50;

  // Picks rebuild only the affected match-pair (smooth fade-in via CSS), so we
  // can clip along quickly without flicker. Pacing tuned to feel like a
  // supercomputer chewing through the bracket — fast cadence in early rounds,
  // a noticeable beat before the championship reveal.
  document.body.classList.add('engine-running');

  // R64 — 32 games, ~60ms each. Total ~2s.
  for(const rName of regionOrder){
    log(`Round of 64 — ${rName}...`); prog(pct); await wait(40);
    const r0 = regions[rName][0];
    for(let mi=0;mi<r0.length;mi++){
      const m=r0[mi];
      pickRegion(rName,0,mi,modelPick(m.t1,m.t2));
      await wait(60);
    }
    pct+=4;
    prog(pct);
  }
  log('Round of 64 complete','ok'); await wait(60);

  // R32 — 16 games, ~90ms each. ~1.5s.
  for(const rName of regionOrder){
    log(`Round of 32 — ${rName}...`); prog(pct); await wait(40);
    const r1 = regions[rName][1];
    for(let mi=0;mi<r1.length;mi++){
      const m=r1[mi];
      pickRegion(rName,1,mi,modelPick(m.t1,m.t2));
      await wait(90);
    }
    pct+=2;
    prog(pct);
  }
  log('Round of 32 complete','ok'); await wait(70);

  // Sweet 16 — 8 games, ~140ms each. ~1.1s.
  for(const rName of regionOrder){
    log(`Sweet 16 — ${rName}...`); prog(pct); await wait(50);
    const r2 = regions[rName][2];
    for(let mi=0;mi<r2.length;mi++){
      const m=r2[mi];
      pickRegion(rName,2,mi,modelPick(m.t1,m.t2));
      await wait(140);
    }
    pct+=2;
    prog(pct);
  }
  log('Sweet 16 complete','ok'); await wait(100);

  // Elite 8 — 4 games, ~240ms each. ~1s.
  for(const rName of regionOrder){
    log(`Elite 8 — ${rName} champion...`); prog(pct); await wait(70);
    const r3 = regions[rName][3];
    const m=r3[0];
    pickRegion(rName,3,0,modelPick(m.t1,m.t2));
    pct+=2;
    prog(pct);
    await wait(240);
  }
  log('Four region champions set','ok'); await wait(160);

  // Final Four — 2 games, ~450ms each.
  prog(92);
  log(`Semifinal 1: ${BRACKET_CONFIG.semi1[0]} vs ${BRACKET_CONFIG.semi1[1]}...`); await wait(150);
  const s1=ff.semi1;
  pickSemi('semi1',modelPick(s1.t1,s1.t2));
  await wait(450);

  log(`Semifinal 2: ${BRACKET_CONFIG.semi2[0]} vs ${BRACKET_CONFIG.semi2[1]}...`); prog(95); await wait(150);
  const s2=ff.semi2;
  pickSemi('semi2',modelPick(s2.t1,s2.t2));
  await wait(450);

  // Championship — clean pause showing the matchup, then the reveal.
  log('Simulating National Championship...','hi'); prog(98); await wait(700);
  const ch=ff.champ;
  pickChamp(modelPick(ch.t1,ch.t2));
  prog(100);
  await wait(300);

  document.body.classList.remove('engine-running');
  document.getElementById('shareBtn').classList.add('on');

  log(`★ Champion: ${ff.champ.w}`,`ok`); await wait(100);
  simNum++;

  const upsetCount = collectUpsets().length;

  try {
    const cs = ff.champ.w === ff.champ.t1 ? ff.champ.s1 : ff.champ.s2;
    const ru = ff.champ.w === ff.champ.t1 ? ff.champ.t2 : ff.champ.t1;
    const ruSeed = ff.champ.w === ff.champ.t1 ? ff.champ.s2 : ff.champ.s1;
    const e8 = getElite8();
    tursoQuery([{
      sql: 'INSERT INTO simulations (champion, champion_seed, runner_up, runner_up_seed, final_four, upset_count) VALUES (?, ?, ?, ?, ?, ?)',
      args: [
        { type: 'text', value: ff.champ.w },
        { type: 'integer', value: String(cs) },
        { type: 'text', value: ru },
        { type: 'integer', value: String(ruSeed) },
        { type: 'text', value: JSON.stringify(e8.map(t => t.name)) },
        { type: 'integer', value: String(upsetCount) }
      ]
    }, 'SELECT COUNT(*) as total FROM simulations']).then(data => {
      const total = parseInt(data.results[1].response.result.rows[0][0].value, 10);
      document.getElementById('globalStats').style.display = '';
      document.getElementById('statTotal').textContent = total.toLocaleString();
    }).catch(() => {});
  } catch(e) {}
  log(`Simulation #${simNum} complete — ${upsetCount} upset${upsetCount===1?'':'s'}`, 'ok'); await wait(600);
  document.getElementById('simCount').textContent = `Sim #${simNum} · seed ${_seed} — hit Simulate Again for a new bracket`;

  renderBreakdown();

  document.getElementById('upsetNum').textContent = upsetCount;
  document.querySelector('.ub-label').textContent = upsetCount === 1 ? 'upset predicted' : 'upsets predicted';
  document.getElementById('upsetBadge').classList.add('on');

  la.classList.remove('on');
  pw.classList.remove('on');
  setTimeout(()=>{li.innerHTML='';},400);

  btn.classList.remove('running');
  btn.querySelector('span').textContent='SIMULATE AGAIN';

  document.getElementById('shareBtn').classList.add('on');
}

// ── SHARE FUNCTIONS ──────────────────────────────────────────────────────────
function getUpsetCount() { return collectUpsets().length; }
function getUpsetList() { return collectUpsets(); }

function getChampSeed() {
  if (!ff.champ.w) return null;
  return ff.champ.w === ff.champ.t1 ? ff.champ.s1 : ff.champ.s2;
}

function getElite8() {
  let teams = [];
  for (const rName of ['EAST', 'WEST', 'SOUTH', 'MIDWEST']) {
    const e8 = regions[rName][3][0];
    if (e8.w) {
      const seed = e8.w === e8.t1 ? e8.s1 : e8.s2;
      teams.push({ name: e8.w, seed, region: rName });
    }
  }
  return teams;
}

const SITE_URL = 'https://bracketengine.locker';

function generateShareText() {
  if (!ff.champ.w) return '';
  const champSeed = getChampSeed();
  const e8 = getElite8();
  const upsetCount = getUpsetCount();

  let lines = [];
  lines.push(`I used Bracket Engine to simulate my March Madness bracket. Blends KenPom + Torvik ratings with injury data.`);
  lines.push('');
  lines.push(`Champion: (${champSeed}) ${ff.champ.w}`);
  lines.push(`Final Four: ${e8.map(t => `(${t.seed}) ${t.name}`).join('  /  ')}`);
  if (upsetCount > 0) {
    lines.push(`${upsetCount} upset${upsetCount === 1 ? '' : 's'} predicted`);
  }
  lines.push('');
  lines.push(`Try it: ${SITE_URL}/#seed=${_seed}`);

  return lines.join('\n');
}

function renderSharePreview() {
  const el = document.getElementById('sharePreview');
  if (!el || !ff.champ.w) return;
  const champSeed = getChampSeed();
  const e8 = getElite8();
  const upsetCount = getUpsetCount();

  let html = '';
  html += `<span class="sp-heading">Champion</span>\n`;
  html += `<span class="sp-champ">(${champSeed}) ${ff.champ.w}</span>\n\n`;
  html += `<span class="sp-heading">Final Four</span>\n`;
  for (const t of e8) {
    html += `<span class="sp-team">${t.region}: (${t.seed}) ${t.name}</span>\n`;
  }
  if (upsetCount > 0) {
    html += `\n<span class="sp-upset">${upsetCount} upset${upsetCount === 1 ? '' : 's'} predicted</span>\n`;
  }
  html += `\n<span class="sp-link">${SITE_URL}/#seed=${_seed}</span>`;
  el.innerHTML = html;
}

function openSharePanel() {
  renderSharePreview();
  document.getElementById('shareOverlay').classList.add('on');
}

function closeSharePanel(e) {
  if (e && e.target !== document.getElementById('shareOverlay')) return;
  document.getElementById('shareOverlay').classList.remove('on');
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('shareOverlay').classList.remove('on');
});

function showToast(msg) {
  const t = document.getElementById('shareToast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyBracketText() {
  const text = generateShareText();
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied to clipboard');
  }
  closeSharePanel();
}

function shareTwitter() {
  const text = generateShareText();
  const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'width=600,height=400');
  closeSharePanel();
}

function shareLinkedIn() {
  const text = generateShareText();
  const url = 'https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'width=700,height=500');
  closeSharePanel();
}

function shareEmail() {
  const text = generateShareText();
  const subject = 'My March Madness 2026 Bracket — Bracket Engine';
  const url = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text);
  window.location.href = url;
  closeSharePanel();
}

// ── EXPORT PICKS ─────────────────────────────────────────────────────────────
function exportPicks() {
  const roundNames = ['R64', 'R32', 'S16', 'E8'];
  const cfg = BRACKET_CONFIG;
  const regionOrder = [cfg.topLeft, cfg.topRight, cfg.bottomLeft, cfg.bottomRight];
  let lines = [];

  for (const rName of regionOrder) {
    regions[rName].forEach((round, ri) => {
      const winners = [];
      round.forEach(m => { if (m.w) winners.push(m.w); });
      if (winners.length) lines.push(`${rName} ${roundNames[ri]}: ${winners.join(', ')}`);
    });
  }

  const s1 = ff.semi1;
  const s2 = ff.semi2;
  const ffWinners = [];
  if (s1.w) ffWinners.push(s1.w);
  if (s2.w) ffWinners.push(s2.w);
  if (ffWinners.length) lines.push(`Final Four: ${ffWinners.join(', ')}`);
  if (ff.champ.w) lines.push(`Championship: ${ff.champ.w}`);

  const prompt = `Fill in my ESPN Tournament Challenge bracket at https://fantasy.espn.com/games/tournament-challenge-bracket-2026\n\nFor each round, click the winning team listed below. Work left to right, top to bottom within each round.\n\n${lines.join('\n')}`;

  navigator.clipboard.writeText(prompt).then(() => {
    showToast('Picks copied — paste into Claude');
    closeSharePanel();
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = prompt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Picks copied — paste into Claude');
    closeSharePanel();
  });
}

// ── TURSO ────────────────────────────────────────────────────────────────────
function tursoQuery(statements) {
  const requests = statements.map(s => ({ type: 'execute', stmt: typeof s === 'string' ? { sql: s } : s }));
  requests.push({ type: 'close' });
  return fetch(TURSO_URL + '/v2/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  }).then(r => r.json());
}

function loadStats() {
  tursoQuery(['SELECT COUNT(*) as total FROM simulations'])
    .then(data => {
      const total = parseInt(data.results[0].response.result.rows[0][0].value, 10);
      const el = document.getElementById('globalStats');
      el.style.display = '';
      document.getElementById('statTotal').textContent = total.toLocaleString();
    })
    .catch(() => {});
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
// Wait for team data before initializing — without it the bracket is empty.
async function boot() {
  try {
    const res = await fetch('data/teams.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    buildDataFromJson(data);
  } catch (err) {
    console.error('Failed to load data/teams.json — engine cannot start. Are you serving over http(s)? `file://` won\'t work.', err);
    const root = document.querySelector('.page-wrap');
    if (root) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#400;border:1px solid #f55;color:#fcc;padding:14px 18px;border-radius:6px;margin:20px;font-family:monospace;font-size:0.85rem;text-align:left;max-width:720px;';
      banner.innerHTML = `<strong>Bracket Engine — data load failed.</strong><br>${err}<br><br>Run <code>python3 -m http.server 8765</code> in this directory and open <code>http://localhost:8765/</code>.`;
      root.prepend(banner);
    }
    return;
  }

  initAll();
  updateSeedChip();
  renderAll();
  loadStats();
}

// Expose seed chip click globally (inline handler in index.html).
window.rerollSeed = rerollSeed;

boot();
