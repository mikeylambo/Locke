# Gilded Museum v3: design changes

These are the smallest changes I made where the v3 doc didn't work as written. Everything else follows the doc.

**Order:** A · 1 · 2 · 3 · B · 4 · 5 · 6 (the Rotunda hands straight into its side-view getaway, *Up the Dome*).

**Footprints:** A 8×9 (side) · 1 12×9 · 2 22×6 · 3 14×14 L · B 14×7 (side) · 4 26×5, two floors · 5 16×16 · 6 20×20 octagon, two floors · getaway 10×8 (side). No two are the same, and a test checks it.

| Room | Change | Why |
|---|---|---|
| All side views | Hold Stretch to hang from a hook. Push down to pay out rope. Let go to drop. Hold up and let go to haul yourself up (the arm goes first, then the body). | One button already carries both "lower" and "climb". This makes the doc's let-go comedy (A) and yank comedy (Getaway) both deliberate. |
| A Skylight Drop | Two hooks and a cornice ledge instead of one continuous drop. | His arm reaches 3 m and the shaft is 9 m. The arm still runs out a foot above the floor at the end. |
| 2 Sapphire Hall | The pendulum's blade sits at mid and high height, so crouching won't get you under it. Read its swing instead. | As written, crouching under it beat the room's main idea. |
| 2 Sapphire Hall | The feather is clipped on the first near-miss with the pendulum. If you never come close, it's clipped as you leave. | This keeps the running gag reliable without forcing a hit. |
| 3 Funhouse | The camera blinks: its shutter cycles on and off, and its sweep is narrow. | A camera that sweeps continuously across a corridor can't be passed. |
| 3 Funhouse | The 9-ft reflection is a line plus visibly warped glass, not a full mirrored body. | A real mirror render is costly. I kept the joke cheap. |
| 3 Funhouse | Sensors can require a beam height ("band"). This sensor only accepts the beam at mid height, raised there by the concave mirror. | This makes "landing at the sensor's band" a real rule. |
| B Grand Staircase | The "stair-rod surf" is a landing line plus a squash-and-stretch on the drop between flights. | A surf animation would need new rig work. |
| 4 Long Gallery | The mezzanine is a full see-through grille deck over the gallery. | One shape per floor keeps stacked floors simple. The deck fades when Locke is below it. |
| 5 Sculpture Court | The camera obscura sits by the door and works until the prize lifts. While casing, it doesn't start the clock. | It was out of reach without moving, and moving starts the clock. |
| 5 Sculpture Court | The ruby's plate holds the first gate open. Lifting the ruby shuts it, so you leave a different way. | This gives "on a plate" a job and enforces a way out that differs from the way in. |
| 6 Grand Rotunda | The skylight exit is a door on the gallery ring that leads into the getaway. | Floors are 2D planes, so the climb itself happens in the getaway. |
| Mirrors | Light swinging off the mirror you're turning by hand can't trip you while you turn it. | Rotating in 15° steps could sweep a beam into Locke's face, which isn't fair. |

**Open calls for Michael**
- Tutorial rooms A, B and Card Trick still share 8×6. The unique-size rule only checks the museum. Say if you want them resized.
- Voice lines use hum placeholders until clips are recorded (see `src/content/lines.json`).
