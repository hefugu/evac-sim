import { bindCoreControls, getUIRefs } from "../ui.js";
import { state, syncLegacyState } from "../state.js";
import { createRenderer } from "../renderer.js";
import { computePotentialFieldFromSeedsModule } from "./potential.js";
import { clamp, parseNum} from "../utils/helpers.js";
import { downloadCsvReport } from "../export/csv.js";
import { loadImageFromFile } from "../mapLoader.js";
import { loadPresetStore, savePresetStore } from "../storage/presets.js";
import { pushParamHistoryEntry, showParamHistoryLog } from "../storage/history.js";
import {
  extractScitech3FGrid,
  isLikelyScitech3FExtraction,
  SCITECH_3F_PROFILE
} from "../scitech3f-map3d.js";
import {
  stepFire3D,
  applyFire3DResultToLegacyFloors
} from "./fire3d.js";
import { transferLegacySmokeThroughStairs } from "./smoke3d.js";
import {
  createStairTrafficState,
  enqueueStairTransition,
  stepStairTraffic,
  getStairCongestion,
  normalizeStairLink
} from "./stairs3d.js";
import {
  normalizeAgent3D,
  deriveAgentBehaviorState,
  chooseClearAirStep,
  summarizeAgentMetrics
} from "./agents3d-sync.js";
import {
  stairEndpointKey,
  normalizeStairLinkEndpoints,
  stairLinkHash
} from "./stairs.js";
let runtimeControls = {
  start: null,
  stop: null,
  reset: null
};

export function startSimulation() {
  return runtimeControls.start ? runtimeControls.start() : false;
}

export function stopSimulation() {
  return runtimeControls.stop ? runtimeControls.stop() : false;
}

export function resetSimulation() {
  return runtimeControls.reset ? runtimeControls.reset() : false;
}

