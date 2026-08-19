# ASCII CITY

A neon-soaked 3D city rendered entirely with coloured ASCII characters, in one
self-contained `index.html`. No build step, no dependencies, no network access —
open the file in a browser.

```bash
start index.html
```

Click the canvas to capture the mouse. `WASD` walks, `V` boards the air
traffic, `G` takes the metro, `H` hides the key list.

---

## What it does

Every frame the engine casts one ray per character **column** through a tile
grid, finds what each ray hits, and turns the hit distance into three separate
visual cues at once. The view is 90 deg wide (about 59 deg vertical) and carries
96 tiles, so a straight avenue stays legible all the way to the fog:

| cue | near | far |
|---|---|---|
| glyph density | `@ % # *` | `- , .` then blank |
| glyph size | full-cell bold | 41% of cell, thin |
| colour | full material colour | pre-mixed toward fog |

Because the size varies, glyphs are pre-baked into **8 atlases** — one per
distance level, each holding every character in every material colour. A frame
is then a flat run of `drawImage` calls with no canvas state changes at all.

## Render pipeline

1. **Background** — a sky → fog → ground gradient, so anything that fades out
   dissolves into the horizon rather than into black.
2. **Sky pass** — sparse star and horizon-glow glyphs above the horizon line.
3. **Floor pass** — each character cell below the horizon is inverse-projected
   back onto the grid, giving asphalt, dashed centre lines, edge lines, zebra
   crossings, paving joints and kerbs in correct perspective.
4. **Wall pass** — a DDA march per column. The first hit fixes the near surface,
   and the march *continues* so a tower behind a low-rise still rises above its
   roofline. Facades are procedural: floor bands, lit/dark windows keyed by a
   per-building hash, shopfronts at street level, a parapet cap, and vertical
   posts at the real building corners.
5. **Sprite pass** — cars, pedestrians and street furniture as billboards, drawn
   far-to-near and depth-tested **per character cell** against the wall/floor
   z-buffer, so they interleave correctly with the world and with each other.
6. **Sign pass** — shop and tower signage, anchored in the world but drawn in
   screen space at one character per cell so the text stays sharp at any range.
7. **Reflection pass** — a surface at height `z` mirrors to row
   `2*horizon + 2*camZ*unitRows - r`, so every emissive cell above the horizon
   is smeared back into the wet tarmac below it, with a per-column ripple.
8. **Rain pass** — slanted `/` streaks falling at per-column speeds.
9. **Blit → bloom → HUD** — one `drawImage` per lit cell, then two bloom taps,
   then a crisp ASCII overlay with a live minimap.

## Zones and districts

The map is **1000 tiles a side — about 2 km × 2 km, or 4 km²** — and it is laid
out in rings, so the character of the place changes as you travel out rather
than at random:

| ring | what it is |
|---|---|
| **core** | tower downtown and the strip |
| **urban** | residential and industrial, some towers |
| **suburban** | small houses on large plots, gardens, parks |
| **farmland** | open fields, scattered barns, dirt tracks |
| **wilderness** | past the rural ring the lattice returns to earth — two highways leave the city and degrade to dirt tracks, rocks and scrub take over, and the view distance stretches past 300 tiles for full-skyline shots |

Within its ring, each block draws a district from that ring's menu through a
coarse patch field, so like districts clump instead of speckling. Six district
rulesets modulate parameters that already existed — palette subset, height
curve, subdivision depth, prop mix, lit ratio, signage density, fog tint — plus
two that the loose rings needed: `fill` (how often a lot is built on at all)
and `inset` (how far the footprint shrinks inside its plot, which is what turns
a suburban lot into a house with a garden).

The result is a real gradient. Median building height runs about 73 units
downtown, 31 on the strip, 19 residential, 14 industrial, 7 suburban and 5 on
the farms, with open ground taking over entirely past the rural ring.

## World generation
## World generation

