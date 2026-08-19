# ASCII CITY — audio slots

The engine looks for the files below in this folder. Every slot is optional —
a missing file is silently skipped — and each slot tries **`name.mp3` first,
then `name.wav`**, so dropping a curated mp3 next to a placeholder wav
replaces it without deleting anything.

> **The `.wav` files currently here are synthetic placeholders**, generated so
> the pipeline is testable. Replace them freely with curated free-use audio;
> only the base filename matters.

Volumes (master / music / ambience / weather / effects) live in the ESC pause
menu and persist between sessions. The weather bus carries `rain_loop`,
`thunder` and `wind_loop`; the district beds sit on ambience.

## Loops

Loops crossfade — a district border or weather change is a fade, not a cut —
so files should loop cleanly (trim silence from both ends; a seamless loop
edit is ideal).

| file | plays when | suggested feel |
|---|---|---|
| `music_night` | time of day: night | dark synthwave, slow, 1–3 min |
| `music_dusk` | time of day: dusk | warmer, mellow, 1–3 min |
| `music_day` | time of day: day | bright, sparse, 1–3 min |
| `amb_downtown` | standing in DOWNTOWN | deep city hum, distant traffic, HVAC |
| `amb_strip` | THE STRIP | crowd walla, arcade bleeps, music bleed |
| `amb_residential` | RESIDENTIAL | quieter streets, occasional voices |
| `amb_industrial` | INDUSTRIAL | machinery, fans, metal clanks |
| `amb_suburbs` | SUBURBS | wind, dogs far off, sparse traffic |
| `amb_farmland` | FARMLAND | night insects, open-field wind |
| `rain_loop` | weather: rain or storm | steady rain on pavement |
| `wind_loop` | riding the air traffic (`V`) | wind rush / flight tone |

## One-shots

| file | fires when | suggested feel |
|---|---|---|
| `thunder` | lightning flash during a storm | long rumble, 2–5 s (pitch is varied per strike) |
| `footstep` | every footfall walking or running | one soft step on concrete (pitch is jittered) |
| `metro` | metro travel; also boarding air traffic (sped up) | whoosh / transit swell, ~1–2 s |
| `door` | entering or leaving a building | latch click + door thud, ~0.5 s |
| `shot` | firing the zip pistol | sharp crack, ~0.2 s (pitch varied per shot) |
| `hit` | a bullet landing | dull thump, ~0.1 s |
| `hurt` | the player taking damage | low descending tone, ~0.3 s |
| `ui_move` | menu cursor moves / value adjusts | short tick or blip |
| `ui_select` | menu item activated | affirmative blip |
| `ui_back` | menu closed / backed out | downward blip |

## Sourcing free-use audio

Good places to look, with their usual licenses:

- **freesound.org** — filter by license; prefer **CC0**. CC-BY requires credit.
- **pixabay.com/sound-effects** and **/music** — Pixabay license, no attribution required.
- **kenney.nl/assets** — UI/game sound packs, CC0.
- **opengameart.org** — mixed licenses; check each entry.

MP3 keeps music small; WAV is fine for short effects. Mono is fine for
everything except music — positional panning is applied by the engine.

## Credits

Record what you use here, so attribution ships with the project:

| file | source (URL) | author | license |
|---|---|---|---|
| *(placeholders)* | generated locally | — | — |

## Technical notes

- Served over **http(s)** the engine uses WebAudio: per-bus mixing, stereo
  panning, sample-accurate one-shots.
- Opened via **file://** the browser blocks `fetch`, so the engine falls back
  to `<audio>` elements: everything still plays, with volume attenuation but
  no stereo panning.
- The slot list lives in the `AUD` table in `index.html` (section 13c).
  Adding a slot there plus a file here is the whole authoring loop; play it
  from code with `sfx('name')` or positionally with `sfxAt('name', x, y)`.
- The console may show a 404 for `name.mp3` when a slot is filled by
  `name.wav` — that is the extension probe finding the file, not an error.
- To get the WebAudio tier locally, serve the folder over http — the repo
  ships an optional dev server: `node serve.mjs` then open
  http://localhost:8123.
