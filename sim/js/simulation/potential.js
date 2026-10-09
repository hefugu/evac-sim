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
    canTraverseEdge,
    traversalCost = () => 0,
    stairCost = dst => Math.max(1, Number(dst.travelCostSec) || 8)
  } = ctx;
  if (!grid || !seeds || seeds.length === 0 || !floorStates.length) return null;

  const potential = new Array(floorCount).fill(null).map(() =>
    new Array(gridH).fill(null).map(() => new Array(gridW).fill(Infinity))
  );

  // Dijkstra: nonnegative hazard and stair costs need a priority queue.
  const q = [];
  const push = item => {
    let i = q.length;
    q.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent].cost <= item.cost) break;
      q[i] = q[parent]; i = parent;
    }
    q[i] = item;
  };
  const pop = () => {
    const first = q[0], last = q.pop();
    if (q.length) {
      let i = 0;
      while (i * 2 + 1 < q.length) {
        let child = i * 2 + 1;
        if (child + 1 < q.length && q[child + 1].cost < q[child].cost) child++;
        if (q[child].cost >= last.cost) break;
        q[i] = q[child]; i = child;
      }
      q[i] = last;
    }
    return first;
  };
  seeds.forEach(({ floor, cx, cy }) => {
    const f = Number.isFinite(floor) ? floor : currentFloor;
    if (f < 0 || f >= floorCount) return;
    if (!isAgentTraversableCell(f, cx, cy)) return;
    potential[f][cy][cx] = 0;
    push({ floor: f, cx, cy, cost: 0 });
  });
  if (q.length === 0) return potential;

  const dirs = [
    { dx: 1, dy: 0, c: 1 }, { dx: -1, dy: 0, c: 1 },
    { dx: 0, dy: 1, c: 1 }, { dx: 0, dy: -1, c: 1 },
    { dx: 1, dy: 1, c: 1.414 }, { dx: -1, dy: 1, c: 1.414 },
    { dx: 1, dy: -1, c: 1.414 }, { dx: -1, dy: -1, c: 1.414 }
  ];

  while (q.length) {
    const { floor, cx, cy, cost } = pop();
    if (cost !== potential[floor][cy][cx]) continue;
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
      const newPot = base + d.c * (1 + Math.max(0, traversalCost(floor, cx, cy)));
      if (newPot < potential[floor][ny][nx]) {
        potential[floor][ny][nx] = newPot;
        push({ floor, cx: nx, cy: ny, cost: newPot });
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
        const newPot = base + Math.max(0.001, stairCost(dst)) + Math.max(0, traversalCost(floor, cx, cy));
        if (newPot < potential[dst.floor][dst.cy][dst.cx]) {
          potential[dst.floor][dst.cy][dst.cx] = newPot;
          push({ floor: dst.floor, cx: dst.cx, cy: dst.cy, cost: newPot });
        }
      }
    }
  }
  return potential;
}