The lattice falls out of tile residues inside a 20-tile block period:
residues 0–5 are roadway (one 3-tile lane each way), 6–7 and 18–19 are the
two-tile sidewalk ring, 8–17 are buildable interior. A road residue crossed with
a sidewalk residue *is* a crosswalk — no special-casing needed, and widening the
road widened the crossings for free. Block interiors are subdivided by BSP into footprints, some carved back into
alleys, some left as parks, with the district setting how hard the block splits.

**Footprints are not rectangles.** Roughly half get a shape modifier — an L cut
from one corner, an open courtyard notched into one edge, or chamfered corners —
stamped through a per-tile mask.

**Heights are per tile, not per building.** `tH` was always a per-tile array and
the wall pass always read it per tile, so stepping the height down toward the
footprint edge produces real setback towers and ziggurats with no renderer
change at all. Corner posts are found by comparing each tile against its
neighbour, so any footprint shape and every setback step gets its silhouette
picked out.

## The look

Buildings are dark and chromatic — fourteen shell colours, from near-black blue
through rust and slate violet — so the light on them carries the frame. Each
building then gets its own glow identity, drawn from eight neons:

- a **dominant window colour** plus a minority **accent**, so a tower reads as
  "the cyan one" or "the magenta one" from blocks away
- an independent **signage colour** for the shopfront band at street level
- a **neon crown** on the parapet (about 44% of buildings)
- an optional **vertical strip** running the full height (about 36%)

Windows are lit per-window from a hash against the building's own lit ratio,
which itself varies widely building to building — so unlit windows read as dark
holes in a lit tower rather than a uniform grid. And every window lives its own
life: each has a personal period of 25–90 seconds and re-rolls its state when
it lapses, so rooms go dark and wake out of sync across the whole city. A tube
about to go out flickers away its last two seconds first, and now and then a
single bulb on a facade fails for a moment and sputters before steadying —
one window at a time, never a fixed population of blinkers.

The ground carries the rest: rain-slick tarmac catches sparse neon glints,
kerbs are picked out along every crossing, and street lamps burn their own
colour rather than a uniform sodium yellow.

The street tree is **hand-drawn literal ASCII art** — a broad oak authored in
a plain text file (`tree ascii.txt`), rendered with its exact characters:
`#` foliage, branch strokes threading the canopy, a braced trunk. The
`parseArtLit` loop makes this repeatable for any prop: draw art in a text
file, paste the lines in, give each character class a colour; far distance
levels fall back to density shading so literal art fades into the fog like
everything else. Residential streets and the suburbs favour **cherry
blossom** — pink sakura canopies over the walkways — and parks mix both. Street stalls come in three flavours weighted
by district: ramen carts with hanging lanterns on the strip, produce stands
in the neighbourhoods, tech benches stacked with screens downtown. Out past
the suburbs the rural lots are **worked land**: crop rows with soil furrows
between, corn stalks standing in files.

**Street furniture is placed by rule, not scattered.** Trees are rare in the
city and stand down the centre line of the promenade, spaced along it. A street
tree is planted last, after every other fitting exists, and only where it has
room: nothing within three tiles to either side of it and no facade within two.
About 40% of otherwise-valid spots are turned down for having a neighbour, so a
tree on the walkway always stands clear rather than crowded up against a bench
or a lamp. Nothing is ever planted within a tile of a facade - and because park trees are planted while the blocks
are still being built, a final pass prunes any that a later building or
landmark ended up on top of. Parks are planted lightly rather than packed.
Traffic signals are gone entirely, since nothing drives; the junctions they
stood on now carry **surveillance cameras**, dense in the core and thinning
outward, which is both better dressing and a better fit for the place. The sky is light-polluted — a thick
magenta haze at the horizon and only a handful of stars.

### Signage

Buildings carry **readable text**. A sign is a **flat panel fixed in the wall
plane** - not a billboard. Its letters are drawn through the same 3×5 block
font the dome uses, baked with a border and a dark backing into a small bitmap,
then bolted to the facade at a true size in metres.

It is drawn the way a wall is drawn: each column's ray is intersected with the
sign's plane and the artwork is read across the hit. Perspective then does the
rest for free - the panel grows as you approach, foreshortens into a
parallelogram as you slide off its axis, and never turns to follow you. Head
on it measures 26 cells across; from 66 degrees off axis, 12.

