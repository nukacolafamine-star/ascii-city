---
name: playtest
description: Join ASCII CITY as a third player and playtest it alongside the human — host or join a lobby, follow them, take turns driving quest stages, and watch the engine's internals for defects. Use when the user wants to play/test the game together, run a quest co-op, hunt multiplayer bugs, or asks to "join my lobby" / "playtest with me" / "run the main quest with me".
---

# Playtesting ASCII CITY as a live player

You join the same lobby a human joins, walk the same streets, and are subject to the same
engine. You are a **player who can also read the engine's mind** — that is the whole value.

## How your vision actually works

You cannot be invoked sixty times a second, and you do not need to be. `observer.js`
installs a **watcher that runs inside the game at its own frame rate** and checks
invariants on every single frame. You read its findings when you check in.

> **Fast reflexes in the page. Slow judgement in you.**
> Nothing that happens in a frame escapes the watcher. What you supply is deciding what
> to do about it, where to look next, and what is worth telling a human.

So: do **not** poll in a tight loop, and do **not** take screenshots to see what happened.
Ask `__OBS.report()` every minute or so, or after any action, and read `FINDINGS`.

---

## 1. Get in

Serve the folder if it is not already up — `node serve.mjs 8123` — then open
`http://localhost:8123` in the browser pane and run **one line**:

```js
fetch('/.claude/skills/playtest/rig/boot.js').then(r=>r.text()).then(t=>(0,eval)(t));
```

Then read `PT.status()` on the next call. That brings up `observer.js` **and** the
rig: one frame driver that survives the pane lying about visibility, a navigator that
knows about furniture, an action layer that refuses to interact with the wrong thing,
and the long behaviours. See **§The rig** below for the API.

Expect `driver` to name exactly one worker and `fps` near 60. **If fps reads ~120 you
have two drivers and the world is running at 2×** — `PT.checkDriver()` says so out
loud. On a host that means the whole world runs double for everybody.

If you want the watcher and nothing else, the observer still loads on its own:

```js
fetch('/.claude/skills/playtest/observer.js').then(r=>r.text())
  .then(t=>{window.__boot=eval(t)}).catch(e=>{window.__boot='ERR '+e});
```

**Ask the human to make the browser pane visible if they can** — ideally on a second
monitor, so they can watch you play. It costs them screen space and gives you real
screenshots. Note that a visible pane is *not* a reliable loop: see the driver trap in
`reference.md` §1.

Then clear the intro: `PT.act.esc()`.

## 2. Host or join

Ask which, unless they said. Default is **they host, you join** — they give you a
five-character code.

Only host after checking your frame rate in `__OBS.report()`. The host simulates the
crowd, every seeded actor, the sky and the clock; a slow host runs the world slowly **for
everyone**, and the humans will report it as a game bug.

Drive the real menus with `__OBS.tap(code)`. Escape → `MULTIPLAYER` → `HOST A GAME` or
`JOIN A GAME`; type a code with `__OBS.typeCode('UNNAR')` then `tap('Enter')`.

Confirm you are genuinely in before saying so: `status:'joined'`, `ice:'connected'`, and
**the clock jumped** to the host's time.

Report the join once — room code, roster, seed, date and time, where everyone is
standing. Then go quiet. Do not narrate.

---

## Read the sources, not the screen

`__OBS.screen('only')` is the HUD **layer**, and the first-person body viewmodel is
drawn into that layer through `hudCell`. On a 206×106 grid it came back as 57 non-blank
rows of which 36 were the player's own arms — about 7,000 tokens to learn nothing. Do not
pay for that.

**`PT.see()` is your main read.** It asks the engine the questions directly — position and
scene, district, clock, hp/credits/corruption, weapon and ammo, inventory, the tracked
quest with its objective line and marker, `lookTarget.prompt`, the current toast, the open
mode and its rows — for about 200 tokens.

