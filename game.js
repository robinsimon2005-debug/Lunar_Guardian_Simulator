import * as THREE from "three";
import { loadGlb } from "./models.js";
import { Input } from "./input.js";
import { Terrain } from "./terrain.js";
import { createSky, createSunLight } from "./sky.js";
import { Astronaut } from "./astronaut.js";
import { Rover } from "./rover.js";
import { CameraRig } from "./camera.js";
import { HUD } from "./hud.js";
import { SITES, MISSIONS } from "./missions.js";
import { Outpost, POWER_MODES, ROVER, SIM_HOURS_PER_SEC } from "./outpost.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import {
  buildNavGrid,
  dijkstra,
  shortestCost,
  terrainAwareCost,
  astar,
  worldToIndex,
  routeMetrics,
} from "./pathfinding.js";

export class Game {
  constructor(root) {
    this.root = root;
    this.input = new Input();
    this.hud = new HUD();
    this.site = SITES[0];
    this.mission = MISSIONS[0];
    this.clock = new THREE.Clock();
    this.running = false;
    this.mapOpen = false;
    this.wristOpen = false;
    this.extracting = false;
    this.layer = 0;
    this.layersUsed = new Set();
    this.paths = { short: [], safe: [], detour: [] };
    this.targets = [];
    this.zones = [];
    this.hazards = [];
    this.objectives = [];
    this.sample = null;
    this.samplesStored = 0;
    this.timer = 0;
    this.hazardFired = false;
    this.losOk = true;
    this.extract = { rpm: 420, torque: 40, heat: 40, density: 1.6, progress: 0 };
    this._lines = [];
    this.losLinks = [];
    this.powerGrid = 1;
    this.checklist = { contact: false, stable: false, lock: false };
    this.preserveHold = 0;
    this.hiddenHazards = [];
    this.lights = null;
    this.fallingRocks = [];
    this.debriefed = false;
    this.outpost = null;
    this.habitat = null;
    this.routeMetrics = null;
    this.log = [];
    this.hintsSeen = new Set();
    this.tutorialDone = false;
    this.tutorial = null;
    this.quizResult = null;
    this._sepT = 0;
    this._rovAlerted = new Set();
    this.missionClock = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000005);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.15, 6000);
    this.rig = new CameraRig(this.camera);

    this._onSite = (s) => {
      this.site = s;
      this._refreshHub();
    };
    this._onMission = (m) => {
      this.mission = m;
      this._refreshHub();
    };
    this._refreshHub();

    qsClick("close-map", () => this.toggleMap(false));
    qsClick("debrief-hub", () => this._returnToHub());
    qsClick("coach-skip", () => {
      this.tutorial = null;
      this.tutorialDone = true;
      this.hud.setCoach(null);
    });
    document.getElementById("layer-legend").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-layer]");
      if (!li || !this.running) return;
      this._setLayer(Number(li.dataset.layer));
    });
    window.addEventListener("resize", () => this._resize());
    this.renderer.domElement.addEventListener("click", () => {
      if (this.running && !this.mapOpen && !this.debriefed) this.renderer.domElement.requestPointerLock();
    });

    // Title screen -> mission tab -> mission start.
    this.paused = false;
    this._pausedAt = 0;
    qsClick("start-sim", () => {
      document.getElementById("title").classList.add("hidden");
      document.getElementById("hub").classList.remove("hidden");
    });
    qsClick("resume-btn", () => this.resume());
    qsClick("pause-hub", () => this._returnToHub());
    document.addEventListener("pointerlockchange", () => {
      // Releasing the mouse (Esc) while flying pauses the simulation.
      if (
        !document.pointerLockElement &&
        this._hadLock &&
        this.running &&
        !this.paused &&
        !this.mapOpen &&
        !this.debriefed
      ) {
        this.pause();
      }
      this._hadLock = Boolean(document.pointerLockElement);
    });
    this._startTitleScene();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // Live lunar fly-over used behind the title screen and the mission tab.
  _startTitleScene() {
    this._teardown();
    this.titleMode = true;
    this.titleT = 0;
    this.site = this.site || SITES[0];
    this.terrain = new Terrain(SITES[0].seed);
    this.scene.add(this.terrain.group);
    const sky = createSky(SITES[0]);
    this.scene.add(sky.group);
    this.sky = sky;
    const lights = createSunLight();
    this.scene.add(lights.sun, lights.sun.target, lights.fill, lights.earthshine);
    this.terrain.sunDir.copy(lights.sun.position).normalize();
    this._updateTitle(0);
  }

  _updateTitle(dt) {
    this.titleT += dt;
    const t = this.titleT;
    const cx = 120 * Math.sin(t * 0.045);
    const cz = -80 + 25 * Math.sin(t * 0.03);
    const ground = this.terrain.heightAt(cx, cz);
    this.camera.position.set(cx, ground + 7 + 2 * Math.sin(t * 0.2), cz);
    const lx = cx + 60 * Math.cos(t * 0.045) + 25 * Math.sin(t * 0.06);
    const lz = cz + 120;
    this.camera.lookAt(lx, this.terrain.heightAt(lx, lz) + 16, lz);
  }

  _onEscape() {
    if (this.debriefed) return this._returnToHub();
    if (this.mapOpen) return this.toggleMap(false);
    if (this.paused) {
      if (performance.now() - this._pausedAt > 350) this.resume();
    } else this.pause();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this._pausedAt = performance.now();
    document.exitPointerLock();
    this.hud.showPause(this);
  }

  resume() {
    this.paused = false;
    this.hud.hidePause();
    this.clock.getDelta();
    this.renderer.domElement.requestPointerLock?.();
  }

  _refreshHub() {
    this.hud.fillHub(SITES, MISSIONS, this, this._onSite, this._onMission, () => this.launch());
  }

  launch() {
    this._teardown();
    this.titleMode = false;
    this.paused = false;
    this.hud.hidePause();
    this.running = true;
    this.mapOpen = false;
    this.wristOpen = false;
    this.extracting = false;
    this.layer = 0;
    this.layersUsed = new Set();
    this.hazardFired = false;
    this.timer = this.mission.id === 4 ? 180 : 0;
    this.samplesStored = 0;
    this.sample = null;
    this.extract = { rpm: 420, torque: 40, heat: 40, density: 1.62, progress: 0 };
    this.checklist = { contact: false, stable: false, lock: false };
    this.preserveHold = 0;
    this.fallingRocks = [];
    this.losLinks = [];
    this.debriefed = false;
    this.hud.hideDebrief();

    this.terrain = new Terrain(this.site.seed);
    this.scene.add(this.terrain.group);
    const sky = createSky(this.site);
    this.scene.add(sky.group);
    this.sky = sky;
    const lights = createSunLight();
    this.lights = lights;
    this.scene.add(lights.sun, lights.sun.target, lights.fill, lights.earthshine);
    this.terrain.sunDir.copy(lights.sun.position).normalize();

    this.alpha = { x: -70, z: -80 };
    this.bravo = { x: 96, z: 88 };
    // Habitat sits beside the landing pad. Blocking its footprint keeps rover
    // routes (and the nav grid) out of it.
    this.habitat = { x: this.alpha.x + 9, z: this.alpha.z + 3 };
    this.terrain.addBlock(this.habitat.x, this.habitat.z, 5);
    this.outpost = new Outpost();
    this.log = [];
    this.missionClock = 0;
    this._sepT = 0;
    this._rovAlerted = new Set();
    this.quizResult = null;
    this._mapLogged = false;
    this.routeMetrics = null;
    this.tutorial = !this.tutorialDone && this.mission.id === 1 ? { step: 0 } : null;
    this.astronaut = new Astronaut(this.terrain, this.alpha);
    this.scene.add(this.astronaut.group);

    this.sampler = new Rover(this.terrain, { x: this.alpha.x + 18, z: this.alpha.z + 14 }, "sampler");
    this.scout = new Rover(this.terrain, { x: this.alpha.x - 16, z: this.alpha.z + 10 }, "scout");
    this.mapper = new Rover(this.terrain, { x: this.alpha.x + 6, z: this.alpha.z + 24 }, "mapper");
    this.rovers = this.mission.id === 3 ? [this.scout, this.mapper, this.sampler] : [this.sampler];
    for (const r of this.rovers) {
      r.astronaut = this.astronaut;
      r.others = this.rovers;
    }
    for (const r of this.rovers) this.scene.add(r.group);

    this.grid = buildNavGrid(this.terrain, 120, [this.alpha, this.bravo]);
    for (const r of this.rovers) r.nav = this.grid;
    const short = dijkstra(this.grid, this.alpha, this.bravo, shortestCost);
    const safe = dijkstra(this.grid, this.alpha, this.bravo, terrainAwareCost);
    this.paths.short = short.path;
    this.paths.safe = safe.path;
    this.paths.detour = [];
    this.routeStats = { short: short.cost, safe: safe.cost };

    this.sampler.setPath(this.paths.safe);
    if (this.mission.id === 3) {
      this.scout.setPath([
        { x: 12, z: 58 },
        { x: -48, z: 20 },
        { x: 70, z: -18 },
        { x: this.bravo.x, z: this.bravo.z },
      ]);
      this.mapper.driveTo(40, -30);
      this.sampler.driveTo(-20, 40);
    }

    this._markers = new THREE.Group();
    this.scene.add(this._markers);
    this._landingPad(this.alpha.x, this.alpha.z);
    this._buildHabitat();
    this.targets = [
      this._beacon(this.bravo.x, this.bravo.z, 0x5ce1ff, "BRAVO"),
      this._beacon(-20, 40, 0x9b7bff, "CORE-A"),
      this._beacon(55, -50, 0x9b7bff, "CORE-B"),
    ];
    this.hiddenHazards = [
      { x: 12, z: 58, r: 14, found: false },
      { x: -48, z: 20, r: 12, found: false },
      { x: 70, z: -18, r: 16, found: false },
    ];
    this.zones = [
      this._zone(-55, -40),
      this._zone(10, 20),
    ];
    this.hazards = [];
    this._refreshRouteMetrics();
    this.nearestTarget = this.targets[0];

    this._pathLines = new THREE.Group();
    this.scene.add(this._pathLines);
    this._drawPath(this.paths.short, 0xff5a5a);
    this._drawPath(this.paths.safe, 0x5ce1ff);

    this.objectives = this.mission.objectives.map((text) => ({ text, done: false }));
    this.hud.setHubVisible(false);
    this.hud.setTerrainPreview(this.terrain.sampleHeightField());
    this.hud.toast(`${this.mission.title.toUpperCase()}`);
    this._log(`Mission started at ${this.site.name}`);
    document.getElementById("tactical-map").classList.add("hidden");
    this.rig.setMode("eva");
    this.camera.position.set(this.alpha.x - 12, 10, this.alpha.z - 12);
  }

  _teardown() {
    this._clearLos();
    this.fallingRocks = [];
    this.lights = null;
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      for (const m of mats) {
        if (!m) continue;
        for (const key of Object.keys(m)) {
          if (m[key] && m[key].isTexture) m[key].dispose();
        }
        m.dispose();
      }
    });
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
  }

  _landingPad(x, z) {
    const y = this.terrain.heightAt(x, z);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(7.5, 7.5, 0.18, 24),
      new THREE.MeshStandardMaterial({ color: 0x3a4450, metalness: 0.4, roughness: 0.35, emissive: 0x112233 })
    );
    pad.position.set(x, y + 0.08, z);
    pad.receiveShadow = true;
    this._markers.add(pad);
    const mark = new THREE.Mesh(
      new THREE.RingGeometry(5.2, 5.6, 24),
      new THREE.MeshBasicMaterial({ color: 0x5ce1ff, side: THREE.DoubleSide })
    );
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(x, y + 0.2, z);
    this._markers.add(mark);
  }

  _beacon(x, z, color, name = "TARGET") {
    const y = this.terrain.heightAt(x, z);
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 3.2, 5),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55 })
    );
    mesh.position.set(x, y + 2.2, z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 3.6, 24),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 0.2, z);
    const label = this._spriteLabel(name, color);
    label.position.set(x, y + 5.2, z);
    g.add(mesh, ring, label);
    this._markers.add(g);
    return { x, z, y, name, mesh, ring, position: new THREE.Vector3(x, y + 1, z) };
  }

  _spriteLabel(text, color) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "rgba(6,16,24,0.72)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = "#d7f4ff";
    ctx.font = "28px Share Tech Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(8, 2, 1);
    return spr;
  }

  _zone(x, z) {
    const y = this.terrain.heightAt(x, z);
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 10, 0.15, 32),
      new THREE.MeshStandardMaterial({
        color: 0x5dff9a,
        transparent: true,
        opacity: 0.28,
        emissive: 0x144422,
      })
    );
    cyl.position.set(x, y + 0.1, z);
    this._markers.add(cyl);
    return { x, z, r: 10, mesh: cyl };
  }

  _drawPath(path, color) {
    if (!path.length) return;
    const pts = path.map((p) => new THREE.Vector3(p.x, this.terrain.heightAt(p.x, p.z) + 0.6, p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })
    );
    this._pathLines.add(line);
  }

  toggleMap(force) {
    this.mapOpen = force ?? !this.mapOpen;
    if (this.mapOpen && this.routeMetrics && !this._mapLogged) {
      this._mapLogged = true;
      this._log("Reviewed route comparison on the tactical map");
    }
    document.getElementById("tactical-map").classList.toggle("hidden", !this.mapOpen);
    if (this.mapOpen && document.pointerLockElement) document.exitPointerLock();
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  _loop() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.titleMode) this._updateTitle(dt);
    if (this.running && this.input.pressed("Escape")) this._onEscape();
    if (this.running && !this.paused) this.update(dt);
    if (this.sky) this.sky.update(dt, this.camera);
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
    requestAnimationFrame(this._loop);
  }

  update(dt) {
    if (this.input.pressed("KeyM")) this.toggleMap();
    if (this.debriefed) {
      this.rig.update(dt, this.astronaut, this.sampler);
      this.hud.updateFlight(this);
      return;
    }

    if (this.input.pressed("KeyR")) this.wristOpen = !this.wristOpen;
    if (this.input.pressed("KeyB")) this._cyclePower();
    if (this.input.pressed("KeyC")) {
      this.rig.toggleRover();
      this.sampler.manual = this.rig.mode.startsWith("rover");
      this.hud.toast(
        this.rig.mode === "roverFpv" ? "ROVER FPV HAZARD CAM" : this.rig.mode === "rover" ? "ROVER CHASE CAM" : "EVA CAM"
      );
    }

    if (this.input.pressed("Digit0") || this.input.pressed("Numpad0")) this._setLayer(0);
    for (let i = 1; i <= 5; i++) {
      if (this.input.pressed("Digit" + i) || this.input.pressed("Numpad" + i)) this._setLayer(i);
    }

    this.targets.forEach((t) => {
      t.ring.rotation.z += dt * 0.6;
      t.position.y = this.terrain.heightAt(t.x, t.z) + 1;
    });
    this.nearestTarget = this.targets.reduce((a, b) =>
      this.astronaut.position.distanceTo(a.position) < this.astronaut.position.distanceTo(b.position) ? a : b
    );

    const canExtract =
      this.wristOpen && this.astronaut.position.distanceTo(this.nearestTarget.position) < 28;

    if (this.input.pressed("KeyE") && canExtract && !this.extracting) {
      this.extracting = true;
      this.rig.setMode("extract");
      this.sampler.drilling = true;
      {
        // Park the rover short of the core site so its arm can reach it.
        const t = this.nearestTarget;
        const sp = this.sampler.position;
        const d = new THREE.Vector2(t.x - sp.x, t.z - sp.z);
        const len = d.length() || 1;
        d.divideScalar(len);
        // Pick a free parking spot on a ring around the core site, starting
        // from the side the rover approaches from.
        const base = Math.atan2(-d.y, -d.x);
        let stop = { x: t.x - d.x * 4.8, z: t.z - d.y * 4.8 };
        for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2, 3.14]) {
          const px = t.x + Math.cos(base + off) * 4.8;
          const pz = t.z + Math.sin(base + off) * 4.8;
          if (!this.terrain.isBlocked(px, pz)) {
            stop = { x: px, z: pz };
            break;
          }
        }
        this.sampler.driveTo(stop.x, stop.z);
        this.sampler.setWorkTarget(t.x, t.z);
        this.sampler.extractProgress = 0;
      }
      this.extract.density = 1.35 + this.terrain.roughnessAt(this.nearestTarget.x, this.nearestTarget.z);
      this.extract.progress = 0;
      this.extract.heat = 80;
      this.hud.toast("ROVER MOVING TO CORE SITE");
      this._log(`Commanded extraction at ${this.nearestTarget.name}`);
      if (this.mission.id === 1) this._complete(2);
    } else if (this.input.pressed("KeyE") && this.extracting) {
      this.extracting = false;
      this.sampler.drilling = false;
      this.rig.setMode("eva");
    }

    this.astronaut.update(
      dt,
      this.input,
      this.extracting || this.rig.mode.startsWith("rover"),
      this.wristOpen
    );

    if (this.extracting) this._updateExtract(dt);

    for (const r of this.rovers) {
      r.update(dt, this.input, this.rig.mode.startsWith("rover") && r === this.sampler, (x, z, hdg) =>
        this.terrain.stampTrack(x, z, hdg)
      );
    }

    this._updatePowerGrid();
    this._updateOutpost(dt);
    if (this.debriefed) {
      this.hud.updateFlight(this);
      return;
    }
    this._updateComms();
    this._updateScoutRadar();
    this._updateSun();
    this._updateFalling(dt);
    this._updateMissions(dt);
    this._updateTutorial();
    if (this.astronaut.canister) this.astronaut.canister.visible = Boolean(this.sample);
    this.rig.update(dt, this.astronaut, this.sampler);
    this.hud.updateFlight(this);
  }

  // ---- Outpost integration -------------------------------------------------

  _log(text) {
    this.log.push({ t: this.missionClock, text });
  }

  _hint(key, text, ms = 5200) {
    if (this.hintsSeen.has(key)) return;
    this.hintsSeen.add(key);
    this.hud.toast(text, ms);
  }

  _buildHabitat() {
    const { x, z } = this.habitat;
    const y = this.terrain.heightAt(x, z);
    const g = new THREE.Group();
    // The habitat is the Apollo Lunar Module (GLB). It loads asynchronously;
    // the solar array, shelter ring and label below are placed immediately.
    const label = this._spriteLabel("HABITAT", 0xffffff);
    label.position.set(x, y + 9, z);
    this._loadApolloHabitat(g, x, z, label);
    // Solar array: three tilted panels beside the lander.
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x14284a, metalness: 0.6, roughness: 0.25, emissive: 0x071428 });
    for (let i = 0; i < 3; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.1, 2.2), panelMat);
      panel.position.set(x - 7.5, y + 1.4, z - 3.2 + i * 3.1);
      panel.rotation.z = -0.5;
      panel.castShadow = true;
      g.add(panel);
    }
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(this.outpost.p.shelterRadius - 0.3, this.outpost.p.shelterRadius, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.18 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 0.25, z);
    g.add(ring);
    this._markers.add(g);
    this._markers.add(label);
  }

  /** Load the Apollo Lunar Module GLB and stand it on the terrain at the habitat site. */
  _loadApolloHabitat(group, x, z, label) {
    const draco = new DRACOLoader();
    draco.setDecoderPath(new URL("../draco/", import.meta.url).href);
    draco.setDecoderConfig({ type: "js" });
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    const site = this.site;
    loadGlb(loader, "apollo",
      (gltf) => {
        // Ignore a late load if the player already left this mission.
        if (this.site !== site || !this._markers || !group.parent) return draco.dispose();
        const model = gltf.scene;
        model.updateMatrixWorld(true);
        let box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        // Landing-gear span (X/Z) becomes ~9 m, which fits the 5 m blocked footprint.
        const k = 9 / Math.max(size.x, size.z, 0.001);
        model.scale.setScalar(k);
        model.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.x -= c.x;
        model.position.z -= c.z;
        model.position.y -= box.min.y;
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        // Wrap so the lander can be turned to face the landing pad.
        const holder = new THREE.Group();
        holder.add(model);
        holder.rotation.y = Math.atan2(this.alpha.x - x, this.alpha.z - z);
        // Rest on the mean ground height under the footprint; the pads settle slightly into the regolith.
        let sum = 0;
        let n = 0;
        for (const [dx, dz] of [[0, 0], [3.2, 0], [-3.2, 0], [0, 3.2], [0, -3.2]]) {
          sum += this.terrain.heightAt(x + dx, z + dz);
          n++;
        }
        holder.position.set(x, sum / n - 0.15, z);
        group.add(holder);
        this.habitatModel = holder;
        label.position.y = holder.position.y + (box.max.y - box.min.y) + 2.5;
        draco.dispose();
      },
      undefined,
      (err) => {
        draco.dispose();
        console.error("Unable to load Apollo Lunar Module GLB:", err);
      }
    );
  }

  _hazardList() {
    return this.hazards.map((h) => ({ x: h.x, z: h.z, r: h.r || 14 }));
  }

  _refreshRouteMetrics() {
    const opts = { kind: "sampler", speed: this.sampler.speed, hazards: this._hazardList() };
    this.routeMetrics = {
      short: routeMetrics(this.grid, this.paths.short, opts),
      safe: routeMetrics(this.grid, this.paths.safe, opts),
      detour: this.paths.detour?.length > 1 ? routeMetrics(this.grid, this.paths.detour, opts) : null,
    };
  }

  _cyclePower() {
    if (!this.outpost) return;
    const mode = this.outpost.cycleMode();
    const label = POWER_MODES[mode].label;
    const why = {
      balanced: "Hydroponics first, then rover charging, using surplus power.",
      surface_ops: "Rover charging first; hydroponics paused so crops stop growing.",
      life_support: "Only life support runs. Rovers do not charge and crops stop growing.",
    }[mode];
    this.hud.toast(`POWER MODE: ${label} — ${why}`, 4200);
    this._log(`Power mode: ${label}`);
  }

  _updateOutpost(dt) {
    const o = this.outpost;
    if (!o || this.debriefed) return;
    this.missionClock += dt;
    const p = o.p;
    const hab = this.habitat;
    const ap = this.astronaut.position;
    const outside = Math.hypot(ap.x - hab.x, ap.z - hab.z) > p.shelterRadius;
    const h = dt * SIM_HOURS_PER_SEC;
    const solar = THREE.MathUtils.clamp(this.terrain.illuminationAt(hab.x, hab.z), 0.15, 1);

    // Docked rovers ask the habitat for charge, never more than they can hold.
    const requests = [];
    this.rovers.forEach((r, i) => {
      const d = Math.hypot(r.position.x - hab.x, r.position.z - hab.z);
      r.docked = d < p.chargeRadius;
      const room = (1 - r.battery) * ROVER.capKwh;
      if (r.docked && room > 1e-6 && h > 0) requests.push({ id: i, kw: Math.min(p.roverChargeKw, room / h) });
    });

    if (this._sepT > 0) {
      this._sepT -= dt;
      if (this._sepT <= 0) o.setSolarEvent(false);
    }

    const res = o.step(dt, { solarFactor: solar, evaOutside: outside, chargeRequests: requests });
    for (const [id, kwh] of Object.entries(res.charged)) this.rovers[Number(id)].charge(kwh);

    // Each rover's own small panel gives a slow trickle so a drained rover can crawl home.
    for (const r of this.rovers) {
      const trickle = p.roverSolarKw * solar * h;
      r.solarKwh = (r.solarKwh || 0) + trickle;
      r.charge(trickle);
    }

    for (const e of o.drainEvents()) {
      this.hud.toast(e.text, 3600);
      this._log(e.text);
    }

    for (const r of this.rovers) {
      const key = r.kind;
      if (r.battery <= 0 && !this._rovAlerted.has(key)) {
        this._rovAlerted.add(key);
        this.hud.toast(`${key.toUpperCase()} BATTERY EMPTY — ROVER STOPPED. IT TRICKLE-CHARGES FROM ITS PANEL; TOW-FREE RECOVERY IS SLOW`, 5200);
        this._log(`${key} rover battery depleted`);
      } else if (r.battery > 0.15) this._rovAlerted.delete(key);
    }
    if (this.rovers.some((r) => r.docked && r.battery < 0.7)) {
      this._hint("charge", "ROVER DOCKED AT HABITAT: CHARGING FROM THE HABITAT BATTERY. PRESS B TO CHOOSE WHAT GETS POWER FIRST.");
    }
    if (this.rovers.some((r) => r.battery < 0.3 && !r.docked)) {
      this._hint("lowrover", "ROVER BATTERY LOW: DRIVING AND DRILLING USE ENERGY. RETURN TO THE HABITAT PAD TO RECHARGE.");
    }
    if (outside && o.doseMsv > 0.4 * p.doseLimit) {
      this._hint("dose", "RADIATION DOSE BUILDING OUTSIDE: THE HABITAT SHELTER (WHITE RING) LOWERS THE DOSE RATE.");
    }

    if (o.failure) {
      this._log(`Habitat failure: ${o.failure}`);
      this.hud.toast("HABITAT FAILURE — " + o.failure.toUpperCase(), 5000);
      this._openDebrief(false, o.failure);
      this.running = false;
    }
  }

  _updateTutorial() {
    const t = this.tutorial;
    if (!t) return;
    const steps = [
      { text: "TUTORIAL 1/5 — Fly with W A S D. Hold Space to rise and Shift to descend. Gravity is only 1.62 m/s², so keep an eye on propellant.", done: () => ["KeyW", "KeyA", "KeyS", "KeyD"].some((k) => this.input.down(k)) },
      { text: "TUTORIAL 2/5 — Press 1 to 5 to switch terrain layers (elevation, slope, illumination, obstacles, science targets).", done: () => this.layersUsed.size >= 1 },
      { text: "TUTORIAL 3/5 — Press R to open the wrist terminal. It links you to the Sampler rover for remote drilling.", done: () => this.wristOpen },
      { text: "TUTORIAL 4/5 — Press B to change habitat power priority. Life support always gets power first; B decides who gets the rest.", done: () => this.outpost.decisions.length > 0 },
      { text: "TUTORIAL 5/5 — Press M for the tactical map. It compares routes by distance, slope, shadow and estimated rover energy.", done: () => this.mapOpen },
    ];
    const cur = steps[t.step];
    if (!cur) {
      this.tutorial = null;
      this.tutorialDone = true;
      this.hud.setCoach(null);
      this.hud.toast("TUTORIAL COMPLETE — FOLLOW THE OBJECTIVES ON THE LEFT", 3500);
      return;
    }
    this.hud.setCoach(cur.text);
    if (cur.done()) t.step += 1;
  }

  _setLayer(i) {
    this.layer = i;
    if (i > 0) this.layersUsed.add(i);
    this.terrain.applyLayer(i, this.targets);
    this.hud.setTerrainPreview(this.terrain.sampleOverlayField(i, this.targets));
    this.hud.toast(i ? `LAYER ${i}` : "LAYER BASE");
  }

  _returnToHub() {
    this.running = false;
    this.paused = false;
    this.mapOpen = false;
    this.extracting = false;
    this.hud.hideDebrief();
    this.hud.hidePause();
    this.hud.setHubVisible(true);
    document.exitPointerLock();
    document.getElementById("tactical-map").classList.add("hidden");
    this._startTitleScene();
  }

  _updatePowerGrid() {
    const avg = this.rovers.reduce((s, r) => s + r.battery, 0) / this.rovers.length;
    this.powerGrid = avg;
    const scale = avg < 0.22 ? 0.42 : 1;
    for (const r of this.rovers) r.gridScale = scale;
  }

  _updateScoutRadar() {
    if (this.mission.id !== 3) return;
    for (const h of this.hiddenHazards) {
      if (h.found) continue;
      const d = Math.hypot(this.scout.position.x - h.x, this.scout.position.z - h.z);
      if (d < 42) {
        h.found = true;
        this.hazards.push({ x: h.x, z: h.z, r: h.r });
        this.terrain.addBlock(h.x, h.z, h.r);
        const rock = new THREE.Mesh(
          new THREE.DodecahedronGeometry(4.5, 0),
          new THREE.MeshStandardMaterial({ color: 0x6a5f55, roughness: 0.55 })
        );
        rock.position.set(h.x, this.terrain.heightAt(h.x, h.z) + 2.4, h.z);
        rock.castShadow = true;
        this.scene.add(rock);
        this.hud.toast("SCOUT: HIDDEN HAZARD CONTACT");
        this._log("Scout detected a hidden hazard");
      }
    }
  }

  _updateSun() {
    if (!this.lights) return;
    const p = this.astronaut.position;
    this.lights.sun.target.position.copy(p);
    this.lights.sun.position.set(p.x + 180, p.y + 140, p.z + 90);
    this.lights.sun.target.updateMatrixWorld();
  }

  _updateFalling(dt) {
    for (const rock of this.fallingRocks) {
      rock.velocity.y -= 1.62 * dt;
      rock.mesh.position.addScaledVector(rock.velocity, dt);
      rock.mesh.rotation.x += dt * 1.2;
      const g = this.terrain.heightAt(rock.mesh.position.x, rock.mesh.position.z) + 2;
      if (rock.mesh.position.y < g) {
        rock.mesh.position.y = g;
        rock.velocity.set(0, 0, 0);
      }
    }
  }

  _updateExtract(dt) {
    this.sampler.extractProgress = this.extract.progress;
    if (!this.sampler.arrived) {
      // Drilling starts only once the rover is parked at the core site.
      return;
    }
    if (this.input.down("KeyA")) this.extract.rpm = Math.max(120, this.extract.rpm - dt * 220);
    if (this.input.down("KeyD")) this.extract.rpm = Math.min(1400, this.extract.rpm + dt * 220);
    if (this.input.down("KeyW")) this.extract.progress += dt * 0.08 * (this.extract.rpm / 800);
    if (this.input.down("KeyS")) this.extract.progress += dt * 0.02;
    this.extract.progress += dt * 0.035 * (this.extract.rpm / 900);
    this.extract.torque = this.extract.rpm * 0.08 * this.extract.density;
    this.extract.heat += dt * (this.extract.rpm / 400) * this.extract.density;
    this.extract.heat -= dt * 28;
    this.extract.heat = Math.max(20, this.extract.heat);
    this.astronaut.powerUsed += dt * 2.2;
    if (this.extract.heat > 920) {
      this.extract.progress = Math.max(0, this.extract.progress - 0.15);
      this.extract.heat = 700;
      this.hud.toast("THERMAL TRIP — BIT RETRACT");
    }
    if (this.extract.progress >= 1) {
      this.extract.progress = 1;
      this.extracting = false;
      this.sampler.drilling = false;
      this.sampler.extractProgress = 0;
      this.rig.setMode("eva");
      this.sample = {
        id: "LG-" + Date.now().toString(36).toUpperCase(),
        integrity: THREE.MathUtils.clamp(1 - this.extract.heat / 1400, 0.4, 0.99),
        density: this.extract.density,
        site: { x: this.nearestTarget.x, z: this.nearestTarget.z },
      };
      this.hud.toast("CORE SECURED — TRANSPORT TO PRESERVATION ZONE");
      this._log(`Core secured (integrity ${(this.sample.integrity * 100).toFixed(0)}%)`);
      this._complete(1);
    }
  }

  _updateComms() {
    const units = this.rovers.concat([{ position: this.astronaut.position, commsRange: 70, kind: "eva" }]);
    this._clearLos();
    this.losLinks = [];
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i];
        const b = units[j];
        const d = a.position.distanceTo(b.position);
        const range = Math.max(a.commsRange || 80, b.commsRange || 80);
        const blocked = this._terrainBlocks(a.position, b.position);
        const linked = d < range && !blocked;
        if (linked) this._losLine(a.position, b.position, 0x5dff9a);
        else if (d < range * 1.3) this._losLine(a.position, b.position, 0xff5a5a);
        this.losLinks.push({
          ax: a.position.x,
          az: a.position.z,
          bx: b.position.x,
          bz: b.position.z,
          ok: linked,
        });
      }
    }
    this.losOk = this.mission.id !== 3 || this._teamLinked();
  }

  _teamLinked() {
    const nodes = [this.astronaut, ...this.rovers];
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      const i = stack.pop();
      for (let j = 0; j < nodes.length; j++) {
        if (seen.has(j)) continue;
        const d = nodes[i].position.distanceTo(nodes[j].position);
        const range = Math.max(nodes[i].commsRange || 80, nodes[j].commsRange || 80);
        if (d < range && !this._terrainBlocks(nodes[i].position, nodes[j].position)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    return seen.size === nodes.length;
  }

  _terrainBlocks(a, b) {
    for (let t = 0.1; t < 1; t += 0.08) {
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      if (this.terrain.heightAt(x, z) > y - 1.4) return true;
    }
    return false;
  }

  _losLine(a, b, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      a.clone().add(new THREE.Vector3(0, 2.2, 0)),
      b.clone().add(new THREE.Vector3(0, 2.2, 0)),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }));
    this.scene.add(line);
    this._lines.push(line);
  }

  _clearLos() {
    for (const l of this._lines) {
      this.scene.remove(l);
      l.geometry.dispose();
    }
    this._lines = [];
  }

  _complete(i) {
    if (this.objectives[i] && !this.objectives[i].done) {
      this.objectives[i].done = true;
      this._log(`Objective complete: ${this.objectives[i].text}`);
      if (this.objectives.every((o) => o.done)) {
        this.hud.toast("MISSION COMPLETE");
        this._openDebrief(true);
      }
    }
  }

  _openDebrief(success, reason) {
    if (this.debriefed) return;
    this.debriefed = true;
    document.exitPointerLock();
    this.hud.setCoach(null);
    const o = this.outpost.snapshot();
    const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const done = this.objectives.filter((x) => x.done).length;
    const rovDist = this.rovers.reduce((a, r) => a + r.distance, 0);
    const dist = (this.astronaut?.distance || 0) + rovDist;
    const outcome = success
      ? "MISSION COMPLETE — all objectives satisfied"
      : reason
        ? `MISSION FAILED — ${reason}`
        : "MISSION ABORTED — clock expired";
    const lines = [
      `Site: ${this.site.name}`,
      `Mission: ${this.mission.title}`,
      `Outcome: ${outcome}`,
      `Mission time: ${mmss(this.missionClock)} (habitat clock ${o.simHours.toFixed(1)} simulated hours)`,
      `Objectives: ${done}/${this.objectives.length} complete`,
      "",
      "MOVEMENT",
      `  Distance travelled: ${dist.toFixed(0)} m (EVA ${(this.astronaut?.distance || 0).toFixed(0)} m, rovers ${rovDist.toFixed(0)} m)`,
      `  MMU propellant remaining: ${((this.astronaut?.fuel || 0) * 100).toFixed(0)}%`,
      "",
      "ROVERS",
      ...this.rovers.map(
        (r) =>
          `  ${r.kind.toUpperCase()}: battery ${(r.battery * 100).toFixed(0)}% (${(r.battery * ROVER.capKwh).toFixed(1)} kWh) · used ${(r.energyUsedKwh || 0).toFixed(2)} kWh · charged ${(r.energyChargedKwh || 0).toFixed(2)} kWh`
      ),
      "",
      "RESOURCES (gameplay parameters)",
      `  Habitat power: ${o.batteryKwh.toFixed(1)} kWh left (lowest ${o.batteryMinKwh.toFixed(1)}), generated ${o.totals.generated.toFixed(1)} kWh`,
      `  Consumed: life support ${o.totals.lifeSupport.toFixed(1)} kWh · hydroponics ${o.totals.hydroponics.toFixed(1)} kWh · rover charging ${o.totals.rovers.toFixed(1)} kWh`,
      `  Oxygen ${o.o2Kg.toFixed(1)} kg · water ${o.waterKg.toFixed(1)} kg · food ${o.foodKg.toFixed(1)} kg`,
      `  Radiation dose: ${o.doseMsv.toFixed(2)} mSv of ${this.outpost.p.doseLimit} mSv mission limit`,
      `  Power mode at end: ${o.mode}`,
      "",
      "SCIENCE & HAZARDS",
      `  Samples stored: ${this.samplesStored}${this.sample ? ` (integrity ${(this.sample.integrity * 100).toFixed(0)}%)` : ""}`,
      `  Hazards encountered: ${this.hazards.length}`,
      `  Layers used: ${[...this.layersUsed].sort().join(", ") || "none"}`,
      `  Comms mesh: ${this.losOk ? "NOMINAL" : "DEGRADED"}`,
    ];
    if (this.mission.id === 2 && this.routeMetrics) {
      const s = this.routeMetrics.short;
      const a = this.routeMetrics.safe;
      lines.push(
        "",
        "ROUTE COMPARISON",
        `  Shortest: ${s.distance.toFixed(0)} m, max slope ${s.maxSlope.toFixed(0)}°, est. ${s.energyKwh.toFixed(2)} kWh`,
        `  Terrain-aware: ${a.distance.toFixed(0)} m, max slope ${a.maxSlope.toFixed(0)}°, est. ${a.energyKwh.toFixed(2)} kWh`,
        `  You followed the terrain-aware path: ${this.objectives[1]?.done ? "yes" : "no"}`
      );
    }
    if (this.log.length) {
      lines.push("", "KEY EVENTS & DECISIONS", ...this.log.slice(-12).map((e) => `  ${mmss(e.t)}  ${e.text}`));
    }
    lines.push("", "WHY IT MATTERS", `  ${this.mission.learn}`);
    this.hud.showDebrief(
      success ? "MISSION COMPLETE" : "MISSION FAILED",
      this.site.name.toUpperCase(),
      lines.join("\n"),
      this.mission.check,
      (ok, text) => {
        this.quizResult = { correct: ok, answer: text };
      }
    );
  }

  _updateMissions(dt) {
    const id = this.mission.id;
    const distBravo = Math.hypot(this.astronaut.position.x - this.bravo.x, this.astronaut.position.z - this.bravo.z);

    if (id === 1) {
      if (this.layersUsed.size >= 3) this._complete(0);
      const safe = this.terrain.safetyIndex(this.astronaut.position.x, this.astronaut.position.z);
      if (safe < 0.28) this._complete(1);
    }

    if (id === 2) {
      if (this.mapOpen) this._complete(0);
      const onSafe = nearPath(this.astronaut.position, this.paths.safe, 18);
      if (onSafe) this._complete(1);
      if (distBravo < 14) this._complete(2);
    }

    if (id === 3) {
      if (this.losOk) this._complete(0);
      const crater = Math.hypot(this.mapper.position.x - 40, this.mapper.position.z + 30);
      if (crater < 22) {
        this.mapper.scanComplete = true;
        this._complete(1);
      }
      if (this.sampler.position.distanceTo(this.targets[1].position) < 16) this._complete(2);
      if (this.hiddenHazards.some((h) => h.found) && this.losOk) this._complete(0);
    }

    if (id === 4) {
      this.timer -= dt;
      if (!this.hazardFired && this.timer < 150) this._triggerHazard();
      if (this.hazardFired) this._complete(1);
      if (distBravo < 16) this._complete(2);
      if (this.timer < 175) this._complete(0);
      if (this.timer <= 0 && !this.objectives[2].done) {
        this.hud.toast("TIME EXPIRED — RETURN TO HUB");
        this._openDebrief(false);
        this.running = false;
      }
      this.objectives[0].text = `Timed traverse (${Math.max(0, this.timer).toFixed(0)}s remaining)`;
    }

    if (id === 5) {
      if (this.wristOpen) this._complete(0);
      if (this.sample) this._complete(1);
      this.checklist.contact = this.astronaut.nearGround;
      this.checklist.stable = this.astronaut.velocity.length() < 1.8;
      this.checklist.lock = false;
      if (this.sample && !this.sample.stored) {
        let holding = false;
        for (const z of this.zones) {
          const inZone = Math.hypot(this.astronaut.position.x - z.x, this.astronaut.position.z - z.z) < z.r;
          if (inZone && this.checklist.contact && this.checklist.stable) {
            holding = true;
            this.preserveHold += dt;
            if (this.preserveHold > 2.2) {
              this.checklist.lock = true;
              this.sample.stored = true;
              this.samplesStored += 1;
              this._complete(2);
              this._exportReport();
              this.hud.toast("PRESERVATION CHECKLIST COMPLETE — REPORT EXPORTED");
            }
          }
        }
        if (!holding) this.preserveHold = 0;
      } else {
        this.preserveHold = 0;
      }
    }
  }

  _triggerHazard() {
    this.hazardFired = true;
    this._log("Slope collapse blocked the planned route");
    if (this.outpost) {
      this.outpost.setSolarEvent(true);
      this._sepT = 45;
      this._log("Solar particle event began");
    }
    const hx = 20;
    const hz = 10;
    this.terrain.addBlock(hx, hz, 22);
    this.hazards.push({ x: hx, z: hz, r: 22 });
    const geo = new THREE.DodecahedronGeometry(8, 0);
    const rock = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x6a5f55, roughness: 0.6 })
    );
    rock.position.set(hx, this.terrain.heightAt(hx, hz) + 18, hz);
    rock.castShadow = true;
    this.scene.add(rock);
    this.fallingRocks.push({ mesh: rock, velocity: new THREE.Vector3(2, 0, -1) });
    for (let i = 0; i < 5; i++) {
      const shard = new THREE.Mesh(
        new THREE.DodecahedronGeometry(2 + Math.random() * 2, 0),
        new THREE.MeshStandardMaterial({ color: 0x6a5f55, roughness: 0.6 })
      );
      shard.position.set(hx + (Math.random() - 0.5) * 10, this.terrain.heightAt(hx, hz) + 22 + i * 2, hz + (Math.random() - 0.5) * 10);
      shard.castShadow = true;
      this.scene.add(shard);
      this.fallingRocks.push({
        mesh: shard,
        velocity: new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6),
      });
    }
    this.grid = buildNavGrid(this.terrain, 120, [this.alpha, this.bravo]);
    for (const r of this.rovers) r.nav = this.grid;
    const extra = new Set();
    const idx = worldToIndex(this.grid, hx, hz);
    extra.add(idx);
    const detour = astar(this.grid, this.astronaut.position, this.bravo, extra);
    this.paths.detour = detour.path;
    this._drawPath(this.paths.detour, 0xffb347);
    this._refreshRouteMetrics();
    this.sampler.setPath(this.paths.detour);
    this.hud.toast("HAZARD: SLOPE COLLAPSE — DYNAMIC REROUTE");
  }

  _exportReport() {
    const dist = this.astronaut.distance + this.sampler.distance;
    const ideal = this.routeStats.safe || dist;
    const efficiency = THREE.MathUtils.clamp((ideal / Math.max(dist, 0.01)) * 100, 4, 99.9);
    const report = {
      mission: this.mission.title,
      site: this.site,
      timestamp: new Date().toISOString(),
      telemetry: {
        gravity_mps2: 1.62,
        latitude: this.site.lat,
        longitude: this.site.lon,
        distance_traveled_m: Number(dist.toFixed(2)),
        path_efficiency_pct: Number(efficiency.toFixed(2)),
        habitat_energy_consumed_kwh: Number((this.outpost.totals.lifeSupport + this.outpost.totals.hydroponics + this.outpost.totals.rovers).toFixed(3)),
        eva_suit_power_estimate_kwh_illustrative: Number((this.astronaut.powerUsed * 0.04).toFixed(3)),
        mmu_propellant_remaining: Number(this.astronaut.fuel.toFixed(3)),
        comms_latency_ms: Number((8 + this.astronaut.position.distanceTo(this.sampler.position) * 0.04).toFixed(1)),
      },
      sample: this.sample,
      outpost: this.outpost.snapshot(),
      route_metrics: this.routeMetrics,
      rovers: this.rovers.map((r) => ({
        kind: r.kind,
        battery_pct: Number((r.battery * 100).toFixed(1)),
        distance_m: Number(r.distance.toFixed(1)),
        energy_used_kwh: Number((r.energyUsedKwh || 0).toFixed(3)),
        energy_charged_kwh: Number((r.energyChargedKwh || 0).toFixed(3)),
      })),
      events: this.log,
      data_provenance:
        "Procedurally generated terrain and gameplay parameters. No NASA terrain or illumination dataset is loaded; values are simulation estimates, not NASA data.",
      preservation_zones: this.zones.map((z) => ({ x: z.x, z: z.z, radius_m: z.r })),
      routes: {
        dijkstra_cost: this.routeStats.short,
        terrain_aware_cost: this.routeStats.safe,
      },
      checklist: {
        wrist_terminal: true,
        extraction_complete: true,
        surface_contact_clear: this.checklist.contact,
        hover_stable: this.checklist.stable,
        preservation_lock: true,
      },
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lunar-guardian-report-${this.sample.id}.json`;
    a.click();
  }
}

function qsClick(id, fn) {
  document.getElementById(id).onclick = fn;
}

function offsetPath(path, offset) {
  return path.map((p, i) => {
    const n = path[Math.min(i + 1, path.length - 1)];
    const dx = n.x - p.x;
    const dz = n.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x + (-dz / len) * offset, z: p.z + (dx / len) * offset };
  });
}

function nearPath(pos, path, rad) {
  return path.some((p) => Math.hypot(pos.x - p.x, pos.z - p.z) < rad);
}
