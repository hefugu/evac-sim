import {
  getFloorByIndex,
  gridToWorld,
  simulationFloorsView
} from "./floors3d.js";
import { stairTransitionWorldPosition } from "./stairs3d.js";

export const AGENT3D_TYPES = Object.freeze(["teacher", "student", "panic"]);

export const AGENT_BEHAVIOR_STATES = Object.freeze([
  "normal",
  "follow_teacher",
  "avoid_hazard",
  "seek_clear_air",
  "stair_transition",
  "stuck_escape",
  "panic_escape"
]);

export const AGENT3D_PROFILES = Object.freeze({
  teacher: Object.freeze({
    color: "#66ccff",
    speedFactor: 0.96,
    hazardAvoidance: 1.35,
    decisionNoise: 0.08,
    exitPersistence: 0.55
  }),
  student: Object.freeze({
    color: "#7bb8ff",
    speedFactor: 0.72,
    hazardAvoidance: 1,
    decisionNoise: 0.18,
    exitPersistence: 0.8
  }),
  panic: Object.freeze({
    color: "#ff66aa",
    speedFactor: 1.1,
    hazardAvoidance: 0.7,
    decisionNoise: 0.65,
    exitPersistence: 1.35
  }),
  adult: Object.freeze({ color: "#ff3366", speedFactor: 1, hazardAvoidance: 1, decisionNoise: 0.15, exitPersistence: 0.8 }),
  child: Object.freeze({ color: "#8ad8ff", speedFactor: 0.74, hazardAvoidance: 0.95, decisionNoise: 0.22, exitPersistence: 0.85 }),
  elderly: Object.freeze({ color: "#ffd26b", speedFactor: 0.62, hazardAvoidance: 1.1, decisionNoise: 0.12, exitPersistence: 0.7 }),
  leader: Object.freeze({ color: "#66ffcc", speedFactor: 1.02, hazardAvoidance: 1.3, decisionNoise: 0.08, exitPersistence: 0.55 })
});

