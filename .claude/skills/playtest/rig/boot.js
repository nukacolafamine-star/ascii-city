/* ============================================================================
   PT — the playtest rig.  boot.js: loader, frame driver, cleanup.

   One call brings up everything:

     fetch('/.claude/skills/playtest/rig/boot.js').then(r=>r.text()).then(eval)

   then read `PT.ready` on the next probe.  Everything lives under `window.PT`;
   nothing else is added to the page except a single frame hook.
   ============================================================================ */
(() => {
const PT = window.PT = window.PT || {};
PT.version = '1.1';

/* ------------------------------------------------------------------ log --- */
PT.log = PT.log || [];
PT.say = s => {
  const t = (typeof worldTime !== 'undefined') ? worldTime.toFixed(1) : '--';
  PT.log.push(t + ' ' + s);
  if (PT.log.length > 600) PT.log.shift();
  return s;
};
PT.tail = n => PT.log.slice(-(n || 8));

/* =========================== 1. THE ONE FRAME HOOK =========================
   Every behaviour in the rig is a named entry in PT.ticks, redefined freely
   whenever a rig file is re-evaluated.  The hook that calls them is installed
   exactly once, ever.

   This is the whole reason the registry exists.  Wrapping `window.frame` per
   file means a second load stacks a second wrapper, and two copies of the same
   behaviour then fight over the same state - which reads exactly like a game
   bug and is not one.  Register, do not wrap.                                */
PT.ticks = PT.ticks || {};
if (!PT._hooked){
  PT._hooked = true;
  const inner = window.frame;
  PT._frame0 = inner;
  const hook = function(now){
    const out = inner.apply(this, arguments);
    const t = (typeof performance !== 'undefined') ? performance.now() : now;
    let dt = PT._last ? (t - PT._last) / 1000 : 0.016;
    PT._last = t;
    if (!(dt > 0) || dt > 0.25) dt = 0.016;
    PT.dt = dt; PT.frames = (PT.frames || 0) + 1;
    for (const k in PT.ticks){
      const fn = PT.ticks[k];
      if (!fn) continue;
      try { fn(dt); }
      catch (e){
        PT.say('tick ' + k + ' THREW ' + e);
        PT.ticks[k] = null;                     // a throwing tick is retired,
      }                                         // never left to throw per frame
    }
    return out;
  };
  hook.__isFrame = true;
  window.frame = hook;
}

/* ============================ 2. THE FRAME DRIVER ==========================
   Two traps live here, and both present as engine faults.

   (a) The pane lies.  A preview tab reports `document.hidden === false` and
       `visibilityState === 'visible'`, then stops delivering rAF the moment
       another tab is fronted.  observer.js only installs its worker when
       document.hidden is true, so a pane tab gets no driver and the world
       silently stops - clock frozen, every "am I visible" check saying fine.

   (b) observer.js captures the loop by `cb.name === 'frame'`.  The moment any
       rig wraps window.frame that name becomes '' - so installing a navigator
       can kill the observer's own driver.

   The fix for both: capture by IDENTITY, never by name, and drive from exactly
   one worker.  Native rAF is deliberately taken out of the loop entirely, so
   the count of drivers is one no matter what the tab claims about itself.     */
if (!PT._rafFixed){
  PT._rafFixed = true;
  const realRAF = window.requestAnimationFrame.bind(window);
  PT._realRAF = realRAF;
  window.requestAnimationFrame = function(cb){
    if (cb === window.frame || cb === PT._frame0 || (cb && (cb.__isFrame || cb.name === 'frame'))){
      window.__pend = cb;                       // observer's worker reads this
      return 1;                                 // same slot, so either can drive
    }
    return realRAF(cb);
  };
}
window.__pend = window.frame;

/* Exactly one worker.  If observer.js already made one it is consuming
   window.__pend on an 8 ms tick, and a second would double-step the world -
   the symptom is fps reading ~120 and the simulation running at 2x, which on
   a host it does for everybody.

   This has to run AFTER the observer has had its chance to install one, which
   is why it is a function and not a top-level expression: boot() loads the
   observer first and then calls this. */
PT.installDriver = () => {
  if (PT._worker) return PT.driver;
  if (typeof __OBS !== 'undefined' && __OBS.worker){
    PT.driver = 'observer worker (capture repaired)';
    return PT.driver;
  }
  const src = "let t=null;onmessage=e=>{if(e.data==='go'){if(t)clearInterval(t);" +
              "t=setInterval(()=>postMessage(0),8);}}";
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  PT._worker = w; PT._wlast = 0; PT.wErr = null;
  w.onmessage = () => {
    const p = performance.now();
    if (p - PT._wlast < 15) return;             // ~60 Hz, never faster
    PT._wlast = p;
    let cb = window.__pend; window.__pend = null;
    if (!cb) cb = window.frame;
    try { cb(p); } catch (e){ PT.wErr = String(e && e.stack || e); }
  };
  w.postMessage('go');
  PT.driver = 'PT worker';
  return PT.driver;
};
/* Belt and braces: if the count is ever wrong, say so rather than letting a
   2x world be mistaken for a desync. */
PT.checkDriver = () => {
  const n = (PT._worker ? 1 : 0) + ((typeof __OBS !== 'undefined' && __OBS.worker) ? 1 : 0);
  if (n > 1) PT.say('WARNING: ' + n + ' frame drivers — the world is running at ' + n + 'x');
  return n;
};

/* ============================== 3. VIEWPORT ================================
   A collapsed pane reports innerWidth 0 and initRender clamps to a 45x20 grid.
   Pin a real one, and pin manualRes so auto-res cannot step the grid down
   mid-session and change what every colour and screen probe is looking at. */
PT.fixViewport = () => {
  try {
    if (!window.innerWidth || window.innerWidth < 900){
      Object.defineProperty(window, 'innerWidth',  { configurable: true, get: () => 1280 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 720 });
    }
  } catch (e){ PT.say('viewport: ' + e); }
  if (typeof CFG !== 'undefined'){ CFG.manualRes = true; }
  if (typeof initRender === 'function') initRender();
  return R.cols + 'x' + R.rows;
};

/* ============================ 4. THE CLEANUP CONTRACT ======================
   reference.md section 10, as one call.  Run it before you finish, and after
   any probe that touched the world. */
PT.release = () => {
  for (const k of ['KeyW','KeyS','KeyA','KeyD','ShiftLeft','ShiftRight','Space'])
    keys[k] = 0;
  return 'released';
};
PT.stopAll = () => {
  for (const k in PT.ticks) if (PT.state && PT.state[k]) PT.state[k].on = 0;
  if (PT.nav) PT.nav.stop();
  PT.release();
  return 'all behaviours off';
};
PT.clean = (quiet) => {
  PT.stopAll();
  let g = 0; while (topMode() && g++ < 15) PT.tap('Escape');
  if (typeof netSceneId === 'function' && netSceneId() !== 'city' && typeof exitInterior === 'function')
    exitInterior();
  const out = {
    scene: SCENE.id,
    rooms: [...SCENES.keys()],
    actors: actors.length,
    baseline: (typeof CAST0 !== 'undefined') ? CAST0 : null,
    aboveBaseline: actors.length - ((typeof CAST0 !== 'undefined') ? CAST0 : actors.length),
    interior1: actors.filter(a => a.interior === 1).length,
    camFinite: isFinite(cam.x) && isFinite(cam.y),
    modes: modeStack.length,
    heldKeys: Object.keys(keys).filter(k => keys[k])
  };
  /* A POSITIVE aboveBaseline is the thing you spawned and must remove. A
     NEGATIVE one is the world having lost a body the seed placed, which is
     not yours to clean up and is worth saying out loud - it means this client
     and every other client now disagree about who exists. Seen once already:
     a seeded PATROL culled by enfBrainTick with no worldDelta.slain record. */
  if (out.aboveBaseline < 0){
    const ids = actors.filter(a => !a.interior && a.id !== undefined).map(a => a.id);
    const missing = [];
    for (let i = 0; i < out.baseline; i++) if (ids.indexOf(i) < 0) missing.push(i);
    out.LOST_SEEDED_ACTORS = missing;
    out.warn = 'this client is ' + (-out.aboveBaseline) + ' seeded actor(s) short of its own ' +
               'baseline (ids ' + missing.join(',') + ') - other clients still have them';
  }
  if (!quiet) PT.say('clean ' + JSON.stringify(out));
  return out;
};

/* ============================= 5. KEYS AND STATUS ========================== */
const KEYNAME = {
  Space:' ', Enter:'Enter', Escape:'Escape', Tab:'Tab', Backspace:'Backspace',
  ArrowUp:'ArrowUp', ArrowDown:'ArrowDown', ArrowLeft:'ArrowLeft', ArrowRight:'ArrowRight',
  ShiftLeft:'Shift', ShiftRight:'Shift', Backquote:'`'
};
const keyFor = c => KEYNAME[c] ||
  (c.startsWith('Key') ? c.slice(3).toLowerCase() : c.startsWith('Digit') ? c.slice(5) : c);
/* Real dispatched events, so the game's own bindings are under test too -
   writing keys[] directly skips the whole input layer. */
PT.tap = code => {
  const k = keyFor(code);
  dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true }));
  dispatchEvent(new KeyboardEvent('keyup',   { code, key: k, bubbles: true }));
  return code;
};
PT.down = code => { dispatchEvent(new KeyboardEvent('keydown', { code, key: keyFor(code), bubbles: true })); };
PT.up   = code => { dispatchEvent(new KeyboardEvent('keyup',   { code, key: keyFor(code), bubbles: true })); };
PT.type = s => { for (const ch of s.toUpperCase()) PT.tap(/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch); return s; };

