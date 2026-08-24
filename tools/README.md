# voxel model pipeline

Drop an FBX in `voxel models/`, run the importer, paste the one line it
prints into `index.html`.

```
node tools/voxel-import.mjs "voxel models/Fire Hydrant.fbx" --name hydr --height 28 --roles B
```

```
node tools/voxel-import.mjs "voxel models/Market Stand.fbx" --name stall --roles M,S,M --axis "z,y,-x" --height 32 --lit "S:X"
```

It prints a report, an elevation preview, and the `voxArt(...)` entry for the
`ART` table.

```
node tools/voxel-import.mjs "voxel models/Streetlight.fbx" --name lamp --tex "M,e3b253:X" --lit "M:X@0-2"
```

| option     | what it does |
|------------|--------------|
| `--name`   | key for the `ART` table |
| `--height` | height in voxels after resampling; omit to keep the source lattice |
| `--roles`  | a role letter per **material slot**, in slot order (`M,S,M`) |
| `--tex`    | roles from **atlas colour** instead: `"M,e3b253:X"` — the bare letter is the fallback, each `hex:ROLE` claims the voxels nearest that colour |
| `--textol` | how close a voxel's colour must be to claim a `--tex` target (default 90) |
| `--axis`   | `"<across>,<up>,<depth>"`, each `x`/`y`/`z` with an optional minus |
| `--lit`    | `"S:X"` — the underside of role S becomes role X, a light strip. `"M:X@0-2"` confines it to those rows, which is how you light the head of a lamp without lighting the foot of its post |
| `--mark`   | `"X@0-2,0-1"` — role X over that span of the width and those rows. For the part that is neither a material nor an underside: the flock camera's bright slot turns out to be a highlight down the whole bracket, so its lens is marked by hand at the tip of the housing. Repeatable |

Two models in the set carry their parts as material slots; the other two carry
them in a texture. `--roles` and `--tex` are the same idea against whichever
one a model happens to use.

## Repairs, done automatically and reported

The conversion these models came through turns smooth diagonals into
staircases whose steps touch only at a **corner**. Watertight as a mesh; as
voxels it is a row of pieces sharing no face, and every corner is a slit you
can see the street through. Both repairs run on every import and print what
they did, and the importer finishes by counting connected components so a
model that is still in pieces says so.

- **`bridgeSeveredLayers`** — the loud version: a layer that is *entirely*
  empty with solid above and below. Only fires on a total severance, so it
  can never quietly thicken a post that was meant to be thin.
- **`weldCornerJoins`** — the quiet version: two solids meeting at a corner
  with both joining cells empty. Fills the better-supported one, so the fill
  grows into the body rather than budding off the silhouette. A gap that was
  *meant* to be there — a groove, a scallop — is more than one cell wide and
  never presents a corner-only pair, so it survives.

What that was worth, on the three models that came through the converter:

| | before | after |
|---|---|---|
| hydrant | 1 piece, 6 corner slits | 1 piece, +6 voxels |
| streetlight | **4 pieces**, 1 severed layer | 1 piece, +12 voxels |
| flock camera | **6 pieces** | 1 piece, +8 voxels |

The streetlight's head was floating free of its pole and the camera's bracket
was five loose fragments hanging off a post. Both read as solid now.

Read the printed elevation before pasting. It is the whole point of the
report: a wrong axis, a lost part or a mangled silhouette is obvious there
and invisible once it is a base-36 string.

## What it does

`fbx-read.mjs` reads binary FBX (7100–7700) and the PNG atlas embedded in it.
`voxel-import.mjs` turns the mesh into an occupancy grid:

1. **Mesh to shell.** Every triangle is half of an axis-aligned cube face, so
   the constant axis plus the winding names the cube behind it outright. This
   beats rounding a centroid, and needs nothing from the mesh's topology —
   these exports are neither closed nor manifold, so ray parity and flooding
   the outside both lie about them. Each cell also keeps its **material
   slot**, which is what separates an awning from the frame it hangs on.
2. **Shell to solid.** The models are hollow and their skin is pierced
   wherever a groove runs, so an outside flood pours straight in. Each
   horizontal slice is closed between its own extremes along both ground
   axes and only the agreement is kept — it cannot leak, and it fills the
   barrel without also filling the notch beside a cap.
3. **Resample.** On the exact ratio, never in integer blocks: block
   averaging an odd axis puts the model's mirror plane inside a cell and the
   symmetry dies where you can see it.
