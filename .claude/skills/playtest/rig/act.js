/* ============================================================================
   PT.act — doing things, always through the game's own layers.

   The rule this file exists to enforce: `tryInteract()` acts on whatever
   `lookTarget` currently is, which is the highest-scoring thing in the cone -
   not what you meant.  Facing a shopkeeper while intending to leave a room
   opens a conversation.  So every interaction here asserts on the prompt text
   first and REFUSES rather than guessing.

   The second thing it exists for is `reach()`.  Walking to a thing and being
   able to interact with it are different problems: the probe wants you inside
   3.6 tiles, in a 0.82 cone, with line of sight, and NOT looking at something
   that outscores it.  reach() solves the whole sentence.
   ============================================================================ */
(() => {
const PT = window.PT;
const A = PT.act = PT.act || {};
const N = PT.nav;
PT.state = PT.state || {};

/* ============================== 1. THE PROBE =============================== */
A.face = (x, y) => N.face(x, y);

A.look = () => {
  probeInteract();
  if (!lookTarget) return null;
  return {
    kind: lookTarget.kind,
    prompt: lookTarget.prompt,
    name: lookTarget.a ? lookTarget.a.name
        : lookTarget.p ? (lookTarget.p.item || ('prop' + lookTarget.p.k))
        : lookTarget.door ? lookTarget.door.name : null,
    raw: lookTarget
  };
};
A.aimAt = (x, y) => { A.face(x, y); return A.look(); };

/* Does the probe currently hold THIS thing?  Props, actors, doors and peds
   are each held on a different key of lookTarget. */
/* The last clause here used to be `lookTarget.p === t.p`, which is
   `undefined === undefined` whenever the probe holds an ACTOR (no `.p`) and
   you ask about another actor (also no `.p`) - so it answered TRUE for every
   target in the room. That defeated the one guard rail this file exists to
   provide: `reach()` completed on whoever was actually under the crosshair
   while reporting the target you asked for, and with `use:true` it opened
   them. Asking for VESPER opened ROOK, who was 0.7 tiles closer.
   Listings from actorsNear/itemsNear/furnNear are wrappers carrying the live
   object on a non-enumerable `.ref`; resolve that, and never compare two
   undefineds. */
A.holds = (t) => {
  if (!lookTarget || !t) return false;
  const want = t.ref || t;
  return lookTarget.p === want || lookTarget.a === want || lookTarget.door === want;
};

/* Interact, but only if the prompt says what you expect. */
A.use = (want) => {
  probeInteract();
  if (!lookTarget) return PT.say('use: nothing under the crosshair');
  const p = lookTarget.prompt;
  if (want && p.indexOf(want) < 0)
    return PT.say('use: REFUSED — prompt reads "' + p + '", wanted "' + want + '"');
  tryInteract();
  return PT.say('use: ' + p);
};

/* ============================== 2. MENUS =================================== */
A.mode = () => {
  const m = topMode();
  if (!m) return null;
  return {
    name: m.name, title: m.title, phase: m.phase, cursor: m.cursor,
    items: (m.items || []).map((it, i) =>
      i + ':' + (it.label || it.info || '---') +
      (it.value ? ' [' + (typeof it.value === 'function' ? it.value() : it.value) + ']' : ''))
  };
};

/* Walk the cursor to a label and press Enter.
   The label is captured BEFORE the press: reading it afterwards touches a
   menu that Enter may already have closed, which throws. */
/* Matching a row by bare substring is not safe in this game's menus.
   `pick('FLOOR 1')` in a stairwell listing FLOOR 11 / FLOOR 9 / FLOOR 1 stops
   on "FLOOR 11 - top", because that contains "FLOOR 1" - and the rig then
   cheerfully reports it picked what you asked for while standing on the wrong
   storey. The same collision is waiting in every bet ladder (BET 10 / BET 100)
   and every numbered list.
   So: score the rows, take an exact match first, then a match at a word
   boundary, and only then a loose substring - and refuse when a loose match
   is ambiguous rather than guessing. */
A.matchRow = (items, want) => {
  const W = String(want).toUpperCase().trim();
  const labs = items.map(it => String(it && it.label || '').toUpperCase().trim());
  let i = labs.indexOf(W);
  if (i >= 0) return { i, how: 'exact' };
  const bound = [];
  for (let k = 0; k < labs.length; k++){
    const at = labs[k].indexOf(W);
    if (at < 0) continue;
    const after = labs[k][at + W.length];
    if (after === undefined || !/[A-Z0-9]/.test(after)) bound.push(k);
  }
  if (bound.length === 1) return { i: bound[0], how: 'word-boundary' };
  if (bound.length > 1) return { i: bound[0], how: 'word-boundary', ambiguous: bound.map(k => labs[k]) };
  const loose = [];
  for (let k = 0; k < labs.length; k++) if (labs[k] && labs[k].indexOf(W) >= 0) loose.push(k);
  if (loose.length === 1) return { i: loose[0], how: 'substring' };
  if (loose.length > 1) return { i: -1, how: 'ambiguous', ambiguous: loose.map(k => labs[k]) };
  return { i: -1, how: 'none' };
};

A.pick = (label, press) => {
  const m = topMode();
  if (!m || !m.items) return PT.say('pick: no list menu open');
  const hit = A.matchRow(m.items, label);
  if (hit.i < 0)
    return PT.say('pick: "' + label + '" ' +
      (hit.how === 'ambiguous' ? 'matches several rows - ' + hit.ambiguous.join(' | ')
                               : 'not in this menu'));
  const at = () => { const t = topMode(); return (t && t.items && t.items[t.cursor]) || null; };
  let guard = 0;
  const n = m.items.length * 2 + 2;
  while (topMode() && topMode().cursor !== hit.i && guard++ < n) PT.tap('ArrowDown');
  const row = at();
  const chose = (row && row.label) || '';
  /* menuMove skips separators and info rows, so a target index can be one the
     cursor is not allowed to occupy - say so instead of pressing blindly */
  if (!topMode() || topMode().cursor !== hit.i)
    return PT.say('pick: could not land on "' + label + '" (cursor stuck at ' +
                  (topMode() ? topMode().cursor : '?') + ' on "' + chose + '")');
  if (press !== false) PT.tap('Enter');
  return PT.say('pick: ' + chose + ' [' + hit.how +
                (hit.ambiguous ? ' AMBIGUOUS: ' + hit.ambiguous.join(' | ') : '') + ']');
};

/* Menus refuse an Escape that arrives within ~250 ms of them opening - a
   deliberate anti-misclick guard.  Spamming fifteen presses inside one probe
   therefore closes NOTHING: every one lands inside the guard window.  Press
   once, then keep pressing on a slow tick until the stack is empty. */
PT.state.escc = PT.state.escc || { on: 0 };
PT.ticks.esc = function(dt){
  const E = PT.state.escc; if (!E.on) return;
  E.cd -= dt; if (E.cd > 0) return;
  E.cd = 0.35;                                   // comfortably past the guard
  if (!topMode()){ E.on = 0; return; }
  PT.tap('Escape');
  if (++E.n > 14){ E.on = 0; PT.say('esc: "' + topMode().name + '" will not close'); }
};
A.esc = () => {
  if (topMode()) PT.tap('Escape');
  PT.state.escc = { on: 1, cd: 0.35, n: 0 };     // and keep at it in the background
  return topMode() ? topMode().name : null;
};
A.escNow = () => { let g = 0; while (topMode() && g++ < 4) PT.tap('Escape');
                   return topMode() ? topMode().name : null; };

/* ============================== 3. DOORS =================================== */
A.doorsOf = (bld) => doors.filter(d => d.b === bld);
A.doorNear = (r) => doors.filter(d => Math.hypot(d.x - cam.x, d.y - cam.y) < (r || 2.0))
                         .sort((a, b) => Math.hypot(a.x-cam.x,a.y-cam.y) - Math.hypot(b.x-cam.x,b.y-cam.y))[0];

/* Enter through the probe, and handle the two prompts a door can wear:
   ENTER, and FOR SALE for a building that also carries a home listing. */
A.enter = () => {
  probeInteract();
  if (lookTarget && lookTarget.kind === 'door'){ tryInteract(); return PT.say('entered -> ' + netSceneId()); }
  if (lookTarget && lookTarget.kind === 'buyhome'){
    tryInteract();
    if (topMode()) A.pick('STEP INSIDE');
    return PT.say('entered past a FOR SALE sign -> ' + netSceneId());
  }
  const d = A.doorNear(1.9);
  if (!d) return PT.say('enter: no door within reach, probe holds ' + (lookTarget ? lookTarget.kind : 'nothing'));
  enterInterior(d);
  return PT.say('enterInterior b' + d.b + ' -> ' + netSceneId());
};
A.leave = () => { if (typeof exitInterior === 'function') exitInterior();
                  return PT.say('exitInterior -> ' + netSceneId()); };

/* ============================== 4. WHAT IS AROUND ========================== */
const dist = o => Math.hypot(o.x - cam.x, o.y - cam.y);
/* `ref` is the live object, kept for code and hidden from JSON: a listing of
   the crowd with refs enumerable stringifies to kilobytes of pathfinding. */
const withRef = (o, r) => { Object.defineProperty(o, 'ref', { value: r, enumerable: false }); return o; };
A.actorsNear = (r) => actors
  .filter(a => actorHere(a) && dist(a) < (r || 10))
  .map(a => withRef({ name: a.name, hp: a.hp, max: a.maxHp, brain: a.brain,
               d: +dist(a).toFixed(2), iidx: a.iidx, id: a.id }, a))
  .sort((p, q) => p.d - q.d);
A.pedsNear = (r) => (typeof gridQuery === 'function'
  ? gridQuery(pedGrid, cam.x, cam.y, r || 8, []).filter(p => !p.off) : [])
  .map(p => withRef({ name: p.ident && p.ident.name, d: +dist(p).toFixed(2), i: peds.indexOf(p) }, p))
  .sort((a, b) => a.d - b.d).slice(0, 10);
A.itemsNear = (r) => props
  .filter(p => p.k === PK_ITEM && dist(p) < (r || 12))
  .map(p => withRef({ item: p.item, price: p.price || 0, cval: p.cval, key: p.key,
               d: +dist(p).toFixed(2) }, p))
  .sort((a, b) => a.d - b.d);
A.furnNear = (r, fid) => props
  .filter(p => p.k === PK_FURN && (!fid || p.fid === fid) && dist(p) < (r || 12))
  .map(p => withRef({ fid: p.fid, d: +dist(p).toFixed(2) }, p))
  .sort((a, b) => a.d - b.d);
A.peers = () => PLAYERS.filter(p => !p.local).map(p => withRef({
  id: p.id, name: p.name, hp: p.hp, dead: !!p.dead, scene: p.sceneId,
  here: p.sceneId === netSceneId(),
  d: +Math.hypot(p.cam.x - cam.x, p.cam.y - cam.y).toFixed(2) }, p));

/* itemsNear/furnNear cover PK_ITEM and PK_FURN, which left every other prop
   class unreachable - most importantly PK_CAM, the flock of street cameras
   that three separate jobs (mq3, mq15, quiet) ask you to cut. A camera is a
   prop with `k === PK_CAM`, cut through the probe as `kind:'cut'`, and one
   already cut carries `dead = 1` - the stump stays as proof, so a finder that
   does not filter on it will send you back to the same dead camera forever. */
A.propsNear = (k, r, o) => {
  o = o || {};
  return props
    .filter(p => p.k === k && (o.dead || !p.dead) && dist(p) < (r || 40))
    .map(p => withRef({ k: p.k, item: p.item, fid: p.fid, dead: !!p.dead,
                        d: +dist(p).toFixed(2), at: [p.x | 0, p.y | 0] }, p))
    .sort((a, b) => a.d - b.d);
};
A.camsNear = (r) => A.propsNear(typeof PK_CAM !== 'undefined' ? PK_CAM : -1, r || 60);

/* Cut cameras until `n` of them are down, reporting the ENGINE's counter
   (qvar.camCut) rather than the number of times a key was pressed. */
A.cutCams = async (n, o) => {
  o = o || {};
  n = n || 3;
  const c0 = player.qvar.camCut || 0, done = [], skipped = [];
  for (let i = 0; i < n * 4 && (player.qvar.camCut || 0) - c0 < n; i++){
    const c = A.camsNear(o.within || 80)[0];
    if (!c){ return { ok: false, why: 'no live camera within ' + (o.within || 80) + ' tiles',
                      cut: (player.qvar.camCut || 0) - c0, done }; }
    A.reach(c.ref, { kind: 'cut' });
    await PT.see.settle({ ms: 20000, quiet: true });
    const st = A.reachState();
    if (!st.done){ skipped.push(c.at + ' ' + (st.fail || 'unreached')); c.ref.dead = c.ref.dead; 
                   /* do not spin on one we cannot line up on */
                   if (skipped.length > n + 3) break;
                   continue; }
    const before = player.qvar.camCut || 0;
    A.use('CUT');
    await new Promise(r => setTimeout(r, 300));
    if ((player.qvar.camCut || 0) > before) done.push(c.at);
    else skipped.push(c.at + ' prompt="' + (st.prompt || '?') + '"');
  }
  return { ok: (player.qvar.camCut || 0) - c0 >= n,
           cut: (player.qvar.camCut || 0) - c0, done, skipped };
};

/* Find a building by use, skipping the ones the game itself refuses to route
   to.  d.sealed is set by openSealedDoors() for doorsteps the street cannot
   reach, and every routing function in the game honours it - so should we. */
A.findBuildings = (use, o) => {
  o = o || {};
  const bl = (typeof CITY !== 'undefined' && CITY) ? CITY.buildings : buildings;
  const out = [];
  for (const b of bl){
    if (buildingUse(b) !== use) continue;
    const d = doors.filter(q => q.b === b.id)[0];
    if (!d || d.sealed) continue;
    const dd = Math.hypot(d.x - cam.x, d.y - cam.y);
    if (o.within && dd > o.within) continue;
    out.push({ id: b.id, use, door: [+d.x.toFixed(1), +d.y.toFixed(1)], d: +dd.toFixed(0),
               area: (b.x1 - b.x0) * (b.y1 - b.y0) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, o.limit || 8);
};

/* ============================== 5. COMBAT ================================== */
A.equip = (id) => { equipWeapon(id); return PT.say('equip ' + id + ' -> ' + weaponId()); };
A.armed = () => {
  const G = GUNS[weaponId()];
  return !!G && invCount(weaponId()) > 0 && invCount('ammo') > 0;
};
A.reachOf = () => A.armed() ? Math.min(GUNS[weaponId()].range, 16) : meleeStats().reach;

const AT = PT.state.attack = PT.state.attack || { on: 0 };
/* Attack until the target is gone or the swing budget runs out.  Closing the
   gap uses closeOn, not "hold forward": a counter between you and a keeper is
   a solid tile, and walking into it forever is how a rig looks stuck. */
PT.ticks.attack = function(dt){
  if (!AT.on) return;
  /* Death is checked BEFORE the mode gate, and that order is the whole point.
     Dying pushes the 'dead' mode, so a tick that returns early on topMode()
     never reaches its own hp check - the behaviour stays `on` for the rest of
     the session, PT.busy() reports attack:true forever, and every later
     PT.see.settle() hangs until it times out. A rig that cannot tell you it
     has stopped is worse than one that never started. */
  if (player.hp <= 0){ AT.on = 0; PT.nav.stop(); PT.say('attack: I am down after ' + AT.hits + ' hits'); return; }
  if (topMode()) return;
  const t = AT.tgt;
  /* Three kinds of body, three ways of being gone: a peer leaves PLAYERS or
     goes dead, an actor leaves `actors`, and a pedestrian is never IN actors -
     it goes `off`, or its hp comes back undefined once the host recycles it. */
  const gone = t && (t.player ? (t.player.dead || t.player.hp <= 0 || PLAYERS.indexOf(t.player) < 0)
                   /* A pedestrian is never removed - the crowd recycles the
                      same object to a fresh spot. pedDown clears hp, so after
                      at least one landed hit that is the only honest "dead". */
                   : t.pid !== undefined ? (t.off || peds.indexOf(t) < 0 ||
                                            (AT.hits > 0 && t.hp === undefined))
                   : actors.indexOf(t) < 0);
  if (gone){ AT.on = 0; PT.nav.stop(); PT.say('attack: ' + AT.label + ' DOWN after ' + AT.hits + ' hits'); return; }
  if (AT.n <= 0){ AT.on = 0; PT.nav.stop(); PT.say('attack: budget spent, ' + AT.hits + ' hits'); return; }
  if (!t){ AT.on = 0; return; }
  AT.t = (AT.t || 0) + dt;
  if (AT.t > (AT.timeout || 60)){ AT.on = 0; PT.nav.stop(); PT.say('attack: TIMEOUT'); return; }

  const tx = t.player ? t.player.cam.x : t.x, ty = t.player ? t.player.cam.y : t.y;
  const d = Math.hypot(tx - cam.x, ty - cam.y);
  const reach = A.reachOf();
  if (d > reach - (A.armed() ? 1.5 : 0.25)){
    if (!N.busy()){
      if (AT.closes++ > 6){ AT.on = 0; PT.say('attack: cannot reach ' + AT.label + ' (d=' + d.toFixed(2) + ', reach=' + reach.toFixed(2) + ')'); return; }
      N.closeOn(tx, ty, Math.max(0.9, reach - 0.4), { run: d > 8, timeout: 25 });
    }
    return;
  }
  N.stop();
  A.face(tx, ty);
  const ready = A.armed() ? (shotCool <= 0) : (typeof punchT === 'undefined' || punchT <= 0);
  if (ready){ fireWeapon(); AT.n--; AT.hits++; }
};
/* A gun you cannot feed is worse than no gun: `fireWeapon()` with a pistol
   equipped and zero ammo is a SILENT no-op - no toast, no cooldown, nothing
   in the event stream. A rig that does not check this closes to melee range,
   swings its whole budget, lands nothing, and reports "budget spent, 0 hits",
   which is indistinguishable from a combat bug. Check the magazine, and say
   so out loud. */
A.checkWeapon = () => {
  const id = weaponId();
  const G = GUNS[id];
  if (!G) return { ok: true, mode: 'melee', wep: id, reach: meleeStats().reach };
  if (invCount('ammo') > 0) return { ok: true, mode: 'gun', wep: id, ammo: invCount('ammo'), reach: Math.min(G.range, 16) };
  return { ok: false, mode: 'DRY', wep: id, ammo: 0,
           why: id + ' is equipped with 0 ammo - fireWeapon() is a silent no-op. ' +
                'equip("fist") or buy ammo at a counter signed ARMS.' };
};

A.attack = (target, n, o) => {
  o = o || {};
  const chk = A.checkWeapon();
  if (!chk.ok && !o.dry){
    if (o.fists !== false){ A.equip('fist'); PT.say('attack: ' + chk.why + ' -> switched to fists'); }
    else return PT.say('attack: REFUSED - ' + chk.why);
  }
  const label = target && (target.name || (target.player && ('PEER ' + target.player.id)) || 'target');
  Object.assign(AT, { on: 1, tgt: target, n: n || 12, hits: 0, closes: 0, t: 0,
                      timeout: o.timeout || 60, label });
  return PT.say('attack ' + label + ' x' + (n || 12) + ' as ' + weaponId());
};
A.attackPeer = (id, n, o) => {
  const q = PLAYERS.find(p => p.id === id && !p.local);
  if (!q) return PT.say('attackPeer: no peer ' + id);
  return A.attack({ player: q, name: 'PEER ' + id }, n, o);
};
A.attackStop = () => { AT.on = 0; N.stop(); return 'attack off'; };

/* ============================== 6. LOOT ==================================== */
const LT = PT.state.loot = PT.state.loot || { on: 0 };
PT.ticks.loot = function(dt){
  if (!LT.on) return;
  if (player.hp <= 0){ LT.on = 0; PT.say('loot: down, took ' + LT.took); return; }
  if (topMode()) return;
  if (N.busy()) return;
  let p = LT.cur;
  if (!p || props.indexOf(p) < 0){
    p = props.filter(q => q.k === PK_ITEM && (!LT.freeOnly || !q.price) && LT.skip.indexOf(q) < 0)
             .sort((a, b) => dist(a) - dist(b))[0];
    LT.cur = p;
    if (!p){ LT.on = 0; PT.say('loot: done, took ' + LT.took); return; }
    LT.tries = 0;
  }
  const d = dist(p);
  A.face(p.x, p.y);
  probeInteract();
  if (lookTarget && lookTarget.p === p){
    const pr = lookTarget.prompt;
    tryInteract();
    const gone = props.indexOf(p) < 0;
    if (gone) LT.took++; else LT.skip.push(p);
    PT.say('loot ' + pr + (gone ? '' : '  [no-op]'));
    LT.cur = null;
    return;
  }
  if (++LT.tries > 3){ LT.skip.push(p); LT.cur = null; PT.say('loot: cannot see ' + p.item + ' at d=' + d.toFixed(2)); return; }
  N.closeOn(p.x, p.y, 1.4, { timeout: 20 });
};
A.lootAll = (freeOnly) => {
  Object.assign(LT, { on: 1, cur: null, took: 0, tries: 0, skip: [], freeOnly: freeOnly !== false });
  return PT.say('lootAll (' + (freeOnly !== false ? 'free only' : 'including priced') + ')');
};
A.lootStop = () => { LT.on = 0; return 'loot off'; };

/* ============================== 7. REACH =================================== */
/* Walk to a thing and keep working until the probe actually offers it.
   Handles the case that cost the most time in play: something else outscores
   your target in the cone (a stairwell over a shopkeeper, a dropped item over
   a work station), which only a small sidestep fixes. */
const RE = PT.state.reach = PT.state.reach || { on: 0 };
PT.ticks.reach = function(dt){
  if (!RE.on) return;
  if (player.hp <= 0){ RE.on = 0; RE.fail = 'down'; PT.say('reach: down'); return; }
  if (topMode()) return;
  if (N.busy()) return;
  const t = RE.tgt;
  if (!t || (t.k !== undefined && props.indexOf(t) < 0) || (t.name && t.hp !== undefined && actors.indexOf(t) < 0)){
    RE.on = 0; RE.fail = 'target gone'; PT.say('reach: target gone'); return;
  }
  const tx = t.x !== undefined ? t.x : t.cam.x, ty = t.y !== undefined ? t.y : t.cam.y;
  A.face(tx, ty); probeInteract();
  /* `want` matches the PROMPT, `kind` matches lookTarget.kind. Prefer kind:
     prompt wording varies where you would not expect it - a freight station
     reads '[E]  HAUL FREIGHT - 6h, +84 cr' and contains no the word 'SHIFT'
     at all, so want:'SHIFT' can never match one. */
  if (A.holds(t) && (!RE.want || lookTarget.prompt.indexOf(RE.want) >= 0)
                 && (!RE.kind || lookTarget.kind === RE.kind)){
    RE.on = 0; RE.done = true;
    RE.prompt = lookTarget.prompt;
    PT.say('reach: got it — ' + lookTarget.prompt);
    if (RE.thenUse) tryInteract();
    return;
  }
  RE.tries = (RE.tries || 0) + 1;
  const d = Math.hypot(tx - cam.x, ty - cam.y);
  if (d > 3.0){ N.closeOn(tx, ty, 2.4, { timeout: 30, run: d > 10 }); return; }
  /* in range but something else owns the crosshair: sidestep */
  const off = [[0,0.8],[0,-0.8],[0.8,0],[-0.8,0],[0.8,0.8],[-0.8,0.8],[0.8,-0.8],[-0.8,-0.8]][RE.tries % 8];
  const nx = cam.x + off[0], ny = cam.y + off[1];
  if (!blockedAt(nx, ny, cam.rad)) N.walk([[nx, ny]], { timeout: 8 });
  if (RE.tries > 16){ RE.on = 0; RE.fail = 'shadowed'; PT.say('reach: gave up — probe kept holding ' + (lookTarget ? lookTarget.kind : 'nothing')); }
};
A.reach = (target, o) => {
  o = o || {};
  Object.assign(RE, { on: 1, tgt: target, want: o.want || null, kind: o.kind || null,
                      thenUse: !!o.use, tries: 0, done: false, fail: null, prompt: null });
  return PT.say('reach ' + (target.name || target.item || target.fid || 'target') + (o.want ? ' for "' + o.want + '"' : ''));
};
A.reachState = () => ({ on: !!RE.on, done: !!RE.done, fail: RE.fail, prompt: RE.prompt });

/* ============================== 8. TALKING AND TRADE ======================= */
/* Dialogue swallows the first Space if the option list changed within 450 ms -
   a deliberate anti-misclick guard.  So: open, wait a beat, press once,
   verify.  Never double-tap; the second press lands on whatever the cursor
   moved to and can pick "Just watching" instead of "Deal me in". */
const TK = PT.state.talk = PT.state.talk || { on: 0 };
PT.ticks.talk = function(dt){
  if (!TK.on) return;
  TK.cd -= dt; if (TK.cd > 0) return;
  TK.cd = 0.5;
  const m = topMode();
  if (!m){
    if (TK.opened){ TK.on = 0; PT.say('talk: dialogue closed'); return; }
    if (N.busy()) return;
    A.face(TK.who.x, TK.who.y); probeInteract();
    if (lookTarget && lookTarget.kind === 'actor' && lookTarget.a === TK.who){ tryInteract(); TK.opened = 1; return; }
    if (++TK.miss > 10){ TK.on = 0; PT.say('talk: could not get ' + TK.who.name + ' in the crosshair'); return; }
    N.closeOn(TK.who.x, TK.who.y, 2.4, { timeout: 20 });
    return;
  }
  if (m.name === 'dialog'){
    if (!TK.pick){ TK.on = 0; PT.say('talk: open on ' + m.title); return; }
    PT.tap('Space');                       // one press, then look
    return;
  }
  TK.on = 0; PT.say('talk: reached ' + m.name);
};
A.talk = (who, o) => {
  o = o || {};
  Object.assign(TK, { on: 1, who, opened: 0, miss: 0, cd: 0, pick: o.pick !== false });
  return PT.say('talk to ' + who.name);
};

/* Buy a shopping list.  Repeats an entry until it stops costing credits, so
   'AMMO' x40 buys ammo until the stack or the wallet runs out. */
const SH = PT.state.shop = PT.state.shop || { on: 0 };
PT.ticks.shop = function(dt){
  if (!SH.on) return;
  SH.cd -= dt; if (SH.cd > 0) return;
  SH.cd = 0.2;
  const m = topMode();
  if (!m){ SH.on = 0; PT.say('shop: no menu, stopped'); return; }
  if (m.name === 'buyhome'){ A.pick('STEP INSIDE'); return; }
  if (m.name === 'dialog'){ PT.tap('Space'); return; }
  if (m.name !== 'shop'){ SH.on = 0; PT.say('shop: unexpected mode ' + m.name); return; }
  if (!SH.list.length){
    A.esc(); SH.on = 0;
    PT.say('shop: done, spent ' + (SH.cr0 - player.credits) + ' cr, carrying ' +
           player.inv.map(s => s.id + 'x' + s.qty).join(','));
    return;
  }
  const want = SH.list[0];
  const before = player.credits;
  A.pick(want);
  if (player.credits === before){ SH.list.shift(); PT.say('shop: no more ' + want); }
};
A.shopFor = (list) => {
  Object.assign(SH, { on: 1, list: list.slice(), cd: 0, cr0: player.credits });
  return PT.say('shopping for ' + list.join(', '));
};

/* ============================== 8b. THE INVENTORY ==========================
   Not everything the player can do arrives through the probe.  The tools -
   the burner, the jammer, the cam-jack, the firecrackers - are used from the
   inventory card, and before this the rig had no way to reach them at all:
   `PT.act.use()` only ever drives `tryInteract()`, and mq2 ("put the cell's
   mark on 3 walls") cannot be done through the crosshair.

   Tab opens the card.  Tab does NOT cycle the tabs - the inventory's
   `onTab(){ popMode(); }` CLOSES it, and `onLR` moves between the five tabs,
   so tab-walking is ArrowLeft/ArrowRight (the card's own hint row says so:
   "TAB or ESC also closes; A/D switch tabs").  Getting this backwards makes
   the rig open and shut the card forever while reading the same tab.
   Note also that `onDigit` only pins CONSUMABLES to the hotbar, so a tool
   like the burner cannot be reached through 1-3 - the card is the only way. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

A.inv = async () => {
  if (topMode() && topMode().name !== 'inventory') A.escNow();
  if (!topMode()) { PT.tap('Tab'); await sleep(160); }
  const m = topMode();
  if (!m || m.name !== 'inventory')
    return { ok: false, why: 'inventory did not open, got ' + (m ? m.name : 'nothing') };
  const seen = {};
  for (let t = 0; t < INV_TABS.length; t++){
    const c = topMode();
    if (!c || c.name !== 'inventory') break;
    seen[INV_TABS[invTab][0]] = (c.items || [])
      .map(it => it.label).filter(l => l && l !== '---');
    PT.tap('ArrowRight'); await sleep(110);
  }
  return { ok: true, tabs: seen };
};

/* Use an item by label. Returns what the world did, not what you pressed:
   a tool that fires closes the card, so a still-open inventory means the
   press did nothing. */
A.item = async (want, o) => {
  o = o || {};
  const W = String(want).toUpperCase();
  if (topMode() && topMode().name !== 'inventory') A.escNow();
  if (!topMode()) { PT.tap('Tab'); await sleep(160); }
  let m = topMode();
  if (!m || m.name !== 'inventory')
    return { ok: false, why: 'inventory did not open, got ' + (m ? m.name : 'nothing') };

  for (let t = 0; t <= INV_TABS.length; t++){
    m = topMode();
    if (!m || m.name !== 'inventory') return { ok: false, why: 'inventory closed while searching' };
    const hit = (m.items || []).some(it => (it.label || '').toUpperCase().indexOf(W) >= 0);
    if (hit){
      const tab = INV_TABS[invTab][0];
      const t0 = toastT, before = PT.tail(1)[0];
      A.pick(want);
      await sleep(o.wait || 350);
      const open = topMode() && topMode().name === 'inventory';
      return { ok: true, tab, stillOpen: open,
               toast: (toastT > 0 && toastT !== t0) ? toastMsg : null,
               note: open ? 'card still open - a tool that fired would have closed it' : null };
    }
    PT.tap('ArrowRight'); await sleep(110);
  }
  A.escNow();
  return { ok: false, why: 'no item labelled "' + want + '" on any tab' };
};

/* Some tools act on the WORLD IN FRONT OF YOU rather than on a probe target:
   `burnTag()` walks 0.6 -> 4.2 tiles along cam.ang looking for `tH > 1.6`.
   There is no prompt to read and no lookTarget to assert on, so the only
   honest precondition is "is there actually a wall in front of me". Sweep a
   fine fan - a coarse one misses a wall you are standing beside. */
A.faceWall = (o) => {
  o = o || {};
  const near = o.near || 0.6, far = o.far || 4.2;
  for (let a = 0; a < 32; a++){
    const th = a * Math.PI / 16, vx = Math.cos(th), vy = Math.sin(th);
    for (let d = near; d < far; d += 0.25){
      const x = (cam.x + vx * d) | 0, y = (cam.y + vy * d) | 0;
      if (!inMap(x, y)) break;
      if (tH[y * MAP + x] > 1.6){ cam.ang = th; return { ok: true, at: [x, y], d: +d.toFixed(2) }; }
    }
  }
  return { ok: false, why: 'no wall within ' + far + ' tiles of ' + A.where() };
};
A.where = () => cam.x.toFixed(1) + ',' + cam.y.toFixed(1);

/* Mark a wall, and report the ENGINE's evidence (qvar.vandal) rather than the
   keypress. Walks to a fresh spot first if there is nothing to paint here. */
A.tag = async (o) => {
  o = o || {};
  let w = A.faceWall();
  if (!w.ok && o.hunt !== false){
    for (let i = 0; i < (o.tries || 6) && !w.ok; i++){
      const th = Math.random() * Math.PI * 2, r = 5 + Math.random() * 7;
      const sp = PT.nav.nearestStandable(cam.x + Math.cos(th) * r, cam.y + Math.sin(th) * r, 6);
      if (!sp) continue;
      PT.nav.goto(sp[0] + 0.5, sp[1] + 0.5, { dist: 1.0, run: false, timeout: 20 });
      await PT.see.settle({ ms: 15000, quiet: true });
      w = A.faceWall();
    }
  }
  if (!w.ok) return { ok: false, why: w.why };
  const n0 = player.qvar.vandal || 0;
  const r = await A.item('GRAFFITI BURNER');
  const n1 = player.qvar.vandal || 0;
  return { ok: n1 > n0, at: A.where(), wall: w.at, marks: n1, toast: r.toast || null,
           why: n1 > n0 ? undefined : 'qvar.vandal did not move - the burn did not land' };
};

/* ============================== 9. SCREEN ================================== */
A.screen  = () => (typeof __OBS !== 'undefined') ? __OBS.screen() : 'observer not loaded';
A.hud     = () => (typeof __OBS !== 'undefined')
  ? __OBS.screen('only').split('\n').filter(l => l.trim()).join('\n') : 'observer not loaded';
A.toasts  = (n) => (typeof __OBS !== 'undefined')
  ? __OBS.events.filter(e => e.kind === 'toast').slice(-(n || 8)).map(e => e.data) : [];
A.events  = (n, re) => (typeof __OBS !== 'undefined')
  ? __OBS.events.slice(-(n || 20))
      .filter(e => !re || re.test(e.kind + ' ' + JSON.stringify(e.data)))
      .map(e => e.t + ' ' + e.kind + ' ' + JSON.stringify(e.data).slice(0, 110)) : [];

PT.busy = () => ({
  nav: N.busy(), attack: !!AT.on, loot: !!LT.on, reach: !!RE.on,
  talk: !!TK.on, shop: !!SH.on,
  drive: PT.drive ? PT.drive.busy() : false
});
})();
'PT.act loaded';
