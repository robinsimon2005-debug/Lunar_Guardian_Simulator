import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { fbm3 } from "./noise.js";

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fractured lunar rock: a sphere clipped by random planes (flat, angular
 * faces and sharp edges), then roughened with multi-scale noise. Upward-facing
 * surfaces get a dusty regolith tint, undersides and crevices go darker.
 */
export function makeRockGeometry(seed, detail = 12) {
  const rnd = rng(seed);
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo);

  const planes = [];
  const count = 8 + Math.floor(rnd() * 7);
  for (let i = 0; i < count; i++) {
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    planes.push({
      n: new THREE.Vector3(
        Math.sin(ph) * Math.cos(th),
        Math.cos(ph),
        Math.sin(ph) * Math.sin(th)
      ),
      d: 0.55 + rnd() * 0.4,
    });
  }

  const pos = geo.attributes.position;
  const dir = new THREE.Vector3();
  const off = seed * 3.17;
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    let r = 1.15;
    for (const p of planes) {
      const dp = p.n.dot(dir);
      if (dp > 1e-4) r = Math.min(r, p.d / dp);
    }
    const x = dir.x * r;
    const y = dir.y * r;
    const z = dir.z * r;
    // broad lumps, mid-scale pitting and fine grain
    r *= 1 + (fbm3(x * 1.6 + off, y * 1.6, z * 1.6, 3) - 0.5) * 0.28;
    r *= 1 + (fbm3(x * 5 + off, y * 5, z * 5, 3) - 0.5) * 0.12;
    r *= 1 + (fbm3(x * 14 + off, y * 14, z * 14, 2) - 0.5) * 0.05;
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r);
  }
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const grain = fbm3(x * 4 + off, y * 4, z * 4, 3);
    const patch = fbm3(x * 1.3 + off, y * 1.3 + 9, z * 1.3, 2);
    let v = 0.5 + grain * 0.32 + (patch - 0.5) * 0.22;
    const up = THREE.MathUtils.smoothstep(nrm.getY(i), 0.25, 0.85);
    c.setRGB(v * 0.94, v * 0.92, v * 0.88);
    // dust settled on top surfaces
    c.lerp(new THREE.Color(0.5, 0.46, 0.41), up * 0.55);
    // darker, bluer-grey fresh rock on steep faces
    const steep = 1 - THREE.MathUtils.smoothstep(nrm.getY(i), -0.2, 0.5);
    c.multiplyScalar(1 - steep * 0.12);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

export function makeRockMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
  });
}
