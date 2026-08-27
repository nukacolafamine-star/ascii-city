/* ============================================================================
   PT.nav — getting there.

   Three layers, because the city needs all three:

     goto(x,y)        long haul outdoors.  astar for the route, a prop-aware
                      BFS for the next few tiles, stuck-escape when pinned.
     routeTo(x,y)     tight spaces.  A* whose walkability test knows about
                      furniture, so it does not plan through a shelf.
     closeOn(x,y,r)   the one you actually want before interacting: stand on
                      the nearest tile that is BOTH standable and within r of
                      the target.

   Why routeTo exists at all: walkG holds tiles only.  Props are not in the
   navigation grid, so the engine's own astar routes straight through counters
   and shelves - reference.md section 5 says so, and it is why hostileBrain
   stalls on geometry too.  Outdoors that barely matters.  Indoors, furniture
   IS the room, and a tile-only path is useless.
   ============================================================================ */
(() => {
const PT = window.PT;
const N = PT.nav = PT.nav || {};
PT.state = PT.state || {};
const S = PT.state.nav = PT.state.nav || { on: 0 };

/* ------------------------------------------------------- walkability ------ */
/* The player's own radius is cam.rad (0.32).  Test at 0.36 so a path never
   threads a gap the body cannot actually fit through. */
N.ok = (x, y) => {
  if (x < 1 || y < 1 || x >= MAP - 1 || y >= MAP - 1) return false;
  if (!walkG[y * MAP + x]) return false;
  return !propBlocked(x + 0.5, y + 0.5, 0.36) && !tileBlocked(x + 0.5, y + 0.5, 0.36);
};
const ok = N.ok;

/* Nearest standable tile to a point, searched outward in rings. */
N.nearestStandable = (x, y, maxR) => {
  if (ok(x | 0, y | 0)) return [x | 0, y | 0];
  for (let r = 1; r <= (maxR || 6); r++){
    let best = null, bd = 1e9;
    for (let a = 0; a < r * 8; a++){
      const th = a * Math.PI * 2 / (r * 8);
      const px = (x + Math.cos(th) * r) | 0, py = (y + Math.sin(th) * r) | 0;
      if (!ok(px, py)) continue;
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (d < bd){ bd = d; best = [px, py]; }
    }
    if (best) return best;
  }
  return null;
};

/* ------------------------------------------------------- prop-aware A* ---- */
/* Bounded to a window around start and goal, so an interior costs almost
   nothing and a cross-city call still terminates. */
N.findPath = (sx, sy, gx, gy, pad) => {
  sx |= 0; sy |= 0; gx |= 0; gy |= 0;
  pad = pad || 30;
  const x0 = Math.max(1, Math.min(sx, gx) - pad), x1 = Math.min(MAP - 2, Math.max(sx, gx) + pad);
  const y0 = Math.max(1, Math.min(sy, gy) - pad), y1 = Math.min(MAP - 2, Math.max(sy, gy) + pad);
  const K = (x, y) => y * MAP + x;
  const h = (x, y) => Math.hypot(x - gx, y - gy);
  const g = new Map(), f = new Map(), from = new Map();
  const start = K(sx, sy);
  g.set(start, 0); f.set(start, h(sx, sy));
  const open = [[sx, sy]];
  let steps = 0, best = [sx, sy], bh = h(sx, sy);
  while (open.length && steps++ < 24000){
    let bi = 0, bf = Infinity;
    for (let i = 0; i < open.length; i++){
      const v = f.get(K(open[i][0], open[i][1]));
      if (v < bf){ bf = v; bi = i; }
    }
    const [cx, cy] = open.splice(bi, 1)[0];
    const ch = h(cx, cy);
    if (ch < bh){ bh = ch; best = [cx, cy]; }
    if (cx === gx && cy === gy) break;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      if (!ok(nx, ny)) continue;
      if (dx && dy && (!ok(cx + dx, cy) || !ok(cx, cy + dy))) continue;   // no corner cutting
      const nk = K(nx, ny), ng = g.get(K(cx, cy)) + (dx && dy ? 1.414 : 1);
      if (g.has(nk) && g.get(nk) <= ng) continue;
      g.set(nk, ng); f.set(nk, ng + h(nx, ny)); from.set(nk, K(cx, cy));
      open.push([nx, ny]);
    }
  }
  const endK = g.has(K(gx, gy)) ? K(gx, gy) : K(best[0], best[1]);
  if (endK === start) return [];
  const out = [];
  let cur = endK;
  while (cur !== undefined && cur !== start){
    out.push([(cur % MAP) + 0.5, ((cur / MAP) | 0) + 0.5]);
    cur = from.get(cur);
  }
  return out.reverse();
};

/* Short-range BFS used by the street walker for the next few tiles. */
const localStep = (sx, sy, tx, ty, W) => {
  W = W || 16;
  const seen = new Set([sx + ',' + sy]), from = new Map();
  const q = [[sx, sy]];
  let best = null, bd = 1e9, guard = 0;
  while (q.length && guard++ < 5000){
    const [x, y] = q.shift();
    const d = Math.hypot(x - tx, y - ty);
    if (d < bd){ bd = d; best = [x, y]; }
    if (d < 0.9) break;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (Math.abs(nx - sx) > W || Math.abs(ny - sy) > W) continue;
      const k = nx + ',' + ny;
      if (seen.has(k) || !ok(nx, ny)) continue;
      if (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
      seen.add(k); from.set(k, x + ',' + y); q.push([nx, ny]);
    }
  }
  if (!best) return null;
  let cur = best[0] + ',' + best[1], prev = null;
  while (from.has(cur)){ prev = cur; cur = from.get(cur); }
  return prev ? prev.split(',').map(Number) : best;
};

/* ------------------------------------------------------------- facing ---- */
N.face = (x, y) => { cam.ang = Math.atan2(y - cam.y, x - cam.x); return cam.ang; };
N.faceSmooth = (x, y, rate, dt) => {
  let e = Math.atan2(y - cam.y, x - cam.x) - cam.ang;
  while (e > Math.PI) e -= Math.PI * 2;
  while (e < -Math.PI) e += Math.PI * 2;
  cam.ang += Math.sign(e) * Math.min(Math.abs(e), (rate || 5) * (dt || 0.016));
  return Math.abs(e);
};

/* --------------------------------------------------------------- stop ---- */
N.stop = () => {
  S.on = 0; S.mode = null; S.goal = null; S.pts = null;
  for (const k of ['KeyW','KeyS','KeyA','KeyD','ShiftLeft']) keys[k] = 0;
  return 'nav stopped';
};

/* ==================== the walker: one tick, three modes ==================== */
/* mode 'street'  — astar plan, local BFS steering, stuck escape
   mode 'path'    — follow an explicit waypoint list (from findPath)          */
PT.ticks.nav = function(dt){
  if (!S.on) return;
  if (topMode()){ keys['KeyW'] = 0; return; }        // a menu owns the keyboard
  if (player.hp <= 0){ N.stop(); PT.say('nav: down'); return; }
  S.t = (S.t || 0) + dt;
  if (S.t > S.timeout){ S.fail = 'timeout'; N.stop(); PT.say('nav: TIMEOUT at ' + N.where()); return; }

  if (S.mode === 'path'){
    const t = S.pts[S.i];
    if (!t){ S.done = true; N.stop(); PT.say('nav: arrived ' + N.where()); return; }
    if (Math.hypot(t[0] - cam.x, t[1] - cam.y) < 0.5){ S.i++; keys['KeyW'] = 0; return; }
    const err = N.faceSmooth(t[0], t[1], 7, dt);
    keys['KeyW'] = err > 0.6 ? 0 : 1;
    keys['ShiftLeft'] = (S.run && err < 0.3 && S.pts.length - S.i > 6) ? 1 : 0;
    stuckCheck(dt, () => { S.pts = N.findPath(cam.x, cam.y, S.goal[0], S.goal[1]); S.i = 0; });
    return;
  }

  /* street */
  const [gx, gy] = S.goal;
  const gd = Math.hypot(gx - cam.x, gy - cam.y);
  if (gd <= S.dist){ S.done = true; N.stop(); PT.say('nav: arrived d=' + gd.toFixed(2)); return; }
  if (S.arrive && S.arrive()){ S.done = true; N.stop(); PT.say('nav: arrive() satisfied'); return; }

  while (S.pts.length && Math.hypot(S.pts[0][0] - cam.x, S.pts[0][1] - cam.y) < 1.6) S.pts.shift();
  let wp = null;
  for (let i = Math.min(S.pts.length - 1, 24); i >= 0; i--){
    const w = S.pts[i];
    if (Math.abs(w[0] - cam.x) <= 15 && Math.abs(w[1] - cam.y) <= 15){ wp = w; break; }
  }
  if (!wp) wp = [gx, gy];
  const loc = localStep(cam.x | 0, cam.y | 0, wp[0] | 0, wp[1] | 0, 16) || [wp[0] | 0, wp[1] | 0];
  const err = N.faceSmooth(loc[0] + 0.5, loc[1] + 0.5, 5, dt);
  /* turn before you walk: holding forward through a turn hugs walls and pins
     you in corners */
  keys['KeyW'] = err > 1.0 ? 0 : 1;
  keys['ShiftLeft'] = (S.run && err < 0.5 && gd > 5) ? 1 : 0;

  stuckCheck(dt, () => { plan(gx, gy); });
  S.replan = (S.replan || 0) + dt;
  if (S.replan > 4){ S.replan = 0; plan(gx, gy); }
};

/* Stuck is a DISPLACEMENT fact, not an intent one: holding forward while not
   actually moving.  Escape by sweeping all 24 headings at two probe distances
   and taking the free one nearest the goal - a coarse fan misses the one gap. */
function stuckCheck(dt, replan){
  const moved = Math.hypot(cam.x - (S.px || cam.x), cam.y - (S.py || cam.y));
  S.px = cam.x; S.py = cam.y;
  if (keys['KeyW'] && moved < 0.004) S.stuck = (S.stuck || 0) + dt;
  else S.stuck = Math.max(0, (S.stuck || 0) - dt * 2);
  if (S.stuck < 0.9) return;
  S.stuck = 0; S.escapes = (S.escapes || 0) + 1;
  PT.say('nav: stuck at ' + N.where() + ' -> escape #' + S.escapes);
  let bestA = null, bestS = -1e9;
  const gx = S.goal[0], gy = S.goal[1];
  for (let a = 0; a < 24; a++){
    const th = a * Math.PI / 12, c = Math.cos(th), s = Math.sin(th);
    let free = true;
    for (const r of [0.9, 1.8]) if (!ok((cam.x + c * r) | 0, (cam.y + s * r) | 0)){ free = false; break; }
    if (!free) continue;
    let d = th - Math.atan2(gy - cam.y, gx - cam.x);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (-Math.abs(d) > bestS){ bestS = -Math.abs(d); bestA = th; }
  }
  if (bestA !== null) cam.ang = bestA;
  if (S.escapes > 14){ S.fail = 'wedged'; N.stop(); PT.say('nav: WEDGED, giving up'); return; }
  replan();
}

function plan(gx, gy){
  let p = null;
  try { p = astar(cam.x | 0, cam.y | 0, gx | 0, gy | 0, 90000); } catch (e){}
  if (!p || !p.length){
    const nb = N.nearestStandable(gx, gy, 5);
    if (nb) { try { p = astar(cam.x | 0, cam.y | 0, nb[0], nb[1], 90000); } catch (e){} }
  }
  S.pts = (p || []).map(i => [(i % MAP) + 0.5, ((i / MAP) | 0) + 0.5]);
  return S.pts.length;
}

/* ------------------------------------------------------------ the API ---- */
/* goto: picks its own strategy.  Indoors, or anywhere close, the prop-aware
   path is the right one; across the city the two-level street planner is. */
N.goto = (x, y, o) => {
  o = o || {};
  N.stop();
  const indoors = (typeof netSceneId === 'function') && netSceneId() !== 'city';
  const near = Math.hypot(x - cam.x, y - cam.y) < 40;
  Object.assign(S, {
    on: 1, goal: [x, y], dist: o.dist === undefined ? 1.2 : o.dist,
    run: o.run !== false, timeout: o.timeout || 240,
    t: 0, replan: 0, stuck: 0, escapes: 0, done: false, fail: null,
    arrive: o.arrive || null, px: cam.x, py: cam.y
  });
  if (indoors || near || o.precise){
    S.mode = 'path';
    const g = N.nearestStandable(x, y, 6) || [x | 0, y | 0];
    S.pts = N.findPath(cam.x, cam.y, g[0], g[1]);
    S.i = 0;
    if (!S.pts.length){ S.on = 0; return PT.say('goto: no path to ' + x.toFixed(1) + ',' + y.toFixed(1)); }
    return PT.say('goto ' + x.toFixed(0) + ',' + y.toFixed(0) + ' via path (' + S.pts.length + ')');
  }
  S.mode = 'street';
  const n = plan(x, y);
  if (!n) { S.on = 0; return PT.say('goto: no route to ' + x.toFixed(1) + ',' + y.toFixed(1)); }
  return PT.say('goto ' + x.toFixed(0) + ',' + y.toFixed(0) + ' via street (' + n + ')');
};

/* walk an explicit list of points */
N.walk = (pts, o) => {
  o = o || {};
  N.stop();
  Object.assign(S, { on: 1, mode: 'path', pts: pts.slice(), i: 0,
    goal: pts[pts.length - 1] || [cam.x, cam.y], dist: 0.5,
    run: !!o.run, timeout: o.timeout || 120, t: 0, stuck: 0, escapes: 0,
    done: false, fail: null, px: cam.x, py: cam.y });
  return PT.say('walk ' + pts.length + ' points');
};

N.routeTo = (x, y, o) => N.goto(x, y, Object.assign({ precise: true }, o || {}));

/* closeOn: the interaction-shaped move.  Find every standable tile within
   `reach` of the target, take the closest one you can actually path to, and
   stand there.  This is what "walk up to the shopkeeper" actually means when
   the shopkeeper is behind a counter. */
N.closeOn = (x, y, reach, o) => {
  reach = reach || 1.8;
  const cands = [];
  const R = Math.ceil(reach) + 1;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++){
    const px = (x | 0) + dx, py = (y | 0) + dy;
    if (!ok(px, py)) continue;
    const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
    if (d <= reach) cands.push([px, py, d]);
  }
  if (!cands.length) return PT.say('closeOn: no standable tile within ' + reach.toFixed(2));
  cands.sort((a, b) => a[2] - b[2]);
  for (const c of cands.slice(0, 8)){
    const pts = N.findPath(cam.x, cam.y, c[0], c[1]);
    if (!pts.length && Math.hypot(c[0] + 0.5 - cam.x, c[1] + 0.5 - cam.y) > 1) continue;
    N.walk(pts.length ? pts : [[c[0] + 0.5, c[1] + 0.5]], o);
    S.goal = [x, y];
    return PT.say('closeOn ' + pts.length + ' steps, will sit ' + c[2].toFixed(2) + ' off');
  }
  return PT.say('closeOn: nothing reachable within ' + reach.toFixed(2));
};

