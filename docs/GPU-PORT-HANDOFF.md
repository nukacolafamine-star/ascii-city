# ASCII CITY — GPU renderer port, handoff

Rewritten at commit `da33b41` on branch `fog-and-hd`. Line numbers drift; the
function names do not.

---

## 1. The goal, and the one number that matters

**Target:** 180fps at the finest grid — 479×255, 122,145 cells — with no
perceivable loss of fidelity. That is a 5.56ms frame.

Where it started, measured inside the real frame loop at that grid with ~364
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

`simulate()` is 0.34ms. The game logic is not the problem, the netcode is not
the problem, the GPU is not the problem. **The frame is CPU rasterisation and
the card is idle.**

**Sky, floor and walls are now on the card.** The rest is not. Measured on the
same street on a slower afternoon (absolute times on this machine drift by more
than 2× — see §6 — so read the pairs, not the numbers):

```
                        switch off      switch on
skyPass                    1.70            —
floorPass                  6.71            —
wallPass                   6.21            —
glWorldPass                 —             8.93
──────────────────────────────────────────────────
worldPasses               35.48           30.54     0.86x
```

`glWorldPass` breaks down as **read 6.73, unpack 1.76, setup 0.25, upload 0.08,
draw 0.05**. Note what that says: the shader is free and the readback is the
entire cost. That is the shape of the next problem.

---

## 2. What is on the card, and what it is built on

### The compose swap — the hinge everything hangs off

`gBuf`, `bBuf` and `lBuf` are `Uint8Array`s of exactly `cols × rows`, which is
exactly an R8 texture. They upload as themselves with no JS loop and a
full-screen shader does the palette lookup.

| thing | what it is |
|---|---|
| `FS_COMPOSE` | the full-screen shader: cell → glyph/palette/level → atlas → light |
| `glComposeWorld()` | three `texSubImage2D` calls and one triangle |
| `GL.cellG/cellB/cellL` | R8 textures, `cols × rows` |
| `GPUC = { on: true }` | the A/B switch |
| `glPackWorld()` | still there, still correct, the fallback |

The point of it is not the 1.7ms. It is that a shader reading the world out of
textures can be fed by a pass that *writes* those textures, and compose never
learns the difference.

**Its one constraint:** compose is skipped and packing is used when
`_cpuLitFrame` is true — a frame where the CPU light buffers were written, which
is `GPUL.on` false or indoors.

### The world pass — sky, floor and walls (`GPUW`, `FS_WORLD`, `glWorldPass`)

One fragment per **character cell**, not per pixel, into two RGBA8 attachments
and an R32F:

```
colour 0   RGBA8   glyph, palette, distance level, wetness
colour 1   RGBA8   source kind, emitter kind, did-write
colour 2   R32F    depth
```

which is `gBuf/bBuf/lBuf/refBuf`, `srcBuf/emitKind`, and `dBuf`. It comes back
across the bus and every pass downstream is untouched.

`GPUW.stages` is a bitmask — 1 sky, 2 floor, 4 walls — and `worldPasses` runs
the CPU original for whatever the card did not do. That is what makes it
bisectable: the settings menu steps OFF → SKY → SKY+FLOOR → ON.

**Why a fragment and not a column.** The CPU walks one DDA per column and paints
spans of rows, because a span is nearly free once you are on the tile. A shader
has no spans. But screen row `r` at horizontal distance `d` sits at world height
`cam.z - (r + 0.5 - horizon) * d / projRows`, which is *linear in d* — every
cell is a straight ray in three dimensions, and sky/floor/wall is one
heightfield march per cell. The march may stop the moment something claims the
cell, because every row is claimed exactly once: `ceilLimit` drops past a tile's
top the moment that tile is drawn, so every later tile is clamped above it.

Three things do not obey that and are handled where they are:

- a **bridge deck** is depth-tested rather than claiming a row, so the march
  does not stop on one;
