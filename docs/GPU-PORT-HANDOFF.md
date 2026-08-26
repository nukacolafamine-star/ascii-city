# ASCII CITY — GPU renderer port, handoff

Rewritten after stage 3 (the sprites) landed; updated again after stage 4 (the
tail) and **stage 5, which deletes the readback**. Line numbers drift; the
function names do not.

**THE PORT IS DONE.** At 480×256 with ~300 models, whole frames, adjacent
blocks: **56.8ms on the pure CPU path → 6.13ms with everything on. 9.3×, and
163fps against a 180fps target**, with two of four blocks under the 5.56ms
target outright.

**What changed since stage 3, if you read this doc before:** the readback is
20ms on a composited page and not 6, and the screenshot test for the condition
does not work while the rig is driving (§3.4); `wallMirror` is 0.10ms and not
2.65 (§1); the forced order is REVERSE pipeline order, not pipeline order (§5);
and the readback is **gone** (§5a) — not by moving `harvestEmitters` but by
making the read stop blocking, which turned out to be the cheaper question.

---

## 1. The goal, and where the frame actually is

**Target:** 180fps at the finest grid — 480×256, 122,880 cells — with no
perceivable loss of fidelity. That is a 5.56ms frame.

Where it started, measured inside the real frame loop at that grid with a few
hundred models in view:

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

**Sky, floor, walls and now the sprites are written for the card, correct, and
switched OFF.** Read that before you read anything else in here.

Both switches are off because the readback is still there and because
**the condition that decides has not been measurable from an agent session
since the browser pane stopped compositing** (§3.4). Every millisecond below is
the quiet condition. What that does and does not threaten is spelled out at the
end of this section.

Two adjacent runs at the same vantage, same minute, whole frames timed end to
end in alternating blocks (`GPUT.blockAB`):

```
the sprites alone, world pass held ON on both sides - three samples
  26.25ms  →  20.12ms      0.767x     −6.13ms
  36.72ms  →  31.92ms      0.869x     −4.80ms
  36.73ms  →  32.76ms      0.892x     −3.97ms
       last sample, block by block
       off  37.04 36.73 36.46 36.65 37.03 36.71
       on   31.79 32.76 32.00 33.05 32.98 32.06

the whole port against the CPU path
  33.28ms  →  19.38ms      0.583x     −13.89ms
  32.67ms  →  19.24ms      0.589x     −13.43ms
  33.92ms  →  20.44ms      0.603x     −13.48ms
```

**Read the range, not a figure.** Those three sprite samples are within an hour
of each other and the machine's own baseline moved from 26ms to 37ms between
them, which is the drift §6 warns about doing exactly what it says on the tin.
Each sample's blocks are tight — the third varies by 1.3ms across twelve blocks
— so each is a good measurement of a machine that was not the same machine
twice. The port is **4 to 6ms of sprite pass deleted, 0.77x to 0.89x**, and the
whole port is **0.58x to 0.60x**, which is the more stable of the two because
the gap it measures is bigger than the drift.

And the pass profile either side of it, at 122,880 cells with ~340 models:

```
        all on the CPU                world + sprites on the card
  floorPass        10.60        glWorldPass          0.26   submit
  spritePass        9.22        glWorldRead          6.09   THE TOLL
  wallPass          5.51*       glSpritePass         0.63   (0.59 of it CPU)
  lampVolume        3.98        applySpriteRefl      0.14
  wallMirror        2.73*       wallMirror           2.65
  reflectPass       2.60        reflectPass          2.35
  harvestEmitters   0.61        lampVolume           4.78
  signPass          0.41        harvestEmitters      0.60
  skyPass           0.32        signPass             0.40
  hizBuild          0.21
  ─────────────────────        ─────────────────────
  worldPasses      33.52        worldPasses         18.16
```

`*` wallPass calls wallMirror at its own tail, so the 5.51 already contains the
2.73. The two columns are minutes apart and this machine drifts by more than
2×, so read the shape, not the difference — the difference is the blockAB
above.

**Remeasured on a page that was actually compositing** (§3.4 — the figures
above were all taken in the quiet condition, because no session had been able
to get the pane to composite). Same vantage, 480×256, ~340 models, world and
sprites on:

```
  glWorldRead     19.7 – 21.1     THE TOLL, three times what it looked like
  lampVolume       4.77 – 4.81
  reflectPass      2.73 – 2.92
  harvestEmitters  0.88 – 0.91
  spritePass       0.58           what is left of it: the draw LIST
  signPass         0.39
  glWorldPass      0.26
  applySpriteRefl  0.13
  wallMirror       0.10 – 0.12    ← NOT 2.65; see below
  rainPass         0.05
  ─────────────────────────
  worldPasses     30.2 – 30.5
```

**The readback is 65% of the frame, and the whole CPU tail keeping it alive is
9.8ms.**

With stage 4 on — the reflections, the lamp beams and the rain all on the card
and the answer handed forward to compose — the same vantage, adjacent samples:

```
                       tail off        tail on (stages 7)
  reflectPass          2.82 – 2.90     0
  lampVolume           4.81 – 4.86     0
  rainPass             0.04            0
  glTailPass           —               0.22 – 0.23   submission
  glTailRead           —               0             it never comes back
  harvestEmitters      0.92            0.91          untouched, as designed
  worldPasses         30.7 – 36.5     24.9 – 25.0
```

Whole frames, alternating blocks, three adjacent samples with the blocks tight
inside each:

```
  31.64 → 26.15    0.827
  31.61 → 26.05    0.824
  31.31 → 25.75    0.822       −5.5ms
```

**0.82×, and the range is real.** Seven and a half milliseconds of CPU are
deleted and the frame improves by five and a half, because the 20ms readback
underneath is untouched — it is still there for `harvestEmitters`. The last
sample caught the pane dropping out of compositing mid-run (both sides fell,
off to 18–20ms and on to 9.6–9.9ms) and the ratio in **that** condition is
~0.51, because the readback stops masking the saving. Both are honest; the
0.82 is what a player sees.

**`wallMirror` is not 2.65ms — it is 0.10ms.** The 2.65 in the table above was
taken somewhere this doc did not record. The pass can only write when
`2*horizon + 2*cam.z*unitRows` falls inside the frame, which needs a steep look
down — this doc says exactly that two sections later — and its DDA stops at the
first thing tall enough to fill the column. So stage 5 is not "2.65 plus 0.60".
It is **harvestEmitters, and a tenth of a millisecond of company.**

**The one number that still decides everything: `glWorldRead` is a sync, not a
transfer.** It is what the port pays for existing. Sprites
were nearly free to move because they went on the card *between* the world's
draw and the world's read and shared that sync. Every pass left is in the same
position. The moment the last CPU reader of these buffers moves, the readback
deletes itself and takes six to eight milliseconds with it.

**What the quiet condition threatens, and what it does not.** A backgrounded
pane does not contend with the compositor, and readback measured there costs
1.6ms where the same call on screen cost 16.2ms. So:

- the **sprite** ratio holds the readback constant on *both* sides. It is CPU
  work deleted, and compositing cannot take it back. Trust it.
- the **whole-port** ratio compares a side that reads the card back against a
  side that does not. On screen the left-hand number is the one that grows. Do
  not quote 0.58 as the port's win until somebody has run it on a visible page.

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

One fragment per **character cell**, not per pixel, into two RGBA8 attachments,
an R32F and a real depth buffer:

```
colour 0   RGBA8   glyph, palette, distance level, [wetness | source | wrote]
colour 1   RGBA8   emitter kind
colour 2   R32F    distance
depth      D32F    the same distance, plus the sprite pass's 0.02 bias
```

**The fourth byte of attachment 0 is three things, and that is not tidiness.**
Wetness is 0..2, source kind is 0..2, did-write is a bit; packing them frees
attachment 1 to hold the emitter kind *alone*. A solid drawn over a lit window
keeps that window's `emitKind` on the CPU — the sprite pass never touched the
array — and a fragment shader cannot keep a byte it is not allowed to read. So
the byte lives in the one attachment the sprite pass binds to `NONE`. Before
that repack, 1,459 cells a frame disagreed on `emitKind` alone and swamped
every other number in the report.

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

Three things do not obey that and are handled where they are: a **bridge deck**
is depth-tested rather than claiming a row; the **lid of the tile the camera
stands on** is drawn before the loop and does not move `ceilLimit`; and
**`wallMirror`** stays on the CPU, because it is the only thing in the wall pass
that writes to a cell other than the one being drawn.

### The sprite pass — every solid in the frame (`GPUS`, `FS_SPRITE`, `glSpritePass`)

`drawModel` is a voxel ray marcher walking one screen cell at a time, and a
voxel ray marcher is what a fragment shader **is**. Three things had to move.

**1. The readback moved.** `glWorldPass(defer)` now draws and returns;
`glWorldRead()` is the trip back. The sprites go on the card in between, so the
two passes share one sync instead of paying for two. This is the whole
economics of the port and it is why stage 3 cost 0.04ms of submission.

**2. The volumes live on the card.** `voxelize` already caches one
rasterisation per `(art, depthScale, round)` and hands back a `Uint8Array` laid
out x fastest, then depth, then height — which is exactly what `texSubImage3D`
wants. They are shelf-packed into one `R8UI` `TEXTURE_2D_ARRAY`, 256×256×64,
uploaded once each and never touched again. **Every art in the game** — 149 of
them, 198 volumes once the depth-scale variants are counted — fits in 147 of
the 256 shelf rows. A volume that will not fit gets no slot and the solid
wearing it is drawn on the CPU afterwards (`GS.defer`, `spriteReplay`), which
has not happened yet.

**3. The mirror turned round.** The reflection inside `drawModel` is a scatter:
it writes to a cell in a *different row* from the one it is shading. But the
flip is exact planar geometry rather than a screen trick — a point at height h
and distance t sits at row `horizon + (camz-h)*pr/t`, and its mirror at −h sits
at `2*horizon + 2*camz*pr/t` minus that row. So **the reflection of a solid is
the solid mirrored about the street**, and a fragment below the horizon can
march *that* instead of waiting to be written to. In the shader it is the same
march with `Ozz = Oz - 2*camz` and `Dzz = +k`. Gather, not scatter. The
reflections land in a target of their own (`GL.sRefF`) and are applied by
`applySpriteRefl` after `wallMirror`, gated on the same wetness byte the CPU
gates on — which is what keeps the two mirrors in the order they were written
in, and what makes "a solid claimed this cell so it is no longer a mirror" work
without any ordering bookkeeping at all.

The instance table is eight RGBA32F texels a solid, written by `spriteCapture`
at the exact point in `drawModel` where the per-solid work ends and the
per-cell loop would start — so **nothing is recomputed on the other side of the
bus**, because a recomputation is a place to drift. That is why the solids came
out byte-identical on the first run.

**Depth.** The world writes `gl_FragDepth = (t + 0.02)/uDFar`; the sprites write
`t/uDFar` and test `LEQUAL`. That is `dBuf[idx] < t - 0.02` — the CPU's own test
— with the bias moved onto the other operand. Sprite against sprite is the one
place it is not exact: the CPU compares `t' - 0.02 <= t` and the card compares
`t' <= t`, because a fixed-function test has one value to write and to compare.

