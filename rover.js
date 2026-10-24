import * as THREE from "three";
import { loadGlb } from "./models.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { astar, worldToIndex } from "./pathfinding.js";
import { ROVER, SIM_HOURS_PER_SEC, roverLoadKw } from "./outpost.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

export class Rover {
  constructor(terrain, spawn, kind = "sampler") {
    this.terrain = terrain;
    this.kind = kind;

    this.speed =
      kind === "scout" ? 11 :
      kind === "mapper" ? 7.5 : 5.5;

    this.powerDraw =
      kind === "scout" ? 0.4 :
      kind === "mapper" ? 0.7 : 1.1;

    this.commsRange = kind === "scout" ? 160 : 95;

    this.path = [];
    this.pathIndex = 0;
    this.heading = 0;
    this.drillSpin = 0;
    this.drilling = false;
    this.manual = false;
    this.battery = 1;
    this.distance = 0;
    this.gridScale = 1;
    this.scanComplete = false;

    this.group = this._build();

    const y = terrain.heightAt(spawn.x, spawn.z);

    this.group.position.set(
      spawn.x,
      y,
      spawn.z
    );

    this.scanPulse = 0;
  }

  _build() {
    const g = new THREE.Group();

    this.wheels = [];

    // Articulated sampling arm (turret, shoulder, elbow, wrist, drill).
    if (this.kind === "sampler") this._buildArm(g);

    // Configure Draco decoding for the compressed GLB.
    const dracoLoader = new DRACOLoader();

    dracoLoader.setDecoderPath(new URL("../draco/", import.meta.url).href);

    dracoLoader.setDecoderConfig({ type: "js" });
    dracoLoader.preload();

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    loadGlb(loader, "rover",

      (gltf) => {
        const model = gltf.scene;

        model.updateMatrixWorld(true);

        let bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());

        const maxDimension = Math.max(
          size.x,
          size.y,
          size.z,
          0.001
        );

        // Scale the rover to a consistent overall size.
        model.scale.setScalar(5.9 / maxDimension);

        model.updateMatrixWorld(true);

        bounds = new THREE.Box3().setFromObject(model);

        const center = bounds.getCenter(new THREE.Vector3());

        model.position.x -= center.x;
        model.position.y -= bounds.min.y;
        model.position.z -= center.z;

        model.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        // Add the reference rover model to the existing group.
        g.add(model);
        this.model = model;

        // Mount the sampling arm on the front of the hull.
        const fb = new THREE.Box3().setFromObject(model);
        this.armMount?.position.set(
          0,
          Math.min(1.5, (fb.max.y - fb.min.y) * 0.5),
          Math.min(3.1, fb.max.z * 0.92)
        );

        dracoLoader.dispose();
      },

      undefined,

      (error) => {
        dracoLoader.dispose();

        console.error(
          "Unable to load Space Exploration Vehicle GLB:",
          error
        );
      }
    );

    // Rover camera anchor.
    this.bumperCam = new THREE.Object3D();

    this.bumperCam.position.set(
      0,
      1.6,
      2.7
    );

    g.add(this.bumperCam);

    // Mapper scanning ring.
    if (this.kind === "mapper") {
      this.scanRing = new THREE.Mesh(
        new THREE.RingGeometry(2.2, 2.5, 32),
        new THREE.MeshBasicMaterial({
          color: 0x66c2ff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.55,
        })
      );

      this.scanRing.rotation.x = -Math.PI / 2;
      this.scanRing.position.y = 0.2;

      g.add(this.scanRing);
    }

    // Scout radar light.
    if (this.kind === "scout") {
      this.radar = new THREE.PointLight(
        0xffcc66,
        0.4,
        18
      );

      this.radar.position.set(
        0,
        2.4,
        1.2
      );

      g.add(this.radar);
    }

