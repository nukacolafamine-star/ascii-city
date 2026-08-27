# ASCII CITY playtest agent — technical reference

Companion to `SKILL.md`. Everything here was used in a live three-player session; every
trap listed was walked into first.

---

## 1. Booting the engine

The automation pane frequently does not composite: `document.hidden === true`, so
`requestAnimationFrame` never fires. The page loads, the world generates, `worldTime`
stays `0`.

The engine is fine — a frame costs **~4 ms** at the full 182×60 grid (≈250 fps of
headroom). Nobody is calling the loop.

**`setInterval` is not a safe driver.** A fresh hidden tab held 62 ticks/s; the same tab
after a reload was clamped to **10/s**. `frame()` clamps `dt` at `0.1`, so 10 fps sits
exactly on the clamp and anything slower runs the world in slow motion. If the throttled
client is the **host**, it runs slow for everyone.

Use the Worker ticker in `SKILL.md` §1. Verified: 60.5 driven fps in a hidden zero-size
tab, sustained as host for a full session.

**Two traps here cost a whole session's first hour, and both present as engine faults.**

*The pane lies about visibility.* A preview tab reports `document.hidden === false` and
`visibilityState === 'visible'`, and then stops delivering `requestAnimationFrame`
the moment another tab is fronted. `observer.js` only installs its worker when
`document.hidden` is true, so a pane tab gets **no driver at all** — the world silently
stops, `clock` freezes, `__OBS.frames` stops climbing, and every "am I visible" check
you can write says everything is fine. On a host it stops the world for everybody.
Do not trust the flag. Drive from a worker regardless, or verify rAF is really
arriving by scheduling one and seeing whether it fires.

*Capturing the loop by name breaks the moment you wrap it.* The observer's rAF override
matches `cb.name === 'frame'`. Assigning `window.frame = function(dt){…}` produces a
function whose `name` is `''` — member-expression assignment does not infer a name — so
installing any rig that wraps the frame loop **silently kills the observer's own
driver**. Capture by identity (`cb === window.frame`) instead.

*And never end up with two.* If the observer already made a worker and you add another,
`fps` reads ~120 and the simulation runs at **2×**. `rig/boot.js` reuses the observer's
worker when there is one and only creates its own otherwise; `PT.checkDriver()` counts
them and says so out loud. Check fps is near 60 before believing anything else you see.

Wrap the frame call in `try/catch`. A frame that throws every tick is one of the two ways
this game presents as "totally frozen", and the captured stack diagnoses it instantly.

**Viewport:** a collapsed pane reports `innerWidth === 0`; `initRender()` clamps to
320×240 → a 45×20 grid. Override both dimensions, set `CFG.manualRes = true` and
`CFG.resIdx = 6`, then `initRender()` → 182×60. Pin `manualRes` deliberately: auto-res
steps the grid down above 14 ms average frame time, silently changing your view
resolution mid-session.

---

## 2. Reaching into scope

One top-level script. What that means:

| Declaration | Readable from a probe? | Patchable? |
|---|---|---|
| `function foo(){}` | Yes — also a `window` property | **Yes** — assign `window.foo`; callers see it |
| `let` / `const` | Yes — global lexical environment | `let` yes, `const` no |
| Object properties | Yes, via their holder | Yes |

`keys`, `cam`, `PLAYERS`, `actors`, `props`, `clock` are top-level `let`/`const`:
readable and writable, but **not on `window`**, so anything enumerating `window` misses
them. Every top-level `function` is patchable — that is the basis of all instrumentation.

**Patching only affects call sites that resolve the name at call time.** A reference
captured earlier (passed into a constructor, stored on an object) still points at the
original. The transport's message callback is captured at `netStart`, so patching it does
nothing — patch a function it calls *by name* instead.

**Synchronous-probe guarantee:** everything in one JS execution runs to completion before
the loop interleaves. Render, mutate, render, compare — nothing moves underneath you.
State *does* carry between separate probes; treat each as a transaction.

---

## 3. Seeing the world

Screenshots are usually unavailable. The game is made of letters — reconstruct the screen
from its own buffers.

