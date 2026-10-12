// grassMaterial.js  (v2: follows the Blender node chain)
// ---------------------------------------------------------------------------
// Stylized clumpy grass for three.js WebGPURenderer, written in TSL.
// No scene code here, so it drops straight into an R3F project.
//
// Same order as the Blender material, node for node:
//
//   Texture Coordinate (Object: Empty.006) -> Mapping
//       = world X/Z divided by the "empty size"                       (step 1)
//   Noise Texture -> Linear Light (factor 0.05) into the coordinates
//       = blur on the normal-map lookup                               (step 2)
//   grass_normal_texture.png (Non-Color)                             (step 3)
//   Normal Map, TANGENT space, strength 1   -> N1                     (step 4)
//   Normal Map, WORLD space,   strength 1   -> N2                     (step 5)
//   Linear Light (factor 0.075): A = N1, B = N2                       (step 6)
//   Diffuse BSDF (white) -> Shader to RGB                             (step 7)
//   Color Ramp (linear)                                               (step 8)
//
// Extras on top (all can be set to 0): root darkening, clump tint,
// per-blade jitter, gust colour waves, backlight.
//
// Per-instance attributes the grass geometry must carry (main.js fills them):
//   aRoot    vec3   world position of the clump's root
//   aUp      vec3   the clump's up axis in world space. This is the normal your
//                   Data Transfer copied from the flat plane, after the
//                   instance rotation (Align Rotation) is applied.
//   aTangent vec3   the clump's local X axis in world space (tangent for step 4)
//   aRand    float  0..1 random per clump
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu'
import {
  Fn, uniform, texture, attribute, varying,
  vec2, vec3, float,
  positionGeometry, positionLocal, positionWorld, normalWorld, cameraPosition, time,
  normalize, cross, dot, mix, smoothstep, clamp, saturate, pow, sin, abs, max, log2,
  select,
} from 'three/tsl'

