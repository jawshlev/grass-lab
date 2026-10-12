// grassMaterial.js
// ---------------------------------------------------------------------------
// Stylized "clumpy" grass for three.js WebGPURenderer, written in TSL.
// This file has no scene code in it, so it drops straight into an R3F project:
//
//   const { grassMaterial, groundMaterial, uniforms } = createGrassMaterials(normalTex)
//   <instancedMesh material={grassMaterial} ... />
//
// The look is the TSL version of the Blender material:
//   Blender                                   ->  here
//   Data Transfer normals from a flat plane   ->  per-blade "aNormal" (the hill's normal at the root)
//   Texture Coordinate (Object: Empty.006)    ->  normal map projected from above in world space
//   Noise (scale 1000) + Linear Light         ->  "grain": tiny noise that roughens blob edges
//   Diffuse BSDF -> Shader to RGB -> Ramp     ->  our own lambert term -> 3-stop toon ramp
//
// Per-instance attributes the grass geometry must carry (see buildField in main.js):
//   aRoot   vec3   world position of the blade's root
//   aNormal vec3   ground normal at the root (the "shared surface" every blade is lit from)
//   aRand   float  0..1 random per blade
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu'
import {
  Fn, uniform, texture, attribute, varying,
  vec2, vec3, float,
  positionGeometry, positionLocal, positionWorld, normalWorld, cameraPosition, time,
  normalize, cross, dot, mix, smoothstep, clamp, saturate, pow, sin, cos, abs, length, max,
  mx_noise_float, select,
} from 'three/tsl'

export const BLADE_HEIGHT = 0.568 // height of GrassPiece in metres (from the .glb)

// Default values. The lab panel and "Copy settings" use the same keys.
export const DEFAULTS = {
  // Ramp colours (sRGB hex, like Blender's colour pickers)
  shadowColor: '#2b5230',
  midColor: '#5b8c34',
  lightColor: '#a6cb57',
  rootColor: '#1f3d22',
  tintColor: '#e0c96a',
  backlightColor: '#f2f0a0',

  // Light
  sunAzimuth: 35,      // degrees
  sunElevation: 39,    // degrees
  wrap: 0.25,          // 0 = hard lambert, 1 = light wraps all the way round

  // Clumps (the normal-map blobs)
  blobScale: 0.02,     // smaller = bigger blobs
  bump: 0,           // how much the normal map tilts the light
  heightSkew: 0,     // how much blob pattern shifts up the blade (breaks the "decal" look)
  grain: 0,        // edge roughness, Blender's Linear Light factor
  grainScale: 1,

  // Ramp shape
  rampLow: 0.58,       // shadow -> mid threshold
  rampHigh: 0.76,      // mid -> light threshold
  softness: 0.175,      // band softness. 0 = hard toon bands

  // Depth / variation
  rootHeight: 0.2,    // how far up the blade the dark root colour reaches (0..1)
  variation: 0.45,     // large-scale clump tint
  bladeJitter: 0.08,   // tiny per-blade brightness jitter (reads as individual leaves)
  backlight: 0,     // translucency when looking toward the sun

  // Wind
  windStrength: 0.18,  // tip displacement in metres
  windSpeed: 1.2,
  windDirection: 30,   // degrees
  gustScale: 0.1,     // size of travelling gusts (smaller = bigger gusts)
  flutter: 0.018,      // per-blade jitter
  gustHighlight: 0, // brighten tips inside a gust ("colour waves")

  debugView: 0,
}

const rad = (d) => (d * Math.PI) / 180

function sunVector(azDeg, elDeg, target = new THREE.Vector3()) {
  const az = rad(azDeg), el = rad(elDeg)
  return target.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize()
}

