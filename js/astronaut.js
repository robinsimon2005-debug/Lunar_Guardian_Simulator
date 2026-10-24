import * as THREE from "three";
import { loadGlb } from "./models.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const G = 1.62;
const THRUST = 9.4;
const MAX_SPEED = 28;

export class Astronaut {
  constructor(terrain, spawn) {
    this.terrain = terrain;
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0.15;
    this.heat = 0;
    this.fuel = 1;
    this.distance = 0;
    this.powerUsed = 0;

    this.group = this._build();

    const y = terrain.heightAt(spawn.x, spawn.z) + 3.2;
    this.group.position.set(spawn.x, y, spawn.z);

    this._dust = this._makeDust();
    this.group.add(this._dust);

    this.thrusting = false;
    this.nearGround = false;
  }

  _build() {
    const g = new THREE.Group();

    this.nozzles = [];
    this.flames = [];
    this.wristPad = null;

    // Load the supplied NASA Z2 Spacesuit model.
    const dracoLoader = new DRACOLoader();

    dracoLoader.setDecoderPath(new URL("../draco/", import.meta.url).href);

    dracoLoader.setDecoderConfig({ type: "js" });
    dracoLoader.preload();

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    loadGlb(loader, "suit",

      (gltf) => {
        const model = gltf.scene;

        model.updateMatrixWorld(true);

        // Measure the model before scaling.
        let bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());

        // Scale the astronaut to approximately 2.35 world units tall.
        model.scale.setScalar(
          2.35 / Math.max(size.y, 0.001)
        );

        model.updateMatrixWorld(true);

        // Recalculate bounds after scaling.
        bounds = new THREE.Box3().setFromObject(model);

        const center = bounds.getCenter(new THREE.Vector3());

        // Center the model horizontally and place its lowest point at y = 0.
        model.position.x -= center.x;
        model.position.y -= bounds.min.y;
        model.position.z -= center.z;

        model.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        // Add the supplied model only once.
        g.add(model);
        this.model = model;

        dracoLoader.dispose();
      },

      undefined,

      (error) => {
        dracoLoader.dispose();

        console.error(
          "Unable to load Z2 Spacesuit GLB:",
          error
        );
      }
    );

