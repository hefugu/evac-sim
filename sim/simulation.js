  // ==== Basic Setup ====
  const cvs = document.getElementById("simCanvas");
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
    drawScene();
  }
  window.addEventListener("resize", resizeCanvas);

  // ==== UI References ====
  const mapFileInput = document.getElementById("mapFile");
  const thrRange = document.getElementById("thrRange");
  const numAgentsInput = document.getElementById("numAgents");
  const speedInput = document.getElementById("speed");
  const speedVarInput = document.getElementById("speedVar");
  const cellSizeMetersInput = document.getElementById("cellSizeMeters");
  const startRuleInput = document.getElementById("startRule");
  const floorCountInput = document.getElementById("floorCount");
  const currentFloorSelect = document.getElementById("currentFloor");
  const btnApplyFloors = document.getElementById("btnApplyFloors");
  const osmCenterInput = document.getElementById("osmCenter");
  const osmZoomInput = document.getElementById("osmZoom");
  const btnLoadOSM = document.getElementById("btnLoadOSM");

  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnReset = document.getElementById("btnReset");
  const btnClearMap = document.getElementById("btnClearMap");
  const btnMonte = document.getElementById("btnMonte");
  const btnAnalyze = document.getElementById("btnAnalyze");
  const btnOptimizeExit = document.getElementById("btnOptimizeExit");
  const btnAutoImprove = document.getElementById("btnAutoImprove");
  const btnSavePreset = document.getElementById("btnSavePreset");
  const btnLoadPreset = document.getElementById("btnLoadPreset");
  const btnExportCsv = document.getElementById("btnExportCsv");
  const btnParamHistory = document.getElementById("btnParamHistory");
  const optimizeReverseInput = document.getElementById("optimizeReverse");

  const logEl = document.getElementById("log");
  const statusBar = document.getElementById("statusBar");
  const floorLabel = document.getElementById("floorLabel");
  const presetNameInput = document.getElementById("presetName");
  const presetSelect = document.getElementById("presetSelect");

  const vizTrailsInput = document.getElementById("vizTrails");
  const vizFlowInput = document.getElementById("vizFlow");
  const vizPotentialInput = document.getElementById("vizPotential");
  const potentialViewModeInput = document.getElementById("potentialViewMode");
  const potentialExitIndexInput = document.getElementById("potentialExitIndex");

  const agentPresetInput = document.getElementById("agentPreset");
  const ratioChildInput = document.getElementById("ratioChild");
  const ratioElderlyInput = document.getElementById("ratioElderly");
  const ratioPanicInput = document.getElementById("ratioPanic");
  const ratioLeaderInput = document.getElementById("ratioLeader");
  const ratioTeacherInput = document.getElementById("ratioTeacher");
  const ratioStudentInput = document.getElementById("ratioStudent");

  const modeButtons = {
    spawn: document.getElementById("modeSpawn"),
    exit: document.getElementById("modeExit"),
    stair: document.getElementById("modeStair"),
    stairLink: document.getElementById("modeStairLink"),
    fire: document.getElementById("modeFire"),
    erase: document.getElementById("modeErase")
  };
  const modeLabelMap = {
    spawn: "開始位置",
    exit: "出口",
    stair: "階段",
    stairLink: "階段リンク",
    fire: "火元",
    erase: "消去"
  };

  const hudTime = document.getElementById("hudTime");
  const hudEvac = document.getElementById("hudEvac");
  const hudAvg = document.getElementById("hudAvg");
  const hudMax = document.getElementById("hudMax");

  // ==== Map / Grid ====
  let baseImage = null;
  let grid = null;        // {walkable:boolean, fire:boolean}
  let gridW = 0, gridH = 0;
  const CELL_SIZE_PX = 4; // Downscale factor: image pixels -> sim cells
  let baseWalkableTemplate = null;
  let floorStates = [];
  let floorCount = 1;
  let currentFloor = 0;
  const SINGLE_FLOOR_MODE = true;
  let stairLinks = [];      // [{a:{floor,cx,cy}, b:{floor,cx,cy}}]
  let stairLinkIndex = new Map(); // key -> [{floor,cx,cy}]
  let pendingStairLink = null;    // {floor,cx,cy}
  let allExitPoints = [];   // {floor,cx,cy}
  let allSpawnPoints = [];  // {floor,cx,cy}
  let multiPotentialByExit = []; // [exit][floor][y][x]
  let multiCombinedPotential = null; // [floor][y][x]

  let exits = [];         // {cx,cy}
  let spawns = [];        // {cx,cy,r}
  let mode = "spawn";

  // ==== Simulation State ====
  let agents = [];        // {x,y,cx,cy,v,finished,startTime,finishTime}
  let simRunning = false;
  let simTime = 0;
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
  const PRESET_STORAGE_KEY = "evac_presets_v1";

  let smokeMap = null; 
  let smokeCeil = null; 
  const FAR_FIRST_MAX_DELAY_SEC = 8.0;
  const MAX_OCCUPANCY_PER_CELL = 2;
  const DENSITY_RADIUS = 1;
  const DENSITY_SPEED_COEF = 0.85;
  const POTENTIAL_GAIN_WEIGHT = 2.8;
  const CONGESTION_PENALTY_WEIGHT = 1.3;
  const HEATMAP_PENALTY_WEIGHT = 0.03;
  const SMOKE_AVOID_WEIGHT = 1.1;
  const FIRE_AVOID_WEIGHT = 2.5;
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
    adult:   { label: "大人",   speed: 1.00, fallRisk: 1.00, panic: 0.00, color: "#ff3366" },
    child:   { label: "子供",   speed: 0.74, fallRisk: 1.10, panic: 0.05, color: "#8ad8ff" },
    elderly: { label: "高齢者", speed: 0.62, fallRisk: 1.85, panic: 0.03, color: "#ffd26b" },
    panic:   { label: "パニック", speed: 1.10, fallRisk: 1.35, panic: 0.30, color: "#ff66aa" },
    leader:  { label: "リーダー", speed: 1.02, fallRisk: 0.90, panic: 0.02, color: "#66ffcc" },
    teacher: { label: "教師", speed: 0.96, fallRisk: 0.92, panic: 0.01, color: "#66ccff" },
    student: { label: "生徒", speed: 0.72, fallRisk: 1.20, panic: 0.04, color: "#7bb8ff" }
  };

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
      setStatus("階段リンク選択をキャンセルしました。");
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

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function parseNum(input, fallback = 0) {
    const n = Number(input?.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function cloneWalkableTemplate(template) {
    if (!Array.isArray(template)) return null;
    return template.map(row => Array.isArray(row) ? row.map(v => !!v) : []);
  }

  function stairEndpointKey(floor, cx, cy) {
    return `${floor}:${cx}:${cy}`;
  }

  function normalizeStairLinkEndpoints(a, b) {
    const ka = stairEndpointKey(a.floor, a.cx, a.cy);
    const kb = stairEndpointKey(b.floor, b.cx, b.cy);
    return (ka <= kb)
      ? [{ floor: a.floor, cx: a.cx, cy: a.cy }, { floor: b.floor, cx: b.cx, cy: b.cy }]
      : [{ floor: b.floor, cx: b.cx, cy: b.cy }, { floor: a.floor, cx: a.cx, cy: a.cy }];
  }

  function stairLinkHash(a, b) {
    const [na, nb] = normalizeStairLinkEndpoints(a, b);
    return `${stairEndpointKey(na.floor, na.cx, na.cy)}|${stairEndpointKey(nb.floor, nb.cx, nb.cy)}`;
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
      stairLinkIndex.get(ka).push({ floor: b.floor, cx: b.cx, cy: b.cy });
      stairLinkIndex.get(kb).push({ floor: a.floor, cx: a.cx, cy: a.cy });
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
      next.push({ a: na, b: nb });
    }
    stairLinks = next;
    rebuildStairLinkIndex();
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
      setStatus("同じ地点同士はリンクできません。");
      return false;
    }
    if (aa.floor === bb.floor) {
      setStatus("階段リンクは別フロア同士を接続してください。");
      return false;
    }
    if (!isStairEndpointUsable(aa) || !isStairEndpointUsable(bb)) {
      setStatus("リンク先は階段セル（通行可能・非火元）にしてください。");
      return false;
    }
    const h = stairLinkHash(aa, bb);
    const dup = stairLinks.some(link => stairLinkHash(link.a, link.b) === h);
    if (dup) {
      setStatus("その階段リンクは既に設定済みです。");
      return false;
    }
    const [na, nb] = normalizeStairLinkEndpoints(aa, bb);
    stairLinks.push({ a: na, b: nb });
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

  function cloneGridFromTemplate(template) {
    const out = new Array(gridH);
    for (let y = 0; y < gridH; y++) {
      out[y] = new Array(gridW);
      for (let x = 0; x < gridW; x++) {
        out[y][x] = {
          walkable: !!template?.[y]?.[x],
          fire: false,
          stair: false
        };
      }
    }
    return out;
  }

  function createFloorState(seedTemplate = null, seedImage = null) {
    const tpl = cloneWalkableTemplate(seedTemplate);
    return {
      baseImage: seedImage || null,
      walkableTemplate: tpl,
      grid: cloneGridFromTemplate(tpl),
      exits: [],
      spawns: [],
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
    floorStates[currentFloor].baseImage = baseImage;
    floorStates[currentFloor].walkableTemplate = cloneWalkableTemplate(baseWalkableTemplate);
    floorStates[currentFloor].grid = grid;
    floorStates[currentFloor].exits = exits;
    floorStates[currentFloor].spawns = spawns;
    floorStates[currentFloor].heatmap = heatmap;
    floorStates[currentFloor].smokeMap = smokeMap;
    floorStates[currentFloor].smokeCeil = smokeCeil;
    floorStates[currentFloor].flowField = flowField;
    floorStates[currentFloor].potentialByExit = potentialByExit;
    floorStates[currentFloor].combinedPotential = combinedPotential;
    floorStates[currentFloor].potentialLegendMax = potentialLegendMax;
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
    syncPotentialExitIndexControl();
    updateFloorLabel();
    if (redraw) drawScene();
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
    floorLabel.textContent = `表示フロア: ${floorText}${baseImage ? "" : "（マップ未設定）"}`;
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
      if (preserve && i < prevCount && prevStates[i]) next.push(prevStates[i]);
      else next.push(createFloorState(null, null));
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

  function loadPresetStore() {
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch {
      return {};
    }
  }

  function savePresetStore(store) {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(store));
  }

  function refreshPresetOptions() {
    const store = loadPresetStore();
    const names = Object.keys(store).sort();
    presetSelect.innerHTML = "";
    if (names.length === 0) {
      const op = document.createElement("option");
      op.value = "";
      op.textContent = "保存済みなし";
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
    const store = loadPresetStore();
    store[name] = currentSettingsSnapshot();
    savePresetStore(store);
    refreshPresetOptions();
    presetSelect.value = name;
    log(`プリセット保存: ${name}`);
  }

  function loadSelectedPreset() {
    const name = presetSelect.value;
    if (!name) return;
    const store = loadPresetStore();
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
      if (ok) resetSim(true);
    }
    log(`プリセット読込: ${name}`);
  }

  function pushParamHistory() {
    const entry = {
      at: new Date().toISOString(),
      ...currentSettingsSnapshot()
    };
    paramHistory.unshift(entry);
    if (paramHistory.length > 120) paramHistory.length = 120;
  }

  function showParamHistory() {
    if (!paramHistory.length) {
      log("パラメータ履歴: まだ記録がありません。");
      return;
    }
    log("パラメータ履歴（新しい順）");
    paramHistory.slice(0, 8).forEach((h, i) => {
      log(
        `${i + 1}. ${h.at.slice(0, 19).replace("T", " ")} / ` +
        `階数=${h.floorCount ?? floorCount}, 人数=${h.numAgents}, 速度=${h.speed}, ばらつき=${h.speedVar}%, ルール=${h.startRule}, 構成=${h.agentPreset}, 逆最適化=${h.optimizeReverse ? "ON" : "OFF"}`
      );
    });
  }

  function csvEscape(v) {
    const s = (v ?? "").toString();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadCsv() {
    if (!lastSummary) {
      alert("先にシミュレーションを実行してください。");
      return;
    }
    const lines = [];
    lines.push("section,key,value");
    lines.push(`summary,agents,${lastSummary.agents}`);
    lines.push(`summary,evacuated,${lastSummary.evacuated}`);
    lines.push(`summary,dead,${lastSummary.dead}`);
    lines.push(`summary,avg_time_s,${lastSummary.avgTime.toFixed(3)}`);
    lines.push(`summary,max_time_s,${lastSummary.maxTime.toFixed(3)}`);
    lines.push("");
    lines.push("section,time_s,avg_density,max_occ,active_agents");
    congestionHistory.forEach(r => {
      lines.push(`congestion,${r.time.toFixed(2)},${r.avgDensity.toFixed(4)},${r.maxOcc},${r.active}`);
    });
    lines.push("");
    lines.push("section,floor,rank,cx,cy,pass_count,est_saved_s");
    bottleneckReport.forEach((b, i) => {
      lines.push(`bottleneck,${currentFloor + 1},${i + 1},${b.cx},${b.cy},${b.passCount},${b.estimatedSavedSec.toFixed(2)}`);
    });
    lines.push("");
    lines.push("section,id,type,floor,target_exit,target_exit_floor,start_s,finish_s,dead,death_cause");
    agents.forEach(a => {
      const exit = allExitPoints[a.targetExitIndex] || null;
      lines.push(
        [
          "agent",
          a.id,
          csvEscape(TYPE_META[a.type]?.label || a.type || "大人"),
          (a.floor ?? 0) + 1,
          a.targetExitIndex ?? "",
          exit ? (exit.floor + 1) : "",
          Number.isFinite(a.startTime) ? a.startTime.toFixed(3) : "",
          Number.isFinite(a.finishTime) ? a.finishTime.toFixed(3) : "",
          a.dead ? 1 : 0,
          a.deathCause || ""
        ].join(",")
      );
    });
    lines.push("");
    lines.push("section,at,floor_count,current_floor,num_agents,speed,speed_var,start_rule,preset,optimize_reverse");
    paramHistory.forEach(h => {
      lines.push(
        [
          "params",
          csvEscape(h.at),
          h.floorCount ?? "",
          (Number.isFinite(h.currentFloor) ? (h.currentFloor + 1) : ""),
          h.numAgents,
          h.speed,
          h.speedVar,
          csvEscape(h.startRule),
          csvEscape(h.agentPreset),
          h.optimizeReverse ? 1 : 0
        ].join(",")
      );
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `evac_report_${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log("CSVを出力しました。");
  }

  // ==== Map Loading and Grid Build ====
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("failed_to_read_file"));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("failed_to_decode_image"));
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    });
  }

  mapFileInput.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    syncActiveFloorState();
    const targetFloor = 0;
    try {
      const img = await loadImageFromFile(file);
      // Show immediate preview even before grid extraction succeeds.
      baseImage = img;
      drawScene();
      const ok = applyImageToFloorMap(img, targetFloor, {
        initializeAllFloors: false,
        clearMarkers: true
      });
      if (!ok) return;
      resetSim(true);
      log(`マップ割当: ${targetFloor + 1}F <- ${file.name} (${img.width}x${img.height}px)`);
      setStatus(`${targetFloor + 1}F にマップを割り当てました。`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      alert(`画像の読み込みに失敗しました: ${file.name}\n理由: ${reason}`);
    } finally {
      mapFileInput.value = "";
    }
  });

  function loadImageFromUrl(url, title = "外部マップ") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const ok = applyImageToFloorMap(img, currentFloor, {
          initializeAllFloors: false,
          clearMarkers: true
        });
        if (!ok) return;
        resetSim(true);
        log(`${title}読込: ${currentFloor + 1}F (${img.width}x${img.height}px)`);
      } catch (err) {
        alert("画像のピクセル取得に失敗しました。CORS制限の可能性があります。");
      }
    };
    img.onerror = () => {
      alert("画像の読み込みに失敗しました。");
    };
    img.src = url;
  }

  function loadOSMMap() {
    const center = (osmCenterInput.value || "").trim();
    const zoom = clamp(Math.round(parseNum(osmZoomInput, 17)), 10, 19);
    osmZoomInput.value = zoom;
    if (!/^[-+]?[\d.]+\s*,\s*[-+]?[\d.]+$/.test(center)) {
      alert("OSM中心点は「緯度,経度」で入力してください。例: 35.681236,139.767125");
      return;
    }
    const [lat, lon] = center.split(",").map(v => Number(v.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert("緯度経度の形式が正しくありません。");
      return;
    }
    const url =
      "https://staticmap.openstreetmap.de/staticmap.php?" +
      `center=${encodeURIComponent(lat + "," + lon)}&zoom=${zoom}&size=1024x1024&maptype=mapnik`;
    loadImageFromUrl(url, "OSM");
  }

  btnLoadOSM.addEventListener("click", loadOSMMap);

  thrRange.addEventListener("input", () => {
    if (!baseImage) return;
    const ok = applyImageToFloorMap(baseImage, currentFloor, {
      initializeAllFloors: false,
      clearMarkers: true
    });
    if (!ok) return;
    resetSim(true);
  });

  function extractWalkableTemplateFromImage(image) {
    if (!image) return null;
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
      alert("画像のピクセル解析に失敗しました（外部画像のCORS制限）。");
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
    return { template, w, h };
  }

  function clearFloorMarkersAndFields(fs, template) {
    fs.walkableTemplate = cloneWalkableTemplate(template);
    fs.grid = cloneGridFromTemplate(fs.walkableTemplate);
    fs.exits = [];
    fs.spawns = [];
    fs.heatmap = makeScalarGrid(0);
    fs.smokeMap = makeScalarGrid(0);
    fs.smokeCeil = makeScalarGrid(false);
    fs.flowField = makeFlowGrid();
    fs.potentialByExit = [];
    fs.combinedPotential = null;
    fs.potentialLegendMax = 1;
  }

  function applyImageToFloorMap(image, floorIndex, options = {}) {
    const { clearMarkers = true } = options;
    if (!image) return false;
    const parsed = extractWalkableTemplateFromImage(image);
    if (!parsed) return false;
    const { template, w, h } = parsed;

    if (!SINGLE_FLOOR_MODE && gridW > 0 && gridH > 0 && (w !== gridW || h !== gridH)) {
      alert(`マップサイズが一致しません。現在は ${gridW}x${gridH} セルです。`);
      return false;
    }
    gridW = w;
    gridH = h;
    floorCount = 1;
    currentFloor = 0;
    if (floorCountInput) floorCountInput.value = "1";

    const fs = floorStates[0] || createFloorState(template, image);
    fs.baseImage = image;
    fs.walkableTemplate = cloneWalkableTemplate(template);
    if (clearMarkers || !fs.grid || !fs.grid.length) {
      clearFloorMarkersAndFields(fs, template);
    }
    floorStates = [fs];
    stairLinks = [];
    stairLinkIndex = new Map();
    pendingStairLink = null;

    baseImage = image;
    baseWalkableTemplate = cloneWalkableTemplate(template);

    sanitizeStairLinks();
    refreshFloorSelector();
    loadFloorState(0, false);
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    rebuildPotentialCache();
    congestionHistory = [];
    bottleneckReport = [];
    lastSummary = null;
    drawScene();
    setStatus("グリッド準備完了。開始位置 / 出口 / 火元を設定してください。");
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
        setStatus("開始位置は通行可能かつ非火元セルに配置してください。");
        return;
      }
      spawns.push({ cx, cy, r: 0 }); // r reserved for future use
      log(`開始位置を追加: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "exit") {
      if (!cellObj.walkable || cellObj.fire) {
        setStatus("出口は通行可能かつ非火元セルに配置してください。");
        return;
      }
      exits.push({ cx, cy });
      log(`出口を追加: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "stair") {
      if (cellObj.fire) {
        setStatus("火元セルには階段を設定できません。");
        return;
      }
      const toggled = !cellObj.stair;
      cellObj.stair = toggled;
      cellObj.walkable = true;
      if (!toggled) removeStairLinksByCell(currentFloor, cx, cy);
      log(`${toggled ? "階段を設定" : "階段を解除"}: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "stairLink") {
      if (!cellObj.stair || !cellObj.walkable || cellObj.fire) {
        setStatus("階段リンクは階段セル（通行可能・非火元）を選択してください。");
        return;
      }
      const endpoint = { floor: currentFloor, cx, cy };
      if (!pendingStairLink) {
        pendingStairLink = endpoint;
        setStatus(`階段リンクの1点目を選択: ${currentFloor + 1}F (${cx},${cy})。接続先をクリックしてください。`);
      } else {
        const same =
          pendingStairLink.floor === endpoint.floor &&
          pendingStairLink.cx === endpoint.cx &&
          pendingStairLink.cy === endpoint.cy;
        if (same) {
          pendingStairLink = null;
          setStatus("階段リンク選択をキャンセルしました。");
        } else {
          const from = pendingStairLink;
          pendingStairLink = null;
          if (addStairLink(from, endpoint)) {
            log(
              `階段リンクを設定: ${from.floor + 1}F(${from.cx},${from.cy}) <-> ` +
              `${endpoint.floor + 1}F(${endpoint.cx},${endpoint.cy})`
            );
            setStatus("階段リンクを追加しました。");
          }
        }
      }
    } else if (mode === "fire") {
      cellObj.fire = true;
      cellObj.stair = false;
      cellObj.walkable = false;
      removeStairLinksByCell(currentFloor, cx, cy);
      log(`火元を設定: ${currentFloor + 1}F (${cx},${cy})`);
    } else if (mode === "erase") {
      // Remove spawn/exit/fire markers at this cell
      spawns = spawns.filter(p => !(p.cx === cx && p.cy === cy));
      exits = exits.filter(p => !(p.cx === cx && p.cy === cy));
      cellObj.fire = false;
      cellObj.stair = false;
      removeStairLinksByCell(currentFloor, cx, cy);
      // Keep as walkable until map is rebuilt
      cellObj.walkable = !!baseWalkableTemplate?.[cy]?.[cx];
      if (smokeMap) smokeMap[cy][cx] = 0;
      log(`マーカーを削除: ${currentFloor + 1}F (${cx},${cy})`);
    }

    sanitizeStairLinks();
    syncActiveFloorState();
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    if (allExitPoints.length > 0) rebuildPotentialCache();
    drawScene();
  });

  // ==== Potential Field Calculation ====
  function computePotentialFieldFromSeeds(seeds) {
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
        const newPot = base + d.c;
        if (newPot < potential[floor][ny][nx]) {
          potential[floor][ny][nx] = newPot;
          q.push({ floor, cx: nx, cy: ny });
        }
      }
      if (floorGrid[cy][cx].stair) {
        const stairsTo = [floor - 1, floor + 1];
        for (let i = 0; i < stairsTo.length; i++) {
          const nf = stairsTo[i];
          if (nf < 0 || nf >= floorCount) continue;
          const nc = floorStates[nf]?.grid?.[cy]?.[cx];
          if (!isAgentTraversableCell(nf, cx, cy)) continue;
          if (!nc?.stair) continue;
          const newPot = base + 1.0;
          if (newPot < potential[nf][cy][cx]) {
            potential[nf][cy][cx] = newPot;
            q.push({ floor: nf, cx, cy });
          }
        }
        const linked = getLinkedStairDestinations(floor, cx, cy);
        for (let i = 0; i < linked.length; i++) {
          const dst = linked[i];
          if (!isAgentTraversableCell(dst.floor, dst.cx, dst.cy)) continue;
          const nd = floorStates[dst.floor]?.grid?.[dst.cy]?.[dst.cx];
          if (!nd?.stair) continue;
          const newPot = base + 1.0;
          if (newPot < potential[dst.floor][dst.cy][dst.cx]) {
            potential[dst.floor][dst.cy][dst.cx] = newPot;
            q.push({ floor: dst.floor, cx: dst.cx, cy: dst.cy });
          }
        }
      }
    }
    return potential;
  }

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
      computePotentialFieldFromSeeds([{ floor: ex.floor, cx: ex.cx, cy: ex.cy }])
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
    // 要件: 基本は最短出口を選ぶ（混雑・煙は出口選択に使わない）
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
      alert("先にマップを読み込んでください。");
      return false;
    }
    syncActiveFloorState();
    allSpawnPoints = collectAllSpawns();
    allExitPoints = collectAllExits();
    if (allSpawnPoints.length === 0 || allExitPoints.length === 0) {
      alert("開始位置と出口（全フロア合計）が必要です。");
      return false;
    }
    const n = Math.max(1, Math.floor(parseInt(numAgentsInput.value, 10) || 1));
    const baseSpeed = parseFloat(speedInput.value) || 1.0;
    const varPct = Math.max(0, Math.min(100, parseFloat(speedVarInput.value) || 0));
    const cellMeters = parseFloat(cellSizeMetersInput.value) || 0.5;
    const typeRatios = getTypeRatios();
    if (!rebuildPotentialCache()) {
      alert("出口まで到達可能な経路がありません。");
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
      alert("通行可能セルが見つかりません。");
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
        visibility: 1,
        potential0: startPot,
        evacDelay: 0,
        fallen: false,
        rescue: null,
        helpingId: null,
        recoveredUntil: 0,
        type,
        panicFactor: meta.panic || 0,
        fallRiskMult: meta.fallRisk || 1,
        targetExitIndex: exitChoice.idx,
        potentialField: exitChoice.field,
        prevCell: null,
        moveDir: null,
        stuckTime: 0,
        leaderId: null,
        trail: [{ floor: chosen.floor, x: chosen.cx, y: chosen.cy, t: 0 }],
        trailTick: 0
      });
    }
    if (!agents.length) {
      alert("エージェントを有効な場所に配置できませんでした。");
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
    const startRuleLabel = startRule === "far_first" ? "遠方優先" : "一斉開始";
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
      `エージェント生成: ${agents.length}人, 基準速度=${baseSpeed}m/s, ` +
      `速度ばらつき=${varPct}%, 開始ルール=${startRuleLabel}, 種別=[${typeSummary}], フロア構成=[${floorSummary}]`
    );
    return true;
  }

  // ==== Simulation Control ====
  function resetSim() {
    //simstop
    simRunning = false;
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

    //HUDreset
    hudTime.textContent = "0.0 s";
    hudEvac.textContent = "0 避難 / 0 死亡 / 0";
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

    drawScene();
  }

  btnReset.addEventListener("click", () => {
    resetSim(false);
    log("シミュレーションをリセットしました。");
    setStatus("リセット完了。");
  });

  btnClearMap.addEventListener("click", () => {
    spawns = [];
    exits = [];
    if (grid) {
      for (let y=0;y<gridH;y++)for(let x=0;x<gridW;x++){
        grid[y][x].fire = false;
        grid[y][x].stair = false;
        grid[y][x].walkable = !!baseWalkableTemplate?.[y]?.[x];
      }
    }
    removeStairLinksByFloor(currentFloor);
    sanitizeStairLinks();
    syncActiveFloorState();
    allExitPoints = collectAllExits();
    allSpawnPoints = collectAllSpawns();
    syncPotentialExitIndexControl();
    rebuildPotentialCache();
    log(`開始位置 / 出口 / 階段 / 火元マーカーをクリアしました: ${currentFloor + 1}F`);
    drawScene();
  });

  btnMonte.addEventListener("click", () => {

  if (!gridW || !gridH || !floorStates.length || !floorStates.some(fs => !!fs?.baseImage)) {
    alert("先にマップを読み込んでください。");
    return;
  }

  mcRunning = true;
  mcRuns = 0;
  mcResults = [];

  log("MC開始: " + mcTargetRuns + " 回");

  startSimulation();

});

  btnApplyFloors.addEventListener("click", () => {
    if (!gridW || !gridH || !floorStates.length || !floorStates.some(fs => !!fs?.baseImage)) {
      alert("先にマップを読み込んでください。");
      return;
    }
    syncActiveFloorState();
    applyFloorSetup(true);
    log(`フロア設定反映: ${floorCount}フロア`);
    setStatus(`フロア数を ${floorCount} に設定しました。`);
  });
  currentFloorSelect.addEventListener("change", () => {
    const target = SINGLE_FLOOR_MODE ? 0 : clamp(Math.floor(parseNum(currentFloorSelect, currentFloor)), 0, floorCount - 1);
    syncActiveFloorState();
    if (!floorStates[target]) {
      currentFloor = target;
      updateFloorLabel();
      drawScene();
    } else {
      loadFloorState(target);
    }
    if (mode === "stairLink" && pendingStairLink) {
      setStatus(
        `表示フロアを ${target + 1}F に切り替えました。` +
        `接続先として階段セルをクリックしてください。`
      );
    } else {
      setStatus(`表示フロアを ${target + 1}F に切り替えました。`);
    }
  });
  floorCountInput.addEventListener("change", () => {
    floorCountInput.value = "1";
  });

  agentPresetInput.addEventListener("change", () => {
    applyAgentPreset(agentPresetInput.value);
  });
  [vizTrailsInput, vizFlowInput, vizPotentialInput, potentialViewModeInput, potentialExitIndexInput]
    .forEach(el => el.addEventListener("change", drawScene));

  btnSavePreset.addEventListener("click", saveCurrentPreset);
  btnLoadPreset.addEventListener("click", loadSelectedPreset);
  btnExportCsv.addEventListener("click", downloadCsv);
  btnParamHistory.addEventListener("click", showParamHistory);
  btnAnalyze.addEventListener("click", () => analyzeBottlenecks(true));
  btnOptimizeExit.addEventListener("click", optimizeExitPlacement);
  btnAutoImprove.addEventListener("click", autoImproveSpawnPlacement);

 btnStart.addEventListener("click", () => {
  startSimulation();
  });

  function startSimulation() {
    
    if (!gridW || !gridH || !floorStates.length || !floorStates.some(fs => !!fs?.baseImage)) {
      alert("先にマップを読み込んでください。");
      return false;
    }
    if (!mcRunning || mcRuns === 0) {
      pushParamHistory();
    }
    if (!spawnAgents()) return false;
    simRunning = true;
    simTime = 0;
    lastFrameTime = performance.now();
    btnStart.disabled = true;
    btnStart.classList.remove("pulse");
    const startRuleLabel = (startRuleInput?.value === "far_first") ? "遠方優先" : "一斉開始";
    setStatus(`シミュレーション実行中。開始ルール: ${startRuleLabel}`);
    requestAnimationFrame(loop);

    return true;
  };

  btnStop.addEventListener("click", () => {

  if (!simRunning) return;

  simRunning = false;

  summarize();

  setStatus("シミュレーションを停止しました。");
  log("シミュレーションを手動停止しました。");

});
  // ==== Main Loop ====
  function loop(now) {
    if (!simRunning) return;
    if (!lastFrameTime) lastFrameTime = now;
    const dt = (now - lastFrameTime) / 1000; // sec
    lastFrameTime = now;
    simTime += dt;

    stepSimulation(dt);
    drawScene();
    requestAnimationFrame(loop);
  }

  function stepSimulation(dt) {
    if (!grid || !floorStates.length) return;
    syncActiveFloorState();

    // === Smoke generation and diffusion (per-floor) ===
    const cellMeters = parseFloat(cellSizeMetersInput.value) || 0.5;
    const dirs8 = [
      {dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1},
      {dx:1,dy:1},{dx:-1,dy:1},{dx:1,dy:-1},{dx:-1,dy:-1}
    ];
    const dirs4 = [
      {dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}
    ];
    const inBounds = (x, y) => x >= 0 && y >= 0 && x < gridW && y < gridH;
    const floorInBounds = f => f >= 0 && f < floorCount;

    const MAX_SMOKE = 3.0;
    const FIRE_SOURCE_PER_SEC = 2.4;
    const DIFFUSE_PER_SEC = 1.7 / cellMeters;
    const BASE_DECAY_PER_SEC = 0.012;
    const upTransferRatio = Math.min(0.5, BUOYANCY_PER_SEC * dt);
    const diffuseRatio = Math.min(0.9, DIFFUSE_PER_SEC * dt * 0.35);

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

          const targets = [];
          for (const d of dirs4) {
            const nx = x + d.dx;
            const ny = y + d.dy;
            if (!inBounds(nx, ny)) continue;
            if (!smokePassable(nx, ny)) continue;
            targets.push({ x: nx, y: ny });
          }
          if (targets.length > 0) {
            const move = remain * diffuseRatio;
            const per = move / targets.length;
            remain -= move;
            for (const t of targets) nextSmoke[t.y][t.x] += per;
          }
          nextSmoke[y][x] += remain;
        }
      }

      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (!smokePassable(x, y)) {
            nextSmoke[y][x] = 0;
            continue;
          }
          const decay = Math.max(0, 1 - (BASE_DECAY_PER_SEC + (vent[y][x] ? VENT_DECAY_BONUS : 0)) * dt);
          nextSmoke[y][x] = Math.max(0, Math.min(MAX_SMOKE, nextSmoke[y][x] * decay));
        }
      }

      fs.smokeMap = nextSmoke;
      fs.smokeCeil = nextCeil;
    }

    if (!agents || agents.length === 0) {
      loadFloorState(currentFloor, false);
      return;
    }

    const smokeAt = (floor, x, y) =>
      (floorInBounds(floor) && inBounds(x, y))
        ? (floorStates[floor].smokeMap?.[y]?.[x] || 0)
        : 0;

    function fireRiskAt(floor, cx, cy) {
      let heat = 0;
      let lethal = false;
      const fGrid = floorStates[floor]?.grid;
      if (!fGrid) return { heat, lethal };
      const r = Math.ceil(FIRE_DANGER_RADIUS);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny)) continue;
          if (!fGrid[ny][nx].fire) continue;
          const d = Math.hypot(dx, dy);
          if (d <= FIRE_LETHAL_RADIUS) lethal = true;
          if (d <= FIRE_DANGER_RADIUS) {
            heat += (FIRE_DANGER_RADIUS - d) / FIRE_DANGER_RADIUS;
          }
        }
      }
      return { heat, lethal };
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
        const shouldSwitch =
          (choice.idx >= 0) &&
          (choice.idx !== a.targetExitIndex) &&
          (choice.score + EXIT_SWITCH_MARGIN < curScore);
        if (shouldSwitch) {
          a.targetExitIndex = choice.idx;
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
      a.visibility = Math.max(MIN_VISIBILITY, 1 - smoke * VISIBILITY_SMOKE_COEF);
      a.smokeDose += Math.max(0, smoke - 0.2) * Math.max(0, smoke - 0.2) * dt;
      a.heatDose += fire.heat * dt;

      const acuteSmoke = smoke >= LETHAL_SMOKE_LEVEL &&
        Math.random() < Math.max(0, smoke - LETHAL_SMOKE_LEVEL + 0.2) * 0.25 * dt;

      if (fire.lethal || acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE || a.heatDose >= HEAT_DEATH_DOSE) {
        a.dead = true;
        a.deathTime = simTime;
        a.deathCause = fire.lethal ? "fire" : (acuteSmoke || a.smokeDose >= SMOKE_DEATH_DOSE ? "smoke" : "heat");
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

      let best = { dx: 0, dy: 0, nx: cx, ny: cy, nf: floor, score: -Infinity };
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
        if (candidateKeys.has(key)) return;
        candidateKeys.add(key);
        candidates.push({ ...c, nf, nx, ny });
      }
      if (fGrid[cy][cx].stair) {
        const floors = [floor - 1, floor + 1];
        for (let i = 0; i < floors.length; i++) {
          const nf = floors[i];
          if (!floorInBounds(nf)) continue;
          const nc = floorStates[nf].grid[cy][cx];
          if (nc.walkable && nc.stair) {
            pushCandidate({ dx: 0, dy: 0, nf, nx: cx, ny: cy, stairMove: true });
          }
        }
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
            linkMove: true
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
          fireHeat: fireTarget.heat, potGain, uphill, isBacktrack
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
        const { c, nx, ny, nf, occ, densityTarget, smokeTarget, heatPenalty, fireHeat, potGain, uphill, isBacktrack } = e;
        let score = potGain * POTENTIAL_GAIN_WEIGHT;
        score -= uphill * UPHILL_PENALTY_WEIGHT;
        score -= occ * CONGESTION_PENALTY_WEIGHT;
        score -= densityTarget * CONGESTION_PENALTY_WEIGHT;
        score -= smokeTarget * SMOKE_AVOID_WEIGHT;
        score -= fireHeat * FIRE_AVOID_WEIGHT;
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
          score += (curDistLead - nxtDistLead) * 1.1;
        }
        if (panicDir && c.dx === panicDir.dx && c.dy === panicDir.dy) {
          score += 0.9 + (a.panicFactor * 1.5);
        }
        if (c.dx === 0 && c.dy === 0 && nf === floor) score -= STAY_PENALTY;
        if (nf !== floor) score += 1.2;
        score += (Math.random() - 0.5) * VISIBILITY_NOISE * (1 - a.visibility);
        if (a.panicFactor > 0) {
          score += (Math.random() - 0.5) * (1.8 * a.panicFactor);
        }

        if (score > best.score) best = { dx: c.dx, dy: c.dy, nx, ny, nf, score };
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
        if (occupancyDynamicByFloor[best.nf][best.ny][best.nx] < MAX_OCCUPANCY_PER_CELL) {
          occupancyDynamicByFloor[floor][cy][cx] = Math.max(0, occupancyDynamicByFloor[floor][cy][cx] - 1);
          occupancyDynamicByFloor[best.nf][best.ny][best.nx] += 1;
          a.floor = best.nf;
          a.x = best.nx;
          a.y = best.ny;
          a.cx = best.nx;
          a.cy = best.ny;
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
      for (let f = 0; f < floorCount; f++) {
        for (let y = 0; y < gridH; y++) {
          for (let x = 0; x < gridW; x++) {
            const o = occupancyDynamicByFloor[f][y][x];
            if (o > 0) {
              occupiedCells++;
              occSum += o;
              if (o > maxOcc) maxOcc = o;
            }
          }
        }
      }
      const activeAgents = agents.filter(a => !a.dead && !a.finished).length;
      congestionHistory.push({
        time: simTime,
        avgDensity: occupiedCells ? (occSum / occupiedCells) : 0,
        maxOcc,
        active: activeAgents
      });
      if (congestionHistory.length > 1200) congestionHistory.shift();
      nextCongestionSampleAt = simTime + 1.0;
    }

    hudTime.textContent = simTime.toFixed(1) + " s";
    hudEvac.textContent = `${evacCount} 避難 / ${deadCount} 死亡 / ${agents.length}`;

    const resolvedCount = evacCount + deadCount;
    if (resolvedCount === agents.length) {
      simRunning = false;
      summarize();
      if (deadCount > 0) {
        setStatus(`終了: 避難=${evacCount}、死亡=${deadCount}。`);
        log(`シミュレーション終了: 避難=${evacCount}、死亡=${deadCount}。`);
      } else {
        setStatus("全員が避難完了しました。");
        log("全員が避難完了しました。");
      }
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
      if (writeLog) log("分析対象がありません。");
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
        log("ボトルネック分析: 通過データがありません。");
      } else {
        log(`ボトルネック分析: 上位 / ${currentFloor + 1}F`);
        bottleneckReport.slice(0, 5).forEach((b, i) => {
          log(
            `${i + 1}. (${b.cx},${b.cy}) 騾夐℃=${b.passCount}, ` +
            `拡幅時短縮推定=${b.estimatedSavedSec.toFixed(2)}s`
          );
        });
      }
      if (congestionHistory.length) {
        const maxOcc = Math.max(...congestionHistory.map(c => c.maxOcc));
        const peak = congestionHistory.reduce((a, b) => (a.maxOcc >= b.maxOcc ? a : b));
        log(
          `混雑推移: サンプル=${congestionHistory.length}, ` +
          `ピーク時刻=${peak.time.toFixed(1)}s, 最大同一セル人数=${maxOcc}`
        );
      }
    }
    return bottleneckReport;
  }

  function optimizeExitPlacement() {
    syncActiveFloorState();
    if (!grid || !spawns.length) {
      alert("先にマップと開始位置を設定してください。");
      return;
    }
    if (!rebuildPotentialCache() || !combinedPotential) {
      alert("出口が未設定、または到達不可です。");
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
      const field = computePotentialFieldFromSeeds(exits.concat([c]));
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
      log("出口最適化: 有効な候補がありません。");
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
    const deltaLabel = reverse ? "推定悪化" : "推定短縮";
    log(
      `出口最適化: ${currentFloor + 1}F に出口 (${best.cx},${best.cy}) を追加。` +
      `${deltaLabel}=${estimatedDeltaSec.toFixed(2)}s`
    );
    setStatus(reverse ? "逆最適化を適用しました。" : "出口最適化を適用しました。");
    drawScene();
  }

  function autoImproveSpawnPlacement() {
    syncActiveFloorState();
    if (!grid || !exits.length) {
      alert("先にマップと出口を設定してください。");
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
      log("配置自動改善: 候補が見つかりません。");
      return;
    }
    spawns = chosen;
    syncActiveFloorState();
    allSpawnPoints = collectAllSpawns();
    log(
      reverse
        ? `配置自動改善(逆): ${currentFloor + 1}F の開始位置を${chosen.length} 点に更新しました。`
        : `配置自動改善: ${currentFloor + 1}F の開始位置を${chosen.length} 点に更新しました。`
    );
    setStatus(reverse ? "開始位置の逆改善を適用しました。" : "開始位置の自動改善を適用しました。");
    drawScene();
  }

  // ==== Summary Generation ====
  function summarize() {
    if (!agents || agents.length === 0) return;
    const evacuated = agents.filter(a => a.finished && !a.dead && a.finishTime != null);
    const dead = agents.filter(a => a.dead);
    const resolved = evacuated.length + dead.length;
    if (resolved === 0) return;

    const times = evacuated
      .map(a => a.finishTime - a.startTime)
      .filter(t => Number.isFinite(t) && t >= 0);
    const minT = times.length ? Math.min(...times) : 0;
    const maxT = times.length ? Math.max(...times) : 0;
    const avgT = times.length ? (times.reduce((a,b)=>a+b,0) / times.length) : 0;

    // Heatmap maximum
    let maxHeat = 0, maxHeatCell = null;
    if (heatmap) {
      for (let y=0;y<gridH;y++)for(let x=0;x<gridW;x++){
        if (heatmap[y][x] > maxHeat) {
          maxHeat = heatmap[y][x];
          maxHeatCell = {x,y};
        }
      }
    }
    const bottlenecks = analyzeBottlenecks(false);

    hudAvg.textContent = times.length ? (avgT.toFixed(1) + " s") : "--";
    hudMax.textContent = times.length ? (maxT.toFixed(1) + " s") : "--";

    const reportLines = [];
    reportLines.push(`シミュレーション結果`);
    reportLines.push(`  - エージェント数: ${agents.length}`);
    reportLines.push(`  - 避難完了: ${evacuated.length} (${(evacuated.length / agents.length * 100).toFixed(1)}%)`);
    reportLines.push(`  - 死亡: ${dead.length} (${(dead.length / agents.length * 100).toFixed(1)}%)`);
    const typeCount = agents.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] || 0) + 1;
      return acc;
    }, {});
    const typeText = Object.entries(typeCount)
      .map(([k, v]) => `${TYPE_META[k]?.label || k}:${v}`)
      .join(" / ");
    if (typeText) reportLines.push(`  - 種別内訳: ${typeText}`);
    const floorCountMap = agents.reduce((acc, a) => {
      acc[a.floor] = (acc[a.floor] || 0) + 1;
      return acc;
    }, {});
    const floorText = Object.entries(floorCountMap)
      .map(([f, v]) => `${Number(f) + 1}F:${v}`)
      .join(" / ");
    if (floorText) reportLines.push(`  - フロア内訳: ${floorText}`);
    if (times.length) {
      reportLines.push(`  - 最速避難: ${minT.toFixed(1)} s`);
      reportLines.push(`  - 最終避難: ${maxT.toFixed(1)} s`);
      reportLines.push(`  - 平均避難時間: ${avgT.toFixed(1)} s`);
    } else {
      reportLines.push(`  - 避難時間: 該当なし（避難成功なし）`);
    }
    reportLines.push(``);

    if (dead.length) {
      const cause = { smoke: 0, heat: 0, fire: 0, out_of_bounds: 0, other: 0 };
      dead.forEach(a => {
        if (a.deathCause in cause) cause[a.deathCause]++;
        else cause.other++;
      });
      reportLines.push(`死亡要因内訳`);
      reportLines.push(`  - 辣・ ${cause.smoke}`);
      reportLines.push(`  - 熱: ${cause.heat}`);
      reportLines.push(`  - 火炎接触: ${cause.fire}`);
      reportLines.push(`  - 遽・峇螟・ ${cause.out_of_bounds}`);
      if (cause.other) reportLines.push(`  - 縺昴・莉・ ${cause.other}`);
      reportLines.push(``);
    }

    if (congestionHistory.length) {
      const peak = congestionHistory.reduce((a, b) => (a.maxOcc >= b.maxOcc ? a : b));
      const avgDensity = congestionHistory.reduce((s, c) => s + c.avgDensity, 0) / congestionHistory.length;
      reportLines.push(`時間ごとの混雑推移`);
      reportLines.push(`  - サンプル数: ${congestionHistory.length}`);
      reportLines.push(`  - 平均密度: ${avgDensity.toFixed(3)}`);
      reportLines.push(`  - ピーク時刻: ${peak.time.toFixed(1)} s`);
      reportLines.push(`  - ピーク同一セル人数: ${peak.maxOcc}`);
      reportLines.push(``);
    }

    if (maxHeatCell) {
      const mx = maxHeatCell.x, my = maxHeatCell.y;
      const crowdLevel =
        maxHeat > 200 ? "極めて高密度" :
        maxHeat > 80  ? "高密度" :
        maxHeat > 30  ? "中程度の混雑" :
        maxHeat > 10  ? "軽度の混雑" :
                        "低混雑";
      reportLines.push(`混雑ボトルネック`);
      reportLines.push(`  - 対象フロア: ${currentFloor + 1}F`);
      reportLines.push(`  - セル: (${mx},${my})`);
      reportLines.push(`  - 通過回数: ${maxHeat}`);
      reportLines.push(`  - 混雑レベル: ${crowdLevel}`);
      reportLines.push(``);
    }
    if (bottlenecks.length) {
      reportLines.push(`ボトルネックランキング（拡幅短縮試算）`);
      bottlenecks.slice(0, 5).forEach((b, i) => {
        reportLines.push(
          `  ${i + 1}. (${b.cx},${b.cy}) 通過=${b.passCount}, 試算短縮=${b.estimatedSavedSec.toFixed(2)} s`
        );
      });
      reportLines.push(``);
    }
    reportLines.push(`総括`);
    if (times.length && dead.length === 0) {
      reportLines.push(
        `  全員が避難完了しました。平均避難時間は ${avgT.toFixed(1)} s、最悪ケースは ${maxT.toFixed(1)} s です。`
      );
    } else if (times.length) {
      reportLines.push(
        `  ${evacuated.length}人が避難完了（平均 ${avgT.toFixed(1)} s）、${dead.length}人が煙・熱・火炎の影響で死亡しました。`
      );
    } else {
      reportLines.push(
        `  避難成功はなく、解決済みエージェントは全員死亡でした。`
      );
    }

    logEl.value = reportLines.join("\n") + "\n\n" + logEl.value;
    lastSummary = {
      agents: agents.length,
      evacuated: evacuated.length,
      dead: dead.length,
      avgTime: avgT,
      maxTime: maxT,
      at: new Date().toISOString()
    };

    // MonteCarlo post-processing
