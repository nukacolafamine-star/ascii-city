# ASCII CITY — Expansion II plan (2026-08-21)

Fourteen features, ordered so that each phase builds on the one before it.
Strike items through as they land. The rule from last time stands: nothing
ships until it is measured in the live page.

## Phase A — foundations and quick wins
Small, unblocking, or restructuring work that later phases hook into.

- [x] **A1. Ped collision with solid props.** Pedestrians currently walk
  through benches, stalls, everything. Route `propBlocked` (with the stall
  box test) into ped steering — cheap check against propGrid, and bake
  solid-prop tiles out of `walkG` so A* routes around rather than into
  furniture. Actors (vendors are pinned) unaffected.
- [x] **A2. Quest markers on both maps.** The tracked quest's `target()`
  drawn as a pulsing glyph on the minimap edge (clamped, arrow at edge when
  off-screen) and on the city map via `sx()/plot()` (respect chirality —
  never raw +x math). Selected-quest plumbing already exists in
  `player.track`.
- [x] **A3. HUD / pause-menu restructure.** Remove the KEYS panel and the
  ASCII CITY box from the HUD. Date/time/district/coords go in a block
  under the minimap. New bottom-centre element: HP + ammo. CR shown in
  inventory only. Pause menu gains sub-menus with green separator lines:
  CONTROLS (the old keys text), SETTINGS (bloom, char grid, minimap,
  touch), SOUNDS (all volume sliders), SAVES (save/load/new city), DEBUG
  (nearest landmark, substances, on-foot/skate flag, clock, weather).
- [x] **A4. Item voxel models — one per item, no sharing.** Every single
  ITEMS entry gets its own authored voxel volume (~40 of them): the cup
  noodles is a cup with a lid and steam, the cola a can, the pistol a
  pistol, each garment its own folded shape, each tool its own silhouette.
  Replaces the flat PK_ITEM card on the ground and in shop displays.
  Reuses the stallVolume authored-volume path. NOT a quick win — this is
  a full art pass and each model gets verified in-engine.

## Phase B — world fabric
Content infrastructure that the venues and the main quest consume.

- [ ] **B1. Interior furniture voxel set.** ≥1 unique piece per shop trade,
  10 shared corpo pieces (desks, terminals, planters, water coolers…),
  5 player-home pieces, 6 dungeon pieces. Authored volumes like the cart;
  placed by `buildInterior` per archetype so each trade reads distinct.
- [ ] **B2. Pedestrian expansion.** Seeded first+last name pools combined
  per ped; every ped gets a home (an apartment/house door) and a schedule:
  leave home → path to a destination (work/school/dome = despawn there;
  store/casino/landmark = linger then walk home). Interact (SPACE) for
  dialogue: several hundred lines keyed to where they are, where they're
  going, what district, time of day, weather, and (rare) what the player
  has done (corruption, murders, quest flags). Continuity: name+home from
  seed so a save keeps its people.
- [ ] **B3. Weapon expansion.** +5 basic guns (revolver, SMG, shotgun,
  rifle, hold-out), +3 special guns (unique visual effects — e.g. railgun
  glyph-tracer, arc gun chaining sparks, nailer that pins), +1 basic melee
  (knife), +2 special melee (vibro-katana with trail smear, shock maul
  with screen-shake burst). Each with viewmodel art, swing/fire anims,
  stats in a WEAPONS table. Acquisition spread: shops, main quest, side
  quests, and hidden ground spawns tucked into alleys/rooftops/dungeons.

## Phase C — venues and systems
Each one independent; order here is by dependency weight.

- [ ] **C1. Gambling interiors + minigames.** Casino/arcade interiors get
  themed variants; each spawns a playable minigame mode: blackjack, slots,
  plinko, high-low dice, wheel. Minigames are HUD modes on the mode stack
  (like the map), bet from credits, house edge tuned.
- [ ] **C2. Brothel / xxx interiors.** Themed variants for D_RED interiors;
  paid encounters that fade to black with corny smutty dialogue beats
  (text only, "WHOA WHOA" tier, nothing explicit on screen).
- [ ] **C3. Multi-floor dungeons.** Reuse `bldFloors`/`gotoFloor`: flagged
  buildings become dungeons — hostile floors, tool puzzles (saw cuts a
  grate, camjack opens a door, jammer kills a camera lock), locked
  progression, unique enemies, loot caches with special weapons. Some
  story-critical, some optional gear tests.
- [ ] **C4. Corruption / enforcement escalation.** Crimes accrue; corrupt
  quests stack. Tier 2: occasional lone enforcers. Tier 4: swat visits the
  player home every few days, spotlight helicopter sometimes overhead.
  Tier 6: constant heli pressure, swat drops, coordinated parties, harder
  escapes. C key = hide: stand still 6s, unhit and unseen by cameras →
  trail lost. Heli is a moving light cone + audio + minimap ping.
- [ ] **C5. Player homes.** Basic industrial apartment (buyable, grind-
  affordable), mid-tier suburb house (granted ~60% through main quest),
  downtown penthouse (post-game reward, betray-ending only, after the
  5-quest corpo-friend line). Homes: bed (sleep/save), stash, wardrobe;
  furnished from the B1 home set. Swat-visit hook for C4.
- [ ] **C6. Car dealership + flying car questline.** New landmarks: the
  dealership and the legal parking lot. 5 quests: earn the shady dealer's
  trust → errands → steal back the gang-stolen luxury car (1.5× speed,
  quest-only) → registration → keys. Reward car: flyable (V near it),
  parks on streets, persists in save.

## Phase D — the main quest
~30 quests in 4 acts. Bleakness, corporate rot, hopelessness. Uses
everything above: anarchist tools, weapon tiers, dungeons, homes, heli/
enforcer pressure.

- Act 1 (q1–q8): the watcher introduces the anarchist cell. Establishing
  jobs: tag, cut cameras, courier runs. Climax: **skateboard chase** (timed
  escape route, trick-boost mechanics, pursuit).
- Act 2 (q9–q16): deeper sabotage; meet ROOK the cell leader, and VESPER —
  the softer one, the recurring friend. Mid-quest the suburb house lands.
  Climax: **first enforcer infiltration** — camera exposure spawns waves;
  stealth-punishing.
- Act 3 (q17–q24): the plan takes shape (shut the city's power down; the
  people already live in rolling blackouts, the corpos never do). VESPER
  digs into what the grid actually feeds; grows uneasy. q24: VESPER tells
  you they found something dangerous, that ROOK already knows — and is
  killed mid-sentence by an unknown assailant. Emotional beat, no answers.
- Act 4 (q25–q30): the run on the power room, floor by floor (tower
  dungeon, act-gated tools/weapons all required). Climax: **the fight for
  the power room**, then the choice —
  - **CUT THE POWER:** the corpos lose. So does everything. The "power" was
    running the digital universe itself: the narrative physically goes
    dark — render decays, palette dies, input goes, save is marked
    terminal. Roll quiet credits into black.
  - **LEAVE IT ON (betray):** play continues. The cell becomes a hostile
    faction (spawns, ambushes, tagged territory), the corpo-friend line
    (C5 penthouse) opens, post-game world state.
- Unique high-floor locations throughout (friendly safehouse floors,
  hostile corpo floors) via the interior archetype system.

## Order of work
A1 → A2 → A3 → A4 → B1 → B2 → B3 → C1 → C2 → C3 → C4 → C5 → C6 → D.
Main quest last because every system it leans on must exist first.