export function initSimulation() {
  const ui = getUIRefs();
  state.ui.refs = ui;

  // ==== Basic Setup ====
  const cvs = ui.simCanvas;
  const ctx = cvs.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    syncPublicState();
    drawScene();
  }
  window.addEventListener("resize", resizeCanvas);

  // ==== UI References ====
  const mapFileInput = ui.mapFileInput;
  const thrRange = ui.thrRange;
  const numAgentsInput = ui.numAgentsInput;
  const speedInput = ui.speedInput;
  const speedVarInput = ui.speedVarInput;
  const cellSizeMetersInput = ui.cellSizeMetersInput;
  const startRuleInput = ui.startRuleInput;
  const floorCountInput = ui.floorCountInput;
  const currentFloorSelect = ui.currentFloorSelect;
  const btnApplyFloors = ui.btnApplyFloors;
  const fdsCsvFileInput = ui.fdsCsvFileInput;
  const btnClearFdsCsv = ui.btnClearFdsCsv;
  const fdsCsvStatus = ui.fdsCsvStatus;
  const fdsCsvStats = ui.fdsCsvStats;
  const riskViewModeInput = ui.riskViewModeInput;
  const smokeSourceRateInput = ui.smokeSourceRateInput;
  const smokeDiffusionRateInput = ui.smokeDiffusionRateInput;
  const smokeSpreadMixInput = ui.smokeSpreadMixInput;
  const smokeDiagonalMixInput = ui.smokeDiagonalMixInput;
  const smokeDecayRateInput = ui.smokeDecayRateInput;
  const stairTypeInput = ui.stairTypeInput;
  const stairTravelCostInput = ui.stairTravelCostInput;
  const stairSmokeTransferInput = ui.stairSmokeTransferInput;
  const stairCapacityInput = ui.stairCapacityInput;

  const btnStart = ui.btnStart;
  const btnStop = ui.btnStop;
  const btnReset = ui.btnReset;
  const btnClearMap = ui.btnClearMap;
  const btnMonte = ui.btnMonte;
  const btnAnalyze = ui.btnAnalyze;
  const btnOptimizeExit = ui.btnOptimizeExit;
  const btnAutoImprove = ui.btnAutoImprove;
  const btnSavePreset = ui.btnSavePreset;
  const btnLoadPreset = ui.btnLoadPreset;
  const btnExportCsv = ui.btnExportCsv;
  const btnParamHistory = ui.btnParamHistory;
  const optimizeReverseInput = ui.optimizeReverseInput;

  const logEl = ui.logEl;
  const statusBar = ui.statusBar;
  const floorLabel = ui.floorLabel;
  const presetNameInput = ui.presetNameInput;
  const presetSelect = ui.presetSelect;

  const vizTrailsInput = ui.vizTrailsInput;
  const vizFlowInput = ui.vizFlowInput;
  const vizPotentialInput = ui.vizPotentialInput;
  const potentialViewModeInput = ui.potentialViewModeInput;
  const potentialExitIndexInput = ui.potentialExitIndexInput;

  const agentPresetInput = ui.agentPresetInput;
  const ratioChildInput = ui.ratioChildInput;
  const ratioElderlyInput = ui.ratioElderlyInput;
  const ratioPanicInput = ui.ratioPanicInput;
  const ratioLeaderInput = ui.ratioLeaderInput;
  const ratioTeacherInput = ui.ratioTeacherInput;
  const ratioStudentInput = ui.ratioStudentInput;

  const modeButtons = {
    spawn: ui.modeButtons.spawn,
    exit: ui.modeButtons.exit,
    stair: ui.modeButtons.stair,
    stairLink: ui.modeButtons.stairLink,
    fire: ui.modeButtons.fire,
    erase: ui.modeButtons.erase
  };
  const modeLabelMap = {
    spawn: "開始位置",
    exit: "出口",
    stair: "階段",
    stairLink: "階段リンク",
    fire: "火元",
    erase: "消去"
  };

  const hudTime = ui.hudTime;
  const hudEvac = ui.hudEvac;
  const hudAvg = ui.hudAvg;
  const hudMax = ui.hudMax;

  // ==== Map / Grid ====
  let baseImage = null;
  let grid = null;        // {walkable:boolean, fire:boolean}
  let gridW = 0, gridH = 0;
  const CELL_SIZE_PX = 4; // Downscale factor: image pixels -> sim cells
  let baseWalkableTemplate = null;
  let floorStates = [];
  let floorCount = 1;
  let currentFloor = 0;
  const SINGLE_FLOOR_MODE = false;
  let stairLinks = [];      // [{a:{floor,cx,cy}, b:{floor,cx,cy}}]
  let stairLinkIndex = new Map(); // key -> [{floor,cx,cy}]
  let pendingStairLink = null;    // {floor,cx,cy}
  let allExitPoints = [];   // {floor,cx,cy}
  let allSpawnPoints = [];  // {floor,cx,cy}
  let multiPotentialByExit = []; // [exit][floor][y][x]
  let multiCombinedPotential = null; // [floor][y][x]
  let stairTrafficState = createStairTrafficState([]);
  let stairCongestion = [];
  let verticalSmokeTransfers = [];

  let exits = state.exits = [];         // {cx,cy}
  let spawns = state.spawns = [];        // {cx,cy,r}
  let mode = "spawn";

  // ==== Simulation State ====
  let agents = state.agents = [];        // {x,y,cx,cy,v,finished,startTime,finishTime}
  let simRunning = state.simRunning = false;
  let simTime = state.simTime = 0;
  let lastFrameTime = 0;
  let heatmap = null;     // Cell pass count

  let maxHeatCell = null;
  let maxHeatValue = 0;
  let potentialByExit = [];
  let combinedPotential = null;
  let flowField = null;
  let congestionHistory = [];
  let bottleneckReport = [];
  let paramHistory = [];
  let lastSummary = null;
  let potentialLegendMax = 1;
  let nextRouteReplanAt = 0;
  let nextCongestionSampleAt = 0;
  let nextFireStepAt = 0;
  let lastFireStepAt = 0;
  let activeFireCount = 0;
  let totalFireHrrKw = 0;
  const PRESET_STORAGE_KEY = "evac_presets_v1";

  let smokeMap = null; 
  let smokeCeil = null; 
  let importedFdsRisk = {
    active: false,
    name: null,
    rows: 0,
    frames: [],
    times: [],
    stats: null
  }; 
  const FAR_FIRST_MAX_DELAY_SEC = 8.0;
  const MAX_OCCUPANCY_PER_CELL = 2;
  const DENSITY_RADIUS = 1;
  const DENSITY_SPEED_COEF = 0.85;
  const POTENTIAL_GAIN_WEIGHT = 2.8;
  const CONGESTION_PENALTY_WEIGHT = 1.3;
  const HEATMAP_PENALTY_WEIGHT = 0.03;
  const SMOKE_AVOID_WEIGHT = 1.1;
  const FIRE_AVOID_WEIGHT = 2.5;
  const LETHAL_FIRE_CELL_BLOCK = true;
  const FIRE_HARD_AVOID_HEAT = 0.85;
  const FIRE_SOFT_AVOID_HEAT = 0.25;
  const SMOKE_HARD_AVOID_LEVEL = 2.25;
  const SMOKE_SOFT_AVOID_LEVEL = 0.75;
  const FIRE_BLOCK_SCORE = 1e6;
  const FIRE_NEAR_BLOCK_SCORE = 160;
  const HIGH_SMOKE_BLOCK_SCORE = 85;
  const SMOKE_ROUTE_WEIGHT = 7.5;
  const SMOKE_ROUTE_QUADRATIC_WEIGHT = 5.0;
  const FIRE_ROUTE_WEIGHT = 22.0;
  const FIRE_LETHAL_ROUTE_WEIGHT = 120.0;

  // Fire engineering layer:
  // - FDS/CFD CSV input is used when available.
  // - Browser t^2 fire is only a fallback risk field, not a CFD solver.
  const FDS_HEAT_FLUX_SOFT_KW_M2 = 2.5;
  const FDS_HEAT_FLUX_HARD_KW_M2 = 10.0;
  const FDS_CO_SOFT_PPM = 200;
  const FDS_CO_HARD_PPM = 1200;
  const FDS_OPTICAL_DENSITY_SOFT = 0.15;
  const FDS_OPTICAL_DENSITY_HARD = 1.0;
  const FDS_ROUTE_HEAT_WEIGHT = 13.0;
  const FDS_ROUTE_OD_WEIGHT = 18.0;
  const FDS_ROUTE_CO_WEIGHT = 0.035;
  const FDS_ROUTE_VISIBILITY_WEIGHT = 18.0;
  const CO_DOSE_FATAL_PPM_MIN = 30000;
  const HEAT_FLUX_DOSE_FATAL = 120;
  const T2_FIRE_ALPHA = 0.0469; // medium t-squared fire growth, kW/s^2
  const T2_FIRE_MAX_HRR_KW = 3000;
  const STAY_PENALTY = 0.2;
  const UPHILL_PENALTY_WEIGHT = 4.2;
  const BACKTRACK_PENALTY = 1.15;
  const HEADING_INERTIA_WEIGHT = 0.38;
  const TURNBACK_EXTRA_PENALTY = 0.9;
  const STUCK_BACKTRACK_RELEASE_SEC = 1.0;
  const STUCK_UPHILL_RELEASE_SEC = 1.6;
  const EXIT_SWITCH_MARGIN = 2.0;
  const MIN_SPEED_FACTOR = 0.12;
  const VISIBILITY_SMOKE_COEF = 0.33;
  const MIN_VISIBILITY = 0.1;
  const VISIBILITY_NOISE = 0.9;
  const LOW_VISIBILITY_THRESHOLD = 0.35;
  const SMOKE_DEATH_DOSE = 17.0;
  const HEAT_DEATH_DOSE = 10.0;
  const LETHAL_SMOKE_LEVEL = 2.7;
  const FIRE_LETHAL_RADIUS = 1.1;
  const FIRE_DANGER_RADIUS = 3.0;
  const BUOYANCY_PER_SEC = 0.55;
  const VENT_DECAY_BONUS = 0.08;
  const FALL_SMOKE_THRESHOLD = 0.9;
  const FALL_RATE_PER_SEC = 0.015;
  const HELPERS_NEEDED = 2;
  const RESCUE_DURATION_SEC = 6.0;

  let mcRunning = false;
  let mcRuns = 0;
  let mcTargetRuns = 100;
  let mcResults = [];
  const TYPE_META = {
    adult: { label: "Adult", speed: 1.0, fallRisk: 1.0, panic: 0.0, color: "#ff3366" },
    child: { label: "Child", speed: 0.74, fallRisk: 1.1, panic: 0.05, color: "#8ad8ff" },
    elderly: { label: "Elderly", speed: 0.62, fallRisk: 1.85, panic: 0.03, color: "#ffd26b" },
    panic: { label: "Panic", speed: 1.1, fallRisk: 1.35, panic: 0.3, color: "#ff66aa" },
    leader: { label: "Leader", speed: 1.02, fallRisk: 0.9, panic: 0.02, color: "#66ffcc" },
    teacher: { label: "Teacher", speed: 0.96, fallRisk: 0.92, panic: 0.01, color: "#66ccff" },
    student: { label: "Student", speed: 0.72, fallRisk: 1.2, panic: 0.04, color: "#7bb8ff" }
  };

  function syncPublicState() {
    if (Array.isArray(agents) && floorStates.length) {
      agents.forEach(agent => Object.assign(agent, normalizeAgent3D(agent, floorStates, {
        cellSizeMeters: parseNum(cellSizeMetersInput, state.spatial.cellSizeMeters || 0.5),
        floorHeightMeters: state.spatial.floorHeightMeters || 3.5
      })));
    }
    state.agents = agents;
    state.simRunning = simRunning;
    state.simTime = simTime;
    state.exits = exits;
    state.spawns = spawns;
    state.currentFloor = currentFloor;
    state.floors = floorStates;

    state.map.baseImage = baseImage;
    state.map.grid = grid;
    state.map.gridW = gridW;
    state.map.gridH = gridH;
    state.map.baseWalkableTemplate = baseWalkableTemplate;
    state.map.floorStates = floorStates;
    state.map.floorCount = floorCount;
    state.map.currentFloor = currentFloor;
    state.map.stairLinks = stairLinks;
    state.map.pendingStairLink = pendingStairLink;
    state.map.allExitPoints = allExitPoints;
    state.map.allSpawnPoints = allSpawnPoints;

    state.sim.running = simRunning;
    state.sim.time = simTime;
    state.sim.lastFrameTime = lastFrameTime;
    state.sim.heatmap = heatmap;
    state.sim.smokeMap = smokeMap;
    state.sim.smokeCeil = smokeCeil;
    state.sim.flowField = flowField;
    state.sim.potentialByExit = potentialByExit;
    state.sim.combinedPotential = combinedPotential;
    state.sim.potentialLegendMax = potentialLegendMax;
    state.sim.maxHeatCell = maxHeatCell;
    state.sim.maxHeatValue = maxHeatValue;
    state.sim.congestionHistory = congestionHistory;
    state.sim.bottleneckReport = bottleneckReport;
    state.sim.paramHistory = paramHistory;
    state.sim.lastSummary = lastSummary;
    state.sim.nextRouteReplanAt = nextRouteReplanAt;
    state.sim.nextCongestionSampleAt = nextCongestionSampleAt;
    state.sim.stairTraffic = stairTrafficState;
    state.sim.stairCongestion = stairCongestion;
    state.sim.verticalSmokeTransfers = verticalSmokeTransfers;
    state.sim.fireStats = { activeFireCount, totalHrrKw: totalFireHrrKw };
    state.spatial.cellSizeMeters = Math.max(0.05, parseNum(cellSizeMetersInput, state.spatial.cellSizeMeters || 0.5));
    state.hazards.fds = importedFdsRisk;
    state.render.revision = (state.render.revision || 0) + 1;

    const liveMetrics = summarizeAgentMetrics(agents);
    state.evaluation.floorOccupancy = liveMetrics.floorOccupancy;
    state.evaluation.stairCongestion = Object.fromEntries(
      stairCongestion.map(item => [item.id || item.stairId, item])
    );
    state.evaluation.stuckEvents = liveMetrics.stuckCount;
    state.evaluation.panicEscapeEvents = liveMetrics.panicEscapeCount;

    state.mc.running = mcRunning;
    state.mc.runs = mcRuns;
    state.mc.targetRuns = mcTargetRuns;
    state.mc.results = mcResults;

    state.viz.trails = !!vizTrailsInput.checked;
    state.viz.flow = !!vizFlowInput.checked;
    state.viz.potential = !!vizPotentialInput.checked;
    state.viz.potentialViewMode = potentialViewModeInput.value;
    state.viz.potentialExitIndex = Math.max(1, Math.floor(parseNum(potentialExitIndexInput, 1)));

    syncLegacyState();
  }

  function log(line) {
    const ts = new Date().toISOString().slice(11,19);
    logEl.value = `[${ts}] ${line}\n` + logEl.value;
  }

  function setStatus(text) {
    statusBar.textContent = text;
  }

  function setMode(m) {
    if (mode === "stairLink" && m !== "stairLink" && pendingStairLink) {
      pendingStairLink = null;
      setStatus("Stair link selection cancelled.");
    }
    mode = m;
    Object.entries(modeButtons).forEach(([k,btn]) => {
      if (!btn) return;
      btn.classList.toggle("modeActive", k === m);
    });
    setStatus(`モード: ${modeLabelMap[m] || m}`);
  }

  function syncPotentialExitIndexControl() {
    const max = Math.max(1, allExitPoints.length || exits.length || 1);
    potentialExitIndexInput.max = String(max);
    const cur = Math.max(1, Math.floor(parseNum(potentialExitIndexInput, 1)));
    potentialExitIndexInput.value = String(Math.min(cur, max));
  }

  function cloneWalkableTemplate(template) {
    if (!Array.isArray(template)) return null;
    return template.map(row => Array.isArray(row) ? row.map(v => !!v) : []);
  }

  function isStairEndpointUsable(ep) {
    if (!ep) return false;
    const f = Math.floor(ep.floor);
    const cx = Math.floor(ep.cx);
    const cy = Math.floor(ep.cy);
    if (f < 0 || f >= floorStates.length) return false;
    if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return false;
    const cell = floorStates[f]?.grid?.[cy]?.[cx];
    return !!(cell && cell.walkable && !cell.fire && cell.stair);
  }

  function rebuildStairLinkIndex() {
    stairLinkIndex = new Map();
    stairLinks.forEach(link => {
      const a = link?.a;
      const b = link?.b;
      if (!a || !b) return;
      const ka = stairEndpointKey(a.floor, a.cx, a.cy);
      const kb = stairEndpointKey(b.floor, b.cx, b.cy);
      if (!stairLinkIndex.has(ka)) stairLinkIndex.set(ka, []);
      if (!stairLinkIndex.has(kb)) stairLinkIndex.set(kb, []);
      const metadata = {
        linkId: link.id,
        type: link.type || "indoor",
        widthMeters: link.widthMeters || 1.5,
        travelCostSec: link.travelCostSec || 8,
        verticalSmokeTransfer: link.verticalSmokeTransfer ?? 0.35,
        congestionCapacity: link.congestionCapacity || 2
      };
      stairLinkIndex.get(ka).push({ floor: b.floor, floorIndex: b.floor, cx: b.cx, cy: b.cy, ...metadata });
      stairLinkIndex.get(kb).push({ floor: a.floor, floorIndex: a.floor, cx: a.cx, cy: a.cy, ...metadata });
    });
  }

  function sanitizeStairLinks() {
    const seen = new Set();
    const next = [];
    for (let i = 0; i < stairLinks.length; i++) {
      const link = stairLinks[i];
      const a = link?.a;
      const b = link?.b;
      if (!a || !b) continue;
      if (a.floor === b.floor && a.cx === b.cx && a.cy === b.cy) continue;
      if (!isStairEndpointUsable(a) || !isStairEndpointUsable(b)) continue;
      const h = stairLinkHash(a, b);
      if (seen.has(h)) continue;
      seen.add(h);
      const [na, nb] = normalizeStairLinkEndpoints(a, b);
      const type = ["indoor", "outdoor", "emergency"].includes(link.type) ? link.type : "indoor";
      next.push({
        ...link,
        id: link.id || `stair-${type}-${stairLinkHash(na, nb).replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
        type,
        a: na,
        b: nb,
        from: { floorIndex: na.floor, cx: na.cx, cy: na.cy },
        to: { floorIndex: nb.floor, cx: nb.cx, cy: nb.cy },
        widthMeters: Math.max(0.5, Number(link.widthMeters) || 1.5),
        travelCostSec: Math.max(0.5, Number(link.travelCostSec) || 8),
        verticalSmokeTransfer: clamp(Number(link.verticalSmokeTransfer ?? 0.35), 0, 1),
        congestionCapacity: Math.max(1, Math.floor(Number(link.congestionCapacity) || 2))
      });
    }
    stairLinks = next;
    rebuildStairLinkIndex();
    stairTrafficState = createStairTrafficState(stairLinks, simTime);
    stairCongestion = getStairCongestion(stairTrafficState, stairLinks);
  }

  function removeStairLinksByCell(floor, cx, cy) {
    stairLinks = stairLinks.filter(link => {
      const a = link?.a;
      const b = link?.b;
      if (!a || !b) return false;
      const matchA = a.floor === floor && a.cx === cx && a.cy === cy;
      const matchB = b.floor === floor && b.cx === cx && b.cy === cy;
      return !(matchA || matchB);
    });
    if (pendingStairLink && pendingStairLink.floor === floor && pendingStairLink.cx === cx && pendingStairLink.cy === cy) {
      pendingStairLink = null;
    }
    rebuildStairLinkIndex();
  }

  function removeStairLinksByFloor(floor) {
    stairLinks = stairLinks.filter(link => {
      const a = link?.a;
      const b = link?.b;
      if (!a || !b) return false;
      return a.floor !== floor && b.floor !== floor;
    });
    if (pendingStairLink && pendingStairLink.floor === floor) {
      pendingStairLink = null;
    }
    rebuildStairLinkIndex();
  }

  function getLinkedStairDestinations(floor, cx, cy) {
    const key = stairEndpointKey(floor, cx, cy);
    return stairLinkIndex.get(key) || [];
  }

  function addStairLink(a, b) {
    const aa = { floor: Math.floor(a.floor), cx: Math.floor(a.cx), cy: Math.floor(a.cy) };
    const bb = { floor: Math.floor(b.floor), cx: Math.floor(b.cx), cy: Math.floor(b.cy) };
    if (aa.floor === bb.floor && aa.cx === bb.cx && aa.cy === bb.cy) {
      setStatus("同じセル同士はリンクできません。");
      return false;
    }
    if (aa.floor === bb.floor) {
      setStatus("階段リンクは別フロア間で設定してください。");
      return false;
    }
    if (!isStairEndpointUsable(aa) || !isStairEndpointUsable(bb)) {
      setStatus("有効な階段セルを選択してください。");
      return false;
    }
    const h = stairLinkHash(aa, bb);
    const dup = stairLinks.some(link => stairLinkHash(link.a, link.b) === h);
    if (dup) {
      setStatus("同じ階段リンクは既に存在します。");
      return false;
    }
    const [na, nb] = normalizeStairLinkEndpoints(aa, bb);
    const type = ["indoor", "outdoor", "emergency"].includes(stairTypeInput?.value)
      ? stairTypeInput.value
      : "indoor";
    const hash = stairLinkHash(na, nb);
    stairLinks.push({
      id: `stair-${type}-${hash.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
      type,
      a: na,
      b: nb,
      from: { floorIndex: na.floor, cx: na.cx, cy: na.cy },
      to: { floorIndex: nb.floor, cx: nb.cx, cy: nb.cy },
      widthMeters: 1.5,
      travelCostSec: Math.max(0.5, parseNum(stairTravelCostInput, 8)),
      verticalSmokeTransfer: clamp(parseNum(stairSmokeTransferInput, type === "outdoor" ? 0.1 : 0.35), 0, 1),
      congestionCapacity: Math.max(1, Math.floor(parseNum(stairCapacityInput, 2)))
    });
    rebuildStairLinkIndex();
    return true;
  }

  function makeScalarGrid(fillValue) {
    return new Array(gridH).fill(null).map(() => new Array(gridW).fill(fillValue));
  }

  function makeFlowGrid() {
    return new Array(gridH).fill(null).map(() =>
      new Array(gridW).fill(null).map(() => ({ vx: 0, vy: 0, n: 0 }))
    );
  }

  function cloneGridFromTemplate(template, stairTemplate = null) {
    const out = new Array(gridH);
    for (let y = 0; y < gridH; y++) {
      out[y] = new Array(gridW);
      for (let x = 0; x < gridW; x++) {
        const walkable = !!template?.[y]?.[x];
        const stair = !!stairTemplate?.[y]?.[x];
        out[y][x] = {
          walkable: walkable || stair,
          wall: !(walkable || stair),
          door: false,
          fire: false,
          fireIntensity: 0,
          fireAgeSec: 0,
          temperatureC: 20,
          heatFluxKwM2: 0,
          stair,
          stairType: stair ? "indoor" : null,
          smokeDensity: 0,
          opticalDensity: 0,
          coPpm: 0,
          visibilityMeters: 30,
          smoke: 0,
          heat: 0,
          co: 0,
          visibility: 1
        };
      }
    }
    return out;
  }

  function collectStairCells(floorGrid) {
    const cells = [];
    if (!Array.isArray(floorGrid)) return cells;
    for (let cy = 0; cy < floorGrid.length; cy++) {
      const row = floorGrid[cy];
      if (!Array.isArray(row)) continue;
      for (let cx = 0; cx < row.length; cx++) {
        const cell = row[cx];
        if (cell?.stair) cells.push({ cx, cy, type: cell.stairType || "indoor" });
      }
    }
    return cells;
  }

  function createFloorState(seedTemplate = null, seedImage = null, floorIndex = 0, options = {}) {
    const tpl = cloneWalkableTemplate(seedTemplate);
    const stairTemplate = cloneWalkableTemplate(options.stairTemplate);
    const floorGrid = cloneGridFromTemplate(tpl, stairTemplate);
    const cellSizeMeters = Math.max(0.05, parseNum(cellSizeMetersInput, state.spatial.cellSizeMeters || 0.5));
    const floorHeightMeters = Math.max(1, Number(options.floorHeightMeters) || state.spatial.floorHeightMeters || 3.5);
    return {
      floorIndex,
      name: options.name || `${floorIndex + 1}F`,
      zMeters: floorIndex * floorHeightMeters,
      elevationMeters: floorIndex * floorHeightMeters,
      floorHeightMeters,
      wallHeightMeters: Number(options.wallHeightMeters) || state.spatial.wallHeightMeters || 2.8,
      cellSizeMeters,
      gridWidth: gridW,
      gridHeight: gridH,
      mapProfile: options.mapProfile || null,
      baseImage: seedImage || null,
      walkableTemplate: tpl,
      stairTemplate,
      grid: floorGrid,
      exits: [],
      spawns: [],
      stairs: collectStairCells(floorGrid),
      heatmap: makeScalarGrid(0),
      smokeMap: makeScalarGrid(0),
      smokeCeil: makeScalarGrid(false),
      flowField: makeFlowGrid(),
      potentialByExit: [],
      combinedPotential: null,
      potentialLegendMax: 1
    };
  }

  function syncActiveFloorState() {
    if (!floorStates[currentFloor]) return;
    const active = floorStates[currentFloor];
    active.floorIndex = currentFloor;
    active.name = active.name || `${currentFloor + 1}F`;
    active.floorHeightMeters = active.floorHeightMeters || state.spatial.floorHeightMeters || 3.5;
    active.zMeters = currentFloor * active.floorHeightMeters;
    active.elevationMeters = active.zMeters;
    active.wallHeightMeters = active.wallHeightMeters || state.spatial.wallHeightMeters || 2.8;
    active.cellSizeMeters = Math.max(0.05, parseNum(cellSizeMetersInput, active.cellSizeMeters || 0.5));
    active.gridWidth = gridW;
    active.gridHeight = gridH;
    active.baseImage = baseImage;
    // The template is immutable between map edits; keep a stable reference so
    // the 3D geometry cache is not rebuilt on every simulation frame.
    active.walkableTemplate = baseWalkableTemplate;
    active.grid = grid;
    active.exits = exits;
    active.spawns = spawns;
    active.stairs = collectStairCells(grid);
    active.heatmap = heatmap;
    active.smokeMap = smokeMap;
    active.smokeCeil = smokeCeil;
    active.flowField = flowField;
    active.potentialByExit = potentialByExit;
    active.combinedPotential = combinedPotential;
    active.potentialLegendMax = potentialLegendMax;
  }

  function loadFloorState(floorIndex, redraw = true) {
    const fs = floorStates[floorIndex];
    if (!fs) return;
    currentFloor = floorIndex;
    baseImage = fs.baseImage || null;
    baseWalkableTemplate = cloneWalkableTemplate(fs.walkableTemplate);
    grid = fs.grid;
    exits = fs.exits;
    spawns = fs.spawns;
    heatmap = fs.heatmap;
    smokeMap = fs.smokeMap;
    smokeCeil = fs.smokeCeil;
    flowField = fs.flowField;
    potentialByExit = fs.potentialByExit || [];
    combinedPotential = fs.combinedPotential || null;
    potentialLegendMax = fs.potentialLegendMax || 1;
    if (cellSizeMetersInput && Number.isFinite(fs.cellSizeMeters)) {
      cellSizeMetersInput.value = String(fs.cellSizeMeters);
    }
    syncPotentialExitIndexControl();
    updateFloorLabel();
    if (redraw) {
      syncPublicState();
      drawScene();
    }
  }

  function refreshFloorSelector() {
    currentFloorSelect.innerHTML = "";
    for (let i = 0; i < floorCount; i++) {
      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = `${i + 1}F`;
      currentFloorSelect.appendChild(op);
    }
    currentFloorSelect.value = String(currentFloor);
  }

  function updateFloorLabel() {
    const floorText = `${currentFloor + 1}F / ${floorCount}F`;
    floorLabel.textContent = `表示フロア: ${floorText}${baseImage ? "" : " (マップ未設定)"}`;
  }

  function collectAllExits() {
    const arr = [];
    for (let f = 0; f < floorStates.length; f++) {
      const fs = floorStates[f];
      if (!fs) continue;
      fs.exits.forEach(e => arr.push({ floor: f, cx: e.cx, cy: e.cy }));
    }
    return arr;
  }

  function collectAllSpawns() {
    const arr = [];
    for (let f = 0; f < floorStates.length; f++) {
      const fs = floorStates[f];
      if (!fs) continue;
      fs.spawns.forEach(s => arr.push({ floor: f, cx: s.cx, cy: s.cy, r: s.r || 0 }));
    }
    return arr;
  }

  function isAgentTraversableCell(floor, cx, cy) {
    if (floor < 0 || floor >= floorStates.length) return false;
    if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return false;
    const cell = floorStates[floor]?.grid?.[cy]?.[cx];
    return !!(cell && cell.walkable && !cell.fire);
  }

  function applyFloorSetup(preserve = true) {
    const requested = SINGLE_FLOOR_MODE ? 1 : clamp(Math.floor(parseNum(floorCountInput, 1)), 1, 8);
    if (floorCountInput) floorCountInput.value = String(requested);
    const prevStates = floorStates;
    const prevCount = floorCount;
    floorCount = requested;
    const next = [];
    for (let i = 0; i < floorCount; i++) {
      if (preserve && i < prevCount && prevStates[i]) {
        const existing = prevStates[i];
        existing.floorIndex = i;
        existing.name = existing.name || `${i + 1}F`;
        existing.floorHeightMeters = existing.floorHeightMeters || state.spatial.floorHeightMeters || 3.5;
        existing.zMeters = i * existing.floorHeightMeters;
        existing.elevationMeters = existing.zMeters;
        next.push(existing);
      } else {
        next.push(createFloorState(null, null, i));
      }
    }
    floorStates = next;
    currentFloor = clamp(currentFloor, 0, floorCount - 1);
    stairLinks = stairLinks.filter(link =>
      link?.a?.floor >= 0 && link?.a?.floor < floorCount &&
      link?.b?.floor >= 0 && link?.b?.floor < floorCount
    );
    if (pendingStairLink && (pendingStairLink.floor < 0 || pendingStairLink.floor >= floorCount)) {
      pendingStairLink = null;
    }
    sanitizeStairLinks();
    refreshFloorSelector();
    loadFloorState(currentFloor, false);
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    if (allExitPoints.length) rebuildPotentialCache();
    state.render.geometryRevision = (state.render.geometryRevision || 0) + 1;
    syncPublicState();
    drawScene();
  }

  function applyAgentPreset(kind) {
    const preset = kind || "default";
    const presetMap = {
      default: { child: 15, elderly: 10, panic: 10, leader: 8, teacher: 7, student: 20 },
      teacher_student: { child: 0, elderly: 5, panic: 5, leader: 8, teacher: 20, student: 50 },
      mixed: { child: 15, elderly: 15, panic: 15, leader: 12, teacher: 8, student: 15 },
      custom: null
    };
    const cfg = presetMap[preset];
    const custom = preset === "custom";
    [
      ratioChildInput, ratioElderlyInput, ratioPanicInput,
      ratioLeaderInput, ratioTeacherInput, ratioStudentInput
    ].forEach(el => {
      el.disabled = !custom;
    });
    if (!cfg) return;
    ratioChildInput.value = cfg.child;
    ratioElderlyInput.value = cfg.elderly;
    ratioPanicInput.value = cfg.panic;
    ratioLeaderInput.value = cfg.leader;
    ratioTeacherInput.value = cfg.teacher;
    ratioStudentInput.value = cfg.student;
  }

  function getTypeRatios() {
    const raw = {
      child: clamp(parseNum(ratioChildInput), 0, 100),
      elderly: clamp(parseNum(ratioElderlyInput), 0, 100),
      panic: clamp(parseNum(ratioPanicInput), 0, 100),
      leader: clamp(parseNum(ratioLeaderInput), 0, 100),
      teacher: clamp(parseNum(ratioTeacherInput), 0, 100),
      student: clamp(parseNum(ratioStudentInput), 0, 100)
    };
    const sum = Object.values(raw).reduce((a, b) => a + b, 0);
    const scale = sum > 100 ? 100 / sum : 1;
    const ratios = {};
    Object.entries(raw).forEach(([k, v]) => {
      ratios[k] = v * scale;
    });
    const nonAdult = Object.values(ratios).reduce((a, b) => a + b, 0);
    ratios.adult = Math.max(0, 100 - nonAdult);
    return ratios;
  }

  function weightedPick(typeRatios) {
    const keys = Object.keys(typeRatios);
    const total = keys.reduce((s, k) => s + typeRatios[k], 0);
    if (total <= 0) return "adult";
    let r = Math.random() * total;
    for (const k of keys) {
      r -= typeRatios[k];
      if (r <= 0) return k;
    }
    return "adult";
  }

  function currentSettingsSnapshot() {
    return {
      floorCount,
      currentFloor,
      numAgents: parseNum(numAgentsInput, 80),
      speed: parseNum(speedInput, 1.2),
      speedVar: parseNum(speedVarInput, 25),
      cellSizeMeters: parseNum(cellSizeMetersInput, 0.5),
      startRule: startRuleInput.value,
      thr: parseNum(thrRange, 200),
      agentPreset: agentPresetInput.value,
      ratios: getTypeRatios(),
      viz: {
        trails: !!vizTrailsInput.checked,
        flow: !!vizFlowInput.checked,
        potential: !!vizPotentialInput.checked,
        mode: potentialViewModeInput.value,
        exitIndex: parseNum(potentialExitIndexInput, 1)
      },
      optimizeReverse: !!optimizeReverseInput.checked
    };
  }

  function restoreSettingsSnapshot(snap) {
    if (!snap) return;
    if (Number.isFinite(snap.numAgents)) numAgentsInput.value = snap.numAgents;
    if (Number.isFinite(snap.speed)) speedInput.value = snap.speed;
    if (Number.isFinite(snap.speedVar)) speedVarInput.value = snap.speedVar;
    if (Number.isFinite(snap.cellSizeMeters)) cellSizeMetersInput.value = snap.cellSizeMeters;
    if (Number.isFinite(snap.floorCount)) {
      floorCountInput.value = SINGLE_FLOOR_MODE ? 1 : clamp(Math.floor(snap.floorCount), 1, 8);
      if (gridW > 0 && gridH > 0 && floorStates.length) {
        syncActiveFloorState();
        applyFloorSetup(true);
      } else {
        floorCount = SINGLE_FLOOR_MODE ? 1 : clamp(Math.floor(snap.floorCount), 1, 8);
        refreshFloorSelector();
      }
    }
    if (Number.isFinite(snap.thr)) thrRange.value = snap.thr;
    if (snap.startRule) startRuleInput.value = snap.startRule;
    if (snap.agentPreset) {
      agentPresetInput.value = snap.agentPreset;
      applyAgentPreset(snap.agentPreset);
    }
    if (snap.ratios) {
      ratioChildInput.value = Math.round(snap.ratios.child ?? 0);
      ratioElderlyInput.value = Math.round(snap.ratios.elderly ?? 0);
      ratioPanicInput.value = Math.round(snap.ratios.panic ?? 0);
      ratioLeaderInput.value = Math.round(snap.ratios.leader ?? 0);
      ratioTeacherInput.value = Math.round(snap.ratios.teacher ?? 0);
      ratioStudentInput.value = Math.round(snap.ratios.student ?? 0);
    }
    if (snap.viz) {
      vizTrailsInput.checked = !!snap.viz.trails;
      vizFlowInput.checked = !!snap.viz.flow;
      vizPotentialInput.checked = !!snap.viz.potential;
      if (snap.viz.mode) potentialViewModeInput.value = snap.viz.mode;
      if (Number.isFinite(snap.viz.exitIndex)) potentialExitIndexInput.value = snap.viz.exitIndex;
    }
    if (Number.isFinite(snap.currentFloor) && floorStates.length) {
      const toFloor = clamp(Math.floor(snap.currentFloor), 0, floorCount - 1);
      loadFloorState(toFloor, false);
      currentFloorSelect.value = String(toFloor);
    }
    optimizeReverseInput.checked = !!snap.optimizeReverse;
  }


  function refreshPresetOptions() {
    const store = loadPresetStore(PRESET_STORAGE_KEY);
    const names = Object.keys(store).sort();
    presetSelect.innerHTML = "";
    if (names.length === 0) {
      const op = document.createElement("option");
      op.value = "";
      op.textContent = "保存済みプリセットなし";
      presetSelect.appendChild(op);
      return;
    }
    names.forEach(name => {
      const op = document.createElement("option");
      op.value = name;
      op.textContent = name;
      presetSelect.appendChild(op);
    });
  }

  function saveCurrentPreset() {
    const name = (presetNameInput.value || "").trim();
    if (!name) {
      alert("プリセット名を入力してください。");
      return;
    }
    const store = loadPresetStore(PRESET_STORAGE_KEY);
    store[name] = currentSettingsSnapshot();
    savePresetStore(PRESET_STORAGE_KEY, store);
    refreshPresetOptions();
    presetSelect.value = name;
    log(`プリセット保存: ${name}`);
  }

  function loadSelectedPreset() {
    const name = presetSelect.value;
    if (!name) return;
    const store = loadPresetStore(PRESET_STORAGE_KEY);
    const snap = store[name];
    if (!snap) {
      alert("選択したプリセットが見つかりません。");
      return;
    }
    restoreSettingsSnapshot(snap);
    if (baseImage) {
      const ok = applyImageToFloorMap(baseImage, currentFloor, {
        initializeAllFloors: false,
        clearMarkers: true
      });
      if (ok) resetSimulationCore(true);
    }
    log(`プリセット読込: ${name}`);
  }

  function pushParamHistory() {
    return pushParamHistoryEntry(paramHistory, currentSettingsSnapshot(), 120);
  }

  function showParamHistory() {
    return showParamHistoryLog(paramHistory, {
      floorCount,
      log,
      maxItems: 8
    });
  }

  function downloadCsv() {
    return downloadCsvReport({
      lastSummary,
      congestionHistory,
      bottleneckReport,
      currentFloor,
      agents,
      allExitPoints,
      TYPE_META,
      paramHistory,
      log
    });
  }

  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (ch === "," && !quoted) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function normalizeCsvKey(key) {
    return String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[\s\-]+/g, "_")
      .replace(/[()\[\]/]/g, "");
  }

  function csvNumber(row, names, fallback = 0) {
    for (const name of names) {
      const v = row[name];
      if (v == null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  }

  function parseFdsRiskCsv(text, fileName = "fds.csv") {
    const rawLines = String(text || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    if (rawLines.length < 2) throw new Error("CSVにヘッダーとデータ行が必要です。");

    const headers = splitCsvLine(rawLines[0]).map(normalizeCsvKey);
    const frames = new Map();
    let rows = 0;

    for (let i = 1; i < rawLines.length; i++) {
      const cols = splitCsvLine(rawLines[i]);
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = cols[idx] ?? "";
      });

      const time = csvNumber(row, ["time_s", "time", "t", "sec", "seconds"], 0);
      const rawFloor = csvNumber(row, ["floor", "floor_index", "f"], 1);
      const floor = Math.max(0, Math.floor(rawFloor) - 1);
      const cx = Math.floor(csvNumber(row, ["cx", "cell_x", "grid_x", "x"], NaN));
      const cy = Math.floor(csvNumber(row, ["cy", "cell_y", "grid_y", "y"], NaN));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

      const record = {
        floor,
        cx,
        cy,
        heatFluxKwM2: csvNumber(row, ["heat_flux_kw_m2", "heat_flux", "q_rad", "q_total", "flux_kw_m2"], 0),
        opticalDensityM1: csvNumber(row, ["optical_density_m_1", "optical_density", "od", "extinction_coefficient", "k_m_1"], 0),
        coPpm: csvNumber(row, ["co_ppm", "carbon_monoxide_ppm", "co"], 0),
        visibilityM: csvNumber(row, ["visibility_m", "visibility", "vis_m"], NaN),
        temperatureC: csvNumber(row, ["temperature_c", "temp_c", "temperature"], NaN)
      };

      if (!frames.has(time)) frames.set(time, new Map());
      frames.get(time).set(`${floor}:${cx}:${cy}`, record);
      rows++;
    }

    const times = [...frames.keys()].sort((a, b) => a - b);
    if (!times.length || rows === 0) throw new Error("有効なFDS行がありません。");

    const parsed = {
      active: true,
      name: fileName,
      rows,
      times,
      frames: times.map(time => ({ time, cells: frames.get(time) }))
    };
    parsed.stats = summarizeFdsRiskCsv(parsed);
    return parsed;
  }

  function summarizeFdsRiskCsv(risk) {
    const stats = {
      rows: risk?.rows || 0,
      timeCount: risk?.times?.length || 0,
      maxHeatFluxKwM2: 0,
      maxOpticalDensityM1: 0,
      maxCoPpm: 0,
      minVisibilityM: Infinity,
      maxTemperatureC: -Infinity
    };
    if (!risk?.frames?.length) return stats;
    risk.frames.forEach(frame => {
      frame.cells.forEach(rec => {
        stats.maxHeatFluxKwM2 = Math.max(stats.maxHeatFluxKwM2, rec.heatFluxKwM2 || 0);
        stats.maxOpticalDensityM1 = Math.max(stats.maxOpticalDensityM1, rec.opticalDensityM1 || 0);
        stats.maxCoPpm = Math.max(stats.maxCoPpm, rec.coPpm || 0);
        if (Number.isFinite(rec.visibilityM)) stats.minVisibilityM = Math.min(stats.minVisibilityM, rec.visibilityM);
        if (Number.isFinite(rec.temperatureC)) stats.maxTemperatureC = Math.max(stats.maxTemperatureC, rec.temperatureC);
      });
    });
    if (!Number.isFinite(stats.minVisibilityM)) stats.minVisibilityM = null;
    if (!Number.isFinite(stats.maxTemperatureC)) stats.maxTemperatureC = null;
    return stats;
  }

  function formatFdsStats(stats) {
    if (!stats) return "FDS統計: 未読込";
    const vis = stats.minVisibilityM == null ? "--" : `${stats.minVisibilityM.toFixed(1)}m`;
    const temp = stats.maxTemperatureC == null ? "--" : `${stats.maxTemperatureC.toFixed(1)}℃`;
    return (
      `FDS統計: rows=${stats.rows}, times=${stats.timeCount}, ` +
      `max HeatFlux=${stats.maxHeatFluxKwM2.toFixed(1)}kW/m², ` +
      `max OD=${stats.maxOpticalDensityM1.toFixed(2)}1/m, ` +
      `max CO=${stats.maxCoPpm.toFixed(0)}ppm, ` +
      `min Visibility=${vis}, max Temp=${temp}`
    );
  }

  function getNearestFdsFrame(time) {
    if (!importedFdsRisk.active || !importedFdsRisk.frames.length) return null;
    let best = importedFdsRisk.frames[0];
    let bestDt = Math.abs((best.time || 0) - time);
    for (let i = 1; i < importedFdsRisk.frames.length; i++) {
      const frame = importedFdsRisk.frames[i];
      const dt = Math.abs((frame.time || 0) - time);
      if (dt < bestDt) {
        best = frame;
        bestDt = dt;
      }
    }
    return best;
  }

  function getFdsRiskAt(floor, cx, cy, time = simTime) {
    const frame = getNearestFdsFrame(time);
    if (!frame) return null;
    return frame.cells.get(`${Math.max(0, floor)}:${cx}:${cy}`) || null;
  }

  function applyCurrentFdsToSharedHazards(time = simTime) {
    const frame = getNearestFdsFrame(time);
    if (!frame?.cells) return 0;
    let applied = 0;
    frame.cells.forEach(record => {
      const floor = floorStates[record.floor];
      const cell = floor?.grid?.[record.cy]?.[record.cx];
      if (!cell) return;
      const opticalDensity = Math.max(0, Number(record.opticalDensityM1) || 0);
      const smokeDensity = opticalDensity > 0 ? opticalDensity / 0.32 : (floor.smokeMap?.[record.cy]?.[record.cx] || 0);
      const coPpm = Math.max(0, Number(record.coPpm) || 0);
      const visibilityMeters = Number.isFinite(record.visibilityM)
        ? Math.max(0, record.visibilityM)
        : (opticalDensity > 0.001 ? Math.min(30, 3 / opticalDensity) : 30);
      if (floor.smokeMap?.[record.cy]) floor.smokeMap[record.cy][record.cx] = smokeDensity;
      Object.assign(cell, {
        smokeDensity,
        smoke: smokeDensity,
        opticalDensity,
        opticalDensityM1: opticalDensity,
        coPpm,
        co: coPpm,
        visibilityMeters,
        visibilityM: visibilityMeters,
        visibility: clamp(visibilityMeters / 30, 0, 1),
        heatFluxKwM2: Math.max(0, Number(record.heatFluxKwM2) || 0),
        heat: Math.max(0, Number(record.heatFluxKwM2) || 0),
        temperatureC: Number.isFinite(record.temperatureC) ? record.temperatureC : (cell.temperatureC || 20),
        hazardDataSource: "fds_csv"
      });
      applied++;
    });
    return applied;
  }

  function t2FireHrrKw(timeSec) {
    const t = Math.max(0, Number(timeSec) || 0);
    return Math.min(T2_FIRE_MAX_HRR_KW, T2_FIRE_ALPHA * t * t);
  }

  // ==== Map Loading and Grid Build ====

  mapFileInput.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    syncActiveFloorState();
    const targetFloor = clamp(
      Math.floor(parseNum(currentFloorSelect, currentFloor)),
      0,
      Math.max(0, floorCount - 1)
    );
    let mapProfile = /^scitech_3f_walkable\.png$/i.test(file.name)
      ? SCITECH_3F_PROFILE.id
      : null;
    try {
      const img = await loadImageFromFile(file);
      // Renaming the provided map must not disable its green stair extraction.
      // Dimensions narrow the check, while extracted green cells avoid treating
      // every unrelated 600x800 image as the bundled school-map profile.
      if (!mapProfile &&
          img.width === SCITECH_3F_PROFILE.sourceWidthPx &&
          img.height === SCITECH_3F_PROFILE.sourceHeightPx) {
        try {
          const detected = extractScitech3FGrid(img, {
            cellPixels: SCITECH_3F_PROFILE.gridCellPixels,
            whiteThreshold: parseInt(thrRange.value, 10)
          });
          if (isLikelyScitech3FExtraction(detected, img.width, img.height)) {
            mapProfile = SCITECH_3F_PROFILE.id;
          }
        } catch (_error) {
          // The regular threshold loader below remains available as fallback.
        }
      }
      // Show immediate preview even before grid extraction succeeds.
      baseImage = img;
      syncPublicState();
      drawScene();
      const ok = applyImageToFloorMap(img, targetFloor, {
        initializeAllFloors: false,
        clearMarkers: true,
        mapProfile
      });
      if (!ok) return;
      resetSimulationCore(true);
      log(`マップ読込: ${targetFloor + 1}F <- ${file.name} (${img.width}x${img.height}px)`);
      const stairCount = floorStates[targetFloor]?.stairs?.length || 0;
      setStatus(`マップを読み込みました: ${targetFloor + 1}F${stairCount ? ` / 階段候補 ${stairCount}セル` : ""}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      alert(`画像の読み込みに失敗しました: ${file.name}\n理由: ${reason}`);
    } finally {
      mapFileInput.value = "";
    }
  });

  fdsCsvFileInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      importedFdsRisk = parseFdsRiskCsv(text, file.name);
      const msg = `FDS CSV読込: ${file.name} / ${importedFdsRisk.rows}行 / ${importedFdsRisk.times.length}時刻`;
      if (fdsCsvStatus) fdsCsvStatus.textContent = msg;
      if (fdsCsvStats) fdsCsvStats.textContent = formatFdsStats(importedFdsRisk.stats);
      log(msg);
      log(formatFdsStats(importedFdsRisk.stats));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      alert(`FDS CSVの読込に失敗しました: ${reason}`);
    } finally {
      fdsCsvFileInput.value = "";
    }
  });

  btnClearFdsCsv?.addEventListener("click", () => {
    importedFdsRisk = { active: false, name: null, rows: 0, frames: [], times: [], stats: null };
    if (fdsCsvStatus) {
      fdsCsvStatus.textContent = "未読込。FDS/CFD値は使わず、簡易t²火災フォールバックを使います。";
    }
    if (fdsCsvStats) fdsCsvStats.textContent = "FDS統計: 未読込";
    log("FDS CSVを解除しました。");
  });

  function extractWalkableTemplateFromImage(image, options = {}) {
    if (!image) return null;
    if (options.mapProfile === SCITECH_3F_PROFILE.id) {
      try {
        const parsed = extractScitech3FGrid(image, {
          cellPixels: CELL_SIZE_PX,
          whiteThreshold: parseInt(thrRange.value, 10)
        });
        return {
          template: parsed.walkableTemplate,
          stairTemplate: parsed.stairTemplate,
          w: parsed.gridWidth,
          h: parsed.gridHeight,
          mapProfile: SCITECH_3F_PROFILE,
          extractionStats: parsed
        };
      } catch (err) {
        console.warn("3F map profile extraction failed; falling back to the legacy threshold.", err);
      }
    }
    // Draw image to an offscreen canvas and sample pixels
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");
    tmp.width = image.width;
    tmp.height = image.height;
    tctx.drawImage(image, 0, 0);
    let imgData;
    try {
      imgData = tctx.getImageData(0, 0, image.width, image.height).data;
    } catch (err) {
      alert("画像データを読み取れませんでした。別画像を試してください。");
      return null;
    }

    const w = Math.floor(image.width / CELL_SIZE_PX);
    const h = Math.floor(image.height / CELL_SIZE_PX);
    if (w <= 0 || h <= 0) {
      alert("画像サイズが小さすぎます。");
      return null;
    }
    const template = new Array(h);
    const thr = parseInt(thrRange.value, 10);
    for (let y = 0; y < h; y++) {
      template[y] = new Array(w);
      for (let x = 0; x < w; x++) {
        // Sample the center pixel of each cell
        const px = x * CELL_SIZE_PX + Math.floor(CELL_SIZE_PX / 2);
        const py = y * CELL_SIZE_PX + Math.floor(CELL_SIZE_PX / 2);
        const idx = (py * image.width + px) * 4;
        const r = imgData[idx], g = imgData[idx+1], b = imgData[idx+2];
        template[y][x] = (r > thr && g > thr && b > thr);
      }
    }
    return { template, stairTemplate: null, w, h, mapProfile: null };
  }

  function clearFloorMarkersAndFields(fs, template, stairTemplate = null) {
    fs.walkableTemplate = cloneWalkableTemplate(template);
    fs.stairTemplate = cloneWalkableTemplate(stairTemplate);
    fs.grid = cloneGridFromTemplate(fs.walkableTemplate, fs.stairTemplate);
    fs.exits = [];
    fs.spawns = [];
    fs.stairs = collectStairCells(fs.grid);
    fs.heatmap = makeScalarGrid(0);
    fs.smokeMap = makeScalarGrid(0);
    fs.smokeCeil = makeScalarGrid(false);
    fs.flowField = makeFlowGrid();
    fs.potentialByExit = [];
    fs.combinedPotential = null;
    fs.potentialLegendMax = 1;
  }

  function applyImageToFloorMap(image, floorIndex, options = {}) {
    const { clearMarkers = true, mapProfile = null } = options;
    if (!image) return false;
    const parsed = extractWalkableTemplateFromImage(image, { mapProfile });
    if (!parsed) return false;
    const { template, stairTemplate, w, h } = parsed;

    const hasLoadedFloor = floorStates.some(fs => !!fs?.baseImage);
    if (hasLoadedFloor && gridW > 0 && gridH > 0 && (w !== gridW || h !== gridH)) {
      alert("フロアごとの画像サイズが一致していません。");
      return false;
    }
    gridW = w;
    gridH = h;
    floorCount = clamp(Math.floor(parseNum(floorCountInput, floorCount || 1)), 1, 8);
    if (floorStates.length !== floorCount) applyFloorSetup(true);
    for (let index = 0; index < floorCount; index++) {
      const existing = floorStates[index];
      const dimensionsMatch = existing?.grid?.length === gridH &&
        (gridH === 0 || existing.grid[0]?.length === gridW);
      if (!dimensionsMatch && !existing?.baseImage) {
        floorStates[index] = createFloorState(null, null, index);
      }
    }

    const targetFloor = clamp(Math.floor(Number(floorIndex) || 0), 0, floorCount - 1);
    const fs = floorStates[targetFloor] || createFloorState(template, image, targetFloor);
    fs.floorIndex = targetFloor;
    fs.name = parsed.mapProfile && targetFloor === parsed.mapProfile.floorIndex
      ? parsed.mapProfile.floorName
      : `${targetFloor + 1}F`;
    fs.floorHeightMeters = parsed.mapProfile?.floorHeightMeters || fs.floorHeightMeters || 3.5;
    fs.zMeters = targetFloor * fs.floorHeightMeters;
    fs.elevationMeters = fs.zMeters;
    fs.wallHeightMeters = parsed.mapProfile?.wallHeightMeters || fs.wallHeightMeters || 2.8;
    fs.cellSizeMeters = parsed.mapProfile?.cellSizeMeters || parseNum(cellSizeMetersInput, 0.5);
    fs.gridWidth = gridW;
    fs.gridHeight = gridH;
    fs.mapProfile = parsed.mapProfile?.id || mapProfile || null;
    fs.baseImage = image;
    fs.walkableTemplate = cloneWalkableTemplate(template);
    if (clearMarkers || !fs.grid || !fs.grid.length) {
      clearFloorMarkersAndFields(fs, template, stairTemplate);
    }
    if (fs.mapProfile === SCITECH_3F_PROFILE.id) {
      for (let cy = 0; cy < fs.grid.length; cy++) {
        for (let cx = 0; cx < (fs.grid[cy]?.length || 0); cx++) {
          const cell = fs.grid[cy][cx];
          if (!cell?.stair) continue;
          // The lower-right green region is the labelled exterior stair.
          cell.stairType = (cx >= 124 && cy >= 154) ? "outdoor" : "indoor";
        }
      }
      fs.stairs = collectStairCells(fs.grid);
    }
    floorStates[targetFloor] = fs;
    if (clearMarkers) removeStairLinksByFloor(targetFloor);
    if (pendingStairLink?.floor === targetFloor) pendingStairLink = null;

    baseImage = image;
    baseWalkableTemplate = cloneWalkableTemplate(template);
    currentFloor = targetFloor;
    if (cellSizeMetersInput) cellSizeMetersInput.value = String(fs.cellSizeMeters);
    state.spatial.cellSizeMeters = fs.cellSizeMeters;
    state.spatial.floorHeightMeters = fs.floorHeightMeters;
    state.spatial.wallHeightMeters = fs.wallHeightMeters;
    state.spatial.activeMapProfile = fs.mapProfile;

    sanitizeStairLinks();
    refreshFloorSelector();
    loadFloorState(targetFloor, false);
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    rebuildPotentialCache();
    congestionHistory = [];
    bottleneckReport = [];
    lastSummary = null;
    state.render.geometryRevision = (state.render.geometryRevision || 0) + 1;
    syncPublicState();
    drawScene();
    setStatus("マップ解析が完了しました。");
    return true;
  }

  // ==== Coordinate Helpers ====
  function worldLayout() {
    if (!baseImage) {
      const rect = cvs.getBoundingClientRect();
      return { scale: 1, ox: 0, oy: 0, w: rect.width, h: rect.height };
    }
    const rect = cvs.getBoundingClientRect();
    const imgW = baseImage.width;
    const imgH = baseImage.height;
    const s = Math.min(rect.width / imgW, rect.height / imgH);
    const ox = (rect.width - imgW * s) / 2;
    const oy = (rect.height - imgH * s) / 2;
    return { scale: s, ox, oy, w: rect.width, h: rect.height };
  }

  function canvasToCell(clientX, clientY) {
    if (!baseImage || !grid) return null;
    const rect = cvs.getBoundingClientRect();
    const { scale, ox, oy } = worldLayout();
    const x = (clientX - rect.left - ox) / scale;
    const y = (clientY - rect.top - oy) / scale;
    const cx = Math.floor(x / CELL_SIZE_PX);
    const cy = Math.floor(y / CELL_SIZE_PX);
    if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) return null;
    return { cx, cy };
  }

  // ==== Click Handling by Mode ====
  cvs.addEventListener("pointerdown", e => {
    if (!grid) return;
    const cell = canvasToCell(e.clientX, e.clientY);
    if (!cell) return;
    const { cx, cy } = cell;
    const cellObj = grid[cy][cx];

    if (mode === "spawn") {
      if (!cellObj.walkable || cellObj.fire) {
        setStatus("開始位置は通行可能セルに配置してください。");
        return;
      }
      spawns.push({ cx, cy, r: 0 }); // r reserved for future use
      log(`開始位置を追加: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "exit") {
      if (!cellObj.walkable || cellObj.fire) {
        setStatus("出口は通行可能セルに配置してください。");
        return;
      }
      exits.push({ cx, cy });
      log(`出口を追加: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "stair") {
      if (cellObj.fire) {
        setStatus("火元セルは階段にできません。");
        return;
      }
      const toggled = !cellObj.stair;
      cellObj.stair = toggled;
      cellObj.walkable = true;
      cellObj.wall = false;
      cellObj.stairType = toggled ? (stairTypeInput?.value || "indoor") : null;
      if (!toggled) removeStairLinksByCell(currentFloor, cx, cy);
      log(`${toggled ? "階段を追加" : "階段を解除"}: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "stairLink") {
      if (!cellObj.stair || !cellObj.walkable || cellObj.fire) {
        setStatus("階段リンクは有効な階段セルを選択してください。");
        return;
      }
      const endpoint = { floor: currentFloor, cx, cy };
      if (!pendingStairLink) {
        pendingStairLink = endpoint;
        setStatus(`階段リンク開始点を選択: ${currentFloor + 1}F (${cx},${cy})`);
      } else {
        const same =
          pendingStairLink.floor === endpoint.floor &&
          pendingStairLink.cx === endpoint.cx &&
          pendingStairLink.cy === endpoint.cy;
        if (same) {
          pendingStairLink = null;
          setStatus("階段リンク選択を解除しました。");
        } else {
          const from = pendingStairLink;
          pendingStairLink = null;
          if (addStairLink(from, endpoint)) {
            log(
              `階段リンクを設定: ${from.floor + 1}F(${from.cx},${from.cy}) <-> ` +
              `${endpoint.floor + 1}F(${endpoint.cx},${endpoint.cy})`
            );
            setStatus("階段リンクを設定しました。");
          } else {
            setStatus("階段リンクを設定できませんでした。");
          }
        }
      }
    } else if (mode === "fire") {
      cellObj.fire = true;
      cellObj.fireIntensity = Math.max(0.05, Number(cellObj.fireIntensity) || 0);
      cellObj.fireAgeSec = 0;
      cellObj.temperatureC = Math.max(20, Number(cellObj.temperatureC) || 20);
      cellObj.heatFluxKwM2 = Math.max(0, Number(cellObj.heatFluxKwM2) || 0);
      cellObj.stair = false;
      cellObj.stairType = null;
      cellObj.walkable = false;
      cellObj.wall = false;
      removeStairLinksByCell(currentFloor, cx, cy);
      log(`火元を追加: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "erase") {
      // Remove spawn/exit/fire markers at this cell
      spawns = spawns.filter(p => !(p.cx === cx && p.cy === cy));
      exits = exits.filter(p => !(p.cx === cx && p.cy === cy));
      cellObj.fire = false;
      cellObj.fireIntensity = 0;
      cellObj.fireAgeSec = 0;
      cellObj.temperatureC = 20;
      cellObj.heatFluxKwM2 = 0;
      cellObj.heat = 0;
      cellObj.stair = false;
      cellObj.stairType = null;
      removeStairLinksByCell(currentFloor, cx, cy);
      // Keep as walkable until map is rebuilt
      cellObj.walkable = !!baseWalkableTemplate?.[cy]?.[cx];
      cellObj.wall = !cellObj.walkable;
      if (smokeMap) smokeMap[cy][cx] = 0;
      log(`セルを消去: ${currentFloor + 1}F (${cx},${cy})`);
    }

    sanitizeStairLinks();
    syncActiveFloorState();
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    if (allExitPoints.length > 0) rebuildPotentialCache();
    state.render.geometryRevision = (state.render.geometryRevision || 0) + 1;
    syncPublicState();
    drawScene();
  });

  // ==== Potential Field Calculation ====

  function rebuildPotentialCache() {
    allExitPoints = collectAllExits();
    if (!grid || !floorStates.length || allExitPoints.length === 0) {
      potentialByExit = [];
      combinedPotential = null;
      multiPotentialByExit = [];
      multiCombinedPotential = null;
      return false;
    }
    multiPotentialByExit = allExitPoints.map(ex =>
      computePotentialFieldFromSeedsModule(
        [{ floor: ex.floor, cx: ex.cx, cy: ex.cy }],
        { grid, floorStates, floorCount, gridW, gridH, currentFloor, isAgentTraversableCell, getLinkedStairDestinations }
      )
    );
    multiCombinedPotential = new Array(floorCount).fill(null).map(() =>
      new Array(gridH).fill(null).map(() => new Array(gridW).fill(Infinity))
    );
    for (let f = 0; f < floorCount; f++) {
      const fs = floorStates[f];
      fs.potentialLegendMax = 1;
      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          let best = Infinity;
          for (let i = 0; i < multiPotentialByExit.length; i++) {
            const p = multiPotentialByExit[i]?.[f]?.[y]?.[x];
            if (p < best) best = p;
          }
          multiCombinedPotential[f][y][x] = best;
          if (isFinite(best)) fs.potentialLegendMax = Math.max(fs.potentialLegendMax, best);
        }
      }
      fs.potentialByExit = multiPotentialByExit.map(p => p[f]);
      fs.combinedPotential = multiCombinedPotential[f];
    }
    loadFloorState(currentFloor, false);
    return true;
  }

  function estimateExitCost(exitIndex, floor, cx, cy, exitLoad) {
    const field = multiPotentialByExit[exitIndex];
    if (!field) return Infinity;
    const dist = field[floor]?.[cy]?.[cx];
    if (!isFinite(dist)) return Infinity;
    // TODO: combine static distance with dynamic congestion/load penalties.
    return dist;
  }

  function chooseExitForAgent(agent, exitLoad = []) {
    if (!multiPotentialByExit.length) return { idx: -1, field: null };
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < multiPotentialByExit.length; i++) {
      const score = estimateExitCost(i, agent.floor, agent.cx, agent.cy, exitLoad);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return {
      idx: bestIdx,
      field: bestIdx >= 0 ? multiPotentialByExit[bestIdx] : multiCombinedPotential,
      score: bestScore
    };
  }

  // ==== Agent Spawn ====
  function spawnAgents() {
    agents = [];
    if (!grid || !floorStates.length) {
      alert("マップが読み込まれていません。");
      return false;
    }
    syncActiveFloorState();
    allSpawnPoints = collectAllSpawns();
    allExitPoints = collectAllExits();
    if (allSpawnPoints.length === 0 || allExitPoints.length === 0) {
      alert("開始位置と出口を少なくとも1つずつ配置してください。");
      return false;
    }
    const n = Math.max(1, Math.floor(parseInt(numAgentsInput.value, 10) || 1));
    const baseSpeed = parseFloat(speedInput.value) || 1.0;
    const varPct = Math.max(0, Math.min(100, parseFloat(speedVarInput.value) || 0));
    const cellMeters = parseFloat(cellSizeMetersInput.value) || 0.5;
    const typeRatios = getTypeRatios();
    if (!rebuildPotentialCache()) {
      alert("経路ポテンシャルを計算できませんでした。");
      return false;
    }

    const walkableCells = [];
    for (let f = 0; f < floorCount; f++) {
      for (let y=0; y<gridH; y++) {
        for (let x=0; x<gridW; x++) {
          if (isAgentTraversableCell(f, x, y)) walkableCells.push({ floor: f, cx:x, cy:y });
        }
      }
    }
    if (walkableCells.length === 0) {
      alert("通行可能セルがありません。しきい値やマップを確認してください。");
      return false;
    }

    const exitLoad = new Array(allExitPoints.length).fill(0);
    for (let i=0; i<n; i++) {
      // Pick from spawn points, fallback to random walkable cell
      let chosen = null;
      for (let retry=0; retry<20 && !chosen; retry++) {
        const sp = allSpawnPoints[Math.floor(Math.random()*allSpawnPoints.length)];
        const {floor, cx,cy} = sp;
        if (isAgentTraversableCell(floor, cx, cy)) {
          chosen = { floor, cx, cy };
        }
      }
      if (!chosen) {
        chosen = walkableCells[Math.floor(Math.random()*walkableCells.length)];
      }

      // Speed variation
      const k = (Math.random()*2-1) * (varPct/100);
      const type = weightedPick(typeRatios);
      const meta = TYPE_META[type] || TYPE_META.adult;
      const speedMps = baseSpeed * (1 + k) * (meta.speed || 1); // m/s
      const speedCellsPerSec = speedMps / cellMeters;
      const seed = {
        id: i,
        floor: chosen.floor,
        floorIndex: chosen.floor,
        cx: chosen.cx,
        cy: chosen.cy
      };
      const exitChoice = chooseExitForAgent(seed, exitLoad);
      if (exitChoice.idx < 0 || !exitChoice.field) continue;
      const startPot = exitChoice.field?.[chosen.floor]?.[chosen.cy]?.[chosen.cx];
      if (!isFinite(startPot)) continue;
      exitLoad[exitChoice.idx] += 1;

      agents.push({
        id: i,
        floor: chosen.floor,
        cx: chosen.cx,
        cy: chosen.cy,
        x: chosen.cx,
        y: chosen.cy,
        v: speedCellsPerSec,
        finished: false,
        startTime: simTime,
        finishTime: null,
        dead: false,
        deathTime: null,
        deathCause: null,
        smokeDose: 0,
        heatDose: 0,
        coDosePpmMin: 0,
        coDose: 0,
        heatFluxDose: 0,
        visibility: 1,
        potential0: startPot,
        evacDelay: 0,
        fallen: false,
        rescue: null,
        helpingId: null,
        recoveredUntil: 0,
        type,
        behaviorState: "normal",
        panicFactor: meta.panic || 0,
        fallRiskMult: meta.fallRisk || 1,
        targetExitIndex: exitChoice.idx,
        targetExit: exitChoice.idx,
        targetStair: null,
        potentialField: exitChoice.field,
        prevCell: null,
        moveDir: null,
        stuckTime: 0,
        stuckCount: 0,
        stuckEventLatched: false,
        panicEscapeCount: 0,
        panicEscapeLatched: false,
        stairTransition: null,
        stairTransitionCount: 0,
        leaderId: null,
        trail: [{ floor: chosen.floor, x: chosen.cx, y: chosen.cy, t: 0 }],
        trailTick: 0
      });
    }
    if (!agents.length) {
      alert("エージェント生成に失敗しました。配置条件を確認してください。");
      return false;
    }

    const leaders = agents.filter(a => a.type === "leader" || a.type === "teacher");
    const students = agents.filter(a => a.type === "student" || a.type === "child");
    students.forEach(s => {
      let best = null;
      let bestDist = Infinity;
      leaders.forEach(l => {
        if (l.floor !== s.floor) return;
        const d = Math.hypot(l.x - s.x, l.y - s.y);
        if (d < bestDist) {
          bestDist = d;
          best = l;
        }
      });
      if (best) {
        s.leaderId = best.id;
      }
    });

    const startRule = startRuleInput?.value || "far_first";
    if (startRule === "far_first") {
      // Evacuation priority: farther agents start earlier (staggered departure).
      agents.sort((a, b) => (b.potential0 - a.potential0));
      const denom = Math.max(1, agents.length - 1);
      for (let i = 0; i < agents.length; i++) {
        agents[i].evacDelay = (i / denom) * FAR_FIRST_MAX_DELAY_SEC;
      }
    } else {
      // Everyone starts at the same time.
      for (let i = 0; i < agents.length; i++) {
        agents[i].evacDelay = 0;
      }
    }
    

    for (let f = 0; f < floorCount; f++) {
      floorStates[f].heatmap = makeScalarGrid(0);
      floorStates[f].smokeMap = makeScalarGrid(0);
      floorStates[f].smokeCeil = makeScalarGrid(false);
      floorStates[f].flowField = makeFlowGrid();
    }
    loadFloorState(currentFloor, false);
    congestionHistory = [];
    bottleneckReport = [];
    lastSummary = null;
    nextRouteReplanAt = 0;
    nextCongestionSampleAt = 0;
    stairTrafficState = createStairTrafficState(stairLinks, simTime);
    stairCongestion = getStairCongestion(stairTrafficState, stairLinks);
    verticalSmokeTransfers = [];
    nextFireStepAt = 0;
    lastFireStepAt = 0;
    activeFireCount = 0;
    totalFireHrrKw = 0;
    const startRuleLabel = (startRuleInput?.value === "far_first") ? "far_first" : "simultaneous";
    const typeCounts = agents.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {});
    const floorCounts = agents.reduce((acc, a) => {
      acc[a.floor] = (acc[a.floor] || 0) + 1;
      return acc;
    }, {});
    const typeSummary = Object.entries(typeCounts)
      .map(([k, v]) => `${TYPE_META[k]?.label || k}:${v}`)
      .join(", ");
    const floorSummary = Object.entries(floorCounts)
      .map(([f, v]) => `${Number(f) + 1}F:${v}`)
      .join(", ");
    log(
      `Spawned ${agents.length} agents, speed=${baseSpeed}m/s, variance=${varPct}%, ` +
      `start_rule=${startRuleLabel}, types=[${typeSummary}], floors=[${floorSummary}]`
    );
    return true;
  }

  // ==== Simulation Control ====
  function resetSimulationCore() {
    //simstop
    simRunning = false;
    syncPublicState();
    syncActiveFloorState();

    //timereset
    simTime = 0;
    lastFrameTime = 0;

    //agentsclear
    agents = [];
    congestionHistory = [];
    bottleneckReport = [];
    lastSummary = null;
    nextRouteReplanAt = 0;
    nextCongestionSampleAt = 0;
    stairTrafficState = createStairTrafficState(stairLinks, 0);
    stairCongestion = getStairCongestion(stairTrafficState, stairLinks);
    verticalSmokeTransfers = [];
    nextFireStepAt = 0;
    lastFireStepAt = 0;
    activeFireCount = 0;
    totalFireHrrKw = 0;

    //HUDreset
    hudTime.textContent = "0.0 s";
    hudEvac.textContent = "0 Evacuated / 0 Dead / 0";
    hudAvg.textContent = "--";
    hudMax.textContent = "--";

    //heatmapreset
    if (grid && floorStates.length) {
      for (let f = 0; f < floorCount; f++) {
        floorStates[f].heatmap = makeScalarGrid(0);
        floorStates[f].smokeMap = makeScalarGrid(0);
        floorStates[f].smokeCeil = makeScalarGrid(false);
        floorStates[f].flowField = makeFlowGrid();
      }
      loadFloorState(currentFloor, false);
    }

    maxHeatCell = null;
    maxHeatValue = 0;

    // UI state
    btnStart.disabled = null;
    btnStart.classList.add("pulse");

    syncPublicState();
    drawScene();
    return true;
  }

  btnClearMap.addEventListener("click", () => {
    spawns = [];
    exits = [];
    if (grid) {
      for (let y=0;y<gridH;y++)for(let x=0;x<gridW;x++){
        grid[y][x].fire = false;
        grid[y][x].fireIntensity = 0;
        grid[y][x].fireAgeSec = 0;
        grid[y][x].temperatureC = 20;
        grid[y][x].heatFluxKwM2 = 0;
        grid[y][x].heat = 0;
        grid[y][x].stair = !!floorStates[currentFloor]?.stairTemplate?.[y]?.[x];
        grid[y][x].stairType = grid[y][x].stair ? (grid[y][x].stairType || "indoor") : null;
        grid[y][x].walkable = !!baseWalkableTemplate?.[y]?.[x] || grid[y][x].stair;
        grid[y][x].wall = !grid[y][x].walkable;
      }
    }
    removeStairLinksByFloor(currentFloor);
    sanitizeStairLinks();
    syncActiveFloorState();
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    rebuildPotentialCache();
    log(`Cleared markers on floor ${currentFloor + 1}F`);
    state.render.geometryRevision = (state.render.geometryRevision || 0) + 1;
    syncPublicState();
    drawScene();
  });

  btnMonte.addEventListener("click", () => {

  if (!gridW || !gridH || !floorStates.length || !floorStates.some(fs => !!fs?.baseImage)) {
    alert("Monte Carlo 実行前にマップを読み込んでください。");
    return;
  }

  mcRunning = true;
  mcRuns = 0;
  mcResults = [];

  log(`Monte Carlo開始: ${mcTargetRuns}回`);

  startSimulationCore();

});

  btnApplyFloors.addEventListener("click", () => {
    syncActiveFloorState();
    applyFloorSetup(true);
    log(`Applied floor setup: ${floorCount} floor(s)`);
    setStatus(`フロア設定を反映しました: ${floorCount}階。`);
  });
  currentFloorSelect.addEventListener("change", () => {
    const target = SINGLE_FLOOR_MODE ? 0 : clamp(Math.floor(parseNum(currentFloorSelect, currentFloor)), 0, floorCount - 1);
    syncActiveFloorState();
    if (!floorStates[target]) {
      currentFloor = target;
      updateFloorLabel();
      syncPublicState();
    drawScene();
    } else {
      loadFloorState(target);
    }
    if (mode === "stairLink" && pendingStairLink) {
      setStatus(`Moved to floor ${target + 1}F. Stair link selection remains active.`);
    } else {
      setStatus(`フロアを ${target + 1}F に切り替えました。`);
    }
  });
  floorCountInput.addEventListener("change", () => {
    floorCountInput.value = String(clamp(Math.floor(parseNum(floorCountInput, 1)), 1, 8));
  });

  agentPresetInput.addEventListener("change", () => {
    applyAgentPreset(agentPresetInput.value);
  });
  [vizTrailsInput, vizFlowInput, vizPotentialInput, potentialViewModeInput, potentialExitIndexInput, riskViewModeInput]
    .filter(Boolean)
    .forEach(el => el.addEventListener("change", drawScene));

  btnSavePreset.addEventListener("click", saveCurrentPreset);
  btnLoadPreset.addEventListener("click", loadSelectedPreset);
  btnExportCsv.addEventListener("click", downloadCsv);
  btnParamHistory.addEventListener("click", showParamHistory);
  btnAnalyze.addEventListener("click", () => analyzeBottlenecks(true));
  btnOptimizeExit.addEventListener("click", optimizeExitPlacement);
  btnAutoImprove.addEventListener("click", autoImproveSpawnPlacement);

  function startSimulationCore() {
    
    if (!gridW || !gridH || !floorStates.length || !floorStates.some(fs => !!fs?.baseImage)) {
      alert("シミュレーション開始前にマップを読み込んでください。");
      return false;
    }
    if (!mcRunning || mcRuns === 0) {
      pushParamHistory();
    }
    if (!spawnAgents()) return false;
    simRunning = true;
    syncPublicState();
    simTime = 0;
    lastFrameTime = performance.now();
    btnStart.disabled = true;
    btnStart.classList.remove("pulse");
    const startRuleLabel = (startRuleInput?.value === "far_first") ? "far_first" : "simultaneous";
    setStatus(`Simulation running. start_rule=${startRuleLabel}`);
    requestAnimationFrame(loop);

    return true;
  };

  function stopSimulationCore() {
    if (!simRunning) return false;
    simRunning = false;
    syncPublicState();
    summarize();
    setStatus("Simulation stopped.");
    log("Simulation stopped.");
    return true;
  }
  // ==== Main Loop ====
  function loop(now) {
    if (!simRunning) return;
    if (!lastFrameTime) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000; // sec
    lastFrameTime = now;
    simTime += dt;
    syncPublicState();

    stepSimulation(dt);
    syncPublicState();
    drawScene();
    requestAnimationFrame(loop);
  }

  function stepSimulation(dt) {
    if (!grid || !floorStates.length) return;
    syncActiveFloorState();

    // === Smoke generation and diffusion (per-floor) ===
    const cellMeters = parseFloat(cellSizeMetersInput.value) || 0.5;
    if (simTime >= nextFireStepAt) {
      const fireDt = Math.max(dt, Math.min(1, simTime - lastFireStepAt || dt));
      const fireResult = stepFire3D(floorStates, fireDt, {
        timeSec: simTime,
        cellSizeMeters: cellMeters,
        floorHeightMeters: state.spatial.floorHeightMeters || 3.5,
        stairLinks,
        fdsLookup: getFdsRiskAt
      });
      const applied = applyFire3DResultToLegacyFloors(floorStates, fireResult, {
        blockIgnitedCells: false
      });
      activeFireCount = fireResult.activeFireCount;
      totalFireHrrKw = fireResult.totalHrrKw;
      if (applied.ignitedCells.length) {
        log(`火災延焼: ${applied.ignitedCells.length}セル / active=${activeFireCount}`);
      }
      lastFireStepAt = simTime;
      nextFireStepAt = simTime + 0.5;
    }
    const dirs8 = [
      {dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1},
      {dx:1,dy:1},{dx:-1,dy:1},{dx:1,dy:-1},{dx:-1,dy:-1}
    ];
    const dirs4 = [
      {dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}
    ];
    const inBounds = (x, y) => x >= 0 && y >= 0 && x < gridW && y < gridH;
    const floorInBounds = f => f >= 0 && f < floorCount;

    const MAX_SMOKE = 4.5;
    const FIRE_SOURCE_PER_SEC = Math.max(0, parseNum(smokeSourceRateInput, 3.8));
    const DIFFUSE_PER_SEC = Math.max(0, parseNum(smokeDiffusionRateInput, 2.8)) / cellMeters;
    const BASE_DECAY_PER_SEC = Math.max(0, parseNum(smokeDecayRateInput, 0.006));
    const SMOKE_SPREAD_MIX = clamp(parseNum(smokeSpreadMixInput, 0.65), 0.05, 1.2);
    const SMOKE_DIAGONAL_MIX = clamp(parseNum(smokeDiagonalMixInput, 0.25), 0, 0.8);
    const upTransferRatio = Math.min(0.55, BUOYANCY_PER_SEC * dt);
    const diffuseRatio = Math.min(0.92, DIFFUSE_PER_SEC * dt * SMOKE_SPREAD_MIX);

    for (let f = 0; f < floorCount; f++) {
      const fs = floorStates[f];
      const fGrid = fs.grid;
      if (!fGrid || !fs.smokeMap || !fs.smokeCeil) continue;

      const vent = makeScalarGrid(0);
      fs.exits.forEach(({cx, cy}) => {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!inBounds(nx, ny)) continue;
            if (Math.hypot(dx, dy) <= 2.2) vent[ny][nx] = 1;
          }
        }
      });

      const nextSmoke = makeScalarGrid(0);
      const nextCeil = fs.smokeCeil.map(row => row.slice());
      const smokePassable = (x, y) => {
        const c = fGrid[y][x];
        return c.walkable || c.fire || c.stair;
      };

      function collectSmokeTargets(x, y) {
        const targets = [];
        const add = (nx, ny, weight) => {
          if (!inBounds(nx, ny)) return;
          if (!smokePassable(nx, ny)) return;
          targets.push({ x: nx, y: ny, weight });
        };
        for (const d of dirs4) add(x + d.dx, y + d.dy, 1.0);
        if (SMOKE_DIAGONAL_MIX > 0) {
          const diagonals = [
            { dx: 1, dy: 1 }, { dx: -1, dy: 1 },
            { dx: 1, dy: -1 }, { dx: -1, dy: -1 }
          ];
          for (const d of diagonals) {
            const nx = x + d.dx;
            const ny = y + d.dy;
            if (!inBounds(nx, ny) || !smokePassable(nx, ny)) continue;
            const sideA = inBounds(x + d.dx, y) && smokePassable(x + d.dx, y);
            const sideB = inBounds(x, y + d.dy) && smokePassable(x, y + d.dy);
            if (sideA || sideB) add(nx, ny, SMOKE_DIAGONAL_MIX);
          }
        }
        return targets;
      }

      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (!smokePassable(x, y)) continue;
          let sm = fs.smokeMap[y][x];
          if (fGrid[y][x].fire) {
            sm += FIRE_SOURCE_PER_SEC * dt;
            nextCeil[y][x] = true;
          }
          if (sm <= 0.0001) continue;

          let remain = sm;
          const upY = y - 1;
          if (upY >= 0 && smokePassable(x, upY)) {
            const up = remain * upTransferRatio;
            nextSmoke[upY][x] += up;
            remain -= up;
            nextCeil[y][x] = true;
          } else if (upY < 0 || !smokePassable(x, upY)) {
            nextCeil[y][x] = true;
          }

          const targets = collectSmokeTargets(x, y);
          if (targets.length > 0) {
            const move = remain * diffuseRatio;
            const weightSum = targets.reduce((sum, t) => sum + Math.max(0, t.weight || 0), 0) || targets.length;
            remain -= move;
            for (const t of targets) {
              const share = move * (Math.max(0, t.weight || 0) / weightSum);
              nextSmoke[t.y][t.x] += share;
            }
          }
          nextSmoke[y][x] += remain;
        }
      }

      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (!smokePassable(x, y)) {
            nextSmoke[y][x] = 0;
            Object.assign(fGrid[y][x], {
              smokeDensity: 0,
              opticalDensity: 0,
              opticalDensityM1: 0,
              coPpm: 0,
              visibilityMeters: 30,
              visibilityM: 30,
              smoke: 0,
              co: 0,
              visibility: 1
            });
            continue;
          }
          const decay = Math.max(0, 1 - (BASE_DECAY_PER_SEC + (vent[y][x] ? VENT_DECAY_BONUS : 0)) * dt);
          const density = Math.max(0, Math.min(MAX_SMOKE, nextSmoke[y][x] * decay));
          const opticalDensity = density * 0.32;
          const coPpm = density * 260;
          const visibilityMeters = opticalDensity > 0.001 ? Math.min(30, 3 / opticalDensity) : 30;
          nextSmoke[y][x] = density;
          Object.assign(fGrid[y][x], {
            smokeDensity: density,
            opticalDensity,
            opticalDensityM1: opticalDensity,
            coPpm,
            visibilityMeters,
            visibilityM: visibilityMeters,
            smoke: density,
            co: coPpm,
            visibility: clamp(visibilityMeters / 30, 0, 1)
          });
        }
      }

      fs.smokeMap = nextSmoke;
      fs.smokeCeil = nextCeil;
    }

    verticalSmokeTransfers = transferLegacySmokeThroughStairs(
      floorStates,
      stairLinks,
      dt,
      {
        floorHeightMeters: state.spatial.floorHeightMeters || 3.5,
        syncCellFields: true
      }
    );
    applyCurrentFdsToSharedHazards(simTime);

    if (!agents || agents.length === 0) {
      loadFloorState(currentFloor, false);
      return;
    }

    const stairStep = stepStairTraffic(stairTrafficState, stairLinks, agents, dt);
    stairTrafficState = stairStep.trafficState;
    stairCongestion = stairStep.congestion;
    stairStep.agents.forEach((nextAgent, index) => {
      const current = agents[index];
      if (!current || current.id !== nextAgent.id) return;
      Object.assign(current, nextAgent);
    });

    const smokeAt = (floor, x, y) =>
      (floorInBounds(floor) && inBounds(x, y))
        ? (floorStates[floor].smokeMap?.[y]?.[x] || 0)
        : 0;

    function fireRiskAt(floor, cx, cy) {
      let heat = 0;
      let heatFluxKwM2 = 0;
      let temperatureC = 20;
      let lethal = false;
      const fGrid = floorStates[floor]?.grid;
      if (!fGrid) return { heat, heatFluxKwM2, temperatureC, lethal };
      const r = Math.ceil(FIRE_DANGER_RADIUS);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny)) continue;
          const sourceCell = fGrid[ny][nx];
          if (!sourceCell.fire) continue;
          const d = Math.hypot(dx, dy);
          if (d <= FIRE_LETHAL_RADIUS) lethal = true;
          if (d <= FIRE_DANGER_RADIUS) {
            const intensity = clamp(Number(sourceCell.fireIntensity) || 0.05, 0.05, 1);
            const attenuation = (FIRE_DANGER_RADIUS - d) / FIRE_DANGER_RADIUS;
            heat += attenuation * (0.25 + intensity * 0.75);
            heatFluxKwM2 = Math.max(
              heatFluxKwM2,
              Math.max(0, Number(sourceCell.heatFluxKwM2) || 0) * attenuation
            );
            temperatureC = Math.max(
              temperatureC,
              20 + (Math.max(20, Number(sourceCell.temperatureC) || 20) - 20) * attenuation
            );
          }
        }
      }
      return { heat, heatFluxKwM2, temperatureC, lethal };
    }

    function fallbackEngineeringRisk(floor, cx, cy) {
      const smoke = smokeAt(floor, cx, cy);
      const fire = fireRiskAt(floor, cx, cy);
      const hrrScale = Math.min(1, t2FireHrrKw(simTime) / Math.max(1, T2_FIRE_MAX_HRR_KW));
      const heatFluxKwM2 = Math.max(
        fire.heatFluxKwM2 || 0,
        fire.heat * 8.0 * (0.35 + 0.65 * hrrScale)
      );
      const opticalDensityM1 = Math.max(0, smoke * 0.32);
      const coPpm = Math.max(0, smoke * 260 * (0.4 + 0.6 * hrrScale));
      const visibilityM = opticalDensityM1 > 0.001 ? Math.min(30, 3.0 / opticalDensityM1) : 30;

      return {
        heatFluxKwM2,
        opticalDensityM1,
        coPpm,
        visibilityM,
        temperatureC: fire.temperatureC,
        source: "fallback_t2"
      };
    }

    function engineeringRiskAt(floor, cx, cy) {
      const fds = getFdsRiskAt(floor, cx, cy, simTime);
      if (fds) return { ...fds, source: "fds_csv" };
      return fallbackEngineeringRisk(floor, cx, cy);
    }

    function routeRiskAt(floor, cx, cy) {
      const fGrid = floorStates[floor]?.grid;
      if (!fGrid || !inBounds(cx, cy)) {
        return { blocked: true, penalty: FIRE_BLOCK_SCORE, visibilityFactor: 1, risk: null };
      }

      const cell = fGrid[cy][cx];
      const smoke = smokeAt(floor, cx, cy);
      const fire = fireRiskAt(floor, cx, cy);
      const er = engineeringRiskAt(floor, cx, cy);

      if (LETHAL_FIRE_CELL_BLOCK && cell.fire) {
        return { blocked: true, penalty: FIRE_BLOCK_SCORE, visibilityFactor: 1, risk: er };
      }

      if (fire.lethal || fire.heat >= FIRE_HARD_AVOID_HEAT) {
        return {
          blocked: true,
          penalty: FIRE_NEAR_BLOCK_SCORE + fire.heat * FIRE_LETHAL_ROUTE_WEIGHT,
          visibilityFactor: 1,
          risk: er
        };
      }

      const od = Math.max(0, er.opticalDensityM1 || 0);
      const co = Math.max(0, er.coPpm || 0);
      const hf = Math.max(0, er.heatFluxKwM2 || 0);
      const vis = Number.isFinite(er.visibilityM) ? Math.max(0, er.visibilityM) : 30;
      const visibilityFactor = Math.max(0, Math.min(1, vis / 10));

      const hard =
        smoke >= SMOKE_HARD_AVOID_LEVEL ||
        od >= FDS_OPTICAL_DENSITY_HARD ||
        co >= FDS_CO_HARD_PPM ||
        hf >= FDS_HEAT_FLUX_HARD_KW_M2;

      const penalty =
        smoke * SMOKE_ROUTE_WEIGHT +
        smoke * smoke * SMOKE_ROUTE_QUADRATIC_WEIGHT +
        fire.heat * FIRE_ROUTE_WEIGHT +
        Math.max(0, hf - FDS_HEAT_FLUX_SOFT_KW_M2) * FDS_ROUTE_HEAT_WEIGHT +
        Math.max(0, od - FDS_OPTICAL_DENSITY_SOFT) * FDS_ROUTE_OD_WEIGHT +
        Math.max(0, co - FDS_CO_SOFT_PPM) * FDS_ROUTE_CO_WEIGHT +
        Math.max(0, 1 - visibilityFactor) * FDS_ROUTE_VISIBILITY_WEIGHT +
        (hard ? HIGH_SMOKE_BLOCK_SCORE : 0);

      return { blocked: false, penalty, visibilityFactor, risk: er };
    }

    const occupancyByFloor = new Array(floorCount).fill(null).map(() => makeScalarGrid(0));
    agents.forEach(a => {
      if (a.finished || a.dead) return;
      const f = clamp(Math.floor(a.floor ?? 0), 0, floorCount - 1);
      const cx = Math.round(a.x);
      const cy = Math.round(a.y);
      if (inBounds(cx, cy)) occupancyByFloor[f][cy][cx] += 1;
    });
    const occupancyDynamicByFloor = occupancyByFloor.map(layer => layer.map(row => row.slice()));

    function localDensity(floor, cx, cy) {
      let cnt = 0;
      let cells = 0;
      const fGrid = floorStates[floor]?.grid;
      if (!fGrid) return 0;
      for (let dy = -DENSITY_RADIUS; dy <= DENSITY_RADIUS; dy++) {
        for (let dx = -DENSITY_RADIUS; dx <= DENSITY_RADIUS; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny)) continue;
          if (!fGrid[ny][nx].walkable) continue;
          cnt += occupancyDynamicByFloor[floor][ny][nx];
          cells++;
        }
      }
      return cells > 0 ? cnt / cells : 0;
    }

    const byId = new Map();
    agents.forEach(a => byId.set(a.id, a));

    const exitLoad = new Array(allExitPoints.length).fill(0);
    agents.forEach(a => {
      if (a.dead || a.finished) return;
      if (Number.isInteger(a.targetExitIndex) && a.targetExitIndex >= 0 && a.targetExitIndex < allExitPoints.length) {
        exitLoad[a.targetExitIndex] += 1;
      }
    });

    if (simTime >= nextRouteReplanAt) {
      agents.forEach(a => {
        if (a.dead || a.finished || a.fallen) return;
        const f = clamp(Math.floor(a.floor ?? 0), 0, floorCount - 1);
        const cx = Math.round(a.x);
        const cy = Math.round(a.y);
        if (!inBounds(cx, cy)) return;
        a.floor = f;
        a.cx = cx;
        a.cy = cy;
        const choice = chooseExitForAgent(a, exitLoad);
        const curScore =
          (Number.isInteger(a.targetExitIndex) && a.targetExitIndex >= 0 && a.targetExitIndex < allExitPoints.length)
            ? estimateExitCost(a.targetExitIndex, f, cx, cy, exitLoad)
            : Infinity;
        const localRouteRisk = routeRiskAt(f, cx, cy);
        const switchMargin = a.type === "teacher"
          ? 0.5
          : (a.type === "panic" ? 5.5 : EXIT_SWITCH_MARGIN);
        const panicMaySwitch = a.type !== "panic" ||
          localRouteRisk.penalty >= HIGH_SMOKE_BLOCK_SCORE * 0.35 ||
          (a.stuckTime || 0) >= STUCK_UPHILL_RELEASE_SEC;
        const shouldSwitch =
          (choice.idx >= 0) &&
          (choice.idx !== a.targetExitIndex) &&
          panicMaySwitch &&
          (choice.score + switchMargin < curScore);
        if (shouldSwitch) {
          a.targetExitIndex = choice.idx;
          a.targetExit = choice.idx;
          a.potentialField = choice.field;
        }
      });
      nextRouteReplanAt = simTime + 1.5;
    }

    function findLeaderFor(agent) {
      let best = null;
      let bestD = Infinity;
      agents.forEach(other => {
        if (other.dead || other.finished) return;
        if (other.floor !== agent.floor) return;
        if (!(other.type === "leader" || other.type === "teacher")) return;
        const d = Math.hypot(other.x - agent.x, other.y - agent.y);
        if (d < bestD) {
          best = other;
          bestD = d;
        }
      });
      return best && bestD <= 8 ? best : null;
    }

    agents.forEach(a => {
      if (a.finished || a.dead) return;
      const f = clamp(Math.floor(a.floor ?? 0), 0, floorCount - 1);
      const cx = Math.round(a.x);
      const cy = Math.round(a.y);
      if (!inBounds(cx, cy)) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = "out_of_bounds";
        a.fallen = false;
        a.rescue = null;
        a.helpingId = null;
        return;
      }

      const smoke = smokeAt(f, cx, cy);
      const fire = fireRiskAt(f, cx, cy);
      const localEngineeringRisk = engineeringRiskAt(f, cx, cy);
      const riskVisibilityFactor = Number.isFinite(localEngineeringRisk.visibilityM)
        ? Math.max(MIN_VISIBILITY, Math.min(1, localEngineeringRisk.visibilityM / 10))
        : 1;
      a.visibility = Math.min(riskVisibilityFactor, Math.max(MIN_VISIBILITY, 1 - smoke * VISIBILITY_SMOKE_COEF));
      a.smokeDose += Math.max(0, smoke - 0.2) * Math.max(0, smoke - 0.2) * dt;
      a.heatDose += fire.heat * dt;
      a.coDosePpmMin = (a.coDosePpmMin || 0) + Math.max(0, localEngineeringRisk.coPpm || 0) * (dt / 60);
      a.coDose = a.coDosePpmMin;
      a.heatFluxDose = (a.heatFluxDose || 0) +
        Math.max(0, (localEngineeringRisk.heatFluxKwM2 || 0) - FDS_HEAT_FLUX_SOFT_KW_M2) * dt;

      const acuteSmoke = smoke >= LETHAL_SMOKE_LEVEL &&
        Math.random() < Math.max(0, smoke - LETHAL_SMOKE_LEVEL + 0.2) * 0.25 * dt;

      if (
        fire.lethal || acuteSmoke ||
        a.smokeDose >= SMOKE_DEATH_DOSE ||
        a.heatDose >= HEAT_DEATH_DOSE ||
        a.coDosePpmMin >= CO_DOSE_FATAL_PPM_MIN ||
        a.heatFluxDose >= HEAT_FLUX_DOSE_FATAL
      ) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = fire.lethal
          ? "fire"
          : (a.coDosePpmMin >= CO_DOSE_FATAL_PPM_MIN
            ? "co"
            : (acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE
              ? "smoke"
              : (a.heatFluxDose >= HEAT_FLUX_DOSE_FATAL ? "heat_flux" : "heat")));
        a.fallen = false;
        a.rescue = null;
        a.helpingId = null;
      }
    });

    agents.forEach(a => {
      if (a.helpingId == null) return;
      const t = byId.get(a.helpingId);
      if (!t || t.dead || !t.fallen || t.floor !== a.floor) a.helpingId = null;
    });

    agents.forEach(fallen => {
      if (fallen.dead || fallen.finished) return;
      if (!fallen.fallen || fallen.rescue) return;
      const candidates = [];
      agents.forEach(helper => {
        if (helper.id === fallen.id) return;
        if (helper.floor !== fallen.floor) return;
        if (helper.dead || helper.finished || helper.fallen) return;
        if (helper.helpingId != null) return;
        if (simTime < helper.startTime + (helper.evacDelay || 0)) return;
        const d = Math.hypot(helper.x - fallen.x, helper.y - fallen.y);
        if (d <= 2.5) candidates.push({ id: helper.id, d });
      });
      candidates.sort((a, b) => a.d - b.d);
      if (candidates.length >= HELPERS_NEEDED) {
        const helperIds = candidates.slice(0, HELPERS_NEEDED).map(c => c.id);
        fallen.rescue = { helperIds, endTime: simTime + RESCUE_DURATION_SEC };
        helperIds.forEach(hid => {
          const h = byId.get(hid);
          if (h) h.helpingId = fallen.id;
        });
      }
    });

    agents.forEach(fallen => {
      if (fallen.dead || !fallen.fallen || !fallen.rescue) return;
      if (simTime < fallen.rescue.endTime) return;
      const helperIds = fallen.rescue.helperIds || [];
      fallen.fallen = false;
      fallen.rescue = null;
      fallen.recoveredUntil = simTime + 8.0;
      helperIds.forEach(hid => {
        const h = byId.get(hid);
        if (h && h.helpingId === fallen.id) h.helpingId = null;
      });
    });

    let evacCount = 0;
    let deadCount = 0;

    agents.forEach(a => {
      if (a.dead) {
        deadCount++;
        return;
      }
      if (a.finished) {
        evacCount++;
        return;
      }

      const floor = clamp(Math.floor(a.floor ?? 0), 0, floorCount - 1);
      const fGrid = floorStates[floor].grid;
      const cx = Math.round(a.x);
      const cy = Math.round(a.y);
      if (!inBounds(cx, cy)) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = "out_of_bounds";
        deadCount++;
        return;
      }

      if (a.helpingId != null) {
        const target = byId.get(a.helpingId);
        if (!target || target.dead || !target.fallen || target.floor !== floor) {
          a.helpingId = null;
        } else {
          const dxh = target.x - a.x;
          const dyh = target.y - a.y;
          const dh = Math.hypot(dxh, dyh);
          if (dh > 0.7) {
            const step = Math.min(0.8 * dt, dh);
            const nxp = a.x + (dxh / dh) * step;
            const nyp = a.y + (dyh / dh) * step;
            const ncx = Math.round(nxp);
            const ncy = Math.round(nyp);
            const same = (ncx === cx && ncy === cy);
            if (
              inBounds(ncx, ncy) &&
              !floorStates[floor].grid[ncy][ncx].fire &&
              (same || occupancyDynamicByFloor[floor][ncy][ncx] < MAX_OCCUPANCY_PER_CELL)
            ) {
              a.x = nxp;
              a.y = nyp;
              if (!same) {
                occupancyDynamicByFloor[floor][cy][cx] = Math.max(0, occupancyDynamicByFloor[floor][cy][cx] - 1);
                occupancyDynamicByFloor[floor][ncy][ncx] += 1;
              }
            }
          }
          return;
        }
      }

      if (a.fallen) return;
      if (simTime < a.startTime + (a.evacDelay || 0)) return;
      if (a.stairTransition) {
        a.behaviorState = "stair_transition";
        return;
      }

      const potentialField = a.potentialField || multiCombinedPotential;
      if (!potentialField) return;
      const curPot = potentialField?.[floor]?.[cy]?.[cx];
      if (!isFinite(curPot) || curPot < 0.01) {
        a.finished = true;
        a.finishTime = simTime;
        evacCount++;
        occupancyDynamicByFloor[floor][cy][cx] = Math.max(0, occupancyDynamicByFloor[floor][cy][cx] - 1);
        return;
      }

      const localSmoke = smokeAt(floor, cx, cy);
      const localFire = fireRiskAt(floor, cx, cy);
      a.visibility = Math.max(MIN_VISIBILITY, 1 - localSmoke * VISIBILITY_SMOKE_COEF);
      const densityHere = localDensity(floor, cx, cy);
      const prevCell = a.prevCell;

      let leaderTarget = null;
      if (a.type === "student" || a.type === "child") {
        leaderTarget = (a.leaderId != null) ? byId.get(a.leaderId) : null;
        if (!leaderTarget || leaderTarget.dead || leaderTarget.finished || leaderTarget.floor !== floor) {
          leaderTarget = findLeaderFor(a);
          a.leaderId = leaderTarget ? leaderTarget.id : null;
        }
      }

      a.behaviorState = deriveAgentBehaviorState(a, {
        floors: floorStates,
        cell: fGrid[cy][cx],
        teacher: leaderTarget,
        followTeacher: !!leaderTarget
      });
      if (a.behaviorState === "panic_escape") {
        if (!a.panicEscapeLatched) a.panicEscapeCount = (a.panicEscapeCount || 0) + 1;
        a.panicEscapeLatched = true;
      } else {
        a.panicEscapeLatched = false;
      }

      let best = { dx: 0, dy: 0, nx: cx, ny: cy, nf: floor, score: -Infinity, linkId: null };
      const dirPool = a.visibility < LOW_VISIBILITY_THRESHOLD ? dirs4 : dirs8;
      const candidates = dirPool.map(d => ({ ...d, nf: floor })).concat([{ dx: 0, dy: 0, nf: floor }]);
      const candidateKeys = new Set(
        candidates.map(c => stairEndpointKey(c.nf ?? floor, cx + (c.dx ?? 0), cy + (c.dy ?? 0)))
      );
      function pushCandidate(c) {
        const nf = c.nf ?? floor;
        const nx = Number.isFinite(c.nx) ? c.nx : (cx + (c.dx ?? 0));
        const ny = Number.isFinite(c.ny) ? c.ny : (cy + (c.dy ?? 0));
        const key = stairEndpointKey(nf, nx, ny);
        if (candidateKeys.has(key)) {
          const existing = candidates.find(item => {
            const itemFloor = item.nf ?? floor;
            const itemX = Number.isFinite(item.nx) ? item.nx : (cx + (item.dx ?? 0));
            const itemY = Number.isFinite(item.ny) ? item.ny : (cy + (item.dy ?? 0));
            return itemFloor === nf && itemX === nx && itemY === ny;
          });
          if (existing) Object.assign(existing, c, { nf, nx, ny });
          return;
        }
        candidateKeys.add(key);
        candidates.push({ ...c, nf, nx, ny });
      }
      if (fGrid[cy][cx].stair) {
        const linked = getLinkedStairDestinations(floor, cx, cy);
        for (let i = 0; i < linked.length; i++) {
          const dst = linked[i];
          const nc = floorStates[dst.floor]?.grid?.[dst.cy]?.[dst.cx];
          if (!nc?.walkable || nc.fire || !nc.stair) continue;
          pushCandidate({
            dx: dst.cx - cx,
            dy: dst.cy - cy,
            nf: dst.floor,
            nx: dst.cx,
            ny: dst.cy,
            stairMove: true,
            linkMove: true,
            linkId: dst.linkId,
            travelCostSec: dst.travelCostSec
          });
        }
      }
      if (a.behaviorState === "seek_clear_air" || a.behaviorState === "stuck_escape") {
        const clearAir = chooseClearAirStep(a, floorStates, { allowDiagonal: a.visibility >= LOW_VISIBILITY_THRESHOLD });
        if (clearAir && clearAir.improvement >= 0) {
          pushCandidate({
            dx: clearAir.dx,
            dy: clearAir.dy,
            nf: floor,
            nx: clearAir.cx,
            ny: clearAir.cy,
            clearAir: true,
            clearAirImprovement: clearAir.improvement
          });
        }
      }
      const panicDir = (a.panicFactor > 0 && Math.random() < a.panicFactor)
        ? dirPool[Math.floor(Math.random() * dirPool.length)]
        : null;

      const evaluated = [];
      for (const c of candidates) {
        const nx = Number.isFinite(c.nx) ? c.nx : (cx + (c.dx ?? 0));
        const ny = Number.isFinite(c.ny) ? c.ny : (cy + (c.dy ?? 0));
        const nf = c.nf ?? floor;
        if (!isAgentTraversableCell(nf, nx, ny)) continue;

        const routeRisk = routeRiskAt(nf, nx, ny);
        if (routeRisk.blocked) continue;
        const nextPot = potentialField?.[nf]?.[ny]?.[nx];
        if (!isFinite(nextPot)) continue;

        const rawOcc = occupancyDynamicByFloor[nf][ny][nx];
        const occ = (nf === floor && nx === cx && ny === cy) ? Math.max(0, rawOcc - 1) : rawOcc;
        if (!(nf === floor && nx === cx && ny === cy) && occ >= MAX_OCCUPANCY_PER_CELL) continue;

        const densityTarget = localDensity(nf, nx, ny);
        const smokeTarget = smokeAt(nf, nx, ny);
        const fireTarget = fireRiskAt(nf, nx, ny);
        const heatPenalty = Math.min(100, (floorStates[nf].heatmap?.[ny]?.[nx] || 0)) * HEATMAP_PENALTY_WEIGHT;
        const potGain = curPot - nextPot;
        const uphill = Math.max(0, nextPot - curPot);
        const isBacktrack = !!(prevCell && prevCell.floor === nf && prevCell.cx === nx && prevCell.cy === ny);
        evaluated.push({
          c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty,
          fireHeat: fireTarget.heat,
          routeRiskPenalty: routeRisk.penalty,
          routeVisibilityFactor: routeRisk.visibilityFactor,
          potGain, uphill, isBacktrack
        });
      }

      const stuckTime = a.stuckTime || 0;
      const strictBacktrack = stuckTime < STUCK_BACKTRACK_RELEASE_SEC;
      const strictUphill = stuckTime < STUCK_UPHILL_RELEASE_SEC;
      const hasForwardMove = evaluated.some(e => e.potGain > 0.04);
      const hasNonBacktrackOption = evaluated.some(e => !e.isBacktrack);

      let evalPool = evaluated.filter(e => {
        if (strictBacktrack && e.isBacktrack && hasNonBacktrackOption) return false;
        if (strictUphill && e.uphill > 0.06 && hasForwardMove) return false;
        return true;
      });
      if (evalPool.length === 0) evalPool = evaluated;

      for (const e of evalPool) {
        const {
          c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty,
          fireHeat, routeRiskPenalty, routeVisibilityFactor, potGain, uphill, isBacktrack
        } = e;
        let score = potGain * POTENTIAL_GAIN_WEIGHT;
        score -= uphill * UPHILL_PENALTY_WEIGHT;
        score -= occ * CONGESTION_PENALTY_WEIGHT;
        score -= densityTarget * CONGESTION_PENALTY_WEIGHT;
        score -= smokeTarget * SMOKE_AVOID_WEIGHT;
        score -= fireHeat * FIRE_AVOID_WEIGHT;
        const hazardAvoidance = a.type === "teacher" ? 1.35 : (a.type === "panic" ? 0.72 : 1);
        score -= routeRiskPenalty * hazardAvoidance;
        if (routeVisibilityFactor < 0.35) {
          score -= (0.35 - routeVisibilityFactor) * FDS_ROUTE_VISIBILITY_WEIGHT;
        }
        score -= heatPenalty;

        if (isBacktrack) score -= BACKTRACK_PENALTY;

        if (a.moveDir && nf === floor) {
          const stepMag = Math.hypot(c.dx, c.dy);
          if (stepMag > 0.001) {
            const ndx = c.dx / stepMag;
            const ndy = c.dy / stepMag;
            const dot = ndx * a.moveDir.dx + ndy * a.moveDir.dy;
            score += dot * HEADING_INERTIA_WEIGHT;
            if (dot < -0.2) score -= TURNBACK_EXTRA_PENALTY;
          }
        }

        if (leaderTarget) {
          const curDistLead = Math.hypot(leaderTarget.x - a.x, leaderTarget.y - a.y);
          const nxtDistLead = Math.hypot(leaderTarget.x - nx, leaderTarget.y - ny);
          const followWeight = a.visibility < LOW_VISIBILITY_THRESHOLD ? 2.4 : 1.1;
          score += (curDistLead - nxtDistLead) * followWeight;
        }
        if (c.clearAir) score += 2.5 + Math.max(0, c.clearAirImprovement || 0) * 3;
        if (panicDir && c.dx === panicDir.dx && c.dy === panicDir.dy) {
          score += 0.9 + (a.panicFactor * 1.5);
        }
        if (c.dx === 0 && c.dy === 0 && nf === floor) score -= STAY_PENALTY;
        if (nf !== floor) score += 1.2;
        score += (Math.random() - 0.5) * VISIBILITY_NOISE * (1 - a.visibility);
        if (a.panicFactor > 0) {
          score += (Math.random() - 0.5) * (1.8 * a.panicFactor);
        }

        if (nf !== floor) score -= Math.max(0, Number(c.travelCostSec) || 0) * 0.08;
        if (score > best.score) best = { dx: c.dx, dy: c.dy, nx, ny, nf, score, linkId: c.linkId || null };
      }

      let speedFactor = 1;
      speedFactor *= Math.max(MIN_SPEED_FACTOR, 1 - localSmoke * 0.35);
      speedFactor *= 1 / (1 + densityHere * DENSITY_SPEED_COEF);
      speedFactor *= (0.45 + 0.55 * a.visibility);
      speedFactor *= Math.max(0.5, 1 - localFire.heat * 0.12);
      if (a.recoveredUntil && simTime < a.recoveredUntil) speedFactor *= 0.85;
      if (a.visibility < 0.2 && Math.random() < 0.3) speedFactor *= 0.25;
      if (a.type === "elderly") speedFactor *= 0.9;
      if (a.panicFactor > 0) speedFactor *= (0.86 + Math.random() * 0.5);
      if (a.type === "student" && leaderTarget) speedFactor *= 1.03;

      const prevX = a.x;
      const prevY = a.y;
      const prevFloor = floor;

      if (best.nf !== floor) {
        const rawLink = stairLinks.find(link => link.id === best.linkId);
        if (rawLink) {
          const link = normalizeStairLink(rawLink);
          const queued = enqueueStairTransition(
            stairTrafficState,
            link,
            a,
            { floorIndex: floor, cx, cy },
            simTime
          );
          if (queued.status === "queued") {
            stairTrafficState = queued.state;
            a.behaviorState = "stair_transition";
            a.targetStair = link.id;
            a.stairTransition = {
              status: "queued",
              linkId: link.id,
              from: { floorIndex: floor, cx, cy },
              to: { floorIndex: best.nf, cx: best.nx, cy: best.ny },
              travelCostSec: link.travelCostSec,
              remainingSec: link.travelCostSec,
              progress: 0
            };
            stairCongestion = getStairCongestion(stairTrafficState, stairLinks);
          }
        }
      } else {
        const stepCells = a.v * speedFactor * dt;
        const vx = best.nx - a.x;
        const vy = best.ny - a.y;
        const dist = Math.hypot(vx, vy);
        if (dist > 0.0001) {
          const step = Math.min(stepCells, dist);
          a.x += (vx / dist) * step;
          a.y += (vy / dist) * step;
        }

        const nx = Math.round(a.x);
        const ny = Math.round(a.y);
        if (inBounds(nx, ny) && (nx !== cx || ny !== cy)) {
          if (occupancyDynamicByFloor[floor][ny][nx] >= MAX_OCCUPANCY_PER_CELL) {
            a.x = cx;
            a.y = cy;
          } else {
            occupancyDynamicByFloor[floor][cy][cx] = Math.max(0, occupancyDynamicByFloor[floor][cy][cx] - 1);
            occupancyDynamicByFloor[floor][ny][nx] += 1;
          }
        }
      }

      const nowFloor = clamp(Math.floor(a.floor ?? floor), 0, floorCount - 1);
      const gx2 = Math.round(a.x);
      const gy2 = Math.round(a.y);
      if (nowFloor !== floor || gx2 !== cx || gy2 !== cy) {
        a.prevCell = { floor, cx, cy };
        a.stuckTime = 0;
        a.stuckEventLatched = false;
        if (nowFloor === floor) {
          const mdx = gx2 - cx;
          const mdy = gy2 - cy;
          const m = Math.hypot(mdx, mdy);
          if (m > 0.001) a.moveDir = { dx: mdx / m, dy: mdy / m };
        } else {
          a.moveDir = null;
        }
      } else {
        a.stuckTime = (a.stuckTime || 0) + dt;
        if (a.stuckTime >= 2 && !a.stuckEventLatched) {
          a.stuckCount = (a.stuckCount || 0) + 1;
          a.stuckEventLatched = true;
        }
      }
      if (inBounds(gx2, gy2)) {
        floorStates[nowFloor].heatmap[gy2][gx2] += 1;
      }

      const movedX = a.x - prevX;
      const movedY = a.y - prevY;
      const movedDist = Math.hypot(movedX, movedY);
      if (movedDist > 0.02) {
        const fx = Math.round(prevX);
        const fy = Math.round(prevY);
        if (inBounds(fx, fy) && floorStates[prevFloor]?.flowField?.[fy]?.[fx]) {
          const fref = floorStates[prevFloor].flowField[fy][fx];
          fref.vx += movedX;
          fref.vy += movedY;
          fref.n += 1;
        }
      }

      a.trailTick = (a.trailTick || 0) + dt;
      if (a.trail && (a.trailTick > 0.2 || movedDist > 0.4 || nowFloor !== prevFloor)) {
        a.trail.push({ floor: nowFloor, x: a.x, y: a.y, t: simTime });
        if (a.trail.length > 260) a.trail.shift();
        a.trailTick = 0;
      }

      if (inBounds(gx2, gy2)) {
        const smoke = smokeAt(nowFloor, gx2, gy2);
        const density = localDensity(nowFloor, gx2, gy2);
        if (smoke >= FALL_SMOKE_THRESHOLD) {
          const smokeFactor = Math.min(3.0, smoke / FALL_SMOKE_THRESHOLD);
          const p = FALL_RATE_PER_SEC * smokeFactor * (1 + density * 0.35) * (a.fallRiskMult || 1) * dt;
          if (Math.random() < p) {
            a.fallen = true;
            a.rescue = null;
            a.helpingId = null;
          }
        }
      }
    });

    if (simTime >= nextCongestionSampleAt) {
      let occupiedCells = 0;
      let occSum = 0;
      let maxOcc = 0;
      const floorOccupancy = {};
      for (let f = 0; f < floorCount; f++) {
        let floorTotal = 0;
        for (let y = 0; y < gridH; y++) {
          for (let x = 0; x < gridW; x++) {
            const o = occupancyDynamicByFloor[f][y][x];
            if (o > 0) {
              occupiedCells++;
              occSum += o;
              floorTotal += o;
              if (o > maxOcc) maxOcc = o;
            }
          }
        }
        floorOccupancy[f] = floorTotal;
      }
      const activeAgents = agents.filter(a => !a.dead && !a.finished).length;
      congestionHistory.push({
        time: simTime,
        avgDensity: occupiedCells ? (occSum / occupiedCells) : 0,
        maxOcc,
        active: activeAgents,
        floorOccupancy,
        stairCongestion: stairCongestion.map(item => ({ ...item }))
      });
      if (congestionHistory.length > 1200) congestionHistory.shift();
      nextCongestionSampleAt = simTime + 1.0;
    }

    hudTime.textContent = simTime.toFixed(1) + " s";
    hudEvac.textContent = `${evacCount} 避難 / ${deadCount} 死亡 / ${agents.length}`;

    const resolvedCount = evacCount + deadCount;
    if (resolvedCount === agents.length) {
      simRunning = false;
    syncPublicState();
      summarize();
      if (deadCount > 0) {
        setStatus("シミュレーション終了（死者あり）。");
        log("シミュレーション終了: 死者が発生しました。");
      } else {
        setStatus("シミュレーション終了（全員避難）。");
        log("シミュレーション終了: 全員が避難しました。");
      }
      syncPublicState();
    drawScene();
    }

    loadFloorState(currentFloor, false);

    maxHeatValue = 0;
    maxHeatCell = null;
    if (heatmap) {
      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (heatmap[y][x] > maxHeatValue) {
            maxHeatValue = heatmap[y][x];
            maxHeatCell = { x, y };
          }
        }
      }
    }
  }

  function analyzeBottlenecks(writeLog = false) {
    if (!heatmap || !grid) {
      log("ボトルネック分析: ヒートマップがありません。");
      bottleneckReport = [];
      return [];
    }
    const top = [];
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!grid[y][x].walkable) continue;
        const pass = heatmap[y][x] || 0;
        if (pass <= 0) continue;
        top.push({ cx: x, cy: y, passCount: pass });
      }
    }
    top.sort((a, b) => b.passCount - a.passCount);
    const avgSpeed = parseFloat(speedInput.value) || 1.2;
    const cellM = parseFloat(cellSizeMetersInput.value) || 0.5;
    const occPeak = congestionHistory.reduce((m, c) => Math.max(m, c.maxOcc || 0), 0);
    bottleneckReport = top.slice(0, 8).map(item => {
      const severity = Math.log10(item.passCount + 1);
      const crowdAmp = 1 + Math.max(0, occPeak - 1) * 0.18;
      const estimatedSavedSec = Math.min(
        45,
        severity * crowdAmp * (cellM / Math.max(0.25, avgSpeed)) * 12
      );
      return { ...item, estimatedSavedSec };
    });

    if (writeLog) {
      if (!bottleneckReport.length) {
        log(`ボトルネック分析: 該当なし / ${currentFloor + 1}F`);
      } else {
        log(`ボトルネック分析: 上位候補 / ${currentFloor + 1}F`);
        bottleneckReport.slice(0, 5).forEach((b, i) => {
          log(
            `${i + 1}. (${b.cx},${b.cy}) 通過数=${b.passCount}, ` +
            `改善見込み=${b.estimatedSavedSec.toFixed(2)}s`
          );
        });
      }
      if (congestionHistory.length) {
        const maxOcc = Math.max(...congestionHistory.map(c => c.maxOcc));
        const peak = congestionHistory.reduce((a, b) => (a.maxOcc >= b.maxOcc ? a : b));
        log(
          `混雑統計: サンプル=${congestionHistory.length}, ` +
          `ピーク時刻=${peak.time.toFixed(1)}s, 最大セル人数=${maxOcc}`
        );
      }
    }
    return bottleneckReport;
  }

  function optimizeExitPlacement() {
    syncActiveFloorState();
    if (!grid || !spawns.length) {
      alert("出口最適化には、マップと開始位置が必要です。");
      return;
    }
    if (!rebuildPotentialCache() || !combinedPotential) {
      alert("ポテンシャル場を計算できませんでした。");
      return;
    }
    const spawnCells = spawns.filter(p => p.cx >= 0 && p.cy >= 0 && p.cx < gridW && p.cy < gridH);
    if (!spawnCells.length) {
      alert("有効な開始位置がありません。");
      return;
    }
    const baseline = spawnCells.reduce((s, p) => {
      const v = combinedPotential[p.cy]?.[p.cx];
      return s + (isFinite(v) ? v : potentialLegendMax);
    }, 0) / spawnCells.length;

    const candidates = [];
    const step = Math.max(2, Math.round(Math.min(gridW, gridH) / 22));
    for (let y = 1; y < gridH - 1; y += step) {
      for (let x = 1; x < gridW - 1; x += step) {
        const onEdgeBand = (x < 5 || y < 5 || x > gridW - 6 || y > gridH - 6);
        if (!onEdgeBand) continue;
        if (!grid[y][x].walkable || grid[y][x].fire) continue;
        candidates.push({ cx: x, cy: y });
      }
    }
    if (!candidates.length) {
      log("出口最適化: 候補セルが見つかりません。");
      return;
    }

    const reverse = !!optimizeReverseInput.checked;
    let best = null;
    let bestScore = reverse ? -Infinity : Infinity;
    candidates.forEach(c => {
      const field = computePotentialFieldFromSeedsModule(
        exits.concat([c]),
        { grid, floorStates, floorCount, gridW, gridH, currentFloor, isAgentTraversableCell, getLinkedStairDestinations }
      );
      if (!field) return;
      let score = 0;
      for (let i = 0; i < spawnCells.length; i++) {
        const p = spawnCells[i];
        const dist = field[p.cy]?.[p.cx];
        if (!isFinite(dist)) {
          score += potentialLegendMax * 2;
        } else {
          score += dist;
        }
      }
      score /= spawnCells.length;
      if ((!reverse && score < bestScore) || (reverse && score > bestScore)) {
        bestScore = score;
        best = c;
      }
    });
    if (!best) {
      log("出口最適化: 改善候補を決定できませんでした。");
      return;
    }

    exits.push(best);
    syncActiveFloorState();
    allExitPoints = collectAllExits();
    syncPotentialExitIndexControl();
    rebuildPotentialCache();
    const baseSpeed = parseFloat(speedInput.value) || 1.2;
    const cellM = parseFloat(cellSizeMetersInput.value) || 0.5;
    const estimatedDeltaSec = (baseline - bestScore) * (cellM / Math.max(baseSpeed, 0.2));
    const deltaLabel = reverse ? "悪化見込み" : "改善見込み";
    log(
      `出口最適化: ${currentFloor + 1}F に出口を追加 (${best.cx},${best.cy}), ` +
      `${deltaLabel}=${estimatedDeltaSec.toFixed(2)}s`
    );
    setStatus("出口最適化を反映しました。");
    syncPublicState();
    drawScene();
  }

  function autoImproveSpawnPlacement() {
    syncActiveFloorState();
    if (!grid || !exits.length) {
      alert("開始位置の自動改善には、マップと出口が必要です。");
      return;
    }
    rebuildPotentialCache();
    const targetCount = Math.max(1, spawns.length || Math.ceil(parseNum(numAgentsInput, 80) / 30));
    const pool = [];
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!grid[y][x].walkable || grid[y][x].fire) continue;
        const p = combinedPotential?.[y]?.[x];
        if (!isFinite(p)) continue;
        const smoke = smokeMap?.[y]?.[x] || 0;
        pool.push({ cx: x, cy: y, score: p - smoke * 4 });
      }
    }
    const reverse = !!optimizeReverseInput.checked;
    pool.sort((a, b) => reverse ? (a.score - b.score) : (b.score - a.score));
    const chosen = [];
    const minDist = Math.max(4, Math.floor(Math.min(gridW, gridH) / 12));
    for (let i = 0; i < pool.length && chosen.length < targetCount; i++) {
      const c = pool[i];
      const near = chosen.some(s => Math.hypot(s.cx - c.cx, s.cy - c.cy) < minDist);
      if (!near) chosen.push({ cx: c.cx, cy: c.cy, r: 0 });
    }
    if (!chosen.length) {
      log("開始位置自動改善: 候補が見つかりませんでした。");
      return;
    }
    spawns = chosen;
    syncActiveFloorState();
    allSpawnPoints = collectAllSpawns();
    log(
      reverse
        ? `開始位置自動改善(逆): ${currentFloor + 1}F の開始位置を ${chosen.length} 点に更新しました。`
        : `開始位置自動改善: ${currentFloor + 1}F の開始位置を ${chosen.length} 点に更新しました。`
    );
    setStatus("開始位置の自動改善を反映しました。");
    syncPublicState();
    drawScene();
  }

  // ==== Summary Generation ====
  function summarize() {
    const evacuated = agents.filter((a) => a.finished && !a.dead);
    const dead = agents.filter((a) => a.dead);
    const times = evacuated
      .map((a) => a.finishTime - a.startTime)
      .filter((t) => Number.isFinite(t) && t >= 0);

    const avgT = times.length ? (times.reduce((x, y) => x + y, 0) / times.length) : 0;
    const maxT = times.length ? Math.max(...times) : 0;
    const agentMetrics = summarizeAgentMetrics(agents);
    const floorPeakOccupancy = {};
    congestionHistory.forEach(sample => {
      Object.entries(sample.floorOccupancy || {}).forEach(([floor, count]) => {
        floorPeakOccupancy[floor] = Math.max(floorPeakOccupancy[floor] || 0, Number(count) || 0);
      });
    });
    const stuckEvents = agents.reduce((sum, agent) => sum + Math.max(0, Number(agent.stuckCount) || 0), 0);
    const panicEscapeEvents = agents.reduce((sum, agent) => sum + Math.max(0, Number(agent.panicEscapeCount) || 0), 0);

    hudAvg.textContent = times.length ? `${avgT.toFixed(1)} s` : "--";
    hudMax.textContent = times.length ? `${maxT.toFixed(1)} s` : "--";

    log(`Summary: agents=${agents.length}, evacuated=${evacuated.length}, dead=${dead.length}, avg=${avgT.toFixed(2)}s, max=${maxT.toFixed(2)}s`);
    log(
      `Exposure: smoke=${agentMetrics.smokeExposure.toFixed(2)}, ` +
      `CO=${agentMetrics.coExposurePpmMin.toFixed(2)}ppm-min, heat=${agentMetrics.heatExposure.toFixed(2)}, ` +
      `stuck=${stuckEvents}, teacher_follow=${(agentMetrics.teacherFollowRate * 100).toFixed(1)}%, ` +
      `panic_escape=${panicEscapeEvents}`
    );

    lastSummary = {
      agents: agents.length,
      evacuated: evacuated.length,
      dead: dead.length,
      avgTime: avgT,
      maxTime: maxT,
      floorOccupancy: agentMetrics.floorOccupancy,
      floorPeakOccupancy,
      stairCongestion: stairCongestion.map(item => ({ ...item })),
      smokeExposure: agentMetrics.smokeExposure,
      coExposurePpmMin: agentMetrics.coExposurePpmMin,
      heatExposure: agentMetrics.heatExposure,
      stuckEvents,
      teacherFollowRate: agentMetrics.teacherFollowRate,
      panicEscapeEvents,
      activeFireCount,
      totalFireHrrKw,
      at: new Date().toISOString()
    };
    state.evaluation = {
      ...state.evaluation,
      floorOccupancy: agentMetrics.floorOccupancy,
      stairCongestion: Object.fromEntries(stairCongestion.map(item => [item.id, item])),
      stuckEvents,
      teacherFollowActiveSamples: agentMetrics.teacherFollowRate,
      panicEscapeEvents
    };
    state.sim.lastSummary = lastSummary;

    if (mcRunning) {
      const mcAvg = times.length ? avgT : simTime;
      const mcMax = times.length ? maxT : simTime;

      mcResults.push({ avg: mcAvg, max: mcMax });
      mcRuns++;

      if (mcRuns < mcTargetRuns) {
        resetSimulationCore();
        startSimulationCore();
      } else {
        mcRunning = false;
        const avgAll = mcResults.reduce((s, r) => s + r.avg, 0) / mcResults.length;
        const maxAll = Math.max(...mcResults.map((r) => r.max));
        log(`MC complete: avg=${avgAll.toFixed(2)}s, worst=${maxAll.toFixed(2)}s`);
        setStatus("Monte Carlo complete.");
      }
    }
  }

  function fireHeatForOverlay(floor, cx, cy) {
    let heat = 0;
    const fs = floorStates[floor];
    const fGrid = fs?.grid;
    if (!fGrid) return 0;
    const r = Math.ceil(FIRE_DANGER_RADIUS);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
        if (!fGrid[ny][nx].fire) continue;
        const d = Math.hypot(dx, dy);
        if (d <= FIRE_DANGER_RADIUS) heat += (FIRE_DANGER_RADIUS - d) / FIRE_DANGER_RADIUS;
      }
    }
    return heat;
  }

  function riskRecordForOverlay(floor, cx, cy) {
    const fds = getFdsRiskAt(floor, cx, cy, simTime);
    if (fds) return fds;
    const smoke = floorStates[floor]?.smokeMap?.[cy]?.[cx] || 0;
    const fireHeat = fireHeatForOverlay(floor, cx, cy);
    const hrrScale = Math.min(1, t2FireHrrKw(simTime) / Math.max(1, T2_FIRE_MAX_HRR_KW));
    const opticalDensityM1 = Math.max(0, smoke * 0.32);
    return {
      heatFluxKwM2: Math.max(0, fireHeat * 8.0 * (0.35 + 0.65 * hrrScale)),
      opticalDensityM1,
      coPpm: Math.max(0, smoke * 260 * (0.4 + 0.6 * hrrScale)),
      visibilityM: opticalDensityM1 > 0.001 ? Math.min(30, 3.0 / opticalDensityM1) : 30,
      source: 'overlay_fallback'
    };
  }

  function buildRiskOverlayGrid(mode) {
    if (!grid || !floorStates.length || !mode || mode === 'none') return null;
    const overlay = {
      mode,
      label: mode,
      unit: '',
      cells: new Array(gridH).fill(null).map(() => new Array(gridW).fill(null)),
      maxValue: 0,
      minValue: Infinity,
      source: importedFdsRisk.active ? 'fds_csv' : 'fallback_t2'
    };
    if (mode === 'heat_flux') { overlay.label = 'Heat Flux'; overlay.unit = 'kW/m²'; }
    else if (mode === 'optical_density') { overlay.label = 'Optical Density'; overlay.unit = '1/m'; }
    else if (mode === 'co') { overlay.label = 'CO'; overlay.unit = 'ppm'; }
    else if (mode === 'visibility') { overlay.label = 'Visibility risk'; overlay.unit = 'm'; }
    else { overlay.label = 'Total fire risk'; overlay.unit = 'risk'; }

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!grid[y][x].walkable && !grid[y][x].fire && !grid[y][x].stair) continue;
        const rec = riskRecordForOverlay(currentFloor, x, y);
        const hf = Math.max(0, rec.heatFluxKwM2 || 0);
        const od = Math.max(0, rec.opticalDensityM1 || 0);
        const co = Math.max(0, rec.coPpm || 0);
        const vis = Number.isFinite(rec.visibilityM) ? Math.max(0, rec.visibilityM) : 30;
        let value = 0;
        let norm = 0;
        if (mode === 'heat_flux') {
          value = hf;
          norm = clamp(hf / FDS_HEAT_FLUX_HARD_KW_M2, 0, 1);
        } else if (mode === 'optical_density') {
          value = od;
          norm = clamp(od / FDS_OPTICAL_DENSITY_HARD, 0, 1);
        } else if (mode === 'co') {
          value = co;
          norm = clamp(co / FDS_CO_HARD_PPM, 0, 1);
        } else if (mode === 'visibility') {
          value = vis;
          norm = clamp(1 - (vis / 10), 0, 1);
        } else {
          const heatNorm = clamp(hf / FDS_HEAT_FLUX_HARD_KW_M2, 0, 1);
          const odNorm = clamp(od / FDS_OPTICAL_DENSITY_HARD, 0, 1);
          const coNorm = clamp(co / FDS_CO_HARD_PPM, 0, 1);
          const visNorm = clamp(1 - (vis / 10), 0, 1);
          norm = clamp(Math.max(heatNorm, odNorm, coNorm, visNorm) * 0.7 + ((heatNorm + odNorm + coNorm + visNorm) / 4) * 0.3, 0, 1);
          value = norm;
        }
        if (norm <= 0.001) continue;
        overlay.cells[y][x] = { value, norm };
        overlay.maxValue = Math.max(overlay.maxValue, value);
        overlay.minValue = Math.min(overlay.minValue, value);
      }
    }
    if (!Number.isFinite(overlay.minValue)) overlay.minValue = 0;
    return overlay;
  }

  // ==== Rendering ====
  const renderer = createRenderer({
    ctx,
    cvs,
    cellSizePx: CELL_SIZE_PX,
    typeMeta: TYPE_META,
    clamp
  });

  function drawScene() {
    const layout = worldLayout();
    const scene = {
      layout,
      baseImage,
      grid,
      gridW,
      gridH,
      floorCount,
      currentFloor,
      stairLinks,
      pendingStairLink,
      potentialByExit,
      combinedPotential,
      potentialLegendMax,
      allExitPoints,
      exits,
      spawns,
      smokeMap,
      agents,
      flowField,
      simRunning,
      simTime,
      maxHeatCell,
      maxHeatValue,
      vizTrails: !!vizTrailsInput.checked,
      vizFlow: !!vizFlowInput.checked,
      vizPotential: !!vizPotentialInput.checked,
      potentialViewMode: potentialViewModeInput.value,
      potentialExitIndex: Math.max(1, Math.floor(parseNum(potentialExitIndexInput, 1))),
      riskOverlayMode: riskViewModeInput?.value || "none",
      riskOverlay: buildRiskOverlayGrid(riskViewModeInput?.value || "none"),
      fdsStats: importedFdsRisk.stats
    };
    state.render.lastScene = scene;
    renderer.render(scene);
  }

  // ==== Initialization ====
  runtimeControls.start = startSimulationCore;
  runtimeControls.stop = stopSimulationCore;
  runtimeControls.reset = resetSimulationCore;

  bindCoreControls({
    onStart: () => startSimulationCore(),
    onStop: () => stopSimulationCore(),
    onReset: () => {
      resetSimulationCore();
      log("Simulation reset.");
      setStatus("Simulation reset.");
    },
    onModeChange: (nextMode) => setMode(nextMode)
  });

  applyAgentPreset(agentPresetInput.value);
  refreshPresetOptions();
  floorCount = 1;
  if (floorCountInput) floorCountInput.value = "1";
  refreshFloorSelector();
  updateFloorLabel();
  syncPotentialExitIndexControl();
  setMode("spawn");
  resizeCanvas();
  setStatus("Load a map, place spawn/exit/fire points, then start simulation.");
}








