/*============================================================================
  voxel models/_food/<item-id>/*.obj|fbx  ->  FOOD_VOX entries

  The consumables used to be procedural blobs at the hand - a cup was a ring
  of beams, a can was a beam with a label blob, everything else was a sphere.
  This bakes the real food models down to role grids the rig can stamp: the
  same surface-voxelise / flood-solidify / repair pipeline the weapons came
  through, minus the scope drilling, plus a colour pass tuned for FOOD - a
  burger bun must come out bread, not a light. Saturated paint still earns
  glow (this is a city where the apples are SYNTH), but the thresholds are
  higher and every model gets a per-material override in food-import.json.

  Run with no arguments: every folder under "voxel models/_food" is baked,
  previews print for eyeballing, and tools/baked-foods.js comes out ready
  for tools/splice-foods.mjs.

  Role map (the RIG's palette - the item is stamped into the first-person
  rig and the third-person body, so only roles both palettes carry):
    T light grey    H dark grey     L matte white   P bread/wood brown
    X amber glow    R red glow      G green glow    V blue/cyan glow
    W bright white  M the item's own colour (ITEMS[id].pcol at runtime)
  NEVER use B/S/K: on the rig those are the wearer's shirt, skin and coat.
============================================================================*/
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFBX, kid, kids } from './fbx-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOOD_DIR = join(ROOT, 'voxel models', '_food');
const CFG_PATH = join(ROOT, 'tools', 'food-import.json');
const OUT_PATH = join(ROOT, 'tools', 'baked-foods.js');

/*----------------------------- mesh loading -------------------------------*/
function loadOBJ(dir){
  const files = readdirSync(dir);
  const objF = files.find(f => extname(f).toLowerCase() === '.obj');
  const mtlF = files.find(f => extname(f).toLowerCase() === '.mtl');
  const mats = {};                          // name -> [r,g,b] 0..1
  if (mtlF){
    let cur = null;
    for (const line of readFileSync(join(dir, mtlF), 'utf8').split('\n')){
      const t = line.trim().split(/\s+/);
      if (t[0] === 'newmtl') cur = t[1];
      else if (t[0] === 'Kd' && cur) mats[cur] = [+t[1], +t[2], +t[3]];
    }
  }
  const verts = [], tris = [], triMat = [], matList = [];
  const matIdx = new Map();
  let curM = 0;
  for (const line of readFileSync(join(dir, objF), 'utf8').split('\n')){
    if (line[0] === 'v' && line[1] === ' '){
      const t = line.split(/\s+/);
      verts.push([+t[1], +t[2], +t[3]]);
    } else if (line.startsWith('usemtl')){
      const name = line.slice(7).trim();
      if (!matIdx.has(name)){
        matIdx.set(name, matList.length);
        matList.push({ name, rgb: mats[name] || [0.5, 0.5, 0.5] });
      }
      curM = matIdx.get(name);
    } else if (line[0] === 'f' && line[1] === ' '){
      const t = line.trim().split(/\s+/).slice(1)
                    .map(s => parseInt(s) - 1);
      for (let i = 2; i < t.length; i++){
        tris.push([t[0], t[i - 1], t[i]]);
        triMat.push(curM);
      }
    }
  }
  return { verts, tris, triMat, matList };
}
function loadFBXMesh(dir){
  const files = readdirSync(dir);
  const fbxF = files.find(f => extname(f).toLowerCase() === '.fbx');
  const { root } = readFBX(join(dir, fbxF));
  const objs = kid(root, 'Objects');
  const verts = [], tris = [], triMat = [], matList = [];
  for (const m of kids(objs, 'Material')){
    const p70 = kid(m, 'Properties70');
    let dc = [0.5, 0.5, 0.5];
    if (p70) for (const P of kids(p70, 'P'))
      if (P.props[0] === 'DiffuseColor') dc = [P.props[4], P.props[5], P.props[6]];
    matList.push({ name: String(m.props[1]).split(' ')[0].split(' ')[0], rgb: dc });
  }
  for (const geo of kids(objs, 'Geometry')){
    const V = kid(geo, 'Vertices'); if (!V) continue;
    const vv = V.props[0], base = verts.length;
    for (let i = 0; i < vv.length; i += 3) verts.push([vv[i], vv[i + 1], vv[i + 2]]);
    const PI = kid(geo, 'PolygonVertexIndex').props[0];
    let matOf = null, same = 0;
    const lem = kid(geo, 'LayerElementMaterial');
    if (lem){
      const mapping = (kid(lem, 'MappingInformationType') || { props: [''] }).props[0];
      const arr = (kid(lem, 'Materials') || { props: [null] }).props[0];
      if (arr && mapping === 'ByPolygon') matOf = arr;
      else if (arr && arr.length) same = arr[0];
    }
    let poly = [], polyN = 0;
    for (let i = 0; i < PI.length; i++){
      let ix = PI[i];
      const end = ix < 0;
      if (end) ix = ~ix;
      poly.push(base + ix);
      if (end){
        const m = matOf ? (matOf[polyN] || 0) : same;
        for (let k = 2; k < poly.length; k++){
          tris.push([poly[0], poly[k - 1], poly[k]]);
          triMat.push(m);
        }
        poly = []; polyN++;
      }
    }
  }
  if (!matList.length) matList.push({ name: 'default', rgb: [0.5, 0.5, 0.5] });
  return { verts, tris, triMat, matList };
}