| Layer | Buffer | Decode | Empty |
|---|---|---|---|
| World | `gBuf` | `CHARS[g]` | `0` |
| HUD | `hGlyph` | `String.fromCharCode(h + 32)` | `0` |

`hGlyph` stores `charCode - 32` (valid 0–94). Indexing it into `CHARS` — the natural
mistake — shifts every character by one: `MAP` reads as `NBQ`, `FINANCE DISTRICT` as
`GJOBODF EJTUSJDU`.

```js
window.__scr = function(hudOnly){
  const out = [];
  for (let r = 0; r < R.rows; r++){
    let s = '';
    for (let c = 0; c < R.cols; c++){
      const i = r * R.cols + c, h = hGlyph[i];
      s += h ? String.fromCharCode(h + 32)
             : hudOnly ? ' '
             : (gBuf[i] ? CHARS[gBuf[i]] : ' ');
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out.join('\n');
};
```

`__scr(true)` gives the HUD alone — menus, minimap, quest tracker, clock, district, HP.

### Isolating a subject by differencing

To answer "is that actually being drawn", render twice and diff. What changed is the
subject.

```js
const grab = () => { /* read gBuf into row strings */ };
worldPasses();                    const A = grab();
const ox = t.cam.x, oy = t.cam.y;
t.cam.x = -9999; t.cam.y = -9999;
worldPasses();                    const B = grab();
t.cam.x = ox; t.cam.y = oy; worldPasses();
// cells where A differs from B are the subject
```

Before trusting a negative, confirm the sight line with `solidAt || propBlocked` — an
unnoticed prop three tiles ahead occludes the subject and looks like "nothing rendered".

### State map

| Question | Read |
|---|---|
| Where is everyone, alive on the wire? | `PLAYERS[]`, `p.cam` (drawn) vs `p.tx/ty/tang` (wire), `p.lastT` vs `netNow()` |
| Which scene am I in? | `netSceneId()`, `SCENE.id`, `inside` |
| Which scene is a peer in? | `p.sceneId` — `'city'` or `'b<id>f<floor>'` |
| Is this actor mine to reason about? | `actorHere(a)`, `actorScene(a)` |
| Replicated or local-only? | `actorNetSynced(a)`, the `CAST0` boundary |
| What has the world remembered? | `worldDelta.{taken,drops,slain,seen,tags,cutIn}` |
| Time / weather | `clock`, `dayCount`, `weather`, `fogLevel`, `wetLevel` |
| Crowd | `peds[]` (`p.off` = despawned), `cars[]`, `CARS0` |
| Link health | `NET.link.rtc.{live,swarm,route,ice}`, `NET.link.bus.state`, `NET.error` |

**The `CAST0` / `CARS0` boundaries are the most useful thing to know about multiplayer.**
Anything the seed placed sits below the line and is shared; anything spawned at runtime
sits above it and exists on exactly one screen. Most real multiplayer defects are
something above the line behaving as though it were below.

Be precise about *how* it is shared, because it is not by array position. The outdoor
seeded cast is addressed **by `a.id`**:

```js
} else if (m.c !== undefined){                       // 'slain', outdoor cast
  if (!actors[i].interior && actors[i].id === m.c && actors[i].id < CAST0) …
```

and a room's cast by `(interior, iidx)`. So two clients whose `actors` arrays are
different *lengths* still resolve every wire reference to the same body. A length
difference is a real divergence worth reporting — it means one client is simulating a
body the other is not — but it does not by itself mis-target anything.

---

## 4. Host and join

Host-authoritative: the host simulates the crowd, every nameable actor, the sky and the
clock. **Do not host from a throttled client.**

Drive the real menus with `onPress(code, key)`. Menu behaviours to expect:

- The cursor opens on the **first row**, which in the multiplayer panel is a read-only
  status row. Walk it to a matching `label`; never assume it starts on an action.
- Joining **pops two modes and leaves you on the pause card**. The world is frozen for
  you until you close it; `netTick` keeps running so you exist for others meanwhile.
- In dialogue trees the **first Space is deliberately swallowed** if the option list
  changed within 450 ms (anti-misclick). Press, verify, press again.