```js
PT.see()            // the whole player state, cheap
PT.see.quest()      // the tracked job: name, leg, objective line, where the marker points
PT.see.quests()     // everything you are holding, done and live
PT.see.hud()        // the HUD glyphs with texture rows filtered out — when you must
PT.see.raw({r0,r1}) // the buffer, cropped, for proving something rendered
```

Reach for the glyph buffer only to prove a *rendering* claim. Everything else is a
question the engine will answer directly and exactly.

## One round trip, not six

**The page awaits promises, so let the page do the waiting.** The behaviours already run
at 60 Hz inside the game; you do not need a probe per step.

```js
// walk there and come back with the result — one call
await PT.see.go(x, y)
// or: start something, then wait for the rig to go idle
PT.act.lootAll(); await PT.see.settle()
```

> **There is a hard 30-second ceiling on a probe.** A promise that resolves later kills the
> call and you lose the answer *even though the work in the page finished fine* — a
> 181-tile walk took 31.1 s and the probe died at 30. Every wait in the rig is clamped to
> 25 s (`PT.see.CAP`) and returns `{settled:false, still, nav}` honestly rather than
> hanging. For anything longer: start it, let the probe return, and poll.

## Conversations

Do not press Space and hope. The dialog mode's anti-misclick guard does not merely swallow
a fast press — it **moves the cursor to the bottom option and then eats it**, and the
bottom option is almost always the one that declines:

```
node 'offer', cursor 0 = "Deal",  opts ["Deal", "Not interested"]
press 1  ->  node 'offer', cursor 1     guard ate it AND armed the refusal
press 2  ->  node 'pass',  quests []    declined; the quest never started
```

`PT.dlg` reads the tree and drives it properly — page the text in, wait out the 450 ms
window (or move the cursor, which disarms it), select by label, press once, and verify
`nodeT` advanced.

| call | does |
|---|---|
| `PT.dlg.read()` | title, node, the actual text, the options with the cursor marked, ms of guard left |
| `await PT.dlg.to('ROOK')` | walk to them, open them, hand back the first page — and **check the title matches who you asked for** |
| `await PT.dlg.say('Deal')` | pick by substring or index, verified; refuses if no option matches |
| `await PT.dlg.run([...])` | a script of choices in order |
| `await PT.dlg.walk({choose})` | auto-advance; stops on a dead node or a loop |
| `await PT.dlg.close()` | leave, respecting the 250 ms open-guard |

## Multiplayer

| call | does |
|---|---|
| `PT.net.status()` | room, role, status, rtc/ice/swarm, bus, error, clock — the confirmation set |
| `PT.net.roster()` | everyone, **qualified by scene**, with staleness in seconds |
| `await PT.net.host()` / `PT.net.join(code)` | drive the real menus; `join` returns `ok` only if status is joined, ice connected, **and the clock jumped** |
| `PT.net.scenes()` | what is built, its refcount, and who is standing in it |
| `PT.net.rooms('b972')` | the acquire → stamp → release trace for one room |
| `PT.net.watch()` / `PT.net.log()` | the once-a-second sampler from `reference.md` §7, on the frame tick, logging transitions only |

`roster()` prints `d: null` when a peer is in a different scene, deliberately. Every
interior is stamped at the same array origin, so two players in different rooms sit on
nearly identical coordinates and a bare distance is a lie.

---

## The API

| Call | Does |
|---|---|
| `__OBS.report({findings:20, events:15})` | **Your main read.** State, roster, world, link, findings, recent events |
| `__OBS.report({clearFindings:true})` | Same, and empties the queue so next time is only new |
| `__OBS.screen()` | The screen as text — HUD over world, exactly what the player sees |
| `__OBS.screen('only')` | The HUD **layer** — which includes the first-person body, see below |
| `__OBS.palette()` | Which colours are on screen right now, **by name**, most-used first |
| `__OBS.findColour('camRed')` | Is that colour being drawn, how many cells, and where |
| `__OBS.isolate(get,set)` | Render twice with the subject moved away and diff — proves a thing is drawn |
| `__OBS.down/up/tap(code)` | Real dispatched key events, through the game's own bindings |
| `__OBS.typeCode('ABC12')` | Type letters/digits as key events |
| `__OBS.release()` | Let go of everything held — **always do this after moving** |
| `__OBS.clean()` | Baseline check: scenes, actor count, finite camera, open modes |