/*------------------------ colour -> engine role ----------------------------
  Food first: bread and meat browns go to P/H, creams and rices to L, greys
  to T/H. Glow needs real neon saturation - a tomato slice earns R, a bun
  never does. Config `map` overrides per material name or index. */
function rgbToHsv([r, g, b]){
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6)
    h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0, v: mx };
}
function classify(rgb){
  const { h, s, v } = rgbToHsv(rgb);
  // warm food browns and tans first - the biggest food family by volume
  if (h >= 12 && h < 55 && s > 0.25 && v < 0.85) return 'P';
  if (s > 0.62 && v > 0.55){                 // real neon only
    if (h < 15 || h >= 335) return 'R';
    if (h < 62) return 'X';
    if (h < 170) return 'G';
    return 'V';
  }
  if (v > 0.82 && s < 0.30) return 'L';      // cream, rice, paper
  if (s > 0.35 && v > 0.25) return 'M';      // coloured but matte: item's own
  if (v > 0.55) return 'T';
  if (v > 0.22) return 'H';
  return 'H';
}

/*----------------------- conversion repairs (as guns) ----------------------*/
function weldCornerJoins(vox, aw, vd, ah){
  const I = (x, y, z) => (z * vd + y) * aw + x;
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= aw || y >= vd || z >= ah)
    ? 0 : vox[I(x, y, z)];
  const support = (x, y, z) => {
    let n = 0;
    if (at(x + 1, y, z)) n++; if (at(x - 1, y, z)) n++;
    if (at(x, y + 1, z)) n++; if (at(x, y - 1, z)) n++;
    if (at(x, y, z + 1)) n++; if (at(x, y, z - 1)) n++;
    return n;
  };
  const DIAG = [[1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1], [1, 1, 0], [1, -1, 0]];
  let filled = 0;
  for (let z = 0; z < ah; z++)
    for (let y = 0; y < vd; y++)
      for (let x = 0; x < aw; x++){
        const a = at(x, y, z);
        if (!a) continue;
        for (const [dx, dy, dz] of DIAG){
          const b = at(x + dx, y + dy, z + dz);
          if (!b) continue;
          const ax = [];
          if (dx) ax.push([dx, 0, 0]);
          if (dy) ax.push([0, dy, 0]);
          if (dz) ax.push([0, 0, dz]);
          const p1 = [x + ax[0][0], y + ax[0][1], z + ax[0][2]];
          const p2 = [x + ax[1][0], y + ax[1][1], z + ax[1][2]];
          if (at(p1[0], p1[1], p1[2]) || at(p2[0], p2[1], p2[2])) continue;
          const s1 = support(p1[0], p1[1], p1[2]), s2 = support(p2[0], p2[1], p2[2]);
          const p = s1 >= s2 ? p1 : p2;
          vox[I(p[0], p[1], p[2])] = s1 >= s2 ? a : b;
          filled++;
        }
      }
  return filled;
}
function bridgeSeveredLayers(vox, aw, vd, ah){
  const layerHas = z => {
    for (let i = z * vd * aw; i < (z + 1) * vd * aw; i++) if (vox[i]) return true;
    return false;
  };
  const nearIn = (z, x, y) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++){
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= aw || ny >= vd) continue;
        const r = vox[(z * vd + ny) * aw + nx];
        if (r) return r;
      }
    return 0;
  };
  let filled = 0;
  for (let z = 1; z < ah - 1; z++){
    if (layerHas(z)) continue;
    let above = false;
    for (let zz = z - 1; zz >= 0 && !above; zz--) above = layerHas(zz);
    let below = false;
    for (let zz = z + 1; zz < ah && !below; zz++) below = layerHas(zz);
    if (!above || !below) continue;
    for (let y = 0; y < vd; y++)
      for (let x = 0; x < aw; x++){
        const up = nearIn(z - 1, x, y);
        if (!up || !nearIn(z + 1, x, y)) continue;
        vox[(z * vd + y) * aw + x] = up;
        filled++;
      }
  }
  return filled;
}
function stitchPieces(vox, aw, vd, ah, maxGap){
  const N = aw * vd * ah;
  const I = (x, y, z) => (z * vd + y) * aw + x;
  let bridged = 0, bridges = 0;
  for (let guard = 0; guard < 24; guard++){
    const comp = new Int16Array(N).fill(-1);
    let nc = 0;
    const cells = [];
    for (let s = 0; s < N; s++){
      if (!vox[s] || comp[s] >= 0) continue;
      const id = nc++, st = [s];
      comp[s] = id; cells.push([s]);
      while (st.length){
        const j = st.pop();
        const x = j % aw, y = ((j / aw) | 0) % vd, z = (j / (aw * vd)) | 0;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= aw || ny >= vd || nz >= ah) continue;
          const k = I(nx, ny, nz);
          if (vox[k] && comp[k] < 0){ comp[k] = id; st.push(k); cells[id].push(k); }
        }
      }
    }
    if (nc <= 1) break;
    let bd = 1e9, from = -1, to = -1;
    for (let a = 0; a < nc; a++)
      for (let b = a + 1; b < nc; b++)
        for (const s of cells[a]){
          const x = s % aw, y = ((s / aw) | 0) % vd, z = (s / (aw * vd)) | 0;
          for (const t of cells[b]){
            const d = Math.abs(x - t % aw) + Math.abs(y - ((t / aw) | 0) % vd) +
                      Math.abs(z - ((t / (aw * vd)) | 0));
            if (d < bd){ bd = d; from = s; to = t; }
          }
        }
    if (bd > maxGap){
      console.log('   stitch: ' + nc + ' pieces remain - nearest gap ' + bd +
                  ' cells is wider than maxGap ' + maxGap);
      break;
    }
    let x = from % aw, y = ((from / aw) | 0) % vd, z = (from / (aw * vd)) | 0;
    const tx = to % aw, ty = ((to / aw) | 0) % vd, tz = (to / (aw * vd)) | 0;
    const role = vox[from];
    while (x !== tx || y !== ty || z !== tz){
      if (x !== tx) x += Math.sign(tx - x);
      else if (y !== ty) y += Math.sign(ty - y);
      else z += Math.sign(tz - z);
      const k = I(x, y, z);
      if (!vox[k]){ vox[k] = role; bridged++; }
    }
    bridges++;
  }
  return { bridged, bridges };
}
function componentCount(vox, aw, vd, ah){
  const N = aw * vd * ah, seen = new Uint8Array(N);
  let pieces = 0;
  const stack = [];
  for (let i = 0; i < N; i++){
    if (!vox[i] || seen[i]) continue;
    pieces++;
    seen[i] = 1; stack.push(i);
    while (stack.length){
      const j = stack.pop();
      const x = j % aw, y = ((j / aw) | 0) % vd, z = (j / (aw * vd)) | 0;
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= aw || ny >= vd || nz >= ah) continue;
        const k = (nz * vd + ny) * aw + nx;
        if (vox[k] && !seen[k]){ seen[k] = 1; stack.push(k); }
      }
    }
  }
  return pieces;
}

