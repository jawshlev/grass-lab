# Grass Lab: context for Claude Code

A test bench for a stylized, flat-shaded grass field written in **three.js TSL**
(WebGPURenderer, WebGL 2 fallback). It's prep for an **R3F + TSL** portfolio
scene: the material in `js/grassMaterial.js` is meant to drop into that project.
The look started as a Blender tutorial setup (Scatter on Surface + Data Transfer
normals + a toon-ish material) and was ported to TSL step by step.

The owner is learning shaders and geometry nodes and has some three.js
experience. Explain changes plainly.

## Run it

No build step. three.js r180 loads from jsDelivr through the import map in `index.html`.

```
npm run dev        # = npx serve -l 5173 .   (any static server works)
```

Open http://localhost:5173. Append `#webgl` to force the WebGL 2 backend.
`v1/index.html` is the frozen first version (see "Versions").

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` publishes on every push to `main` (Pages source:
**GitHub Actions**). It copies only the runtime files (`index.html`, `.nojekyll`,
`js/`, `presets/`, `v1/`, `assets/grass_normal.png`) into `_site`. **If a new file
or folder is needed at runtime, add it to the workflow's copy step.** Keep every
path relative (no leading `/`), because the site is served from `/<repo>/`.

## Files

| Path | What it is |
|---|---|
| `index.html` | Page, controls panel, presets (`PRESETS` object), import map, on-screen error reporter |
| `js/main.js` | Scene: renderer setup, hill terrain, scatter, instancing, camera, stats, `window.grassLab.apply()` |
| `js/grassMaterial.js` | **The material.** No scene code. Exports `createGrassMaterials`, `DEFAULTS`, `makeNoiseTexture`, `BLADE_HEIGHT` |
| `js/grassPiece.js` | GrassPiece clump geometry, inlined as arrays (see "Why the geometry is inlined") |
| `assets/grass_normal.png` | Normal map used at runtime (1024², downsized) |
| `assets/source/` | Originals: `grassPiece.glb` from Blender (it also embeds the 2048² normal map) and the full-res normal map |
| `presets/*.json` | Saved settings: `tuned`, `tuned-waves` (default), `mobile`, `v1` (v1 uses the old wind keys) |
| `reference/` | Blender node screenshots, the tutorial's wind nodes, and the look target |
| `v1/` | Frozen copy of the first shader with its settings. **Don't edit it unless the owner asks.** |

## The material (v2): Blender node chain → TSL

The fragment stage in `grassMaterial.js` follows the owner's Blender material
(`reference/blender-material-nodes-annotated.png`) node for node:

1. **Texture Coordinate (Object: Empty.006) → Mapping:** `vec2(world.x, -world.z) / emptySize`. Blender XY = three (x, -z).
2. **Noise (scale 1000) → Linear Light 0.05 into coords:** in Eevee this only reads as a *blur*, because it averages many samples per pixel. Emulated by sampling a blurrier mip: `texture(...).level(log2(blur * texSize + 1))`. `grain` adds literal per-pixel jitter (off by default; it sparkles in real time).
3. **Image texture, Non-Color, Repeat.**
4. **Normal Map, tangent space, strength 1 → N1:** the tangent frame is the clump's own `aTangent` / `aUp`, so differently rotated clumps tilt differently, as in Blender. With a world-fixed frame, v1 got embossed diagonal stripes.
5. **Normal Map, world space → N2:** texture RGB read as a Blender world normal, converted with `toThree(b) = (b.x, b.z, -b.y)`.
6. **Linear Light, A=N1, B=N2, factor `worldBlend`:** `N1 + f * (2*N2 - (1,1,1)_blender)`.
7. **Diffuse (white) → Shader to RGB:** `max(dot(N, sun), 0) * sunStrength + ambient`. No cast shadows (per-blade shadows caused speckle in Blender).
8. **Color Ramp:** 3 stops, **linear** interpolation, adjustable positions.

Extras on top, each can be set to 0: root darkening, clump tint, per-clump
brightness jitter, gust colour waves, backlight. Debug views: ramp input,
normals, height, gusts, raw texture.

`MeshBasicNodeMaterial` is used on purpose: lighting is computed by hand, and
scene lights and shadows are ignored.

### Per-instance attributes (filled in `main.js`)

- `aRoot` vec3: clump root, world space
- `aUp` vec3: clump's local Y axis in world space. This stands in for the Data Transfer normals, which point up in clump space.
- `aTangent` vec3: clump's local X axis in world space
- `aRand` float: 0..1, per clump

### Wind (vertex stage)

Two layers, after the tutorial's geometry nodes (`reference/tutorial-wind-geometry-nodes.png`):
`bend = windStrength × (windLean + wave + noise) + flutter`.

- Both layers are sampled at each clump's **root**, so neighbours move together,
  in a wind frame (`along` = downwind, `across` = sideways). `waveStretch` (< 1)
  squashes `across`, so the noise forms long bands lying across the wind. That's
  the tutorial's tiling (0.35, 1, 1).
- **Wave:** slow, big and smooth. R channel, `smoothstep` into soft crests, 0..1.
- **Noise:** fast, small and choppy. Two G-channel reads drifting in different
  directions, averaged, so it churns instead of sliding. About −1..1. The per-clump
  sine `flutter` sits on top.
- Bend weight is `h²` (h = height on the blade, 0 at the root), with a small tip
  drop. It's a bend, not the tutorial's rigid instance rotation.
- **Light follows bend (`normalTilt`):** the clump's lighting normal tilts downwind
  with the *moving* part of the bend (not the constant lean, so tuned colours don't
  shift). Without it, blades move but the shading never changes and waves barely
  read. In Blender, rotating instances rotates their normals too.
- The **Gusts** debug view and **Colour waves** follow the wave layer only.
- The **Wind** switch rebuilds the shader with no wind code at all
  (`set.windOn(false)`), for measuring cost. With wind on, there are 3 noise reads per vertex.

## Gotchas (learned the hard way)

- **`positionNode` works in the clump's LOCAL space** on an InstancedMesh in r180: the instance transform is applied *after* it, and the root is at the local origin. So:
  - scaling about the root is `positionLocal.mul(s)`;
  - a world-space offset must be rotated into the clump frame with `dot(off, aTangent)`, `dot(off, aUp)`, `dot(off, cross(aTangent, aUp))`.

  This bug once made every clump bend in its own random direction. It still exists in `v1/`, which is intentionally untouched.
- **Blender is Z-up, three.js is Y-up.** Watch any texture-space or world-normal conversion.
- **Why the geometry is inlined.** The lab was published as a claude.ai artifact, whose sandbox blocked GLTFLoader from fetching the glb's `data:` buffer, so the page hung on "Loading". In a normal project, load `assets/source/grassPiece.glb` (e.g. `useGLTF`), then delete its `normal` and `uv` attributes and run `mergeVertices`: 144 → 96 vertices per clump. The material doesn't read either attribute.
- **Noise is a texture, not procedural.** `makeNoiseTexture()` builds a 128² tiling RGBA fbm (R gust, G chop, B clump tint, A grain). It replaced `mx_noise_float` calls for mobile. Texture reads in the vertex stage use `.level(0)`.
- **The ground hides the gaps between clumps.** Plain root colour made every gap a dark hole, which was worst at mobile density. The ground now runs a cheap copy of the grass chain (the same blurred normal-map blobs and ramp, skipping the per-clump tangent map, one texture read) and mixes it with the root colour by `groundFill` (0 = old dark ground).
- **Scatter is an R2 low-discrepancy sequence**, not plain random (`buildField`). Every prefix is evenly spread, so the density slider (first N spots) never opens bald patches. A small jitter hides the lattice. A shuffled jittered grid would *not* work: a random subset of a grid is random again.
- **Renderer init** is raced against an 8 s timeout and falls back to WebGL 2 (some embedded frames never answer the WebGPU adapter request).

## Presets and settings

- Panel presets: **Tuned (saved)**, the owner's chosen look (with `groundFill` 0, the old dark ground); **Tuned + waves**, the default (Tuned with `groundFill` 0.55); **Starter** (`DEFAULTS`); **Mobile** (Tuned + waves with density 12000, scale 1.2). All of them use the two-layer wind. Reset returns to the active preset.
- "Copy settings" puts the full state on the clipboard as JSON (same keys as `presets/*.json`).
- **Default camera:** `CAMERA` (position + orbit target) at the top of `js/main.js`, and `CAMERA_MOBILE` for phones. The panel's **Camera** section shows the live values, and **Copy camera** copies them in the same shape, ready to paste there.
- `localStorage`: `grasslab-preset` (last chosen preset), `grasslab-msaa` (`'1'`/`'0'`).
- Quality settings aren't part of presets: the pixel-ratio cap and the wind switch.

## Mobile

- `window.GRASS_MOBILE` = coarse pointer and short screen side < 820. On phones: the Mobile preset, pixel ratio ≤ 1.5, MSAA on like desktop (it improves quality a lot; changing it reloads the page), its own default view (`CAMERA_MOBILE` in `js/main.js`), panel collapsed, and the camera FOV widened in portrait to keep the horizontal framing.
- Budget reference (CK42BB procedural-grass skill): 50–100K blades on mobile. One clump ≈ 6 blades, so about 12K clumps.
- The phone runs at **60 fps with Low Power Mode off**. The ~30 fps measured earlier was the Low Power Mode cap, not GPU load.

## Tried and rejected

- **Distance thinning** (threejs-grass style; CPU compaction plus shader fade): caused flashing during camera moves and saved little, because the hill is small and close. Removed.
- **v1 toon shading** (banded ramp, world-fixed tangent frame, high bump): gave harsh embossed stripes. It only looked right with the normal map effectively off. Kept in `v1/` for reference.

## Possible next steps

- **Lower-poly far clump:** a simpler GrassPiece from Blender (e.g. 3 blades) for phones or for distance. Saves vertices everywhere on screen.
- **Tiles** (e.g. 4×4 InstancedMeshes) for frustum culling when zoomed in.
- **Port to R3F:** `<Canvas>` with a WebGPURenderer `gl` factory; `createGrassMaterials` in a `useMemo`; fill the instanced attributes as `buildField` / `writeTransforms` / `upload` do in `main.js`; expose uniforms to a leva panel.

## Working agreements with the owner

- Run optimization and refactor ideas past the owner **before** editing.
- Keep `v1/` frozen until the owner says it can be discarded.
- When changing the look, offer to save a new preset rather than overwriting **Tuned**.

## Testing notes

Headless Chromium here renders in software (SwiftShader). Full-density frames
can take seconds or time out. For screenshots: stop the animation loop, lower
`density`, call `renderer.render()` once, then read `canvas.toDataURL()`. The
`window.grassLab` handle exposes `renderer`, `scene`, `camera`, `uniforms`,
`field`, `grass` and `apply(key, value)` for this.