Movement is `down('KeyW')`, `down('ShiftLeft')` to run, then `release()`. Turn by
assigning `cam.ang` — forward is `(cos(cam.ang), sin(cam.ang))`.

### What the watcher flags, without being asked

`CAM_NOT_FINITE`, `SCENE_DISAGREES`, `RENDER_STALLED`, `PALETTE_COLLAPSED`, `HUD_BLANK`,
`TRACKED_QUEST_NO_ROUTE`, `INPUT_THREW`, `MODE_HELD_LONG`, `FOREIGN_ACTOR_ACCEPTED`,
`PROBE_CROSS_ROOM`, `ROOM_NO_DESCRIPTOR`, `PEER_NOT_FINITE`, `PEER_STALE`, `FRAME_THREW`,
`JS_ERROR`.

Each is an **invariant** — something that must be true of a working build — not a
heuristic. They are rate-limited, so a standing condition reports once, not sixty times a
second.

---

## The one rule that matters most

Three findings in the session that produced this were the **instrument**, not the game.
Before reporting anything as a bug, climb the verification ladder in `reference.md` §8.
Retract loudly and immediately when you get one wrong — an unretracted false alarm costs
the developer more than a missed bug.

Worked example, from testing this very file: the route line looked absent —
`waySet` had 101 tiles and `findColour('camRed')` returned **0 cells**. That is exactly
the bug shape. It was not a bug: the camera was facing the wrong way, and the line is a
dotted centre-of-tile line by design. Facing along the route gave 11 cells. **Check your
own facing, range and sampling before you file.** (`waySet` is an **Array** — `.length`,
not `.size`. Reading `.size` gives `undefined` and looks like the line does not exist.)

Two more from the session that added `PT.see`:

- **The instrument fired on a condition that cannot be met.** `TRACKED_QUEST_NO_ROUTE`
  flagged MAKING A MARK repeatedly. That job is "paint any three walls" — `questTarget()`
  returns null, so no route could ever exist. The invariant now requires a real target,
  `autoPath` on, distance > 6, and three consecutive checks (`autoPathTick` clears and
  refills `waySet`, so one mid-rebuild sample says nothing).
- **The instrument read too early.** `mq2`'s `auto()` was already true, yet
  `player.quests.mq2` still read live 350 ms after the third mark. Quest completion is
  evaluated on a throttled tick. **Never read quest state in the same probe as the action
  that satisfies it.**

And retract with the same force. In this session I said a one-actor difference between two
clients meant "every wire ordinal from index 12 up addresses a different body". It does
not: the outdoor cast is addressed by `a.id`, not by array position
(`actors[i].id === m.c && actors[i].id < CAST0`). The divergence was real and worth
reporting; my account of its blast radius was wrong, and saying so is part of the job.

---

## Co-op quest mode: taking turns

Use this when the human says "run the main quest with me, alternating who drives".

For each quest stage:

1. **Announce the handoff in one line** — who drives, who watches, which stage. Read the
   stage from `player.quests` and the quest log rather than guessing.
2. **Run the stage** in whichever role you hold.
3. **Report** — a few lines, shape below.
4. **Swap** and continue.

Track whose turn it is explicitly and say it every time. If you lose track, ask.

### When OBSERVING

Stay out of the way. Do not loot, attack, talk to anyone, or open doors they need. Hold
about four tiles back. Follow them through doors — interiors are where the defects live.

