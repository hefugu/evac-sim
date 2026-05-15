export const state = {
  // legacy-flat fields (kept for compatibility)
  agents: [],
  simRunning: false,
  simTime: 0,
  exits: [],
  spawns: [],
  floors: [],
  currentFloor: 0,

  // structured runtime state
  map: {
    baseImage: null,
    grid: null,
    gridW: 0,
    gridH: 0,
    baseWalkableTemplate: null,
    floorStates: [],
    floorCount: 1,
    currentFloor: 0,
    stairLinks: [],
    pendingStairLink: null,
    allExitPoints: [],
    allSpawnPoints: []
  },
  sim: {
    running: false,
    time: 0,
    lastFrameTime: 0,
    heatmap: null,
    smokeMap: null,
    smokeCeil: null,
    flowField: null,
    potentialByExit: [],
    combinedPotential: null,
    potentialLegendMax: 1,
    maxHeatCell: null,
    maxHeatValue: 0,
    congestionHistory: [],
    bottleneckReport: [],
    paramHistory: [],
    lastSummary: null,
    nextRouteReplanAt: 0,
    nextCongestionSampleAt: 0
  },
  mc: {
    running: false,
    runs: 0,
    targetRuns: 100,
    results: []
  },
  viz: {
    trails: true,
    flow: true,
    potential: false,
    potentialViewMode: "combined",
    potentialExitIndex: 1
  },
  ui: {
    refs: null
  },
  render: {
    lastScene: null
  }
};

export function syncLegacyState() {
  state.simRunning = state.sim.running;
  state.simTime = state.sim.time;
  state.currentFloor = state.map.currentFloor;
  state.floors = state.map.floorStates;
}
