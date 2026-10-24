import * as THREE from "three";
import { fbm, hash } from "./noise.js";
import { makeRockGeometry, makeRockMaterial } from "./rocks.js";

export const WORLD_SIZE = 420;
const MOON_R = 12000;
const FAR_LEVELS = [
  { cell: 70, rmin: 5, rmax: 20, p: 0.55 },
  { cell: 150, rmin: 12, rmax: 46, p: 0.65 },
  { cell: 520, rmin: 60, rmax: 190, p: 0.7 },
  { cell: 1700, rmin: 220, rmax: 640, p: 0.7 },
]; // visual curvature radius (world units)
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Terrain {
  constructor(siteSeed = 1) {
    this.worldSize = WORLD_SIZE;
    this.seed = siteSeed;
    this.sunDir = new THREE.Vector3(0.55, 0.42, 0.28).normalize();
    this.craters = this._makeCraters();
    this.blocked = [];
    this.group = new THREE.Group();
    this.seg = 160;

    // Non-uniform grid: fine detail across the playable square, then cells
    // grow geometrically so the surface runs out to a curved lunar horizon.
    const half = this.worldSize * 0.5;
    const axis = [];
    const step = this.worldSize / this.seg;
    const FAR_STEPS = 46;
    const GROW = 1.12;
    for (let i = FAR_STEPS; i >= 1; i--) {
      axis.push(-half - (step * (Math.pow(GROW, i) - 1)) / (GROW - 1));
    }
    for (let i = 0; i <= this.seg; i++) axis.push(-half + i * step);
    for (let i = 1; i <= FAR_STEPS; i++) {
      axis.push(half + (step * (Math.pow(GROW, i) - 1)) / (GROW - 1));
    }
    const n = axis.length;
    const posArr = new Float32Array(n * n * 3);
    const uvArr = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        posArr[k * 3] = axis[i];
        posArr[k * 3 + 2] = axis[j];
        uvArr[k * 2] = axis[i] / this.worldSize + 0.5;
        uvArr[k * 2 + 1] = axis[j] / this.worldSize + 0.5;
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const pos = geo.attributes.position;
    this.heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.heightAt(x, z);
      pos.setY(i, y);
      this.heights[i] = y;
    }
    geo.computeVertexNormals();
    this._baseColors = new Float32Array(pos.count * 3);
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      const far = smooth(200, 900, Math.hypot(px, pz));
      const mare = fbm(px * 0.0011 + this.seed * 5, pz * 0.0011, 3);
      const n =
        (0.28 + fbm(px * 0.08 + this.seed, pz * 0.08) * 0.22) *
        (1 - far * 0.35 * smooth(0.35, 0.6, mare) + far * 0.12 * (1 - smooth(0.35, 0.6, mare)));
      const c = new THREE.Color().setHSL(0.08, 0.08, n);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      this._baseColors[i * 3] = c.r;
      this._baseColors[i * 3 + 1] = c.g;
      this._baseColors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.geometry = geo;

    const tex = this._regolithTexture();
    const nrm = this._regolithNormal();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: tex,
      normalMap: nrm,
      normalScale: new THREE.Vector2(1.55, 1.55),
      roughness: 0.94,
      metalness: 0,
      envMapIntensity: 0.1,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.group.add(this.mesh);

    this._addBoulders();
    this._addTracksGroup();
  }

  _makeCraters() {
    const rng = (i) => fbm(i * 1.7 + this.seed, i * 4.1);
    const list = [
      { x: 40, z: -30, r: 48, d: 18 },
      { x: -90, z: 70, r: 36, d: 12 },
      { x: 110, z: 95, r: 28, d: 10 },
      { x: -40, z: -120, r: 55, d: 16 },
      { x: 20, z: 140, r: 22, d: 8 },
    ];
    for (let i = 0; i < 18; i++) {
      list.push({
        x: (rng(i) - 0.5) * 360,
        z: (rng(i + 40) - 0.5) * 360,
        r: 6 + rng(i + 80) * 16,
        d: 2 + rng(i + 120) * 6,
      });
    }
    return list;
  }

  heightAt(x, z) {
    const nx = (x + this.seed * 20) * 0.008;
    const nz = (z - this.seed * 13) * 0.008;
    let h = (fbm(nx, nz, 6) - 0.5) * 22;
    h += (fbm(nx * 3.2, nz * 3.2, 3) - 0.5) * 4.5;
    for (const c of this.craters) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.r * 1.25) {
        const t = d / c.r;
        const bowl = Math.exp(-t * t * 3.4);
        const rim = Math.exp(-((t - 1) * (t - 1)) * 18) * c.d * 0.28;
        h -= bowl * c.d;
        h += rim;
      }
    }
    // Beyond the playable square the Moon keeps going: highlands, big craters
    // and a gentle planetary curvature that makes a true horizon.
    h += this._farRelief(x, z);
    h -= (x * x + z * z) / (2 * MOON_R);
    return h;
  }

  _cellCrater(L, i, j) {
    const { cell, rmin, rmax, p } = FAR_LEVELS[L];
    const sd = this.seed;
    const k = L * 31.7 + sd;
    if (hash(i * 7.13 + k, j * 3.71 + k) > p) return null;
    return {
      cx: (i + 0.15 + 0.7 * hash(i + 1.7 + k, j + 9.2)) * cell,
      cz: (j + 0.15 + 0.7 * hash(i + 4.1, j + 2.9 + k)) * cell,
      rad: rmin + (rmax - rmin) * hash(i + 5.3 + k, j + 2.1),
      fresh: hash(i * 1.37 + k, j * 2.11 + k) > 0.7,
    };
  }

  _farRelief(x, z) {
    const cheb = Math.max(Math.abs(x), Math.abs(z));
    const e = smooth(150, 320, cheb);
    if (e <= 0) return 0;
    const r = Math.hypot(x, z);
    let h = 0;
    const sd = this.seed;

    const m = smooth(200, 1300, r) * e;
    h += (fbm(x * 0.0017 + sd * 7, z * 0.0017 - sd * 3, 5) - 0.42) * 700 * m;
    h += (fbm(x * 0.006 + sd, z * 0.006, 4) - 0.5) * 36 * e;

    let cr = 0;
    for (let L = 0; L < FAR_LEVELS.length; L++) {
      const { cell } = FAR_LEVELS[L];
      const ci = Math.floor(x / cell);
      const cj = Math.floor(z / cell);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const c = this._cellCrater(L, ci + di, cj + dj);
          if (!c) continue;
          const rad = c.rad;
          const t = Math.hypot(x - c.cx, z - c.cz) / rad;
          if (t > 1.5) continue;
          const depth = rad * 0.2;
          const floor = 1 - smooth(0.55, 1.0, t);
          const rim = Math.exp(-((t - 1.05) * (t - 1.05)) * 28) * depth * 0.4;
          cr += rim - floor * depth;
        }
      }
    }
    return h + cr * e;
  }

  slopeAt(x, z) {
    const e = 1.6;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const n = new THREE.Vector3(-dx, 2 * e, -dz).normalize();
    return (Math.acos(Math.max(-1, Math.min(1, n.y))) * 180) / Math.PI;
  }

  normalAt(x, z) {
    const e = 1.4;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return new THREE.Vector3(-dx, 2 * e, -dz).normalize();
  }

  illuminationAt(x, z) {
    const n = this.normalAt(x, z);
    return Math.max(0, n.dot(this.sunDir));
  }

  roughnessAt(x, z) {
    const a = this.heightAt(x, z);
    const b = this.heightAt(x + 3, z);
    const c = this.heightAt(x, z + 3);
    return Math.min(1, (Math.abs(a - b) + Math.abs(a - c)) * 0.18);
  }

  safetyIndex(x, z) {
    const w1 = 0.45;
    const w2 = 0.35;
    const w3 = 0.2;
    const slope = this.slopeAt(x, z) / 45;
    const shadow = 1 - this.illuminationAt(x, z);
    const rough = this.roughnessAt(x, z);
    return w1 * slope + w2 * shadow + w3 * rough;
  }

  isBlocked(x, z) {
    if (Math.abs(x) > this.worldSize * 0.48 || Math.abs(z) > this.worldSize * 0.48) return true;
    if (this.blocked.some((b) => Math.hypot(x - b.x, z - b.z) < b.r)) return true;
    if (this.boulderData?.some((b) => b.r >= 1.8 && Math.hypot(x - b.x, z - b.z) < b.r * 1.15 + 2.9)) return true;
    return false;
  }

  addBlock(x, z, r) {
    this.blocked.push({ x, z, r });
  }

  _regolithNormal() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const hL = fbm((x - 1) * 0.12, y * 0.12, 4);
        const hR = fbm((x + 1) * 0.12, y * 0.12, 4);
        const hD = fbm(x * 0.12, (y - 1) * 0.12, 4);
        const hU = fbm(x * 0.12, (y + 1) * 0.12, 4);
        const nx = (hL - hR) * 4.5;
        const ny = (hD - hU) * 4.5;
        const i = (y * 256 + x) * 4;
        img.data[i] = THREE.MathUtils.clamp(128 + nx * 127, 0, 255);
        img.data[i + 1] = THREE.MathUtils.clamp(128 + ny * 127, 0, 255);
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(28, 28);
    return tex;
  }

  _regolithTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const n = fbm(x * 0.08, y * 0.08, 4);
        const v = 90 + n * 70;
        const i = (y * 256 + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v * 0.92;
        img.data[i + 2] = v * 0.8;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(28, 28);
    tex.anisotropy = 8;
    return tex;
  }

  _addBoulders() {
    const mat = makeRockMaterial();
    const seedI = Math.floor(this.seed * 10);
    const VARIANTS = 5;
    const big = Array.from({ length: VARIANTS }, (_, k) =>
      makeRockGeometry(11 + k * 7 + seedI, 12)
    );
    const small = Array.from({ length: 4 }, (_, k) =>
      makeRockGeometry(101 + k * 13 + seedI, 6)
    );
    const rnd = (i, k) => hash(i * 12.9898 + k * 78.233, this.seed * 3.1 + k);

    const count = 90;
    const bigList = Array.from({ length: VARIANTS }, () => []);
    const smallList = Array.from({ length: small.length }, () => []);
    this.boulderData = [];

    for (let i = 0; i < count; i++) {
      let x = (fbm(i * 2.2, this.seed) - 0.5) * 380;
      let z = (fbm(i * 3.7, this.seed + 4) - 0.5) * 380;
      if (i % 5 !== 0) {
        // Most boulders sit on crater walls and rims, as on the real Moon.
        const c = this.craters[i % this.craters.length];
        const a = rnd(i, 81) * Math.PI * 2;
        const d = c.r * (0.8 + rnd(i, 82) * 0.6);
        x = THREE.MathUtils.clamp(c.x + Math.cos(a) * d, -190, 190);
        z = THREE.MathUtils.clamp(c.z + Math.sin(a) * d, -190, 190);
      }
      const s = 1.0 + Math.min(4.2, 0.4 * Math.pow(1 - rnd(i, 83) * 0.999, -1 / 1.5));
      this.boulderData.push({ x, z, r: s * 1.1 });
      bigList[i % VARIANTS].push({
        x,
        z,
        sx: s * (0.9 + rnd(i, 1) * 0.55),
        sy: s * (0.5 + rnd(i, 2) * 0.35),
        sz: s * (0.85 + rnd(i, 3) * 0.5),
        ry: rnd(i, 4) * Math.PI * 2,
        tx: (rnd(i, 5) - 0.5) * 0.35,
        tz: (rnd(i, 6) - 0.5) * 0.35,
        sink: 0.12 + rnd(i, 7) * 0.12,
      });
    }

    // Scattered rubble, plus debris fields around the larger boulders.
    let n = 0;
    const addSmall = (x, z, size, j) => {
      smallList[n++ % small.length].push({
        x,
        z,
        sx: size * (0.8 + rnd(j, 11) * 0.7),
        sy: size * (0.5 + rnd(j, 12) * 0.5),
        sz: size * (0.8 + rnd(j, 13) * 0.7),
        ry: rnd(j, 14) * Math.PI * 2,
        tx: (rnd(j, 15) - 0.5) * 0.6,
        tz: (rnd(j, 16) - 0.5) * 0.6,
        sink: 0.15 + rnd(j, 17) * 0.2,
      });
    };
    for (let j = 0; j < 700; j++) {
      const x = (rnd(j, 21) - 0.5) * 400;
      const z = (rnd(j, 22) - 0.5) * 400;
      addSmall(x, z, 0.12 + Math.pow(rnd(j, 23), 2.4) * 0.85, j);
    }
    let j = 1000;
    for (const b of this.boulderData) {
      if (b.r < 2.6) continue;
      for (let k = 0; k < 7; k++, j++) {
        const ang = rnd(j, 31) * Math.PI * 2;
        const dist = b.r * (0.7 + rnd(j, 32) * 0.9);
        addSmall(
          b.x + Math.cos(ang) * dist,
          b.z + Math.sin(ang) * dist,
          0.15 + Math.pow(rnd(j, 33), 2) * 0.7,
          j
        );
      }
    }

    const dummy = new THREE.Object3D();
    const _v = new THREE.Vector3();
    // Lowest vertices of a rock geometry (local space) so we can find its true
    // underside after scale + tilt, instead of assuming it is at y = -1.
    const lowCache = new Map();
    const lowVerts = (geo) => {
      if (lowCache.has(geo)) return lowCache.get(geo);
      const pos = geo.attributes.position;
      const arr = [];
      for (let i = 0; i < pos.count; i++) arr.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      arr.sort((a, b) => a[1] - b[1]);
      const low = arr.slice(0, Math.min(arr.length, 120));
      lowCache.set(geo, low);
      return low;
    };
    const build = (geo, list) => {
      if (!list.length) return;
      const low = lowVerts(geo);
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      list.forEach((r, idx) => {
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(r.tx, r.ry, r.tz);
        dummy.scale.set(r.sx, r.sy, r.sz);
        dummy.updateMatrix();
        // Underside of the rock relative to its centre.
        let minY = Infinity;
        for (const v of low) {
          _v.set(v[0], v[1], v[2]).applyMatrix4(dummy.matrix);
          if (_v.y < minY) minY = _v.y;
        }
        // Lowest terrain under the footprint: on slopes and crater walls the
        // downhill side must still touch the ground, not hang in the air.
        const fr = Math.max(r.sx, r.sz) * 0.8;
        let ground = this.heightAt(r.x, r.z);
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          ground = Math.min(ground, this.heightAt(r.x + Math.cos(ang) * fr, r.z + Math.sin(ang) * fr));
        }
        // Bury the underside a little so there is never a gap.
        const bury = Math.max(0.05, Math.abs(minY) * (r.sink || 0.15) * 0.6);
        dummy.position.set(r.x, ground - minY - bury, r.z);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    };
    // Boulders on the non-playable surface follow real lunar geology: rocks are
    // excavated by impacts, so they pile up on crater walls and in ejecta
    // blankets (thickest around young craters) and thin out with distance from
    // the rim. The open plains between craters stay mostly bare regolith.
    // Sizes follow a power law: many small rocks, very few big blocks.
    const farGeo = Array.from({ length: 4 }, (_, k) => makeRockGeometry(301 + k * 17 + seedI, 3));
    const farLists = farGeo.map(() => []);
    const half = this.worldSize * 0.5 + 4;
    const MAX_FAR = 4200;
    let placed = 0;
    let q = 0;
    const addFar = (x, z, s) => {
      if (placed >= MAX_FAR) return;
      if (Math.abs(x) < half && Math.abs(z) < half) return;
      q++;
      farLists[placed % farGeo.length].push({
        x,
        z,
        sx: s * (0.85 + rnd(q, 47) * 0.6),
        sy: s * (0.45 + rnd(q, 48) * 0.35),
        sz: s * (0.8 + rnd(q, 49) * 0.55),
        ry: rnd(q, 50) * Math.PI * 2,
        tx: (rnd(q, 51) - 0.5) * 0.4,
        tz: (rnd(q, 52) - 0.5) * 0.4,
        sink: 0.15 + rnd(q, 53) * 0.2,
      });
      placed++;
    };
    const rockSize = (u) => Math.min(5.5, 0.45 * Math.pow(1 - u * 0.9995, -1 / 1.6));
    for (let L = 0; L < 3; L++) {
      const { cell } = FAR_LEVELS[L];
      const reach = [520, 900, 1500][L];
      const n = Math.ceil(reach / cell);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const c = this._cellCrater(L, i, j);
          if (!c || c.rad < 9) continue;
          if (Math.hypot(c.cx, c.cz) > reach) continue;
          // Young craters shed far more rock than old, softened ones.
          const count = Math.round(c.rad * (c.fresh ? 1.8 : 0.35) * (L === 2 ? 0.6 : 1));
          for (let r = 0; r < count; r++) {
            const key = (i * 73856093) ^ (j * 19349663) ^ (L * 83492791) ^ (r * 2654435);
            const ang = rnd(key, 61) * Math.PI * 2;
            // Rocks cluster on the wall/rim (t ~ 0.8-1.2), thinning outward.
            const u = rnd(key, 62);
            const tt = u < 0.45 ? 0.75 + rnd(key, 63) * 0.4 : 1.1 + Math.pow(rnd(key, 64), 2) * (c.fresh ? 1.6 : 0.8);
            const x = c.cx + Math.cos(ang) * c.rad * tt;
            const z = c.cz + Math.sin(ang) * c.rad * tt;
            addFar(x, z, rockSize(rnd(key, 65)));
          }
        }
      }
    }
    // A thin scatter of isolated rocks on the plains, mostly small.
    for (let j = 0; j < 500; j++) {
      const ang = rnd(j, 71) * Math.PI * 2;
      const d = 230 + Math.pow(rnd(j, 72), 1.4) * 900;
      addFar(Math.cos(ang) * d, Math.sin(ang) * d, Math.min(1.6, rockSize(rnd(j, 73))));
    }
    farGeo.forEach((g, k) => {
      build(g, farLists[k]);
      const m = this.group.children[this.group.children.length - 1];
      if (m && m.isInstancedMesh) {
        m.castShadow = false;
        m.frustumCulled = false;
      }
    });

    big.forEach((g, k) => build(g, bigList[k]));
    small.forEach((g, k) => build(g, smallList[k]));
  }

  _addTracksGroup() {
    this.tracks = new THREE.Group();
    this.group.add(this.tracks);
    this._trackMat = new THREE.MeshStandardMaterial({
      color: 0x2a241f,
      roughness: 0.9,
      metalness: 0,
    });
  }

  stampTrack(x, z, heading) {
    if (this.tracks.children.length > 400) {
      const old = this.tracks.children[0];
      this.tracks.remove(old);
      old.geometry.dispose();
    }
    const geo = new THREE.CircleGeometry(0.45, 8);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, this._trackMat);
    const y = this.heightAt(x, z) + 0.04;
    m.position.set(x, y, z);
    m.rotation.y = heading;
    this.tracks.add(m);
  }

  applyLayer(mode, targets = []) {
    const colors = this.geometry.attributes.color;
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (Math.abs(x) > this.worldSize * 0.5 + 2 || Math.abs(z) > this.worldSize * 0.5 + 2) {
        const f = mode === 0 ? 1 : 0.25;
        colors.setXYZ(
          i,
          this._baseColors[i * 3] * f,
          this._baseColors[i * 3 + 1] * f,
          this._baseColors[i * 3 + 2] * f
        );
        continue;
      }
      let col = new THREE.Color(
        this._baseColors[i * 3],
        this._baseColors[i * 3 + 1],
        this._baseColors[i * 3 + 2]
      );
      if (mode === 1) {
        const h = (this.heights[i] + 20) / 40;
        col.setHSL(0.08, 0.35, THREE.MathUtils.clamp(h, 0.08, 0.85));
      } else if (mode === 2) {
        const s = this.slopeAt(x, z) / 40;
        col.setRGB(s, 1 - s, 0.15);
      } else if (mode === 3) {
        const ill = this.illuminationAt(x, z);
        col.setRGB(ill * 1.1, ill * 0.45, 0.08 + (1 - ill) * 0.55);
      } else if (mode === 4) {
        const r = this.roughnessAt(x, z);
        const blocked = this.isBlocked(x, z) ? 1 : 0;
        col.setRGB(0.2 + r + blocked, 0.2, 0.25 + r);
      } else if (mode === 5) {
        const safe = 1 - THREE.MathUtils.clamp(this.safetyIndex(x, z), 0, 1);
        col.setRGB(1 - safe, safe, 0.12);
        for (const t of targets) {
          if (Math.hypot(x - t.x, z - t.z) < 8) col.setRGB(0.2, 0.9, 1);
        }
      }
      colors.setXYZ(i, col.r, col.g, col.b);
    }
    colors.needsUpdate = true;
  }

  sampleHeightField(res = 220) {
    return this.sampleOverlayField(0, [], res);
  }

  sampleOverlayField(mode = 0, targets = [], res = 160) {
    const data = new Uint8ClampedArray(res * res * 4);
    const half = this.worldSize * 0.5;
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const wx = -half + (x / (res - 1)) * this.worldSize;
        const wz = -half + (z / (res - 1)) * this.worldSize;
        const h = (this.heightAt(wx, wz) + 18) / 36;
        const v = THREE.MathUtils.clamp(h, 0, 1);
        let r = v * 0.55;
        let g = v * 0.58;
        let b = v * 0.62;
        if (mode === 1) {
          r = v;
          g = v * 0.55;
          b = v * 0.28;
        } else if (mode === 2) {
          const s = THREE.MathUtils.clamp(this.slopeAt(wx, wz) / 40, 0, 1);
          r = s;
          g = 1 - s;
          b = 0.15;
        } else if (mode === 3) {
          const ill = this.illuminationAt(wx, wz);
          r = ill;
          g = ill * 0.45;
          b = 0.08 + (1 - ill) * 0.55;
        } else if (mode === 4) {
          const rough = this.roughnessAt(wx, wz);
          const blocked = this.isBlocked(wx, wz) ? 1 : 0;
          r = 0.2 + rough + blocked;
          g = 0.2;
          b = 0.25 + rough;
        } else if (mode === 5) {
          const safe = 1 - THREE.MathUtils.clamp(this.safetyIndex(wx, wz), 0, 1);
          r = 1 - safe;
          g = safe;
          b = 0.12;
          for (const t of targets) {
            if (Math.hypot(wx - t.x, wz - t.z) < 10) {
              r = 0.2;
              g = 0.9;
              b = 1;
            }
          }
        }
        const i = (z * res + x) * 4;
        data[i] = THREE.MathUtils.clamp(r, 0, 1) * 255;
        data[i + 1] = THREE.MathUtils.clamp(g, 0, 1) * 255;
        data[i + 2] = THREE.MathUtils.clamp(b, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
    return { data, res };
  }
}