Watch `report()` for scene refcounts on every door (`acquire` → `stamp` →
`release refsAfter:0`), loot claims, kills, damage, quest state replicating to you as a
bystander, and anything in `FINDINGS`. Speak only if something trips.

### When DOING

Play it properly — walk, don't teleport. Use the probe like a player: face the target,
**read `lookTarget.prompt` and confirm it says what you expect**, then `tryInteract()`.
It acts on whatever is under the crosshair, not on what you intended; this has opened
conversations when the intent was to leave a room.

Narrate briefly as you go — they are watching and cannot see your screen. What you are
walking to, what the prompt says, what happened.

If a stage needs something you cannot legitimately do, hand it back rather than reaching
past the game to force it.

### Report shape, per stage

- **What happened**, in the player's words
- **What the engine did underneath** — the trace, the packet, the delta key
- **Anything that tripped**, labelled honestly as one of: a **game defect** (with the
  mechanism, at a line) · an **engine characteristic** worth knowing · **your own rig**
  misbehaving

---

## The rig

Four files under `rig/`, loaded by `boot.js`. Everything hangs off `window.PT`.

| call | does |
|---|---|
| `PT.status()` | **your main read** — driver, fps, position, scene, hp, credits, weapon, inventory, mode, net, and what the rig is currently busy doing |
| `PT.clean()` | the §10 cleanup contract in one call; returns actor count against `CAST0` |
| `PT.tail(n)` / `PT.say(s)` | the rig's own log |
| `PT.tap/down/up/type` | real dispatched key events, through the game's bindings |
| `PT.see / PT.dlg / PT.net` | the cheap read, conversations, and multiplayer — above |

**Movement — `PT.nav`.** `goto(x,y)` picks its own strategy: the two-level street
planner across the city, a furniture-aware A\* indoors. `closeOn(x,y,reach)` is the one
you almost always want before interacting — it stands on the nearest tile that is *both*
standable and within reach of the target. `grid()` prints a small ASCII map of what the
walker believes, for when it disagrees with you about whether somewhere is reachable.

**Actions — `PT.act`.** `use(want)` **refuses** unless the prompt contains `want`; this
is the guard rail that stops you opening a conversation when you meant to leave a room.
Prefer `reach(t, {kind:'shift'})` over matching prompt words — the wording varies where
you would not expect it, and a freight station's prompt reads `[E]  HAUL FREIGHT` with no
"SHIFT" in it at all. `pick(label)` scores rows exact → word-boundary → unique substring
and **refuses an ambiguous match**, because `pick('FLOOR 1')` in a stairwell listing
`FLOOR 11 / FLOOR 9 / FLOOR 1` used to stop on FLOOR 11 and report success.
`await item('GRAFFITI BURNER')` / `inv()` drive the inventory card — the tools (burner,
jammer, cam-jack, firecrackers) are used from there and **cannot be reached through the
crosshair at all**, so a job like "put the cell's mark on 3 walls" is impossible without
it. `propsNear(k)` / `camsNear()` / `cutCams(n)` reach the prop classes that
`itemsNear`/`furnNear` miss — above all `PK_CAM`, which three separate jobs ask you to
cut. `checkWeapon()` before any fight: **a gun with no ammo fires silently** — no toast,
no cooldown, nothing on the wire — so an unchecked rig swings its whole budget, lands
nothing, and reports it exactly the way a combat bug would.
`reach(target,{want,use})` walks in and keeps working until the probe actually offers
that thing, sidestepping when something else outscores it. `pick(label)` drives a list
menu. `actorsNear/pedsNear/itemsNear/furnNear/peers` list what is around (their `ref` is
non-enumerable, so `JSON.stringify` stays small). `findBuildings(use)` skips `d.sealed`
doors, the way the game's own routing does.

**Behaviours — `PT.drive`.** `queue([...])` chains jobs: `{kind:'rob'|'work'|'shop'|
'gamble'|'goto', bld, …}`. `ffa()` fights whoever is nearest. `PT.autoRespawn = true`
keeps a long run going through deaths.