`GPUS.stages` is a bitmask — 1 the solids, 2 their reflections — and the menu
steps OFF → SOLIDS → ON. **SOLIDS draws no reflections at all**: it is the
bisect step, not a shipping mode, and it measures 49,497 differing cells of
which 49,493 are the mirror it deliberately left out and 4 are the same 4
surface cells. That is the shape of an isolated stage, and it is what tells you
the 3,668 in the full mode really are the gather and not the marcher.

**Gated on `GPUW.stages === 7` and on being outdoors.** The solids test against
a depth buffer the world pass fills, and the world pass does not run indoors.
So `GPUS` is inert in a room, and the pose set now proves that rather than
assuming it.

**`hizBuild` does not run when the sprites are captured**, because the pyramid
is built from `dBuf` and `dBuf` has not come back yet. It costs nothing: its
cull is conservative and the depth test drops the same cells one at a time on
hardware that has cells to spare. Parity says so — zero surface cells differ.

**One thing the GPU path does not do:** `statCells`, the HUD's glyph counter,
is not incremented by the solids. Only the reflections add to it.

**And the volume atlas is not rebuilt with the grid.** A volume is a solid's own
shape and knows nothing about how many character cells the screen has;
`glSpriteTargets` resizes only the reflection target and its pack buffer, and
`glSpriteAtlas` runs once. Rebuilding four megabytes of array texture and
re-uploading two hundred volumes every time the window was dragged was a cost
with nothing on the other side of it.

### The tail — the reflections, and the two still to come (`GPUV`, `glTailPass`)

Everything after the sprites is screen-space work over buffers the card already
has, and it lives in one block that runs at the slot of the **first** pass the
card owns:

| thing | what it is |
|---|---|
| `GPUV = {on, stages, max}` | the switch. `stages` is a SUFFIX: 0, 4, 6, 7 |
| `TAIL_ALL = 7` | the whole chain. Short of it, the answer must come back |
| `glTailTargets()` | two three-attachment R8 targets, A and B, and one shared depth buffer |
| `FS_TSEED` | the CPU's `gBuf`/`bBuf`/`lBuf` into A, so every pass reads a texture and writes a texture |
| `VS_TREFL` / `FS_TREFL` | the reflections, one point per source cell |
| `FS_TLAMP` | the lamp beams. One pass, the lamp loop INSIDE the fragment |
| `lampCollect()` | the lamps that survive the cull, with their screen rects |
| `VS_TRAIN` / `FS_TRAIN` | the drops, as points. The CPU still chooses them |
| `rainCollect()` / `rainClearSrc()` | the two halves of rain, deliberately apart |
| `tailLevels()` | levelOf's eight boundaries, bisected once off the real function |
| `FS_TSREF` | applySpriteRefl: a gate and a copy over a target already here |
| `VS_TSIGN` / `FS_TSIGN` | the sign faces and the wall mirror, as points |
| `signCollect()` / `wmirCollect()` | the CPU half - all the geometry, none of the reads |
| `GPUH` | the fence that stops the readback blocking (§5b) |
| `glTailRead()` | the debug way back. Parity only; a full sync, all SIX buffers |
| `GV.dbgRead` | forces that trip at the full suffix, for the harness only |
| `GL.vCol` / `GL.vRow` | per-column and per-row constants, solved on the CPU |

**`GPUV.max` and `TAIL_ALL` are deliberately different numbers.** `max` is how
far the port has got; `TAIL_ALL` is how far it has to get before the trip back
disappears. Confusing the two is what made the first run of this pass hand
compose a frame with reflections but no lamp beams — the suffix test read
`tr !== GPUV.max`, which was trivially true at `max === 1`, so the block
skipped its own readback and published a half-finished frame.

**Compose is the consumer, and that is the whole economics of stage 4.**
`glComposeWorld` skips its three uploads and binds `GL.tailB` instead whenever
the tail owns the end of the frame. The answer goes FORWARD. Nothing new is
read back, which is why moving these passes costs nothing rather than costing a
second sync.

### Already on the card from earlier work

`FS_LIGHT` / `glLightPass()` / `GPUL` — per-cell lighting, with the heightfield
uploaded once as R32F for shadow taps. **`FOCC` / `floorOcclude()`** — one short
DDA per column finds where each column's floor stops being visible, 1.28ms,
byte-identical. **`HIZ` / `hizBuild()` / `hizHidden()`** — a max-depth pyramid,
8×8 cells a tile, 0.33ms, byte-identical.

---

## 3. The rig, and the four things about it that lie

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
`initRender` reads `window.innerWidth` directly. `GPUT.pin()` makes
`innerWidth` and `innerHeight` constants.

**3. THE POSE SET HAS NOW HAD TWO DEAD PROPERTIES IN IT.** Both had the same
shape and both made a thin sweep look like a thorough one:

- `window.clock = p.clock` — ASCII CITY is one classic `<script>`, so its
  top-level `let`s live in the global **lexical** environment and never appear
  on `window`. Thirty-five poses all ran at whatever hour the game happened to
  be at. Found last session.
- `cam.a = p.a` — **there is no `cam.a`. The camera's heading is `cam.ang`.**
  So thirty-five poses that claimed to cover every heading all rendered at one
  heading, for the whole of stages 1 and 2. Found this session.

The second one had been reporting a **thirtyfold** overstatement of the world
pass's error. With the heading axis actually connected, the world pass measures
**46 differing cells in 4,792,320 — 0.00096%** — against the 0.028% this doc
used to call an irreducible floor. It was not a floor. It was one heading, held
still, being hit thirty-five times: the city is laid out on round numbers, the
material tests are written against round numbers, and a camera parked on a tie
sits on that same tie in every pose you think you are varying.

If you add a field to a pose, **print it back off the object it is supposed to
have landed on** before you believe the sweep covers it.

**AND THE HARNESS HAS A CONFOUND OF ITS OWN: `bBuf` AND `lBuf` ARE NEVER
CLEARED.** A cell nobody draws keeps last frame's palette — that is deliberate,
and §4 lists it as one of the things kept out of the float arithmetic. But
`parityOne` renders side B first and side A second, so B inherits its stale
cells from the PREVIOUS POSE and A inherits its own from B. Any cell neither
side draws can therefore differ for reasons that have nothing to do with the
switch. It stays small because a busy vantage draws 121,083 of 122,880 cells,
which is why it has never shown up — but an ad-hoc two-render A/B that changes
pose without settling first will read **thousands** of differing cells and
every one of them is an artefact. Settle the pose (or compare at a fixed point
inside the frame) before believing a number from outside `GPUT.parity`.

**4. COMPOSITING CONTENDS WITH READBACK, IT IS TEN TIMES, AND THE QUIET SIDE IS
THE WRONG SIDE.** Same build, same frame, same code:

```
page on screen      bare getBufferSubData  16.2ms      fps 19
page backgrounded   bare getBufferSubData   1.6ms      fps 30
```

This has now caused a bad number in both directions. First it made the same
commit measure 0.84× and 1.32× twenty minutes apart. Then a session
"controlled for" it by backgrounding the page — because that is where the
numbers are quiet — and shipped a 14% regression as a 14% win.

**And `document.hidden` lies about which side you are on, in both directions.**
It read `true` on a fronted tab in a pane that was not being displayed, and
`false` on the same tab a moment later while the pane was still not
compositing — `computer{action:"screenshot"}` failed with *"the Browser pane is
not displayed, so the page is not compositing frames"* in the same breath. The
only reliable test of the condition is whether a screenshot comes back.

**AND THE SCREENSHOT TEST LIES TOO, IN THE ONE CONDITION YOU NEED IT.** This
doc used to say a screenshot coming back is the only reliable test. It is not.
A screenshot cannot come back *while the rig is driving*: the worker posts a
frame, the page spends 30 to 60ms rendering it, acks, and is posted another,
and the compositor never gets a window wide enough to serve the capture. It
times out at five seconds with that very message — **on a pane that is being
displayed perfectly well**. Pause the driver and the same call returns a fresh
frame instantly. So the sequence that actually tells you where you are is

```js
GPUT.pause(true);   // now screenshot — it returns, and it is current
GPUT.pause(false);  // now measure
```

and the instrument for the condition itself is **the readback**, because the
readback is the thing the condition acts on. `glWorldRead`, measured this
session on a page that was demonstrably compositing:

```
game tab fronted, pane displayed        19.7 – 21.1ms
a second tab opened in front of it      52.2 – 58.9ms   (and it stayed there)
this doc's "quiet" figure                6.09ms
```

The CPU passes did not move a hair across any of those runs — `reflectPass`
2.73 to 2.92, `lampVolume` 4.77 to 4.81, `harvestEmitters` 0.88 to 0.91 — so it
is the readback alone that moves, which is what GPU and compositor contention
look like and what CPU load does not.

**The port's toll on a real player's screen is therefore 20ms, and on a bad day
55ms, not six.** Every ratio in this document with a readback on one side and
not the other is correspondingly *understated*, and nobody should quote 6.09 as
the toll again.

**Stage 3 was measured entirely in the quiet condition**, because the pane could
not be made to composite from the session at all. §1 says which numbers that
threatens.

**And `GPUT.boot()` sets `CFG.manualRes = true`, which disables auto-res.** So
the rig never exercises the interaction in §6 at all. After any perf change, run
once at true defaults with no rig — `GPUT.drive()` only, no `pin()` — and watch
`CFG.resIdx`. Stage 3 was checked this way: **974 frames, sixteen seconds,
`resIdx` never moved off 6, and the volume atlas was never allocated**, because
the sprite targets are now built the first time the pass runs rather than on
every `initRender`.

---

## 4. Proving a change, and the two tolerances

Every change gets an on/off switch in the settings menu (`GPUW`, `GPUS`, `GPUC`,
`FOCC`, `HIZ` all have one), and is proved against the path it replaces before
it is committed.

```js
GPUT.parity(7)              // the world pass, 39 poses, all seven buffers
GPUT.parityS(3)             // the sprites, world pass held ON on both sides
GPUT.parityV(1)             // the tail, compose held ON on both sides
GPUT.blockAB(2200, 5, 'sprite')   // whole frames, alternating blocks
GPUT.measure(4000)                // the per-pass profile
```

A switch nested inside another cannot be compared on its own: the sprites only
run when the world pass is fully on, so `parityS` and `blockAB(...,'sprite')`
hold `GPUW` on for **both** sides and flip only `GPUS`. That is what makes the
number below a statement about the sprite shader and not about the world one.

`GPUT.parity` also **proves the switch switches** (a flag being ignored produces
perfect parity), and **asserts the frame has content** (an empty frame compares
equal to another empty frame). Read pixels from `GL.scene.f`, never the default
framebuffer — the canvas has `preserveDrawingBuffer: false`.

### The pose set

39 poses: four busy vantages, every heading, a look up and four steep looks
down, a crouch and two rooftop eye heights, the clock all the way round, all
four weathers, both river banks — **and two that stage 3 added**:

- **an interior.** `glWorldPass` returns 0 indoors, so no pose ever had to enter
  a room and nothing about one was on the card. `GPUS` is gated the same way,
  which makes these poses a test that the switch is *inert* indoors rather than
  a test of a shader — worth proving rather than assuming, because it is a whole
  branch of `worldPasses`. It measures 0 differing cells against 122,880 cells
  of real content.
- **a moving camera.** Occlusion between solids is the one place a buffer one
  frame stale would show, and a still pose cannot see it. These walk the camera
  five frames before the frame that is compared, identically on both sides.
  Surface cells differing: **0**.