4. **Reframe and encode.** Models come out of Blender Y-up. The engine wants
   row 0 at the top and depth running from the front edge, so the vertical
   always inverts and `--axis` names which model axis is the frontage — a
   hydrant's is its narrow side, a stall's is its long one. Each run is a
   role letter and a base-36 length; role letters are upper case and base-36
   digits are not, so the runs need no separator.

Optionally, **5. a light strip.** Nothing in a model says "this edge glows",
but the underside of a canopy is where a stall hangs its lights, and that is
derivable: in the engine frame, the lowest voxel of the canopy in each column
*is* its under-surface. `--lit S:X` promotes those to their own role so the
engine can make them emissive — which turns the awning's own rim, scalloped
valance included, into the strip.

## Wiring one in

`voxArt()` in `index.html` decodes the runs and hands back what `parseArt`
does, plus the `vol()` the ray march reads. Beyond the `ART` entry a prop
needs, in `PROPDEF`:

- `w` and `h` in metres. Keep `w/h` at the **aspect w/h** the importer
  reports or the model comes out stretched.
- `dep` at the reported **depth scale** (`vd / aw`), which keeps the voxels
  cubic. Without it the prop falls back to `MODEL_DEPTH`.

If the model has a face — a nozzle, a door, a screen — give its kind a
`MODEL_TURN`, because `propYaw` only squares a prop to the nearer roadway
and knows nothing about which side is the front.

## Picking a height

The ray march steps at the size of the smallest voxel, so a fine grid costs
steps everywhere and buys detail no character cell can show. The hydrant
came in at 37×55×28 and went in at 19×28×14; measured against the flat
sprite it replaced, that is free (3.96 ms/frame against 4.01 ms). Native
resolution would have been about twice the steps for detail that never
reaches the screen. Read the printed elevation — if the shape survives, the
coarser grid is the right one.

## Colour

**The model's colours are never used.** They are read and reported — from the
embedded atlas per UV centroid, or from each material's diffuse — but only as
a hint about what a part was meant to be. The engine paints every role from
its own palette in the `slots({...})` call, so imported assets sit in the
city's colour scheme instead of dragging a foreign one in. This matters more
than it sounds: the market stand arrived from a format conversion with its
three materials flattened to near-black browns, and none of that reached the
screen.

So a model contributes **shape and segmentation**. Slots become roles, roles
become palette entries, and a role given `-1` takes the prop's dynamic `dyn`
colour instead — which is how the same stall geometry lights itself three
different ways.

## Anchors

Most models stand on the middle of their own artwork, so the prop's tile and
the model's centre are the same point. An asymmetric one does not: the
streetlight is a post at one edge with an arm reaching off the other, and
centring its bounding box puts the post out in the traffic. Those carry an
`anchor` in `PROPDEF` — the spot along the width, as a fraction from centre,
that has to land on the tile — and the draw shifts the other way by that much.

Give a model with a face a facing, too. `propYaw` only squares a prop to the
nearer roadway and answers with an *axis*; it cannot tell the kerb from the
shopfront behind you. That never mattered for a bin. It is the whole of a
streetlight, so `lampYaw` reads the ground instead — it steps out along each
axis, scores how much roadway it finds and how near, and hangs the arm over
the winner.

## Four models in, so far

| | hydrant | market stand | streetlight | flock camera |
|---|---|---|---|---|
| lattice | 37 × 55 × 28 | 44 × 48 × 55 | 15 × 55 × 4 | 3 × 55 × 13 |
| imported | 19 × 28 × 14 | 37 × 32 × 29 | 15 × 55 × 4 | 13 × 55 × 3 |
| colour source | atlas, one UV | 3 material slots | atlas, 18 colours | 3 material slots |
| roles | `B` | `M` frame, `S` awning, `X` strip | `M` post, `X` lens | `M` post, `X` lens |
| across axis | `x,y,-z` | `z,y,-x` | `x,y,-z` | `-z,y,-x` |
| lens found by | — | `--lit` | `--lit …@0-2` | `--mark` |
| repairs | — | — | 8 voxels bridged | — |
| cost vs predecessor | +0.00 ms | +0.39 ms, 10 in view | +0.16 ms (ground pools) | −0.11 ms, 93 in view |

Two of the four have a post at one edge and something reaching off the other,
and both take `anchor` plus `lampYaw`. The camera's arm is mirrored relative
to the streetlight's, which is why its axis spec starts `-z` rather than `z` —
flipping it in the importer means the engine-side aiming rule is shared
verbatim instead of forked with a half-turn.
