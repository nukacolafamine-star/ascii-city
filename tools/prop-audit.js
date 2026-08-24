/* Prop placement auditor. Loaded into a live ASCII CITY page; reads the
   top-level world arrays directly and reports every prop that is somewhere
   it has no business being. Read-only - it never mutates the world. */
(function(){
  const EXEMPT_SOLID = new Set([PK_ITEM, PK_CROP, PK_STAIR, PK_RAMP, PK_BODY]);
  const NAME = [];
  NAME[PK_LAMP]='LAMP'; NAME[PK_TREE]='TREE'; NAME[PK_HYDR]='HYDR';
  NAME[PK_TLIGHT]='TLIGHT'; NAME[PK_BIN]='BIN'; NAME[PK_RAIL]='RAIL';
  NAME[PK_STALL]='STALL'; NAME[PK_BENCH]='BENCH'; NAME[PK_CAM]='CAM';
  NAME[PK_PLAY]='PLAY'; NAME[PK_METRO]='METRO'; NAME[PK_APPLE]='APPLE';
  NAME[PK_TURBINE]='TURBINE'; NAME[PK_ITEM]='ITEM'; NAME[PK_SAKURA]='SAKURA';
  NAME[PK_CROP]='CROP'; NAME[PK_ROCK]='ROCK'; NAME[PK_STAIR]='STAIR';
  NAME[PK_RACK]='RACK'; NAME[PK_FURN]='FURN'; NAME[PK_HOOP]='HOOP';
  NAME[PK_SWING]='SWING'; NAME[PK_CLIMB]='CLIMB'; NAME[PK_FLOTSAM]='FLOTSAM';
  NAME[PK_RAMP]='RAMP'; NAME[PK_FOUNT]='FOUNT'; NAME[PK_STATUE]='STATUE';
  NAME[PK_BAND]='BAND'; NAME[PK_PARKED]='PARKED'; NAME[PK_BODY]='BODY';
  const nm = k => NAME[k] || ('K' + k);
  const TN = ['ROAD','CROSS','WALK','LOT','BLD','WATER','BRIDGE','PATH','INF'];

  const span = (c, size) => [Math.floor(c - size * 0.5 + 1e-6),
                             Math.floor(c + size * 0.5 - 1e-6)];
  function box(p){
    const yaw = p.yaw === undefined ? propFacing(p) : p.yaw;
    const fb = footBox(p.k, yaw);
    return { w: fb[0], d: fb[1] };
  }
  function tiles(p){
    const b = box(p);
    const [x0, x1] = span(p.x, b.w), [y0, y1] = span(p.y, b.d);
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
    return out;
  }

  window.__audit = function(opt){
    opt = opt || {};
    const cap = opt.cap === undefined ? 6 : opt.cap;   // examples kept per bucket
    const R = { seed: (typeof worldSeed !== 'undefined' ? worldSeed : null),
                props: props.length, buckets: {} };
    const push = (key, rec) => {
      const b = R.buckets[key] || (R.buckets[key] = { n: 0, byKind: {}, eg: [] });
      b.n++;
      b.byKind[rec.k] = (b.byKind[rec.k] || 0) + 1;
      if (b.eg.length < cap) b.eg.push(rec);
    };

    /*--- A. wrong surface -------------------------------------------------*/
    for (const p of props){
      const k = nm(p.k);
      const ts = tiles(p);
      let water = 0, bld = 0, oob = 0, cross = 0;
      for (const t2 of ts){
        const x = t2[0], y = t2[1];
        if (!inMap(x, y)){ oob++; continue; }
        const t = tType[y * MAP + x];
        if (t === T_WATER) water++;
        else if (t === T_BLD) bld++;
        else if (t === T_CROSS) cross++;
      }
      const home = inMap(p.x | 0, p.y | 0) ? tType[(p.y | 0) * MAP + (p.x | 0)] : -1;
      const rec = { k, x: +p.x.toFixed(2), y: +p.y.toFixed(2), t: TN[home] || home };
      if (oob) push('OFF_MAP', rec);
      if (water && p.k !== PK_FLOTSAM)
        push(home === T_WATER ? 'IN_RIVER' : 'OVERHANGS_WATER', Object.assign({ wt: water }, rec));
      if (p.k === PK_FLOTSAM && home !== T_WATER) push('FLOTSAM_ASHORE', rec);
      if (bld)
        push(home === T_BLD ? 'IN_BUILDING' : 'OVERHANGS_BUILDING', Object.assign({ bt: bld }, rec));
      if (cross && !ROAD_OK[p.k] && !EXEMPT_SOLID.has(p.k))
        push('ON_CROSSWALK', Object.assign({ ct: cross }, rec));
      if (!EXEMPT_SOLID.has(p.k) && p.k !== PK_FLOTSAM && home === T_ROAD && !ROAD_OK[p.k])
        push('IN_ROADWAY', rec);
    }

    /*--- B. inside each other --------------------------------------------*/
    const CELL = 8, grid = new Map();
    const solid = props.filter(p => !EXEMPT_SOLID.has(p.k));
    for (const p of solid){
      const b = box(p);
      const x0 = Math.floor(p.x - b.w / 2), x1 = Math.floor(p.x + b.w / 2);
      const y0 = Math.floor(p.y - b.d / 2), y1 = Math.floor(p.y + b.d / 2);
      p.__b = { x0: p.x - b.w / 2, x1: p.x + b.w / 2, y0: p.y - b.d / 2, y1: p.y + b.d / 2 };
      const bx0 = Math.floor(x0 / CELL), bx1 = Math.floor(x1 / CELL);
      const by0 = Math.floor(y0 / CELL), by1 = Math.floor(y1 / CELL);
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++){
        const key = by * 4096 + bx;
        let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(p);
      }
    }
    const seenPair = new Set();
    for (const a of grid.values()){
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++){
        const p = a[i], q = a[j];
        const A = p.__b, B = q.__b;
        const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        if (ox <= 1e-6 || oy <= 1e-6) continue;
        /* Two boxes can share a patch of map and still be nowhere near each
           other: a bridge railing sits on the deck at z 0 and the rubbish in
           the channel under it at z -3. The first version of this reported
           that pair on every seed, at the same coordinate every time, which
           is what gave it away - a real placement fault moves with the seed.
           Anything more than a metre apart vertically is not touching. */
        const az = p.z || 0, bz = q.z || 0;
        if (Math.abs(az - bz) > 1) continue;
        const kk = p.x + ':' + p.y + ':' + q.x + ':' + q.y;
        if (seenPair.has(kk)) continue; seenPair.add(kk);
        push('OVERLAP', { k: nm(p.k) + '+' + nm(q.k), x: +p.x.toFixed(2), y: +p.y.toFixed(2),
                          ov: +(Math.min(ox, oy)).toFixed(2) });
      }
    }
    for (const p of solid) delete p.__b;

    /*--- C. blocking -----------------------------------------------------*/
    const save = Uint8Array.from(walkG);
    buildWalkGrid();
    const terr = Uint8Array.from(walkG);
    bakeSolidProps();
    const withP = Uint8Array.from(walkG);
    walkG.set(save);

    const comp = (g) => {
      const lab = new Int32Array(MAP * MAP).fill(-1);
      const st = new Int32Array(MAP * MAP);
      let best = -1, bestN = 0, next = 0;
      for (let i = 0; i < MAP * MAP; i++){
        if (!g[i] || lab[i] >= 0) continue;
        const id = next++; let sp = 0, n = 0;
        st[sp++] = i; lab[i] = id;
        while (sp > 0){
          const c = st[--sp]; n++;
          const x = c % MAP;
          if (x > 0 && g[c - 1] && lab[c - 1] < 0){ lab[c - 1] = id; st[sp++] = c - 1; }
          if (x < MAP - 1 && g[c + 1] && lab[c + 1] < 0){ lab[c + 1] = id; st[sp++] = c + 1; }
          if (c >= MAP && g[c - MAP] && lab[c - MAP] < 0){ lab[c - MAP] = id; st[sp++] = c - MAP; }
          if (c < MAP * (MAP - 1) && g[c + MAP] && lab[c + MAP] < 0){ lab[c + MAP] = id; st[sp++] = c + MAP; }
        }
        if (n > bestN){ bestN = n; best = id; }
      }
      return { lab, main: best, size: bestN };
    };
    const cT = comp(terr), cP = comp(withP);
    R.walk = { terrain: cT.size, withProps: cP.size, lost: cT.size - cP.size };

    let stranded = 0;
    const pocket = new Map();
    for (let i = 0; i < MAP * MAP; i++){
      if (!terr[i]) continue;
      if (cT.lab[i] !== cT.main) continue;
      if (withP[i] && cP.lab[i] === cP.main) continue;
      stranded++;
      if (withP[i]){
        const id = cP.lab[i];
        const e = pocket.get(id) || { n: 0, x: i % MAP, y: (i / MAP) | 0 };
        e.n++; pocket.set(id, e);
      }
    }
    R.stranded = stranded;
    R.pockets = [...pocket.values()].sort((a, b) => b.n - a.n).slice(0, 10);

    let doorBlocked = 0; const doorEg = [];
    for (const d of doors){
      const sx = clamp(Math.round(d.bx + d.nx), 0, MAP - 1);
      const sy = clamp(Math.round(d.by + d.ny), 0, MAP - 1);
      const i = sy * MAP + sx;
      if (terr[i] && !withP[i]){
        doorBlocked++;
        if (doorEg.length < 6) doorEg.push({ x: sx, y: sy });
      }
    }
    R.doorstepBlockedByProp = doorBlocked; R.doorEg = doorEg;
    R.sealedDoors = doors.filter(d => d.sealed).length;
    R.doors = doors.length;

    R.summary = Object.entries(R.buckets).map(kv => kv[0] + '=' + kv[1].n).sort().join(' ');
    return R;
  };

  window.__auditSeed = function(seed, opt){
    newWorld(seed);
    return __audit(opt);
  };
  /* several cities in a row, folded into one table */
  window.__auditMany = function(seeds, opt){
    const rows = [], tot = {};
    for (const s of seeds){
      const r = __auditSeed(s, Object.assign({ cap: 2 }, opt || {}));
      const row = { seed: s, props: r.props, pocketMax: r.pockets[0] ? r.pockets[0].n : 0,
                    doorBlocked: r.doorstepBlockedByProp, sealed: r.sealedDoors };
      for (const k in r.buckets){
        row[k] = r.buckets[k].n;
        tot[k] = (tot[k] || 0) + r.buckets[k].n;
      }
      rows.push(row);
      window.__lastMany = rows;
    }
    return { rows, tot };
  };
  return 'audit ready';
})()