- the **lid of the tile the camera stands on** is drawn before the loop and does
  not move `ceilLimit` at all, so a later tile may still paint over it;
- **`wallMirror`** stays on the CPU. It is the only thing in the wall pass that
  writes to a cell other than the one being drawn, which is the one thing a
  fragment shader cannot do. It was lifted out of `wallPass` into its own
  function with its own DDA, and it runs after the pass rather than inside it —
  the same picture, because a reflection is blocked when a wall has claimed the
  row it would land in, every row below the horizon is claimed by the nearest
  tile that reaches it, and the one writer that clears wetness without drawing a
  glyph (a roof) cannot round its glyph to zero.

### What the shader is fed

Static, uploaded when the city is built: `wTile` (RGBA8 MAP², surface type +
riverbed, the building index across two bytes, the crossing's painted
character), `wLampG` (R32F, nearest lamp), `wDist`, `wFont`, `wTagArt`,
`heightT`. Per frame: `wCol` (per column — ray, wobble, occlusion cutoff, sky
angle) and `wRow` (per row — the two floor distances, the sky glow ramp, the fog
level and density multiplier), the lamp table, and the dome's current frame.

**Three things in there are not static and pretending they were cost real time:**

- **`litP`** — how many of a building's windows are lit is re-rolled every time
  the hour crosses into a new part of the day. `bldEpoch` is bumped where
  `updateClock` rerolls it and the building table goes up again.
- **`wayG`** — the red line home, recomputed twice a second at most. `wayEpoch`,
  and its own single-channel texture rather than a channel of `wTile`, because
  rebuilding four megabytes of interleaved bytes to move a red line would cost
  more than the pass.
- **`tags`** — graffiti, sprayed by hand and pruned daily. `tagEpoch`.

### Already on the card from earlier work

`FS_LIGHT` / `glLightPass()` / `GPUL` — per-cell lighting, with the heightfield
uploaded once as R32F for shadow taps. The working reference for "upload data,
run a shader, sample the result".

### Also landed, both byte-identical

- **`FOCC` / `floorOcclude()`** — the floor pass is shaded for the whole screen
  and then half of it is painted over by walls. One short DDA per column finds
  where each column's floor stops being visible. 1.28ms. Still used, and now
  uploaded to the shader so the ground stage is comparable cell for cell rather
  than only after the walls have painted.
- **`HIZ` / `hizBuild()` / `hizHidden()`** — a max-depth pyramid, 8×8 cells a
  tile, so a solid the buildings already hide is dropped once instead of once
  per cell. 0.33ms.

---

## 3. The rig, and the three things about it that lie

Load it in the browser pane console:

```js
await import('/tools/gpu-parity.js')
GPUT.boot()          // pin the window, force the finest grid, install the driver
```

**1. `requestAnimationFrame` stops in a pane tab.** The game freezes silently.
`GPUT.drive()` runs `frame` off a worker tick instead and neuters rAF so the
game's own re-arm cannot queue a backlog. The worker is **ack-paced** — it ticks,
the page acks, and only then does it tick again. A free-running `setTimeout(16)`
posts faster than a 40ms frame can consume, the message queue grows without
bound, and the tab stops answering the debugger at all, which reads exactly like
a hung renderer and is not.

**2. The pane resizes itself back a beat after you resize it**, and
`initRender` reads `window.innerWidth` directly — so the grid silently halves
under a benchmark that is still running. `GPUT.pin()` makes `innerWidth` and
`innerHeight` constants.

**3. THE PANE'S COMPOSITING CONTENDS WITH READBACK, AND IT IS TEN TIMES.**
Same build, same frame, same code:

```
pane fronted        bare getBufferSubData  16.2ms      fps 19
pane backgrounded   bare getBufferSubData   1.6ms      fps 30
```