    // Preserve compatibility with the existing game logic.
    this.canister = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.08,
        0.08,
        0.32,
        10
      ),
      new THREE.MeshStandardMaterial({
        color: 0x9b7bff,
        emissive: 0x331166,
        metalness: 0.4,
        roughness: 0.3,
      })
    );

    this.canister.position.set(0.62, 0.72, 0.22);
    this.canister.visible = false;

    g.add(this.canister);

    this._buildThrusters(g);

    return g;
  }

  // Visible MMU / backpack thruster nozzles. Each one fires opposite to its
  // exhaust direction, so pressing a movement key lights up the matching jets.
  _buildThrusters(g) {
    this.thrusters = [];
    const flameGeo = new THREE.ConeGeometry(0.13, 1, 14, 1, true);
    flameGeo.translate(0, 0.5, 0); // base at origin, tip along +Y
    const coreGeo = new THREE.ConeGeometry(0.06, 1, 10, 1, true);
    coreGeo.translate(0, 0.5, 0);
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0x8a8f99,
      metalness: 0.8,
      roughness: 0.35,
    });
    const glowTex = this._glowTexture();

    const defs = [
      // [x, y, z, exhaust dir x, y, z, length]
      [-0.26, 0.95, -0.42, 0, -1, 0, 1.5], // thrust up
      [0.26, 0.95, -0.42, 0, -1, 0, 1.5],
      [-0.26, 1.95, -0.42, 0, 1, 0, 1.1], // thrust down
      [0.26, 1.95, -0.42, 0, 1, 0, 1.1],
      [-0.2, 1.35, -0.55, 0, 0, -1, 1.4], // thrust forward
      [0.2, 1.35, -0.55, 0, 0, -1, 1.4],
      [-0.4, 1.55, 0.3, 0, 0, 1, 1.0], // thrust backward
      [0.4, 1.55, 0.3, 0, 0, 1, 1.0],
      [0.55, 1.4, -0.1, 1, 0, 0, 1.0], // thrust left
      [-0.55, 1.4, -0.1, -1, 0, 0, 1.0], // thrust right
    ];

    for (const [x, y, z, ex, ey, ez, len] of defs) {
      const exhaust = new THREE.Vector3(ex, ey, ez);
      const holder = new THREE.Group();
      holder.position.set(x, y, z);
      holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), exhaust);

      // Metal nozzle bell (flared end points along the exhaust).
      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.055, 0.2, 12, 1, true),
        nozzleMat
      );
      bell.rotation.x = 0; // narrow end toward body
      bell.position.y = 0.08;
      bell.material.side = THREE.DoubleSide;
      holder.add(bell);

      const outer = new THREE.Mesh(
        flameGeo,
        new THREE.MeshBasicMaterial({
          color: 0x59a8ff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        })
      );
      const core = new THREE.Mesh(
        coreGeo,
        new THREE.MeshBasicMaterial({
          color: 0xfff2d8,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        })
      );
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: 0x7fc4ff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        })
      );
      glow.position.y = 0.15;
      holder.add(outer, core, glow);
      g.add(holder);

      this.thrusters.push({
        holder,
        outer,
        core,
        glow,
        len,
        dir: exhaust,
        level: 0,
        seed: Math.random() * 10,
      });
    }

    this._thrustLight = new THREE.PointLight(0x8cc8ff, 0, 14, 1.6);
    this._thrustLight.position.set(0, 1.3, -0.6);
    g.add(this._thrustLight);

    // World-space exhaust sparks.
    const n = 160;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this._sparks = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: glowTex,
        color: 0xbfe0ff,
        size: 0.55,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      })
    );
    this._sparks.frustumCulled = false;
    this._sparkLife = new Float32Array(n);
    this._sparkVel = Array.from({ length: n }, () => new THREE.Vector3());
    this._sparkPos = new Float32Array(n * 3).fill(-9999);
    geo.attributes.position.array.set(this._sparkPos);
  }

  _glowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.3, "rgba(255,255,255,0.45)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  _updateThrusters(dt, thrustDir) {
    // Thrust direction in the astronaut's local frame.
    const local = thrustDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    const t = performance.now() * 0.001;
    let total = 0;

    for (const th of this.thrusters) {
      const want = this.thrusting ? Math.max(0, local.dot(th.dir.clone().negate())) : 0;
      const target = want > 0.2 ? Math.min(1, want * 1.1) : 0;
      th.level += (target - th.level) * Math.min(1, dt * 18);
      const l = th.level;
      total += l;
      const flick = 0.85 + 0.3 * Math.sin(t * 60 + th.seed) * Math.random();
      const len = th.len * l * flick;
      const w = 0.7 + 0.5 * l;
      th.outer.scale.set(w, Math.max(0.001, len), w);
      th.core.scale.set(w, Math.max(0.001, len * 0.6), w);
      th.outer.material.opacity = 0.75 * Math.min(1, l * 1.5);
      th.core.material.opacity = 0.95 * Math.min(1, l * 1.5);
      th.glow.material.opacity = 0.9 * l;
      th.glow.scale.setScalar(0.9 + 0.7 * l * flick);
      th.outer.visible = th.core.visible = l > 0.02;
    }

    this._thrustLight.intensity = Math.min(5, total * 1.6);
    this._emitSparks(dt, total);
  }

  _emitSparks(dt, total) {
    const parent = this.group.parent;
    if (parent && this._sparks.parent !== parent) parent.add(this._sparks);
    const pos = this._sparks.geometry.attributes.position;
    const wp = new THREE.Vector3();
    const wd = new THREE.Vector3();
    const active = this.thrusters.filter((th) => th.level > 0.3);
    let budget = Math.floor(total * 90 * dt + Math.random());

    for (let i = 0; i < this._sparkLife.length; i++) {
      this._sparkLife[i] -= dt;
      if (this._sparkLife[i] <= 0) {
        if (budget > 0 && active.length) {
          const th = active[(Math.random() * active.length) | 0];
          th.holder.getWorldPosition(wp);
          wd.copy(th.dir).applyQuaternion(this.group.quaternion);
          const k = Math.random() * 0.8;
          pos.setXYZ(i, wp.x + wd.x * k, wp.y + wd.y * k, wp.z + wd.z * k);
          this._sparkVel[i]
            .copy(wd)
            .multiplyScalar(5 + Math.random() * 5)
            .add(this.velocity.clone().multiplyScalar(0.4))
            .add(
              new THREE.Vector3(
                (Math.random() - 0.5) * 1.8,
                (Math.random() - 0.5) * 1.8,
                (Math.random() - 0.5) * 1.8
              )
            );
          this._sparkLife[i] = 0.25 + Math.random() * 0.45;
          budget--;
        } else {
          pos.setXYZ(i, 0, -9999, 0);
        }
        continue;
      }
      pos.setXYZ(
        i,
        pos.getX(i) + this._sparkVel[i].x * dt,
        pos.getY(i) + this._sparkVel[i].y * dt,
        pos.getZ(i) + this._sparkVel[i].z * dt
      );
    }
    pos.needsUpdate = true;
  }

  _makeDust() {
    const geo = new THREE.BufferGeometry();
    const n = 80;

    const pos = new Float32Array(n * 3);

    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(pos, 3)
    );

    const mat = new THREE.PointsMaterial({
      color: 0xc2b39a,
      size: 0.35,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });

    this._dustLife = new Float32Array(n);
    this._dustVel = [];

    for (let i = 0; i < n; i++) {
      this._dustVel.push(new THREE.Vector3());
    }

    return new THREE.Points(geo, mat);
  }

  get position() {
    return this.group.position;
  }

  update(dt, input, extracting, wristOpen = false) {
    this.yaw = input.look.x;
    this.pitch = input.look.y;

    this.group.rotation.y = this.yaw;

    const ground = this.terrain.heightAt(
      this.position.x,
      this.position.z
    );

    const clearance = this.position.y - ground;

    this.nearGround = clearance < 4.2;

    const thrust = new THREE.Vector3();

    if (!extracting) {
      const axis = input.axis();

      const forward = new THREE.Vector3(
        Math.sin(this.yaw),
        0,
        Math.cos(this.yaw)
      );

      const right = new THREE.Vector3(
        -Math.cos(this.yaw),
        0,
        Math.sin(this.yaw)
      );

      thrust.addScaledVector(right, axis.x);
      thrust.addScaledVector(forward, -axis.z);

      if (input.down("Space")) {
        thrust.y += 1;
      }

      if (
        input.down("ShiftLeft") ||
        input.down("ShiftRight")
      ) {
        thrust.y -= 1;
      }
    }

    this.thrusting =
      thrust.lengthSq() > 0.01 &&
      this.fuel > 0 &&
      this.heat < 1;

    const overheat = this.heat > 0.92;
    const scale = overheat ? 0.35 : 1;

    const thrustDir = new THREE.Vector3();
    if (this.thrusting) {
      thrust.normalize();
      thrustDir.copy(thrust);

      this.velocity.addScaledVector(
        thrust,
        THRUST * scale * dt
      );

      this.fuel = Math.max(
        0,
        this.fuel - dt * 0.012
      );

      this.heat = Math.min(
        1,
        this.heat + dt * 0.18
      );

      this.powerUsed += dt * 1.4;
    } else {
      this.heat = Math.max(
        0,
        this.heat - dt * 0.22
      );
    }

    // Lunar gravity and momentum damping.
    this.velocity.y -= G * dt;
    this.velocity.multiplyScalar(1 - dt * 0.045);

    if (this.velocity.length() > MAX_SPEED) {
      this.velocity.setLength(MAX_SPEED);
    }

    const before = this.position.clone();

    this.position.addScaledVector(
      this.velocity,
      dt
    );

    this.distance += this.position.distanceTo(before);

    // Prevent the astronaut from passing through the surface.
    const h = this.terrain.heightAt(
      this.position.x,
      this.position.z
    );

    if (this.position.y < h + 1.15) {
      this.position.y = h + 1.15;

      if (this.velocity.y < 0) {
        this.velocity.y *= -0.12;
      }

      this.velocity.x *= 0.985;
      this.velocity.z *= 0.985;
    }

    // Keep the astronaut within the terrain boundary.
    const half = this.terrain.worldSize * 0.48;

    this.position.x = THREE.MathUtils.clamp(
      this.position.x,
      -half,
      half
    );

    this.position.z = THREE.MathUtils.clamp(
      this.position.z,
      -half,
      half
    );

    // Boulder collision.
    for (const b of this.terrain.boulderData || []) {
      if (b.r < 2.6) continue;

      const d = Math.hypot(
        this.position.x - b.x,
        this.position.z - b.z
      );

      const min = b.r * 0.65 + 0.55;

      if (
        d > 0.001 &&
        d < min &&
        this.position.y <
          this.terrain.heightAt(b.x, b.z) + b.r * 1.2
      ) {
        const nx = (this.position.x - b.x) / d;
        const nz = (this.position.z - b.z) / d;

        this.position.x = b.x + nx * min;
        this.position.z = b.z + nz * min;

        this.velocity.x += nx * 1.8;
        this.velocity.z += nz * 1.8;
      }
    }

    // Jetpack visual effects.
    this._updateThrusters(dt, thrustDir);

    // Wrist display compatibility.
    if (this.wristPad) {
      this.wristPad.material.emissiveIntensity =
        wristOpen ? 2.4 : 0.35;

      this.wristPad.material.color.setHex(
        wristOpen ? 0x9ff2ff : 0x5ce1ff
      );
    }

    this._updateDust(dt);
  }

  _updateDust(dt) {
    const pos = this._dust.geometry.attributes.position;

    const show = this.thrusting && this.nearGround;

    this._dust.material.opacity = THREE.MathUtils.lerp(
      this._dust.material.opacity,
      show ? 0.7 : 0,
      dt * 6
    );

    for (let i = 0; i < pos.count; i++) {
      this._dustLife[i] -= dt;

      if (show && this._dustLife[i] <= 0) {
        this._dustLife[i] = 0.4 + Math.random() * 0.5;

        pos.setXYZ(
          i,
          (Math.random() - 0.5) * 1.4,
          -0.8,
          (Math.random() - 0.5) * 1.4
        );

        this._dustVel[i].set(
          (Math.random() - 0.5) * 4,
          1 + Math.random() * 3,
          (Math.random() - 0.5) * 4
        );
      }

      pos.setXYZ(
        i,
        pos.getX(i) + this._dustVel[i].x * dt,
        pos.getY(i) + this._dustVel[i].y * dt,
        pos.getZ(i) + this._dustVel[i].z * dt
      );

      this._dustVel[i].y += dt * 0.4;
    }

    pos.needsUpdate = true;
  }
}