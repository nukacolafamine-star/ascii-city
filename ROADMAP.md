# ASCII CITY — polish & expansion roadmap

Twenty-two items, assessed against the codebase, grouped into phases in
recommended order. Effort scale: **S** (an hour-ish), **M** (a session),
**DEEP** (interiors-class: a system, not a patch).

**The four DEEP items:** #9 (living time/weather), #19 (corruption),
#22 (multi-floor interiors), #8 (first-person body). #13 (city map) and
#15 (wilderness) are M+ with one hard sub-problem each.

**Dependency spine:** #9 (the clock) unlocks #10 (calendar), #21 (waiting),
and #19 (corruption decay). #8 (overlay-anim framework) unlocks #11 (consume
anims). #4 (priced goods) gives #19 its "theft" crime. #7 (day/dusk look)
should land before #9 so the cycle has endpoints worth cycling into.

---

## Phase 1 — Quick polish (one session) — **DONE 2026-08-19**

**#6 Default max resolution + clear weather. (S)**
`CFG.resIdx` → finest, `manualRes` stays false so the Canvas2D budget and
auto-res still protect weak machines; `weather` initial 1 → 0. Two lines.

**#3 Sprint footstep cadence. (S)**
Steps are currently keyed to distance (`walkPhase += sp*dt*2`), so running
doubles the rate. Decouple: advance phase at a fixed cadence per gait —
walking ~6.4 rad/s, running ~5.0 (slower = long stride) — and give running
steps lower pitch, higher volume, bigger head-bob.

**#1 Window life simulation. (S/M-)**
All in `facade()`, no state arrays: each window derives a personal period
(25–90 s) and phase from its hash; the lit roll re-samples per time-bucket
(`hash3(seed, window, bucket)`), so windows wink on and off across the city
out of sync. A window whose *next* bucket is dark flickers irregularly for
its last ~2 s (the dying-tube effect); keep the rare fast ballast stutter.
Cost: ~2 extra hashes per window cell — negligible.

**#4 Shop display items cost money. (S)**
`dropItem` in shop rooms gains `price`; the probe prompt becomes
`[SPACE] BUY - CUP NOODLES (15 cr)`; taking deducts credits or refuses.
Homes/depots stay free scavenging. (When #19 lands, a "steal it anyway"
path becomes the theft crime.)

**#2 Counter gap + worktops. (S + M-)**
The middle gap is the walk-through — move it to one end so the front reads
solid (or seal it entirely; decide then). Worktops are a small renderer
addition mirroring the river's second-plane trick: in `floorPass`, project
each cell onto a plane at counter height (`d = (camZ-1.05)·projRows/…`); if
that projection lands on a counter tile, draw worktop surface and set depth.
Contained in one function; also fixes any future low furniture.

## Phase 2 — Commerce & inventory — **DONE 2026-08-19**

**#5 Shop clerk buy/sell interface. (M-)**
A dedicated shop screen on the menu toolkit: BUY section from a
per-archetype stock table, SELL section from the player's inventory at ~40%
of list price. `ITEMS` gains a canonical `price`; scrap becomes sellable
anywhere cheap (the watcher stays the premium buyer). Entered from the
keeper's tree ("Let me see the stock"), replacing the inline buy options.

**#18 Inventory tabs + categories. (S/M — organizational part only)**
`ITEMS` entries gain `cat` (weapon / consumable / material / accessory /
clothing / misc); the inventory card gets a tab row switched with
left/right (safe: inventory items have no adjustable values). Shops filter
stock by category. **Equipment effects** (wearing clothes, stat bonuses)
are deliberately out of scope here — that's its own future feature.

**#17 Trash can interaction. (S/M)**
Bins answer the probe (`[SPACE] TRASH`). A list menu of your items where
Enter toggles a `[x]` mark, then DISCARD MARKED opens a confirmation page
listing exactly what's marked (info rows) with CONFIRM / BACK.

## Phase 3 — World dressing — **DONE 2026-08-19**