This is the single biggest source of nonsense in this port's measurements. The
same commit measured 0.84× and 1.32× twenty minutes apart because the pane had
been fronted in between. **Open a second tab, front it, and drive the game tab
from the background with `javascript_tool`'s `tabId`.** Then measure. The worker
driver is what makes that possible.

Note that `document.hidden` still reads `false` on a backgrounded pane tab, so
you cannot test for this — you have to arrange it.

---

## 4. Proving a change, and what "byte-identical" turned into

Every change gets an on/off switch in the settings menu (`GPUW`, `GPUC`, `FOCC`,
`HIZ` all have one), and is proved against the path it replaces before it is
committed.

```js
GPUT.parity(7)      // 35 poses, both paths, all seven buffers, cell by cell
GPUT.blockAB(2200, 5)   // whole frames, alternating blocks, on vs off
GPUT.measure(4000)      // the per-pass profile
```

The poses cover every heading, the whole clock, all four weathers, a rooftop,
both river banks, and four steep looks down. That last group is not decoration:
the off-screen mirror in the wall pass needs `2*horizon + 2*cam.z*unitRows` to
fall inside the frame, and at eye level with a level view it never does —
**nothing at all at pitch 0 from any heading, two to five thousand cells a frame
at −40 and below.** A pose set without them tests that code by not reaching it.

`GPUT.parity` also **proves the switch switches** (a flag being ignored produces
perfect parity) and **asserts the frame has content** (an empty frame compares
equal to another empty frame). Read pixels from `GL.scene.f`, never the default
framebuffer — the canvas has `preserveDrawingBuffer: false`.

### The instrument bug that hid inside the harness for a whole stage

`applyPose` did `window.clock = p.clock`. ASCII CITY is one classic `<script>`,
so its top-level `let`s live in the global **lexical** environment and never
appear on `window`. That line quietly created a dead property and left the real
clock alone, so thirty-five poses all ran at whatever hour the game happened to
be at — and the parity number looked excellent while an entire class of bug
(the stale `litP` table, §2) sat behind it. A module can assign the real binding
by name, because the binding is in scope. **Bare assignment, never `window.x =`,
for `clock`, `weather`, `wetLevel`, `_lampNight`, `lamps`, `inside`.**

### The stated tolerance, and why it is irreducible

Over 35 poses, 4,300,800 cells: **1,196 differ, 0.028%**, worst pose 0.23%,
five to eight poses exactly identical. Depth agrees to **1.2e-7 relative**.
Composed output at a wet downtown night vantage: **zero differing bytes across
all 7.4 million of the 1440×1280 frame.**

Every difference is one of two things, and both were tracked to the cell:

- a glyph one rung along the density ramp, where `Math.round` falls either side
  of a half;
- a material either side of a threshold **that the scene sits exactly on**.

The second is worth understanding before trying to fix it. The columns that flip
are **2.7e-7 and 9e-14** from a window-grid boundary; their neighbours that do
not flip are **0.013 and 0.093** away — four to eleven orders of magnitude
further. `gu` comes out at exactly 513.55 and 514.95, so `wf` is exactly 0.10
and 0.90, against tests written `wf > 0.10` and `wf < 0.90`. The city is laid
out on round numbers and so are the tests, so exact ties are common rather than
rare, and the CPU's own answer at such a tie is an artifact of double rounding.
No float implementation decides them reproducibly. This is the floor.

### What WAS worth fixing, and is already done

Everything that could be kept out of the float arithmetic was:

