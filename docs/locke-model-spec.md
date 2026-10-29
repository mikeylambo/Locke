# Mr. Locke — model spec

Source of truth for his look: the character sheet (turnaround, expressions, palette, accessories). Ignore its weapons panel: Locke never fights.

The in-game Locke is built from **swappable parts**. Each part sits in a named slot group parented to an **attach point**. The procedural build fills every slot. A GLB can replace any slot's contents without touching the rig. The **limbs stay procedural** (rubber-hose tubes along beziers): the Stretch needs them to bend along any path.

## Units, axes, scale

- 1 unit = 1 metre. Y up. **The character faces +Z.** His left is +X.
- Height: **1.85 m (6'1")** to the top of the hat crown, standing at rest; lean build.
- Rest pose: the rig poses limbs procedurally, so parts are authored in **neutral orientation with no skeleton**. Gloves are relaxed open mitts; shoes are flat.
- Export glTF 2.0 binary (`.glb`), meshes only. Apply all transforms. One material per colour zone; base colour only (the game re-shades everything with its toon + ink-outline pipeline).

## Slots, attach points and pivots

| Slot | Attach point | Parent | Part origin (pivot) | Notes |
| --- | --- | --- | --- | --- |
| `torso` | `pt_hips` | body | pelvis centre, y = 0 at the crotch line; shoulders at (±0.20, 0.53, 0) | Jacket, vest, shirt V, tie, lapels, pocket square, buttons. **Crown tie pin as a child node named `crown_pin`** (gets the cat's-eye material). Watch chain is procedural; leave it out. |
| `head` | `pt_neck` | torso, at (0, 0.66, 0.01) | base of the skull | Skull, beard, moustache, ears, nose. Mouth via morph targets (below). |
| `glasses` | `pt_eyes` | head, at (0, 0.148, 0.118) | bridge of the nose | Round dark lenses, black frames, gold hinges. Pops up on "surprised". |
| `hat` | `pt_crown` | head, at (0, 0.243, −0.005) | centre of the brim plane | Black fedora, cream band. Lags a beat behind the head; flies off on a beam contact. |
| `glove_L` / `glove_R` | `pt_wrist_L` / `pt_wrist_R` | end of each arm hose | centre of the cuff opening | **Fingers point along +Z.** White, oversized mitts with cuff flare and three stitches. |
| `shoe_L` / `shoe_R` | `pt_ankle_L` / `pt_ankle_R` | body | under the ankle, sole at y = 0 | **Toe along +Z.** Two-tone spectators: white vamp, black toe cap and heel. |

Attach-point positions are the procedural defaults in `src/render/lockeParts.ts` (`DIM`, `ATTACH`).

## Expressions

The head carries four expressions (from the sheet): **cool** (default smirk), **grin** (success), **surprised** (beam contact; mouth open, brows up, glasses lifted), **serious** (reserved for later venues).

On a GLB head, supply **morph targets named exactly `cool`, `grin`, `surprised`, `serious`**. Brows can be part of the morphs. The procedural head swaps mouth meshes instead.

## Poly budget (game-ready, per part)

| Part | Triangles |
| --- | --- |
| head (with beard) | ≤ 6,000 |
| hat | ≤ 2,500 |
| glasses | ≤ 1,200 |
| torso | ≤ 6,000 |
| glove (each) | ≤ 1,500 |
| shoe (each) | ≤ 1,500 |
| **Total rigid parts** | **≤ 21,000** (hose limbs add ~4k at runtime) |

Keep silhouettes readable at 64 px from any orbit angle: big hat brim, bright gloves, white shoe vamps.

## Palette

Suit black `#17151b` with gold pinstripes `#8a7350` · shirt `#f4efe4` · skin `#6b4028` · beard `#100c0b` · gloves `#fffaf0` · gold `#d9aa52` · hat band `#eee3cc`.

## Dropping in Meshy parts

1. Export each part as above, e.g. `public/models/locke/head.glb`.
2. List them in `public/models/locke/manifest.json`:
   ```json
   { "parts": { "head": "head.glb", "hat": "hat.glb", "glasses": "glasses.glb" } }
   ```
3. Reload. `applyModelOverrides()` swaps each listed slot's contents and leaves the attach point (and all animation) intact. A part that fails to load keeps its procedural version.