/* ------------------------------------------------------------- status ---- */
N.where = () => cam.x.toFixed(1) + ',' + cam.y.toFixed(1);
N.busy = () => !!S.on;
N.arrived = () => !S.on && !!S.done;
N.state = () => ({
  on: !!S.on, mode: S.mode, done: !!S.done, fail: S.fail,
  goal: S.goal && [+S.goal[0].toFixed(1), +S.goal[1].toFixed(1)],
  d: S.goal ? +Math.hypot(S.goal[0] - cam.x, S.goal[1] - cam.y).toFixed(2) : null,
  pos: [+cam.x.toFixed(1), +cam.y.toFixed(1)],
  left: S.mode === 'path' ? (S.pts ? S.pts.length - S.i : 0) : (S.pts ? S.pts.length : 0),
  escapes: S.escapes || 0, elapsed: +(S.t || 0).toFixed(1)
});

/* a small ASCII map of what the walker believes, for when it disagrees
   with you about whether somewhere is reachable */
N.grid = (r) => {
  r = r || 7;
  const cx = cam.x | 0, cy = cam.y | 0, rows = [];
  for (let y = cy - r; y <= cy + r; y++){
    let s = String(y).padStart(4) + ' ';
    for (let x = cx - r; x <= cx + r; x++){
      s += (x === cx && y === cy) ? '@'
         : !walkG[y * MAP + x] ? '#'
         : tileBlocked(x + 0.5, y + 0.5, 0.36) ? 'T'
         : propBlocked(x + 0.5, y + 0.5, 0.36) ? 'p' : '.';
    }
    rows.push(s);
  }
  rows.push('     @ you  # not walkable  T tile  p prop  . clear');
  return rows.join('\n');
};
})();
'PT.nav loaded';
