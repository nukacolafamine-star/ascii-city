/* ============================================================================
   PT.see — cheap, honest reads.

   Why this file exists: `__OBS.screen('only')` is documented as "the HUD
   alone" and is not.  The first-person BODY viewmodel (index.html 13h) is
   drawn through `hudCell` into `hGlyph`, so at a 206x106 grid a HUD read came
   back as 57 rows / ~7k tokens, of which 36 rows were the player's own arms.
   An agent pays for every one of those tokens and learns nothing from them.

   The fix is to stop reading the glyph buffer for things the engine will
   simply tell you.  `see()` reads the SOURCES - clock, district, prompt,
   toast, tracked quest, open mode - and costs about 200 tokens.  The glyph
   buffer is still there when you actually need to prove something rendered;
   `hud()` filters the texture out of it, `raw()` gives it to you unfiltered.
   ============================================================================ */
(() => {
const PT = window.PT;
const S = PT.see = function(){ return S.now(); };

/* ------------------------------------------------------------- helpers --- */
/* districtAt() gives the behaviour TYPE (D_DOWN..D_RED); the name the HUD
   prints is the REGION - a contiguous named place like MOSSBROOK. Report
   both: the region is what a human says, the type is what the code branches
   on. */
const D_TYPE = ['DOWN','STRIP','RES','IND','SUB','RURAL','RED'];
const where = () => {
  /* Indoors, cam.x/cam.y are the room's STAMPED coordinates near the array
     origin, not a place in the city - districtAt of those is meaningless and
     read 'RURAL' from inside a depot in the Smelters. reference.md's own rule:
     always qualify a position with its scene. */
  const sc = safe(() => netSceneId(), 'city');
  if (sc !== 'city') return 'interior ' + sc;
  const r = safe(() => regionAt(cam.x, cam.y), 255);
  const R2 = (typeof REGIONS !== 'undefined' && REGIONS[r]) ? REGIONS[r].name : null;
  const t = D_TYPE[safe(() => districtAt(cam.x, cam.y), -1)] || '?';
  return R2 ? R2 + ' (' + t + ')' : t;
};
const num = v => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(1) : v;
const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (e){ return 'ERR ' + e.message; } };

/* The tracked quest as the player sees it: name, which leg, the objective
   line (which is a FUNCTION on most stages and reads differently once you
   are carrying the thing), and where the marker is pointing. */
S.quest = () => {
  const id = player.track;
  if (!id || typeof player.quests[id] !== 'number'){
    const owed = safe(() => Object.keys(player.qvar.owed || {}), []);
    return owed.length ? { owed } : null;
  }
  const Q = QUESTS[id], si = player.quests[id], st = Q.stages[si];
  const t = safe(() => questTarget(), null);
  return {
    id, name: Q.name, stage: si + 1 + '/' + Q.stages.length,
    log: safe(() => questLog(st), '?'),
    to: t ? t.name + ' @' + (t.x|0) + ',' + (t.y|0) +
            ' d=' + Math.hypot(t.x - cam.x, t.y - cam.y).toFixed(0) : null
  };
};

/* Every quest the player is holding, not just the tracked one. */
/* A finished quest stores the STRING 'done', not a stage number, so
   `player.quests[id] + 1` renders as 'done1'. Branch on the type. */
S.quests = () => Object.keys(player.quests).map(id => {
  const v = player.quests[id];
  return id + ':' + QUESTS[id].name +
         (typeof v === 'number' ? ' #' + (v + 1) + '/' + QUESTS[id].stages.length : ' DONE') +
         (player.track === id ? ' <TRACKED' : '');
});

S.now = () => {
  const m = topMode();
  probeInteract();
  const t = safe(() => questTarget(), null);
  return {
    at: [num(cam.x), num(cam.y)], ang: num(cam.ang),
    scene: safe(() => netSceneId(), 'city'),
    dist: where(),
    time: safe(() => clockStr(), '?') + ' d' + dayCount,
    hp: player.hp, cr: player.credits, corr: player.corruption,
    wep: safe(() => weaponId(), '?'), ammo: safe(() => invCount('ammo'), 0),
    inv: player.inv.map(s => s.id + 'x' + s.qty),
    quest: S.quest(),
    /* what the crosshair is actually offering RIGHT NOW - the single most
       misread value in the game, because tryInteract acts on this and not
       on what you meant */
    prompt: lookTarget ? (lookTarget.kind + ': ' + lookTarget.prompt) : null,
    toast: (toastT > 0 && toastMsg) ? toastMsg : null,
    mode: m ? (m.name + (m.title ? ' "' + m.title + '"' : '') +
               (m.phase ? ' [' + m.phase + ']' : '')) : null,
    menu: (m && m.items) ? m.items.map((it, i) =>
            (i === m.cursor ? '>' : ' ') + (it.label || it.info || '---')) : null,
    /* the four states that read identically to "the game has frozen" */
    stuck: [sitting && 'sitting', skating && 'skating', cam.riding && 'riding',
            !isFinite(cam.x) && 'CAM NOT FINITE'].filter(Boolean),
    busy: PT.busy ? PT.busy() : null,
    fps: Math.round(typeof fps !== 'undefined' ? fps : 0)
  };
};

/* ============================ the glyph buffer ============================= */
/* A row of the ASCII world is mostly TEXTURE - long runs drawn from a tiny
   alphabet ('((nnn@@nnn@@nnn))', '|....++......,...@|').  A row of HUD text
   is not.  Distinct-character count separates them almost perfectly, and
   cheaply, without needing to know which pass drew what. */
const textish = (s) => {
  const v = s.trim();
  if (!v) return false;
  if (v.length < 20) return true;                 // short rows are labels
  return new Set(v.replace(/ /g, '')).size > 7;   // long rows must be varied
};

S.hud = (o) => {
  o = o || {};
  const rows = __OBS.screen('only').split('\n');
  const keep = [];
  for (let i = 0; i < rows.length; i++){
    if (!textish(rows[i])) continue;
    keep.push((o.rows ? String(i).padStart(3) + ' ' : '') + rows[i].replace(/\s{4,}/g, '   '));
  }
  return keep.join('\n') || '(no HUD text — HUD_BLANK is worth checking)';
};
S.raw = (o) => {
  o = o || {};
  const rows = __OBS.screen(o.layer || 'over').split('\n');
  const r0 = o.r0 || 0, r1 = o.r1 === undefined ? rows.length : o.r1;
  const c0 = o.c0 || 0, c1 = o.c1 === undefined ? 1e9 : o.c1;
  return rows.slice(r0, r1).map(r => r.slice(c0, c1)).join('\n');
};

/* ======================= waiting, without round trips ======================
   The expensive thing about driving this game from outside is not the game,
   it is the round trip: every "are we there yet" is a whole tool call.  The
   behaviours already run in the page at 60 Hz, so let the page do the
   waiting and hand back the answer once.

   `wait` resolves on a predicate.  `settle` resolves when the rig goes idle,
   which is what you want after almost every action. */
/* The driving tool has a HARD 30 s ceiling per probe: a promise that resolves
   later than that kills the call, and you lose the answer even though the
   behaviour in the page carried on fine (a 181-tile walk took 31.1 s and the
   probe died at 30 - the walk was already finished). So every wait here is
   clamped below the ceiling and returns `ok:false` honestly instead of
   hanging. For anything longer: start it, let the probe return, and poll. */
S.CAP = 25000;
S.wait = (pred, o) => {
  o = o || {};
  const ms = Math.min(o.ms || S.CAP, S.CAP), t0 = performance.now();
  return new Promise(res => {
    const check = () => {
      let v = false;
      try { v = pred(); } catch (e){ return res({ ok: false, why: 'pred threw: ' + e.message }); }
      if (v) return res({ ok: true, ms: Math.round(performance.now() - t0), val: v === true ? undefined : v });
      if (performance.now() - t0 > ms) return res({ ok: false, why: 'timeout ' + ms + 'ms', ms });
      setTimeout(check, o.every || 100);
    };
    check();
  });
};
/* idle = nothing the rig started is still running.  Note this is the RIG's
   idea of busy, not the game's: a mode the game opened by itself still
   counts as idle here, which is why callers check `mode` afterwards. */
S.settle = async (o) => {
  o = o || {};
  const r = await S.wait(() => {
    const b = PT.busy();
    return !b.nav && !b.attack && !b.loot && !b.reach && !b.talk && !b.shop && !b.drive;
  }, { ms: o.ms, every: 120 });
  return { settled: r.ok, waited: r.ms, why: r.why,
           ...(r.ok ? {} : { still: PT.busy(), nav: PT.nav.state() }),
           ...(o.quiet ? {} : { see: S.now() }) };
};
/* walk somewhere and come back with the result - one round trip, not six */
S.go = async (x, y, o) => {
  o = o || {};
  PT.nav.goto(x, y, o);
  const r = await S.settle({ ms: o.ms, quiet: true });
  return { nav: PT.nav.state(), settled: r.settled, waited: r.waited, see: S.now() };
};
S.goTo = S.go;
})();
'PT.see loaded';