Each sign is also clamped to the **exposed run of wall it sits on** - the
stretch where the same building keeps that face open - and centred in it, so
it can never overhang a corner or push through the roofline.

The earlier version drew signs in screen space at one character per cell. That
kept the text crisp at any range, but it inverted the perspective — a sign
forty tiles away covered as much of the view as one right in front of you, and
walking toward it made it *shrink*. A 35-pixel sign now projects 119 cells wide
from four tiles and 12 cells wide from forty. Tall buildings also get vertical signs
running down the wall. Some scroll, some blink on a failing transformer. The
words come from the district: `ZAIBATSU` and `HOLDINGS` downtown, `RAMEN` and
`PACHINKO` on the strip, `LAUNDRY` and `PHARMACY` in the suburbs, `DOCK 7` and
`HAZMAT` in the industrial belt.

This is the one thing the medium gives away for free — the frame is already made
of characters, so text costs nothing extra to draw.

### Weather and light

**Time runs itself now.** The clock is continuous — one game day is 24 real
minutes — and the calendar starts **JAN 12 2420** and counts on from there,
shown with the time and weather at the top of the status box. The three
lighting looks became keyframes: dawn passes through the dusk palette on its
way to day (05:00–06:30), evening runs it back (18:30–20:00), and the
palettes chase the blend as it moves, so blue hour actually happens. The sun
rides an arc, low at 06:30 and high at noon. Sitting on a **bench**
(`SPACE`) lets you wait (`W`) — the clock jumps to the next change of light,
and the weather may have other plans by then. Pedestrians take the benches
too, sometimes.

**Weather drifts on its own**: clear, rain, storm and fog dwell for minutes
at a time and hand over to each other — fog favours the small hours. Rain
falls as slanted `/` streaks at per-column speeds; storms add lightning
that flashes the whole frame. Fog is
quiet: each bank rolls in with its own thickness (light, rolling or heavy),
and above all it pulls the **view distance** in — heavy fog roughly halves
how far the rays carry, on top of tinting what remains toward haze and
leaving the streets damp enough to shimmer. A clear day carries no distance
fog at all, and the far skyline stays **dense and solid** rather than
dissolving into dots — the dissolve suits dark and hazy backdrops, where it
reads as atmosphere instead of blur. Night and dusk keep their neon haze
regardless.

Wet ground reflects, and **water always does**, rain or not. Two kinds of
thing are mirrored: anything that emits light — neon window, sign, headlight,
lamp — and any solid object, meaning people, trees, food stalls, cameras,
benches and passing air traffic. Light mirrors brighter than a silhouette does.
Bulk wall and floor are deliberately left out, or the water fills with dull
concrete and the streaks stop reading.

That distinction is a per-cell mark laid down as each pass draws, not a test on
colour. Marking by colour was the first attempt and it only ever caught neon.

The sweep covers the **whole column**, not just the sky half. A person is 1.76
units tall against a 1.62 eye height, so almost all of them sits below the
horizon: mirroring only what is above it would carry towers and neon but never
anyone standing in front of you.

Reflections are not limited to what is on screen. Screen-space mirroring alone
loses anything the moment it leaves the top of the frame, so **every pass that
draws something tall mirrors its own off-screen rows** - walls, signs and
sprites alike. A sign mounted above a shopfront is gone from view by the time
you are looking at your feet, but its reflection is not; the same is true of a
tree or a lamp standard. The wall pass does it as it marches:
it already knows the facade there, and the band of off-screen rows that can
land in visible water is small and exactly computable. Looking steeply down at
the river, the horizon is off the top of the screen and screen-space mirroring
has nothing left to read — yet the water still carries over a thousand cells of
reflected building.

The river runs as **flowing crests parallel to its banks**. Two perpendicular
sine waves cross into a field of blobs, so the coordinate that varies quickly
is the one measured *across* the channel, meandering slowly along it.

`B` toggles bloom: two taps, each a downscale cubed to crush everything that
is not neon, added back with `lighter`. The upscale is the blur. It costs
0.07 ms and does more for the look than anything else in the renderer.

