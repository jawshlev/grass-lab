// main.js: the lab scene (hill, scatter, camera, controls panel).
// In R3F this becomes: <Canvas gl={webgpu}> + a <Hill/> mesh + an <instancedMesh/>
// built by buildField(). The material code lives in grassMaterial.js.

import * as THREE from 'three/webgpu'
import { fog, rangeFogFactor, mix, positionWorldDirection, vec2, uniform, positionWorld, smoothstep, length, texture } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as blade from './grassPiece.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { createGrassMaterials, DEFAULTS } from './grassMaterial.js'

const MAX_BLADES = 60000
const FIELD = { rx: 8.5, rz: 6.0 } // ellipse radii of the grassy mound, metres
// Default view. The camera looks from `position` at `target` (the orbit centre),
// so these two points fully set its orientation. Get new values with the panel's
// Camera > "Copy camera" button and paste them here.
const CAMERA = { position: [3.88, 14.95, 16.22], target: [1.43, 1.15, -0.13] }

// ---------------------------------------------------------------------------
// Terrain: an elongated mound with gentle rolls (analytic, so the scatter can
// sample height and normal without raycasting).
function heightAt(x, z) {
  const r2 = (x / 9.5) ** 2 + (z / 7) ** 2
  const mound = 2.6 * Math.exp(-r2 * 1.6)
  const roll = 0.12 * Math.sin(x * 0.37 + 1.3) * Math.cos(z * 0.43 - 0.4)
  return mound + roll * Math.exp(-r2 * 0.6)
}
function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.05
  const dx = heightAt(x + e, z) - heightAt(x - e, z)
  const dz = heightAt(x, z + e) - heightAt(x, z - e)
  return out.set(-dx, 2 * e, -dz).normalize()
}
// soft, wobbly edge for the grass patch (0 inside .. >1 outside)
function fieldEdge(x, z) {
  const a = Math.atan2(z, x)
  const wobble = 1 + 0.07 * Math.sin(a * 5 + 0.7) + 0.04 * Math.sin(a * 11)
  return ((x / FIELD.rx) ** 2 + (z / FIELD.rz) ** 2) / (wobble * wobble)
}

function makeHillGeometry() {
  const g = new THREE.PlaneGeometry(320, 320, 320, 320)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) - 0.02)
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------------------
// Scatter: MAX_BLADES random spots are generated once, in random order, so the
// density slider just takes the first N. Transforms are kept in "source" arrays
// and copied into the GPU buffers when a Field setting changes.
function seededRandom(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
}

function buildField(bladeGeometry) {
  const rnd = seededRandom(1234)
  const spots = []
  // Positions come from the R2 low-discrepancy sequence instead of plain random.
  // Random scatter clumps up and leaves bald patches; R2 fills the area evenly, and
  // EVERY prefix of it is even too, so the density slider (first N spots) never
  // opens holes. A little jitter (half the full-density spacing) hides its lattice.
  const g = 1.32471795724474602596 // plastic number
  const a1 = 1 / g, a2 = 1 / (g * g)
  const jitter = 0.5 * Math.sqrt(0.8 / MAX_BLADES)
  let n = 0
  while (spots.length < MAX_BLADES) {
    n++
    const u = (0.5 + n * a1 + (rnd() - 0.5) * jitter) % 1
    const v = (0.5 + n * a2 + (rnd() - 0.5) * jitter) % 1
    const x = (u * 2 - 1) * FIELD.rx * 1.12
    const z = (v * 2 - 1) * FIELD.rz * 1.12
    const e = fieldEdge(x, z)
    // thin out toward the edge so the silhouette is tufty, not a hard cut
    if (e > 1 || (e > 0.82 && rnd() > (1 - e) / 0.18)) continue
    spots.push({ x, z, yaw: rnd() * Math.PI * 2, s: rnd(), r: rnd(), edge: e })
  }

  const src = {
    root: new Float32Array(MAX_BLADES * 3),
    rand: new Float32Array(MAX_BLADES),
    mat: new Float32Array(MAX_BLADES * 16),
    up: new Float32Array(MAX_BLADES * 3),
    tan: new Float32Array(MAX_BLADES * 3),
  }
  spots.forEach((sp, i) => {
    src.root.set([sp.x, heightAt(sp.x, sp.z), sp.z], i * 3)
    src.rand[i] = sp.r
  })

  const geo = bladeGeometry.clone()
  const inst = (n) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLADES * n), n)
  geo.setAttribute('aRoot', inst(3))
  geo.setAttribute('aUp', inst(3))
  geo.setAttribute('aTangent', inst(3))
  geo.setAttribute('aRand', inst(1))
  return { geo, spots, src }
}