Three things the rig exists to get right, all of them learned the hard way:

- **One frame hook, ever.** Behaviours are named entries in `PT.ticks`, redefined freely
  on reload. Wrapping `window.frame` per file stacks wrappers, and two copies of a
  behaviour fighting over one state reads exactly like a game bug.
- **Menus refuse a fast Escape.** There is a ~250 ms anti-misclick guard, so fifteen
  presses inside one probe close *nothing*. `PT.act.esc()` presses once and keeps trying
  on a slow tick. The same guard swallows the first Space in a dialogue.
- **`walkG` holds tiles, not props.** Outdoors that barely matters; indoors furniture
  *is* the room, so `PT.nav` uses a walkability test that asks `propBlocked` too.

## Other modes

- **Shadow** — follow one human, report, never perturb.
- **Directed** — they name an action; you perform it and report what happened underneath.
- **Autonomous** — no human present; set your own objectives. This is where you earn your
  keep: the exhaustive sweeps and stress patterns in `reference.md` §9 and §12 cover
  ground a small team cannot reach by hand.

---

## Running two testers

When the human wants "two Claude playtesters", **run both clients yourself from this one
session** — two browser tabs, one game client in each. Do not spawn subagents for it, and
do not assume a second chat is needed.

This works because each client carries its own 60 Hz watcher. You are not trying to be
present in two places at once; you are reading two digests that were compiled while you
were elsewhere.

Why one session beats two:

- **Ordering is free.** Most multiplayer defects need a precise sequence between two
  clients — A enters first, B follows, A leaves while B stays. One mind just does that.
- **No duplicate filings.** Two independent agents rediscover the same bug twice.
- **You see both sides of a desync at the same instant** — which was the single most
  valuable form of evidence in the session that produced this skill.

### Setup

```js
// one tab per client; keep a note of which tabId is which role
// in EACH tab, install the observer:
fetch('/.claude/skills/playtest/observer.js').then(r=>r.text())
  .then(t=>{window.__boot=eval(t)}).catch(e=>{window.__boot='ERR '+e});
```

- **Pass `tabId` on every single call.** Each tab has its own `__OBS`, its own camera and
  its own opinion of the world. A call without a tabId lands somewhere you did not intend,
  and the resulting "bug" will be you.
- **Label the roles out loud** — e.g. tab A = host, tab B = guest — and restate which one
  you are acting in whenever you switch. The human cannot see your tabs.
- **One host only.** If a human is in the session, let them host: they are the constant.
  If it is agents alone, one agent hosts and must hold its frame rate.
- **Report per client, not merged.** "A saw X, B saw Y" is the useful shape; a merged
  narrative hides the disagreement, and the disagreement is the finding.

### When a second chat is right instead

Genuinely independent work, or genuinely independent judgement:

- one session shadowing the human through a quest while another runs a long autonomous
  sweep elsewhere in the city;
- a second opinion on a defect the first has already formed a theory about.

Two sessions do not need a messaging channel to cooperate. **They are already in the same
game** — positions, scenes, quest state and the event stream are visible to every client,
so each can simply observe what the other is doing. Reserve out-of-band messaging for
task assignment and for handing a finding to whoever is filing.

## Before you finish

Restore what you touched — full contract in `reference.md` §10. Short version:
`__OBS.release()`, close all modes, leave interiors through `exitInterior()`, release any
scene you acquired, remove anything you spawned, restore any quest or inventory state you
edited, then check `PT.clean()` shows the actor count back at baseline, a finite camera
and no open modes.

`aboveBaseline` cuts both ways. **Positive** is something you spawned and must remove.
**Negative** is the world having lost a body the seed placed — not yours to clean up, and
a finding in its own right, because this client and every other client now disagree about
who exists. `PT.clean()` names the missing ids in `LOST_SEEDED_ACTORS` and says so.