Room codes are five characters from an alphabet with no look-alikes — never `I`, `O`,
`0` or `1`. Feed them as `KeyU`, `KeyN`, … then `Enter`.

Three transports run at once — BroadcastChannel (same machine), WebRTC via public
trackers, and an MQTT bus that survives strict NAT. A per-author sequence number
de-duplicates; fastest route wins.

```js
({ room: NET.room, role: NET.role, status: NET.status,
   rtc: NET.link.rtc && { live: NET.link.rtc.live, swarm: NET.link.rtc.swarm,
                          route: NET.link.rtc.route, ice: NET.link.rtc.ice },
   bus: NET.link.bus && NET.link.bus.state,
   err: NET.error || 'none' })
```

`swarm` counts you — two humans plus one agent reads `3`. A healthy join reaches
`status:'joined'` and `ice:'connected'` in a few seconds.

The handshake carries `{seed, clock, day, weather, timeMode, fog, wet, worldDelta, tags,
quests, qvar, track}` and the client rebuilds from the seed. **Confirm the clock jumped** —
if the seed matches but the clock did not move, you are not really in.

---

## 5. Locomotion

Movement is gated on `if (!topMode()) updateCam(dt)`. Clear modes before moving.

- **Walk** — `keys['KeyW'] = 1`, `keys['ShiftLeft'] = 1` to run. Forward is
  `(cos(cam.ang), sin(cam.ang))`.
- **Turn** — assign `cam.ang` directly; that is what the mouse handler does.
- **Discrete** — `onPress(code, key)`.

Without pointer lock, `ME.aiming` is always false for an agent and always **true** for a
human who is simply playing — the flag is `weaponId() && document.pointerLockElement`, and
`weaponId()` returns the truthy string `'fist'` when bare-handed. It encodes "has pointer
lock". Do not report it as meaningful.

### Pathfinding

