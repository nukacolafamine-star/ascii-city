/* ============================================================================
   PTV — visual instrumentation for the GPU renderer.  visual.js

   Load with PT.load(['visual.js']).  Everything lives under window.PTV.
   The design contract is the same as the rest of the rig: fast reflexes in
   the page (a watcher tick that runs at frame rate and accumulates), slow
   judgement outside (read PTV.report() on a check-in).

   What it watches, at frame rate, for free or nearly:
     - frame dt EMA and worst-of-window, per-pass ms (worldPasses / glPresent)
     - GI traced-history health every ~5s (non-finite texels, collapse,
       stuck average) — the "path tracing quietly died" class of bug
     - light-field collapse (attachment 0 near-zero at night with lights on)
     - pair budget overflow / trim / emitter count drift

   On-demand:
     - PTV.snap()          full GPU-state snapshot with texture stats
     - PTV.region(x,y,w,h) composed-canvas region stats (mean rgb, sat, hot)
     - PTV.ab(setA, setB)  in-window alternating-block A/B on the light field
     - PTV.pause(v)        gate the PT worker driver (clean screenshots)
     - PTV.grab()          PNG data-URL of the composed canvas, full-res
   ============================================================================ */
(() => {
const PTV = window.PTV = window.PTV || {};
PTV.version = '1.0';
PTV.findings = PTV.findings || [];
PTV.cfg = Object.assign({
  watchEvery: 300,      // frames between GI-history health reads (~5s)
  liteEvery:  60,       // frames between cheap (no-readback) checks
  giZeroFrac: 0.995,    // giTs this empty at night with GIR.on = collapsed
  keep: 40              // findings kept
}, PTV.cfg || {});

const F = (key, msg, data) => {
  const now = performance.now();
  PTV._seen = PTV._seen || {};
  if (PTV._seen[key] && now - PTV._seen[key] < 30000) return;  // rate limit 30s
  PTV._seen[key] = now;
  PTV.findings.push({ t: +((typeof worldTime !== 'undefined' ? worldTime : 0)).toFixed(1),
                      key, msg, data: data || null });
  if (PTV.findings.length > PTV.cfg.keep) PTV.findings.shift();
  if (window.PT && PT.say) PT.say('PTV ' + key + ' ' + msg);
};

/* ------------------------------------------------------------ pass timers --- */
PTV.t = PTV.t || {};
if (!PTV._timed){
  PTV._timed = true;
  for (const name of ['worldPasses', 'glPresent', 'render']){
    const orig = window[name];
    if (typeof orig !== 'function') continue;
    PTV.t[name] = { ema: 0, last: 0, max: 0, n: 0 };
    window[name] = function(){
      const t0 = performance.now();
      const r = orig.apply(this, arguments);
      const dt = performance.now() - t0;
      const T = PTV.t[name];
      T.last = dt; T.ema = T.ema ? T.ema * 0.95 + dt * 0.05 : dt;
      if (dt > T.max) T.max = dt; T.n++;
      return r;
    };
  }
}
PTV.timers = () => {
  const o = {};
  for (const k in PTV.t){ const T = PTV.t[k];
    o[k] = { ema: +T.ema.toFixed(2), last: +T.last.toFixed(2), max: +T.max.toFixed(2), n: T.n };
    T.max = 0; }                                  // max is per-report-window
  o.fps = Math.round(typeof fps !== 'undefined' ? fps : 0);
  return o;
};

/* ----------------------------------------------------- texture readbacks --- */
/* One scratch FBO, reused.  Reads force a sync (~1-16ms on a composited
   page) so nothing here runs more often than cfg.watchEvery frames. */
const texStats = (tex, w, h) => {
  const gl = GL.gl;
  if (!PTV._fb) PTV._fb = gl.createFramebuffer();
  const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, PTV._fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const N = w * h, buf = new Float32Array(N * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
  let mr = 0, mg = 0, mb = 0, ma = 0, bad = 0, zero = 0, mx = 0, sat = 0;
  for (let i = 0; i < N; i++){
    const r = buf[i*4], g = buf[i*4+1], b = buf[i*4+2], a = buf[i*4+3];
    if (!isFinite(r) || !isFinite(g) || !isFinite(b) || !isFinite(a)){ bad++; continue; }
    mr += r; mg += g; mb += b; ma += a;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi > mx) mx = hi;
    if (hi === 0) zero++; else sat += (hi - lo) / hi;
  }
  const nz = N - zero - bad;
  return { mean: [+(mr/N).toFixed(3), +(mg/N).toFixed(3), +(mb/N).toFixed(3)],
           meanA: +(ma/N).toFixed(3), max: +mx.toFixed(2), bad,
           zeroFrac: +(zero/N).toFixed(3),
           sat: nz > 0 ? +(sat/nz).toFixed(3) : 0, buf };
};
PTV.texStats = (tex, w, h) => { const s = texStats(tex, w, h); delete s.buf; return s; };

/* -------------------------------------------------------------- snapshot --- */
PTV.snap = (opts) => {
  opts = opts || {};
  const gl = GL.gl, W = R.cols, H = R.rows;
  const cur = GL.litIdx;
  const gi = texStats(GL.giTs[cur], W, H);   delete gi.buf;
  const li = texStats(GL.lightTs[cur], W, H); delete li.buf;
  return {
    grid: W + 'x' + H,
    cam: [+cam.x.toFixed(1), +cam.y.toFixed(1), +cam.ang.toFixed(2),
          +(cam.pitch || 0).toFixed(2)],
    clock: +clock.toFixed(2), weather: (typeof weather !== 'undefined') ? weather : null,
    gi, light: li,
    girOn: GIR.on, gpue: GPUE.on,
    pairs: GPUL.pairsUsed, pairsOver: GPUL.pairsOver, trimmed: GPUL.trimmed,
    emitN: (typeof EMIT !== 'undefined' && EMIT) ? (EMIT.n !== undefined ? EMIT.n : null) : null,
    timers: PTV.timers()
  };
};

/* -------------------------------------------------- composed-canvas reads --- */
/* The real output: the WebGL default framebuffer.  Region is in CANVAS pixels
   (origin top-left, like a screenshot); pass nothing for the whole frame.
   preserveDrawingBuffer is false, so this MUST run inside the frame - it
   queues itself and returns a promise resolved after the next present. */
PTV.region = (x, y, w, h) => new Promise((res) => {
  const cvs = GL.gl.canvas;
  x = x|0; y = y|0; w = (w || cvs.width - x)|0; h = (h || cvs.height - y)|0;
  PT.ticks.ptvRegion = () => {
    PT.ticks.ptvRegion = null;
    try {
      const gl = GL.gl, buf = new Uint8Array(w * h * 4);
      const glY = cvs.height - y - h;                    // GL origin bottom-left
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, glY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let mr = 0, mg = 0, mb = 0, sat = 0, hot = 0, dark = 0; const N = w * h;
      for (let i = 0; i < N; i++){
        const r = buf[i*4], g = buf[i*4+1], b = buf[i*4+2];
        mr += r; mg += g; mb += b;
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        if (hi > 235) hot++;
        if (hi < 12) dark++;
        if (hi > 0) sat += (hi - lo) / hi;
      }
      res({ x, y, w, h, mean: [Math.round(mr/N), Math.round(mg/N), Math.round(mb/N)],
            sat: +(sat/N).toFixed(3), hotFrac: +(hot/N).toFixed(4),
            darkFrac: +(dark/N).toFixed(3) });
    } catch (e){ res({ err: String(e) }); }
  };
});

/* Full-frame PNG of the composed canvas, driver paused or not.  ~200KB.
   Same in-frame constraint as region(). */
PTV.grab = (scale) => new Promise((res) => {
  PT.ticks.ptvGrab = () => {
    PT.ticks.ptvGrab = null;
    try {
      const src = GL.gl.canvas, s = scale || 0.5;
      const c = document.createElement('canvas');
      c.width = (src.width * s)|0; c.height = (src.height * s)|0;
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      res(c.toDataURL('image/png'));
    } catch (e){ res('ERR ' + e); }
  };
});

/* ------------------------------------------------------------- A/B blocks --- */
/* Alternating blocks inside ONE window, because absolute light numbers minutes
   apart are incomparable (window churn re-rolls litP).  setA/setB are
   functions that flip the thing under test.  Measures the light texture
   (attachment 0) mean and the frame dt, blockFrames each side, reps times.
   Runs detached: returns immediately, park on PTV.abResult. */
PTV.ab = (setA, setB, opts) => {
  opts = opts || {};
  const blockFrames = opts.blockFrames || 45, reps = opts.reps || 4;
  const skip = opts.skip || 15;               // settle frames after each flip
  const st = PTV._ab = { phase: 0, f: 0, rep: 0, a: [], b: [], adt: [], bdt: [],
                         done: false };
  PTV.abResult = null;
  const gl = GL.gl, W = R.cols, H = R.rows;
  const meanOf = () => {
    const s = texStats(GL.lightTs[GL.litIdx], W, H);
    return (s.mean[0] + s.mean[1] + s.mean[2]) / 3;
  };
  let acc = 0, accDt = 0, n = 0;
  setA(); let inA = true;
  PT.ticks.ptvAB = (dt) => {
    st.f++;
    if (st.f <= skip) return;
    accDt += dt * 1000; n++;
    if (st.f - skip >= blockFrames){
      acc = meanOf();                          // one read per block, at its end
      (inA ? st.a : st.b).push(acc);
      (inA ? st.adt : st.bdt).push(accDt / n);
      st.f = 0; acc = 0; accDt = 0; n = 0;
      if (inA){ setB(); inA = false; }
      else {
        st.rep++;
        if (st.rep >= reps){
          PT.ticks.ptvAB = null; st.done = true;
          const avg = a => a.reduce((x,y)=>x+y,0) / a.length;
          PTV.abResult = {
            aLight: +avg(st.a).toFixed(4), bLight: +avg(st.b).toFixed(4),
            aMs: +avg(st.adt).toFixed(2),  bMs: +avg(st.bdt).toFixed(2),
            reps, blockFrames,
            aRuns: st.a.map(v=>+v.toFixed(4)), bRuns: st.b.map(v=>+v.toFixed(4))
          };
          setA();                              // leave the world in state A
          return;
        }
        setA(); inA = true;
      }
    }
  };
  return 'AB running — read PTV.abResult';
};

/* ------------------------------------------------------------ driver pause --- */
PTV.pause = (v) => {
  PTV._paused = !!v;
  if (!PTV._pauseHooked && PT._worker){
    PTV._pauseHooked = true;
    const old = PT._worker.onmessage;
    PT._worker.onmessage = (e) => { if (PTV._paused) return; old(e); };
  }
  return PTV._paused ? 'paused' : 'running';
};

/* ---------------------------------------------------------- the watcher --- */
/* Named tick, redefined freely on reload.  Cheap checks every liteEvery
   frames; the GI-history readback every watchEvery frames. */
let lite = 0, heavy = 0;
PT.ticks.ptvWatch = () => {
  if (typeof GL === 'undefined' || !GL.lightOK) return;
  if (++lite >= PTV.cfg.liteEvery){
    lite = 0;
    if (GPUL.pairsOver > 0) F('PAIR_OVER', 'tile pair budget blew: ' + GPUL.pairsOver + ' over');
    if (GPUL.trimmed > 0)   F('PAIR_TRIM', GPUL.trimmed + ' lights trimmed on overflow');
    const wp = PTV.t.worldPasses;
    if (wp && wp.last > 14) F('FRAME_SPIKE', 'worldPasses ' + wp.last.toFixed(1) + 'ms',
                              { ema: +wp.ema.toFixed(2) });
  }
  if (++heavy >= PTV.cfg.watchEvery){
    heavy = 0;
    /* Interiors take the CPU light path (glLightPass early-outs on
       `inside`), and a scene swap or respawn reallocates the textures -
       both leave the light attachment legitimately dim, and both fired
       LIGHT_COLLAPSED false alarms in the first soak. Skip the sample. */
    if (typeof inside !== 'undefined' && inside) return;
    const gk = R.cols + 'x' + R.rows;
    if (PTV._lastGrid !== gk){ PTV._lastGrid = gk; return; }
    try {
      const W = R.cols, H = R.rows;
      const gi = texStats(GL.giTs[GL.litIdx], W, H); delete gi.buf;
      /* the engine's own lamp gate, not a clock threshold - the city
         legitimately goes near-dark in the small hours as litP thins,
         and clocks DRIFT between multiplayer clients */
      const night = (typeof _lampNight !== 'undefined' ? _lampNight : 1) > 0.5;
      if (gi.bad > 0)
        F('GI_HISTORY_BAD', gi.bad + ' non-finite texels in traced history', gi);
      else if (GIR.on && night && gi.zeroFrac > PTV.cfg.giZeroFrac)
        F('GI_COLLAPSED', 'traced history ~empty at night with GIR on', gi);
      PTV.giLast = gi;                        // latest health, for report()
      const li = texStats(GL.lightTs[GL.litIdx], W, H); delete li.buf;
      /* threshold well under the deep-night floor: 3-5am measured ~0.01
         mean legitimately (the city sleeps); a truly dead pass reads 0.
         And only where lights EXIST - the rural north edge at night is
         genuinely black, and filed itself as a bug twice. */
      const lamped = (typeof EMIT !== 'undefined' && EMIT && EMIT.n > 150);
      if (night && GPUE.on && lamped &&
          li.mean[0] + li.mean[1] + li.mean[2] < 0.0008)
        F('LIGHT_COLLAPSED', 'light field ~zero at night with city light on', li);
      PTV.lightLast = li;
    } catch (e){ F('PTV_ERR', String(e)); }
  }
};

PTV.report = (clear) => {
  const out = { timers: PTV.timers(), gi: PTV.giLast || null, light: PTV.lightLast || null,
                findings: PTV.findings.slice() };
  if (clear) PTV.findings.length = 0;
  return out;
};

if (window.PT && PT.say) PT.say('visual.js loaded — PTV v' + PTV.version);
})();
'PTV loaded';
