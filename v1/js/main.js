// main.js: the lab scene (hill, scatter, camera, controls panel).
// In R3F this becomes: <Canvas gl={webgpu}> + a <Hill/> mesh + an <instancedMesh/>
// built by buildField(). The material code lives in grassMaterial.js.

import * as THREE from 'three/webgpu'
import { fog, rangeFogFactor, mix, positionWorldDirection, vec2, uniform, positionWorld, smoothstep, length, mx_noise_float } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as blade from './grassPiece.js'
import { createGrassMaterials, DEFAULTS } from './grassMaterial.js'

const MAX_BLADES = 60000
const FIELD = { rx: 8.5, rz: 6.0 } // ellipse radii of the grassy mound, metres

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
// Scatter: precompute MAX_BLADES random spots once (shuffled), then the density
// slider only changes mesh.count. Scale / slope alignment rebuild the matrices.
function seededRandom(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
}

function buildField(bladeGeometry) {
  const rnd = seededRandom(1234)
  const spots = []
  while (spots.length < MAX_BLADES) {
    const x = (rnd() * 2 - 1) * FIELD.rx * 1.12
    const z = (rnd() * 2 - 1) * FIELD.rz * 1.12
    const e = fieldEdge(x, z)
    // thin out toward the edge so the silhouette is tufty, not a hard cut
    if (e > 1 || (e > 0.82 && rnd() > (1 - e) / 0.18)) continue
    spots.push({ x, z, yaw: rnd() * Math.PI * 2, s: rnd(), r: rnd(), edge: e })
  }

  const geo = bladeGeometry.clone()
  const aRoot = new Float32Array(MAX_BLADES * 3)
  const aNormal = new Float32Array(MAX_BLADES * 3)
  const aRand = new Float32Array(MAX_BLADES)
  const n = new THREE.Vector3()
  spots.forEach((sp, i) => {
    const y = heightAt(sp.x, sp.z)
    normalAt(sp.x, sp.z, n)
    aRoot.set([sp.x, y, sp.z], i * 3)
    aNormal.set([n.x, n.y, n.z], i * 3)
    aRand[i] = sp.r
  })
  geo.setAttribute('aRoot', new THREE.InstancedBufferAttribute(aRoot, 3))
  geo.setAttribute('aNormal', new THREE.InstancedBufferAttribute(aNormal, 3))
  geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(aRand, 1))

  return { geo, spots }
}

function writeMatrices(mesh, spots, { scale, sizeVariation, align }) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qYaw = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), p = new THREE.Vector3(), s = new THREE.Vector3()
  spots.forEach((sp, i) => {
    normalAt(sp.x, sp.z, n)
    n.lerp(up, 1 - align).normalize()
    q.setFromUnitVectors(up, n)
    qYaw.setFromAxisAngle(up, sp.yaw)
    q.multiply(qYaw)
    // shorter blades near the edge, plus random size
    const edgeShrink = THREE.MathUtils.clamp(1.25 - sp.edge * 0.45, 0.55, 1)
    const k = scale * (1 - sizeVariation * 0.5 + sizeVariation * sp.s) * edgeShrink
    p.set(sp.x, heightAt(sp.x, sp.z), sp.z)
    m.compose(p, q, s.set(k, k * (0.85 + 0.3 * sp.r), k))
    mesh.setMatrixAt(i, m)
  })
  mesh.instanceMatrix.needsUpdate = true
}

// ---------------------------------------------------------------------------
async function start() {
  const canvas = document.getElementById('view')
  const status = document.getElementById('status')

  status.textContent = 'Starting renderer…'
  // add #webgl to the URL to force the WebGL 2 backend (handy for comparing)
  const makeRenderer = async (forceWebGL) => {
    const r = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL })
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.NoToneMapping // keep the ramp colours exactly as picked

  const scene = new THREE.Scene()
  const skyTop = uniform(new THREE.Color('#6d9fd1'))
  const skyHorizon = uniform(new THREE.Color('#ece3c6'))
  scene.backgroundNode = mix(skyHorizon, skyTop, smoothstep(-0.02, 0.3, positionWorldDirection.y))
  scene.fogNode = fog(skyHorizon, rangeFogFactor(30, 95))

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200)
  camera.position.set(15, 7.5, -19) // sun from the side shows the clumps best
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0.8, 0)
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
  status.textContent = 'Compiling shaders…'

  const { grassMaterial, groundMaterial, uniforms, set } = createGrassMaterials(normalTex)

  // Outside the grass patch the ground fades to a dry meadow colour.
  // (mask = same wobbly ellipse the scatter uses, a little wider)
  const dirt = uniform(new THREE.Color('#8f9a62'))
  const wp = positionWorld.xz.div(vec2(FIELD.rx * 1.02, FIELD.rz * 1.02))
  const edgeNoise = mx_noise_float(positionWorld.mul(0.35)).mul(0.12)
  const inside = smoothstep(1.0, 0.86, length(wp).add(edgeNoise))
  groundMaterial.colorNode = mix(dirt, groundMaterial.colorNode, inside)

  const hill = new THREE.Mesh(makeHillGeometry(), groundMaterial)
  scene.add(hill)

  const { geo, spots } = buildField(bladeGeometry)
  const grass = new THREE.InstancedMesh(geo, grassMaterial, MAX_BLADES)
  grass.frustumCulled = false
  scene.add(grass)

  // field settings live here (they rebuild matrices, not uniforms)
  const field = { density: 26000, scale: 1.06, sizeVariation: 0.55, align: 0.81 }
  const applyField = () => {
    grass.count = Math.min(MAX_BLADES, Math.round(field.density))
    writeMatrices(grass, spots, field)
    updateStats()
  }
  const trisPerBlade = (bladeGeometry.index ? bladeGeometry.index.count : bladeGeometry.attributes.position.count) / 3
  function updateStats() {
    document.getElementById('stat-blades').textContent = grass.count.toLocaleString()
    document.getElementById('stat-tris').textContent = ((grass.count * trisPerBlade) / 1e6).toFixed(2) + 'M'
  }

  const backend = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2'
  document.getElementById('stat-backend').textContent = backend

  window.grassLab = {
    renderer, scene, camera, controls, uniforms, set, field, grass,
    apply(key, value) {
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
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  status.hidden = true
  document.dispatchEvent(new CustomEvent('grasslab:ready'))

  let frames = 0, last = performance.now()
  const fpsEl = document.getElementById('stat-fps')
  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
    frames++
    const now = performance.now()
    if (now - last > 500) { fpsEl.textContent = Math.round((frames * 1000) / (now - last)); frames = 0; last = now }
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
