# ASCII CITY — GPU renderer port, handoff

Written at commit `cffbea3` on branch `fog-and-hd`. Line numbers are from that
commit and will drift; the function names will not.

---

## 1. The goal, and the one number that matters

**Target:** 180fps at the finest grid — 479×255, 122,145 cells — with zero
perceivable loss of fidelity. That is a 5.56ms frame.

Measured **inside the real `requestAnimationFrame` loop** at that grid with ~364
models in view:

```
spritePass      11.23      harvestEmitters  0.85
floorPass        5.01      skyPass          0.57
lampVolume       3.49      signPass         0.31
wallPass         2.93      hizBuild         0.19
reflectPass      2.60      floorOcclude     0.10
──────────────────────────────────────────────────
CPU total       27.30ms    GPU present      0.33ms      →  35fps
```

`simulate()` is **0.34ms**. The game logic is not the problem, the netcode is not
the problem, the GPU is not the problem. **99% of the frame is CPU rasterisation
and the card is sitting idle.** About 22ms has to move onto it.

Do not start by looking for micro-optimisations. The previous session found two
(worth 1.6ms combined), tried two more that measured **negative or zero**, and the
conclusion is that the CPU passes are already reasonably tight. The win is
structural.

---

## 2. What already landed — read this before writing any GL

### The compose swap is the hinge, and it is done

The glyph pass used to take the world as a **vertex buffer**: `glPackWorld` walked
every cell each frame, emitted one instance per non-empty cell (cell index, glyph,
level, palette lookup, 16 bytes each), and uploaded ~2MB.

`gBuf`, `bBuf` and `lBuf` are `Uint8Array`s of exactly `cols × rows`, which is
exactly an R8 texture. They now upload **as themselves, with no JS loop**, and a
full-screen shader does the palette lookup.

| thing | where | what it is |
|---|---|---|
| `FS_COMPOSE` | 21143 | the full-screen shader: cell → glyph/palette/level → atlas → light |
| `glComposeWorld()` | 21710 | three `texSubImage2D` calls + one triangle |
| `GL.cellG/cellB/cellL` | in `glResize` 21473 | R8 textures, `cols × rows` |
| `GL.palT`, `glUploadPalette()` | 21460 | `glPal` as an RGBA8 image, rebuilt only when the palette is |
| `GPUC = { on: true }` | 21589 | the A/B switch |
| `glPackWorld()` | 21669 | **still there**, still correct, used as the fallback |

Result: present **1.97ms → 0.31ms**, zero differing pixels.

**Why this matters far more than 1.7ms:** a shader that reads the world out of
textures can be fed by a GPU pass that *writes* those textures through a
framebuffer, and `FS_COMPOSE` never learns the difference. Every stage below lands
here. You should not need to modify it.

**The one constraint on it:** compose is skipped and packing is used when
`_cpuLitFrame` is true — a frame where the CPU light buffers (`litR/G/B/A`) were
actually written. That happens when `GPUL.on` is false or you are indoors. The
compose shader has no way to see those buffers. If you want compose to be
unconditional, the CPU light path has to go too.

### Also landed, both byte-identical

- **`FOCC` / `floorOcclude()`** (19261–19292) — the floor pass runs before the wall
  pass and ~50% of what it shaded was being painted over. The two passes share a
  projection, so a wall's base row **is** the row where that column's floor stops
  being visible. One short DDA per column, stopping at the first eye-height
  occluder. 1.28ms.
- **`HIZ` / `hizBuild()` / `hizHidden()`** (20466–20486) — a max-depth pyramid,
  8×8 cells per tile. `drawModel` already computes `tNear` (the lower bound on ray
  entry `t0` over its whole box) and already rejects cells with
  `dBuf[idx] < t0 - 0.02`. If the furthest depth under every tile the box covers
  is nearer than `tNear`, every one of those tests would have failed, so the solid
  is dropped before a ray is marched. Same test, made once. 0.33ms.

### Already on the GPU from earlier work

`FS_LIGHT` (21202) / `glLightPass()` (21613) / `GPUL` (21573) — per-cell lighting,
with the heightfield uploaded once as an R32F texture for shadow taps. This is the
working reference for "upload data, run a shader, sample the result." Copy its
shape.

---