`T` cycles neon night (the default), dusk, and day. Dusk is a burning
orange horizon with a low sun kissing the rooftops; day is a real blue sky
with a high white sun, clearer air (the distance fog thins by half), and the
bloom stood down — daylight drowns the neon anyway. The sun hangs at a fixed
world azimuth, so it is somewhere, not everywhere. The horizon glow is drawn
as sky cells, not painted into the backdrop, so buildings occlude it — the
skyline stands against the glow instead of being shone through.

## Landmarks

Stamped over the lattice after it is generated. A stamp may overwrite tiles,
register its own building record so facades still work, and place its own props
and signage. Each stamp **reserves the blocks it claims**, so two landmarks can
never be built on top of each other. The status box names the nearest one and
its bearing, so nothing in the city is findable only by luck.

- **The river** cuts the map in two, meandering, teal-green and reflective, and
  sits **three units below street level**. The floor pass casts a second, lower
  plane through the hole in the street plane, so you look down into a channel
  with its far wall rising out of the water. It severs the walk graph, which is
  the point.
- **Central Bridge** carries a whole boulevard across — roadway and both
  sidewalks — with railings, lamps and a **toll plaza** on the north approach.
- **The Old Crossing**, narrower and unlit, three blocks upriver.
- **The Sphere** — a stepped hemisphere whose entire skin is one display.
  Tile heights follow `h = H·√(1 − (r/R)²)`, so it is a voxel dome; every wall
  cell on it maps to a point on that sphere — longitude around, height for
  latitude — and samples the current frame. The image wraps twice, so a whole
  face reads from any approach. It cycles **22 frames** — eleven faces (grin,
  wink, heart, surprise, shades, sad, angry, skull, cat, alien, laughing)
  alternating with eleven ads — the ads drawn
  through a 3×5 pixel font so they arrive as blocks of light rather than
  characters (one frame cell covers several screen cells, and a literal glyph
  would simply be stamped over and over).
- **Parks and playgrounds** — seven of the former, ten of the latter, scattered
  through the urban and suburban rings.
- **Wind farms, grain silos, radio masts and reservoirs** out in the farmland,
  plus five crossings of the river rather than two.
- **A suburban playground** with climbing frames and benches.
- **The Data Centre** — four blocks of windowless concrete, red-striped and
  ringed with cameras that blink at you.
- **The Red Mile** — one street given over to the trade, its buildings
  re-lit in magenta and pink with their own vocabulary.
- **The fields** — a ring of open ground outside the city proper. Step into it
  and the draw distance eases out to 178 tiles over a few seconds, so the whole
  skyline resolves at once.
- **Eight metro entrances**, spread across the whole map, each sited where
  there is room to stand. Press `G` at one to travel to the next: the arrival spirals outward
  for a spot you can actually occupy, then turns you to face a walkable
  direction.

## Simulation

**Air traffic.** Cars fly and are never physical — they cannot be hit and they
hit nothing. Each holds a cruising band, steers toward a wandering target,
separates from its neighbours inside its own altitude slab, and climbs over
whatever is ahead, with a lookahead that scales with speed and a hard floor
clamp applied after the step. Over a 40-second run they stay clear of the
geometry with at least 2.5 units to spare while climbing past 110 units to
clear the downtown towers. `V` boards one for the view.

Retiring ground traffic deleted the lane graph, car-following, kerb negotiation
and signal obedience — the single most fragile system in the engine, and the
source of nearly every bug it ever had. The masts still cycle as street
furniture.

**The roadway is now a boulevard.** Not a road that happens to be walkable —
the carriageway is *paved*. Same slabs as the sidewalk, the same walking cost in
the navigation grid, no lane paint and no kerb; all that marks the old centre
line is an inlaid strip running down the promenade spine. Crowds spread across
the full ten tiles instead of filing along the edges.

**Pedestrians** A* over sidewalks, boulevards, park paths, parks and bridge
decks. Roughly a third of trips target a **street stall**, where people linger
for ten or twenty seconds before moving on, so crowds gather instead of pacing.
Crowd density is set per district — packed downtown and on the Strip, all but
deserted in the industrial belt. Repathing is budgeted to a few per frame.

