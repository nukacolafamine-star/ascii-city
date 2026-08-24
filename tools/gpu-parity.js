/*============================ the GPU port's rig =============================
  Load it from the browser console (or the browser pane) with

      await import('/tools/gpu-parity.js')

  and everything below hangs off window.GPUT. It exists because three separate
  things about this setup lie, and each of them costs an afternoon if you
  believe it:

  1. A preview pane tab reports document.hidden === true and requestAnimationFrame
     simply stops. The game freezes with no error. GPUT.drive() runs `frame`
     off a worker tick instead and neuters rAF so the game's own re-arm cannot
     queue a backlog that all fires at once later.

  2. The pane resizes itself back to its default a beat after you resize it,
     and initRender reads window.innerWidth directly - so the grid silently
     halves under a benchmark that is still running. GPUT.pin() makes
     innerWidth/innerHeight constants.

  3. Profiling with worldPasses() in a for-loop freezes the world: pedestrians
     stop walking into frame and the same spot measures half of what it costs
     live. GPUT.prof() wraps the passes and lets the driver drive.

  The part that matters is GPUT.parity(): it drives the camera through a set
  of poses covering position, heading, pitch, eye height, the whole clock and
  every weather, renders each one twice - once with the switch on and once
  without - and compares gBuf/bBuf/lBuf/refBuf/srcBuf/emitKind/dBuf cell by
  cell. Byte-identical is the bar until the GPU owns a pass; after that it is
  a stated fraction with every differing cell tracked to a cause.

  THE POSE SET HAS NOW HAD TWO DEAD PROPERTIES IN IT, both of the same shape,
  and both made a thin sweep look like a thorough one. `window.clock = x` on a
  top-level `let` was the first. `cam.a = x` was the second: the camera's
  heading is cam.ANG, there is no cam.a, so thirty-five poses that claimed to
  cover every heading all rendered at whatever heading the game was left at.
  If you add a field to a pose, print it back off the object it is supposed to
  have landed on before you believe the sweep covers it.
============================================================================*/
(() => {
const W = window;
const GPUT = W.GPUT = W.GPUT || {};

/*------------------------------- 1. the rig --------------------------------*/
GPUT.pin = (w = 1440, h = 1280) => {
  try {
    Object.defineProperty(W, 'innerWidth',  { get: () => w, configurable: true });
    Object.defineProperty(W, 'innerHeight', { get: () => h, configurable: true });
  } catch (e){ return 'pin failed: ' + e; }
  CFG.manualRes = true; W.autoRes = false;
  CFG.resIdx = CFG.CELLW.length - 1;
  initRender();
  return { cols: R.cols, rows: R.rows, cells: R.cols * R.rows };
};

/* The worker ticks, the page acks, and only then does the worker tick again.
   A free-running setTimeout(16) posts faster than a 40ms frame can consume,
   the message queue grows without bound, and the tab stops answering the
   debugger at all - which reads exactly like a hung renderer and is not. */
GPUT.drive = () => {
  if (GPUT._drv) return { already: true, n: GPUT._drv.n };
  W.requestAnimationFrame = () => 0;          // the game re-arms; do not let it queue
  const src = "let on=true;" +
              "onmessage=e=>{ if(e.data==='stop'){on=false;return;} if(on) setTimeout(()=>postMessage(0),12); };" +
              "postMessage(0);";
  const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const D = GPUT._drv = { n: 0, wk, on: true, err: null };
  wk.onmessage = () => {
    if (!D.on) return;
    if (!D.paused){
      D.n++;
      try { frame(performance.now()); } catch (e){ D.err = String(e); D.on = false; return; }
    }
    wk.postMessage('ack');
  };
  return { installed: true };
};
GPUT.stop = () => { if (GPUT._drv){ GPUT._drv.on = false; GPUT._drv.wk.postMessage('stop'); } };
// hold the world still for a synchronous sweep, so the driver is not also
// rendering between the two halves of an A/B
GPUT.pause = (v) => { if (GPUT._drv) GPUT._drv.paused = v; return !!(GPUT._drv && GPUT._drv.paused); };

/*---------------------------- 2. the profiler ------------------------------*/
const PASSES = ['skyPass','ceilingPass','floorPass','wallPass','wallMirror','spritePass',
                'signPass','reflectPass','lampVolume','rainPass','harvestEmitters','hizBuild',
                'glWorldPass','glWorldRead','glSpritePass','applySpriteRefl','spriteReplay',
                'worldPasses'];
GPUT.prof = () => {
  if (GPUT._prof) return GPUT._prof;
  const P = GPUT._prof = { acc: {}, frames: 0, on: false };
  for (const n of PASSES){
    const orig = W[n];
    if (typeof orig !== 'function') continue;
    P.acc[n] = 0;
    W[n] = function(){
      if (!P.on) return orig.apply(this, arguments);
      const t = performance.now();
      const r = orig.apply(this, arguments);
      P.acc[n] += performance.now() - t;
      return r;
    };
  }
  const wp = W.worldPasses;
  W.worldPasses = function(){ if (P.on) P.frames++; return wp.apply(this, arguments); };
  P.reset = () => { for (const k in P.acc) P.acc[k] = 0; P.frames = 0; };
  P.report = () => {
    const o = { frames: P.frames, cells: R.cols * R.rows, sprites: statSprites };
    for (const k in P.acc) o[k] = +(P.acc[k] / Math.max(1, P.frames)).toFixed(3);
    return o;
  };
  return P;
};
// run the profiler for ms milliseconds of wall clock and hand back the report
GPUT.measure = (ms = 4000) => new Promise(res => {
  const P = GPUT.prof();
  P.reset(); P.on = true;
  setTimeout(() => { P.on = false; res(P.report()); }, ms);
});

/*------------------- 3. what an A/B is allowed to toggle -------------------
  A switch that is nested inside another one cannot be compared on its own:
  the sprites only run when the world pass is fully on, so an A/B of the
  sprites has to hold the world pass ON on BOTH sides and flip only GPUS.
  Every measurement below takes the name of what it is flipping. */
const SWITCH = {
  world: {
    set(on){ GPUW.on = on; },
    get(){ return GPUW.on; },
    hold(){ return null; },
    free(){}
  },
  sprite: {
    set(on){ GPUS.on = on; },
    get(){ return GPUS.on; },
    // the world pass is the sprites' depth buffer; it stays on for both sides
    hold(){ const s = { on: GPUW.on, st: GPUW.stages }; GPUW.on = true; GPUW.stages = 7; return s; },
    free(s){ if (s){ GPUW.on = s.on; GPUW.stages = s.st; } }
  }
};

/*------------------- 3a. an A/B that interleaves inside one run -------------
  Absolute milliseconds on this machine drift by more than 2x - sometimes
  because the game is open in another window - so a run of A followed by a run
  of B compares two different machines. Alternate them frame by frame instead
  and report the ratio. Right for a change that only costs CPU, WRONG for a
  readback: see blockAB. */
GPUT.ab = (ms = 6000, what = 'world') => new Promise(res => {
  const S = SWITCH[what];
  GPUT.prof();
  const A = { t: 0, n: 0 }, B = { t: 0, n: 0 };     // A = switch on, B = switch off
  const was = S.get(), held = S.hold();
  let flip = false;
  const wp = W.worldPasses;
  const spy = function(){
    flip = !flip;
    S.set(flip);
    const t = performance.now();
    const r = wp.apply(this, arguments);
    const dt = performance.now() - t;
    const s = flip ? A : B;
    s.t += dt; s.n++;
    return r;
  };
  W.worldPasses = spy;
  setTimeout(() => {
    W.worldPasses = wp; S.set(was); S.free(held);
    const a = A.t / Math.max(1, A.n), b = B.t / Math.max(1, B.n);
    res({ what, onMs: +a.toFixed(3), offMs: +b.toFixed(3),
          ratio: +(a / b).toFixed(4), savedMs: +(b - a).toFixed(3),
          frames: A.n + B.n, cells: R.cols * R.rows, sprites: statSprites });
  }, ms);
});

/*--- 3b. block A/B, for a change that introduces a pipeline sync -----------
  Frame-by-frame interleaving is the right instrument for a change that only
  costs CPU, and the wrong one for a readback. A frame that reads the card
  back waits for everything still queued from the frame BEFORE it, while a
  frame that does not read lets the CPU run a frame ahead - so alternating
  hands the entire previous frame's GPU time to whichever side is holding the
  readback. Measured that way the GPU path looked 23% slower; measured in
  blocks, where each side pays for its own steady state, it does not.

  So: whole frames, in alternating blocks, timed end to end. Blocks rather
  than one long run of each because the machine drifts. */
GPUT.blockAB = (msPerBlock = 3000, blocks = 4, what = 'world') => new Promise(res => {
  const S = SWITCH[what];
  const on = [], off = [];
  let bi = 0;
  const acc = { t: 0, n: 0 };
  const was = S.get(), held = S.hold();
  const origFrame = W.frame;
  W.frame = function(now){
    const t = performance.now();
    const r = origFrame.apply(this, arguments);
    acc.t += performance.now() - t; acc.n++;
    return r;
  };
  const step = () => {
    if (bi > 0) (S.get() ? on : off).push(acc.t / Math.max(1, acc.n));
    if (bi >= blocks * 2){
      W.frame = origFrame; S.set(was); S.free(held);
      const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
      return res({ what, onMs: +med(on).toFixed(3), offMs: +med(off).toFixed(3),
                   ratio: +(med(on) / med(off)).toFixed(4),
                   savedMs: +(med(off) - med(on)).toFixed(3),
                   on: on.map(v => +v.toFixed(2)), off: off.map(v => +v.toFixed(2)),
                   cells: R.cols * R.rows, sprites: statSprites });
    }
    S.set((bi % 2) === 0);
    acc.t = 0; acc.n = 0; bi++;
    setTimeout(step, msPerBlock);
  };
  step();
});

/*--------------------------- 4. the parity check ---------------------------*/
const snap = () => ({
  g: Uint8Array.from(gBuf), b: Uint8Array.from(bBuf), l: Uint8Array.from(lBuf),
  s: Uint8Array.from(srcBuf), r: Uint8Array.from(refBuf), d: Float32Array.from(dBuf),
  e: Uint8Array.from(emitKind)
});
GPUT.snap = snap;

// how much of the frame is actually THERE - an all-empty frame compares equal
// to another all-empty frame, and that is the failure mode to guard against
const content = (S) => { let n = 0; for (let i = 0; i < S.g.length; i++) if (S.g[i]) n++; return n; };

const diff = (A, B) => {
  const n = A.g.length, o = { cells: n, g: 0, b: 0, l: 0, s: 0, r: 0, e: 0, d: 0, any: 0,
                              surf: 0, mir: 0, dMaxRel: 0, first: null };
  for (let i = 0; i < n; i++){
    let bad = 0;
    if (A.g[i] !== B.g[i]){ o.g++; bad = 1; }
    if (A.b[i] !== B.b[i]){ o.b++; bad = 1; }
    if (A.l[i] !== B.l[i]){ o.l++; bad = 1; }
    if (A.s[i] !== B.s[i]){ o.s++; bad = 1; }
    if (A.r[i] !== B.r[i]){ o.r++; bad = 1; }
    if (A.e[i] !== B.e[i]){ o.e++; bad = 1; }
    const da = A.d[i], db = B.d[i];
    if (da !== db){
      // 1e30 is "nothing here"; treat only a finite-vs-finite gap as numeric
      if (da > 1e29 || db > 1e29){ o.d++; bad = 1; }
      else {
        const rel = Math.abs(da - db) / Math.max(1e-6, Math.abs(db));
        if (rel > o.dMaxRel) o.dMaxRel = rel;
        if (rel > 1e-4){ o.d++; bad = 1; }
      }
    }
    if (bad){
      o.any++;
      /* A cell painted by a SURFACE carries a source kind; a cell painted by
         a MIRROR is written with srcBuf 0 on purpose, by every mirror in the
         renderer. Splitting the count on that is what separates "the marcher
         disagrees" from "the reflection landed a row out", and the two have
         completely different causes. */
      if (A.s[i] !== 0 || B.s[i] !== 0) o.surf++; else o.mir++;
      if (!o.first) o.first = { i, x: i % R.cols, y: (i / R.cols) | 0,
                                A: [A.g[i], A.b[i], A.l[i], A.r[i], A.s[i], A.d[i]],
                                B: [B.g[i], B.b[i], B.l[i], B.r[i], B.s[i], B.d[i]] };
    }
  }
  o.pct = +(100 * o.any / n).toFixed(4);
  o.dMaxRel = +o.dMaxRel.toExponential(2);
  return o;
};
GPUT.diff = diff;

/* Thirty-odd poses: four vantages the handoff calls busy, every heading, a
   look up and a look down, a crouch and a rooftop eye height, the clock all
   the way round and all four weathers. */
GPUT.poses = () => {
  const spots = [[550, 520], [340, 520], [580, 640], [460, 370]];
  const out = [];
  for (let i = 0; i < 24; i++){
    const s = spots[i & 3];
    out.push({ x: s[0] + (i % 5) * 1.7, y: s[1] + (i % 3) * 2.3,
               a: i * 0.2618, pitch: [0, 0, 14, -12, 0, 6][i % 6],
               z: [1.62, 1.7, 1.15, 1.62][i & 3],
               clock: (i * 1.03) % 24, weather: i & 3 });
  }
  // a rooftop vantage, twice, looking down over the blocks
  out.push({ x: 550, y: 520, a: 0.7,  pitch: 26, z: 24, clock: 21.5, weather: 0 });
  out.push({ x: 340, y: 520, a: 3.4,  pitch: 34, z: 41, clock: 12.0, weather: 3 });
  // the river, from both banks, where the deep pass and the channel wall live
  out.push({ x: 500, y: 486, a: 1.57, pitch: -4, z: 1.62, clock: 22.0, weather: 1 });
  out.push({ x: 520, y: 516, a: 4.71, pitch: -6, z: 1.62, clock: 3.0,  weather: 2 });
  // noon and midnight straight down a street
  out.push({ x: 550, y: 520, a: 0.0,  pitch: 0,  z: 1.62, clock: 12.0, weather: 0 });
  out.push({ x: 550, y: 520, a: 0.0,  pitch: 0,  z: 1.62, clock: 0.5,  weather: 0 });
  /* Looking hard DOWN on wet ground, which is the only thing that fires the
     off-screen mirror in the wall pass: it needs 2*horizon + 2*cam.z*unitRows
     to fall inside the frame, and at eye level with a level view it never
     does. Measured: nothing at all at pitch 0 from any heading, and two to
     five thousand cells a frame at -40 and below. A pose set without these
     tests that code path by not reaching it. */
  for (const [a, pitch] of [[0.7, -40], [2.4, -50], [4.1, -60], [5.6, -45]])
    out.push({ x: 550, y: 520, a, pitch, z: 1.62, clock: 22.5, weather: 1, wet: 0.95 });
  out.push({ x: 340, y: 520, a: 1.2, pitch: -70, z: 3.5, clock: 21.0, weather: 2, wet: 1 });
  /*--- and the two the sprite pass needs that the world pass never did -----
    AN INTERIOR. glWorldPass returns 0 indoors, so nothing about a room was
    ever on the card and no pose had to enter one. The sprites are gated the
    same way, which makes these poses a test that the switch is INERT indoors
    rather than a test of a shader - and that is worth proving rather than
    assuming, because it is a whole branch of worldPasses.

    A MOVING CAMERA. Occlusion between solids is the one place a buffer one
    frame stale would show, and a still pose cannot see it: every pass gets
    the same fresh buffers whether or not it deserves them. These walk the
    camera a few frames before the frame that is compared, identically on
    both sides, so anything carried over from the frame before is carried
    over on both sides or on neither. */
  out.push({ inside: 1, x: 550, y: 520, a: 0.0, pitch: 0, z: 1.62, clock: 20.0, weather: 0 });
  out.push({ inside: 1, x: 550, y: 520, a: 2.2, pitch: -10, z: 1.62, clock: 9.0, weather: 2 });
  for (const [a, dx, dy, da] of [[0.7, 0.22, 0.05, 0.03], [3.9, -0.18, 0.14, -0.05]])
    out.push({ x: 550, y: 520, a, pitch: -6, z: 1.7, clock: 21.0, weather: 1,
               warm: 5, step: [dx, dy, da] });
  return out;
};

/* Bare assignment, NOT window.clock = ... - ASCII CITY is one classic script,
   so its top-level `let`s live in the global LEXICAL environment and never
   appear on window. `W.clock = 3` quietly creates a new window property the
   game does not read, and the pose then runs at whatever hour the game was
   already at: thirty-five poses that all looked like one. A module can assign
   the real binding by name, because the binding is in scope.

   And it is cam.ANG, not cam.a. There is no cam.a. The same mistake in a
   different costume cost this pose set its whole heading axis. */
const applyPose = (p) => {
  if (p.inside){ if (!inside) stepInside(); }
  else if (inside) exitInterior();
  if (!p.inside){ cam.x = p.x; cam.y = p.y; cam.z = p.z; }
  cam.ang = p.a; cam.pitch = p.pitch;
  clock = p.clock;
  weather = p.weather;
  // the palette and the lamp gate are both derived from the clock, and both
  // are settled once a frame - so settle them here or the pose is half-applied
  updateClock(0);
  _lampNight = clamp((curTime().lit - 0.10) / 0.52, 0, 1);
  // a fixed reservoir level, or two renders a frame apart disagree about rain
  wetLevel = p.wet !== undefined ? p.wet : 0.6;
};
/* The nearest door to the busy vantage, stepped through. enterInterior can
   refuse - a flagged lock, and the player's corruption is whatever the save
   left it at - so this reports whether it got in rather than assuming. */
const stepInside = () => {
  if (!doors || !doors.length) return false;
  let best = null, bd = 1e30;
  for (const d of doors){
    const dd = (d.x - 550) * (d.x - 550) + (d.y - 520) * (d.y - 520);
    if (dd < bd){ bd = dd; best = d; }
  }
  if (!best) return false;
  cam.x = best.x; cam.y = best.y;
  const corr = player.corruption;
  player.corruption = 0;                       // no locked doors in a harness
  try { enterInterior(best); } catch (e){}
  player.corruption = corr;
  return !!inside;
};
GPUT.stepInside = stepInside;

/* One pose, rendered twice. render() is the real renderer - runFrame is the
   street race and draws nothing - and it must be called synchronously here so
   the buffers belong to the pose we just set rather than to the frame before. */
const runPose = (p) => {
  applyPose(p);
  if (p.warm){
    // the same walk on both sides, so anything stale is stale on both
    for (let i = 0; i < p.warm; i++){
      cam.x += p.step[0]; cam.y += p.step[1]; cam.ang += p.step[2];
      render();
    }
  }
  render();
};
GPUT.parityOne = (p, stages, what) => {
  what = what || 'world';
  const S = SWITCH[what];
  const wasOn = S.get(), wasSt = GPUW.stages, wasSSt = GPUS.stages, wasWet = wetLevel;
  const wasClock = clock, wasWx = weather;
  const held = S.hold();
  S.set(false); runPose(p); const B = snap();
  S.set(true);
  if (what === 'world') GPUW.stages = stages; else GPUS.stages = stages;
  runPose(p); const A = snap();
  S.set(wasOn); S.free(held);
  GPUW.stages = wasSt; GPUS.stages = wasSSt;
  wetLevel = wasWet; clock = wasClock; weather = wasWx;
  const o = diff(A, B);
  o.contentA = content(A); o.contentB = content(B);
  o.pose = p;
  return o;
};

GPUT.parity = (stages, poses, what) => {
  what = what || 'world';
  if (stages === undefined) stages = what === 'world' ? GPUW.stages : GPUS.stages;
  poses = poses || GPUT.poses();
  GPUT.pause(true);
  try { return parityRun(stages, poses, what); }
  finally { GPUT.pause(false); if (inside) exitInterior(); }
};
// the sprites, with the world pass held on underneath both sides
GPUT.parityS = (stages, poses) => GPUT.parity(stages === undefined ? 3 : stages, poses, 'sprite');

const parityRun = (stages, poses, what) => {
  const S = SWITCH[what];
  const held = S.hold();
  // prove the switch switches: a flag being ignored produces perfect parity
  const counter = () => what === 'world' ? GW.ran : GS.ran;
  const before = counter();
  S.set(true);
  if (what === 'world') GPUW.stages = stages; else GPUS.stages = stages;
  render();
  const onRan = counter() - before;
  S.set(false); render();
  const offRan = counter() - before - onRan;
  S.free(held);
  const rows = [];
  let worst = null, tot = 0, cells = 0, empty = 0, surf = 0, mir = 0;
  for (const p of poses){
    const o = GPUT.parityOne(p, stages, what);
    if (o.contentA < 200 || o.contentB < 200) empty++;
    tot += o.any; cells += o.cells; surf += o.surf; mir += o.mir;
    if (!worst || o.any > worst.any) worst = o;
    rows.push({ pose: p.inside ? ['inside', +p.a.toFixed(2), p.pitch, +p.clock.toFixed(1), p.weather]
                               : [p.x | 0, p.y | 0, +p.a.toFixed(2), p.pitch, p.z,
                                  +p.clock.toFixed(1), p.weather, p.warm ? 'moving' : ''],
                any: o.any, pct: o.pct, g: o.g, b: o.b, l: o.l, r: o.r, s: o.s, e: o.e, d: o.d,
                surf: o.surf, mir: o.mir, dMaxRel: o.dMaxRel, content: o.contentA });
  }
  return { what, stages, switchProven: onRan === 1 && offRan === 0,
           poses: poses.length, emptyFrames: empty,
           totalDiff: tot, totalCells: cells, pct: +(100 * tot / cells).toFixed(5),
           surfaceDiff: surf, mirrorDiff: mir,
           worst, rows };
};

/*----------------------------- 5. one-shot setup ---------------------------*/
GPUT.boot = (w, h) => {
  const a = GPUT.pin(w, h);
  const b = GPUT.drive();
  GPUT.prof();
  return { grid: a, driver: b,
           worldOK: !!(GL && GL.worldOK), spriteOK: !!(GL && GL.spriteOK) };
};

console.log('GPUT ready: boot(), measure(ms), blockAB(ms,blocks,what), parity(stages), parityS(stages)');
})();
