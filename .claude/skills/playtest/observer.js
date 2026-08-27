/* ============================================================================
   ASCII CITY — playtest observer
   ----------------------------------------------------------------------------
   Paste this whole file into the page once. It installs, in order:

     · a loop driver, ONLY if the tab is hidden and rAF is therefore dead
     · a real-keyboard input layer (dispatched KeyboardEvents, so the game's
       own bindings are exercised, not bypassed)
     · colour-aware vision — glyph, colour NAME and brightness per cell
     · a per-frame watcher that checks invariants at the game's own frame rate
     · an event recorder (net events, toasts, scene lifecycle, errors)
     · a 1 Hz state sampler riding the frame hook, never setInterval

   The split that matters: the WATCHER runs 60 times a second and misses
   nothing. CLAUDE reads __OBS.report() every minute or so and does the
   thinking. You get frame-rate reflexes without frame-rate attention.

   Everything is idempotent — running it twice is safe.
   ========================================================================== */
(() => {
const OBS = window.__OBS = window.__OBS || {
  findings: [], events: [], samples: [], seen: {}, stats: {},
  installed: false, frames: 0, err: null
};

/* ---------------------------------------------------------------- logging */
const now = () => (typeof netNow === 'function' ? netNow() : performance.now() / 1000);
/* Rate-limited: one standing condition must never bury the signal. */
function flag(code, detail, quietFor){
  const key = code + '|' + JSON.stringify(detail || {});
  const t = now();
  if (OBS.seen[key] && t - OBS.seen[key] < (quietFor === undefined ? 30 : quietFor)) return;
  OBS.seen[key] = t;
  OBS.findings.push({ t: +t.toFixed(2), code, detail });
  if (OBS.findings.length > 400) OBS.findings.shift();
}
function note(kind, data){
  OBS.events.push({ t: +now().toFixed(2), kind, data });
  if (OBS.events.length > 3000) OBS.events.shift();
}
OBS.flag = flag; OBS.note = note;

/* ============================ 1. LOOP DRIVER ==============================
   Only when the tab is hidden. A VISIBLE tab runs rAF normally and installing
   a second driver would double-step the world. Show the browser pane and this
   whole section switches itself off. */
if (!OBS.driver){
  if (!document.hidden){
    OBS.driver = 'native rAF (tab is visible)';
  } else {
    window.__pend = null;
    const realRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function(cb){
      if (cb && cb.name === 'frame'){ window.__pend = cb; return 1; }
      return realRAF(cb);
    };
    const src = "let t=null;onmessage=e=>{if(e.data==='go'){if(t)clearInterval(t);" +
                "t=setInterval(()=>postMessage(0),8);}}";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    OBS.worker = w; OBS._last = 0;
    w.onmessage = () => {
      const p = performance.now();
      if (p - OBS._last < 15) return;
      OBS._last = p;
      const cb = window.__pend; if (!cb) return; window.__pend = null;
      try { cb(p); } catch (e){ OBS.err = String(e && e.stack || e); flag('FRAME_THREW', { e: OBS.err.slice(0, 240) }, 10); }
    };
    w.postMessage('go');
    if (typeof frame === 'function') window.__pend = frame;
    OBS.driver = 'worker tick (tab hidden)';
  }
}

/* Viewport: a collapsed pane reports 0 and initRender clamps to a 45x20 grid. */
if (!OBS.viewportFixed && (!window.innerWidth || window.innerWidth < 900)){
  try {
    Object.defineProperty(window, 'innerWidth',  { configurable: true, get: () => 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 720 });
    OBS.viewportFixed = true;
  } catch (e){ OBS.viewportFixed = 'failed: ' + e; }
}
if (typeof CFG !== 'undefined'){ CFG.manualRes = true; CFG.resIdx = 6; }
if (typeof initRender === 'function') initRender();

/* ======================= 2. REAL KEYBOARD + MOUSE =========================
   Dispatched KeyboardEvents go through the game's own window listeners, so
   the key BINDINGS are under test too - not just everything downstream of
   them. Writing keys[] directly would skip that layer entirely. */
const KEYNAME = {
  Space: ' ', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', Backquote: '`'
};
const keyFor = (code) => KEYNAME[code] ||
  (code.startsWith('Key')   ? code.slice(3).toLowerCase() :
   code.startsWith('Digit') ? code.slice(5) : code);

function kev(type, code){
  const e = new KeyboardEvent(type, {
    code, key: keyFor(code), bubbles: true, cancelable: true, view: window
  });
  window.dispatchEvent(e);
  return e;
}
OBS.down    = (code) => { OBS._held = OBS._held || {}; OBS._held[code] = 1; kev('keydown', code); };
OBS.up      = (code) => { if (OBS._held) delete OBS._held[code]; kev('keyup', code); };
OBS.tap     = (code) => { kev('keydown', code); kev('keyup', code); };
OBS.release = () => { for (const c in (OBS._held || {})) OBS.up(c); OBS._held = {}; };
OBS.typeCode = (s) => { for (const ch of s.toUpperCase())
  OBS.tap(/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch); };

/* onPress is where a real keypress lands. If it RAISES, every key is dead -
   including Escape - and the game reads as totally frozen. This is the single
   most valuable thing to watch, and it cannot be seen from outside. */
if (!OBS.inputWrapped && typeof onPress === 'function'){
  OBS.inputWrapped = true;
  const _op = window.onPress;
  window.onPress = function(code, key){
    try { return _op.apply(this, arguments); }
    catch (e){
      flag('INPUT_THREW', { code, mode: (topMode() && topMode().name) || null,
                            e: String(e).slice(0, 200) }, 10);
      throw e;
    }
  };
}

/* ============================== 3. VISION =================================
   Three layers per cell: which glyph (gBuf), which colour (bBuf, an index
   into the material table), how bright (lBuf). The HUD is a separate plane
   with its OWN encoding - charCode-32, not a CHARS index. */
const COLNAME = OBS.colName = (() => {
  const rev = [];
  if (typeof C !== 'undefined') for (const k in C) if (typeof C[k] === 'number') rev[C[k]] = k;
  return rev;
})();
OBS.rgb = (ci) => (typeof BASE !== 'undefined' && BASE[ci]) ? BASE[ci] : null;

/* The screen as text, exactly as drawn. hud:'over' composites the HUD on top
   (what the player sees), 'only' gives the HUD alone (menus, prompts, tracker),
   'none' gives the bare world. */
OBS.screen = function(hud){
  hud = hud || 'over';
  const out = [];
  for (let r = 0; r < R.rows; r++){
    let s = '';
    for (let c = 0; c < R.cols; c++){
      const i = r * R.cols + c, h = hGlyph[i];
      s += (hud !== 'none' && h) ? String.fromCharCode(h + 32)
         : hud === 'only' ? ' '
         : (gBuf[i] ? CHARS[gBuf[i]] : ' ');
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out.join('\n');
};

/* What colours are actually on screen, by name, most-used first. This is how
   a colour bug becomes findable: a route that should be drawing 'nRed' and
   is not will simply be missing from this list. */
OBS.palette = function(minCells){
  const n = R.cols * R.rows, tally = {};
  for (let i = 0; i < n; i++){
    if (!gBuf[i]) continue;
    const name = COLNAME[bBuf[i]] || ('#' + bBuf[i]);
    tally[name] = (tally[name] || 0) + 1;
  }
  return Object.entries(tally)
    .filter(([, v]) => v >= (minCells || 1))
    .sort((a, b) => b[1] - a[1]);
};

/* Is a given colour being drawn anywhere right now, and where. */
OBS.findColour = function(name){
  const want = (typeof C !== 'undefined') ? C[name] : undefined;
  if (want === undefined) return { colour: name, known: false };
  const hits = [];
  for (let r = 0; r < R.rows; r++)
    for (let c = 0; c < R.cols; c++){
      const i = r * R.cols + c;
      if (gBuf[i] && bBuf[i] === want) hits.push([c, r]);
    }
  return { colour: name, known: true, cells: hits.length, sample: hits.slice(0, 8) };
};

/* Render twice, once with the subject moved away, and diff. What changed IS
   the subject. The only trustworthy way to answer "is that being drawn". */
OBS.isolate = function(getPos, setPos){
  const grab = () => { const a = [];
    for (let r = 0; r < R.rows; r++){ let s = '';
      for (let c = 0; c < R.cols; c++){ const g = gBuf[r * R.cols + c]; s += g ? CHARS[g] : ' '; }
      a.push(s); } return a; };
  worldPasses();                       const A = grab();
  const p = getPos(); setPos(-9999, -9999);
  worldPasses();                       const B = grab();
  setPos(p[0], p[1]);                  worldPasses();
  const rows = [];
  for (let r = 0; r < R.rows; r++){ let s = '';
    for (let c = 0; c < R.cols; c++) s += (A[r][c] !== B[r][c]) ? A[r][c] : ' ';
    rows.push(s.replace(/\s+$/, '')); }
  let r0 = 0, r1 = rows.length - 1;
  while (r0 < rows.length && !rows[r0].trim()) r0++;
  while (r1 > r0 && !rows[r1].trim()) r1--;
  return r0 >= rows.length ? { drawn: false, art: [] }
       : { drawn: true, rows: [r0, r1], art: rows.slice(r0, r1 + 1) };
};

/* ======================== 4. PER-FRAME WATCHER ============================
   Wraps render(), so it runs after both the world and HUD planes are filled,
   at the game's own frame rate. Every check here is cheap and deterministic.
   These are INVARIANTS - things that must be true of a working build - not
   heuristics. A heuristic here would cry wolf sixty times a second. */
if (!OBS.watching && typeof render === 'function'){
  OBS.watching = true;
  const _render = window.render;
  let lastHash = 0, staleFrames = 0, lastCam = [0, 0], modeSince = 0, lastMode = null;

  window.render = function(){
    const r = _render.apply(this, arguments);
    OBS.frames++;
    try { check(); } catch (e){ flag('WATCHER_THREW', { e: String(e).slice(0, 200) }, 60); }
    return r;
  };

  function check(){
    /* I1 — a non-finite camera. Nothing throws where you can see it: the
       gradient builder fails, the probe matches nothing, every key looks
       dead. This is one of the two ways the game reads as "frozen". */
    if (!isFinite(cam.x) || !isFinite(cam.y) || !isFinite(cam.ang))
      flag('CAM_NOT_FINITE', { x: cam.x, y: cam.y, ang: cam.ang }, 10);

    /* I2 — `inside` must agree with the bound scene. When it does not, you
       are standing in a room the game thinks you are not in: no exit prompt,
       no stairs, no room cast, nothing to reach at all. */
    const indoors = (typeof SCENE !== 'undefined' && typeof CITY !== 'undefined' && SCENE !== CITY);
    if (indoors !== !!inside)
      flag('SCENE_DISAGREES', { sceneId: SCENE && SCENE.id, inside: !!inside }, 10);

    /* I3 — the picture must change when the camera does. Catches a render
       that has stalled while the rest of the game carries on. */
    let h = 0;
    for (let i = 0; i < gBuf.length; i += 37) h = (h * 31 + gBuf[i] + bBuf[i] * 7) | 0;
    const moved = Math.abs(cam.x - lastCam[0]) + Math.abs(cam.y - lastCam[1]) > 0.05;
    if (h === lastHash && moved) staleFrames++; else staleFrames = 0;
    lastHash = h; lastCam = [cam.x, cam.y];
    if (staleFrames > 30) flag('RENDER_STALLED', { frames: staleFrames }, 20);

    /* I4 — the world should not collapse to a couple of colours. A sudden
       loss of variety is a rendering or palette failure, and it is exactly
       the kind of thing a screenshot-based observer would miss. */
    if (!topMode()){
      let seenc = 0; const bits = {};
      for (let i = 0; i < gBuf.length; i += 11){
        if (!gBuf[i]) continue;
        if (!bits[bBuf[i]]){ bits[bBuf[i]] = 1; seenc++; }
      }
      if (seenc > 0 && seenc < 4) flag('PALETTE_COLLAPSED', { distinct: seenc }, 30);
    }

    /* I5 — the HUD must draw. HP and the clock are always up outside a menu. */
    if (!topMode()){
      let any = 0;
      for (let i = 0; i < hGlyph.length; i += 5) if (hGlyph[i]){ any = 1; break; }
      if (!any) flag('HUD_BLANK', {}, 30);
    }

    /* I6 — a tracked job must draw its route.

       The first version of this said: tracked quest live, waySet empty, flag.
       It fired steadily on MAKING A MARK, which asks you to paint any three
       walls and therefore HAS NO DESTINATION - questTarget() returns null and
       no route could ever exist. That is the instrument being wrong, not the
       game, and an unretracted false alarm costs the developer more than a
       missed bug.

       So the condition now names every reason a route may legitimately be
       absent, and asserts only on what is left:
         - the job must actually have somewhere to go (questTarget())
         - the guidance must be switched on (autoPath)
         - you must not already be standing on it (the line ends at arrival)
         - and it must STAY absent: waySet is cleared and refilled by
           autoPathTick, so a single frame that samples mid-rebuild says
           nothing. Require it to hold across consecutive checks. */
    if (typeof player !== 'undefined' && player.track && !inside &&
        typeof waySet !== 'undefined' && typeof QUESTS !== 'undefined'){
      const Q = QUESTS[player.track];
      const live = Q && typeof player.quests[player.track] === 'number';
      let t = null;
      try { t = (typeof questTarget === 'function') ? questTarget() : null; } catch (e){}
      const on = (typeof autoPath === 'undefined') || autoPath;
      const far = t && Math.hypot(t.x - cam.x, t.y - cam.y) > 6;
      if (live && t && on && far && waySet.length === 0){
        OBS._noRoute = (OBS._noRoute || 0) + 1;
        if (OBS._noRoute >= 3)
          flag('TRACKED_QUEST_NO_ROUTE',
               { quest: player.track, name: Q.name, to: t.name,
                 d: +Math.hypot(t.x - cam.x, t.y - cam.y).toFixed(1),
                 heldFor: OBS._noRoute, wayOn: !!wayOn }, 45);
      } else OBS._noRoute = 0;
    }

    /* I7 — a mode that has owned the keyboard for a very long time. Paired
       with INPUT_THREW this is how an unescapable conversation announces
       itself instead of being reported by a stranded human. */
    const m = topMode();
    const mn = m && m.name;
    if (mn !== lastMode){ lastMode = mn; modeSince = now(); }
    else if (mn && now() - modeSince > 180) flag('MODE_HELD_LONG', { mode: mn, secs: 180 }, 180);

    /* I8 — consumer-level room check. Every interior is stamped at the same
       array origin, so two occupied rooms ALWAYS share coordinates - that
       overlap is architecture, not a bug. The failure is the game ACCEPTING
       a body from another room, which is what this asks. */
    if (typeof actorHere === 'function' && typeof actorScene === 'function'){
      const here = (typeof netSceneId === 'function') ? netSceneId() : 'city';
      for (let i = 0; i < actors.length; i++){
        const a = actors[i];
        if (!a.interior || a.interior === 1 || a.interior === here) continue;
        if (actorHere(a)){ flag('FOREIGN_ACTOR_ACCEPTED', { name: a.name, its: String(a.interior), mine: here }); break; }
      }
      if (typeof lookTarget !== 'undefined' && lookTarget && lookTarget.kind === 'actor' &&
          actorScene(lookTarget.a) !== here)
        flag('PROBE_CROSS_ROOM', { name: lookTarget.a.name, its: String(lookTarget.a.interior), mine: here });
    }

    /* I9 — a room that came up without its descriptor cannot be left. */
    if (typeof SCENES !== 'undefined')
      for (const s of SCENES.values())
        if (s.room && s.inside === null) flag('ROOM_NO_DESCRIPTOR', { id: s.id, refs: s.refs });

    /* I10 — peers must be somewhere real. */
    if (typeof PLAYERS !== 'undefined')
      for (let i = 1; i < PLAYERS.length; i++){
        const p = PLAYERS[i];
        if (!isFinite(p.cam.x) || !isFinite(p.cam.y))
          flag('PEER_NOT_FINITE', { id: p.id }, 30);
      }
  }
}

/* ============================ 5. RECORDER ================================= */
if (!OBS.recording){
  OBS.recording = true;
  const wrap = (name, kind, pick) => {
    if (typeof window[name] !== 'function') return;
    const orig = window[name];
    window[name] = function(){ try { note(kind, pick.apply(null, arguments)); } catch (e){}
                               return orig.apply(this, arguments); };
  };
  wrap('netEvent',        'ev',      m => JSON.parse(JSON.stringify(m)));
  wrap('toast',           'toast',   s => String(s));
  wrap('openDialog',      'dialog',  t => ({ who: t }));
  wrap('damagePlayer',    'meHurt',  d => ({ d, hp: player.hp }));
  wrap('acquireScene',    'acquire', (b, f) => ({ b: b && b.id, f }));
  wrap('releaseScene',    'release', s => ({ id: s && s.id, refsAfter: s ? s.refs - 1 : null }));
  wrap('stampRoomCast',   'stamp',   (id, from) => ({ id, from: from | 0 }));
  wrap('enterInterior',   'enter',   d => ({ door: d && d.name, b: d && d.b }));
  wrap('exitInterior',    'exit',    () => ({ from: SCENE && SCENE.id }));
  window.addEventListener('error', e => flag('JS_ERROR', { msg: String(e.message).slice(0, 200) }, 10));
  const _ce = console.error;
  console.error = function(){ flag('CONSOLE_ERROR',
    { msg: Array.from(arguments).map(String).join(' ').slice(0, 200) }, 10); return _ce.apply(console, arguments); };
}

/* ======================== 6. SAMPLER (1 Hz) ===============================
   Rides the frame hook. setInterval gets throttled in a background tab and
   then LIES about elapsed time - which once made a sprint look like a
   teleport. Rates here are always per measured second. */
if (!OBS.sampling){
  OBS.sampling = true;
  let lastT = now(), prev = {}, lastIds = null, lastClock;
  const _r2 = window.render;
  window.render = function(){
    const out = _r2.apply(this, arguments);
    const t = now();
    if (t - lastT >= 1){
      const dt = t - lastT; lastT = t;
      try { sample(dt); } catch (e){ flag('SAMPLER_THREW', { e: String(e).slice(0, 160) }, 60); }
    }
    return out;
  };
  function sample(dt){
    const snap = { t: +now().toFixed(1), fps: Math.round(typeof fps !== 'undefined' ? fps : 0),
                   clock: +clock.toFixed(2), day: dayCount, p: {} };
    for (const p of PLAYERS){
      const me = (p === ME);
      const st = { x: +p.cam.x.toFixed(2), y: +p.cam.y.toFixed(2),
        sc: me ? (typeof netSceneId === 'function' ? netSceneId() : 'city') : p.sceneId,
        hp: me ? player.hp : p.hp, dead: !!p.dead,
        stale: me ? 0 : +(now() - (p.lastT || now())).toFixed(2) };
      snap.p[p.id] = st;
      const pv = prev[p.id];
      if (pv){
        if (pv.sc !== st.sc) note('scene', { id: p.id, from: pv.sc, to: st.sc });
        if (pv.hp !== st.hp) note('hp', { id: p.id, from: pv.hp, to: st.hp });
        if (pv.dead !== st.dead) note('dead', { id: p.id, dead: st.dead });
        if (pv.sc === st.sc){
          const v = Math.hypot(st.x - pv.x, st.y - pv.y) / dt;   // tiles per SECOND
          if (v > 25) note('teleport', { id: p.id, tps: +v.toFixed(1) });
        }
        if (st.stale > 3 && pv.stale <= 3) flag('PEER_STALE', { id: p.id, s: st.stale }, 30);
      }
      prev[p.id] = st;
    }
    const ids = PLAYERS.map(p => p.id).join(',');
    if (lastIds && lastIds !== ids) note('roster', { from: lastIds, to: ids });
    lastIds = ids;
    if (lastClock !== undefined){
      const d = clock - lastClock;
      if (Math.abs(d) > 0.6 && Math.abs(d) < 23) note('clockJump', { from: +lastClock.toFixed(2), to: +clock.toFixed(2) });
    }
    lastClock = clock;
    OBS.samples.push(snap);
    if (OBS.samples.length > 4000) OBS.samples.shift();
  }
}

/* ============================== 7. REPORT ================================= */
OBS.report = function(opts){
  opts = opts || {};
  const link = (typeof NET !== 'undefined' && NET.on && NET.link) ? {
    room: NET.room, role: NET.role, status: NET.status,
    ice: NET.link.rtc && NET.link.rtc.ice, swarm: NET.link.rtc && NET.link.rtc.swarm,
    bus: NET.link.bus && NET.link.bus.state, err: NET.error || 'none'
  } : { off: true };
  const out = {
    driver: OBS.driver, frames: OBS.frames, frameErr: OBS.err,
    grid: R.cols + 'x' + R.rows, fps: Math.round(typeof fps !== 'undefined' ? fps : 0),
    me: { pos: [+cam.x.toFixed(1), +cam.y.toFixed(1)],
          scene: (typeof netSceneId === 'function' ? netSceneId() : 'city'),
          hp: player.hp, mode: (topMode() && topMode().name) || null,
          track: player.track || null },
    players: PLAYERS.map(p => ({ id: p.id, pos: [+p.cam.x.toFixed(1), +p.cam.y.toFixed(1)],
                                 sc: p === ME ? 'me' : p.sceneId, hp: p === ME ? player.hp : p.hp })),
    world: { clock: +clock.toFixed(2), day: dayCount, weather,
             peds: peds.length, actors: actors.length,
             rooms: (typeof SCENES !== 'undefined') ? [...SCENES.keys()] : [] },
    link,
    FINDINGS: OBS.findings.slice(-(opts.findings || 20)),
    events: OBS.events.slice(-(opts.events || 15)).map(e => e.t + ' ' + e.kind + ' ' +
             JSON.stringify(e.data).slice(0, 110))
  };
  if (opts.clearFindings) OBS.findings = [];
  return out;
};

/* Baseline check - run after any probe that touched the world. */
OBS.clean = () => ({
  scene: SCENE.id, rooms: [...SCENES.keys()], actors: actors.length,
  interior1: actors.filter(a => a.interior === 1).length,
  camFinite: isFinite(cam.x) && isFinite(cam.y), modes: modeStack.length,
  held: Object.keys(OBS._held || {})
});

OBS.installed = true;
return { installed: true, driver: OBS.driver, grid: R.cols + 'x' + R.rows,
         colours: COLNAME.filter(Boolean).length,
         api: ['screen(hud)', 'palette()', 'findColour(name)', 'isolate()',
               'down/up/tap/typeCode', 'release()', 'report(opts)', 'clean()'] };
})()