**Actors.** A small persistent layer above the crowd: named characters that
are never streamed away, stand solid in the world, and stop to face you when
you come close. Every frame an interaction ray asks which actor the player is
looking at — within reach, inside a narrow cone, with clear line of sight —
and the answer drives a `[SPACE]` prompt and a typewriter dialog box. The
current cast is a demo trio spawned near the start (a watcher, a wandering
drifter, a stall cook); the layer itself is the foundation quest NPCs,
shopkeepers and enemies will build on, and `ACTORDEF` + `spawnActor` are its
whole authoring API.

**Collision** — the camera slides along walls, street furniture, actors and
the water's edge. Nothing else is solid.

## Interiors

Buildings have insides. Most street-fronting buildings carry one door, cut
into a wall that faces a sidewalk and named after the sign the facade already
carries. The entrance is drawn on the facade — dark wood panels in a
doorframe lit with the building's own signage neon, amber handle at waist
height — so it can be spotted from down the street; walk up, and `SPACE`
takes you through. Rooms are generated on
entry, seeded by the building, so a shop is the same shop every visit and
nothing is ever stored.

The renderer never learns interiors exist: the tile arrays are swapped by
reference for a second interior set, the camera teleports into a room stamped
near the array origin, and every pass — DDA walls, floor projection, sprites,
collision — keeps working untouched. The one addition is a **ceiling pass**,
the mirror of the floor pass: rows above the horizon inverse-project onto the
ceiling plane, giving panel joints and a lattice of tube lights the bloom
picks up. Sky, signage, reflections and rain switch off indoors; the street
ambience goes muffled without changing district; the crowd simulation holds
its breath until you step back out.

Rooms take their character from the district: downtown doors open on
**lobbies**, the strip and residential streets on **shops** with a counter
and shelves, the industrial belt on **depots** stacked with crates, and the
suburbs on **homes** whose residents did not invite you. Most rooms keep a
keeper — concierge, shopkeep, foreman, resident — standing ready to be talked
to, and the way out is drawn as a real door: dark panels, bright frame,
amber handles.

**Buildings carry canonical floors.** A tower announces itself as floors
1, 22, 33, 38 — hash-picked from its height — and the stairwell in the back
corner opens a picker. Each floor regenerates from the building's seed the
moment you arrive: **offices** in partitioned rows, **apartment corridors**
whose tenants warn you off 4C, **storage floors** stacked with crates and
worth scavenging. The street door exists only on floor 1; everything above
belongs to the stairs.

**The city map** (`M`) charts all four square kilometres: pan with `WASD`
or a drag, zoom `Q`/`E` from street grain to the whole grid. Avenues carry
seed-hashed names — KANDA AVE, VOLT AVE — the numbered streets cross them,
landmarks label themselves up close and districts from afar, and your
arrow and the quest marker ride on top.

## Quests and conversations

Conversations are **trees**: a map of nodes, each with typed-out text and
choices. A choice can hide itself behind a condition (you cannot offer
noodles you are not carrying), fire effects (items, credits, quest stages),
and jump anywhere in the tree — and a character's opening line is picked from
quest state, so people greet you differently as their thread moves along.
Node text can be live (`the count stands at 2 of 3`). Plain characters still
speak in simple pages; shopkeeps open **THE COUNTER**, a proper buy/sell
screen — their stock priced on one side, your sellable goods at 40% of value
on the other — which closes the economy loop: scavenge or earn, then spend.

Quests are a table plus a small interpreter: named stages, each with a log
line, an optional compass target and an optional proximity trigger polled
twice a second. Progress lives on the player, so it saves and loads with
everything else. The status box tracks the active objective with distance
and bearing, the minimap marks it `!`, and TAB lists every thread and where
it stands.

The opening cast carries three threads: the drifter wants a warm meal, the
watcher pays for scrap out of the industrial belt (and keeps buying after —
the buyer the scrap always hinted at), and the stall cook will pay to hear
what THE SPHERE shows you.

## Combat

