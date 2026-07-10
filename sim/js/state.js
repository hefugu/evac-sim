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
    nextCongestionSampleAt: 0,
    stairTraffic: null,
    stairCongestion: [],
    verticalSmokeTransfers: [],
    fireStats: {
      activeFireCount: 0,
      totalHrrKw: 0
    }
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
    lastScene: null,
    revision: 0,
    geometryRevision: 0,
    viewMode: "2d",
    renderer3d: null
  },
  spatial: {
    cellSizeMeters: 0.5,
    floorHeightMeters: 3.5,
    wallHeightMeters: 2.8,
    activeMapProfile: null
  },
  hazards: {
    fds: {
      active: false,
      name: null,
      rows: 0,
      times: [],
      frames: [],
      stats: null
    }
  },
  evaluation: {
    floorOccupancy: {},
    stairCongestion: {},
    stuckEvents: 0,
    teacherFollowSamples: 0,
    teacherFollowActiveSamples: 0,
    panicEscapeEvents: 0
  }
};

export function syncLegacyState() {
  state.simRunning = state.sim.running;
  state.simTime = state.sim.time;
  state.currentFloor = state.map.currentFloor;
  state.floors = state.map.floorStates;
}
