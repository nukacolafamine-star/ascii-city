/* ============================================================================
   PT.drive — the long behaviours, and a queue to chain them.

   These are the things a tester does for minutes at a time: clear a shop, work
   a shift, sit at a table, fight whoever is closest.  Each is a small state
   machine with a bounded retry count and an honest log line when it gives up,
   because a behaviour that stalls silently is indistinguishable from a game
   that has frozen - and one of those is worth reporting.
   ============================================================================ */
(() => {
const PT = window.PT, A = PT.act, N = PT.nav;
const D = PT.drive = PT.drive || {};
PT.state = PT.state || {};
const S = PT.state.drive = PT.state.drive || { on: 0, job: null, queue: [] };

const idle = () => !N.busy() && !PT.state.attack.on && !PT.state.loot.on &&
                   !PT.state.reach.on && !PT.state.shop.on && !PT.state.talk.on;

D.busy = () => !!S.on;
D.stop = () => {
  S.on = 0; S.job = null; S.queue = [];
  A.attackStop(); A.lootStop(); N.stop();
  PT.state.reach.on = 0; PT.state.shop.on = 0; PT.state.talk.on = 0;
  return PT.say('drive: stopped');
};
D.state = () => ({ on: !!S.on, job: S.job && S.job.kind, step: S.job && S.job.step,
                   bld: S.job && S.job.bld, queued: S.queue.length, note: S.note });

/* --------------------------------------------------------------- queue --- */
D.queue = (jobs) => {
  S.queue = jobs.slice(); S.on = 1; S.job = null;
  return PT.say('drive: queued ' + jobs.length + ' jobs — ' + jobs.map(j => j.kind).join(', '));
};
D.then = (job) => { S.queue.push(job); S.on = 1; return PT.say('drive: +' + job.kind); };

PT.ticks.drive = function(dt){
  if (!S.on) return;
  if (player.hp <= 0){ S.note = 'down'; return; }          // wait for a respawn
  if (S.job){ step(S.job, dt); if (!S.job.done) return; S.job = null; }
  if (!S.queue.length){ S.on = 0; PT.say('drive: queue empty'); return; }
  S.job = S.queue.shift();
  S.job.step = 'start'; S.job.t = 0; S.job.tries = 0;
  PT.say('drive: -> ' + S.job.kind + (S.job.bld ? ' b' + S.job.bld : ''));
};

function step(j, dt){
  j.t += dt;
  if (j.t > (j.timeout || 300)){ j.done = true; PT.say('drive: ' + j.kind + ' TIMEOUT'); return; }
  const fn = JOBS[j.kind];
  if (!fn){ j.done = true; PT.say('drive: unknown job ' + j.kind); return; }
  fn(j, dt);
}

/* ============================== the jobs =================================== */
const JOBS = {};

/* --- goto ---------------------------------------------------------------- */
JOBS.goto = (j) => {
  if (j.step === 'start'){ N.goto(j.x, j.y, { dist: j.dist || 1.3, timeout: j.timeout || 300 }); j.step = 'walk'; return; }
  if (!N.busy()) j.done = true;
};

/* --- enter a building ---------------------------------------------------- */
function enterBuilding(j){
  const d = doors.filter(q => q.b === j.bld)[0];
  if (!d){ j.done = true; PT.say('no door for b' + j.bld); return false; }
  if (j.step === 'start'){
    if (netSceneId() !== 'city') A.leave();
    N.goto(d.x, d.y, { dist: 1.3, timeout: 300 });
    j.step = 'walk'; j.door = d; return false;
  }
  if (j.step === 'walk'){
    if (N.busy()) return false;
    if (Math.hypot(d.x - cam.x, d.y - cam.y) > 2.4){
      if (++j.tries > 2){ j.done = true; PT.say('could not reach the door of b' + j.bld); return false; }
      N.goto(d.x, d.y, { dist: 1.3, timeout: 120 }); return false;
    }
    A.face(d.x, d.y);
    A.enter();
    if (netSceneId() === 'city'){
      if (++j.tries > 3){ j.done = true; PT.say('could not get into b' + j.bld); return false; }
      return false;
    }
    j.step = 'inside'; j.tries = 0;
    return true;
  }
  return true;
}

/* --- rob: door, clear the room, take what is loose, leave ----------------- */
JOBS.rob = (j) => {
  if (j.step === 'start' || j.step === 'walk'){ if (!enterBuilding(j)) return; }
  if (j.step === 'inside'){ j.step = 'clear'; j.kills = 0; j.tries = 0; }

  if (j.step === 'clear'){
    if (!idle()) return;
    const t = actors.filter(a => actorHere(a) && actorTargetable(a))
                    .sort((p, q) => Math.hypot(p.x-cam.x,p.y-cam.y) - Math.hypot(q.x-cam.x,q.y-cam.y))[0];
    if (t && j.kills < (j.maxKills || 5)){
      j.kills++; A.attack(t, 16, { timeout: 40 }); return;
    }
    j.step = 'loot'; A.lootAll(true);
    PT.say('rob b' + j.bld + ': room clear, ' + j.kills + ' down');
    return;
  }
  if (j.step === 'loot'){
    if (PT.state.loot.on) return;
    j.took = PT.state.loot.took;
    j.step = 'out'; return;
  }
  if (j.step === 'out'){
    A.leave(); j.done = true;
    PT.say('ROB b' + j.bld + ' — ' + j.kills + ' down, ' + j.took + ' picked up, cr=' +
           player.credits + ' corr=' + player.corruption);
  }
};

/* --- work: freight or desk shifts ---------------------------------------- */
JOBS.work = (j) => {
  if (j.step === 'start' || j.step === 'walk'){ if (!enterBuilding(j)) return; }
  if (j.step === 'inside'){ j.step = 'clearfloor'; A.lootAll(true); j.left = j.shifts || 2; return; }
  /* Loose pickups on the floor outscore the work station in the probe cone,
     so the floor has to be clear before a shift can even be started. */
  if (j.step === 'clearfloor'){ if (PT.state.loot.on) return; j.step = 'shift'; j.tries = 0; return; }

  if (j.step === 'shift'){
    if (!idle()) return;
    if (j.left <= 0 || player.hp <= 30){ j.step = 'out'; return; }
    const st = A.furnNear(14, 'cratepile')[0] || A.furnNear(14, 'terminal')[0];
    if (!st){ j.step = 'out'; PT.say('work: nothing to work at in b' + j.bld); return; }
    A.face(st.ref.x, st.ref.y); probeInteract();
    if (lookTarget && lookTarget.kind === 'shift'){
      const cr0 = player.credits, p = lookTarget.prompt;
      tryInteract();
      j.left--; j.earned = (j.earned || 0) + (player.credits - cr0);
      PT.say('shift: "' + p + '" paid ' + (player.credits - cr0) + ', hp ' + player.hp);
      return;
    }
    if (++j.tries > 8){ j.step = 'out'; PT.say('work: could not get the station in the crosshair'); return; }
    A.reach(st.ref, { kind: 'shift' });
    if (!PT.state.reach.on) N.closeOn(st.ref.x, st.ref.y, 2.0, { timeout: 20 });
    return;
  }
  if (j.step === 'out'){
    A.leave(); j.done = true;
    PT.say('WORK b' + j.bld + ' — earned ' + (j.earned || 0) + ', hp ' + player.hp + ', cr ' + player.credits);
  }
};

/* --- shop: walk in, talk to the keeper, buy a list ------------------------ */
JOBS.shop = (j, dt) => {
  if (j.step === 'start' || j.step === 'walk'){ if (!enterBuilding(j)) return; }
  if (j.step === 'inside'){ j.step = 'find'; j.tries = 0; return; }
  if (j.step === 'find'){
    if (!idle()) return;
    j.cd = (j.cd || 0) - dt;
    if (j.cd > 0) return;
    j.cd = 0.55;                              // the same anti-misclick guard
    const m = topMode();
    if (m && m.name === 'shop'){ A.shopFor(j.list); j.step = 'buying'; return; }
    if (m && m.name === 'dialog'){ PT.tap('Space'); return; }
    if (m){ A.esc(); return; }
    const k = actors.filter(a => actorHere(a) && a.tree)
                    .sort((p, q) => Math.hypot(p.x-cam.x,p.y-cam.y) - Math.hypot(q.x-cam.x,q.y-cam.y))[0];
    if (!k){ j.step = 'out'; PT.say('shop: no keeper in b' + j.bld); return; }
    if (++j.tries > 14){ j.step = 'out'; PT.say('shop: could not open the counter'); return; }
    A.reach(k, { want: 'TALK', use: true });
    return;
  }
  if (j.step === 'buying'){
    if (PT.state.shop.on) return;
    j.step = 'out'; return;
  }
  if (j.step === 'out'){ A.esc(); A.leave(); j.done = true;
    PT.say('SHOP b' + j.bld + ' — cr ' + player.credits + ', ' + player.inv.map(s=>s.id+'x'+s.qty).join(',')); }
};

/* --- gamble: blackjack and high-low, played straight ---------------------- */
const G = PT.state.gamble = PT.state.gamble || { on: 0 };
PT.ticks.gamble = function(dt){
  if (!G.on) return;
  G.cd -= dt; if (G.cd > 0) return;
  G.cd = 0.22;
  const m = topMode();
  if (!m){ G.on = 0; PT.say('gamble: table closed, net ' + (player.credits - G.start)); return; }
  if (m.name === 'dialog'){ PT.tap('Space'); return; }
  if (m.name === 'bet'){
    if (G.hands <= 0){ G.on = 0; A.pick('WALK AWAY');
      PT.say('gamble: done ' + G.w + 'W/' + G.l + 'L, net ' + (player.credits - G.start)); return; }
    const bet = G.grow ? (player.credits >= 2500 ? 250 : player.credits >= 700 ? 100 : player.credits >= 120 ? 25 : 10) : G.bet;
    A.pick('BET ' + bet); G.hands--; G.cr0 = player.credits + bet; return;
  }
  if (m.name === 'blackjack'){
    /* 'house' is a real state now - the dealer turns its hole card and draws
       on a clock. Acting during it double-counts every hand as a loss, because
       the stake is already gone and the payout has not happened yet. Wait. */
    if (m.phase === 'house') return;
    if (m.phase === 'play') PT.tap(handVal(m.you) < 17 ? 'KeyH' : 'KeyS');
    else if (m.phase === 'done'){ score(); PT.tap('Space'); }
    return;
  }
  if (m.name === 'highlow'){
    if (m.phase === 'roll') return;             // the die is still in the air
    if (m.phase === 'play'){
      /* play the odds the table is showing, and stop while ahead of the stake */
      const hi = 6 - m.die, lo = m.die - 1;
      if (m.pot > G.cr0 - (G.cr0 - m.bet) && G.cashAt && m.pot >= G.cashAt) PT.tap('KeyC');
      else if (hi >= 4) PT.tap('KeyH');
      else if (lo >= 4) PT.tap('KeyL');
      else PT.tap('KeyC');
      G.rolls = (G.rolls || 0) + 1;
    } else { score(); PT.tap('Space'); }
    return;
  }
  G.on = 0; PT.say('gamble: unexpected mode ' + m.name);
  function score(){ const n = player.credits - G.cr0; if (n > 0) G.w++; else if (n < 0) G.l++; }
};
D.gamble = (hands, bet, o) => {
  o = o || {};
  Object.assign(G, { on: 1, hands: hands || 20, bet: bet || 25, grow: !!o.grow,
                     cashAt: o.cashAt || 0, start: player.credits, cr0: player.credits,
                     w: 0, l: 0, rolls: 0, cd: 0 });
  return PT.say('gamble ' + (hands||20) + ' hands @' + (bet||25));
};
D.gambleState = () => ({ on: !!G.on, left: G.hands, w: G.w, l: G.l, rolls: G.rolls,
                         start: G.start, now: player.credits, net: player.credits - G.start });

JOBS.gamble = (j, dt) => {
  if (j.step === 'start' || j.step === 'walk'){ if (!enterBuilding(j)) return; }
  if (j.step === 'inside'){ j.step = 'sit'; j.tries = 0; return; }
  if (j.step === 'sit'){
    if (!idle()) return;
    /* Dialogue swallows a Space that lands within ~450 ms of the option list
       changing. Pressing every frame therefore selects nothing and eventually
       lands on the wrong line - "Just watching" instead of "Deal me in" - so
       this step gets a heartbeat of its own. */
    j.cd = (j.cd || 0) - dt;
    if (j.cd > 0) return;
    j.cd = 0.55;
    const m = topMode();
    if (m && m.name === 'bet'){ D.gamble(j.hands, j.bet, j); j.step = 'playing'; return; }
    if (m && m.name === 'dialog'){ PT.tap('Space'); return; }
    if (m){ A.esc(); return; }
    const dealer = actors.filter(a => actorHere(a) && a.tree && /DEALER|CALLER|SPINNER|ATTENDANT|WARDEN/.test(a.name))
      .filter(a => !j.game || new RegExp(j.game, 'i').test(a.name))
      .sort((p, q) => Math.hypot(p.x-cam.x,p.y-cam.y) - Math.hypot(q.x-cam.x,q.y-cam.y))[0];
    if (!dealer){ j.step = 'out'; PT.say('gamble: no ' + (j.game || 'table') + ' in b' + j.bld); return; }
    if (++j.tries > 14){ j.step = 'out'; PT.say('gamble: could not sit down'); return; }
    A.reach(dealer, { want: 'TALK', use: true });
    return;
  }
  if (j.step === 'playing'){ if (G.on) return; j.step = 'out'; return; }
  if (j.step === 'out'){ A.esc(); A.leave(); j.done = true;
    PT.say('GAMBLE b' + j.bld + ' — cr ' + player.credits); }
};

/* --- ffa: fight whoever is closest, hold a firing line if armed ----------- */
const F = PT.state.ffa = PT.state.ffa || { on: 0 };
PT.ticks.ffa = function(dt){
  if (!F.on) return;
  if (player.hp <= 0){ F.on = 0; N.stop(); PT.say('FFA: down after ' + (F.shots||0) + ' shots'); return; }
  if (topMode()) return;
  const here = netSceneId();
  const q = PLAYERS.filter(p => !p.local && !p.dead && p.hp > 0 && p.sceneId === here)
                   .sort((a, b) => Math.hypot(a.cam.x-cam.x,a.cam.y-cam.y) - Math.hypot(b.cam.x-cam.x,b.cam.y-cam.y))[0];
  if (!q){ keys['KeyW'] = 0; keys['KeyS'] = 0; keys['ShiftLeft'] = 0; return; }
  const d = Math.hypot(q.cam.x - cam.x, q.cam.y - cam.y);
  A.face(q.cam.x, q.cam.y);
  if (A.armed()){
    const G2 = GUNS[weaponId()], want = Math.min(G2.range * 0.35, 9);
    keys['KeyW'] = d > want + 1.5 ? 1 : 0;
    keys['KeyS'] = d < 2.0 ? 1 : 0;                 // point blank is a dead zone
    keys['ShiftLeft'] = d > 14 ? 1 : 0;
    if (d > 0.6 && shotCool <= 0){ fireWeapon(); F.shots = (F.shots || 0) + 1; }
  } else {
    const reach = meleeStats().reach;
    keys['KeyW'] = d > reach - 0.3 ? 1 : 0;
    keys['ShiftLeft'] = d > 6 ? 1 : 0;
    if (d <= reach && (typeof punchT === 'undefined' || punchT <= 0)){ fireWeapon(); F.swings = (F.swings || 0) + 1; }
  }
};
D.ffa = (o) => {
  o = o || {};
  const chk = A.checkWeapon();
  if (!chk.ok){
    if (o.fists !== false) { A.equip('fist'); PT.say('ffa: ' + chk.why + ' -> switched to fists'); }
    else return PT.say('ffa: REFUSED - ' + chk.why);
  }
  N.stop();
  Object.assign(F, { on: 1, shots: 0, swings: 0, t0: (typeof netNow==='function'?netNow():0), hp0: player.hp });
  return PT.say('FFA engaged as ' + weaponId()); };
D.ffaStop = () => { F.on = 0; keys['KeyW']=0; keys['KeyS']=0; keys['ShiftLeft']=0; return 'ffa off'; };
D.ffaState = () => ({ on: !!F.on, shots: F.shots, swings: F.swings, hp: player.hp,
                      hpLost: (F.hp0 || 0) - player.hp,
                      peers: A.peers().filter(p => p.here) });

/* --- respawn: take the metro option, and say what it cost ---------------- */
D.respawn = () => {
  const m = topMode();
  if (!m || m.name !== 'dead') return PT.say('respawn: not down');
  const cr0 = player.credits;
  A.pick('WAKE AT THE METRO');
  return PT.say('respawn: ' + cr0 + ' -> ' + player.credits + ' cr, woke at ' + N.where());
};
/* auto-respawn so a long run is not stopped by one death */
PT.ticks.autoRespawn = function(){
  const m = topMode();
  if (!(m && m.name === 'dead')) return;
  /* Whether or not we respawn automatically, nothing the rig started should
     still claim to be running once you are on the floor. */
  A.attackStop(); A.lootStop(); N.stop();
  PT.state.reach.on = 0; PT.state.shop.on = 0; PT.state.talk.on = 0;
  if (PT.autoRespawn) D.respawn();
};

/* --- a quick shop run near where you stand -------------------------------- */
D.robRun = (uses, n, within) => {
  const seen = new Set(), jobs = [];
  for (const u of (uses || ['general','grocery','bodega','clothier','jeweler','tools','dispensary'])){
    for (const b of A.findBuildings(u, { within: within || 70, limit: 12 })){
      if (seen.has(b.id)) continue;
      seen.add(b.id); jobs.push({ kind: 'rob', bld: b.id, timeout: 240 });
    }
  }
  jobs.sort(() => 0);
  return D.queue(jobs.slice(0, n || 8));
};
})();
'PT.drive loaded';
