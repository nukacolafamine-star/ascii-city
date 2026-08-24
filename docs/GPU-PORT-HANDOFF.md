# ASCII CITY — GPU renderer port, handoff

Rewritten after stage 3 (the sprites) landed, on branch `fog-and-hd`. Line
numbers drift; the function names do not.

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

**The one number that still decides everything: `glWorldRead` is 6.1ms and it
is a sync, not a transfer.** It is what the port pays for existing. Sprites
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

---

## 5. What is left

`worldPasses()` order:

```
skyPass / ceilingPass → floorPass → wallPass → spritePass
  → signPass → reflectPass → lampVolume → rainPass → harvestEmitters
```

The first four are done. What remains, on the same afternoon:

```
glWorldRead     6.09     ← the toll, and the prize
lampVolume      4.78
wallMirror      2.65
reflectPass     2.35
harvestEmitters 0.60
signPass        0.40
spritePass      0.59     ← what is left of it: the draw LIST, on the CPU
applySpriteRefl 0.14
```

**Stage 4 — signs, reflections, the lamp volume, rain.** All screen-space passes
over data that is by now already on the card and does not need to come back for
them. `reflectPass` is pure screen-space and reads only
`gBuf/bBuf/srcBuf/refBuf`. `lampVolume` is the biggest of them.

**Then `wallMirror` and `harvestEmitters` are the last two CPU readers.** Kill
those and `glWorldRead` loses its reason to exist, and the six milliseconds go
with it. `wallMirror` is a scatter of the same shape the sprite mirror was, and
stage 3 is the worked example of how to turn one round: it is the wall mirrored
about the street, gathered per cell below the horizon, into its own target,
applied afterwards under the same wetness gate.

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

State: branch `fog-and-hd`. `main` deploys to GitHub Pages at
https://nukacolafamine-star.github.io/ascii-city/ — this branch is **not**
merged there.