The industrial belt has teeth: **razors** prowl its streets — red-shirted,
fast, and uninterested in conversation. They stand idle until they see you,
rush, and slash on a cooldown; the screen flushes red when they connect.
Fourteen of them share the belt with the scrap the watcher wants, which is
not a coincidence. He also sells the answer: a **zip pistol** (90 cr) and
rounds (20 for 8), and razors drop ammo or scrap when they fall. Until then —
or when the magazine runs dry — you swing **bare knuckles**: half a pistol
round's damage, arm's reach, a wider arc, and a proper swing cooldown.

Shots are hitscan along the view ray, but height-aware: masonry stops a
bullet, a 1.05 m shop counter does not — cover you can shoot over. The
reticle turns to a red `x` with a nameplate when a hostile is in your sights,
gunfire scatters the crowd and carries to every razor in earshot, and impacts
spark. Dying costs half your credits and a walk back from the nearest metro
platform — or load a save, or start over.

**The law keeps a ledger.** Pedestrians can be fought — a bullet does not
care who stands in front of it — but the city notices: assaulting three
different people or killing one raises your **corruption** (ped-sourced
corruption caps at 2), stealing priced goods raises it too, and the score
sits red in the status bar. At 1–2 the cameras swivel to follow you. At 3–5
shops charge corpo rates and a third of the city's doors flash red and
refuse you. At 6+ **enforcers** come looking — armoured, fast, and already
carrying your signature. Two clean days fade a point; **the fixer** on the
red mile deletes one for forty credits, no questions. Razors and enforcers
are fair game — putting them down costs nothing but ammunition.

## Inventory, stats and saves

The player is data: health, credits, three stats (`VIT` sets max health,
`AGI` quickens the run, `TECH` waits for its moment), and a pocket inventory.
`TAB` opens it, organised into five tabs — consumables, weapons, clothing,
accessories, misc — switched with `A`/`D`; the HUD carries a live health
bar. Street bins answer the prompt too: mark items, confirm exactly what is
listed, and the stacks are gone for good.

**Pickups** hover and bob where people gather — around street stalls, on shop
counters, in homes and depots — and answer the same `[SPACE]` prompt as
everything else. Shop displays are priced: the prompt reads BUY and charges
you (with the shopkeep watching if you cannot pay); homes, depots and street
finds are free scavenging. Items are a table plus one interpreter (`ITEMS` in the
source): noodles and cola heal, a medkit heals fully, scrap waits for a
buyer. Every placement is deterministic from the world seed.

**Saves are tiny because the city is deterministic**: seed + camera + player
+ `worldDelta`, the running diff of what you have taken from the generated
world. Loading rebuilds the identical city from the seed and replays the
diff, so a scavenged shelf stays scavenged and everything untouched comes
back exactly as generated. Save and load live in the ESC menu with **three
slots**, each showing its timestamp and character, stored in the browser;
saving indoors stores the street outside the door, since the room itself
regenerates from its seed.

## Sound

Audio is loaded from an optional `audio/` folder of free-use mp3/wav files —
see [audio/AUDIO.md](audio/AUDIO.md) for the slot list and sourcing notes.
Every slot is optional and a missing file is a silent no-op, so the game runs
fine without the folder; the wavs currently there are synthetic placeholders
to be replaced with curated sounds under the same names.

What plays is driven by the game state: an ambient bed per district
(crossfaded as you cross a border), a music track per time of day, rain and
thunder from the weather system, wind while riding the air traffic, footsteps
keyed to the walk cycle, and menu blips. Rain, thunder and wind sit on their
own weather bus with its own volume slider. Music, ambience and weather duck
to 30% while the world is paused; effects stay crisp.

Two delivery tiers, picked automatically: served over http(s) the engine uses
WebAudio (per-bus mixing, stereo panning, `sfxAt(name, x, y)` positional
one-shots); opened via `file://` the browser blocks `fetch`, so it falls back
to plain `<audio>` elements — everything still plays, just without panning.
Volumes live in the ESC menu and persist. To hear the WebAudio tier locally,
`node serve.mjs` serves the folder at http://localhost:8123.

## Keys