export function createGrassMaterials(normalTex, overrides = {}) {
  const p = { ...DEFAULTS, ...overrides }

  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping
  normalTex.colorSpace = THREE.NoColorSpace // data, not colour

  // ---- uniforms ------------------------------------------------------------
  const u = {
    shadowColor: uniform(new THREE.Color(p.shadowColor)),
    midColor: uniform(new THREE.Color(p.midColor)),
    lightColor: uniform(new THREE.Color(p.lightColor)),
    rootColor: uniform(new THREE.Color(p.rootColor)),
    tintColor: uniform(new THREE.Color(p.tintColor)),
    backlightColor: uniform(new THREE.Color(p.backlightColor)),
    sunDir: uniform(sunVector(p.sunAzimuth, p.sunElevation)),
    wrap: uniform(p.wrap),
    blobScale: uniform(p.blobScale),
    bump: uniform(p.bump),
    heightSkew: uniform(p.heightSkew),
    grain: uniform(p.grain),
    grainScale: uniform(p.grainScale),
    rampLow: uniform(p.rampLow),
    rampHigh: uniform(p.rampHigh),
    softness: uniform(p.softness),
    rootHeight: uniform(p.rootHeight),
    variation: uniform(p.variation),
    bladeJitter: uniform(p.bladeJitter),
    backlight: uniform(p.backlight),
    windStrength: uniform(p.windStrength),
    windSpeed: uniform(p.windSpeed),
    windDir: uniform(new THREE.Vector2(Math.cos(rad(p.windDirection)), Math.sin(rad(p.windDirection)))),
    gustScale: uniform(p.gustScale),
    flutter: uniform(p.flutter),
    gustHighlight: uniform(p.gustHighlight),
    debugView: uniform(p.debugView),
  }

  // Helpers so UI code can set things in "Blender units" (hex, degrees)
  const sunState = { az: p.sunAzimuth, el: p.sunElevation }
  const set = {
    color: (key, hex) => u[key].value.set(hex),
    sunAzimuth: (v) => { sunState.az = v; sunVector(sunState.az, sunState.el, u.sunDir.value) },
    sunElevation: (v) => { sunState.el = v; sunVector(sunState.az, sunState.el, u.sunDir.value) },
    windDirection: (v) => u.windDir.value.set(Math.cos(rad(v)), Math.sin(rad(v))),
  }

  // ---- shared per-blade values ---------------------------------------------
  const aRoot = attribute('aRoot', 'vec3')
  const aNormal = attribute('aNormal', 'vec3')
  const aRand = attribute('aRand', 'float')

  // 0 at the root, 1 at the tip of the clump (from the raw blade geometry)
  const bladeH = clamp(positionGeometry.y.div(BLADE_HEIGHT), 0, 1)

  // ---- wind (vertex stage) -------------------------------------------------
  // A gust field scrolls across the hill along the wind direction. Every blade
  // samples it at its ROOT, so neighbours move together (reads as wind, not jitter).
  const scroll = u.windDir.mul(time.mul(u.windSpeed))
  const gustUV = aRoot.xz.mul(u.gustScale).sub(scroll.mul(u.gustScale))
  const gust = saturate(mx_noise_float(vec3(gustUV, 0.0)).mul(0.9).add(0.5))         // 0..1, big slow waves
  const chop = mx_noise_float(vec3(gustUV.mul(3.7), 7.0))                            // -1..1, smaller ripples
  const flutter = sin(time.mul(6.0).add(aRand.mul(40.0))).mul(u.flutter)

  const windPosition = Fn(() => {
    const bend = u.windStrength.mul(gust.mul(0.85).add(0.15).add(chop.mul(0.2))).add(flutter)
    const w = bladeH.mul(bladeH) // bend from the root, not a stiff tilt
    const side = u.windDir.mul(bend.mul(w))
    // drop the tip a little as it bends so the blade doesn't look stretched
    const drop = abs(bend).mul(w).mul(0.45)
    // positionLocal already includes the instance transform here
    return positionLocal.add(vec3(side.x, drop.negate(), side.y))
  })()

  // gust is computed per vertex, then handed to the fragment stage
  const vGust = varying(gust, 'vGust')
  const vBladeH = varying(bladeH, 'vBladeH')

  // ---- shading (fragment stage) --------------------------------------------
  // baseN: the surface the blades pretend to be (hill normal for grass, real normal for ground)
  // h:     0..1 height on the blade (ground passes 0)
  // lift:  metres above the root (ground passes 0)
  const shade = (baseN, h, lift, rootXZ, gustAmt, rand = float(0.5)) => {
    const wp = positionWorld

    // 1. Project the normal map from above, in world space, so neighbouring blades
    //    get the SAME normal -> light falls in big clumps across many blades.
    //    Shifting by height ABOVE THE ROOT (not world height) keeps the blobs round on slopes.
    const skew = vec2(lift, lift.mul(0.6)).mul(u.heightSkew)
    let projUV = wp.xz.add(skew).mul(u.blobScale)

    // 2. Grain: high-frequency noise nudging the lookup (painterly ragged edges)
    const g = vec2(
      mx_noise_float(wp.mul(u.grainScale)),
      mx_noise_float(wp.mul(u.grainScale).add(17.3)),
    )
    projUV = projUV.add(g.mul(u.grain))

    // Two lookups at different scales and rotations, averaged. One lookup has a
    // directional grain that the toon ramp turns into stripes; two make round blobs.
    const n1 = texture(normalTex, projUV).xyz.mul(2).sub(1)
    const ruv = vec2(projUV.x.mul(0.454).sub(projUV.y.mul(0.891)), projUV.x.mul(0.891).add(projUV.y.mul(0.454)))
    const n2 = texture(normalTex, ruv.mul(0.63).add(0.37)).xyz.mul(2).sub(1)
    const nm = vec3(n1.xy.add(n2.xy).mul(0.5), n1.z)

    // 3. Tilt the base normal by the map (tangent frame built around baseN)
    const up = normalize(baseN)
    const T = normalize(cross(up, vec3(0, 0, 1)))
    const B = cross(up, T)
    const N = normalize(T.mul(nm.x.mul(u.bump)).add(B.mul(nm.y.mul(u.bump))).add(up.mul(nm.z)))

    // 4. Our own diffuse term (Blender's Diffuse -> Shader to RGB), with wrap
    const ndl = dot(N, u.sunDir)
    const lit = saturate(ndl.add(u.wrap).div(u.wrap.add(1)))

    // 5. 3-stop toon ramp
    const s = u.softness.max(0.001)
    const toLow = smoothstep(u.rampLow.sub(s), u.rampLow.add(s), lit)
    const toHigh = smoothstep(u.rampHigh.sub(s), u.rampHigh.add(s), lit)
    let col = mix(mix(u.shadowColor, u.midColor, toLow), u.lightColor, toHigh)

    // 6. Large clump tint (slow noise on the root position)
    const cv = saturate(mx_noise_float(vec3(rootXZ.mul(0.13), 3.0)).mul(1.2).add(0.5))
    col = mix(col, col.mul(u.tintColor).mul(1.6), cv.mul(u.variation))

    col = col.mul(rand.sub(0.5).mul(u.bladeJitter).mul(2).add(1))

    // 7. Roots sink into a dark base colour (like ground-colour projection + AO)
    const rootShade = u.rootColor.mul(mix(float(0.75), float(1.2), lit))
    col = mix(rootShade, col, smoothstep(0.0, u.rootHeight.max(0.001), h))

    // 8. Colour waves: tips brighten where a gust is passing
    col = col.add(u.lightColor.mul(gustAmt.mul(gustAmt).mul(h).mul(u.gustHighlight)))

    // 9. Backlight: looking toward the sun makes tips glow
    const viewDir = normalize(wp.sub(cameraPosition))
    const back = pow(saturate(dot(viewDir, u.sunDir)), 4.0).mul(h).mul(u.backlight)
    col = col.add(u.backlightColor.mul(back))

    // Debug views: 1 lighting, 2 projected normals, 3 height mask, 4 gust field
    const dbg = u.debugView
    col = select(dbg.equal(1), vec3(lit), col)
    col = select(dbg.equal(2), N.mul(0.5).add(0.5), col)
    col = select(dbg.equal(3), vec3(h), col)
    col = select(dbg.equal(4), mix(vec3(0.08, 0.1, 0.2), vec3(1.0, 0.9, 0.4), gustAmt), col)
    return col
  }

  // ---- materials ------------------------------------------------------------
  // MeshBasicNodeMaterial ignores scene lights: we light it ourselves, so there
  // are no per-blade shadows (the speckle problem you hit in Blender).
  const grassMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  grassMaterial.positionNode = windPosition
  const vRoot = varying(aRoot, 'vRoot')
  grassMaterial.colorNode = shade(varying(aNormal, 'vNormal'), vBladeH, positionWorld.y.sub(vRoot.y), vRoot.xz, vGust, varying(aRand, 'vRand'))

  // The ground under the grass uses the same shading at height 0, so gaps between
  // blades read as deep grass instead of bare mesh.
  const groundMaterial = new THREE.MeshBasicNodeMaterial()
  const groundGust = saturate(mx_noise_float(vec3(positionWorld.xz.mul(u.gustScale).sub(scroll.mul(u.gustScale)), 0.0)).mul(0.9).add(0.5))
  groundMaterial.colorNode = shade(normalWorld, float(0), float(0), positionWorld.xz, groundGust)

  return { grassMaterial, groundMaterial, uniforms: u, set, params: p }
}