- **The camera's whole part is held apart from its fraction** (`uCamI/uCamF/
  uCamM/uCamH`, and `guv/hxv/hyv` inside `facade`). A kerb strip is a tenth of a
  metre wide and was being tested at an absolute world coordinate around 400,
  where a float has thirty microns between neighbours — a third of a percent of
  the kerb's own width as noise. The CPU, in double precision, came down the
  other side of it along whole diagonals of the screen.
- **The fog level comes off a table of boundaries solved on the CPU**, not off
  GLSL `pow`. A level is a truncation and a wall face shares one down its whole
  height, so that error lands as a block of the frame rather than a cell.
- **"Is this row past the view distance" is decided on the CPU**, and rides in
  as a negative distance. `projRows` comes out `144.00000000000003`, so a row
  landing on exactly the view distance is `96.00000000000001` in double and
  exactly `96` after the trip to the card — and the two disagree about a whole
  row of the frame.
- **The water's four time phases are wrapped into one turn before upload.**
  `worldTime` reaches thousands, where a float has microradians between
  neighbours; the two window-flicker clocks are truncated on the CPU for the
  same reason.
- **`bBuf` and `lBuf` are never cleared by `worldPasses`**, so a cell nobody
  draws keeps last frame's palette. The pass carries a did-write flag and the
  unpack leaves those cells alone, rather than writing a zero the check would
  rightly shout about.

---

## 5. What is left, and what the next stage has to do

`worldPasses()` order:

```
skyPass / ceilingPass → floorPass → wallPass → spritePass
  → signPass → reflectPass → lampVolume → rainPass → harvestEmitters
