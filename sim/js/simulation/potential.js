export const DEFAULT_EXIT_LOAD_PENALTY_PER_AGENT = 0.55;

export function estimateExitRoutingCost(distance, assignedLoad = 0, options = {}) {
  const dist = Number(distance);
  if (!Number.isFinite(dist)) return Infinity;

  const load = Math.max(0, Number(assignedLoad) || 0);
  const requestedWeight = Number(options.loadPenaltyPerAgent);
  const loadPenaltyPerAgent = Number.isFinite(requestedWeight)
    ? Math.max(0, requestedWeight)
    : DEFAULT_EXIT_LOAD_PENALTY_PER_AGENT;

  // Potential-field distance is measured in cell-equivalent steps. Treat the
  // number of agents already assigned to an exit as an expected queue cost in
  // the same units so nearby exits do not attract the entire population.
  return dist + load * loadPenaltyPerAgent;
}

export function canTraverseGridStep(floor, fromCx, fromCy, toCx, toCy, isTraversable) {
  if (typeof isTraversable !== "function") return false;
  if (!isTraversable(floor, toCx, toCy)) return false;

  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return false;
  if (dx === 0 || dy === 0) return true;

  // Prevent a diagonal move from cutting across a wall corner. Requiring both
  // orthogonal side cells to be clear is conservative for finite-size people
  // and keeps the potential field consistent with actual movement geometry.
  return isTraversable(floor, fromCx + dx, fromCy) &&
    isTraversable(floor, fromCx, fromCy + dy);
}

export function computePotentialFieldFromSeedsModule(seeds, ctx) {
  const {
    grid,
    floorStates,
    floorCount,
    gridW,
    gridH,
    currentFloor,
    isAgentTraversableCell,
    getLinkedStairDestinations
  } = ctx;
  if (!grid || !seeds || seeds.length === 0 || !floorStates.length) return null;

  const potential = new Array(floorCount).fill(null).map(() =>
    new Array(gridH).fill(null).map(() => new Array(gridW).fill(Infinity))
  );

  const q = [];
  seeds.forEach(({ floor, cx, cy }) => {
    const f = Number.isFinite(floor) ? floor : currentFloor;
    if (f < 0 || f >= floorCount) return;
    if (!isAgentTraversableCell(f, cx, cy)) return;
    potential[f][cy][cx] = 0;
    q.push({ floor: f, cx, cy });
  });
  if (q.length === 0) return potential;

  const dirs = [
    { dx: 1, dy: 0, c: 1 }, { dx: -1, dy: 0, c: 1 },
    { dx: 0, dy: 1, c: 1 }, { dx: 0, dy: -1, c: 1 },
    { dx: 1, dy: 1, c: 1.414 }, { dx: -1, dy: 1, c: 1.414 },
    { dx: 1, dy: -1, c: 1.414 }, { dx: -1, dy: -1, c: 1.414 }
  ];

  let qi = 0;
  while (qi < q.length) {
    const { floor, cx, cy } = q[qi++];
    const floorGrid = floorStates[floor]?.grid;
    if (!floorGrid) continue;
    const base = potential[floor][cy][cx];
    for (const d of dirs) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (!canTraverseGridStep(floor, cx, cy, nx, ny, isAgentTraversableCell)) continue;
      const newPot = base + d.c;
      if (newPot < potential[floor][ny][nx]) {
        potential[floor][ny][nx] = newPot;
        q.push({ floor, cx: nx, cy: ny });
      }
    }
    if (floorGrid[cy][cx].stair) {
      const linked = getLinkedStairDestinations(floor, cx, cy);
      for (let i = 0; i < linked.length; i++) {
        const dst = linked[i];
        if (!isAgentTraversableCell(dst.floor, dst.cx, dst.cy)) continue;
        const nd = floorStates[dst.floor]?.grid?.[dst.cy]?.[dst.cx];
        if (!nd?.stair) continue;
        const newPot = base + Math.max(1, Number(dst.travelCostSec) || 8);
        if (newPot < potential[dst.floor][dst.cy][dst.cx]) {
          potential[dst.floor][dst.cy][dst.cx] = newPot;
          q.push({ floor: dst.floor, cx: dst.cx, cy: dst.cy });
        }
      }
    }
  }
  return potential;
}
