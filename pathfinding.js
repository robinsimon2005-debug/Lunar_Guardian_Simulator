import { driveEnergyKwh, ROVER } from "./outpost.js";

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export function buildNavGrid(terrain, size = 120, keepClear = []) {
  const cells = [];
  const step = terrain.worldSize / size;
  const half = terrain.worldSize * 0.5;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const wx = -half + (x + 0.5) * step;
      const wz = -half + (z + 0.5) * step;
      const y = terrain.heightAt(wx, wz);
      const slope = terrain.slopeAt(wx, wz);
      const shadow = terrain.illuminationAt(wx, wz) < 0.22 ? 1 : 0;
      const rough = terrain.roughnessAt(wx, wz);
      let obstacle = slope > 38 || terrain.isBlocked(wx, wz);
      if (obstacle && keepClear.some((p) => Math.hypot(wx - p.x, wz - p.z) < 9)) obstacle = false;
      cells.push({ x, z, wx, wz, y, slope, shadow, rough, obstacle });
    }
  }
  return { size, step, half, cells };
}

function neighbors(grid, i) {
  const { size } = grid;
  const x = i % size;
  const z = Math.floor(i / size);
  const out = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      out.push({ i: nz * size + nx, diag: dx !== 0 && dz !== 0 });
    }
  }
  return out;
}

function worldToIndex(grid, wx, wz) {
  const x = Math.max(0, Math.min(grid.size - 1, Math.floor((wx + grid.half) / grid.step)));
  const z = Math.max(0, Math.min(grid.size - 1, Math.floor((wz + grid.half) / grid.step)));
  return z * grid.size + x;
}

export function dijkstra(grid, start, goal, costFn) {
  const n = grid.cells.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const si = worldToIndex(grid, start.x, start.z);
  const gi = worldToIndex(grid, goal.x, goal.z);
  dist[si] = 0;
  const open = new MinHeap();
  open.push(0, si);
  const seen = new Uint8Array(n);

  while (open.size) {
    const u = open.pop();
    if (u === gi) break;
    if (seen[u]) continue;
    seen[u] = 1;
    const cell = grid.cells[u];
    for (const nb of neighbors(grid, u)) {
      const v = nb.i;
      const ncell = grid.cells[v];
      if (ncell.obstacle) continue;
      const step = (nb.diag ? 1.414 : 1) * costFn(cell, ncell);
      const nd = dist[u] + step;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        open.push(nd, v);
      }
    }
  }

  const path = [];
  if (dist[gi] === Infinity) return { path, cost: Infinity };
  for (let cur = gi; cur !== -1; cur = prev[cur]) {
    const c = grid.cells[cur];
    path.push({ x: c.wx, z: c.wz, y: c.y });
  }
  path.reverse();
  return { path, cost: dist[gi] };
}

export function shortestCost(_a, _b) {
  return 1;
}

export function terrainAwareCost(a, b) {
  let c = 1 + b.slope / 18;
  if (b.slope > 15) c += (b.slope - 15) * 0.55;
  if (b.shadow) c += 2.8;
  c += b.rough * 1.6;
  return c;
}

export function astar(grid, start, goal, blockedExtra = new Set()) {
  const n = grid.cells.length;
  const si = worldToIndex(grid, start.x, start.z);
  const gi = worldToIndex(grid, goal.x, goal.z);
  const gScore = new Float64Array(n).fill(Infinity);
  const fScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  gScore[si] = 0;
  const goalCell = grid.cells[gi];
  const heur = (i) => {
    const c = grid.cells[i];
    return Math.hypot(c.x - goalCell.x, c.z - goalCell.z);
  };
  fScore[si] = heur(si);
  const open = new MinHeap();
  open.push(fScore[si], si);
  const closed = new Uint8Array(n);

  while (open.size) {
    const u = open.pop();
    if (u === gi) break;
    if (closed[u]) continue;
    closed[u] = 1;
    for (const nb of neighbors(grid, u)) {
      const v = nb.i;
      const ncell = grid.cells[v];
      if (ncell.obstacle || blockedExtra.has(v)) continue;
      const step = (nb.diag ? 1.414 : 1) * terrainAwareCost(grid.cells[u], ncell);
      const ng = gScore[u] + step;
      if (ng < gScore[v]) {
        prev[v] = u;
        gScore[v] = ng;
        fScore[v] = ng + heur(v);
        closed[v] = 0;
        open.push(fScore[v], v);
      }
    }
  }

  const path = [];
  if (gScore[gi] === Infinity) return { path, cost: Infinity };
  for (let cur = gi; cur !== -1; cur = prev[cur]) {
    const c = grid.cells[cur];
    path.push({ x: c.wx, z: c.wz, y: c.y });
  }
  path.reverse();
  return { path, cost: gScore[gi] };
}

/**
 * Quantify a route on the existing navigation grid. Uses the same slope,
 * shadow and obstacle data the planners use, and the same energy model the
 * rover drains its battery with.
 *  - distance: metres along the path (planar + elevation change)
 *  - cost: terrainAwareCost summed over the path (comparable between routes)
 *  - hazardM: metres of path within hazardMargin of a known hazard
 */
export function routeMetrics(grid, path, opts = {}) {
  const kind = opts.kind || "sampler";
  const speed = opts.speed || 5.5;
  const hazards = opts.hazards || [];
  const margin = opts.hazardMargin ?? 8;
  const m = {
    valid: Boolean(path && path.length > 1),
    distance: 0, meanSlope: 0, maxSlope: 0, shadowPct: 0, obstacleExposurePct: 0,
    hazardM: 0, cost: 0, energyKwh: 0, batteryPct: 0,
  };
  if (!m.valid) return m;
  let slopeWeighted = 0;
  let shadowM = 0;
  let nearObs = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dy = (b.y ?? 0) - (a.y ?? 0);
    const seg = Math.hypot(b.x - a.x, b.z - a.z, dy);
    const ai = worldToIndex(grid, a.x, a.z);
    const bi = worldToIndex(grid, b.x, b.z);
    const ca = grid.cells[ai];
    const cb = grid.cells[bi];
    const slope = (ca.slope + cb.slope) / 2;
    m.distance += seg;
    slopeWeighted += slope * seg;
    m.maxSlope = Math.max(m.maxSlope, cb.slope);
    if (cb.shadow) shadowM += seg;
    if (adjacentObstacle(grid, bi)) nearObs += seg;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    if (hazards.some((h) => Math.hypot(mx - h.x, mz - h.z) < (h.r || 0) + margin)) m.hazardM += seg;
    if (ai !== bi) {
      const diag = ca.x !== cb.x && ca.z !== cb.z;
      m.cost += (diag ? 1.414 : 1) * terrainAwareCost(ca, cb);
    }
    m.energyKwh += driveEnergyKwh(kind, seg, slope, speed);
  }
  m.meanSlope = slopeWeighted / Math.max(m.distance, 1e-6);
  m.shadowPct = (shadowM / Math.max(m.distance, 1e-6)) * 100;
  m.obstacleExposurePct = (nearObs / Math.max(m.distance, 1e-6)) * 100;
  m.batteryPct = (m.energyKwh / ROVER.capKwh) * 100;
  return m;
}

function adjacentObstacle(grid, i) {
  for (const nb of neighbors(grid, i)) if (grid.cells[nb.i].obstacle) return true;
  return false;
}

export { worldToIndex };
