# Bundled models

The street is populated from two GLB files in this folder. Each one is optional:
delete it and a procedural stand-in of the same footprint is used instead.

| File | Used for | Stand-in when absent | Reported as |
| --- | --- | --- | --- |
| `person.glb` | Three standing subjects and five pedestrians | Merged procedural humanoid | `procedural` |
| `car.glb` | Four parked cars | Box car | `box car` |

Both rows are shown in the CMOS panel of the interface, and logged to the console
on startup, so it is obvious which asset actually loaded.

## `person.glb`

`Soldier.glb` from the [three.js](https://github.com/mrdoob/three.js) examples
(`examples/models/gltf/Soldier.glb`), an Adobe Mixamo character carrying the
`Idle`, `Run`, `TPose` and `Walk` clips.

## `car.glb`

Ferrari 458 Italia by
[vicent091036](https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6),
taken from the three.js examples (`examples/models/gltf/ferrari.glb`).

Its geometry is **Draco compressed**: 358k triangles in 1.7 MB, against roughly
11 MB uncompressed. The decoder is served from [`public/draco/gltf/`](../draco/gltf/),
copied out of `three/examples/jsm/libs/draco/gltf/`, and referenced through
`DRACOLoader.setDecoderPath`. It is served locally rather than from a CDN so the
app keeps working offline and on networks that block third-party hosts. If the
decoder is missing the model fails to load, and the box car appears instead —
nothing else breaks.

This is the heaviest asset in the project. Only the cars inside the view and the
sun shadow frustum are drawn, but four of them still add up. Drop `CAR_COUNT` in
`scene3d.js`, or clear `castShadow` on the cars in `vehicleAsset.js`, to trade
their shadows away for frame rate.

## Licensing caveat

Three.js itself is MIT, but that licence covers the library rather than the
third-party models it ships, and both files above carry their own terms. Mixamo
allows its characters in a project while restricting redistribution of the raw
asset, and the Ferrari model is a Sketchfab upload whose licence should be
checked before you redistribute it. Both are therefore convenience defaults
rather than licence-clean dependencies.

## Licence-clean alternatives

All are CC-BY 4.0 and redistributable with attribution. Save over the bundled
file, no code change needed:

| Model | Size | Notes |
| --- | --- | --- |
| [`CesiumMan`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan) | 0.4 MB | Character. Authored Z-up with no corrective rotation, so it loads lying on its back. Low poly, one texture. |
| [`RiggedFigure`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/RiggedFigure) | 0.05 MB | Character. Untextured, 256 triangles. |
| [`ToyCar`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar) | — | Vehicle. A wooden toy car on a rug, not a street vehicle. |
| [`CesiumMilkTruck`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMilkTruck) | 0.4 MB | Vehicle. A stylised delivery truck. |
| [`Buggy`](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Buggy) | 1.6 MB | Vehicle. A dune buggy. |

## Requirements when swapping either file

**Character** (`personAsset.js`):

- Rigged, with a `SkinnedMesh` and a `Skeleton`.
- An `Idle` clip for the standing subjects and a `Walk` clip for the pedestrians.
  Matching is case-insensitive and also accepts `Stand`, `Breath`, `Jog` and
  `Stroll`. With no clips the figure stays in its bind pose.
- Y-up. Facing is handled for you, see below.

**Vehicle** (`vehicleAsset.js`):

- Any car model. Overall length is normalised to 4.53 m, which is the real
  figure the bundled asset was measured against.
- Facing is handled for you.

Nothing else needs adjusting. Height, scale, ground contact and centring are all
derived from the world bounding box at load time, because the units and transform
conventions inside a glTF file are not reliable — `person.glb` declares bounds of
184 × 44 × 183 units behind a root scale of `0.01` and a 90° rotation.

## How facing is worked out

A constant is not used, because every model is authored differently. Instead an
anatomical cue is measured in the bind pose and the model is turned to face +Z:

- **Character**: the toes point the way a character faces, so the `Foot`-to-`ToeBase`
  vector is averaged across both feet to cancel splay.
- **Vehicle**: the wheel node names (`wheel_fl`, `wheel_rr`, …) name their own
  corner, and the head lamps sit opposite the tail lamps. Both cues are measured
  and compared; lamp names containing `steering`, `interior` or `dash` are
  excluded so the cabin does not drag the centroid.

The result is snapped to a quarter turn, and the angle applied is printed to the
console. Override it with a number if you need to: `MODEL_FACING` and
`VEHICLE_FACING` accept `'auto'` (the default) or radians.
