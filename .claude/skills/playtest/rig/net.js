/* ============================================================================
   PT.net — the multiplayer half, which the rig previously had almost none of.

   `PT.act.peers()` listed bodies and that was all.  Everything the skill asks
   you to confirm about a session - that you are really in, that the clock
   jumped, that a room's refcount walked 1 -> 2 -> 1 -> 0, that a peer is idle
   rather than dropped - had to be hand-written per probe.  It is here now.

   Two things worth knowing before you read a number off this file:

   * A position without a scene is meaningless.  Every interior is stamped at
     the same array origin, so two players in DIFFERENT rooms stand on nearly
     identical coordinates.  `roster()` always prints the scene beside the
     position, and `d` is null unless you are actually in the same one.

   * Staleness, not stillness, is what distinguishes idle from dropped.  A
     player motionless for four minutes with `lastT` 0.07 s behind is standing
     still on purpose; the same stillness with `lastT` climbing is a broken
     connection.
   ============================================================================ */
(() => {
const PT = window.PT;
const N = PT.net = PT.net || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const off = () => (typeof NET === 'undefined' || !NET.on);

/* --------------------------------------------------------- link health --- */
/* Exactly the set SKILL.md tells you to confirm before saying you are in:
   status 'joined', ice 'connected', and a clock that moved. */
N.status = () => {
  if (off()) return { off: true };
  const L = NET.link || {};
  return {
    room: NET.room, role: NET.role, status: NET.status, id: NET.id,
    rtc: L.rtc ? { live: L.rtc.live, swarm: L.rtc.swarm, route: L.rtc.route, ice: L.rtc.ice } : null,
    bus: L.bus ? L.bus.state : null,
    err: NET.error || 'none',
    clock: (typeof clockStr === 'function') ? clockStr() : null, day: dayCount,
    peers: PLAYERS.filter(p => !p.local).length
  };
};

/* Everyone, qualified by scene, with staleness in seconds. */
N.roster = () => {
  if (off()) return [{ off: true, solo: true }];
  const here = (typeof netSceneId === 'function') ? netSceneId() : 'city';
  const now = (typeof netNow === 'function') ? netNow() : 0;
  return PLAYERS.map(p => {
    const same = p.local || p.sceneId === here;
    return {
      id: p.id, name: p.name, me: !!p.local,
      scene: p.local ? here : p.sceneId,
      at: [p.local ? +cam.x.toFixed(1) : +p.cam.x.toFixed(1),
           p.local ? +cam.y.toFixed(1) : +p.cam.y.toFixed(1)],
      hp: p.local ? player.hp : p.hp, dead: !!p.dead,
      /* d is only a real distance when the scene matches - otherwise the two
         of you are standing on the same stamped coordinates in different rooms */
      d: (p.local || !same) ? null
         : +Math.hypot(p.cam.x - cam.x, p.cam.y - cam.y).toFixed(2),
      stale: p.local ? 0 : +(now - p.lastT).toFixed(2)
    };
  });
};

/* ------------------------------------------------------- room lifecycle --- */
/* reference.md calls the acquire/stamp/release trace the most diagnostic thing
   in the game. observer.js records it; this pulls it back out per room. */
N.rooms = (key, n) => {
  if (typeof __OBS === 'undefined') return 'observer not loaded';
  const re = key ? new RegExp(key) : /./;
  return __OBS.events
    .filter(e => /acquire|release|stamp|scene/.test(e.kind))
    .filter(e => re.test(JSON.stringify(e.data)))
    .slice(-(n || 20))
    .map(e => e.t.toFixed(1) + ' ' + e.kind + ' ' + JSON.stringify(e.data));
};
/* what the engine currently believes is built, and who is in it */
N.scenes = () => {
  const out = {};
  for (const [k, v] of SCENES) out[k] = { refs: v.refs, cast: (v.cast || []).length };
  const here = (typeof netSceneId === 'function') ? netSceneId() : 'city';
  const who = {};
  for (const p of PLAYERS) (who[p.local ? here : p.sceneId] = who[p.local ? here : p.sceneId] || []).push(p.id);
  return { built: out, occupants: who, mine: here };
};

/* ---------------------------------------------------------- the menus ---- */
const openMP = async () => {
  if (topMode()) PT.act.escNow();
  await sleep(200);
  PT.tap('Escape'); await sleep(400);
  if (!topMode() || topMode().name !== 'pause') return 'pause menu did not open';
  PT.act.pick('MULTIPLAYER'); await sleep(500);
  return (topMode() && topMode().name === 'multiplayer') ? 'ok' : 'multiplayer panel did not open';
};

N.host = async () => {
  const r = await openMP();
  if (r !== 'ok') return { ok: false, why: r };
  PT.act.pick('HOST A GAME');
  await sleep(2500);
  PT.act.esc(); await sleep(1200);
  return { ok: NET.on && NET.role === 'host', ...N.status() };
};

/* Join, then confirm the three things that actually mean you are in. A seed
   that matches while the clock has NOT moved means you are not really in. */
N.join = async (code, o) => {
  o = o || {};
  const c0 = clock, d0 = dayCount;
  const r = await openMP();
  if (r !== 'ok') return { ok: false, why: r };
  PT.act.pick('JOIN A GAME'); await sleep(600);
  if (!topMode() || topMode().name !== 'roomcode')
    return { ok: false, why: 'room code prompt did not open' };
  PT.type(code); await sleep(300);
  PT.tap('Enter');
  await sleep(o.wait || 6000);
  const s = N.status();
  const jumped = (clock !== c0) || (dayCount !== d0);
  PT.act.esc(); await sleep(1200);          // joining leaves you on the pause card
  return {
    ok: s.status === 'joined' && s.rtc && s.rtc.ice === 'connected' && jumped,
    clockJumped: jumped, ...s,
    why: s.status !== 'joined' ? 'status is ' + s.status
       : !(s.rtc && s.rtc.ice === 'connected') ? 'ice is ' + (s.rtc && s.rtc.ice)
       : !jumped ? 'the clock did not move - the seed matched but you are not really in'
       : undefined
  };
};

N.leave = async () => {
  const r = await openMP();
  if (r !== 'ok') return { ok: false, why: r };
  const m = topMode();
  /* Anchored, and this is not pedantry: the first version of this line read
     /LEAVE|DISCONNECT|STOP HOSTING|END/i, and `END` matches "rENDezvous" - a
     read-only status row that sits NINE rows above DISCONNECT, so `.find()`
     returned it first and the rig pressed the wrong thing and then reported
     that leaving had failed. The same unanchored-substring mistake this file's
     sibling `A.matchRow` exists to prevent. */
  const row = (m.items || []).map(i => i.label).filter(Boolean)
                .find(l => /^(DISCONNECT|LEAVE|STOP HOSTING|CLOSE THE ROOM)/i.test(l.trim()));
  if (!row){ PT.act.esc(); return { ok: false, why: 'no leave row; rows: ' +
    (m.items || []).map(i => i.label).filter(Boolean).join(' | ') }; }
  PT.act.pick(row); await sleep(1500);
  PT.act.esc(); await sleep(1000);
  return { ok: off(), ...N.status() };
};

/* --------------------------------------------------------- the sampler --- */
/* reference.md section 7 asks for a once-a-second sampler driven from the
   frame tick that logs TRANSITIONS only. Driving it from setInterval is the
   trap it warns about: a throttled timer does not stop, it lies about how
   much time passed. This rides PT.ticks, so it is on the same clock as the
   world it is describing. */
PT.state.netwatch = PT.state.netwatch || { on: 0, acc: 0, last: {}, log: [] };
PT.ticks.netwatch = function(dt){
  const W = PT.state.netwatch;
  if (!W.on || off()) return;
  W.acc += dt;
  if (W.acc < 1) return;
  W.acc = 0;
  const now = (typeof netNow === 'function') ? netNow() : 0;
  const here = netSceneId();
  const note = s => { W.log.push(clockStr() + ' ' + s); if (W.log.length > 200) W.log.shift(); };
  for (const p of PLAYERS){
    const k = 'p' + p.id;
    const cur = { scene: p.local ? here : p.sceneId, dead: !!p.dead,
                  hp: p.local ? player.hp : p.hp,
                  stale: p.local ? 0 : (now - p.lastT) };
    const was = W.last[k];
    if (!was) note('JOINED ' + k + ' in ' + cur.scene);
    else {
      if (was.scene !== cur.scene) note(k + ' scene ' + was.scene + ' -> ' + cur.scene);
      if (was.dead !== cur.dead) note(k + (cur.dead ? ' DIED' : ' respawned'));
      if (Math.abs((was.hp || 0) - (cur.hp || 0)) >= 10) note(k + ' hp ' + was.hp + ' -> ' + cur.hp);
      /* stale crossing 3 s is a connection story, not an idleness one */
      if (was.stale < 3 && cur.stale >= 3) note(k + ' GOING STALE ' + cur.stale.toFixed(1) + 's');
      if (was.stale >= 3 && cur.stale < 3) note(k + ' back, stale ' + cur.stale.toFixed(2) + 's');
    }
    W.last[k] = cur;
  }
  for (const k in W.last){
    if (!PLAYERS.some(p => 'p' + p.id === k)){ note('LEFT ' + k); delete W.last[k]; }
  }
};
N.watch = () => { Object.assign(PT.state.netwatch, { on: 1, acc: 0, last: {}, log: [] });
                  return PT.say('netwatch on'); };
N.watchStop = () => { PT.state.netwatch.on = 0; return 'netwatch off'; };
N.log = (n) => PT.state.netwatch.log.slice(-(n || 20));
})();
'PT.net loaded';