**#7 Rework day and dusk. (M)**
Palette/curve tuning in `TIME` + both background paths: day gets a real
blue sky → pale horizon, higher ambient, dimmed neon; dusk gets deep
violet-blue with a strong orange horizon band and a low sun disk drawn in
`skyPass` (day/dusk branch, like night's stars). Iterative — expect a few
look passes. Do before #9 so the cycle is worth watching.

**#12 Cherry-blossom trees. (S/M)**
New sakura art (2 variants, layered canopy, new soft-pink material) as a
prop-art variant selected by district: suburbs/residential/parks mostly
sakura, industrial keeps the scraggly ones. Wet-ground reflection is
automatic. Falling-petal particles are a possible later garnish.

**#16 Stall quality & variety. (S/M)**
Stall art becomes a variant list — ramen cart (lanterns, curtain), produce
stall (crates), tech stall (screens) — picked by the prop's hash, weighted
by district (strip: ramen; residential: produce; downtown: tech). Sprite
pass picks art per variant the way ped frames already work.

**#14 Crops in the fields. (S/M)**
Rural lots get crop-row floor striping in `floorSample` (green rows over
soil bands) plus aligned rows of a new corn-stalk prop replacing part of
the random rural trees. Barns/silos already exist to anchor them.

## Phase 4 — The living clock — **DONE 2026-08-19**

**#9 Time & weather as real systems. (DEEP)**
The core rework: `TIME`'s three modes become keyframes on a continuous
clock. A game day ≈ 25 real minutes: dawn 5% / day 42% / dusk 8% / night
45%; fog/sky/glow/lit/ambient interpolate between adjacent keyframes, with
the GL palette (cheap: 64×9 entries) rebuilt on a throttle during
transitions and per-building `litP` re-rolled at phase boundaries (which
#1's window life then animates naturally). Weather becomes a dwell-time
state machine (clear 6–14 min, rain 3–8, storm 1–3) with a continuous
intensity 0–1 that ramps over 30–60 s — rain density, audio, and wet
reflections already scale, they just need the float instead of the enum.
T/X keys and the pause-menu time/weather settings are removed (clock/
weather shown read-only). Touches: palettes both paths, background both
paths, audio targets, HUD, saves (clock + weather state persist).

**#10 Calendar from Jan 12, 2420. (S — after #9)**
`worldClock` seconds → day/date arithmetic from the epoch; status box shows
`JAN 12 2420  21:40`; saved with the player; day count feeds #19 decay and
#21 waiting.

**#21 Bench sitting + waiting. (S/M — after #9)**
Player: probe a bench → sit (camera drops to 1.15, position locked, look
free) with `[SPACE] stand` / `[W] wait` — waiting fades and jumps the clock
to the next phase boundary. Pedestrians: benches get 2 seat slots; a
lingering ped near one snaps to it with a new seated art frame.

## Phase 5 — The body — **DONE 2026-08-19** (full-size view models: guard fists, held pistol w/ muzzle flash, alternating punch arms reaching screen centre, pitch-revealed body from boots to chest, full-scale consume rituals)

**#8 First-person body & held weapons. (DEEP-ish)**
A screen-space overlay-animation framework replacing the inline GUN/FIST
block: named animations = frames (art rows + duration + offset) drawn in
`hudPass`. Layers: arms+weapon bottom-right (idle sway, walk cycle from
`walkPhase`, punch swing 3 frames, gun hold + recoil + muzzle), and legs/
feet bottom-center that appear when pitch looks down past a threshold.
Mostly art authoring; the machinery is modest.

**#11 Consume animations. (S — after #8)**
`VIEW_ANIMS` entries for eat/drink/medkit (cup raised with steam glyphs,
bottle tilt, wrap flash); `useItem` plays one and applies the effect at the
animation's midpoint.

## Phase 6 — Law & disorder — **DONE 2026-08-19**

**#19 Corruption. (DEEP)**
`player.corruption` 0–10, fed by a `crimeEvent()` hook (theft via #4's
steal path, assault/murder via #20, room for more). Decays 1 per two clean
in-game days (needs #10). Consequence tiers: 1–2 cameras track you and NPCs
comment; 3–5 prices +25% and some doors refuse you; 6+ enforcer actors
(armored razor variant on the hostile brain) spawn periodically and hunt.
Paying it down: a fixer NPC on the Red Mile (finally giving that landmark a
job) takes ~40 cr per point. Small HUD flag when nonzero; saved with the
player.

**#20 Pedestrian combat → corruption. (S/M — with #19)**
Peds get lazy-init hp (~10); the sights helper generalizes to actors+peds
(via the ped grid). Hits make that ped flee hard; kills remove + restream
them. Corruption per your spec: attacking 3 distinct peds = +1, ped-sourced
corruption caps at 2.

## Phase 7 — Big structures — **DONE 2026-08-19**

**#13 Full city map. (M+)**
A full-screen mode (mode stack) sampling `tType` at 1/2/4/8 tiles-per-cell
zoom, WASD pan. Landmarks label from the existing list; district labels at
precomputed region centers; **street names must be invented**: E–W avenues
get hash-picked names from a word list, N–S streets get numbers, both
derived from the grid index + seed so the map costs no storage. `M` opens
it (the corner minimap moves to a pause-menu toggle). The naming/labeling
is the bulk of the work.

**#15 True wilderness + long sightlines. (M+)**
Beyond the rural ring: suppress the road lattice except one or two exit
highways, scatter rocks/dead trees/scrub, and ease `viewD` toward ~320
tiles when deep in it. The hard sub-problem is DDA cost at that distance —
solved with a per-block "empty" mask letting rays stride 20 tiles through
nothing (precomputed at gen). Then full-skyline screenshots work at speed.

**#22 Multi-floor interiors. (DEEP)**
The scene machinery makes floors nearly free: a stairs interactable
rebuilds the interior arrays with `srand(seed ^ floor)`, so each floor
regenerates deterministically without storage. Buildings derive a canonical
floor list from their height (e.g. 1, 2, 17, 21, 55 — hash-picked,
ascending), a small picker menu chooses the destination, upper floors draw
from new archetypes (office, apartment corridor, storage), the street door
exists only on floor 1, and interior walls facing outward can carry a
window band showing sky. The work is the new room archetypes and the floor
picker — the swap trick already built carries all of it.

---

## Post-roadmap additions (unplanned, shipped alongside)

- **GitHub Pages deploy** — public repo `nukacolafamine-star/ascii-city`,
  live at https://nukacolafamine-star.github.io/ascii-city/.
- **Mobile touch suite** — floating movement stick with sprint rim, look
  drag, FIRE/ACT/WAIT clusters, MENU/INV/MAP/FLY buttons, tap-through to
  cards/dialogs, dialogs centered on touch.
- **Custom literal ASCII art pipeline** — `parseArtLit` renders authored
  art exactly as typed (the oak from `tree ascii.txt` replaced the default
  green tree); the door for more player-authored art is open.
- **Arms-only first person** — held pistol with recoil and muzzle flash,
  alternating guard fists and punches, consume rituals; torso/legs removed
  by design.