// Fill the source transforms (runs when scale / size variation / slope alignment change)
function writeTransforms(spots, src, { scale, sizeVariation, align }) {
  const t = new THREE.Vector3()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qYaw = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), p = new THREE.Vector3(), s = new THREE.Vector3()
  spots.forEach((sp, i) => {
    normalAt(sp.x, sp.z, n)
    n.lerp(up, 1 - align).normalize()
    q.setFromUnitVectors(up, n)
    qYaw.setFromAxisAngle(up, sp.yaw)
    q.multiply(qYaw)
    // clump's up axis and local X axis in world space, for the normal-map frame
    t.set(0, 1, 0).applyQuaternion(q); src.up.set([t.x, t.y, t.z], i * 3)
    t.set(1, 0, 0).applyQuaternion(q); src.tan.set([t.x, t.y, t.z], i * 3)
    // shorter blades near the edge, plus random size
    const edgeShrink = THREE.MathUtils.clamp(1.25 - sp.edge * 0.45, 0.55, 1)
    const k = scale * (1 - sizeVariation * 0.5 + sizeVariation * sp.s) * edgeShrink
    p.set(sp.x, heightAt(sp.x, sp.z), sp.z)
    m.compose(p, q, s.set(k, k * (0.85 + 0.3 * sp.r), k))
    m.toArray(src.mat, i * 16)
  })
}

// Copy the first `density` clumps into the GPU buffers.
function upload(mesh, src, density) {
  const a = mesh.geometry.attributes
  mesh.instanceMatrix.array.set(src.mat.subarray(0, density * 16))
  a.aRoot.array.set(src.root.subarray(0, density * 3))
  a.aUp.array.set(src.up.subarray(0, density * 3))
  a.aTangent.array.set(src.tan.subarray(0, density * 3))
  a.aRand.array.set(src.rand.subarray(0, density))
  mesh.count = density
  for (const attr of [mesh.instanceMatrix, a.aRoot, a.aUp, a.aTangent, a.aRand]) attr.needsUpdate = true
}

