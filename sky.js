import * as THREE from "three";

export function createSky(site) {
  const group = new THREE.Group();

  const starGeo = new THREE.BufferGeometry();
  const count = 4200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 900;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const warm = Math.random() > 0.85;
    const c = 0.55 + Math.random() * 0.45;
    colors[i * 3] = warm ? 1 : c;
    colors[i * 3 + 1] = warm ? 0.86 : c;
    colors[i * 3 + 2] = warm ? 0.7 : 0.85 + Math.random() * 0.15;
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: false })
  );
  group.add(stars);

  // Earth hangs at a fixed spot in the sky (the group follows the camera, so
  // it behaves like a true distant body). Lit from the sun's side.
  const sunDir = new THREE.Vector3(180, 140, 90).normalize();
  const EARTH_R = 62;
  const EARTH_DIST = 640;
  const az = 0.45 + (site.lon || 0) * 0.002; // slightly right of the start heading (+Z)
  const el = THREE.MathUtils.degToRad(27);
  const earthPos = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az)
  ).multiplyScalar(EARTH_DIST);

  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: earthTexture() },
      clouds: { value: cloudTexture() },
      sunDir: { value: sunDir.clone() },
      cloudShift: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main(){
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position,1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform sampler2D map, clouds; uniform vec3 sunDir; uniform float cloudShift;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main(){
        vec3 n = normalize(vN);
        vec3 base = texture2D(map, vUv).rgb;
        float c = texture2D(clouds, vec2(vUv.x + cloudShift, vUv.y)).r;
        vec3 col = mix(base, vec3(0.96, 0.96, 0.94), c * 0.9);
        float d = dot(n, normalize(sunDir));
        float day = smoothstep(-0.12, 0.28, d);
        vec3 night = base * 0.06 + vec3(0.004, 0.008, 0.02);
        vec3 lit = col * (0.35 + 0.9 * max(d, 0.0));
        vec3 outc = mix(night, lit, day);
        float fres = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 3.0);
        outc += vec3(0.55, 0.68, 0.85) * fres * (0.06 + 0.22 * day);
        gl_FragColor = vec4(outc, 1.0);
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 64), earthMat);
  earth.position.copy(earthPos);
  earth.rotation.z = 0.41; // axial tilt
  group.add(earth);

  // Soft atmosphere halo, billboarded.
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.09, 64, 32),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: { sunDir: { value: sunDir.clone() } },
      vertexShader: `
        varying vec3 vN; varying vec3 vView;
        void main(){
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position,1.0);
          vView = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 sunDir; varying vec3 vN; varying vec3 vView;
        void main(){
          float a = min(1.0, pow(max(dot(-vN, normalize(vView)), 0.0), 1.5) * 1.8);
          gl_FragColor = vec4(vec3(0.5, 0.68, 0.92) * a * 0.22, a * 0.22);
        }`,
    })
  );
  glow.position.copy(earthPos);
  group.add(glow);

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(14, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff4c8 })
  );
  sunMesh.position.copy(sunDir).multiplyScalar(780);
  group.add(sunMesh);
  const sunHalo = new THREE.Mesh(
    new THREE.SphereGeometry(22, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.22 })
  );
  sunHalo.position.copy(sunMesh.position);
  group.add(sunHalo);

  const update = (dt, camera) => {
    group.position.copy(camera.position);
    earth.rotation.y += dt * 0.02;
    earthMat.uniforms.cloudShift.value -= dt * 0.004;
  };
  group.traverse((o) => {
    if (o.material) {
      o.material.depthTest = false;
      o.material.depthWrite = false;
      o.renderOrder = -1000;
    }
  });
  group.renderOrder = -1000;
  return { group, earth, sunMesh, update };
}

function hash(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (
    hash(xi, yi) * (1 - u) * (1 - v) +
    hash(xi + 1, yi) * u * (1 - v) +
    hash(xi, yi + 1) * (1 - u) * v +
    hash(xi + 1, yi + 1) * u * v
  );
}
// Noise sampled on a cylinder so the texture wraps seamlessly in longitude.
function fbm(u, v, scale, oct, seed) {
  let a = 0.5, f = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    const ang = u * Math.PI * 2;
    const r = scale * f;
    sum += a * vnoise(Math.cos(ang) * r + seed + 50 * o, Math.sin(ang) * r + v * r * 0.5 + seed);
    a *= 0.5;
    f *= 2;
  }
  return sum;
}

function earthTexture() {
  const W = 1024, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const lat = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const h = fbm(u, v, 2.6, 5, 3.1) - 0.12 * lat * lat;
      let r, g, b;
      if (lat > 0.88 + (fbm(u, v, 5, 2, 9) - 0.5) * 0.1) {
        r = 235; g = 242; b = 250; // polar ice
      } else if (h > 0.5) {
        const dry = fbm(u, v, 6, 3, 21) + (0.5 - Math.abs(v - 0.5)) * 0.0 + (lat < 0.55 ? 0.12 - lat * 0.25 : 0);
        const hi = Math.min(1, (h - 0.5) * 5);
        if (dry > 0.55 && lat < 0.6) { r = 196; g = 168; b = 108; } // desert
        else { r = 36 + hi * 70; g = 104 + hi * 20 - dry * 20; b = 48 + hi * 30; }
      } else {
        const depth = Math.min(1, (0.5 - h) * 4);
        r = 40 - depth * 18; g = 78 - depth * 28; b = 112 - depth * 34;
      }
      const i = (y * W + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function cloudTexture() {
  const W = 1024, H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = fbm(x / W, y / H, 3.2, 5, 77);
      const m = Math.max(0, Math.min(1, (n - 0.44) * 3.4));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = m * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function createSunLight() {
  const sun = new THREE.DirectionalLight(0xfff1d0, 8.4);
  sun.position.set(180, 140, 90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 520;
  sun.shadow.camera.left = -160;
  sun.shadow.camera.right = 160;
  sun.shadow.camera.top = 160;
  sun.shadow.camera.bottom = -160;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.04;
  const fill = new THREE.AmbientLight(0x020308, 0.04);
  const earthshine = new THREE.HemisphereLight(0x0a1020, 0x000000, 0.08);
  earthshine.position.set(-80, 40, -40);
  return { sun, fill, earthshine };
}