    return g;
  }

  _buildArm(g) {
    this.L1 = 1.9;
    this.L2 = 1.8;
    this.toolLen = 1.15;
    this.armPose = { yaw: 0, wx: 0.9, wy: 0.7, tipY: 0 };
    this.extractProgress = 0;
    this.arrived = true;
    this.workTarget = null;
    this._armT = 0;

    const metal = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.7, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d33, metalness: 0.5, roughness: 0.5 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xff8a2a, metalness: 0.4, roughness: 0.5 });
    const part = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      return m;
    };
    const link = (len, mat = metal) => {
      const grp = new THREE.Group();
      const bar = part(new THREE.BoxGeometry(len, 0.2, 0.24), mat);
      bar.position.x = len / 2;
      grp.add(bar);
      const rib = part(new THREE.BoxGeometry(len * 0.8, 0.06, 0.34), dark);
      rib.position.x = len / 2;
      grp.add(rib);
      return grp;
    };
    const joint = (r = 0.2) => {
      const j = part(new THREE.CylinderGeometry(r, r, 0.34, 18), accent);
      j.rotation.x = Math.PI / 2;
      return j;
    };

    this.armMount = new THREE.Group();
    this.armMount.position.set(0, 1.3, 2.4);
    // The robotic arm is no longer shown. The rig stays in the scene graph
    // (hidden) so the extraction logic and dust effect keep working.
    this.armMount.visible = false;
    g.add(this.armMount);

    const base = part(new THREE.CylinderGeometry(0.4, 0.48, 0.3, 20), dark);
    base.position.y = -0.1;
    this.armMount.add(base);

    this.turret = new THREE.Group();
    this.armMount.add(this.turret);
    this.turret.add(part(new THREE.CylinderGeometry(0.3, 0.3, 0.28, 18), metal));

    this.shoulder = new THREE.Group();
    this.shoulder.position.y = 0.2;
    this.shoulder.add(joint(0.24));
    this.shoulder.add(link(this.L1));
    this.turret.add(this.shoulder);

    this.elbow = new THREE.Group();
    this.elbow.position.x = this.L1;
    this.elbow.add(joint(0.2));
    this.elbow.add(link(this.L2));
    this.shoulder.add(this.elbow);

    this.wrist = new THREE.Group();
    this.wrist.position.x = this.L2;
    this.wrist.add(joint(0.16));
    this.elbow.add(this.wrist);

    // Tool along +X of the wrist group: housing, auger, bit.
    this.tool = new THREE.Group();
    this.wrist.add(this.tool);
    const housing = part(new THREE.CylinderGeometry(0.16, 0.16, 0.45, 14), dark);
    housing.rotation.z = Math.PI / 2;
    housing.position.x = 0.25;
    this.tool.add(housing);
    this.auger = new THREE.Group();
    this.tool.add(this.auger);
    const shaft = part(
      new THREE.CylinderGeometry(0.07, 0.07, this.toolLen - 0.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3 })
    );
    shaft.rotation.z = Math.PI / 2;
    shaft.position.x = 0.45 + (this.toolLen - 0.45) / 2 - 0.1;
    this.auger.add(shaft);
    for (let i = 0; i < 6; i++) {
      const ring = part(
        new THREE.TorusGeometry(0.1, 0.025, 6, 14),
        new THREE.MeshStandardMaterial({ color: 0xd8dce2, metalness: 0.9, roughness: 0.25 })
      );
      ring.rotation.y = Math.PI / 2;
      ring.rotation.x = i * 0.5;
      ring.position.x = 0.55 + i * 0.1;
      this.auger.add(ring);
    }
    // Drill bit tip: used as the camera/effects anchor.
    this.drill = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.22, 10),
      new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xff7a1a, emissiveIntensity: 0.0, metalness: 0.8, roughness: 0.3 })
    );
    this.drill.rotation.z = -Math.PI / 2;
    this.drill.position.x = this.toolLen;
    this.auger.add(this.drill);

    // Core sample tube carried after extraction.
    this.tube = new THREE.Group();
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.8, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35, metalness: 0.2, roughness: 0.1 })
    );
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.065, 0.7, 12),
      new THREE.MeshStandardMaterial({ color: 0x7a6a58, emissive: 0x5ce1ff, emissiveIntensity: 0.9, roughness: 0.8 })
    );
    this.tube.add(glass, core);
    this.tube.rotation.z = Math.PI / 2;
    this.tube.position.set(this.toolLen * 0.55, 0.3, 0.32);
    this.tube.visible = false;
    this.wrist.add(this.tube);

    // Storage box on the hull where the tube is deposited.
    this.sampleBox = part(new THREE.BoxGeometry(0.7, 0.4, 0.5), dark);
    this.sampleBox.position.set(0, 0.35, -0.6);
    this.armMount.add(this.sampleBox);

    this.armLight = new THREE.PointLight(0xff9a40, 0, 7, 2);
    this.drill.add(this.armLight);

    // Dust kicked up at the drill site (local to the rover while it is parked).
    const n = 70;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3).fill(-9999), 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xc9baa2,
        size: 0.28,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      })
    );
    this.dust.frustumCulled = false;
    this._dustLife = new Float32Array(n);
    this._dustVel = Array.from({ length: n }, () => new THREE.Vector3());
    g.add(this.dust);
  }

  // Keep the rover out of boulders, the astronaut and the other rovers.
  _avoidObstacles() {
    const R = 2.5; // rover footprint radius
    const push = (ox, oz, minDist) => {
      const dx = this.position.x - ox;
      const dz = this.position.z - oz;
      const d = Math.hypot(dx, dz);
      if (d >= minDist) return;
      if (!(this._blockedT > 0) && !this._side) this._side = Math.random() < 0.5 ? 1 : -1;
      this._blockedT = 0.7;
      const nx = d > 0.001 ? dx / d : 1;
      const nz = d > 0.001 ? dz / d : 0;
      this.position.x = ox + nx * minDist;
      this.position.z = oz + nz * minDist;
    };
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.terrain.boulderData || []) {
        if (b.r < 1.8) continue;
        push(b.x, b.z, b.r * 1.15 + R);
      }
      if (this.astronaut) {
        const a = this.astronaut.position;
        const low = a.y < this.terrain.heightAt(a.x, a.z) + 5;
        if (low) push(a.x, a.z, 1.6 + R);
      }
      for (const o of this.others || []) {
        if (o !== this) push(o.position.x, o.position.z, R * 2);
      }
    }
  }

  /** Receive charge (kWh) from the outpost grid. */
  charge(kwh) {
    const before = this.battery;
    this.battery = Math.min(1, this.battery + kwh / ROVER.capKwh);
    this.energyChargedKwh = (this.energyChargedKwh || 0) + (this.battery - before) * ROVER.capKwh;
  }

  setWorkTarget(x, z) {
    this.workTarget = new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
  }

  clearWorkTarget() {
    this.workTarget = null;
  }

  // Drill site in the world (ground point), or a spot just ahead of the hull.
  workPointWorld(out = new THREE.Vector3()) {
    if (this.workTarget) return out.copy(this.workTarget);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
    out.copy(this.position).addScaledVector(f, 4.6);
    out.y = this.terrain.heightAt(out.x, out.z);
    return out;
  }

  _solveArm(wx, wy) {
    // Planar 2-link IK; wrist target (wx, wy) relative to the shoulder.
    const { L1, L2 } = this;
    let d = Math.hypot(wx, wy);
    d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 0.08, L1 + L2 - 0.02);
    const ang = Math.atan2(wy, wx);
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const shoulder = ang + Math.acos(cosA);
    const cosE = THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
    const elbow = -(Math.PI - Math.acos(cosE));
    const wrist = -Math.PI / 2 - (shoulder + elbow); // tool points straight down
    return { shoulder, elbow, wrist };
  }

  _updateArm(dt) {
    const t = (this._armT += dt);
    const p = this.extractProgress;
    const active = this.drilling && this.arrived && this.workTarget;
    const stow = { yaw: 0, wx: 0.95, wy: 0.75, tipY: 0 };
    let goal = stow;
    let phase = "stow";
    let drilling = false;

    if (active) {
      // Work target in the arm's frame.
      this.group.updateMatrixWorld(true);
      const local = this.armMount.worldToLocal(this.workTarget.clone());
      const yaw = Math.atan2(-local.z, local.x);
      const reach = Math.hypot(local.x, local.z);
      const ground = local.y;
      const hover = { yaw, wx: reach, wy: ground + this.toolLen + 0.9 - 0.2 };
      if (p < 0.12) {
        goal = hover;
        phase = "deploy";
      } else if (p < 0.78) {
        const k = (p - 0.12) / 0.66;
        const depth = -0.15 - k * 0.55 + Math.sin(t * 38) * 0.025;
        goal = { yaw, wx: reach + Math.sin(t * 31) * 0.015, wy: ground + this.toolLen + depth };
        phase = "drill";
        drilling = true;
      } else if (p < 0.9) {
        goal = { yaw, wx: reach, wy: ground + this.toolLen + 1.6 };
        phase = "lift";
      } else {
        goal = { ...stow, wy: 1.1 };
        phase = "store";
      }
    }

    const k = 1 - Math.exp(-dt * (phase === "drill" ? 14 : 3.2));
    const a = this.armPose;
    // Keep the yaw turning the short way round.
    let dy = goal.yaw - a.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    a.yaw += dy * k;
    a.wx += (goal.wx - a.wx) * k;
    a.wy += (goal.wy - a.wy) * k;

    const sol = this._solveArm(a.wx, a.wy - 0.2);
    this.turret.rotation.y = a.yaw;
    this.shoulder.rotation.z = sol.shoulder;
    this.elbow.rotation.z = sol.elbow;
    this.wrist.rotation.z = sol.wrist;

    // Auger spin and glow.
    this.drillSpin += dt * (drilling ? 30 : phase === "deploy" ? 6 : 0);
    this.auger.rotation.x = this.drillSpin;
    this.drill.material.emissiveIntensity = THREE.MathUtils.lerp(
      this.drill.material.emissiveIntensity,
      drilling ? 1.6 : 0,
      dt * 6
    );
    this.armLight.intensity = drilling ? 2.2 : 0;

    // Sample tube: appears when the core is pulled, hides once stored.
    const atStow =
      Math.hypot(a.wx - stow.wx, a.wy - stow.wy) < 0.25 && Math.abs(a.yaw) < 0.08;
    if (active && p >= 0.78) this.tube.visible = true;
    else if (!active && atStow) this.tube.visible = false;
    this.sampleBox.material.emissive?.setHex(this.tube.visible && phase === "store" ? 0x113344 : 0x000000);

    this._updateArmDust(dt, drilling);
  }

  _updateArmDust(dt, emit) {
    const pos = this.dust.geometry.attributes.position;
    const site = this.workTarget ? this.group.worldToLocal(this.workTarget.clone()) : null;
    for (let i = 0; i < this._dustLife.length; i++) {
      this._dustLife[i] -= dt;
      if (this._dustLife[i] <= 0) {
        if (emit && site && Math.random() < 0.6) {
          this._dustLife[i] = 0.5 + Math.random() * 0.7;
          pos.setXYZ(i, site.x + (Math.random() - 0.5) * 0.3, site.y + 0.05, site.z + (Math.random() - 0.5) * 0.3);
          this._dustVel[i].set((Math.random() - 0.5) * 2.4, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 2.4);
        } else {
          pos.setXYZ(i, 0, -9999, 0);
        }
        continue;
      }
      pos.setXYZ(
        i,
        pos.getX(i) + this._dustVel[i].x * dt,
        pos.getY(i) + this._dustVel[i].y * dt,
        pos.getZ(i) + this._dustVel[i].z * dt
      );
      this._dustVel[i].y -= dt * 1.6;
    }
    pos.needsUpdate = true;
  }

  get position() {
    return this.group.position;
  }

  setPath(path) {
    this.path = path || [];
    this.pathIndex = 0;
  }

  driveTo(x, z) {
    this.goal = { x, z };
    this.setPath(this._plan(x, z));
  }

  // Plan around boulders on the navigation grid, then straighten the route.
  _plan(x, z) {
    const nav = this.nav;
    if (!nav) return [{ x, z }];
    const cells = nav.cells;
    let gx = x;
    let gz = z;
    const gi = worldToIndex(nav, x, z);
    const goalBlocked = cells[gi].obstacle;
    if (goalBlocked) {
      // Nearest free cell to the requested spot.
      let best = null;
      let bd = Infinity;
      for (const c of cells) {
        if (c.obstacle) continue;
        const d = Math.hypot(c.wx - x, c.wz - z);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (best) {
        gx = best.wx;
        gz = best.wz;
      }
    }
    const res = astar(nav, { x: this.position.x, z: this.position.z }, { x: gx, z: gz });
    if (!res.path.length) return [{ x: gx, z: gz }];
    const pts = res.path.map((p) => ({ x: p.x, z: p.z }));
    pts[pts.length - 1] = { x: gx, z: gz };
    const out = [];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this._clearLine(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out.length ? out : [{ x: gx, z: gz }];
  }

  _clearLine(a, b) {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(d / 1.5);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (this.terrain.isBlocked(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
    }
    return true;
  }

  update(dt, input, roverCam, stampCb) {
    const move = new THREE.Vector2();
    this.arrived = true;

    // Manual control for the sampler rover.
    if (
      roverCam &&
      this.kind === "sampler" &&
      this.manual
    ) {
      if (
        input.down("KeyW") ||
        input.down("ArrowUp")
      ) {
        move.y += 1;
      }

      if (
        input.down("KeyS") ||
        input.down("ArrowDown")
      ) {
        move.y -= 1;
      }

      if (
        input.down("KeyA") ||
        input.down("ArrowLeft")
      ) {
        this.heading += dt * 1.4;
      }

      if (
        input.down("KeyD") ||
        input.down("ArrowRight")
      ) {
        this.heading -= dt * 1.4;
      }
    } else if (this.path.length) {
      const tgt = this.path[
        Math.min(
          this.pathIndex,
          this.path.length - 1
        )
      ];

      const dx = tgt.x - this.position.x;
      const dz = tgt.z - this.position.z;

      const dist = Math.hypot(dx, dz);

      if (dist < 3.2) {
        this.pathIndex = Math.min(
          this.pathIndex + 1,
          this.path.length - 1
        );
      }

      this.heading = Math.atan2(dx, dz);
      // Steer around whatever just blocked the way.
      if (this._blockedT > 0) {
        this._blockedT -= dt;
        this.heading += (this._side || 1) * 1.15;
      }
      move.y = dist > 1.2 ? 1 : 0;
      this.arrived = dist <= 1.2;
    }

    // Battery restricts operation: 0 = stopped, below the low threshold = crawl.
    const speed =
      this.speed *
      (this.battery <= 0 ? 0 : this.battery > ROVER.lowFraction ? 1 : 0.2) *
      this.gridScale;

    const vx = Math.sin(this.heading) * move.y * speed;
    const vz = Math.cos(this.heading) * move.y * speed;

    this.position.x += vx * dt;
    this.position.z += vz * dt;

    this.distance += Math.hypot(vx, vz) * dt;

    this._avoidObstacles();
    if (this._blockedT > 0) this._stuckT = (this._stuckT || 0) + dt;
    else this._stuckT = 0;
    if (this._stuckT > 1.4 && this.goal && !this.manual) {
      this._stuckT = 0;
      this.driveTo(this.goal.x, this.goal.z);
    }

    // Energy model (shared with route planning): idle + driving (slope
    // dependent) + drilling, converted to kWh with the simulation clock.
    const moving = Math.hypot(vx, vz) > 0.05;
    const slopeNow = moving ? this.terrain.slopeAt(this.position.x, this.position.z) : 0;
    const drillingNow = this.kind === "sampler" && this.drilling && this.arrived;
    this.loadKw = roverLoadKw(this.kind, moving, slopeNow, drillingNow);
    const usedKwh = this.loadKw * dt * SIM_HOURS_PER_SEC;
    this.energyUsedKwh = (this.energyUsedKwh || 0) + usedKwh;
    this.battery = Math.max(0, this.battery - usedKwh / ROVER.capKwh);

    // Update terrain height.
    this.position.y = this.terrain.heightAt(
      this.position.x,
      this.position.z
    );

    // Align the rover with the terrain slope and heading.
    const n = this.terrain.normalAt(
      this.position.x,
      this.position.z
    );

    const terrainRotation = new THREE.Quaternion()
      .setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        n
      );

    const headingRotation = new THREE.Quaternion()
      .setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.heading
      );

    const targetRotation = terrainRotation.multiply(
      headingRotation
    );

    this.group.quaternion.slerp(
      targetRotation,
      0.15
    );

    // Wheel animation handles are retained for compatibility.
    const spinning = Math.abs(move.y) > 0.01;

    for (const w of this.wheels) {
      if (spinning) {
        w.rotation.x += dt * 6;
      }
    }

    if (spinning && stampCb) {
      stampCb(
        this.position.x,
        this.position.z,
        this.heading
      );
    }

    // Sampler arm animation.
    if (this.kind === "sampler") this._updateArm(dt);

    // Mapper scan pulse animation.
    this.scanPulse += dt;

    if (this.scanRing) {
      const s = 1 + (this.scanPulse % 2.4) * 2.2;

      this.scanRing.scale.set(s, s, 1);

      this.scanRing.material.opacity =
        0.55 *
        (1 - (this.scanPulse % 2.4) / 2.4);
    }

    // Scout radar animation.
    if (this.radar) {
      this.radar.intensity =
        0.25 + Math.sin(this.scanPulse * 4) * 0.35;
    }
  }
}