// ---------------------------------------------------------------------------
async function start() {
  const canvas = document.getElementById('view')
  const status = document.getElementById('status')

  status.textContent = 'Starting renderer…'
  // add #webgl to the URL to force the WebGL 2 backend (handy for comparing)
  // Phones: MSAA off by default (toggle in the Quality panel; the choice reloads the page)
  const mobile = !!window.GRASS_MOBILE
  let msaa = !mobile
  try { const v = localStorage.getItem('grasslab-msaa'); if (v !== null) msaa = v === '1' } catch {}
  const makeRenderer = async (forceWebGL) => {
    const r = new THREE.WebGPURenderer({ canvas, antialias: msaa, forceWebGL })
    // some embedded frames never answer the WebGPU adapter request, so don't wait forever
    await Promise.race([r.init(), new Promise((_, rej) => setTimeout(() => rej(new Error('renderer init timed out')), 8000))])
    return r
  }
  let renderer
  try {
    renderer = await makeRenderer(location.hash === '#webgl')
  } catch (err) {
    console.warn('WebGPU start failed, retrying with WebGL 2:', err)
    renderer = await makeRenderer(true)
  }
  // Grass is fill-rate heavy: cap the pixel ratio (1.5 on phones, 2 elsewhere)
  const quality = { pixelRatio: mobile ? 1.5 : 2 }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio))
  renderer.toneMapping = THREE.NoToneMapping // keep the ramp colours exactly as picked

  const scene = new THREE.Scene()
  const skyTop = uniform(new THREE.Color('#6d9fd1'))
  const skyHorizon = uniform(new THREE.Color('#ece3c6'))
  scene.backgroundNode = mix(skyHorizon, skyTop, smoothstep(-0.02, 0.3, positionWorldDirection.y))
  scene.fogNode = fog(skyHorizon, rangeFogFactor(30, 95))

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200)
  camera.position.set(...CAMERA.position)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(...CAMERA.target)
  controls.enableDamping = true
  controls.maxPolarAngle = Math.PI * 0.49
  controls.minDistance = 1.5
  controls.maxDistance = 45

  status.textContent = 'Loading normal map…'
  const normalTex = await new THREE.TextureLoader().loadAsync('assets/grass_normal.png')
  normalTex.anisotropy = 8

  // Blade geometry is inlined (js/grassPiece.js). In R3F: useGLTF('/grassPiece.glb').nodes.GrassPiece.geometry
  const bladeGeometry = new THREE.BufferGeometry()
  bladeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(blade.position, 3))
  bladeGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(blade.normal, 3))
  bladeGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(blade.uv, 2))
  bladeGeometry.setIndex(blade.index)
  // The material never reads the mesh's normals or UVs (it lights from the clump's
  // up axis and measures height from position), so drop them and merge the
  // vertices Blender split along normal/UV seams: 144 -> 96 vertices per clump.
  bladeGeometry.deleteAttribute('normal')
  bladeGeometry.deleteAttribute('uv')
  const welded = mergeVertices(bladeGeometry, 1e-4)
  status.textContent = 'Compiling shaders…'

  const { grassMaterial, groundMaterial, uniforms, set, noiseTex } = createGrassMaterials(normalTex)

  // Outside the grass patch the ground fades to a dry meadow colour.
  // (mask = same wobbly ellipse the scatter uses, a little wider)
  const dirt = uniform(new THREE.Color('#8f9a62'))
  const wp = positionWorld.xz.div(vec2(FIELD.rx * 1.02, FIELD.rz * 1.02))
  const edgeNoise = texture(noiseTex, positionWorld.xz.mul(0.35 / 3.0)).b.sub(0.5).mul(0.24)
  const inside = smoothstep(1.0, 0.86, length(wp).add(edgeNoise))
  groundMaterial.colorNode = mix(dirt, groundMaterial.colorNode, inside)

  const hill = new THREE.Mesh(makeHillGeometry(), groundMaterial)
  scene.add(hill)

  const { geo, spots, src } = buildField(welded)
  const grass = new THREE.InstancedMesh(geo, grassMaterial, MAX_BLADES)
  grass.frustumCulled = false
  scene.add(grass)

  // field settings live here (they rebuild matrices, not uniforms)
  const field = { density: 26000, scale: 1.06, sizeVariation: 0.55, align: 0.81 }
  const applyField = () => {
    writeTransforms(spots, src, field)
    upload(grass, src, Math.min(MAX_BLADES, Math.round(field.density)))
    updateStats()
  }

  const trisPerBlade = welded.index.count / 3
  function updateStats() {
    document.getElementById('stat-blades').textContent = grass.count.toLocaleString()
    document.getElementById('stat-tris').textContent = ((grass.count * trisPerBlade) / 1e6).toFixed(2) + 'M'
    document.getElementById('stat-verts').textContent = ((grass.count * welded.attributes.position.count) / 1e6).toFixed(2) + 'M'
  }

  const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2'
  document.getElementById('stat-backend').textContent = backend

  window.grassLab = {
    renderer, scene, camera, controls, uniforms, set, field, grass, quality, mobile, msaa,
    apply(key, value) {
      if (key === 'windOn') return set.windOn(!!value)
      if (key === 'pixelRatio') { quality.pixelRatio = value; renderer.setPixelRatio(Math.min(window.devicePixelRatio, value)); resize(); return }
      if (key === 'msaa') { try { localStorage.setItem('grasslab-msaa', value ? '1' : '0') } catch {} location.reload(); return }
      if (key in field) { field[key] = value; applyField(); return }
      if (/Color$/.test(key)) return set.color(key, value)
      if (set[key]) return set[key](value)
      if (uniforms[key]) uniforms[key].value = value
    },
  }
  applyField()

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // keep the same horizontal view on tall (portrait) screens by widening the vertical FOV
    const baseAspect = 1.6, baseFov = 38
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov / 2)) * baseAspect)
    camera.fov = camera.aspect >= baseAspect ? baseFov
      : Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hHalf) / camera.aspect)))
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  status.hidden = true
  document.dispatchEvent(new CustomEvent('grasslab:ready'))

  // fps plus average frame time in ms (lower is better; 16.7 ms = 60 fps)
  let frames = 0, last = performance.now()
  const fpsEl = document.getElementById('stat-fps'), msEl = document.getElementById('stat-ms')
  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
    frames++
    const now = performance.now()
    if (now - last > 500) {
      fpsEl.textContent = Math.round((frames * 1000) / (now - last))
      msEl.textContent = ((now - last) / frames).toFixed(1)
      frames = 0; last = now
    }
  })
}

export { DEFAULTS }
start().catch((err) => {
  console.error(err)
  const status = document.getElementById('status')
  status.hidden = false
  status.dataset.state = 'error'
  status.textContent = 'Grass Lab could not start: ' + (err && err.message ? err.message : err)
})