The steep looks down are not decoration either: the off-screen mirror in the
wall pass needs `2*horizon + 2*cam.z*unitRows` to fall inside the frame, and at
eye level with a level view it never does — **nothing at all at pitch 0 from any
heading, two to five thousand cells a frame at −40 and below.**

### The world pass: 0.00096%

**46 cells differ out of 4,792,320.** One of them is a surface; the other 45 are
cells nobody claimed with a source kind (floor and mirror). Depth agrees to
1.2e-7 relative. Worst pose 0.0049%.

Every difference is still one of the two things the last session tracked them
to — a glyph one rung along the density ramp where `Math.round` falls either
side of a half, and a material either side of a threshold the scene sits exactly
on. What changed is how *often*: the columns that flip are 2.7e-7 and 9e-14 from
a window-grid boundary, and a camera that actually turns stops parking on them.

Everything that could be kept out of the float arithmetic already was, and all
of it still stands: the camera's whole part held apart from its fraction
(`uCamI/uCamF/uCamM/uCamH`), the fog level off a CPU-solved table rather than
GLSL `pow`, "is this row past the view distance" decided on the CPU and ridden
in as a negative distance, the water's four time phases wrapped into one turn
before upload, and `bBuf`/`lBuf` never cleared so a cell nobody draws keeps last
frame's palette.

### The sprites: 0.0766%, and it is all one thing

**3,672 cells differ out of 4,792,320 — and 4 of them are surfaces.**

```
                        cells differing, 39 poses
  the solids                    4
  their reflections         3,668
  level / wetness / source / emitter / depth        0
```

**The voxel marcher reproduced exactly.** `lBuf`, `refBuf`, `srcBuf`,
`emitKind` and `dBuf` are identical everywhere; only `gBuf` and `bBuf` move, and
only where a reflection landed. Depth agrees to 2.3e-7 relative. That is what
the capture point buys: the shader is handed `Ou/Ov/Oz`, the slabs, the step and
the level the CPU had already solved, so the only arithmetic it does for itself
is the march, and `int()` truncates the way `|0` does.

**The reflections cannot be exact, and every cell is accounted for.** At the
busy vantage, warm, 311 models in frame, with the same wetness gate applied to
both sides:

```
  the CPU's scatter wrote            4,317 cells
  the card's gather wrote            3,774 cells
    of which also CPU cells          3,774      it invents NOTHING
    of which the same glyph+palette  3,770      99.89%
  cells the scatter wrote and the gather did not     543
    the source cell ends up occluded by a nearer solid   232
    the search for the source row was too short           0
    the mirrored ray never saw the solid at that cell    311
```

Two causes, and neither is a rounding shrug:

- **232 — the ordering artefact.** The scatter writes its mirror at the moment
  a solid is drawn, against the depth buffer as it stood *then*. A solid that
  won a cell and was covered a moment later by a nearer one still threw its
  reflection. The gather only ever sees the buffer as it ended up, and no
  fragment shader can recover an order it was not present for.
- **311 — the mirror image is thinner than a cell.** The scatter starts from
  wherever it hit and *rounds* to a target; the gather has to hit at that
  target. A railing or a leg at thirty metres has a mirror image narrower than
  the cell the rounding put it in, and the ray through that cell's centre goes
  past it.

**Zero** were the search window being too short, which is the one that would
have been worth chasing. The rest was tuned rather than shrugged at. The gather knows
the exact *continuous* row a cell is the reflection of; the CPU walked *integer*
rows and rounded the target, and on a slanted surface the row that actually
wrote a cell can be several off. So the shader tries candidate rows from the top
down — the CPU's inner loop runs upward and its last write wins — and takes the
first that both lands on this cell and survives its own depth test. Cells
disagreeing with the scatter at the busy vantage, against the width of that
search:

```
  ±0    884        ±5    159
  ±2    437        ±8     72
              ±16     72
```

It converges at eight and buys nothing after, so `GS.mj` is `[8, -9, 1, 1]`.
Timed in whole-frame blocks against `±1`: **19.40ms against 19.28ms**, inside
the block-to-block spread of either. The card has the headroom; the search is
free.

`_refDbg` / `_refDbg2` are left in `drawModel` behind a null check. They record
what the scatter wrote, cell by cell with its source row and distance, which is
the only way to hold the two mirrors side by side. And `GS.mj[2] = 2` makes the
shader mark, in the one byte nothing reads, every fragment that got as far as a
hit on the mirrored solid and then found no source row rounding onto its cell —
which is what turned "543 cells missing" into the table above. A percentage on
its own would have told you none of it.

### 4-bis. Visible cells and hidden ones

`GPUT.diff` now splits every difference two ways, and the headline is
`visibleDiff`. A cell with **no glyph on either side** is discarded by compose
and cannot be seen: `bBuf` and `lBuf` are never cleared, so a cell nobody draws
keeps a palette from some earlier frame, and the card - seeding off the world's
own attachment - does not reproduce that. It does not propagate either;
everything that reads a palette reads it at a cell that has a glyph, and it was
measured at **zero** cells with the wrote-bit clear and a glyph to show.

Counting those with the rest buries real regressions: at one vantage it is
4,102 hidden against 4 visible. So they are counted apart, and the whole-chain
number below is **visible** cells.

### 4a. The tail: 0.0016%, and it is two things

**13 to 15 cells differ out of 4,792,320, and none of them is a surface.**
Level, source kind, wetness, emitter kind and depth agree everywhere; only
glyph and palette move, on 6 of the 39 poses, 2 or 3 cells each. The count
moves between runs because the world moves — pedestrians walk into and out of
the cells in question — and every one of them is the same cause.

Held against the **shipping** combination, `GPUW` and `GPUS` on underneath both
sides, it is **30 cells, 0.00063%, still no surfaces** — a little higher
because the GPU world's own irreducible cells feed the reflect inputs.

Every one of the 13 is **the ripple's row rounding landing on a half**. Traced
at the worst of them: the ripple came out `−0.500003674`, so `flat + ripple` is
`189.499996326` — **3.7e-6 from the boundary** — and the CPU rounds to 189 while
the shader's float32 `sin`/`cos` land a hair the other side and round to 190.
The reflection moves one row, and the two cells swap contents. It is the same
class as the world pass's own irreducible cells and there is nothing under it.

What kept it to 13 rather than thousands is the same discipline the world pass
uses: **everything separable was solved on the CPU and uploaded.** A row's
`kk`, the road distance it implies, its distance fade and its ripple amplitude
are functions of the ROW alone; a column's ray and that ray's squared length
are functions of the COLUMN alone. Both go up as small RGBA32F strips, and what
is left in the shader is one `sqrt`, one `pow`, one `sin` and one `cos`.

**It is a scatter, and it stayed one.** Stage 3 turned the sprite mirror round
by gathering, because the reflection of a solid is that solid mirrored about
the street and a fragment can march it. That does not transfer: the sprite
mirror had a SOLID on the far end, a thing with a shape a ray can hit, while
this one has a screen cell, and which source row lands on a given destination
depends on that source's own depth. A gather would walk the whole column — 256
taps a cell where the scatter does one. So the card scatters it: **one POINT
per source cell**, placed by the vertex shader at the cell it reflects into and
moved off-screen when it reflects nowhere. The CPU's inner loop runs upward and
its last write wins, which is a priority — and **a depth test with the source
row as the depth and GREATER as the comparison is that rule exactly, in fixed
function, for nothing.**

Cost: `reflectPass` 2.83–2.92ms of CPU becomes `glTailPass` **0.18–0.19ms of
submission**, adjacent samples, on a composited page.

### 4b. The lamp beams, and why the loop went inside the fragment

**24 cells over 39 poses at `stages 6`, 0.0005%.** The whole tail at `stages 7`
is **75 cells, 0.00157%, of which 2 are surfaces** — and the bisect is
additive: on one pose, 7 cells to the reflections and 4 to the beams, 11 to
both, with no interaction between them.

Every beam cell is **a `Math.round` in the resolve landing on a boundary**.
Traced, the ten lift-branch cells came out with `tau × lift × RMAX` sitting
0.0006 to 0.022 from a half-integer, and the one palette difference was
`2 + floor(tau × (LAMP_STEPS−2))` on the rung boundary instead. GLSL `pow` and
`Math.pow` differ in the last bits and the resolve truncates four separate
times off the back of them. There is nothing under that short of taking the
pass off the card again.

**The lamp loop is inside the fragment, and that is the whole design.** The
obvious port is one quad per lamp with blending — additive for the sum, MAX for
the strongest cone. It does not work: the resolve needs the WINNER'S ramp and
the WINNER'S depth, and a componentwise MAX over RGBA decouples them, taking
the largest tau from one lamp and the largest ramp index from another. Packing
tau and its payload into one float so a single MAX carries the pair is the
usual dodge, and every payload bit is a bit off tau — which is exactly what
those four truncations are reading. (Reasoned, not measured. If someone wants
to try it, that is the thing to measure.)

So `vMax`, `vSum`, `vCol` and `vDep` stop being four screen-sized arrays and
become four registers, the winner never survives a blend, and the resolve
happens in the same shader while they are all still in scope. What it costs is
the lamp loop per cell — which is why **the CPU still does the culling.** Its
outer loop was never the expense: 1,794 lamps in the city, **48 in frame**, and
the 4.8ms is the double loop underneath. `lampCollect()` hands over the
survivors with the screen rect it already worked out, and the fragment tests
that rect before it solves anything.

`levelOf` does not go in the shader. It is a truncation of a `pow`, so its
eight boundaries are found once by **bisecting the real function** — not by
inverting it — and ridden in as thresholds, for the same reason the world pass
keeps its fog level on a CPU-solved table.

### 4c. The rain, and the half of it that stayed

Rain costs 0.05ms and its cell list depends on nothing but `worldTime`, so
**none of its arithmetic moved — only its writes did.** The CPU goes on
choosing the drops exactly as it did and hands the card the ~1,400 points;
`gl_VertexID` reads them out of a texture and the fragment writes glyph,
palette and level. Drawn with no depth test, in the CPU's own order, because
primitive order *is* "last write wins".

Two reasons the arithmetic stayed. `hash3` is `Math.imul`, which is exact in
GLSL — but the divide by 2³² that turns it into a float is not, since
`float(uint)` rounds at 24 bits, and a drop one row out is a drop in the wrong
place for nothing gained. And the CPU half keeps its own `srcBuf` clears, which
is what holds `harvestEmitters` byte-identical: **measured, `srcBuf` differs in
0 cells** with the whole tail on.

`rainCollect()` and `rainClearSrc()` are deliberately separate calls. The beam
pass reads `srcBuf` to know what not to wash out, and on the CPU rain runs
*after* the beam — so the list is built before the upload and the clears are
applied at rain's own slot afterwards. Fused, a raindrop would silently
un-mark a source the beam was supposed to spare.

```js
GPUT.parityV(7)     // the whole tail, compose held on for both sides
GPUT.parityV(6)     // the beams and rain
GPUT.parityV(1)     // the reflections
```

Anything short of `stages === 7` is a **bisect** step, not a shipping mode: it
reads its own answer back so there is something in `gBuf` to compare, which is
a full sync and measures *slower* than leaving the switch off (`worldPasses`
30.4 → 43.8ms at `stages 1`, of which 17.0 is the deliberate `glTailRead`). At
the full suffix the trip back is gone — `glTailRead` measures **0** — and the
answer goes forward into compose.