/*------------------------------ voxelise ----------------------------------*/
function bake(id, dir, cfg){
  const files = readdirSync(dir);
  const mesh = files.some(f => extname(f).toLowerCase() === '.obj')
             ? loadOBJ(dir) : loadFBXMesh(dir);
  const { verts, tris, triMat, matList } = mesh;
  console.log('\n== ' + id + ': ' + tris.length + ' tris, materials:');
  const roles = matList.map((m, i) => {
    const ov = cfg.map && (cfg.map[m.name] !== undefined ? cfg.map[m.name]
                          : cfg.map[i] !== undefined ? cfg.map[i] : undefined);
    return ov !== undefined ? ov : classify(m.rgb);
  });
  matList.forEach((m, i) => console.log(
    '   [' + i + '] ' + m.name.padEnd(14) + ' rgb ' +
    m.rgb.map(c => (c * 255) | 0).join(',').padEnd(12) + ' -> ' + roles[i]));
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const v of verts) for (let a = 0; a < 3; a++){
    if (v[a] < lo[a]) lo[a] = v[a];
    if (v[a] > hi[a]) hi[a] = v[a];
  }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  console.log('   ext x/y/z: ' + ext.map(e => e.toFixed(2)).join(' / '));
  const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a]);
  const axV = cfg.axV !== undefined ? cfg.axV : order[0];   // length
  const axW = cfg.axW !== undefined ? cfg.axW : order[1];   // up
  const axU = cfg.axU !== undefined ? cfg.axU : order[2];   // across
  const sV = cfg.flip ? -1 : 1, sW = cfg.upFlip ? -1 : 1;
  /* food is small and held close: 32 cells along the length is plenty of
     detail at thirty centimetres from the eye, and the rig supersamples */
  const res = cfg.res || 32;
  const cell = ext[axV] / res;
  const gd = res;
  const gw = Math.max(3, Math.min(56, Math.round(ext[axU] / cell)));
  const gh = Math.max(3, Math.min(60, Math.round(ext[axW] / cell)));
  const mid = a => (lo[a] + hi[a]) * 0.5;
  const P2G = p => {
    const u = (p[axU] - mid(axU)) / cell + gw / 2;
    const v = sV * (p[axV] - mid(axV)) / cell + gd / 2;
    const w = sW * (p[axW] - mid(axW)) / cell + gh / 2;
    return [u, v, w];
  };
  const N = gw * gd * gh;
  const grid = new Uint8Array(N);
  const II = (iu, iv, iz) => (iz * gd + iv) * gw + iu;
  const mark = (u, v, w, role) => {
    const iu = u | 0, iv = v | 0, iz = gh - 1 - (w | 0);
    if (iu < 0 || iv < 0 || iz < 0 || iu >= gw || iv >= gd || iz >= gh) return;
    grid[II(iu, iv, iz)] = role.charCodeAt(0);
  };
  for (let t = 0; t < tris.length; t++){
    // an FBX can bind polygons to slots past its own material list
    const role = roles[triMat[t]] || roles[0] || 'M';
    const [A, B, C2] = tris[t].map(i => P2G(verts[i]));
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C2[0] - A[0], C2[1] - A[1], C2[2] - A[2]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    const n1 = Math.max(1, Math.ceil(l1 / 0.4)), n2 = Math.max(1, Math.ceil(l2 / 0.4));
    for (let i = 0; i <= n1; i++)
      for (let j = 0; j <= n2 - (i / n1) * n2; j++){
        const a = i / n1, b = j / n2;
        mark(A[0] + e1[0] * a + e2[0] * b, A[1] + e1[1] * a + e2[1] * b,
             A[2] + e1[2] * a + e2[2] * b, role);
      }
  }
  // solidify: outside flood, then inward role fill
  const outside = new Uint8Array(N);
  const q = [];
  for (let z = 0; z < gh; z++) for (let v = 0; v < gd; v++) for (let u = 0; u < gw; u++)
    if ((u === 0 || v === 0 || z === 0 || u === gw - 1 || v === gd - 1 || z === gh - 1)
        && !grid[II(u, v, z)] && !outside[II(u, v, z)]){
      outside[II(u, v, z)] = 1; q.push(u, v, z);
    }
  while (q.length){
    const z = q.pop(), v = q.pop(), u = q.pop();
    for (const [du, dv, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
      const u2 = u + du, v2 = v + dv, z2 = z + dz;
      if (u2 < 0 || v2 < 0 || z2 < 0 || u2 >= gw || v2 >= gd || z2 >= gh) continue;
      const i = II(u2, v2, z2);
      if (!grid[i] && !outside[i]){ outside[i] = 1; q.push(u2, v2, z2); }
    }
  }
  let front = [];
  for (let z = 0; z < gh; z++) for (let v = 0; v < gd; v++) for (let u = 0; u < gw; u++)
    if (grid[II(u, v, z)]) front.push(u, v, z);
  let filled = 0;
  while (front.length){
    const next = [];
    for (let k = 0; k < front.length; k += 3){
      const u = front[k], v = front[k + 1], z = front[k + 2];
      const role = grid[II(u, v, z)];
      for (const [du, dv, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
        const u2 = u + du, v2 = v + dv, z2 = z + dz;
        if (u2 < 0 || v2 < 0 || z2 < 0 || u2 >= gw || v2 >= gd || z2 >= gh) continue;
        const i = II(u2, v2, z2);
        if (!grid[i] && !outside[i]){
          grid[i] = role; filled++; next.push(u2, v2, z2);
        }
      }
    }
    front = next;
  }
  {
    const before = componentCount(grid, gw, gd, gh);
    if (cfg.stitch){
      const st = stitchPieces(grid, gw, gd, gh, cfg.stitch === true ? 4 : cfg.stitch | 0);
      if (st.bridges) console.log('   stitch: ' + st.bridges + ' bridge' +
        (st.bridges > 1 ? 's' : '') + ', +' + st.bridged + ' voxels');
    }
    if (cfg.weld){
      const br = bridgeSeveredLayers(grid, gw, gd, gh);
      const passes = cfg.weld === true ? 2 : cfg.weld | 0;
      let wd = 0;
      for (let p = 0; p < passes; p++) wd += weldCornerJoins(grid, gw, gd, gh);
      const after = componentCount(grid, gw, gd, gh);
      console.log('   repairs: bridged ' + br + ', welded ' + wd + ' voxels over ' +
                  passes + ' passes - ' + before + ' piece' + (before > 1 ? 's' : '') +
                  ' -> ' + after);
    } else if (before > 1)
      console.log('   !! model is in ' + before + ' pieces (no weld configured)');
  }
  /* paint boxes, named in grid cells off the printed preview - the food side
     of the guns' `glow`: repaint solid voxels, never add material */
  if (cfg.glow) for (const B of [].concat(cfg.glow)){
    const u0 = B.u0 !== undefined ? B.u0 : 0, u1 = B.u1 !== undefined ? B.u1 : gw - 1;
    const v0 = B.v0 !== undefined ? B.v0 : 0, v1 = B.v1 !== undefined ? B.v1 : gd - 1;
    const z0 = B.z0 !== undefined ? B.z0 : 0, z1 = B.z1 !== undefined ? B.z1 : gh - 1;
    let n = 0;
    for (let z = Math.max(0, z0); z <= Math.min(gh - 1, z1); z++)
      for (let v = Math.max(0, v0); v <= Math.min(gd - 1, v1); v++)
        for (let u = Math.max(0, u0); u <= Math.min(gw - 1, u1); u++){
          const i = II(u, v, z);
          if (grid[i]){ grid[i] = B.role.charCodeAt(0); n++; }
        }
    console.log('   glow ' + B.role + ': ' + n + ' voxels  u ' + u0 + '..' + u1 +
                '  v ' + v0 + '..' + v1 + '  z ' + z0 + '..' + z1);
  }
  const roleCount = {};
  for (let i = 0; i < N; i++) if (grid[i]){
    const r = String.fromCharCode(grid[i]);
    roleCount[r] = (roleCount[r] || 0) + 1;
  }
  const occ = Object.values(roleCount).reduce((a, b) => a + b, 0);
  console.log('   grid ' + gw + 'x' + gd + 'x' + gh + '  filled ' + occ +
              ' (+' + filled + ' interior)  roles ' + JSON.stringify(roleCount));
  preview(grid, gw, gd, gh, II);
  let rle = '', i = 0;
  while (i < N){
    const c = grid[i];
    let j = i;
    while (j < N && grid[j] === c) j++;
    rle += (c ? String.fromCharCode(c) : '.') + (j - i).toString(36) + ',';
    i = j;
  }
  return { gw, gd, gh, rle: rle.slice(0, -1) };
}
/* side and top views, length ->, so a wrong flip is obvious */
function preview(grid, gw, gd, gh, II){
  console.log('   side (length ->, top ^):');
  for (let z = 0; z < gh; z++){
    let row = '   ';
    for (let v = 0; v < gd; v++){
      let ch = ' ';
      for (let u = 0; u < gw; u++){
        const c = grid[II(u, v, z)];
        if (c){ ch = String.fromCharCode(c); break; }
      }
      row += ch;
    }
    console.log(row);
  }
  console.log('   top (length ->, across ^):');
  for (let u = 0; u < gw; u++){
    let row = '   ';
    for (let v = 0; v < gd; v++){
      let ch = ' ';
      for (let z = 0; z < gh; z++){
        const c = grid[II(u, v, z)];
        if (c){ ch = String.fromCharCode(c); break; }
      }
      row += ch;
    }
    console.log(row);
  }
}

/*--------------------------------- main ------------------------------------*/
const CFG = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
const only = process.argv[2] || null;         // bake one id while tuning
const out = {};
for (const id of readdirSync(FOOD_DIR)){
  const dir = join(FOOD_DIR, id);
  if (!statSync(dir).isDirectory()) continue;
  if (only && id !== only) continue;
  out[id] = bake(id, dir, CFG[id] || {});
}
if (only){
  console.log('\n(single-model run: baked-foods.js NOT written - run with no ' +
              'arguments to bake the set)');
  process.exit(0);
}
let js = '/* generated by tools/food-import.mjs - do not hand-edit */\n' +
         'const FOOD_VOX_RAW = {\n';
for (const k in out){
  const e = out[k];
  js += '  ' + k + ": { gw: " + e.gw + ', gd: ' + e.gd + ', gh: ' + e.gh +
        ",\n    rle: '" + e.rle + "' },\n";
}
js += '};\n';
writeFileSync(OUT_PATH, js);
console.log('\nwrote ' + OUT_PATH + ' (' + (js.length / 1024).toFixed(0) + ' KB)');