| | |
|---|---|
| `WASD` / arrows | move |
| mouse | look (click to capture) |
| `SPACE` | talk / take / enter / sit — whatever the prompt names |
| `W` (seated) | wait until the light changes |
| `LMB` / `CTRL` | attack — bare knuckles, or the zip pistol once you own one |
| `TAB` | inventory and stats |
| `M` | the full city map — pan, zoom, street names |
| `ESC` | pause menu — settings, volumes, save / load, new city |
| `SHIFT` | run |
| `Q` `E` | turn · `R` `F` look up/down |
| `V` | board the air traffic |
| `G` | metro (at an entrance) |
| `M` `H` | minimap · key list |
| `B` | bloom on / off |
| `N` | new city |
| `[` `]` | character grid resolution (takes manual control) |
| `P` | pause |

## Performance

Every geometry pass fills the same character buffers it always did. What
changed is how those cells reach the screen.

The old path issued **one `drawImage` per lit cell**. At 2560×1440 with the
finest grid that is 39,516 calls a frame at ~2 µs each — 79 ms of a 70 ms
frame, or 92% of all frame time, for 14 fps. Four approaches were measured
against that exact frame:

| approach | time | speedup |
|---|---|---|
| per-cell `drawImage` | 74.7 ms | 1× |
| run-batched `fillText` (8,637 runs) | 56.1 ms | 1.3× |
| CPU compose + `putImageData` | 17.9 ms | 4.2× |
| **WebGL2 instanced quads** | **0.65 ms** | **115×** |

Only the last one clears the bar, so the presentation layer is now a single
instanced draw for the entire grid. The glyph atlas holds **shapes only** —
white on transparent, one row per distance level plus a row of full ASCII for
the HUD — and each cell's final colour rides along as a per-instance byte quad.
Nothing has to be re-baked when the time of day changes; only a small colour
table is rebuilt. Bloom became three framebuffer passes, the background a
gradient shader, and the HUD another instanced batch.

| resolution | cells | before | after |
|---|---|---|---|
| 1600×900 default | 6,525 | — | 1.9 ms · **515 fps** |
| 1600×900 finest | 17,100 | — | 3.3 ms · **307 fps** |
| 2560×1440 finest | 43,800 | 70 ms · 14 fps | 6.8 ms · **148 fps** |
| 3840×2160 finest | 98,640 | — | 13.8 ms · **73 fps** |

Simulation and geometry — 430 pedestrians, 54 flying cars, the rays, floor
casting, signage, reflections and rain — total about **5 ms** at 2560×1440,
and the whole presentation layer costs **2 ms**. Geometry is the ceiling, not
drawing.

Across 4 km² two things had to change to keep that true. **Agents are streamed**:
the population is kept around the camera rather than spread across a million
tiles, so density stays where you can see it and cost stays flat. And the
**spatial hash clears in O(agents)** — it has 15,625 buckets at this size, and
wiping all of them twice a frame cost 4.2 ms on its own, so filled buckets are
tracked as they are written and only those are reset. Props are static and
number in the tens of thousands, so the sprite pass pulls only the buckets the
view can reach: about 2,300 of 80,000 in a typical frame.

A world of this size generates in about half a second and costs roughly 45 MB.

**Canvas2D is kept as a full fallback.** If `webgl2` is unavailable the engine
transparently uses the original per-cell path with its baked colour atlases;
both renderers were checked against the same frame and agree within a few
percent. The startup cell budget and the adaptive step-down still exist for
that path, but the GPU path raises the budget out of the way, so a 4K display
gets a real grid instead of a throttled one.

## Tuning

Landmarks live in `stampLandmarks()` and are mostly data — `lmBuilding`,
`lmFill` and `lmSign` are the whole authoring API. Everything else worth
changing is in the `CFG` object at the top: map size, block period, road width
`RW`, sidewalk width `SW`, field of view, draw distance,
agent counts, and the character-cell size ladder. The palette lives just below
it — `BLDC` is the building shell set, `NEONC` the neon set used for windows,
signage, crowns, lamps and reflections. `RAMP` is the density ordering of the glyph set —
reorder it and the whole city re-shades.