Which leaves the harness a problem: it compares CPU buffers, and the point of
the full suffix is that the answer never becomes one. So **`GV.dbgRead` forces
the trip back, and it is set by `parityOne` and nowhere else.** It was in the
tail switch's `hold()` at first, which was wrong: `blockAB` calls `hold()` too,
and a readback on both sides of a timing run measures the harness rather than
the change.

---

## 5. Stage 5, and what is left after it

`worldPasses()` order:

```
skyPass / ceilingPass → floorPass → wallPass → spritePass
  → signPass → reflectPass → lampVolume → rainPass → harvestEmitters
```

The first four are done, and so is the whole tail — reflections, beams and
rain (§4a–4c). What remains:

```
glWorldRead     19.7 – 22.1   ← the toll, and the prize
harvestEmitters  0.88 – 0.94  ← THE LAST CPU READER OF THESE BUFFERS
spritePass       0.58         ← what is left of it: the draw LIST, on the CPU
signPass         0.39
applySpriteRefl  0.13
wallMirror       0.10 – 0.12
```

### 5a. Stage 5: the readback, deleted

Four CPU passes still read the world's buffers, and between them they held a
20-to-63ms sync open. **None of their geometry moved.** What held the readback
open was never what they COST - `wallMirror` 0.10ms, `applySpriteRefl` 0.12,
`signPass` 0.47 - it was two QUESTIONS they had to ask of a buffer they could
not otherwise see:

- `reflects(j)` — is this cell still water? That is `refBuf`, and the card can
  gate on it in a fragment shader.
- `dBuf[idx] < t - 0.02` — is something already nearer? That is a depth test,
  and the card does it in fixed function.

So `wallMirror` and `drawSignPlane` keep every line of their arithmetic — the
DDA, the facade material, the sign's border ring and bezel and ink — and gained
an **emit mode**: instead of writing a cell they hand over a POINT, and the
card decides which survive. The seed pass writes the world's distances into the
depth buffer, so the sign points test against it without anyone reading `dBuf`.
`applySpriteRefl` moved outright, being a gate and a copy over a target that
was already a texture.

It costs the CPU a little MORE than before — `signPass` measured 0.47ms and now
0.49 to 0.79, because it can no longer skip an occluded cell early: it does not
know what is occluded, and emits ~10,000 points where 7,700 survive. That is
the right trade by two orders of magnitude.

**The chain state became six buffers, not three.** `signPass` writes a source
kind, a wetness byte and a distance as well as a glyph, and `reflectPass` reads
all three back off it. Carrying only the visible three is what made the first
sign run report 74,000 differing "surface" cells — the harness was holding the
GPU's glyphs against the CPU's un-signed `srcBuf`. That was the debug readback
being wrong, not the shader.

### 5b. And the readback itself: not moved, unblocked

`harvestEmitters` is the last reader and it does not port cleanly. It is a
REDUCTION - 3,440 buckets summed off the screen, filtered, then **the biggest
110 kept** - and that clamp binds hard: 448 to 835 buckets pass the weight
floor at a busy vantage and 110 survive. Top-110-of-3,440 on a card with no
compute shaders is a prefix-sum and a threshold search, several passes, and
still not byte-exact against a CPU sort.

So the question changed. With the whole tail on the card, **harvest is the only
thing left that reads those buffers at all** - and what it builds is a light
LIST: a few hundred bucket averages of emitters that barely move, spent as a
soft glow. It does not need this frame's answer.

Deferring by one frame is **not** enough on its own, and that is worth knowing:
measured, it took 21.9ms down to only 15.1ms, because the CPU runs further
ahead of the card than a single frame. The answer is not "wait a frame", it is
**never wait**. Each read is issued into one of three pack-buffer sets and
carries a `fenceSync`; the fence is polled with `clientWaitSync(…, 0, 0)` and
the collect happens on whichever frame it comes back signalled. If it is not
ready the harvest keeps the list it had.

```
  glWorldRead   21.9ms  →  15.1ms  deferred one frame
                        →   0.79ms fenced   (0.19 sync + 0.60 unpack)
  worldPasses   ~25ms   →   4.16ms
```

### 5b-bis. What that got wrong, and what a player found

**This section used to claim the deferral cost "one frame of latency in the
light list and nothing else". That was false, and it shipped.** Two bugs came
out of it, both reported from play, neither visible to the harness.

**1. The whole picture lagged, not the light list.** The tail seeded from
`gBuf`/`bBuf`/`lBuf`/`srcBuf`/`refBuf`/`dBuf` - the CPU's copies - which is
fine while the read is immediate and wrong the moment it is not. Measured: one
frame after a camera jump the composed output still matched the OLD pose 44.5%
and the new one **6.8%**, against 100% with the deferral off. On a moving
camera that is the world swimming behind you with current-camera lighting laid
over stale geometry.

Fixed by seeding the chain from **the world pass's own attachments**, which are
always this frame. `GL.wT[0]` packs glyph, palette, level and the same fourth
byte `glWorldRead` unpacks; `GL.wT[2]` is the distance. The CPU copies come off
the display path entirely and go back to being what 5b meant them to be: input
for the harvest. Six full-grid `texSubImage2D` a frame go with them.

Two conditions on that, and the second is not optional: the card must have
drawn the whole world this frame **and the tail must own the whole chain**. At
any shorter suffix the CPU has already run the passes ahead of the tail and
written them into `gBuf`, and the attachment knows nothing about them. Missing
that took rain-only parity from byte-identical to **14.8% of cells wrong**.

**2. The light list collapsed on every fence miss.** `worldPasses` clears
`srcBuf`, `dBuf` and `emitKind` at the top of every frame, and a deferred read
that is not ready returns *without refilling them* - so the harvest ran over an
all-zero `srcBuf`, found no sources, and built an empty list. Measured: the
list goes from 120 entries to **10** (just the appended off-screen lamps). On
screen that is a building standing dark with no emission and flashing back the
moment a read lands, which is exactly how it was reported.

Fixed by not harvesting a clear screen: if the buffers are not this frame's,
keep the list already built. With every single frame forced to miss, the list
now holds at 120 and the picture stays 100% correct.

**3. And the harvest lost every SIGN as a light source.** This one is not a
GPUH bug at all - it was in stage 5 from the day it landed, and GPUH only made
it easier to notice. `signPass` marks a sign face `srcBuf = EMISSIVE ? 2 : 1`,
and once the card owns signPass the CPU's `signPass()` is skipped. At any
suffix short of the whole chain `glTailRead` runs and reads the source byte
back, so nothing shows; at **TAIL_ALL it does not run at all**, and the CPU's
`srcBuf` never learns the signs exist. Measured at one vantage, non-window
sources: **3,913 at suffix 56 and 60, and 871 at 63.** That is every shopfront
dropping out of the light list - the street dims, and what is left redistributes
as you turn, which reads as the window lights flickering off.

Fixed by having `drawSignPlane` keep its CPU writes in emit mode as well as
emitting the point - depth tested, because the card applies the same test to
the point and the copy has to agree with what lands. It costs a handful of
stores on cells the pass already walks.

`signPass` is the ONLY tail pass whose `srcBuf` writes matter here, and that is
measured rather than assumed: `reflectPass` and `applySpriteRefl` were both
counted clearing a live source **zero** times, `lampVolume` skips sources by
construction, `wallMirror` does not touch the byte, and rain keeps its clears on
the CPU already. With the world frozen, all six configurations from all-CPU to
tail 63 with harvest on now agree exactly: 20,137 sources, 15,781 of them
windows, 4,356 not.

**Why the harness could not see either.** `parityOne` sets `GV.dbgRead`, which
forces the read back to immediate - so **the deferred path is never rendered
under test**. That is not a gap that can be closed by adding poses; the pose
set proves a frame in isolation and both of these are properties of a SEQUENCE
of frames. §4 now measures what it can: `visibleDiff` versus `hiddenDiff`.

**What it costs, measured, because it is the one thing in this port that is not
parity.** Driving a brisk turn-and-walk (0.22 tiles and 0.03 radians a frame),
a list one frame late sits **0.35 world tiles** from the fresh one with colours
within a quarter of one 0-255 channel; two frames late, 0.57 tiles. And 29 of
120 buckets change identity frame to frame even when the list IS fresh, because
buckets enter and leave frame as you turn - so the lag adds about as much as
the natural churn already does. The fence misses roughly half of frames, so the
list refreshes every other frame.

**The pose parity cannot see this and never will**, by construction: it
compares CPU buffers and the light list is not one of them. Stated here rather
than buried, because it is the single approximation in the whole port.

### 5c. What it all measures

```
                                        ms/frame    fps
  all five GPU switches OFF (pure CPU)    56.8      17.6
  compose + lighting only (the start)     34.3      29.2
  EVERYTHING ON                            6.13    163.1
       blocks: 6.13  5.48  7.27  5.31
  the target                               5.56    180
```

**9.3× against the pure CPU path and 5.6× against where this doc started.** The
median misses 180fps; two of the four blocks beat it. The measured ceiling in
§5d predicted 3.2-3.7ms and the real thing lands at 6.13 - the difference is
that the ceiling probe had stale buffers making `harvestEmitters` cheaper than
it is, and that `signPass` costs more in emit mode than it did.

Parity across the whole chain, 39 poses, `GPUW` and `GPUS` held on both sides:
**80 VISIBLE cells in 4,792,320 - 0.00167% - of which 2 are surfaces, and
source kind, wetness and depth are byte-identical everywhere (s=0, r=0, d=0).**
The suffixes below it: 62 and 60 and 56 all at 42, 48 at 23, **32 at zero**.
Hidden cells appear only at 63, which is the only suffix that seeds off the
card - see §4-bis. Every
grid in `CFG.CELLW` sweeps clean with the camera moving, and auto-res holds at
true defaults over 954 frames.

**They still default OFF, and that is now a decision rather than a necessity.**
The reasons to leave them off for the moment: the light-list lag above is a
fidelity call somebody other than the harness should look at; this is one
machine and one driver; and `clientWaitSync` behaviour is the kind of thing
that varies. Turning them on is a menu away and the auto-res guard no longer
holds the grid when the read is unblocked.

### 5d. The ceiling probe, for the record



Stub `glWorldRead` entirely — no `readPixels`, no `getBufferSubData`, no unpack,
which is exactly what stage 5 leaves behind — and let every downstream CPU pass
go on running at its real cost. Four rounds, adjacent blocks, 480×256, ~310
models, everything else on:

```
  all five GPU switches OFF (pure CPU)          44.2ms     22.6 fps
  compose + lighting only (the doc's start)     27.4ms     36.5 fps
  everything on, readback at 63ms               67.7ms     14.8 fps
  everything on, readback DELETED                3.19ms   313    fps
                                                 3.15 3.15 3.19 3.25
  the target                                     5.56ms   180    fps
```

**3.19ms against a 5.56ms target.** The whole remaining gap to 180fps is the
readback and nothing else. Where that 3.19 goes (nested passes not double
counted):

```
  glSpritePass     0.547   submission, and it contains spritePass 0.505
  signPass         0.466   CPU
  harvestEmitters  0.395   CPU  (0.92 on live buffers - see the caveat)
  glWorldPass      0.237   submission
  glTailPass       0.217   submission
  applySpriteRefl  0.122   CPU
  wallMirror       0.101   CPU
  ──────────────
  worldPasses      2.31    + ~0.9 of present, HUD and simulate
```