PT.status = () => ({
  driver: PT.driver, fps: Math.round(typeof fps !== 'undefined' ? fps : 0),
  frames: PT.frames || 0, wErr: PT.wErr || null,
  grid: R.cols + 'x' + R.rows,
  pos: [+cam.x.toFixed(1), +cam.y.toFixed(1)],
  scene: (typeof netSceneId === 'function') ? netSceneId() : 'city',
  hp: player.hp, cr: player.credits, corr: player.corruption,
  wep: (typeof weaponId === 'function') ? weaponId() : '?',
  ammo: (typeof invCount === 'function') ? invCount('ammo') : null,
  inv: player.inv.map(s => s.id + 'x' + s.qty),
  mode: topMode() ? topMode().name : null,
  clock: +clock.toFixed(2), day: dayCount,
  net: (typeof NET !== 'undefined' && NET.on)
        ? { room: NET.room, role: NET.role, status: NET.status } : { off: true },
  busy: PT.busy ? PT.busy() : null
});

/* ============================== 6. THE LOADER ============================== */
PT.load = async (files) => {
  const base = '/.claude/skills/playtest/rig/';
  for (const f of (files || ['nav.js', 'act.js', 'drive.js', 'see.js', 'talk.js', 'net.js'])){
    try {
      const t = await (await fetch(base + f + '?t=' + Date.now())).text();
      // indirect eval: rig files are top-level IIFEs and want global scope
      (0, eval)(t);
      PT.say('loaded ' + f);
    } catch (e){ PT.say('LOAD FAILED ' + f + ' — ' + e); }
  }
  return PT.tail(6);
};

PT.boot = async (opts) => {
  opts = opts || {};
  PT.ready = false;
  if (typeof __OBS === 'undefined' && opts.observer !== false){
    try {
      const t = await (await fetch('/.claude/skills/playtest/observer.js?t=' + Date.now())).text();
      window.__boot = (0, eval)(t);
      PT.say('observer ' + JSON.stringify(window.__boot).slice(0, 90));
    } catch (e){ PT.say('observer failed: ' + e); }
  }
  PT.installDriver();                     // AFTER the observer, never before
  PT.fixViewport();
  await PT.load(opts.files);
  window.__pend = window.frame;
  PT.ready = true;
  PT.checkDriver();
  PT.say('READY  driver=' + PT.driver + '  grid=' + R.cols + 'x' + R.rows +
         '  fps=' + Math.round(typeof fps !== 'undefined' ? fps : 0));
  return PT.status();
};

if (!PT._autoBooted){ PT._autoBooted = true; PT.boot(); }
})();
'PT boot v1.0 — read PT.ready, then PT.status()';