## 3. Why the next stage is all-or-nothing

The four world passes are welded together by shared buffers. This is the central
obstacle and it was checked in code, not assumed:

- **`wallPass` needs `floorPass` to have run.** It paints reflections of lit
  facades down onto the wet road (writes to a neighbour index `j`, gated on
  `reflects(j)` which reads `refBuf`). Reordering erases them.
- **`spritePass`, `signPass`, `reflectPass`, `lampVolume` all depth-test against
  `dBuf`.** `drawModel` has `if (dBuf[idx] < t0 - 0.02) continue` and
  `if (dBuf[idx] < t - 0.02) continue`.
- **`reflectPass` sweeps `srcBuf`**, which `wallPass` and `drawModel` set.

Move one pass to the GPU and the others need the results back on the CPU. A
synchronous `gl.readPixels` of a 479×255 R32F depth buffer stalls the pipeline and
eats the entire win. Async PBO readback costs a frame of latency on sprite
occlusion.

**A partial port was investigated and is blocked.** Moving only the floor
*material* (leaving `dBuf`/`refBuf` on the CPU, marking floor cells with a sentinel
and computing `floorSample` in `FS_COMPOSE`) fails because `lampVolume` reads floor
`gBuf` to lift its density (`const g = gBuf[idx] + lift`). `lampVolume` would have
to move too.

So the order things can move in is forced: **anything ordered after a pass you move
must also move.** `worldPasses()` (24046) order is:

```
skyPass / ceilingPass → floorPass → wallPass → spritePass
  → signPass → reflectPass → lampVolume → rainPass → harvestEmitters
```

---

## 4. Suggested plan

The pragmatic reading of the dependency chain is to move the **static world first
and completely**, because it is the head of the chain, and to give the object
passes a GPU depth buffer they can test against without a readback.

**Stage 2 — floor + sky + walls onto the GPU, together, with MRT.**
Render into `GL.cellG/cellB/cellL` (already exist) plus a depth attachment, using
real hardware depth testing via `gl_FragDepth` rather than a manual `dBuf`
compare. This is the big one and the facade system in `wallPass` (19660, ~780
lines: facades, windows, corner posts, roof spans, bridge decks) is most of the
work.

Needs uploaded as textures: `tH` (already up, see `glUploadHeight`), `tType`,
`tB`, building colours, `distMap`. Needs porting to GLSL: `hash3` (89),
`districtAt` (376), `zoneAt` (371), `puddleAt` (15426), `floorSample` (19138,
87 lines), `lampPool` (18170).

**Stage 3 — sprites.** `drawModel` (19993) is a voxel ray-marcher, which is
natively a fragment shader. Volumes come from `voxelize` (19938) and are cached
per `(art, depthScale, round)`, so they can go up as 3D textures once. Each model
becomes a quad over its screen box; hardware depth handles occlusion against
stage 2.

**Stage 4 — signs, reflections, lamp volume, rain.** All screen-space passes over
data that is by then already on the card.

**Then reconsider `_cpuLitFrame`** and delete the CPU light path if nothing needs
it, which makes compose unconditional.

If you want a cheaper first target to build confidence in the framework:
`reflectPass` (20937) is 2.6ms, is pure screen-space, and reads only
`gBuf`/`bBuf`/`srcBuf`/`refBuf` — but note it currently runs *before* `lampVolume`,
so moving it alone still needs care.

---

## 5. The verification protocol — this is what made the last session work

Every change that landed was proved byte-identical before it was committed.
**Keep doing this.** It caught real bugs and it is the only reason the commits can
be trusted.

**Give every change an on/off switch in the settings menu** (`GPUC`, `FOCC`,
`HIZ` all have one). Then A/B is exact and the user can bisect visually too.

**The parity harness** — run in the browser pane via `javascript_tool`:

```js
// snapshot every buffer the frame is made of
const snap = () => ({
  g: Uint8Array.from(gBuf),  b: Uint8Array.from(bBuf),
  l: Uint8Array.from(lBuf),  s: Uint8Array.from(srcBuf),
  r: Uint8Array.from(refBuf), d: Float32Array.from(dBuf)
});
// ...then for ~30 randomised poses: position, heading, pitch, eye height,
// clock 0..24, weather 0..3, plus a rooftop vantage and an interior.
// FLAG.on = true → worldPasses() → A ; FLAG.on = false → worldPasses() → B
// compare all six arrays cell by cell. Anything but zero is a defect.
```