**Caveat, stated because §6 says a stub changes control flow and not just
cost:** with nothing read back the buffers go stale, and `harvestEmitters`
reads 0.395ms here against 0.92ms on live data — it finds fewer sources to
bucket. Add that back and the honest ceiling is **~3.7ms, ~270fps**. Either
figure clears 5.56ms with room to spare.

**Nothing is left holding the readback open.** What remains, if anyone wants it:

- **`harvestEmitters` on the card for real** (a reduction plus a top-110), which
  would remove the one approximation in §5b. It is several passes and still not
  byte-exact against a CPU sort; the fence made it unnecessary rather than easy.
- **The tail still UPLOADS its inputs** from CPU buffers that came off the card
  in the first place. Wiring it to read the world pass's attachments directly
  would delete six `texSubImage2D` calls a frame and the unpack loop with them
  - 0.60ms of the 0.79 that `glWorldRead` still costs.
- **`spritePass` 0.5-1.0ms** is the draw LIST, built on the CPU inside
  `glSpritePass`. It reads nothing that comes back, so it never blocked
  anything; it is simply the largest CPU item left.
- **Then `_cpuLitFrame`**, and the CPU light path can go, which makes compose
  unconditional.



### The order is forced, and it is REVERSE pipeline order

This doc used to read the forced order as pipeline order — signs, then
reflections, then the lamp volume, then rain, then the two stragglers — on the
grounds that every remaining pass is "nearly free to move and worth nothing on
its own". **That is the wrong way round, and taking it costs a second sync.**

A ported pass has to get its answer to the screen. Compose is the only thing
downstream of these passes and compose reads TEXTURES, so:

- a pass whose output flows **forward** into compose costs nothing to move;
- a pass with a CPU pass still **behind** it has to hand its buffers back, and
  a hand-back is a whole second readback on top of the first.

`lampVolume` reads `gBuf`. `rainPass` writes it. So porting `reflectPass` on
its own — the pipeline-order move, and the one this doc recommended — leaves
`lampVolume` reading a `gBuf` with no reflections in it and forces the answer
back across the bus. **The chain has to be eaten from the tail end forwards**,
which is why `GPUV.stages` is a suffix (0, 4, 6, 7) and not a mask you may pick
from.

**And the reflections cannot dodge it by going earlier instead.** The obvious
alternative is to run them between the world's draw and the world's read, the
way the sprites got in for 0.04ms. Measured: **18.7% of every reflection in a
wet downtown frame is a sign being mirrored**, and `signPass` is a CPU pass
that runs *after* the read. A gather placed before the read loses a fifth of
them silently.

**What the harvest sees**, measured over four busy vantages, because it is the
only CPU reader left behind these passes:

```
reflectPass clearing a live srcBuf cell     0 of 25,969   never happens
lampVolume writing bBuf at a source         0             it skips them
rainPass clearing srcBuf                    220 – 678 cells, 31 – 269 emitters
```

So reflections and lamp beams are free of the harvest entirely, and only rain
touches it. Rain's cell list depends on nothing but `worldTime`, so the CPU
goes on computing rain for a twentieth of a millisecond, keeps its own `srcBuf`
clears, and hands the card the ~1,400 points to draw — and the harvest stays
byte-identical for nothing.

**Then reconsider `_cpuLitFrame`** and delete the CPU light path, which makes
compose unconditional.

**Do not default `GPUW` or `GPUS` on before the readback is gone**, and not
before somebody has run the port on a page that is actually being composited.
Turning them on is safe now — the grid is held while they are on, and the
sprite atlas no longer takes the session's unpack alignment with it (§6) — but
safe is not the same as fast, and on a composited page the readback is still
ten times what it measures here.

**Both of those were found by a player turning the switch on, not by the
harness**, and both were outside what the pose set can see: one is auto-res,
which the rig pins, and the other only shows at a grid whose column count is
not a multiple of four, which the rig's pinned 480 is. **Sweep every entry in
`CFG.CELLW` after any change to a texture upload**, with the camera moving
between renders, and check `gl.getError()` at each one.

---

## 5e. What the port was FOR: every window is a light

The optimisation was never the point. This is.

`FS_LIGHT` could always do this - it solves a glow sphere per source, takes the
chord this view ray cuts through it, shadows that chord against the city's
heightfield and lays the result into the air. It was never the shader that was
the limit. **It was the LIST**, and the list was three separate apologies for
not being able to afford anything, all written when the frame was 27ms of CPU
rasterising:

```
  LIGHTV.block  6      six cells by six collapsed into one source
  LIGHTV.winW   0.22   a lit window counted as a fifth of a sign its size
  LIGHTV.keep   110    and everything past the brightest hundred thrown away
```

Measured now: **thirty sources and two hundred and twenty cost the same 4.6ms
frame.** The per-light cost is in the noise, because a light whose glow the ray
misses is rejected in a handful of instructions. So `GPUE` opens the list up -
block 2, windows at full weight, ceiling 4096 - and the count goes from
**120 sources to 4,106**. Every lit window, every sign face, every stall, every
lamp, each with its own glow and its own shaft through the air.

**Two things had to be fixed for it to look like anything.**

*The ambient term was voting per light.* `occ += 1 - sh; occW += 1;` is fine
for a hundred hand-picked sources and wrong for four thousand: from any given
cell nearly all of them are occluded, `occ/occW` pins at 1, and the ambient
floor bottoms out everywhere. The whole street darkened by half while the one
shopfront in front of you blew out. It is weighted by how much each light
actually reaches the surface now.

*And the tuning had to be fitted to two vantages, not one.* An open street and
a canyon of close windows want different numbers, and a setting fitted to the
first blows the second out. Mean light, and the fraction of cells over 150 -
where colour is lost to white:

```
                          open street        canyon of windows
  sparse baseline         31.3  hot 0%        12.9  hot 0%
  gain 0.26 roof 205      62.7  hot 4.7%     108.4  hot 18.1%   blown
  gain 0.20 roof 165      49.0  hot 0%        84.9  hot 0%      <- shipped
  gain 0.13 roof 140      34.6  hot 0%        60.8  hot 0%      timid
```

The canyon goes from barely lit to six times lit. Those windows were always
there; they were never allowed to be lights.

**What it costs.** At the default grid, **+0.14ms** - 7.25ms against 7.39ms,
with the port switched off entirely. At the finest grid the samples straddle
the machine's own drift (4.68 -> 6.02 in one run, 5.12 -> 3.50 in the next), so
call it a millisecond either way. `CITY LIGHT` in the settings menu switches
between EVERY WINDOW and the old SPARSE list.

**And it is tuned by measurement, not by eye.** Mean, peak and lit fraction
read straight off `GL.lightF`. Two knobs that pull in opposite directions -
radius is reach, gain is brightness - and guessing gets you a white blob at one
end of the street and a dark tower at the other.

---

### 5f. Two refinements, and the defaults

**Blown out white when rounding a corner.** `harvestEmitters` turns a screen
cell back into a world position with `cam + ray * depth`. With a deferred read
the depth is two frames old while `cam` and the rays are CURRENT, so every
reconstruction is wrong by roughly depth times the angle turned. Standing still
that is nothing; turning a corner it puts sources metres from where they are,
and a source that lands near the eye has an attenuation of `1/(1+d²)` that goes
straight up. Each outstanding read now carries the camera it was taken with
(`GW.pbBasis`) and the harvest reconstructs against THAT - exact, because a lit
window does not move.

**Light decaying as you move around an area.** Not time, density. Measured
walking a circle in one block: source CELLS swing from 9,899 to 29,517 as the
view turns into and out of a dense frontage - up to ~7,400 buckets - and the
list was clamped at 4,096. The clamp keeps the HEAVIEST buckets, so what gets
dropped is every dim window, exactly when you turn to face more of them. It
does not read as a limit being hit; it reads as the light draining away.
`LIGHT_CAP` is 16,384 now and nothing is dropped.

Retuned for the raised ceiling with a fast TURN as the test case, because a
two-frame-old list holds the lights of the view you are leaving as well as the
one you are entering: cells over 150 went 10.5% at gain 0.20 to **0% at gain
0.15 / roof 150**.

**The defaults are now the whole port.** `GPUC`, `GPUL`, `GPUW`, `GPUS`,
`GPUV`, `GPUH` and `GPUE` all on, at the **4px grid** (`resIdx` 9). Measured
there: **5.79ms against 25.51ms on the CPU path - 173fps against 39.** Auto-res
holds; its guard checks for a BLOCKING read, and there is not one any more.

**A harness note that follows from that.** `GPUT.parity(7)` flips `GPUW` only,
so with `GPUS` now on by default the "off" side falls back to CPU sprites too
and the number measures BOTH passes - 3,727 cells, which is the documented
sprite figure, not a world-pass regression. **Turn `GPUS` off to measure the
world pass alone** (it reads 43).

### 5g. Path tracing does not currently coexist with any of this

Stated plainly because it is a real conflict, not an oversight to work around.
`worldPasses` gates them as `if (gpuLit) { harvest } else if (GIR.on) { …
pathTrace() }`. Path tracing runs **zero times** while the card owns the
lighting, and turning `GPUL` off to reach it sets `_cpuLitFrame`, which
disables compose and therefore the entire tail. Measured at 4px:

```
  GPU light branch                     2.72ms
  CPU light branch (what GIR needs)   38.8ms
  pathTrace itself                     4.01ms
  the rest of the CPU light chain     10.5ms   (litUpsample 6.13 is the bulk)
```

So GIR is not expensive - the BRANCH is. And they are not layers: `bounces 1`
is "direct light and shadows", which is what `FS_LIGHT` already computes, so
adding them double-counts the direct term.

Making them coexist is a real piece of work with a real design question in it
(isolate the bounce, or scale the whole thing), and the cheap version is
better than it looks: `pathTrace` runs at HALF resolution, so uploading the
half-res buffer and letting a linear sampler do the upsample skips
`litUpsample` entirely - about +4.9ms rather than +14.5.

---

### 5h. Path tracing moved onto the card, and the whitewash

The CPU tracer was an ALTERNATIVE to the GPU lighting, not a layer - reaching
it took the CPU light branch, which sets `_cpuLitFrame` and turns off compose
and the whole tail (38.8ms against 2.72). It is a fragment shader now, inside
`FS_LIGHT`, and additive: the analytic loop is direct light and the shafts,
the tracer is the INDIRECT bounce and the openness, and they do not overlap -
the old `bounces: 1` was direct light, which is why the two could never stack.

One ray per cell per frame against the heightfield (`gMarch` = `giTrace` in
GLSL), one randomly-chosen emitter at the hit (`gOneLight` = `giDirect`),
normals from neighbouring depths, and a running average in a ping-ponged
RGBA16F pair - 8 bits cannot hold a 1/240 increment. `GIR.on` now costs about
a millisecond and defaults on.

**Four colour bugs came out in the same pass, and the first two predate the
tracer - they are why everything washed out white near lights:**

- **The rolloff was per-channel.** `1-exp(-c)` compresses channel RATIOS, so
  bright acc rolls every channel toward the roof - bright equals white, by
  construction, worst exactly beside a light. It rolls the BRIGHTEST channel
  now and scales the others by the same factor: hue survives any brightness.
- **Compose clipped per-channel too** - `min(c, 1.0)` after the light is
  added. Over 1 it scales the whole colour down instead.
- **The GI sample is scaled by uNE, which is ~7,000 now, not 120.** One sample
  landing beside a light came back thousands of acc units bright and the
  average smeared those fireflies into white patches at the sources. Clamped
  per sample (`GIR.clamp`, 400).
