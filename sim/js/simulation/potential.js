export function computePotentialFieldFromSeedsModule(seeds, ctx) {
  const {
    grid,
    floorStates,
    floorCount,
    gridW,
    gridH,
    currentFloor,
    isAgentTraversableCell,
    getLinkedStairDestinations,
    canTraverseEdge
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
      if (!isAgentTraversableCell(floor, nx, ny)) continue;
      // The field is expanded backwards from the exit. Ask the optional edge
      // policy about the corresponding forward agent move: neighbour -> current.
      if (
        typeof canTraverseEdge === "function" &&
        !canTraverseEdge(floor, nx, ny, floor, cx, cy)
      ) continue;
      if (d.dx !== 0 && d.dy !== 0) {
        // Never squeeze diagonally through a blocked wall/fire corner.
        if (
          !isAgentTraversableCell(floor, cx + d.dx, cy) ||
          !isAgentTraversableCell(floor, cx, cy + d.dy)
        ) continue;
      }
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
        if (
          typeof canTraverseEdge === "function" &&
          !canTraverseEdge(dst.floor, dst.cx, dst.cy, floor, cx, cy)
        ) continue;
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
