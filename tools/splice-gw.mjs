// Rebuild the GPU world block in index.html from the scratchpad sources.
// The block is delimited by two stable markers; everything between them is
// replaced, so the shader and the pass can be edited as real files instead of
// as a 3000-character template literal wedged inside a 24k-line page.
import { readFileSync, writeFileSync } from 'node:fs';
const S = process.argv[2];
const glsl = readFileSync(S + '/fs_world.glsl', 'utf8').replace(/\s+$/, '');
const bt = String.fromCharCode(96);
if (glsl.includes(bt)) { console.error('BACKTICK IN GLSL - it would close the literal'); process.exit(1); }
const statics = readFileSync(S + '/gw_statics.js', 'utf8');
const pass = readFileSync(S + '/gw_pass.js', 'utf8');
let s = readFileSync('index.html', 'utf8');
const A = s.indexOf('/*=================== the world stops being a CPU loop');
const B = s.indexOf('function glQuad(x, y, w, h, r, g, b, a){');
if (A < 0 || B < 0 || B < A) { console.error('block markers not found'); process.exit(1); }
const old = s.slice(A, B);
const head = old.slice(0, old.indexOf('const FS_WORLD ='));
const tA = old.indexOf('/*------------------ the framebuffer the world lands in');
const tB = old.indexOf('/*------------------- what the shader needs to know once');
if (tA < 0 || tB < 0) { console.error('inner markers not found'); process.exit(1); }
const targets = old.slice(tA, tB);
const rebuilt = head + 'const FS_WORLD = ' + bt + glsl + bt + ';\n' + targets + statics + pass;
writeFileSync('index.html', s.slice(0, A) + rebuilt + s.slice(B));
console.log('spliced', rebuilt.length, 'chars');