- **The GI seed was keyed to the average's frame count, which RESETS on any
  camera move** - so a moving camera fired the identical ray from every cell
  every frame: structured error, never converging. It has its own counter.

Measured at the shopfront: lit cells that were desaturated-to-white went
**27% to 0%**, still and moving, with the mean held. The judge for colour work
is `whiteOfLit` - lit cells whose min/max channel ratio exceeds 0.75 - read
straight off `GL.lightF` (which is RGBA16F now: read it as FLOAT, not bytes).

---

### 5i. The framerate came back, and the light stopped being screen-shaped

Opening the list to every window put the frame at 7.7ms against the 5.56
target, and the decomposition was clean: GI cost 0.3ms, the DENSE LIST cost
2.7 - every cell looping 7,500 lights, rejecting most in a few instructions
each. "30 and 220 cost the same" was true at 220 and does not extrapolate.

Three structural changes, each measured:

**Tiled culling.** Lights bin by their projected reach into 32x32-cell tiles;
a fragment loops only its tile's list. `GPUL.noTile` is the bisect - every
light into every tile, same indirection - and tiled against it is **zero
texels different**. The reach formula is shared verbatim between the shader's
surface gate and the binning (attenuation-based, att < 0.05 - the old
three-radius gate made footprints three times wider than anything visible and
pushed every light down the all-tiles path: 780,932 pairs a frame).

**Distance LOD in the harvest.** Cells nearer than `lodT` (24) bucket at
block 2 as before; cells past it bucket at block 6 - the ORIGINAL granularity
the far field was tuned at. 7,407 lights became 1,326 with the far field
visually identical.

**And the world-keyed cache, which is the walk-around fix.** The list was
built from the screen, so a window that left the frame stopped existing as a
light - the street dimmed behind you and snapped bright when you looked back.
Kept buckets now land in a cache quantised at a quarter-tile (same-frame
siblings MERGE, or a close wall of windows collapses to its last bucket;
later frames REPLACE), entries live ~30s unseen, and the shader's list is the
nearest rings of everything cached within 44 tiles, capped at `emitMax`.

**The ring cap is not decoration.** Emitting everything in range put 12,967
lights in the list after one lap of a block, which blew the tile-pair budget
fivefold - and overflow drops whole lights per tile, so MORE LIGHTS MADE THE
STREET DIMMER: the exact bug the cache was meant to fix, rebuilt out of its
own success. Nearest-rings-first with a cap keeps every budget honest, and
anything that ever does truncate is the farthest light.

The walk test, which the pose harness cannot express: stand, lap the block,
return. Before: mean light 17.2 to 6.7 and stuck. After: **18.7 to 17.2, and
looking 180 degrees away and back recovers in fifteen frames with no snap.**

**At the shipped configuration - 4px grid, every switch on, GI on, warm
cache, turning camera: 4.80ms median, 208fps, against the 5.56ms / 180fps
goal.** Blocks 4.71 / 4.76 / 4.80 / 5.08. The pinned 480x256 stretch grid is
~7.2ms; the fat there is per-tile counts (~600 average) and the next lever is
16-cell tiles, measured not guessed.

### 5j. The light stopped depending on where you look

Reported from play with two screenshots: the frame reads right only in its
top half, the camera moving paints 32x32 boxes, pitching the view brightens
and darkens buildings, and the same street is lit well from one spot and
barely from another. Four causes, none of them the tuning:

**1. The pair budget was still blowing, and the failure mode is geometric.**
`off[]` is assigned in tile order, top row first, so every pair past
`PAIR_CAP` silently empties a tile at the BOTTOM of the screen - the street
goes out from the feet up, on some headings and not others. Measured at the
reported vantage with a warm cache: demand swings **195k-345k with heading**
against the 262,144 cap - `pairsOver` hit 82,758 at heading 113. That is
"only the top half looks right" and the flickering boxes, both. The cap is
1,048,576 now (`tidxT` 2048x512), worst measured demand since is 465k, and
running out no longer empties tiles: whole lights are dropped from the tail
of the list instead (`GPUL.trimmed`), which is the farthest light, uniformly
across the screen - the walk stops short of the appended off-screen lamps.

**2. The running average never moved with the camera.** `FS_LIGHT` blends
70% of last frame's buffer in AT THE SAME SCREEN CELL, and a turning or
pitching camera slides the world across the screen - so the whole light
field (direct included, not just the traced term) dragged three frames
behind every rotation and smeared facade light onto sky and street. In this
projection the fix is exact: pitch is a row shift by the horizon delta, yaw
is a shift in the tangent of the column angle (`uHR`; plane is dir rotated
+90, so column angle = atan(cx*planeLen)). Verified against the depth
buffer: a 0.05rad step moves content 12 columns, predicted 12. A cell whose
past left the frame keeps its fresh value rather than clamping to the edge.

**3. The cache took every observation at face value, and observations are
screen-shaped.** Weight is harvested cell count - the same window counts
less seen from further, from an oblique pitch, or half-clipped by the frame
edge, and REPLACE semantics wrote that straight over the memory. Plus two
subtler leaks: entries the camera had not FACED in 30s expired even though
they were being emitted every frame (the street behind you died while your
back was turned), and when `emitMax` truncated inside a ring, what survived
was cache insertion order - two visits to one corner kept two different
subsets. Now: a smaller observation drifts the memory at `partA` (6%) per
frame instead of replacing it (`keepFrac` gates which); ttl is 90s and is
only the memory bound, because a light whose spot is on screen, in front of
everything (projected against the HARVEST BASIS camera and its dBuf, not the
current one), and not harvested is really off and decays out in ~1s
(`decay`); and the one ring the cap cuts is sorted by distance, so the kept
set is "the nearest emitMax of everything cached" every time. The windows
churn on their own 25-90s cycles (`litP` re-rolls per time block), so total
cached weight is SUPPOSED to move with the hour - standing still, wSum holds
to ~1% over seconds while ghost duplicates reap out.

**4. The surface term was decorative, and the air term is ray-length.**
The chord accumulates with how far a ray travels through lit air, so a frame
of near street is dark and the same block seen down its length is bright -
that is most of the settled pitch swing (mean 36 looking down, 53 up, same
spot). The surface term is the half that cannot depend on the ray, and at
its old 0.06 a 50x knob sweep moved the frame mean 9%: invisible. It has
its own knobs now (`GPUE.surf` 0.60, `surfFall` 1.2, legacy values kept on
`GPUL` for the sparse path), and the reach gate is DERIVED from them in the
shader and the binning both - retuning the term retunes the culling with it.
The pavement under a shopfront now carries its colour; hot cells (>150) stay
at zero.

What it measures after: matched-content brightness across a 60-row pitch
change is **1.001** (content shifted by the horizon delta, 18.6k cells);
a full spin peaks at 465k pairs, zero over, zero trimmed; the lap test goes
42.6 -> 45.3 the frame you are back -> 49.1 settled, no snap and no decay;
and `worldPasses` is **4.79ms** at the busy vantage against the shipped
4.80 - the sort, the decay projections and the wider gates cost nothing the
block noise can see.

Two instrument notes that cost an hour: the frame MEAN is the wrong lens for
either local term - GI ambient is ~19 of a mean of ~29 at the shopfront, so
air and surface tuning drowns in it; read the term in isolation or by eye.
And knob A/Bs at a still pose converge at 1/n up to `GIR.maxFrames` (240) -
drop it to 8 while comparing or the second screenshot is 45% the first one.

### 5k. Path tracing felt like the REVERSE of path tracing, and it was

Reported: the bounce-and-colour feel the switch promises was stronger with
the switch OFF. Measured settled at the shopfront, GI on against off: mean
29.40 / 29.41, saturation 0.212 / 0.210 - **the traced bounce contributed
NOTHING to the picture**, and what the switch actually did was darken
surfaces 8% (openness AO) and drag the ENTIRE light field - the vivid
analytic colour included - behind a 240-frame running average. On = darker
and laggier, off = instant and punchy. The player was right.

(That "GI-only = 19 mean" figure in 5j's instrument note is itself the
average trap: it was residual analytic light still draining out of the
history, measured 110 frames after the terms were zeroed. The traced term
was never 19 of anything.)

Two causes, two changes:

**The average wrapped the wrong thing.** The analytic terms are
deterministic - averaging them buys nothing and costs the drag. The light
FBO now carries a second RGBA16F attachment: 0 is the composed light,
written FRESH every frame, on or off; 1 is the traced term's running
average, the only ping-ponged meaning, reprojected under rotation like 5j's
history (clamped at the frame edge rather than dropped - a stretched
neighbour beats one raw sample as a prior). `moveA` eased 0.30 to 0.18: lag
on the bounce is invisible now that the direct term does not share it, and
what a high alpha costs - sample noise shimmering while walking - is not.
Openness rides in the average's alpha, so the corner darkening is as
denoised as the bounce. A bonus: the resize dark-flash (alpha 0.3 against a
just-cleared history) is gone, because attachment 0 no longer mixes.

**The estimator sampled four thousand lights to hit nothing.** One uniform
pick over the whole nearest-rings list spends almost every sample on a far
light the falloff has already discarded. It picks from the nearest
`GIR.pick` (384) now, scaled by the same count - the same estimator over
the lights that matter, uNE/K times the hit rate. With signal actually
arriving, the term could be tuned: `bounce` 3.5 (the rolloff compresses the
addition in lit areas; dark cells sit on the linear part and gain ~4-5 lit
units, which is where a bounce SHOULD show), `falloff` 0.30 (at 0.10 a hit
averaged the whole street to grey; steeper keeps the colour of what is near
the hit), and the sky-escape term came OFF the bounce knob so turning the
bounce up does not wash dusk in sky-grey.

After: GI on against off is +1.7 to +2.6 of mean (was +0.01), a quarter of
cells gain >3 lit units, hot stays 0%, strafing adds 0.7 of a 255-channel
of frame-to-frame noise (off-baseline 1.3), and `worldPasses` 4.87 against
4.79-4.80 - inside this machine's drift. The on/off deltas above were each
measured inside one ~1.5s window: the windows churn (5j), so any GI number
taken minutes apart from its baseline is not a comparison.

### 5l. The spectacle pass: the dimming bug, HDR overflow, and a real bloom

The player's brief: path tracing does not earn its frames, coloured light
does not land on walls, windows dull out UP CLOSE while stalls stay
emissive, and only white ever reads as a light. All of it traced to three
mechanisms, none of them the light pass - which is why (their words) "every
light change we have made has failed to fix it".

**1. THE dimming bug, at last: `T.amb` multiplied EVERY palette entry.**
The bake did `c * dim * T.amb` for all 64 materials - so every neon sign,
lit window and stall lamp baked toward half brightness exactly when night
fell. Dissected pixel by pixel (palette says (120,255,240), compose says
0.63) after the fix at one hour, T.amb was 0.94 and the residual dim was
glyph alpha - but the amb multiply swings to ~0.55 across the night, and
it sat UPSTREAM of everything: the compose ceiling is over the DISPLAYED
palette, so no light-side gain could ever buy the loss back. Emissive
materials now skip amb in both bakes (glBuildPalette and the 2D atlas);
the fog fade stays, because fog is air, not sun.