if (mcRunning) {
  const mcAvg = times.length ? avgT : simTime;
  const mcMax = times.length ? maxT : simTime;

  mcResults.push({
    avg: mcAvg,
    max: mcMax
  });

  mcRuns++;

  if (mcRuns < mcTargetRuns) {

    resetSim();
    startSimulation();

  } else {

    mcRunning = false;

    const avgAll =
      mcResults.reduce((s,r)=>s+r.avg,0) / mcResults.length;

    const maxAll =
      Math.max(...mcResults.map(r=>r.max));

    log("MC邨先棡");
    log("平均避難時間: " + avgAll.toFixed(2) + " s");
    log("最悪ケース: " + maxAll.toFixed(2) + " s");

    setStatus("MC完了。");
  }
}
  }

  // ==== Rendering ====
  function drawScene() {
    const rect = cvs.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const layout = worldLayout();
    const { scale, ox, oy } = layout;

    function drawArrow(px, py, vx, vy, color, width = 0.35) {
      const len = Math.hypot(vx, vy);
      if (len < 0.001) return;
      const ux = vx / len;
      const uy = vy / len;
      const head = 0.8;
      const tipX = px + vx;
      const tipY = py + vy;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * head - uy * 0.4, tipY - uy * head + ux * 0.4);
      ctx.lineTo(tipX - ux * head + uy * 0.4, tipY - uy * head - ux * 0.4);
      ctx.closePath();
      ctx.fill();
    }

    // Base image
    if (baseImage) {
      ctx.drawImage(baseImage, ox, oy, baseImage.width*scale, baseImage.height*scale);
    } else {
      ctx.strokeStyle = "#330011";
      ctx.strokeRect(20, 20, rect.width-40, rect.height-40);
      ctx.fillStyle = "#501020";
      ctx.fillText("先にマップ画像を読み込んでください", 40, 50);
      return;
    }

    // Grid overlay (subtle)
    if (grid) {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      ctx.strokeStyle = "rgba(80,0,40,0.25)";
      ctx.lineWidth = 0.2;
      for (let y=0; y<=gridH; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y*CELL_SIZE_PX);
        ctx.lineTo(gridW*CELL_SIZE_PX, y*CELL_SIZE_PX);
        ctx.stroke();
      }
      for (let x=0; x<=gridW; x++) {
        ctx.beginPath();
        ctx.moveTo(x*CELL_SIZE_PX, 0);
        ctx.lineTo(x*CELL_SIZE_PX, gridH*CELL_SIZE_PX);
        ctx.stroke();
      }

      // Stairs cells
      ctx.fillStyle = "rgba(80,220,255,0.42)";
      for (let y=0; y<gridH; y++) for (let x=0; x<gridW; x++) {
        if (grid[y][x].stair) {
          ctx.fillRect(x*CELL_SIZE_PX, y*CELL_SIZE_PX, CELL_SIZE_PX, CELL_SIZE_PX);
        }
      }
      // Stair links (current-floor endpoints)
      if (stairLinks.length) {
        ctx.strokeStyle = "rgba(120,255,220,0.95)";
        ctx.fillStyle = "rgba(200,255,245,0.95)";
        ctx.lineWidth = 0.45;
        ctx.font = `${Math.max(6, CELL_SIZE_PX * 0.7)}px Consolas`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        stairLinks.forEach(link => {
          if (!link?.a || !link?.b) return;
          const here = link.a.floor === currentFloor ? link.a : (link.b.floor === currentFloor ? link.b : null);
          if (!here) return;
          const other = (here === link.a) ? link.b : link.a;
          const px = (here.cx + 0.5) * CELL_SIZE_PX;
          const py = (here.cy + 0.5) * CELL_SIZE_PX;
          ctx.beginPath();
          ctx.arc(px, py, CELL_SIZE_PX * 0.9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillText(`->${other.floor + 1}F`, px + CELL_SIZE_PX * 0.65, py);
        });
      }
      if (pendingStairLink && pendingStairLink.floor === currentFloor) {
        const px = (pendingStairLink.cx + 0.5) * CELL_SIZE_PX;
        const py = (pendingStairLink.cy + 0.5) * CELL_SIZE_PX;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(px, py, CELL_SIZE_PX * 1.15, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (vizPotentialInput.checked && (combinedPotential || potentialByExit.length)) {
        const showPerExit = potentialViewModeInput.value === "per_exit";
        const targetIdx = Math.max(0, Math.floor(parseNum(potentialExitIndexInput, 1)) - 1);
        const pMap = showPerExit ? potentialByExit[targetIdx] : combinedPotential;
        if (pMap) {
          const maxPot = Math.max(1, potentialLegendMax);
          for (let y = 0; y < gridH; y++) {
            for (let x = 0; x < gridW; x++) {
              if (!grid[y][x].walkable) continue;
              const p = pMap[y]?.[x];
              if (!isFinite(p)) continue;
              const t = clamp(1 - (p / maxPot), 0, 1);
              const r = Math.floor(30 + 210 * t);
              const g = Math.floor(70 + 120 * (1 - Math.abs(t - 0.5) * 2));
              const b = Math.floor(255 - 180 * t);
              ctx.fillStyle = `rgba(${r},${g},${b},0.22)`;
              ctx.fillRect(x * CELL_SIZE_PX, y * CELL_SIZE_PX, CELL_SIZE_PX, CELL_SIZE_PX);
            }
          }
          // Potential gradient arrows
          const stride = 5;
          for (let y = 2; y < gridH - 2; y += stride) {
            for (let x = 2; x < gridW - 2; x += stride) {
              if (!grid[y][x].walkable) continue;
              const cur = pMap[y]?.[x];
              if (!isFinite(cur)) continue;
              let best = { dx: 0, dy: 0, gain: 0 };
              const dirs = [
                {dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1},
                {dx:1,dy:1},{dx:-1,dy:1},{dx:1,dy:-1},{dx:-1,dy:-1}
              ];
              for (let i = 0; i < dirs.length; i++) {
                const d = dirs[i];
                const nx = x + d.dx;
                const ny = y + d.dy;
                if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
                if (!grid[ny][nx].walkable) continue;
                const np = pMap[ny]?.[nx];
                if (!isFinite(np)) continue;
                const gain = cur - np;
                if (gain > best.gain) best = { dx: d.dx, dy: d.dy, gain };
              }
              if (best.gain > 0.01) {
                const px = (x + 0.5) * CELL_SIZE_PX;
                const py = (y + 0.5) * CELL_SIZE_PX;
                drawArrow(px, py, best.dx * 1.2, best.dy * 1.2, "rgba(180,255,255,0.7)", 0.3);
              }
            }
          }
        }
      }

      // Fire cells
      ctx.fillStyle = "rgba(255,40,40,0.5)";
      for (let y=0;y<gridH;y++)for(let x=0;x<gridW;x++){
        if (grid[y][x].fire) {
          ctx.fillRect(x*CELL_SIZE_PX, y*CELL_SIZE_PX, CELL_SIZE_PX, CELL_SIZE_PX);
        }
      }
      // Smoke cells
      // Smoke rendering
      // Smoke rendering (grayscale with stepped emphasis)
if (smokeMap) {
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const s = smokeMap[y][x];
      if (s <= 0.02) continue;

      // ===== Visual scaling =====
      const v = Math.min(s / 2.0, 1.0); // Clamp to 0..1

      let gray, alpha;

      if (v < 0.33) {
        // Light smoke
        gray  = 180;
        alpha = 0.35;
      } else if (v < 0.66) {
        // Medium smoke
        gray  = 110;
        alpha = 0.65;
      } else {
        // Dense smoke
        gray  = 40;
        alpha = 0.9;
      }

      ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
      ctx.fillRect(
        x * CELL_SIZE_PX,
        y * CELL_SIZE_PX,
        CELL_SIZE_PX,
        CELL_SIZE_PX
      );

      // Extra dark overlay for dense smoke
      if (v > 0.66) {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(
          x * CELL_SIZE_PX,
          y * CELL_SIZE_PX,
          CELL_SIZE_PX,
          CELL_SIZE_PX
        );
      }
    }
  }
}



      // Exit
      ctx.fillStyle = "#ffdd33";
      exits.forEach((p, idx) => {
        const px = (p.cx+0.5)*CELL_SIZE_PX;
        const py = (p.cy+0.5)*CELL_SIZE_PX;
        ctx.beginPath();
        ctx.arc(px, py, CELL_SIZE_PX*0.6, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = "#3b2200";
        ctx.font = `${Math.max(6, CELL_SIZE_PX * 0.8)}px Consolas`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const globalIndex = allExitPoints.findIndex(e =>
          e.floor === currentFloor && e.cx === p.cx && e.cy === p.cy
        );
        ctx.fillText(String((globalIndex >= 0 ? globalIndex : idx) + 1), px, py);
        ctx.fillStyle = "#ffdd33";
      });

      // Spawn
      ctx.fillStyle = "#33ffaa";
      spawns.forEach(p => {
        const px = (p.cx+0.5)*CELL_SIZE_PX;
        const py = (p.cy+0.5)*CELL_SIZE_PX;
        ctx.beginPath();
        ctx.arc(px, py, CELL_SIZE_PX*0.6, 0, Math.PI*2);
        ctx.fill();
      });

      if (vizTrailsInput.checked && agents && agents.length > 0) {
        agents.forEach(a => {
          if (!a.trail || a.trail.length < 2) return;
          if (a.dead) return;
          const baseColor = TYPE_META[a.type]?.color || "#ff3366";
          ctx.strokeStyle = baseColor;
          ctx.globalAlpha = 0.22;
          ctx.lineWidth = 0.45;
          let drawing = false;
          for (let i = 0; i < a.trail.length; i++) {
            const t = a.trail[i];
            if ((t.floor ?? a.floor) !== currentFloor) {
              drawing = false;
              continue;
            }
            const tx = (t.x + 0.5) * CELL_SIZE_PX;
            const ty = (t.y + 0.5) * CELL_SIZE_PX;
            if (!drawing) {
              ctx.beginPath();
              ctx.moveTo(tx, ty);
              drawing = true;
            } else {
              ctx.lineTo(tx, ty);
              ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;
        });
      }

      if (vizFlowInput.checked && flowField) {
        const stride = 4;
        for (let y = 1; y < gridH - 1; y += stride) {
          for (let x = 1; x < gridW - 1; x += stride) {
            const f = flowField[y][x];
            if (!f || f.n < 1) continue;
            const vx = (f.vx / f.n) * 2.1;
            const vy = (f.vy / f.n) * 2.1;
            const m = Math.hypot(vx, vy);
            if (m < 0.03) continue;
            const px = (x + 0.5) * CELL_SIZE_PX;
            const py = (y + 0.5) * CELL_SIZE_PX;
            const alpha = clamp(0.25 + m * 0.45, 0.25, 0.85);
            drawArrow(px, py, vx, vy, `rgba(120,230,255,${alpha})`, 0.28);
          }
        }
      }

      // Agents
      if (agents && agents.length > 0) {
        agents.forEach(a => {
          if (a.floor !== currentFloor) return;
          const px = (a.x+0.5)*CELL_SIZE_PX;
          const py = (a.y+0.5)*CELL_SIZE_PX;
          if (a.dead) ctx.fillStyle = "#1a1a1a";
          else if (a.fallen) ctx.fillStyle = "#ff9900";
          else if (a.helpingId != null) ctx.fillStyle = "#33ccff";
          else if (a.finished) ctx.fillStyle = "#8888ff";
          else ctx.fillStyle = TYPE_META[a.type]?.color || "#ff3366";
          ctx.globalAlpha = a.dead ? 0.95 : Math.max(0.25, a.visibility ?? 1);
          ctx.beginPath();
          ctx.arc(px, py, CELL_SIZE_PX*0.4, 0, Math.PI*2);
          ctx.fill();
          if (!a.dead && (a.type === "teacher" || a.type === "leader")) {
            ctx.strokeStyle = "#d2fff2";
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.arc(px, py, CELL_SIZE_PX * 0.62, 0, Math.PI * 2);
            ctx.stroke();
          }
          if (a.dead) {
            ctx.strokeStyle = "#660000";
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(px - CELL_SIZE_PX * 0.35, py - CELL_SIZE_PX * 0.35);
            ctx.lineTo(px + CELL_SIZE_PX * 0.35, py + CELL_SIZE_PX * 0.35);
            ctx.moveTo(px + CELL_SIZE_PX * 0.35, py - CELL_SIZE_PX * 0.35);
            ctx.lineTo(px - CELL_SIZE_PX * 0.35, py + CELL_SIZE_PX * 0.35);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        });
      }
            // === Highlight most congested cell ===
      if (!simRunning && maxHeatCell && maxHeatValue > 5) {
        const px = (maxHeatCell.x + 0.5) * CELL_SIZE_PX;
        const py = (maxHeatCell.y + 0.5) * CELL_SIZE_PX;
        const pulse = 0.5 + 0.5 * Math.sin(simTime * 4);
        ctx.strokeStyle = `rgba(255,120,0,${pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, CELL_SIZE_PX * (1.2 + pulse), 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(255,220,150,0.9)";
      ctx.font = "10px Consolas";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`フロア ${currentFloor + 1}/${floorCount}`, 4, 4);

      ctx.restore();
      
    }
  }

  // ==== Initialization ====
  Object.values(modeButtons).forEach(btn => {
    if (!btn) return;
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
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
  setStatus("マップを読み込み、開始位置 / 出口 / 火元を設定してからシミュ開始を押してください。");
