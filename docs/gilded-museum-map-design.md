# The Gilded Museum: Map Design v3
*Midnight on Fifth Avenue. Six rooms. Six treasures. Not one of them his. Yet.*

v3 adds: exhibits as security systems, layered verticality, the Funhouse Mirror Hall, comedy beats, curator blueprint notes, and a skylight bookend. It follows `venue-design-standard.md`.

## The night at a glance
| # | Beat | Shape | Verticality | Exhibit-mechanic | Prize flip |
|---|---|---|---|---|---|
| A | **Skylight Drop** (side-view opener) | Vertical shaft | Side-view | — | — |
| 1 | The Hope of Midnight | Small square | — | — | Simple return |
| 2 | The Sapphire Hall | Narrow corridor 6×22 | — | **Foucault pendulum** | Rhythm inverts |
| 3 | The Funhouse Mirror Hall | L-shape 14×14 | — | **Warped mirrors** | Mirror must stay |
| B | **Grand Staircase** (side-view link) | Staircase | Side-view | — | — |
| 4 | The Long Gallery | Two floors 5×26 | **Stacked floors** | Light-well grates | Floor goes live |
| 5 | The Sculpture Court | Courtyard 16×16 | **Standable plinths** | **Camera obscura** | Sweeper splits |
| 6 | The Grand Rotunda | Octagonal dome 20×20, two floors | Stacked + side-view exit | **Planetarium** | Entry seals; climb out |

Saved for later venues or a museum expansion: stained-glass chapel, Egyptian sun-mirror tomb, Ames room.

## A. The Skylight Drop (opening set piece)
Side-view. Locke lowers himself through the museum skylight on his own stretched arm, hat first, into the moonlit atrium. A short timed descent past a few slow beams teaches stretch as a rope. Intertitle: *"Midnight on Fifth Avenue."*
**Comedy:** his arm runs out of stretch a foot above the floor. He hangs there, considers it, and lets go.

## 1. The Hope of Midnight
The introduction, mostly unchanged. **Blueprint note:** *"A diamond needs no guard but the dark. — Night Curator."* Polish only.

## 2. The Sapphire Hall
**Author:** *The Metronome*, a retired conductor. **Note:** *"Keep time, or be kept."* **Footprint:** corridor 6 × 22.
**Exhibit-mechanic:** a Foucault pendulum mid-hall; its bob carries a beam that sweeps the floor, and it conducts the five pulse curtains.
- **Going in:** read the pendulum and you read the room's rhythm.
- **Prize flip:** lifting the sapphire flips curtain offsets and steps up the tempo; the pendulum's plane rotates 90° to run along the corridor.
- **Comedy:** the pendulum beam trims the feather off Locke's hat. He stays composed.
- **Locke moment:** tie straighten, then the sweat bead.

## 3. The Funhouse Mirror Hall
**Author:** *Madame Verre*. **Note:** *"A reflection never lies. It only exaggerates."* **Footprint:** L-shape, 14 × 14 outer.
**Exhibit-mechanic:** warped mirrors are fixed optics that shift a beam's height band (concave up, convex down). Cameras watch reflections.
- **Going in:** bend the feed beam around the corner to the sensor that drops the alcove grid, landing at the sensor's band; keep Locke's reflection out of camera lines.
- **Prize flip:** lifting the prize arms an out-phase grid powered by the same sensor, so the belt mirror has to stay.
- **Comedy:** a stretch mirror shows Locke 9 feet tall; he adjusts his hat, the reflection a fraction late.
- **Locke moment:** he admires the prize in his glasses; the mirrors repeat it, each more smug.

## B. The Grand Staircase (side-view link)
Side-view down the marble staircase. Laser steps cascade in time with the music; Locke flattens against the balustrade.
**Comedy:** a loose stair rod; Locke surfs two stairs with perfect posture.

## 4. The Long Gallery
**Author:** *Sir Ambrose Hale*. **Note:** *"No one crosses my floor."* **Footprint:** two floors, 5 × 26: gallery floor with roped island + prize; mezzanine above, stairs at each end.
**Exhibit-mechanic:** light-well grates in the balcony floor pass beams down.
- **Going in:** from the balcony, mirror a beam down a grate to a gallery sensor that kills an oscillator; then stretch over the rope.
- **Prize flip:** every gallery plate goes live; out is back up to the balcony, where the grates now fire upward.
- **Comedy:** Hale's portrait's eyes follow Locke; he tips his hat to it.
- **Locke moment:** a full-length stretch overshoots and snaps back, hat bouncing.

## 5. The Sculpture Court
**Author:** *Odile Marchetti*. **Note:** *"Security should be beautiful."* **Footprint:** courtyard 16 × 16, irregular statues.
**Verticality:** standable plinths raise Locke a band. **Exhibit-mechanic:** a camera obscura in the corner tower projects the court, revealing sweepers hidden behind statues.
- **Going in:** read the projection, use statue shadows, flatten through two gaps, climb plinths over low sweepers.
- **Prize flip:** lifting the ruby (in a statue's hand, on a plate) splits the nearest sweeper into two spokes.
- **Comedy:** Locke freezes beside a statue in an identical pose; the statue holds his missing feather; he takes it back.
- **Locke moment:** he peels off the wall like a sticker.

## 6. The Grand Rotunda (finale)
**Author:** *The Board of Trustees*. **Note:** *"Every curator's fear, under one dome."* **Footprint:** octagonal dome 20 × 20, ground + gallery ring.
**Exhibit-mechanic:** a planetarium projector whose constellations sweep both floors; the Crown sits on it.
- **Going in:** pulse arcs on the ground; on the ring a multi-sensor lock needs A and B lit at once (splitter, one ray down a grate) to open the inner shutter; stretch across the plate ring.
- **Prize flip:** the projector stops and freezes every constellation on; the entry seals; out is the skylight.
- **Getaway (side-view):** climb the dome ribs while constellations sweep; re-aim the mirror once.
- **Comedy:** at the skylight his arm goes up, his body follows a beat late.
- **Locke moment:** silhouetted against the moon, tips his hat. *GILDED MUSEUM STRIPPED OF ITS CROWN JEWEL.*

## Build notes
- Stacked floors are separate 2D sim planes linked by stairs; beams cross only at grates and wells.
- Side-view sequences run on their own plane with a locked camera, reusing beam and pose logic.
- Every room keeps its bot playthrough test (no soft-locks, ≤ 1 alarm). No two rooms share dimensions.