`astar(sx, sy, tx, ty, limit)` returns tile indices (`y * MAP + x`) over the bound scene's
`walkG`. It is fast and correct — **and `walkG` contains tiles only. Props are not in the
navigation grid**, so a planned route runs straight through shelves and counters. (This is
also why the engine's own `hostileBrain` stalls on geometry.)

Use a two-level planner: `astar` for the long haul, a prop-aware BFS for the local leg.
Pick the furthest `astar` waypoint inside your local window and BFS to it.

**That is the recipe for OUTDOORS. It is not enough indoors.** In a four-metre shop the
furniture *is* the room, and a tile-only path is not a rough guide, it is useless — the
planner walks you into a counter and holds forward there forever, which reads exactly
like the client having frozen. Indoors you want the goal test itself to know about
props: an A\* whose walkability is `walkG && !propBlocked && !tileBlocked`, windowed to
the room so it costs nothing. `PT.nav.routeTo` is that.

And the move you actually want before interacting is neither: it is *stand on the nearest
tile that is both standable and within reach of the target*. A shopkeeper behind a
counter is 1.96 tiles from the closest tile you can occupy; fist reach is 1.7. Walking
"to" them is not a thing you can do. `PT.nav.closeOn(x, y, reach)` solves that sentence,
and `PT.act.reach(target)` goes further — it keeps working until the probe actually
offers the thing, sidestepping when something else outscores it in the cone.

```js
const ok = (x, y) => {
  const i = y * MAP + x;
  if (x < 1 || y < 1 || x >= MAP-1 || y >= MAP-1 || !walkG[i]) return false;
  return !propBlocked(x + 0.5, y + 0.5, 0.34) && !tileBlocked(x + 0.5, y + 0.5, 0.34);
};
// 8-way BFS over a ±16 window; refuse diagonal corner-cutting:
//   if (dx && dy && (!ok(sx+dx, sy) || !ok(sx, sy+dy))) continue;
```

Steering rules that stop the agent wedging:

1. **Turn before you walk.** Holding forward while rotating makes you hug walls and pin
   yourself in corners. Above ~1.0 rad of heading error, rotate and hold still.
2. **Strafe past obstructions** — try ±0.8 rad with a strafe key before replanning.
3. **Detect stuck by displacement, not intent** — holding forward while moving <0.004
   tiles/tick. After ~0.9 s force a replan and an escape heading.
4. **Sweep the full circle when escaping** — a coarse fan misses the one clear heading.
   All 24 headings at two probe distances, take the free one nearest the goal.

### Following through doors

Compare `t.sceneId` with `netSceneId()`.

- **They went in, you are outside** — parse `b(\d+)f(\d+)`, `doors.find(d => d.b === bldId)`,
  path to it, `enterInterior(dr)` within ~1.2 tiles. Floor 1 only; upper floors need stairs.
- **They came out, you are inside** — path to `inside.exit`, `exitInterior()`.

Never ease across a scene change. The street is near tile 500 and every room is stamped at
the array origin near tile 10; interpolating draws a body sliding 400 tiles through solid
city. The engine snaps peers on scene change — match that.

---

## 6. Directed actions

Prefer, in order:

1. **Through the probe.** `probeInteract()` sets `lookTarget` with a `kind` and a
   human-readable `prompt`. Face it, **assert the prompt matches your intent**, then
   `tryInteract()`. Only this route exercises reach, cone and line-of-sight properly.
2. **Through `onPress`** for anything key-bound.
3. **Direct function calls** — last resort, always disclosed. Calling `enterInterior()` is
   not the same test as walking through the door.

`tryInteract()` acts on whatever `lookTarget` currently is — the highest-scoring thing in
the cone, not what you meant. Facing a shopkeeper while intending to leave opens a
conversation.

Verify actions by engine evidence, not by the keypress: the `worldDelta.taken` key that
appeared, the `'ev'` packet that went out, the `hp` that changed, the `worldDelta.slain`
entry that survived the room rebuilding from seed.

---

## 7. Instrumentation

| Patch | Gives you |
|---|---|
| `netEvent` | Every replicated event: `took`, `drop`, `cut`, `shot`, `ahit`, `phit`, `pdown`, `pdam`, `slain`, `tag`, `seen`, `clk`, `scat`, `cutin` |
| `toast` | Everything the game told the player, incl. quest milestones replicating to bystanders |
| `openDialog` | Conversations opening, and which |
| `damagePlayer` | Damage arriving at you, with the engine's value |
| `acquireScene` / `releaseScene` | Room lifecycle with refcounts — the most diagnostic trace in the game |
| `stampRoomCast` | Which bodies a room build claimed, and their wire ordinals |
| `window.onerror`, `console.error` | The failures nobody surfaces |

A healthy interior visit:

```
acquire b1371f1 refs:1          ← first player opens the door
stamp   b1371f1 from:181 cast:2 ← bounded to this build's two bodies
acquire b1371f1 refs:2          ← second player walks in after them
took    b1371_0                 ← keyed loot claim, one winner
release b1371f1 refsAfter:1     ← first leaves, room survives
release b1371f1 refsAfter:0     ← last out, torn down
```

**Sampler:** once a second, driven from the **worker tick, not `setInterval`** — a
throttled sampler does not stop, it lies about elapsed time. Per player: position, scene,
hp, dead, weapon, flags, staleness (`netNow() - p.lastT`). Globally: clock, day, weather,
fps, ped/actor counts, live scene keys. Log only transitions.

Staleness distinguishes idle from dropped: motionless for four minutes with `lastT` of
0.07 s is standing still by choice; the same stillness with `lastT` climbing is a
connection problem.

---

## 8. Assertions that don't lie

**Three findings in the source session were the instrument, not the game.** Each produces
a rule.

**Artifact 1 — measured a delta, called it a rate.** A player "teleported" 14.1 tiles in
one sample. The sampler's timer had drifted to two seconds under throttling; 14.1 tiles
over 2.0 s is 7 t/s, exactly sprint speed.
→ *Never threshold on per-sample distance.* Divide by measured elapsed time. Sprint tops
out near 7.5 t/s; a real discontinuity moves you hundreds of tiles.

**Artifact 2 — asserted on presence, not failure.** An alarm fired 135 times reporting an
actor from another player's room within six tiles. That overlap is architectural — every
interior is stamped at the same array origin, so two occupied rooms always share
coordinates. The engine was correctly refusing to draw, collide with or target it.
→ *Assert on the consumer, not the condition.* Not "is a foreign body nearby" but "did
`probeInteract` ever hand the player a target from another room" — which can only be true
if something is broken. Restated, it fired zero times in 307 overlaps.

**Artifact 3 — tested a component out of context.** A sweep reported `spireTree` opening
on a node that does not exist. It does — standalone. In the game it is spread into another
character's tree, which supplies the missing entry.
→ *Validate objects as the game assembles them*, not as the factory returns them. Prefer
sweeping live instances.

Two more:

- **Rate-limit every assertion.** One standing condition emitted thirty identical lines and
  buried the signal. Suppress identical messages for ~30 s.
- **Never wrap an instrument you are about to replace.** A sampler captured the log
  function into a local `const` at install time; wrapping the global afterwards had no
  effect. Rebuild instruments from scratch and re-verify the patch took.

### The verification ladder

Most candidates die on step 2.

1. **Is the instrument sound?** Elapsed time, thresholds, consumer-vs-condition.
2. **Can I reproduce it deterministically?** Construct the state and watch it fail on demand.
3. **Do I have the mechanism?** Name the line; explain why it produces *this* symptom.
4. **Does it survive a clean client?** Re-test against the real file in a fresh tab, never
   against a hot-patched session carrying your own mutations.
5. **Is single-player unchanged?**
6. **Do two independent clients agree?** Hash a signature of built state and compare.

---

## 9. Multi-agent groups

Each agent is one browser client; the engine treats agents and humans identically.

- **One authority.** Exactly one host, chosen deliberately, frame rate measured and
  monitored. Everyone else guests.
- **Distinct objectives.** Agents on the same player report the same thing three times.
  Assign each a different human, district or quest line.
- **One reporter, or dedupe by mechanism.**

Agents already share a world — use it as the coordination substrate. Positions, scenes,
quest state and the event stream are visible to every client. Reserve out-of-band
messaging for task assignment and handing findings to whoever is filing.

Two agents in *different* interiors is a useful test and the easiest thing to misread:
both stand on the same coordinates. **Always qualify a position with its scene.**

### Stress patterns worth running

- Two clients into **the same room**, both entry orders, both exit orders. Watch the
  refcount walk 1 → 2 → 1 → 0.
- Two clients into **different rooms** simultaneously; try to interact with each other's
  cast and confirm the engine refuses.
- One leaves a room and immediately re-enters while another stays inside.
- Everyone in a room; one dies inside it.
- A quest set-piece triggered by one player while another stands beside them.
- One sleeps or works a shift mid-activity; watch the clock jump propagate.

---

## 10. Cleanup contract

| If you… | You must… |
|---|---|
| Acquired a scene | Release it — never one you are still standing in |
| Entered an interior | Leave via `exitInterior()`, not by rebinding by hand |
| Spawned an actor | Splice it out; confirm `actors.length` is back to baseline |
| Moved the camera to probe | Restore the exact position |
| Edited quests or inventory | Snapshot before, restore after — quest state **replicates** |
| Patched a function | Keep the original; be able to unpatch |
| Opened any mode | `while (topMode()) onPress('Escape','Escape')` |

Releasing a scene you are standing in leaves you bound to a torn-down room whose tile
buffers went back to the pool — the next room built is stamped over the array you are
walking on. The frame loop can resurrect the released object through `sceneStore`, which
makes it look fine while remaining unsafe. Recover: close all modes, `exitInterior()`,
verify `SCENE.id === 'city'` and a finite position.

```js
({ scene: SCENE.id,
   scenes: [...SCENES.keys()],
   actors: actors.length,
   interior1: actors.filter(a => a.interior === 1).length,   // 0 outdoors
   camFinite: isFinite(cam.x) && isFinite(cam.y),
   modes: modeStack.length })                                 // 0
```

---

## 11. Reporting

1. **Symptom, in the player's words.**
2. **Mechanism, at a line** — why this and not something else.
3. **Evidence** — trace, packet, diffed frame, state dump. Raw, not paraphrased.
4. **Reproduction** — the deliberate construction, not the accident.
5. **Blast radius** — solo or multiplayer, host or guest, recoverable or terminal.
6. **What you are unsure of.**

Two habits matter more than the format:

- **Retract loudly and immediately** when a finding was your instrument — same register as
  the report, not a footnote.
- **Separate rig problems from game problems every time.** "I wedged against a wall" is
  your pathfinder. "The planner routes through furniture because props are not in the nav
  grid" is an engine characteristic. "The stairwell lock let me through because the content
  it gates is never built" is a defect.

---

## 12. Recipes

### Cold start, shadow mode

1. Load the game; install the worker driver and error trap.
2. Override viewport, pin `manualRes`, `initRender()`.
3. Verify driven fps ≥ 55, `__err === null`, `R.cols === 182`.
4. `while (topMode()) onPress('Escape','Escape')`.
5. Install screen reader, event patches, sampler on the worker tick.
6. Join through the menus; verify `joined`, `ice: connected`, clock jumped.
7. Identify the target by id, enable the follower, confirm their body renders by
   differencing.
8. Report join, roster, world state. Then go quiet.

### Structural sweep of dialogue content

Runs offline in a solo client; finds a whole class of lockup before a human meets it. For
every tree the game actually assembles — live `actors[i].tree`, plus each shop trade —
across a matrix of quest and variable states, assert `tree[entry()]` exists and every
node's text resolves to a string.

A node whose text comes back `undefined` is an **unescapable freeze**: the tree's key
handler evaluates it before it reads the escape key, so the throw kills Escape too.
(60,125 node checks across 170 trees and 180 states ran in a single probe.)

### Determinism check for new content

Two fresh clients on the same seed. Build the same rooms in each; hash a signature of cast
names, wire ordinals, positions and loot placement; compare. Identical hashes mean it will
replicate. Divergent hashes mean wire ordinals address different bodies on different
machines.

### When the game appears totally frozen

Two distinct causes, one probe, in this order:

1. `window.__err` — a frame throwing every tick; your driver caught the stack.
2. `topMode()` — a mode holding the keyboard. If a keypress raises inside its handler,
   even Escape is dead and only a reload recovers.
3. `isFinite(cam.x)` — a non-finite camera. Nothing throws visibly: the gradient builder
   fails, the probe matches nothing, every key looks unresponsive.
4. `sitting` / `cam.riding` — both make `updateCam` and `probeInteract` return
   immediately, which reads identically to frozen.


---

## 13. Contracts learned the hard way

Each of these cost a probe or more, and each is a *contract* — a fact about how the game
takes input or reports state that no amount of care will get right by guessing.

### The 30-second probe ceiling

The driving tool kills any call that has not resolved in 30 s, and you lose the return
value even though the work inside the page finished normally. A 181-tile walk took 31.1 s;
the walk was fine, the probe was not. Clamp every wait below the ceiling
(`PT.see.CAP = 25000`) and return honestly. Start-and-poll is the pattern for anything
longer, and the behaviours keep running in the page regardless.

### Dialogue

Options live on `visibleOpts()`, labelled `.t` (not `.label`), already `if`-filtered.
`m.items` is empty for a dialog mode, so any menu reader built on `items` is blind to
every conversation in the game.

```js
case 'Space': case 'Enter':
  if (!this.pageDone()){ this.t0 = -1; break; }        // text still paging: no commit
  if (opts.length){
    const sigNow = this.sig(opts);
    if (sigNow !== this.lastSig && performance.now() - this.nodeT < 450){
      this.lastSig = sigNow;
      this.cursor = opts.length - 1;                   // parks on the BOTTOM row
      break;                                           // and eats the press
    }
```

The guard **arms the refusal** rather than doing nothing, and the bottom row is normally
the decline. Reproduced on THE WATCHER: two fast presses took "Not interested" and the
quest never started.

Moving the cursor sets `lastSig`, so a deliberate `ArrowDown` disarms the guard as well as
selecting. And `go(id)` re-stamps `nodeT` on **every** transition including same-node
re-entry — which is why "did `nodeT` advance" is the honest commit test and "did the node
change" is not: selling one unit at a time legitimately re-enters `job`.

Escape has its own 250 ms guard from `openedT`.

### The inventory

Tools act on the world and are used from the card, never through the crosshair — a job
like "put the cell's mark on 3 walls" cannot be done with `tryInteract()` at all.

- `Tab` **opens** the card. `Tab` does **not** cycle tabs — `onTab(){ popMode(); }` closes
  it. Tabs are `onLR`: arrows or A/D. The card's own hint row says so.
- `onDigit` pins **consumables only**, so a tool can never reach the 1–3 hotbar.
- `burnTag()` has no probe target: it ray-walks `cam.ang` from 0.6 to 4.2 tiles looking for
  `tH > 1.6`, and refuses indoors. The only honest precondition is "is a wall actually in
  front of me".

### Menus

Match rows by more than substring. A stairwell listing `FLOOR 11 - top / FLOOR 9 /
FLOOR 1 - street` will hand `'FLOOR 1'` the *eleventh* floor. Score exact →
word-boundary → unique substring, and refuse ambiguity. The same collision waits in any
bet ladder (`BET 10` vs `BET 100`).

`menuMove` skips separator and info rows, so a computed target index may be one the cursor
cannot occupy — verify the cursor actually landed before pressing.

### Combat

`fireWeapon()` with a gun equipped and **zero ammo is a silent no-op**: no toast, no
cooldown, nothing in the event stream. A rig that does not preflight the magazine closes
to melee range, spends its whole swing budget, lands nothing, and reports it in exactly
the shape of a combat defect. `PT.act.checkWeapon()` before any fight.

### Behaviour ticks and death

Order the guards `hp <= 0` **before** `topMode()`. Dying pushes the `dead` mode, so a tick
that returns early on `topMode()` never reaches its own death check: the behaviour stays
`on` for the rest of the session, `PT.busy()` reports it forever, and every subsequent
`settle()` hangs until timeout. This bit `attack`, `loot` and `reach`.

Death itself: half your credits stay where you fell, corruption resets to 0, inventory
survives, and you wake on a metro platform.

### Quest state is evaluated on a throttled tick

`auto()` being true is not the same as the quest being done. Let a tick pass — do not read
`player.quests` in the same probe as the action that satisfies it.

### Indoors, coordinates are not a place

`cam.x/cam.y` inside a room are its stamped coordinates near the array origin.
`districtAt()` of those is meaningless — it read "RURAL" from inside a depot in the
Smelters. Report the scene instead, and never print a peer distance across scenes.

### A seeded actor can be culled without a record

`enfBrainTick` removes an off-duty enforcer:

```js
if (a.tier && player.corruption < a.tier && !a.aggro && a.brain !== 'patrol'){
  actors.splice(i, 1);            // index.html:13785 — no worldDelta entry, no wire event
```

Seeded patrols ship with `tier: 0`, which is what keeps them out of this. But
`enfRecognise` (index.html:13755) sets `a.tier = Math.max(a.tier || 1, …)` the moment one
witnesses a crime — so a seeded patrol that recognised you and then lost you is no longer
protected. Observed: host `actors` ids `[0,1,2,3,5..30]`, guest `[0..30]`,
`worldDelta.slain` empty on both, no `slain` event ever broadcast, no matching corpse in
`worldDelta.bodies`. The host is permanently one seeded body short; a joiner or a reload
rebuilds it. `PT.clean()` reports this as a negative `aboveBaseline` and names the ids.

### Re-evaluating `observer.js` does not replace the checker that is running

Editing the file, re-fetching it and `eval`-ing it in a long-lived tab leaves the ORIGINAL
checker installed and running. The new `__OBS` object exists; the old closure is still the
one on the frame hook, still emitting the old findings. The tell is the finding's *shape*:
old-format details with none of the fields the new code adds, and a fresh `__OBS` that is
missing the new code's own state (`'_noRoute' in __OBS === false`).

This is §8's "never wrap an instrument you are about to replace", met from the other side.
**Verify an observer change in a freshly loaded tab, not a hot-patched one.**

And give the test a long enough window. `flag()` is rate-limited — most invariants at
45 seconds. An eight-second "no findings" window proves nothing at all about a check that
can only speak every forty-five; it was read as a clean bill of health here and was not
one. Clear the queue, wait past the limit, then read.