// ---------------------------------------------------------------------------
// Small tiling noise texture (128x128). One texture read is much cheaper than
// procedural noise, especially on phones. Channels:
//   R = gust waves, G = chop ripples, B = clump tint, A = fine grain
export function makeNoiseTexture(size = 128) {
  const data = new Uint8Array(size * size * 4)
  const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646 })()
  // periodic value noise: lattice of random values that wraps, smoothly interpolated
  const layer = (cells) => {
    const g = Array.from({ length: cells * cells }, rand)
    const at = (x, y) => g[((y % cells + cells) % cells) * cells + ((x % cells + cells) % cells)]
    const fade = (t) => t * t * (3 - 2 * t)
    return (u, v) => {
      const x = u * cells, y = v * cells, x0 = Math.floor(x), y0 = Math.floor(y)
      const fx = fade(x - x0), fy = fade(y - y0)
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx
      return a + (b - a) * fy
    }
  }
  const fbm = (cellsList) => {
    const ls = cellsList.map(layer)
    return (u, v) => { let sum = 0, amp = 1, tot = 0; ls.forEach((l) => { sum += l(u, v) * amp; tot += amp; amp *= 0.5 }); return sum / tot }
  }
  const ch = [fbm([4, 8, 16]), fbm([8, 16, 32]), fbm([3, 6]), fbm([32, 64])]
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    for (let c = 0; c < 4; c++) {
      // stretch contrast a little: fbm bunches up around 0.5
      const v = (ch[c](x / size, y / size) - 0.5) * 1.8 + 0.5
      data[i + c] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

export const BLADE_HEIGHT = 0.568 // height of GrassPiece in metres

export const DEFAULTS = {
  // Colour Ramp (linear, like Blender's). Positions are along the lighting value.
  shadowColor: '#2b5230',
  midColor: '#5b8c34',
  lightColor: '#a6cb57',
  rampShadowPos: 0.0,
  rampMidPos: 0.5,
  rampLightPos: 0.95,

  // Lighting (Diffuse BSDF -> Shader to RGB)
  sunAzimuth: 35,
  sunElevation: 39,
  sunStrength: 1.0,  // like the Sun lamp's strength
  ambient: 0.08,     // world / sky light added on top

  // Normal-map chain
  emptySize: 12,      // Empty.006 size in metres: bigger = bigger blobs
  blur: 0.05,         // Linear Light factor into the coordinates (0.05 in Blender)
  grain: 0.0,         // the same jitter done literally per pixel (noisy in real time, so off)
  tangentStrength: 1, // Normal Map node 1 strength (tangent space)
  worldBlend: 0.075,  // Linear Light factor mixing in the world-space normal map

  // Extras
  rootColor: '#1f3d22',
  rootHeight: 0.2,
  tintColor: '#e0c96a',
  variation: 0.45,
  bladeJitter: 0.08,
  backlight: 0,
  backlightColor: '#f2f0a0',

  // Ground between the clumps: 0 = root colour (dark gaps), 1 = full grass colour
  groundFill: 0.55,

  // Wind: two layers, like the tutorial's geometry nodes.
  //   bend = windStrength * (lean + wave + noise) + flutter
  windStrength: 0.18,  // master multiplier, metres at the tip
  windDirection: 30,
  windLean: 0.3,       // constant lean downwind (WindAmplitude)
  normalTilt: 1.0,     // how much the bend tilts the lighting (makes waves visible)
  gustHighlight: 0,
  // Wave: slow, big, smooth rolling bands
  waveStrength: 1.0,
  waveSpeed: 1.5,      // metres per second along the wind
  waveScale: 0.08,     // smaller = bigger waves
  waveStretch: 0.35,   // < 1 stretches the bands across the wind (tiling 0.35, 1, 1)
  // Noise: fast, small, choppy
  noiseStrength: 0.35,
  noiseSpeed: 3.5,
  noiseScale: 0.2,
  flutter: 0.018,      // per-clump shimmer (metres)

  debugView: 0,
}

const rad = (d) => (d * Math.PI) / 180

function sunVector(azDeg, elDeg, target = new THREE.Vector3()) {
  const az = rad(azDeg), el = rad(elDeg)
  return target.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
}

export function createGrassMaterials(normalTex, overrides = {}, noiseTex = makeNoiseTexture()) {
  const p = { ...DEFAULTS, ...overrides }

  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping // Image Texture: Repeat
  normalTex.colorSpace = THREE.NoColorSpace                 // Image Texture: Non-Color
  const texSize = normalTex.image ? normalTex.image.width : 1024

  // ---- uniforms ------------------------------------------------------------
  const u = {
    shadowColor: uniform(new THREE.Color(p.shadowColor)),
    midColor: uniform(new THREE.Color(p.midColor)),
    lightColor: uniform(new THREE.Color(p.lightColor)),
    rampShadowPos: uniform(p.rampShadowPos),
    rampMidPos: uniform(p.rampMidPos),
    rampLightPos: uniform(p.rampLightPos),
    sunDir: uniform(sunVector(p.sunAzimuth, p.sunElevation)),
    sunStrength: uniform(p.sunStrength),
    ambient: uniform(p.ambient),
    emptySize: uniform(p.emptySize),
    blur: uniform(p.blur),
    grain: uniform(p.grain),
    tangentStrength: uniform(p.tangentStrength),
    worldBlend: uniform(p.worldBlend),
    rootColor: uniform(new THREE.Color(p.rootColor)),
    rootHeight: uniform(p.rootHeight),
    tintColor: uniform(new THREE.Color(p.tintColor)),
    variation: uniform(p.variation),
    bladeJitter: uniform(p.bladeJitter),
    backlight: uniform(p.backlight),
    backlightColor: uniform(new THREE.Color(p.backlightColor)),
    groundFill: uniform(p.groundFill),
    windStrength: uniform(p.windStrength),
    windDir: uniform(new THREE.Vector2(Math.cos(rad(p.windDirection)), Math.sin(rad(p.windDirection)))),
    windLean: uniform(p.windLean),
    normalTilt: uniform(p.normalTilt),
    waveStrength: uniform(p.waveStrength),
    waveSpeed: uniform(p.waveSpeed),
    waveScale: uniform(p.waveScale),
    waveStretch: uniform(p.waveStretch),
    noiseStrength: uniform(p.noiseStrength),
    noiseSpeed: uniform(p.noiseSpeed),
    noiseScale: uniform(p.noiseScale),
    flutter: uniform(p.flutter),
    gustHighlight: uniform(p.gustHighlight),
    debugView: uniform(p.debugView),
  }

  const sunState = { az: p.sunAzimuth, el: p.sunElevation }
  const set = {
    color: (key, hex) => u[key].value.set(hex),
    sunAzimuth: (v) => { sunState.az = v; sunVector(sunState.az, sunState.el, u.sunDir.value) },
    sunElevation: (v) => { sunState.el = v; sunVector(sunState.az, sunState.el, u.sunDir.value) },
    windDirection: (v) => u.windDir.value.set(Math.cos(rad(v)), Math.sin(rad(v))),
  }

  // ---- per-instance values -------------------------------------------------
  const aRoot = attribute('aRoot', 'vec3')
  const aUp = attribute('aUp', 'vec3')
  const aTangent = attribute('aTangent', 'vec3')
  const aRand = attribute('aRand', 'float')

  const bladeH = clamp(positionGeometry.y.div(BLADE_HEIGHT), 0, 1) // 0 root .. 1 tip

  // ---- wind (vertex stage): two layers, like the tutorial's geometry nodes ---
  // Both layers are sampled at the clump's ROOT, so a whole clump moves as one and
  // neighbours move together. Coordinates are in a wind frame: "along" runs
  // downwind, "across" runs sideways. Squashing "across" (waveStretch < 1) stretches
  // the noise into long bands lying across the wind, like the tiling (0.35, 1, 1).
  // Texture reads in the vertex stage need an explicit mip: .level(0).
  const along = dot(aRoot.xz, u.windDir)
  const across = dot(aRoot.xz, vec2(u.windDir.y.negate(), u.windDir.x))
  const windUV = (speed) => vec2(along.sub(time.mul(speed)), across.mul(u.waveStretch))

  // Wave: slow, large and smooth. The smoothstep turns the noise into soft crests.
  const waveTex = texture(noiseTex, windUV(u.waveSpeed).mul(u.waveScale)).level(0).r
  const wave = smoothstep(0.25, 0.75, waveTex) // 0 calm .. 1 crest

  // Noise: fast, small and choppy. Two reads drifting in different directions,
  // averaged, so the pattern churns instead of sliding past as one rigid sheet.
  const n1 = texture(noiseTex, windUV(u.noiseSpeed).mul(u.noiseScale)).level(0).g
  const uv2 = vec2(along.sub(time.mul(u.noiseSpeed.mul(0.6))), across.add(time.mul(u.noiseSpeed.mul(0.45))))
  const n2 = texture(noiseTex, uv2.mul(u.noiseScale.mul(1.7)).add(0.37)).level(0).g
  const noise = n1.add(n2).sub(1.0) // about -1 .. 1
  const flutter = sin(time.mul(6.0).add(aRand.mul(40.0))).mul(u.flutter)

  // The moving part of the bend: wave + noise + flutter (metres at the tip)
  const gusting = u.windStrength.mul(wave.mul(u.waveStrength).add(noise.mul(u.noiseStrength))).add(flutter)
  const bend = u.windStrength.mul(u.windLean).add(gusting)

  // clump tint only depends on the root, so compute it once per vertex, not per pixel
  const clumpTint = saturate(texture(noiseTex, aRoot.xz.mul(0.13 / 3.0)).level(0).b.sub(0.5).mul(1.3).add(0.5))

  // Tilt the clump's lighting normal downwind as it bends. Without this the blades
  // move but their shading never changes, so waves are hard to see. In Blender,
  // rotating an instance rotates its normals too. Only the moving part tilts, so
  // the constant lean doesn't shift the tuned colours.
  const windDir3 = vec3(u.windDir.x, 0, u.windDir.y)
  const tiltedUp = normalize(aUp.add(windDir3.mul(gusting.mul(u.normalTilt).div(BLADE_HEIGHT))))

  // NOTE: in this three.js version positionNode works in the clump's OWN local space
  // (the instance transform is applied afterwards), with the clump's root at the origin.

  const windOffset = () => {
    const w = bladeH.mul(bladeH)
    const side = u.windDir.mul(bend.mul(w))
    const drop = abs(bend).mul(w).mul(0.45)
    const worldOff = vec3(side.x, drop.negate(), side.y)
    // The wind blows in WORLD space, but this offset is applied in the clump's local
    // space (see the note above), so rotate it into the clump's frame. aTangent and
    // aUp are the clump's local X and Y axes in world space; Z = X x Y.
    const X = aTangent, Y = aUp, Z = cross(aTangent, aUp)
    return vec3(dot(worldOff, X), dot(worldOff, Y), dot(worldOff, Z))
  }
  const positionWithWind = Fn(() => positionLocal.add(windOffset()))()
  const positionNoWind = Fn(() => positionLocal)()

  const vGust = varying(wave, 'vGust') // colour waves and the Gusts view follow the wave layer
  const vBladeH = varying(bladeH, 'vBladeH')
  const vUp = varying(aUp, 'vUp')
  const vUpWind = varying(tiltedUp, 'vUpWind')
  const vTangent = varying(aTangent, 'vTangent')
  const vRand = varying(aRand, 'vRand')
  const vTint = varying(clumpTint, 'vTint')

  // Blender is Z-up, three.js is Y-up: Blender (x, y, z) = three (x, -z, y).
  const toThree = (b) => vec3(b.x, b.z, b.y.negate())

  // Blur as a mip level (step 2); only depends on uniforms, so shared
  const lod = log2(u.blur.mul(texSize).add(1.0))

  // Step 8, Color Ramp: linear interpolation between three stops. Shared by grass and ground.
  const ramp = (lit) => {
    const t1 = saturate(lit.sub(u.rampShadowPos).div(max(u.rampMidPos.sub(u.rampShadowPos), 0.0001)))
    const t2 = saturate(lit.sub(u.rampMidPos).div(max(u.rampLightPos.sub(u.rampMidPos), 0.0001)))
    return mix(mix(u.shadowColor, u.midColor, t1), u.lightColor, t2)
  }

  // ---- shading (fragment stage) --------------------------------------------
  // N0: the normal before the map (Data Transfer result); h: 0..1 height on blade
  const shade = ({ N0, T0, h, tint, gustAmt, rand, local }) => {
    const wp = positionWorld

    // 1. Texture Coordinate (Object: Empty) -> Mapping
    //    Object coords of the empty = world position / empty size. Blender XY = three (x, -z).
    let coords = vec2(wp.x, wp.z.negate()).div(u.emptySize)

    // 2. Noise -> Linear Light into the coordinates.
    //    In Blender this is noise at scale 1000 on each blade, which only reads as a
    //    blur because Eevee averages many samples per pixel. In real time we get the
    //    same result by reading a blurrier mip level of the texture: blur 0.05 = a
    //    5%-of-the-texture-wide smear. "grain" adds the literal per-pixel jitter.
    // grain: one cheap texture read instead of fractal noise (only matters when grain > 0)
    const jitter = texture(noiseTex, local.xy.mul(40.0)).level(0).a.mul(2).sub(1)
    coords = coords.add(jitter.mul(u.grain))

    // 3. Image texture (Non-Color)
    const c = texture(normalTex, coords).level(lod).rgb
    const m = c.mul(2).sub(1) // stored colour -> vector

    // 4. Normal Map, tangent space (OpenGL: green = +bitangent).
    //    Tangent frame comes from each clump's orientation, so neighbouring clumps
    //    that are rotated differently tilt in different directions, like in Blender.
    const N = normalize(N0)
    const T = normalize(T0.sub(N.mul(dot(N, T0)))) // keep tangent perpendicular to N
    const B = cross(N, T)
    const mapped = normalize(T.mul(m.x).add(B.mul(m.y)).add(N.mul(m.z)))
    const N1 = normalize(mix(N, mapped, u.tangentStrength))

    // 5. Normal Map, world space: the texture's RGB read directly as a Blender world normal.
    const N2 = normalize(toThree(m))

    // 6. Linear Light, A = N1, B = N2, factor 0.075 (Clamp Factor on):
    //    result = A + factor * (2B - 1). The "- 1" is (1,1,1) in Blender space.
    const lin = N1.add(N2.mul(2).sub(toThree(vec3(1, 1, 1))).mul(saturate(u.worldBlend)))
    const Nf = normalize(lin)

    // 7. Diffuse BSDF (white) -> Shader to RGB. Plain Lambert from the sun plus sky light.
    //    No cast shadows (you turned those off for the grass in Blender).
    const lit = max(dot(Nf, u.sunDir), 0).mul(u.sunStrength).add(u.ambient)

    // 8. Color Ramp, linear interpolation between three stops.
    let col = ramp(lit)

    // ---- extras ----
    col = col.mul(rand.sub(0.5).mul(u.bladeJitter).mul(2).add(1))
    col = mix(col, col.mul(u.tintColor).mul(1.6), tint.mul(u.variation))
    const rootShade = u.rootColor.mul(mix(float(0.75), float(1.2), saturate(lit)))
    col = mix(rootShade, col, smoothstep(0.0, u.rootHeight.max(0.001), h))
    col = col.add(u.lightColor.mul(gustAmt.mul(gustAmt).mul(h).mul(u.gustHighlight)))
    const viewDir = normalize(wp.sub(cameraPosition))
    col = col.add(u.backlightColor.mul(pow(saturate(dot(viewDir, u.sunDir)), 4.0).mul(h).mul(u.backlight)))

    // Debug: 1 ramp input, 2 final normal, 3 height, 4 gusts, 5 raw texture
    const dbg = u.debugView
    col = select(dbg.equal(1), vec3(saturate(lit)), col)
    col = select(dbg.equal(2), Nf.mul(0.5).add(0.5), col)
    col = select(dbg.equal(3), vec3(h), col)
    col = select(dbg.equal(4), mix(vec3(0.08, 0.1, 0.2), vec3(1.0, 0.9, 0.4), gustAmt), col)
    col = select(dbg.equal(5), c, col)
    return col
  }

  // ---- materials ------------------------------------------------------------
  const grassMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  const vLocal = varying(positionGeometry, 'vLocal')
  const colorWithWind = shade({ N0: vUpWind, T0: vTangent, h: vBladeH, tint: vTint, gustAmt: vGust, rand: vRand, local: vLocal })
  const colorNoWind = shade({ N0: vUp, T0: vTangent, h: vBladeH, tint: vTint, gustAmt: float(0.5), rand: vRand, local: vLocal })
  // Wind switch: "off" rebuilds the shader with no wind code at all (no gust
  // texture reads, no bend math), so you can measure what the wind really costs.
  let windState = null
  const setWind = (on) => {
    if (on === windState) return // avoid a needless shader rebuild
    windState = on
    grassMaterial.positionNode = on ? positionWithWind : positionNoWind
    grassMaterial.colorNode = on ? colorWithWind : colorNoWind
    grassMaterial.needsUpdate = true
  }
  setWind(true)
  set.windOn = setWind

  // Ground under the grass. Wherever the clumps leave a gap you see the ground, so
  // instead of plain root colour (dark holes) it gets a cheap copy of the grass
  // colour: the same blurred normal-map blobs (steps 1-3, 5-6; the per-clump tangent
  // map of step 4 is skipped) and the same ramp, then darkened toward the root
  // colour. groundFill 0 gives the old dark ground. One texture read per pixel.
  const groundMaterial = new THREE.MeshBasicNodeMaterial()
  const gwp = positionWorld
  const gm = texture(normalTex, vec2(gwp.x, gwp.z.negate()).div(u.emptySize)).level(lod).rgb.mul(2).sub(1)
  const gN = normalize(normalWorld.add(normalize(toThree(gm)).mul(2).sub(toThree(vec3(1, 1, 1))).mul(saturate(u.worldBlend))))
  const groundLit = max(dot(gN, u.sunDir), 0).mul(u.sunStrength).add(u.ambient)
  const rootGround = u.rootColor.mul(mix(float(0.75), float(1.2), saturate(groundLit)))
  const groundCol = mix(rootGround, ramp(groundLit), saturate(u.groundFill))
  groundMaterial.colorNode = select(u.debugView.equal(1), vec3(saturate(groundLit)), groundCol)

  return { grassMaterial, groundMaterial, uniforms: u, set, params: p, noiseTex }
}
