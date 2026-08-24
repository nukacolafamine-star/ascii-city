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
  every weather, renders each one twice - once with GPUW.on and once without -
  and compares gBuf/bBuf/lBuf/refBuf/srcBuf/dBuf cell by cell. Byte-identical
  is the bar until the GPU owns a pass; after that it is a stated fraction.
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
const PASSES = ['skyPass','ceilingPass','floorPass','wallPass','spritePass','signPass',
                'reflectPass','lampVolume','rainPass','harvestEmitters','hizBuild',
                'glWorldPass','worldPasses'];
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

/*------------------- 3. an A/B that interleaves inside one run -------------
  Absolute milliseconds on this machine drift by more than 2x - sometimes
  because the game is open in another window - so a run of A followed by a run
  of B compares two different machines. Alternate them frame by frame instead
  and report the ratio. */
GPUT.ab = (ms = 6000) => new Promise(res => {
  const P = GPUT.prof();
  const A = { t: 0, n: 0 }, B = { t: 0, n: 0 };     // A = switch on, B = switch off
  const was = GPUW.on;
  let flip = false;
  const wp = W.worldPasses;
  const spy = function(){
    flip = !flip;
    GPUW.on = flip;
    const t = performance.now();
    const r = wp.apply(this, arguments);
    const dt = performance.now() - t;
    const s = flip ? A : B;
    if (s.n >= 0){ s.t += dt; s.n++; }
    return r;
  };
  W.worldPasses = spy;
  setTimeout(() => {
    W.worldPasses = wp; GPUW.on = was;
    const a = A.t / Math.max(1, A.n), b = B.t / Math.max(1, B.n);
    res({ onMs: +a.toFixed(3), offMs: +b.toFixed(3),
          ratio: +(a / b).toFixed(4), savedMs: +(b - a).toFixed(3),
          frames: A.n + B.n, cells: R.cols * R.rows, sprites: statSprites });
  }, ms);
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
                              dMaxRel: 0, first: null };
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
    if (bad){ o.any++; if (!o.first) o.first = { i, x: i % R.cols, y: (i / R.cols) | 0,
                                                 A: [A.g[i], A.b[i], A.l[i], A.r[i], A.s[i], A.d[i]],
                                                 B: [B.g[i], B.b[i], B.l[i], B.r[i], B.s[i], B.d[i]] }; }
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
  return out;
};

const applyPose = (p) => {
  cam.x = p.x; cam.y = p.y; cam.z = p.z; cam.a = p.a; cam.pitch = p.pitch;
  W.clock = p.clock;
  W.weather = p.weather;
  // the palette and the lamp gate are both derived from the clock, and both
  // are settled once a frame - so settle them here or the pose is half-applied
  W.updateClock(0);
  W._lampNight = clamp((curTime().lit - 0.10) / 0.52, 0, 1);
};

/* One pose, rendered twice. render() is the real renderer - runFrame is the
   street race and draws nothing - and it must be called synchronously here so
   the buffers belong to the pose we just set rather than to the frame before. */
GPUT.parityOne = (p, stages) => {
  const wasOn = GPUW.on, wasSt = GPUW.stages, wasWet = W.wetLevel;
  applyPose(p);
  // a fixed reservoir level, or two renders a frame apart disagree about rain
  W.wetLevel = p.wet !== undefined ? p.wet : 0.6;
  GPUW.on = false; render(); const B = snap();
  applyPose(p); W.wetLevel = p.wet !== undefined ? p.wet : 0.6;
  GPUW.on = true; GPUW.stages = stages; render(); const A = snap();
  const ranA = GW.ran;
  GPUW.on = wasOn; GPUW.stages = wasSt; W.wetLevel = wasWet;
  const o = diff(A, B);
  o.contentA = content(A); o.contentB = content(B);
  o.pose = p;
  return o;
};

GPUT.parity = (stages = (typeof GPUW !== 'undefined' ? GPUW.stages : 1), poses) => {
  poses = poses || GPUT.poses();
  GPUT.pause(true);
  try { return parityRun(stages, poses); } finally { GPUT.pause(false); }
};
const parityRun = (stages, poses) => {
  // prove the switch switches: a flag being ignored produces perfect parity
  const before = GW.ran;
  GPUW.on = true; GPUW.stages = stages; render();
  const onRan = GW.ran - before;
  GPUW.on = false; render();
  const offRan = GW.ran - before - onRan;
  const rows = [];
  let worst = null, tot = 0, cells = 0, empty = 0;
  for (const p of poses){
    const o = GPUT.parityOne(p, stages);
    if (o.contentA < 200 || o.contentB < 200) empty++;
    tot += o.any; cells += o.cells;
    if (!worst || o.any > worst.any) worst = o;
    rows.push({ pose: [p.x | 0, p.y | 0, +p.a.toFixed(2), p.pitch, p.z, +p.clock.toFixed(1), p.weather],
                any: o.any, pct: o.pct, g: o.g, b: o.b, l: o.l, r: o.r, s: o.s, e: o.e, d: o.d,
                dMaxRel: o.dMaxRel, content: o.contentA });
  }
  return { stages, switchProven: onRan === 1 && offRan === 0,
           poses: poses.length, emptyFrames: empty,
           totalDiff: tot, totalCells: cells, pct: +(100 * tot / cells).toFixed(5),
           worst, rows };
};

/*----------------------------- 5. one-shot setup ---------------------------*/
GPUT.boot = (w, h) => {
  const a = GPUT.pin(w, h);
  const b = GPUT.drive();
  GPUT.prof();
  return { grid: a, driver: b, worldOK: !!(GL && GL.worldOK) };
};

console.log('GPUT ready: boot(), pin(), drive(), prof(), measure(ms), ab(ms), parity(stages)');
})();