export const DEFAULT_AGENT_HAZARD_OPTIONS = Object.freeze({
  lowVisibilityMeters: 6,
  avoidHazardScore: 1,
  seekClearAirHazardScore: 1.8,
  panicEscapeHazardScore: 2.2,
  stuckEscapeSec: 2,
  seekClearAirStuckSec: 1.2,
  smokeDoseThreshold: 0.2,
  coReferencePpm: 1000,
  heatFluxReferenceKwM2: 10
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function agentFloorIndex(agent = {}) {
  // `floor` is the current core.js source of truth. floorIndex is the
  // canonical fallback for standalone 3D agents.
  return Math.floor(finiteNumber(agent.floor ?? agent.floorIndex, 0));
}

export function agentGridPosition(agent = {}) {
  const x = finiteNumber(agent.x ?? agent.cx, 0);
  const y = finiteNumber(agent.y ?? agent.cy, 0);
  return {
    floorIndex: agentFloorIndex(agent),
    floor: agentFloorIndex(agent),
    x,
    y,
    cx: Math.round(x),
    cy: Math.round(y)
  };
}

function validBehaviorState(value) {
  return AGENT_BEHAVIOR_STATES.includes(value) ? value : "normal";
}

export function agentWorldPosition(agent, floors, options = {}) {
  if (agent?.stairTransition?.status === "in_transit") {
    const transitionPosition = stairTransitionWorldPosition(agent.stairTransition, floors, options);
    if (transitionPosition) return transitionPosition;
  }
  const position = agentGridPosition(agent);
  const floor = getFloorByIndex(floors, position.floorIndex);
  return gridToWorld(position, { ...options, floor });
}

/** Add canonical fields to one legacy/current agent without mutating it. */
export function normalizeAgent3D(agent = {}, floors = [], options = {}) {
  const position = agentGridPosition(agent);
  const world = agentWorldPosition(agent, floors, options);
  const type = String(agent.type || options.defaultType || "student");
  return {
    ...agent,
    x: position.x,
    y: position.y,
    cx: position.cx,
    cy: position.cy,
    floorIndex: position.floorIndex,
    floor: position.floorIndex,
    worldX: world.worldX,
    worldY: world.worldY,
    worldZ: world.worldZ,
    type,
    behaviorState: validBehaviorState(agent.behaviorState),
    targetExit: agent.targetExitIndex ?? agent.targetExit ?? null,
    targetStair: agent.stairTransition?.linkId ?? agent.targetStair ?? null,
    visibility: clamp(finiteNumber(agent.visibility, 1), 0, 1),
    smokeDose: Math.max(0, finiteNumber(agent.smokeDose, 0)),
    coDose: Math.max(0, finiteNumber(agent.coDosePpmMin, agent.coDose || 0)),
    heatDose: Math.max(0, finiteNumber(agent.heatDose, agent.heatFluxDose || 0)),
    stuckTime: Math.max(0, finiteNumber(agent.stuckTime, 0))
  };
}

/**
 * Return renderer records derived from the shared agents. `sourceAgent` is the
 * original object reference, making it explicit that this is not a second set
 * of simulation agents.
 */
export function projectAgents3D(agents, floors, options = {}) {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter(agent => options.includeFinished !== false || (!agent.finished && !agent.dead))
    .map(agent => {
      const normalized = normalizeAgent3D(agent, floors, options);
      const profile = AGENT3D_PROFILES[normalized.type] || AGENT3D_PROFILES.student;
      return {
        id: normalized.id,
        sourceAgent: agent,
        type: normalized.type,
        behaviorState: normalized.behaviorState,
        floorIndex: normalized.floorIndex,
        worldX: normalized.worldX,
        worldY: normalized.worldY,
        worldZ: normalized.worldZ,
        color: profile.color,
        opacity: normalized.dead ? 0.95 : Math.max(0.25, normalized.visibility),
        dead: !!normalized.dead,
        fallen: !!normalized.fallen,
        finished: !!normalized.finished,
        targetExit: normalized.targetExit,
        targetStair: normalized.targetStair,
        visibility: normalized.visibility
      };
    });
}

/** One-call live-state adapter for a 3D renderer. */
export function projectSimulationState3D(state, options = {}) {
  const floors = options.floors || simulationFloorsView(state, options);
  const agents = Array.isArray(state?.agents) ? state.agents : [];
  return {
    floors,
    agents: projectAgents3D(agents, floors, options),
    sourceAgents: agents,
    stairLinks: state?.map?.stairLinks || [],
    simTime: finiteNumber(state?.sim?.time ?? state?.simTime, 0),
    running: !!(state?.sim?.running ?? state?.simRunning)
  };
}

/** Pure alternative for stores that want world fields persisted on agents. */
export function syncAgentWorldCoordinates(agents, floors, options = {}) {
  return Array.isArray(agents)
    ? agents.map(agent => normalizeAgent3D(agent, floors, options))
    : [];
}

export function cellHazardMetrics(cell = {}, options = {}) {
  const config = { ...DEFAULT_AGENT_HAZARD_OPTIONS, ...options };
  const smokeDensity = Math.max(0, finiteNumber(cell.smokeDensity, cell.smoke || 0));
  const coPpm = Math.max(0, finiteNumber(
    cell.coPpm ?? cell.co,
    smokeDensity * 260
  ));
  const heatFluxKwM2 = Math.max(0, finiteNumber(cell.heatFluxKwM2, cell.heat || 0));
  const fireIntensity = Math.max(0, finiteNumber(cell.fireIntensity, cell.fire ? 1 : 0));
  const smokeVisibilityMeters = smokeDensity > 0.001
    ? Math.min(30, 3 / (smokeDensity * 0.32))
    : 30;
  const visibilityMeters = Math.max(0, finiteNumber(
    cell.visibilityMeters ?? cell.visibilityM,
    cell.visibility == null ? smokeVisibilityMeters : finiteNumber(cell.visibility, 1) * 30
  ));
  const score =
    smokeDensity * 0.8 +
    coPpm / Math.max(1, config.coReferencePpm) +
    heatFluxKwM2 / Math.max(0.1, config.heatFluxReferenceKwM2) +
    fireIntensity * 3 +
    Math.max(0, 1 - visibilityMeters / Math.max(0.1, config.lowVisibilityMeters));
  return { smokeDensity, coPpm, heatFluxKwM2, fireIntensity, visibilityMeters, score };
}

function floorCellWithHazard(floor, cx, cy) {
  const cell = floor?.grid?.[cy]?.[cx];
  if (!cell) return null;
  const legacySmoke = floor?.smokeMap?.[cy]?.[cx];
  if (cell.smokeDensity == null && Number.isFinite(Number(legacySmoke))) {
    return { ...cell, smokeDensity: Number(legacySmoke), smoke: Number(legacySmoke) };
  }
  return cell;
}

function agentCell(agent, floors) {
  const position = agentGridPosition(agent);
  const floor = getFloorByIndex(floors, position.floorIndex);
  return floorCellWithHazard(floor, position.cx, position.cy);
}

/**
 * Central state transition policy. Movement remains in core.js; this function
 * only decides the behavior label and is therefore deterministic/testable.
 */
export function deriveAgentBehaviorState(agent, context = {}, options = {}) {
  const config = { ...DEFAULT_AGENT_HAZARD_OPTIONS, ...options };
  if (agent?.stairTransition || context.inStairTransition) return "stair_transition";
  const contextLooksLikeCell = context && (
    context.walkable != null || context.fire != null ||
    context.smokeDensity != null || context.smoke != null || context.coPpm != null
  );
  const cell = context.cell ||
    (context.floors ? agentCell(agent, context.floors) : (contextLooksLikeCell ? context : {}));
  const hazard = context.hazard || cellHazardMetrics(cell || {}, config);
  const stuckTime = Math.max(0, finiteNumber(agent?.stuckTime, 0));
  const type = String(agent?.type || "student");
  const lowVisibility = hazard.visibilityMeters < config.lowVisibilityMeters ||
    finiteNumber(agent?.visibility, 1) < 0.35;
  const hasTeacher = !!(
    context.teacher || context.teacherId != null || agent?.teacherId != null || agent?.leaderId != null
  );

  if (stuckTime >= config.seekClearAirStuckSec && hazard.score >= config.seekClearAirHazardScore) {
    return "seek_clear_air";
  }
  if (type === "panic" && (
    hazard.score >= config.panicEscapeHazardScore || stuckTime >= config.stuckEscapeSec
  )) return "panic_escape";
  if ((type === "student" || type === "child") && hasTeacher && lowVisibility) return "follow_teacher";

  const profile = AGENT3D_PROFILES[type] || AGENT3D_PROFILES.student;
  const adjustedAvoidThreshold = config.avoidHazardScore / Math.max(0.2, profile.hazardAvoidance);
  if (hazard.score >= adjustedAvoidThreshold) return "avoid_hazard";
  if (stuckTime >= config.stuckEscapeSec) return "stuck_escape";
  if ((type === "student" || type === "child") && hasTeacher && context.followTeacher) return "follow_teacher";
  return "normal";
}

/** Select the lowest-hazard adjacent passable cell for seek_clear_air. */
export function chooseClearAirStep(agent, floors, options = {}) {
  const position = agentGridPosition(agent);
  const floor = getFloorByIndex(floors, position.floorIndex);
  if (!floor) return null;
  const directions = options.allowDiagonal === false
    ? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
    : [
        [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [-1, 1], [1, -1], [-1, -1]
      ];
  const candidates = [];
  directions.forEach(([dx, dy]) => {
    const cx = position.cx + dx;
    const cy = position.cy + dy;
    const cell = floorCellWithHazard(floor, cx, cy);
    if (!cell || cell.wall || !cell.walkable || cell.fire) return;
    const hazard = cellHazardMetrics(cell, options);
    const distancePenalty = Math.hypot(dx, dy) * finiteNumber(options.distancePenalty, 0.01);
    candidates.push({
      floorIndex: position.floorIndex,
      cx,
      cy,
      dx,
      dy,
      hazard,
      score: hazard.score + distancePenalty
    });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || a.cy - b.cy || a.cx - b.cx);
  const best = candidates[0];
  const current = candidates.find(candidate => candidate.dx === 0 && candidate.dy === 0);
  return {
    ...best,
    improvement: current ? current.score - best.score : 0
  };
}

/** Accumulate exposure fields with the same units used by the existing core. */
export function applyAgentHazardExposure(agent, cellOrHazard, dtSeconds, options = {}) {
  const config = { ...DEFAULT_AGENT_HAZARD_OPTIONS, ...options };
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const hazard = cellOrHazard?.score == null
    ? cellHazardMetrics(cellOrHazard || {}, config)
    : cellOrHazard;
  const smokeExcess = Math.max(0, hazard.smokeDensity - config.smokeDoseThreshold);
  const smokeDose = Math.max(0, finiteNumber(agent?.smokeDose, 0)) + smokeExcess * smokeExcess * dt;
  const coDose = Math.max(0, finiteNumber(agent?.coDose, agent?.coDosePpmMin || 0)) + hazard.coPpm * dt / 60;
  const heatFluxDose = Math.max(0, finiteNumber(agent?.heatFluxDose, 0)) + hazard.heatFluxKwM2 * dt;
  const heatDose = Math.max(0, finiteNumber(agent?.heatDose, 0)) +
    (hazard.fireIntensity + hazard.heatFluxKwM2 / Math.max(0.1, config.heatFluxReferenceKwM2)) * dt;
  const visibility = clamp(hazard.visibilityMeters / 30, 0.1, 1);

  return {
    ...agent,
    visibility,
    smokeDose,
    coDose,
    coDosePpmMin: coDose,
    heatDose,
    heatFluxDose
  };
}

export function groupAgentsByFloor(agents) {
  const groups = new Map();
  (Array.isArray(agents) ? agents : []).forEach(agent => {
    const floorIndex = agentFloorIndex(agent);
    if (!groups.has(floorIndex)) groups.set(floorIndex, []);
    groups.get(floorIndex).push(agent);
  });
  return groups;
}

/** Common evaluation data for either renderer. */
export function summarizeAgentMetrics(agents, options = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const evacuated = list.filter(agent => agent.finished && !agent.dead);
  const dead = list.filter(agent => agent.dead);
  const evacuationTimes = evacuated
    .map(agent => finiteNumber(agent.finishTime, NaN) - finiteNumber(agent.startTime, 0))
    .filter(time => Number.isFinite(time) && time >= 0);
  const floorOccupancy = {};
  list.forEach(agent => {
    if (agent.finished || agent.dead) return;
    const floorIndex = agentFloorIndex(agent);
    floorOccupancy[floorIndex] = (floorOccupancy[floorIndex] || 0) + 1;
  });
  const students = list.filter(agent => agent.type === "student" || agent.type === "child");
  const following = students.filter(agent =>
    agent.behaviorState === "follow_teacher" || agent.leaderId != null || agent.teacherId != null
  );
  const sum = selector => list.reduce((total, agent) => total + Math.max(0, finiteNumber(selector(agent), 0)), 0);

  return {
    total: list.length,
    evacuated: evacuated.length,
    dead: dead.length,
    averageEvacuationTime: evacuationTimes.length
      ? evacuationTimes.reduce((total, time) => total + time, 0) / evacuationTimes.length
      : 0,
    maximumEvacuationTime: evacuationTimes.length ? Math.max(...evacuationTimes) : 0,
    floorOccupancy,
    smokeExposure: sum(agent => agent.smokeDose),
    coExposurePpmMin: sum(agent => agent.coDosePpmMin ?? agent.coDose),
    heatExposure: sum(agent => agent.heatDose ?? agent.heatFluxDose),
    stuckCount: list.filter(agent =>
      finiteNumber(agent.stuckCount, 0) > 0 || finiteNumber(agent.stuckTime, 0) >= finiteNumber(options.stuckThresholdSec, 2)
    ).length,
    teacherFollowRate: students.length ? following.length / students.length : 0,
    panicEscapeCount: list.reduce((count, agent) =>
      count + Math.max(0, finiteNumber(agent.panicEscapeCount, agent.behaviorState === "panic_escape" ? 1 : 0)),
    0)
  };
}