**2. The lights sat ON their walls and shadowed themselves.** A harvested
window's bucket position was the ray hit - the facade plane - and shadow
taps toward it graze the building's own tile, so the wall self-shadowed its
own windows and zeroed the surface term precisely where it matters. Stalls
protrude off their walls, which is exactly why stalls looked emissive and
windows did not. Harvested positions now sit a third of a tile off the
surface toward the eye (`t - 0.35`), the way a neon tube hangs in front of
its glass.

**3. Saturated colour cannot out-luminance white inside a display
ceiling.** That needs headroom, and headroom needs somewhere to go:

- **Compose gained a second output: the OVERFLOW plane** - the picture (0)
  keeps the exact old hue-preserving ceiling BEFORE the alpha blend (the
  glyph texture IS partial alpha; normalising after the blend flattens
  every bright wall into a slab - tried, it did), and (1) gets `c - disp`,
  the light the ceiling cut, in the cell's own hue.
- **Emissive materials run `uEGain` (1.55) past the ceiling** and skip the
  AO multiply (they emit; the dark cannot dim them). The excess lands in
  the overflow and comes back as glow in the material's own colour - cyan
  blooms cyan. The EMISSIVE bitmask rides into compose as two uint words,
  set once.
- **The bloom was rebuilt.** The old one was a per-channel cube ("crush
  everything that is not neon") into two bare taps: the cube kept only
  near-white (why only white ever glowed), and a single bilinear tap at an
  eighth size lands BETWEEN the thin strokes ASCII is made of, so most
  window energy never reached it - and the losses were baked into the
  look, which bit when an energy-preserving chain replaced it at equal
  strength. Now: half-float scene and taps (`GL.halfOK`), a knee on the
  BRIGHTEST channel scaling the whole colour (hue kept), the overflow
  plane added kneeless (existing is its threshold), a quarter-to-32nd
  4-tap box chain, and ONE merged lay-back draw (four fullscreen additive
  passes were most of a millisecond). `BLOOMV` holds every knob; key B and
  the menu still toggle it, and `bloomOn` off also drops `uEGain` to 1 so
  the picture is exactly the picture.

**And the light gain came off its leash.** `GPUE.gain` 0.15 was tuned
against fast turns blowing out - the stale double-list bug the cache fixed
in 5j, not a property of the scene. At 0.22, a deliberately fast spin
peaks at 0% cells over 150. The PT bounce now lands where it should:
cells dark without GI gain **+30 lit units** with it on (was +4-5), which
is "worth the frames" by inspection.

Costs, measured at the dense vantage: `worldPasses` 6.3 -> **4.49ms**
after two recoveries (the cut-shell sort went from 4 shells to 16, so the
sorted shell is a few hundred entries, not thousands: harvest 3.9 -> 1.76;
and the merged lay-back: present 1.8 -> **1.2ms**). Day is gated as
before (no bloom, no egain at timeMode 2), interiors take the CPU-lit
path untouched, and rain now mirrors genuinely luminous windows in the
wet street, which is most of "reflections got better" for free.

### 5m. The air itself carries light now

The last gap in "volumetric everywhere": FS_LIGHT early-outed on any ray
that ended in SKY, and compose discarded empty cells - so every glow
sphere's light existed only painted ON geometry, and the air between the
lines (over a shopfront, between towers, around a sign's edge) stayed
dead. Only the lamp cones ever lived in the open air, which is why lamps
felt volumetric and nothing else did.

Two changes. FS_LIGHT shades air cells at full view distance - the chord
loop runs, the surface term, the traced bounce and the occlusion are
skipped (they need a surface), and the early-out writes BOTH outputs now
(it used to leave the traced history undefined for every sky cell:
garbage waiting to be reprojected onto a wall). And compose's empty-cell
path paints the light texture's answer over the sky, sampled BILINEARLY
at the pixel (air is not a glyph; it may gradient where a glyph must
not), scaled by `GPUE.airGlow` (0.75 - a ray to the sky crosses more air
than a ray to a wall, and the sky must stay behind the city). Compose
went premultiplied for it (glyphs write rgb*a; air writes glow with
ALPHA ZERO, which the ONE/ONE_MINUS_SRC_ALPHA blend turns into a pure
add) - the glPresent comp branch swaps the blend func around the draw
and back.

Auto-gated everywhere it should be: `_lampNight` zeroes the analytic air
by day, interiors take the pack path compose never sees, and cells whose
air is worth under 0.002 still discard. worldPasses unmoved (4.45),
present 1.2 -> 1.6ms - the sky cells now run the tile loop and it shows
up as GPU pressure at the sync, nowhere else.

### 5n. The colour pass: bright is not rich

Player: enough brightness now, not enough COLOUR - lights do not give off
the colour they are. Three mechanisms, three fixes, all knobs:

**Hue dominance (`GPUE.rich`, uRichK).** A sum of overlapping glows is
physically additive and visually grey: with five-tile spheres lying ten
deep, cyan + magenta + amber average to soup, and every light's colour is
donated to the street instead of kept. The loop now also accumulates a
luminance-weighted hue (accH += c*max(c)), and the answer is the plain
sum's ENERGY carried on the dominant hue, mixed by rich (0.9). Energy is
conserved; only ownership changes. `GPUE.fall` (5.5) is the dense path's
own in-sphere falloff now - steeper than the sparse 3.2, so each glow has
a saturated core that is ITS colour.

**Chroma lift at APPLY time (`GPUE.lightSat`, uLSat, compose).** Coloured
light added to a grey base is pale - the sum keeps the hue but the base's
greyness dilutes it. The light (never the palette) is pushed away from
its own luminance by 1.35 as it lands, surfaces and air cells both.

**And "more of that" (the tower the player pointed at):** emissive
materials resist the distance fog at 0.45 of the rate (fog in front of a
light scatters its colour, it does not grey it) so the far skyline reads
as coloured points the way a near facade does; and litP's floor rose
0.04 -> 0.16 so no tower rolls nearly dark - the special cases that set
litP directly keep their deliberate darkness.

Ambient came up with it: GIR.sky 0.30, GPUE.ao 0.26, gain 0.26/roof 155.
Fast-spin max hot 0.09%. Denser city costs: pairs ~392k (budget 1M),
worldPasses 5.2ms at the dense vantage - inside the 5.56 target still.
Light-buffer saturation (weak lens, see 5j's note): 0.21 -> 0.25 global,
but the per-region look is the judge and the streets now carry their
nearest light's hue visibly.

### 5o. The city tints its own atmosphere (CTINT)

5n made the LIGHTS rich and the player still saw grey, and they were
right: the canvas under the lights stayed neutral. Three reservoirs of
grey-blue cover most of any frame - the fog colour every distant
surface's palette fades toward, the background gradient behind every
empty cell, and the GI's sky fill - and no amount of per-light richness
touches any of them.

`CTINT` is the city's own colour: the harvested lights' weighted mean
hue, normalised to carry colour and not brightness, eased at 0.02/frame
so it drifts as the district changes around the player. At night
(through `_lampNight`, so dawn unwinds all of it) it leans the three
reservoirs by their own knobs on GPUE: `fogTint` 0.45 into the palette
bake's fog mix (bakeKey carries `CTINT.q`, so the bake follows the
drift), `bgTint` 0.55 into the backdrop's horizon band and ground (the
zenith keeps most of its dark sky so up still reads as up), and
`skyTint` 0.60 into the GI escape fill - a night ray does not see black
space, it sees the smog the city lights from below. Tinted fogs run
slightly brighter than the neutral they replace (x1.2-1.3): lit smog
glows.

With them: `airGlow` 0.75 -> 1.0 and `lightSat` 1.35 -> 1.45. The
pitched-up canyon vantage - the densest thing the game can frame -
measures worldPasses 5.77ms; the level street 5.2.

### 5p. Three small artefacts, and one sky

Player-reported, player-verified fixed:

**The lamp pools' rings and the seam where two pools meet.** Both in the
GROUND pool (floorSample's lampPool, both twins), not the beam: the pool
palette rung was `(e*STEPS)|0` over a smooth falloff - concentric rings -
and `lampGrid` kept ONE lamp per tile, so where two pools met, intensity
and cast switched on tile boundaries. `lampGrid2` now carries the
second-nearest lamp; the two falloffs ADD across the meeting ground (light
does), the cast comes from the stronger with a world-anchored hash vote
near ties, and the rung takes half a step of the same dither. FS_TLAMP's
beam resolve got the matching treatment: a second-best cone tracked, the
winner dithered by relative strength at the seam, the ramp step and the
swap threshold dithered. The lampGrid texture is RG now.

**Path tracing rotting until toggled.** `normalize(n + jit*0.85)` is NaN
when the jitter cancels the normal; NaN survives every mix() into the
traced history FOREVER, fails every comparison so no gate caught it, and
the reprojection's bilinear reads SPREAD it. Toggling PT off wrote one
clean frame of zeros over the poison, which is why the toggle "fixed" it.
Now: hand-normalised with a guard, and the history read heals itself
(`!(x <= 1e9)` catches NaN and infinity both).

**And the sky was three colour systems wearing one trenchcoat.** The
horizon band the player liked is skyPass HAZE GLYPHS (C.skyGlow, tinted);
above it the haze ran out and the raw background gradient showed (a
different colour however tuned - and its three linear mixes met with
slope breaks the eye reads as bands, now smoothstepped); and far unlit
towers kept 60-90% of their blue-grey base through the fog mix and stood
in the glowing sky like holes. Fixed by construction: the whole dome
wears one ramp step of the same haze material at night (both sky-pass
twins, +0.035 floor), C.skyGlow itself follows CTINT in the bake, the
zenith band hue-swaps harder than its luminance-proportional share
(`tn*1.75`, or its own night blue dominates the dark), and non-emissive
materials hand their fog-level-proportional leftover hue to the
atmosphere (`GPUE.matTint` 0.70, `min(0.88, f*2.6)` by level - near
untouched, skyline nearly all the way). Verified by pixel measurement:
the four sky regions the player marked now agree in normalised hue to
within 0.1 per channel, and the upper sky holds ZERO empty cells in
1,715 sampled.

---

## 6. Measurement traps that have already cost time

- **A dead property in the harness is worth thirty times the thing you are
  measuring.** §3.3. Twice now. Print the field back off the object.
- **Compositing contends with readback, ten to one, and the quiet side is the
  wrong side** — and `document.hidden` will not tell you which side you are on.
  §3.4.
- **A fixed per-frame cost fights auto-res, and auto-res loses.** Auto-res
  assumes frame time falls when the grid gets coarser. Anything whose cost is
  per *call* rather than per cell breaks that assumption, and the grid walks to
  the floor doing a full `initRender` every ninety frames on the way — which on
  screen reads as the world freezing, flickering black and coming back smaller
  until there is nothing of it left. **This is what a player reported the first
  time `GPU SOLIDS` was turned on, and it was reproducible in twenty seconds:
  212×106 down to 61×29 in twelve, and 114×55 still took 19.6ms.** The rig
  hides it because it pins `manualRes`.

  The defence used to be a latch — `GPUW`'s menu handler set `CFG.manualRes` on
  the way past. That was wrong twice over: the sprite switch did not have one,
  and the latch never let go, so turning the switch off left auto-res dead for
  the rest of the session. **The auto-res step in `frame()` now checks
  `GPUW.on && GL.worldOK` itself** and holds the grid for exactly as long as
  the card owns the world.
- **`readPixels` into a typed array is a synchronous round trip.** Five
  milliseconds a call on this driver, and it does not care what you ask for — a
  single pixel measured 5.4ms against 5.8ms for the whole frame. Through a
  **pixel pack buffer** the same read is 0.004ms to issue and 0.87ms to collect.
  Issue all of them before collecting any: the sprite mirror's `readPixels` goes
  out inside `glSpritePass` and is collected at the tail of `glWorldRead`, so
  every read in the frame is issued before any is waited on.
- **An R8 attachment is worse still**: 6.6ms *each* to read back. Four one-byte
  buffers ride in one RGBA8 read instead, and the unpack is a shift and a store.
- **Profile inside the real frame loop, not with `worldPasses()` in a `for`
  loop.** Freezing the world stops pedestrians walking into frame. The same spot
  measured 12.9ms frozen and 24.6ms live.
- **The profiler double-counts nested passes.** `wallPass` calls `wallMirror` at
  its own tail, so a profile with the world pass off shows both and their sum is
  not the total.
- **Frame-by-frame interleaving is the wrong instrument for a readback.** A
  frame that reads the card back waits for whatever is still queued from the
  frame before it, while a frame that does not read lets the CPU run a frame
  ahead. Measured that way the port looked 23% slower. Use `GPUT.blockAB`.
- **Absolute times drift by more than 2×**, and it may be the user playing in
  another window. The same vantage measured `worldPasses` at 24.5ms and 33.5ms
  an hour apart *in this session*. Compare ratios from adjacent runs, never
  numbers from different ones.
- **An instrument that copies a buffer is what you are timing.** A probe doing
  `before.set(gBuf)` (122KB) around each of 503 `drawModel` calls reported hidden
  solids as 18.5% of the pass. They were ~2%.
- **A stub changes control flow, not just cost.** Replacing `floorSample` with a
  no-op left `_wd` stale and non-zero, inventing a 4.8ms "bare loop" cost.
- **A fresh page load is not a populated world.** 387 of 430 pedestrians start
  `off`. Sweep for a busy vantage (`statSprites`) and run several seconds of
  frames before timing or counting anything — the same accounting probe read
  4,938 CPU mirror cells on a warm world and 3,092 on a cold one.
- **PUTTING A PIECE OF GL STATE BACK IS NOT POLITENESS, IT IS A GUESS.**
  `UNPACK_ALIGNMENT` is set to **1** once in `glInit` and must stay there:
  every one-byte-per-texel upload in this renderer depends on it, because an
  R8 image of width `cols` has rows of exactly `cols` bytes and an alignment
  of 4 makes the driver expect them padded, read past the end of the array and
  **reject the upload outright**. `spriteSlot` set it to 1 for its own
  `texSubImage3D` and then put it back to 4. That broke `glComposeWorld` at
  every grid whose column count is not a multiple of four — 205, 130, 110, 90,
  75 — for the **rest of the session, including after the switch was turned
  off again**. The world stopped updating, then vanished when the next
  `initRender` handed compose a fresh empty texture.

  It cost extra time because the failure does not look like one: a rejected
  `texSubImage2D` leaves the *previous* texture in place, so a probe that
  renders twice from a still camera sees an identical picture and reports
  nothing wrong. It only shows when the camera moves. **Move the camera
  between the two halves of any A/B that could be comparing a stale upload
  against itself**, and check `gl.getError()` per grid, not once.
- **A texture bound to a unit and attached to the bound framebuffer is a
  feedback loop**, and WebGL refuses the draw outright if the sampler is
  *active in the program at all* — not only if that branch runs. The sprite
  shader samples the depth attachment in its mirror branch, so the direct draw
  binds something else to that unit and the mirror draw, which targets its own
  framebuffer, swaps it in.
- **A DEPTH CLEAR IS MASKED BY `depthMask`, EXACTLY AS A DRAW IS.**
  `clearBufferfv(gl.DEPTH, …)` with depth writes disabled is a silent no-op:
  the buffer keeps the 1.0 it was born with, every fragment fails a `GREATER`
  test, and the pass emits **a perfect copy of its own input with no GL error
  to show for it**. That is the worst possible failure signature — the reflect
  scatter drew nothing at all and the frame still looked plausible, because the
  seed had already put the unreflected world in the target. `depthMask(true)`
  goes BEFORE the clear, not after.
- **`PACK_ALIGNMENT` is the twin of `UNPACK_ALIGNMENT`, and it bites the same
  way.** `readPixels` pads each row to `PACK_ALIGNMENT`, which is **4** by
  default — so reading a one-byte-per-texel attachment of width `cols` into an
  array of exactly `cols × rows` bytes is rejected outright at every grid whose
  column count is not a multiple of four. 75, 90, 110, 130 and 205 all are not,
  and all five threw `INVALID_OPERATION` and rendered ~96% wrong while 60, 160,
  240, 288, 360 and 480 were byte-perfect. It is now set to 1 once in `glInit`
  beside its twin, and nothing puts it back. **The `CFG.CELLW` sweep in §5 is
  what caught it, on the first run, exactly as advertised — run it.**
- **A TIMED-OUT TOOL CALL DOES NOT STOP THE PAGE.** `javascript_exec` gives up
  at 30 seconds; the promise it started keeps running. A `blockAB` series is
  66 seconds, so the call times out, and the next attempt starts a SECOND
  series — and both of them wrap and restore `window.frame`. One restores the
  other's wrapper, that side stops accumulating, and the run comes back with
  half its blocks reading `0` and a median of zero. Start long runs detached,
  park the result on `window`, and **reload the page before retrying** rather
  than layering a second run on a first that is still alive.
- **A BLOWN PAIRS BUDGET READS AS DIMMING, NOT AS AN ERROR.** Tile-list
  overflow drops whole lights per tile silently - so ADDING lights made the
  street darker, which pointed every intuition away from the cause. If light
  behaves paradoxically, read `GPUL.pairsUsed` and `pairsOver` before
  theorising.
- **TUNING WITH `GPUH` ON AND THE DRIVER PAUSED MEASURES NOTHING.** The fence
  needs the card to finish work between frames; a paused driver rendering
  synchronously never gives it the chance, so the read never lands, the harvest
  is skipped and the light list is whatever it was. It cost three separate
  runs of nonsense numbers - a vantage reading zero light, a sweep where the
  emitter count never changed - before the pattern was obvious. **Turn `GPUH`
  off to tune anything about light.**
- **A DEFERRED READ DELAYS EVERY CONSUMER OF THOSE BUFFERS, NOT THE ONE YOU
  WERE THINKING OF.** The intent was "the light list may lag". The effect was
  that the whole composed frame lagged, because the tail was also seeding off
  the same buffers - a consumer nobody had written down. Before deferring a
  read, enumerate what reads it, and be suspicious of the answer.
- **AND A CLEARED BUFFER IS NOT A STALE ONE.** `worldPasses` clears its buffers
  at the top of every frame. A deferred read that is not ready leaves them
  CLEARED, not holding last frame's data - so a consumer downstream gets an
  empty screen rather than an old one, which is a much louder failure. If a
  read may not deliver, the consumer has to be skipped, not fed.
- **THE POSE PARITY CANNOT SEE A SEQUENCE BUG.** It renders one pose twice and
  compares; anything that is a property of successive frames - staleness,
  latency, a fence that sometimes misses - is invisible to it by construction,
  and `GV.dbgRead` actively turns the deferred path off while it runs. Both
  GPUH bugs went out clean through 39 poses and were found by playing. When a
  change is about WHEN data arrives rather than what it contains, the harness
  is not evidence.
- **A DEFERRED READBACK IS NOT AN UNBLOCKED ONE.** Issuing into one pack
  buffer and collecting the other a frame later took `glWorldRead` from 21.9ms
  to 15.1ms and no further, because the CPU runs further ahead of the card than
  one frame. `fenceSync` + `clientWaitSync(…, 0, 0)` took the same call to
  0.19ms. If you are deferring a read and it is still expensive, you have not
  deferred it enough - and no fixed number of frames is enough, which is what
  the fence is for.
- **An MRT fragment shader writes the outputs it does not assign.** They get
  whatever was in the register. A pass with only a glyph and a palette to give
  has to switch the other attachments off with `drawBuffers`, not leave them
  politely alone.
- **`precision highp int;` in BOTH stages, or a shared `uniform int` will not
  LINK.** Vertex shaders default int to highp and fragment shaders to mediump,
  and the error - "Precisions of uniform 'uKind' differ" - arrives at link
  time, long after both halves compiled cleanly on their own.
- **The backtick trap fired again** (§ below), this time in a comment added to
  a shader while fixing the precision error above. `node tools/syntax-check.mjs`
  caught it in two seconds. Run it after EVERY edit; that is what it is for.
- **Use `gl.finish()` around anything GPU-side**, or you are timing command
  submission.
- **A backtick inside a comment inside a GLSL template literal** closes the
  literal and takes the whole 26k-line file out with one `SyntaxError`. It fired
  again this session. Run `node tools/syntax-check.mjs` after every edit; it is
  two seconds.

---

## 7. Dead ends — measured, rejected, do not retry without new information

- **Packing the world pass into two attachments instead of three.**
  Byte-identical, strictly less work, and it measured **27.74ms against 27.83ms
  on the same baseline** — inside the block-to-block noise. The readback cost is
  a per-frame sync, not per call and not per byte. (The stage-3 repack of the
  fourth byte was for *correctness*, not speed, and it is not this.)
- **Hierarchical empty-space skipping in the voxel marcher** (4×4×4 occupancy so
  rays stride over air). Byte-identical and 6.3% slower. Models are ~16 voxels
  across and the sampler steps at 0.7 of a voxel.
- **A coarse water-proximity bitmap** to avoid the per-cell `tType` read.
  Correct superset, skipped 97.4% of the reads, bought 0.05ms.
- **Reordering `wallPass` before `floorPass`** to avoid floor overdraw. Erases
  the facade reflections painted onto the wet road.
- **Sprite draw order** — `drawList` is sorted far-to-near, but measured overdraw
  is only 1.24× and just 9.2% of writes are wasted.
- **Narrowing the mirror's source-row search below ±8.** ±2 is twelve times the
  error for 0.12ms of frame time, which is inside the noise. §4.

---

## 8. Running it

```bash
node serve.mjs 8123
```

Then `preview_start` at `http://localhost:8123/index.html`, **open a second tab
and front it**, and drive the game tab by `tabId`. Take a screenshot before you
believe anything about which condition you are in (§3.4).

Force the finest grid and the rig:

```js
await import('/tools/gpu-parity.js'); GPUT.boot()
```

Busy vantages (heading 0.7, eye 1.7): `550,520` · `340,520` (open park,
floor-heavy) · `580,640` · `460,370`.

`tools/` also holds `syntax-check.mjs` and `splice-gw.mjs` — the latter rebuilds
the world-pass block in `index.html` from scratchpad sources. Those sources are
not in the repo; `FS_SPRITE` was written in place and does not need them.

State: **`fog-and-hd` is merged into `main` and pushed** — stages 1 to 3 are
live on GitHub Pages at https://nukacolafamine-star.github.io/ascii-city/ .
That is safe, because `GPUW`, `GPUS` and `GPUV` all default OFF and the CPU
path is untouched, but it is no longer true that this work is unpublished and
the line that said so has been removed. **Stage 4 (all of it) is in the working
tree and not committed:** `index.html` also carries unrelated content work (menus,
touch UI, quest logs, minimap), and the two are interleaved closely enough that
`git apply` cannot separate them — the GPU hunks share context with the content
ones. Splitting them is a judgement call for whoever owns the content work.