```

The first three are done. What remains, on the same slow afternoon:

```
spritePass     10.08      signPass    0.49
lampVolume      6.35      hizBuild    0.55
reflectPass     2.89      harvest     1.34
```

**The readback is now the whole toll and it does not get bigger.** `glWorldPass`
is 8.93ms of which 8.5 is getting the answer back to the CPU; the shader itself
is 0.05ms of submission and about 2ms on the card. Every pass that moves after
this one is nearly free, because it shares a readback that is already paid for —
and the moment the LAST reader of these buffers moves, the readback deletes
itself and takes eight milliseconds with it.

So the order is forced and it is the doc's original order:

**Stage 3 — sprites.** `drawModel` is a voxel ray-marcher, which is natively a
fragment shader. Volumes come from `voxelize` and are cached per
`(art, depthScale, round)`, so they can go up as 3D textures once. Each model
becomes a quad over its screen box; the depth the world pass already computes
handles occlusion. This is the biggest single pass left.

**Stage 4 — signs, reflections, the lamp volume, rain.** All screen-space passes
over data that is by then already on the card. `reflectPass` is pure
screen-space and reads only `gBuf/bBuf/srcBuf/refBuf` — the cheapest of them to
move, and the one that would let you delete a buffer from the readback.

**Then `wallMirror` and `harvestEmitters`** are the last two CPU readers. Kill
those and `glWorldPass` loses its readback entirely.

**Then reconsider `_cpuLitFrame`** and delete the CPU light path, which makes
compose unconditional.

---

## 6. Measurement traps that have already cost time

- **The pane's compositing contends with readback, ten to one.** §3. If a
  performance number is not reproducible, check this first.
- **`readPixels` into a typed array is a synchronous round trip.** Five
  milliseconds a call on this driver, and it does not care what you ask for — a
  single pixel measured 5.4ms against 5.8ms for the whole frame. Through a
  **pixel pack buffer** the same read is 0.004ms to issue and 0.87ms to collect.
  Issue all of them before collecting any, so the card has that long to finish.
  This was the difference between the port being 20% slower and 16% faster and
  nothing else about it changed.
- **An R8 attachment is worse still**: 6.6ms *each* to read back. Four one-byte
  buffers ride in one RGBA8 read instead, and the unpack is a shift and a store.
- **Profile inside the real frame loop, not with `worldPasses()` in a `for`
  loop.** Freezing the world stops pedestrians walking into frame. The same spot
  measured 12.9ms frozen and 24.6ms live; `lampVolume` read 0.29ms frozen
  against 3.49ms live.
- **Frame-by-frame interleaving is the wrong instrument for a readback.** A
  frame that reads the card back waits for whatever is still queued from the
  frame before it, while a frame that does not read lets the CPU run a frame
  ahead — so alternating hands the whole previous frame's GPU time to whichever
  side holds the readback. Measured that way the port looked 23% slower. Use
  `GPUT.blockAB`, which times whole frames in alternating blocks.
- **Absolute times drift by more than 2×**, and it may be the user playing in
  another window. The same commit measured `off` at 24.5ms and 34.5ms an hour
  apart. Compare ratios from adjacent runs, never numbers from different ones.
- **An instrument that copies a buffer is what you are timing.** A probe doing
  `before.set(gBuf)` (122KB) around each of 503 `drawModel` calls reported hidden
  solids as 18.5% of the pass. They were ~2%.
- **A stub changes control flow, not just cost.** Replacing `floorSample` with a
  no-op leaves `_wd` stale and non-zero, so every cell took all four buffer
  writes instead of the usual early `continue` — inventing a 4.8ms "bare loop"
  cost that sent a session after a cache theory measuring exactly zero.
- **A fresh page load is not a populated world.** 387 of 430 pedestrians start
  `off`. Sweep for a busy vantage (`statSprites`) and run several frames to warm
  the voxel cache before timing anything.
- **Use `gl.finish()` around anything GPU-side**, or you are timing command
  submission.
- **Top-level `let`/`const` are not `window` properties.** §4. `function`
  declarations are, so `window.floorPass = wrapper` works for instrumenting.
- **A backtick inside a comment inside a GLSL template literal** closes the
  literal and takes the whole 24k-line file out with one `SyntaxError`. Run
  `node tools/syntax-check.mjs` after every edit; it is two seconds.

---

## 7. Dead ends — measured, rejected, do not retry without new information

- **Packing the world pass into two attachments instead of three** (level,
  wetness, source kind and the did-write flag into one spare byte; the emitter
  kind derived from `srcBuf === 2`, which holds exactly within these three
  passes; depth bit-cast to four bytes and read straight into `dBuf`'s own
  buffer). Byte-identical, strictly less work — one fewer readback and a third
  less traffic through the unpack — and it measured **27.74ms against 27.83ms on
  the same baseline**, which is inside the block-to-block noise. The readback
  cost is a per-frame sync, not per call and not per byte.
- **Hierarchical empty-space skipping in the voxel marcher** (4×4×4 occupancy so
  rays stride over air). Byte-identical and 6.3% slower. Models are ~16 voxels
  across and the sampler steps at 0.7 of a voxel, so a 4-voxel block is worth ~3
  samples and the block-exit arithmetic costs more than 3 samples do.
- **A coarse water-proximity bitmap** to avoid the per-cell `tType` read.
  Correct superset, skipped 97.4% of the reads, bought 0.05ms.
- **Reordering `wallPass` before `floorPass`** to avoid floor overdraw. Erases
  the facade reflections painted onto the wet road.
- **Sprite draw order** — `drawList` is sorted far-to-near, but measured overdraw
  is only 1.24× and just 9.2% of writes are wasted.

---

## 8. Running it

```bash
node serve.mjs 8123
```

Then `preview_start` at `http://localhost:8123/index.html`, **open a second tab
and front it**, and drive the game tab by `tabId`.

Force the finest grid and the rig:

```js
await import('/tools/gpu-parity.js'); GPUT.boot()
```

Busy vantages (heading 0.7, eye 1.7): `550,520` · `340,520` (open park,
floor-heavy) · `580,640` · `460,370`.

`tools/` also holds `syntax-check.mjs` and `splice-gw.mjs` — the latter rebuilds
the world-pass block in `index.html` from scratchpad sources, which is how the
shader was edited as readable files rather than as a template literal wedged
inside a 24k-line page. The sources are not in the repo; if you want that
workflow again, split the block back out.

State: branch `fog-and-hd`, pushed. `main` is at `a9ad8c4` and deploys to
GitHub Pages at https://nukacolafamine-star.github.io/ascii-city/ — this branch
is **not** merged there yet.