Once the GPU owns a pass, byte-parity will no longer hold (JS and GLSL floats
differ). Replace it with a stated tolerance and hold yourself to it — e.g.
"palette index identical in ≥99.9% of cells, glyph index within ±1" — and measure
it, do not eyeball it.

**Read pixels from `GL.scene.f`, not the default framebuffer.** The canvas has
`preserveDrawingBuffer: false`, so reading the default framebuffer after present
returns all black — and an all-black-vs-all-black comparison passes trivially.
Always assert the frame has content (count bright pixels) before trusting a
comparison that shows no difference.

**Prove the switch actually switches.** Wrap both code paths in counters and
confirm one ran and the other did not. A flag that is being ignored produces a
perfect parity result.

---

## 6. Measurement traps that already cost time — do not re-learn these

- **Profile inside the real rAF loop, not with `worldPasses()` in a `for` loop.**
  Freezing the world stops pedestrians walking into frame. The same spot measured
  12.9ms frozen and 24.6ms live; `lampVolume` read 0.29ms frozen against 3.49ms
  live.
- **An instrument that copies a buffer is what you are timing.** A probe doing
  `before.set(gBuf)` (122KB) around each of 503 `drawModel` calls reported hidden
  solids as 18.5% of the pass. They were ~2%.
- **A stub changes control flow, not just cost.** Replacing `floorSample` with a
  no-op leaves `_wd` stale and non-zero, so every cell took all four buffer writes
  instead of the usual early `continue` — which invented a 4.8ms "bare loop" cost
  that sent the session after a cache theory measuring exactly zero.
- **Absolute times drift by >2×, and it may be the user playing in another
  window.** Only tightly interleaved A/B inside one run is trustworthy. Report
  ratios, not milliseconds.
- **A fresh page load is not a populated world.** 387 of 430 pedestrians start
  `off`. Teleporting the camera onto a fresh boot gives a 0.7ms sprite pass where
  real play gives 11ms. Sweep for a busy vantage (`statSprites`), then run several
  `worldPasses()` to warm the voxel cache, before timing anything.
- **Use `gl.finish()` around anything GPU-side**, or you are timing command
  submission.
- **Top-level `let`/`const` are not `window` properties.** `function` declarations
  are, so `window.floorPass = wrapper` works for instrumenting; `window.lamps = [...]`
  silently does nothing.

---

## 7. Dead ends — measured, rejected, do not retry without new information

- **Hierarchical empty-space skipping in the voxel marcher** (4×4×4 occupancy per
  model so rays stride over air). Byte-identical and **6.3% slower** on a heavy
  scene, re-confirmed on a quiet machine. Models are ~16 voxels across and the
  sampler steps at 0.7 of a voxel, so a 4-voxel block is worth ~3 samples and the
  block-exit arithmetic costs more than 3 samples do.
- **A coarse water-proximity bitmap** to avoid the per-cell `tType[iy*MAP+ix]`
  read. Correct superset, skipped 97.4% of the reads, bought **0.05ms**. The tile
  lookup is not the bottleneck.
- **Reordering `wallPass` before `floorPass`** to avoid floor overdraw. Erases the
  facade reflections painted onto the wet road.
- **Sprite draw order** — `drawList` is sorted far-to-near, but measured overdraw
  is only 1.24× and just 9.2% of writes are wasted. Flipping it buys almost
  nothing.

---

## 8. Running it

```bash
node serve.mjs 8123
```

Then open `http://localhost:8123/index.html`. In the browser pane, use
`preview_start` with the URL (a server may already be on 8123).

To force the finest grid from the console:

```js
CFG.manualRes = true; autoRes = false;
CFG.resIdx = CFG.CELLW.length - 1; initRender();
```

Busy vantages for benchmarking (heading 0.7, eye 1.7): `550,520` · `340,520`
(open park, floor-heavy) · `580,640` · `460,370`.

State: branch `fog-and-hd`, pushed. `main` is at `a9ad8c4` and deploys to
GitHub Pages at https://nukacolafamine-star.github.io/ascii-city/ — this branch is
**not** merged there yet.
