import { fbm } from "./noise.js";
import { PARAMS, ROVER } from "./outpost.js";

export function qs(id) {
  return document.getElementById(id);
}

export class HUD {
  constructor() {
    this.minimap = qs("minimap");
    this.mctx = this.minimap.getContext("2d");
    this.map = qs("map-canvas");
    this.xctx = this.map.getContext("2d");
    this.elev = qs("elev-profile");
    this.ectx = this.elev.getContext("2d");
    this.heightImg = null;
  }

  setTerrainPreview(field) {
    const c = document.createElement("canvas");
    c.width = c.height = field.res;
    c.getContext("2d").putImageData(new ImageData(field.data, field.res, field.res), 0, 0);
    this.heightImg = c;
  }

  toast(msg, ms = 2200) {
    const el = qs("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this._tt);
    this._tt = setTimeout(() => el.classList.remove("show"), ms);
  }

  setCoach(text) {
    const el = qs("coach");
    el.classList.toggle("hidden", !text);
    if (text) qs("coach-text").textContent = text;
  }

  setHubVisible(v) {
    qs("hub").classList.toggle("hidden", !v);
    qs("hud").classList.toggle("hidden", v);
  }

  fillHub(sites, missions, state, onPickSite, onPickMission, onLaunch) {
    const sl = qs("site-list");
    const ml = qs("mission-list");
    sl.innerHTML = "";
    ml.innerHTML = "";
    for (const s of sites) {
      const b = document.createElement("button");
      b.className = "choice" + (state.site.id === s.id ? " active" : "");
      b.innerHTML = `${s.name}<small>LAT ${s.lat.toFixed(2)} · LON ${s.lon.toFixed(2)}</small>`;
      b.onclick = () => onPickSite(s);
      sl.appendChild(b);
    }
    for (const m of missions) {
      const b = document.createElement("button");
      b.className = "choice" + (state.mission.id === m.id ? " active" : "");
      b.innerHTML = `${m.title}<small>${m.blurb}</small>`;
      b.onclick = () => onPickMission(m);
      ml.appendChild(b);
    }
    const m = state.mission;
    const li = (arr) => `<ul class="brief-list">${(arr || []).map((x) => `<li>${x}</li>`).join("")}</ul>`;
    qs("briefing").innerHTML = `
      <b>${m.title}</b><p>${m.blurb}</p>
      <div class="brief-grid">
        <div><div class="label">OBJECTIVES</div>${li(m.objectives)}</div>
        <div><div class="label">EQUIPMENT</div>${li(m.equipment)}</div>
        <div><div class="label">TARGET &amp; SITE</div>
          <ul class="brief-list"><li>${state.site.name} · LAT ${state.site.lat.toFixed(2)} · LON ${state.site.lon.toFixed(2)}</li>
          <li>Landing Alpha to Target Bravo (about 236 m straight line)</li>
          <li>Terrain: procedurally generated (no NASA terrain dataset loaded)</li></ul></div>
        <div><div class="label">STARTING STATUS</div>
          <ul class="brief-list"><li>Rovers: ${ROVER.capKwh} kWh battery each, 100% charged</li>
          <li>Habitat: ${PARAMS.batteryStartKwh}/${PARAMS.batteryCapKwh} kWh battery, ${PARAMS.crew} crew</li>
          <li>Reserves: O2 ${PARAMS.o2Start} kg · water ${PARAMS.waterStart} kg · food ${PARAMS.foodStart} kg</li>
          <li>Dose limit ${PARAMS.doseLimit} mSv (gameplay value)</li></ul></div>
        <div style="grid-column:1/3"><div class="label">RISKS</div>${li(m.risks)}</div>
      </div>`;
    qs("launch-btn").onclick = onLaunch;
    this.drawHubPreview(state.site);
  }

  drawHubPreview(site) {
    const c = qs("hub-preview");
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x += 2) {
        const nx = (x / w - 0.5) * 6 + site.seed;
        const nz = (y / h - 0.5) * 2.4 + site.lat * 0.02;
        const n = fbm(nx, nz, 5);
        const v = 40 + n * 180;
        ctx.fillStyle = `rgb(${v * 0.55},${v * 0.58},${v * 0.62})`;
        ctx.fillRect(x, y, 2, 1);
      }
    }
    ctx.fillStyle = "#5ce1ff";
    ctx.fillRect(w * 0.28, h * 0.62, 6, 6);
    ctx.fillStyle = "#ffb347";
    ctx.fillRect(w * 0.72, h * 0.34, 6, 6);
    ctx.fillStyle = "#d7f4ff";
    ctx.font = "12px Share Tech Mono, monospace";
    ctx.fillText("ALPHA", w * 0.28 + 10, h * 0.62 + 10);
    ctx.fillText("BRAVO", w * 0.72 + 10, h * 0.34 + 10);
  }

  showDebrief(title, status, body, check, onAnswer) {
    qs("debrief").classList.remove("hidden");
    qs("debrief-title").textContent = title;
    qs("debrief-status").textContent = status;
    qs("debrief-body").textContent = body;
    const kc = qs("knowledge-check");
    kc.innerHTML = "";
    kc.classList.toggle("hidden", !check);
    if (!check) return;
    const q = document.createElement("div");
    q.className = "kc-q";
    q.textContent = "KNOWLEDGE CHECK · " + check.q;
    kc.appendChild(q);
    const why = document.createElement("div");
    why.className = "kc-why";
    let answered = false;
    check.options.forEach((text, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kc-opt";
      b.textContent = text;
      b.onclick = () => {
        if (answered) return;
        answered = true;
        const ok = i === check.answer;
        b.classList.add(ok ? "right" : "wrong");
        kc.querySelectorAll(".kc-opt")[check.answer].classList.add("right");
        why.textContent = (ok ? "Correct. " : "Not quite. ") + check.why;
        onAnswer?.(ok, text);
      };
      kc.appendChild(b);
    });
    kc.appendChild(why);
  }

  showPause(game) {
    qs("pause").classList.remove("hidden");
    qs("pause-mission").textContent = game.mission.title;
    qs("pause-site").textContent = game.site.name.toUpperCase();
    const ul = qs("pause-objectives");
    ul.innerHTML = "";
    const firstOpen = game.objectives.findIndex((x) => !x.done);
    game.objectives.forEach((o, i) => {
      const li = document.createElement("li");
      li.textContent = o.text;
      if (o.done) li.className = "done";
      else if (i === firstOpen) li.className = "active";
      ul.appendChild(li);
    });
  }

  hidePause() {
    qs("pause").classList.add("hidden");
  }

  hideDebrief() {
    qs("debrief").classList.add("hidden");
  }

  updateFlight(game) {
    const { astronaut, site, mission, objectives } = game;
    qs("mission-title").textContent = mission.title;
    qs("mission-phase").textContent = site.name.toUpperCase();
    const lat = site.lat + astronaut.position.z * 0.00021;
    const lon = site.lon + astronaut.position.x * 0.00021;
    qs("tel-lat").textContent = lat.toFixed(3);
    qs("tel-lon").textContent = lon.toFixed(3);
    qs("tel-elv").textContent = `${astronaut.position.y.toFixed(1)} m`;
    const dist = astronaut.position.distanceTo(game.sampler.position);
    const latency = 8 + dist * 0.04 + (game.losOk ? 0 : 40);
    qs("tel-latn").textContent = `${latency.toFixed(0)} ms`;
    qs("heat-fill").style.width = `${astronaut.heat * 100}%`;
    qs("heat-fill").style.background =
      astronaut.heat > 0.8 ? "#ff5a5a" : "linear-gradient(90deg, #5ce1ff, #ffb347)";
    qs("fuel-fill").style.width = `${astronaut.fuel * 100}%`;

    const ul = qs("objectives");
    ul.innerHTML = "";
    objectives.forEach((o, i) => {
      const li = document.createElement("li");
      li.textContent = o.text;
      if (o.done) li.className = "done";
      else if (i === objectives.findIndex((x) => !x.done)) li.className = "active";
      ul.appendChild(li);
    });

    const units = game.rovers
      .map(
        (r) =>
          `${r.kind.toUpperCase()} PWR ${(r.battery * 100).toFixed(0)}% (${(r.battery * ROVER.capKwh).toFixed(1)} kWh) · ${(r.loadKw ?? 0).toFixed(1)} kW${r.docked ? " · CHARGING" : r.battery <= 0 ? " · EMPTY" : ""}`
      )
      .join("<br>");
    qs("unit-status").innerHTML = units;

    const safe = game.terrain.safetyIndex(astronaut.position.x, astronaut.position.z);
    qs("safety-idx").textContent = `SAFETY INDEX ${safe.toFixed(2)} · SIM ESTIMATE (lower = safer)`;
    qs("zone-r").textContent = `PRESERVE R ${game.zones[0]?.r ?? 10} m · LATN ${latency.toFixed(0)} ms`;
    const grid = game.powerGrid ?? 1;
    qs("grid-fill").style.width = `${grid * 100}%`;
    qs("grid-fill").style.background =
      grid < 0.25 ? "#ff5a5a" : "linear-gradient(90deg, #5ce1ff, #5dff9a)";

    document.querySelectorAll("#layer-legend li").forEach((li) => {
      li.classList.toggle("active-layer", Number(li.dataset.layer) === game.layer);
    });

    qs("wrist").classList.toggle("hidden", !game.wristOpen);
    const range = astronaut.position.distanceTo(game.nearestTarget.position);
    qs("wrist-range").textContent = `RANGE: ${range.toFixed(1)} m`;
    qs("wrist-link").textContent =
      range < 28 ? `LINK: MMSEV LOCK · ${game.nearestTarget?.name || "TARGET"}` : "LINK: SEARCHING";
    qs("wrist-body").textContent = game.extracting
      ? "Fixed camera on the sampling arm. Modulate RPM with A/D. Keep thermal under 920 °C."
      : range < 28
        ? "Target in envelope. Press E to command the MMSEV arm to drill a core."
        : "Fly closer to a science beacon to establish wrist-link.";
    const chk = game.checklist || {};
    qs("wrist-check").textContent = `CONTACT ${chk.contact ? "OK" : "--"} · STABLE ${chk.stable ? "OK" : "--"} · LOCK ${chk.lock ? "OK" : "--"}`;

    qs("extract-hud").classList.toggle("hidden", !game.extracting);
    if (game.extracting) {
      qs("ex-rpm").textContent = game.extract.rpm.toFixed(0);
      qs("ex-torque").textContent = `${game.extract.torque.toFixed(0)} Nm`;
      qs("ex-heat").textContent = `${game.extract.heat.toFixed(0)} °C`;
      qs("ex-dens").textContent = `${game.extract.density.toFixed(2)} g/cm³`;
      qs("ex-progress").style.width = `${game.extract.progress * 100}%`;
    }

    this.updateOutpost(game);
    this.drawMini(game);
    this.drawElev(game);
    if (game.mapOpen) this.drawMap(game);
  }

  updateOutpost(game) {
    const o = game.outpost;
    if (!o) return;
    const p = o.p;
    const set = (id, frac, text, color) => {
      const bar = qs(id);
      bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      if (color) bar.style.background = color;
      qs(id + "-v").textContent = text;
    };
    const warn = (f) => (f < 0.25 ? "#ff5a5a" : f < 0.5 ? "#ffb347" : "linear-gradient(90deg, #5ce1ff, #5dff9a)");
    qs("op-mode").textContent = o.snapshot().mode;
    const bf = o.batteryKwh / p.batteryCapKwh;
    set("op-batt", bf, `${o.batteryKwh.toFixed(1)} kWh`, warn(bf));
    const of = o.o2Kg / p.o2Start;
    set("op-o2", of, `${o.o2Kg.toFixed(1)} kg`, warn(of));
    const wf = o.waterKg / p.waterStart;
    set("op-h2o", wf, `${o.waterKg.toFixed(1)} kg`, warn(wf));
    const ff = o.foodKg / p.foodStart;
    set("op-food", ff, `${o.foodKg.toFixed(1)} kg`, warn(ff));
    const df = o.doseMsv / p.doseLimit;
    set("op-dose", df, `${o.doseMsv.toFixed(2)} mSv`, df > 0.6 ? "#ff5a5a" : df > 0.3 ? "#ffb347" : "linear-gradient(90deg, #5ce1ff, #5dff9a)");
    const net = o.flow.genKw - o.flow.loadKw;
    const flow = qs("op-flow");
    flow.textContent = `GEN ${o.flow.genKw.toFixed(1)} kW · LOAD ${o.flow.loadKw.toFixed(1)} kW · NET ${net >= 0 ? "+" : ""}${net.toFixed(1)} kW${o.sepActive ? " · SPE ALERT" : o.sheltered ? " · SHELTERED" : " · EXPOSED"}`;
    flow.classList.toggle("warn", net < 0 || o.sepActive);
    const e = o.endurance();
    const fmt = (d) => (Number.isFinite(d) ? d.toFixed(1) : "∞");
    const endure = qs("op-endure");
    endure.textContent = `ENDURANCE ${fmt(e.limiting)} d · LIMIT ${e.which}${o.lifeSupportPowered ? "" : " · LIFE SUPPORT OFFLINE"}`;
    endure.classList.toggle("bad", !o.lifeSupportPowered || e.limiting < 2);
    endure.classList.toggle("warn", o.lifeSupportPowered && e.limiting >= 2 && e.limiting < 4);
  }

  renderRouteCompare(game) {
    const el = qs("route-compare");
    const rm = game.routeMetrics;
    if (!el || !rm) return;
    const cols = [["SHORTEST", rm.short], ["TERRAIN-AWARE", rm.safe]];
    if (rm.detour) cols.push(["DETOUR", rm.detour]);
    const rows = [
      ["Distance (m)", (m) => m.distance.toFixed(0), "distance"],
      ["Mean / max slope (°)", (m) => `${m.meanSlope.toFixed(1)} / ${m.maxSlope.toFixed(0)}`, "meanSlope"],
      ["Shadowed (% of route)", (m) => m.shadowPct.toFixed(0), "shadowPct"],
      ["Near obstacles (%)", (m) => m.obstacleExposurePct.toFixed(0), "obstacleExposurePct"],
      ["Hazard exposure (m)", (m) => m.hazardM.toFixed(0), "hazardM"],
      ["Terrain cost", (m) => m.cost.toFixed(0), "cost"],
      ["Est. rover energy (kWh)", (m) => m.energyKwh.toFixed(2), "energyKwh"],
      ["Est. battery use (%)", (m) => m.batteryPct.toFixed(0), "batteryPct"],
    ];
    const best = (key) => Math.min(...cols.map(([, m]) => m[key]));
    const html = `<table><tr><th></th>${cols.map(([n]) => `<th>${n}</th>`).join("")}</tr>${rows
      .map(
        ([label, f, key]) =>
          `<tr><td>${label}</td>${cols
            .map(([, m]) => `<td class="${Math.abs(m[key] - best(key)) < 1e-9 ? "best" : ""}">${f(m)}</td>`)
            .join("")}</tr>`
      )
      .join("")}</table><div class="note">Green = lowest. Estimates come from this game's navigation grid and rover energy model (procedural terrain, gameplay parameters).</div>`;
    if (html !== this._routeHtml) {
      el.innerHTML = html;
      this._routeHtml = html;
    }
  }

  drawElev(game) {
    const ctx = this.ectx;
    const w = this.elev.width;
    const h = this.elev.height;
    ctx.fillStyle = "#071018";
    ctx.fillRect(0, 0, w, h);
    const yaw = game.astronaut.yaw;
    const ax = game.astronaut.position.x;
    const az = game.astronaut.position.z;
    const samples = 48;
    const reach = 90;
    const heights = [];
    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      const x = ax + Math.sin(yaw) * reach * t;
      const z = az + Math.cos(yaw) * reach * t;
      heights.push(game.terrain.heightAt(x, z));
    }
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    const span = Math.max(4, max - min);
    ctx.beginPath();
    ctx.strokeStyle = "#5ce1ff";
    ctx.lineWidth = 1.5;
    heights.forEach((y, i) => {
      const u = (i / (samples - 1)) * w;
      const v = h - 4 - ((y - min) / span) * (h - 8);
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
    ctx.stroke();
    ctx.fillStyle = "#ffb347";
    ctx.fillRect(2, 2, 3, h - 4);
  }

  worldToPx(x, z, w, h, world) {
    const u = (x / world + 0.5) * w;
    const v = (z / world + 0.5) * h;
    return [u, v];
  }

  drawMini(game) {
    const ctx = this.mctx;
    const w = this.minimap.width;
    const h = this.minimap.height;
    ctx.fillStyle = "#071018";
    ctx.fillRect(0, 0, w, h);
    if (this.heightImg) ctx.drawImage(this.heightImg, 0, 0, w, h);
    this._markers(ctx, game, w, h, true);
  }

  drawMap(game) {
    const ctx = this.xctx;
    const w = this.map.width;
    const h = this.map.height;
    ctx.fillStyle = "#0b1520";
    ctx.fillRect(0, 0, w, h);
    if (this.heightImg) ctx.drawImage(this.heightImg, 0, 0, w, h);
    this._markers(ctx, game, w, h, false);
    qs("map-site").textContent = `SITE: ${game.site.name} · LAYER ${game.layer || "BASE"}`;
    this.renderRouteCompare(game);
  }

  _markers(ctx, game, w, h, mini) {
    const world = game.terrain.worldSize;
    const drawPath = (path, color, dash) => {
      if (!path || path.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = mini ? 1.5 : 2.5;
      ctx.setLineDash(dash || []);
      path.forEach((p, i) => {
        const [u, v] = this.worldToPx(p.x, p.z, w, h, world);
        if (i === 0) ctx.moveTo(u, v);
        else ctx.lineTo(u, v);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    drawPath(game.paths.short, "rgba(255,90,90,0.85)", [6, 4]);
    drawPath(game.paths.safe, "rgba(92,225,255,0.95)", []);
    drawPath(game.paths.detour, "rgba(255,179,71,0.95)", [2, 3]);

    for (const z of game.zones) {
      const [u, v] = this.worldToPx(z.x, z.z, w, h, world);
      ctx.strokeStyle = "#5dff9a";
      ctx.beginPath();
      ctx.arc(u, v, mini ? 8 : 18, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (game.habitat) {
      const [hu, hv] = this.worldToPx(game.habitat.x, game.habitat.z, w, h, world);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(hu - 5, hv - 5, 10, 10);
      if (!mini) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "11px Share Tech Mono, monospace";
        ctx.fillText("HAB", hu + 8, hv + 4);
      }
    }
    for (const t of game.targets) {
      const [u, v] = this.worldToPx(t.x, t.z, w, h, world);
      ctx.fillStyle = "#5ce1ff";
      ctx.fillRect(u - 3, v - 3, 6, 6);
    }
    for (const hzd of game.hazards) {
      const [u, v] = this.worldToPx(hzd.x, hzd.z, w, h, world);
      ctx.fillStyle = "#ff5a5a";
      ctx.beginPath();
      ctx.arc(u, v, mini ? 5 : 10, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!mini && game.losLinks) {
      for (const link of game.losLinks) {
        const [u1, v1] = this.worldToPx(link.ax, link.az, w, h, world);
        const [u2, v2] = this.worldToPx(link.bx, link.bz, w, h, world);
        ctx.strokeStyle = link.ok ? "rgba(93,255,154,0.45)" : "rgba(255,90,90,0.4)";
        ctx.beginPath();
        ctx.moveTo(u1, v1);
        ctx.lineTo(u2, v2);
        ctx.stroke();
      }
    }
    for (const r of game.rovers) {
      const [u, v] = this.worldToPx(r.position.x, r.position.z, w, h, world);
      ctx.fillStyle = r.kind === "scout" ? "#ffcc66" : r.kind === "mapper" ? "#66c2ff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(u, v, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      ctx.moveTo(u, v);
      ctx.lineTo(u + Math.sin(r.heading) * 12, v + Math.cos(r.heading) * 12);
      ctx.stroke();
      if (!mini) {
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.beginPath();
        ctx.arc(u, v, (r.commsRange / world) * w, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const [au, av] = this.worldToPx(
      game.astronaut.position.x,
      game.astronaut.position.z,
      w,
      h,
      world
    );
    ctx.fillStyle = "#ffb347";
    ctx.beginPath();
    ctx.moveTo(au, av - 7);
    ctx.lineTo(au + 5, av + 5);
    ctx.lineTo(au - 5, av + 5);
    ctx.closePath();
    ctx.fill();
    const yaw = game.astronaut.yaw;
    ctx.strokeStyle = "#ffb347";
    ctx.beginPath();
    ctx.moveTo(au, av);
    ctx.lineTo(au + Math.sin(yaw) * 14, av + Math.cos(yaw) * 14);
    ctx.stroke();
  }
}
