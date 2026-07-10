import { getFloorByIndex, gridToWorld, updateFloorCell } from "./floors3d.js";

export const STAIR_TYPES = Object.freeze(["indoor", "outdoor", "emergency"]);

export const STAIR_TYPE_META = Object.freeze({
  indoor: Object.freeze({ smokeRiseFactor: 1, ventilationFactor: 0.15 }),
  outdoor: Object.freeze({ smokeRiseFactor: 0.22, ventilationFactor: 1 }),
  emergency: Object.freeze({ smokeRiseFactor: 0.55, ventilationFactor: 0.55 })
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = finiteNumber(value, fallback);
  return n > 0 ? n : fallback;
}

function sameEndpoint(a, b) {
  return !!a && !!b &&
    a.floorIndex === b.floorIndex && a.cx === b.cx && a.cy === b.cy;
}

export function normalizeStairEndpoint(endpoint = {}) {
  return {
    floorIndex: Math.floor(finiteNumber(endpoint.floorIndex ?? endpoint.floor, 0)),
    cx: Math.floor(finiteNumber(endpoint.cx ?? endpoint.x, 0)),
    cy: Math.floor(finiteNumber(endpoint.cy ?? endpoint.y, 0))
  };
}

export function stairEndpointKey3D(endpoint) {
  const normalized = normalizeStairEndpoint(endpoint);
  return `${normalized.floorIndex}:${normalized.cx}:${normalized.cy}`;
}

function generatedLinkId(type, from, to) {
  const safe = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `stair-${safe(type)}-${safe(stairEndpointKey3D(from))}-${safe(stairEndpointKey3D(to))}`;
}

/** Accept both the requested {from,to} shape and the existing core {a,b} shape. */
export function normalizeStairLink(link = {}, defaults = {}) {
  const from = normalizeStairEndpoint(link.from || link.a || defaults.from);
  const to = normalizeStairEndpoint(link.to || link.b || defaults.to);
  const type = STAIR_TYPES.includes(link.type) ? link.type : (STAIR_TYPES.includes(defaults.type) ? defaults.type : "indoor");

  return {
    ...link,
    id: String(link.id || defaults.id || generatedLinkId(type, from, to)),
    type,
    from,
    to,
    widthMeters: positiveNumber(link.widthMeters ?? defaults.widthMeters, 1.5),
    travelCostSec: positiveNumber(link.travelCostSec ?? defaults.travelCostSec, 8),
    verticalSmokeTransfer: Math.max(0, finiteNumber(
      link.verticalSmokeTransfer ?? defaults.verticalSmokeTransfer,
      0.35
    )),
    congestionCapacity: Math.max(1, Math.floor(positiveNumber(
      link.congestionCapacity ?? defaults.congestionCapacity,
      2
    )))
  };
}

export function createStairLink(input = {}) {
  return normalizeStairLink(input);
}

export function validateStairLink(link, floors = null) {
  const normalized = normalizeStairLink(link);
  const errors = [];
  if (!normalized.id) errors.push("id is required");
  if (!STAIR_TYPES.includes(normalized.type)) errors.push("unsupported stair type");
  if (sameEndpoint(normalized.from, normalized.to)) errors.push("from and to must differ");
  if (normalized.from.floorIndex === normalized.to.floorIndex) errors.push("stairs must connect different floors");
  if (!(normalized.travelCostSec > 0)) errors.push("travelCostSec must be positive");
  if (!(normalized.congestionCapacity >= 1)) errors.push("congestionCapacity must be at least 1");

  if (Array.isArray(floors)) {
    for (const [label, endpoint] of [["from", normalized.from], ["to", normalized.to]]) {
      const floor = getFloorByIndex(floors, endpoint.floorIndex);
      const cell = floor?.grid?.[endpoint.cy]?.[endpoint.cx];
      if (!floor) errors.push(`${label} floor does not exist`);
      else if (!cell) errors.push(`${label} cell is outside its floor grid`);
      else if (!cell.walkable) errors.push(`${label} cell must be walkable`);
    }
  }

  return { valid: errors.length === 0, errors, link: normalized };
}

export function indexStairLinks(links) {
  const byId = new Map();
  const byEndpoint = new Map();
  (Array.isArray(links) ? links : []).forEach(raw => {
    const link = normalizeStairLink(raw);
    byId.set(link.id, link);
    for (const endpoint of [link.from, link.to]) {
      const key = stairEndpointKey3D(endpoint);
      if (!byEndpoint.has(key)) byEndpoint.set(key, []);
      byEndpoint.get(key).push(link);
    }
  });
  return { byId, byEndpoint };
}

export function stairLinksAt(linksOrIndex, endpoint) {
  const index = linksOrIndex?.byEndpoint ? linksOrIndex : indexStairLinks(linksOrIndex);
  return index.byEndpoint.get(stairEndpointKey3D(endpoint)) || [];
}

export function otherStairEndpoint(linkInput, endpointInput) {
  const link = normalizeStairLink(linkInput);
  const endpoint = normalizeStairEndpoint(endpointInput);
  if (sameEndpoint(link.from, endpoint)) return { ...link.to };
  if (sameEndpoint(link.to, endpoint)) return { ...link.from };
  return null;
}

/** Copy-on-write marking of a stair cell and its floor-local metadata. */
export function addStairCell(floors, endpointInput, metadata = {}) {
  if (!Array.isArray(floors)) return [];
  const endpoint = normalizeStairEndpoint(endpointInput);
  const floorArrayIndex = floors.findIndex((floor, index) =>
    Math.floor(finiteNumber(floor?.floorIndex ?? floor?.floor, index)) === endpoint.floorIndex
  );
  if (floorArrayIndex < 0) return floors;
  const floor = floors[floorArrayIndex];
  if (!floor?.grid?.[endpoint.cy]?.[endpoint.cx]) return floors;

  let nextFloor = updateFloorCell(floor, endpoint.cx, endpoint.cy, cell => ({
    ...cell,
    walkable: true,
    wall: false,
    stair: true,
    stairType: STAIR_TYPES.includes(metadata.type) ? metadata.type : (cell.stairType || "indoor")
  }));
  const localStairs = Array.isArray(nextFloor.stairs) ? nextFloor.stairs.slice() : [];
  const existingIndex = localStairs.findIndex(stair =>
    Number(stair.cx) === endpoint.cx && Number(stair.cy) === endpoint.cy
  );
  const localRecord = { ...metadata, cx: endpoint.cx, cy: endpoint.cy };
  if (existingIndex >= 0) localStairs[existingIndex] = { ...localStairs[existingIndex], ...localRecord };
  else localStairs.push(localRecord);
  nextFloor = { ...nextFloor, stairs: localStairs };

  const nextFloors = floors.slice();
  nextFloors[floorArrayIndex] = nextFloor;
  return nextFloors;
}

/** Return an append result instead of throwing, which keeps UI workflows simple. */
export function appendStairLink(links, linkInput, floors = null) {
  const current = Array.isArray(links) ? links : [];
  const checked = validateStairLink(linkInput, floors);
  if (!checked.valid) return { links: current, link: checked.link, added: false, errors: checked.errors };
  const duplicate = current.some(raw => {
    const link = normalizeStairLink(raw);
    return link.id === checked.link.id || (
      (sameEndpoint(link.from, checked.link.from) && sameEndpoint(link.to, checked.link.to)) ||
      (sameEndpoint(link.from, checked.link.to) && sameEndpoint(link.to, checked.link.from))
    );
  });
  if (duplicate) return { links: current, link: checked.link, added: false, errors: ["duplicate stair link"] };
  return { links: current.concat(checked.link), link: checked.link, added: true, errors: [] };
}

export function createStairTrafficState(links = [], elapsedSec = 0) {
  const byLink = {};
  (Array.isArray(links) ? links : []).forEach(raw => {
    const link = normalizeStairLink(raw);
    byLink[link.id] = {
      queue: [],
      inTransit: [],
      completedCount: 0,
      maxQueue: 0
    };
  });
  return { elapsedSec: Math.max(0, finiteNumber(elapsedSec, 0)), byLink };
}

function ensureTrafficRecord(state, linkId) {
  const record = state?.byLink?.[linkId];
  return {
    queue: Array.isArray(record?.queue) ? record.queue.map(item => ({ ...item })) : [],
    inTransit: Array.isArray(record?.inTransit) ? record.inTransit.map(item => ({
      ...item,
      from: normalizeStairEndpoint(item.from),
      to: normalizeStairEndpoint(item.to)
    })) : [],
    completedCount: Math.max(0, Math.floor(finiteNumber(record?.completedCount, 0))),
    maxQueue: Math.max(0, Math.floor(finiteNumber(record?.maxQueue, 0)))
  };
}

function inferAgentEndpoint(agent = {}) {
  return normalizeStairEndpoint({
    floorIndex: agent.floor ?? agent.floorIndex,
    cx: agent.cx ?? agent.x,
    cy: agent.cy ?? agent.y
  });
}

/** Queue an agent. Capacity is applied by stepStairTraffic. */
export function enqueueStairTransition(stateInput, linkInput, agentOrId, fromInput = null, queuedAtSec = null) {
  const link = normalizeStairLink(linkInput);
  const state = stateInput || createStairTrafficState([link]);
  const agentId = typeof agentOrId === "object" ? agentOrId?.id : agentOrId;
  if (agentId == null) return { state, status: "invalid", reason: "agent id is required" };
  const from = fromInput
    ? normalizeStairEndpoint(fromInput)
    : (typeof agentOrId === "object" ? inferAgentEndpoint(agentOrId) : link.from);
  const to = otherStairEndpoint(link, from);
  if (!to) return { state, status: "invalid", reason: "agent is not at a link endpoint" };

  const record = ensureTrafficRecord(state, link.id);
  const duplicate = record.queue.some(item => item.agentId === agentId) ||
    record.inTransit.some(item => item.agentId === agentId);
  if (duplicate) return { state, status: "duplicate", reason: "agent is already queued or in transit" };

  record.queue.push({
    agentId,
    from,
    to,
    queuedAtSec: Math.max(0, finiteNumber(queuedAtSec, state.elapsedSec || 0))
  });
  record.maxQueue = Math.max(record.maxQueue, record.queue.length);
  const nextState = {
    elapsedSec: Math.max(0, finiteNumber(state.elapsedSec, 0)),
    byLink: { ...(state.byLink || {}), [link.id]: record }
  };
  return { state: nextState, status: "queued", request: record.queue[record.queue.length - 1] };
}

function updateAgent(nextAgents, indexById, agentId, patch) {
  const index = indexById.get(agentId);
  if (index == null) return null;
  const previous = nextAgents[index];
  const next = { ...previous, ...patch };
  nextAgents[index] = next;
  return next;
}

/**
 * Advance all queues and transitions without mutating the traffic state or the
 * shared agent array. Consumers may assign the returned array back to state, or
 * use the emitted events to update an existing store in place.
 */
export function stepStairTraffic(stateInput, linksInput, agentsInput, dtSeconds) {
  const dt = Math.max(0, finiteNumber(dtSeconds, 0));
  const links = (Array.isArray(linksInput) ? linksInput : []).map(normalizeStairLink);
  const state = stateInput || createStairTrafficState(links);
  const agents = Array.isArray(agentsInput) ? agentsInput : [];
  const nextAgents = agents.slice();
  const indexById = new Map(agents.map((agent, index) => [agent.id, index]));
  const byLink = { ...(state.byLink || {}) };
  const started = [];
  const completed = [];

  for (const link of links) {
    const record = ensureTrafficRecord(state, link.id);
    const active = [];

    for (const transit of record.inTransit) {
      const remainingSec = Math.max(0, finiteNumber(transit.remainingSec, link.travelCostSec) - dt);
      if (remainingSec <= 0) {
        const previousAgent = agents[indexById.get(transit.agentId)];
        const restoredState = transit.previousBehaviorState && transit.previousBehaviorState !== "stair_transition"
          ? transit.previousBehaviorState
          : "normal";
        updateAgent(nextAgents, indexById, transit.agentId, {
          floorIndex: transit.to.floorIndex,
          floor: transit.to.floorIndex,
          cx: transit.to.cx,
          cy: transit.to.cy,
          x: transit.to.cx,
          y: transit.to.cy,
          behaviorState: restoredState,
          targetStair: null,
          stairTransition: null,
          stairTransitionCount: Math.max(0, finiteNumber(previousAgent?.stairTransitionCount, 0)) + 1
        });
        completed.push({ ...transit, linkId: link.id, completedAtSec: state.elapsedSec + dt });
        record.completedCount += 1;
      } else {
        const nextTransit = { ...transit, remainingSec };
        active.push(nextTransit);
        updateAgent(nextAgents, indexById, transit.agentId, {
          behaviorState: "stair_transition",
          targetStair: link.id,
          stairTransition: {
            status: "in_transit",
            linkId: link.id,
            from: { ...transit.from },
            to: { ...transit.to },
            remainingSec,
            travelCostSec: link.travelCostSec,
            progress: Math.max(0, Math.min(1, 1 - remainingSec / link.travelCostSec))
          }
        });
      }
    }

    record.inTransit = active;
    while (record.queue.length && record.inTransit.length < link.congestionCapacity) {
      const request = record.queue.shift();
      if (!indexById.has(request.agentId)) continue;
      const agent = nextAgents[indexById.get(request.agentId)];
      if (agent?.dead || agent?.finished) continue;
      const transit = {
        ...request,
        remainingSec: link.travelCostSec,
        startedAtSec: state.elapsedSec + dt,
        previousBehaviorState: agent?.behaviorState || "normal"
      };
      record.inTransit.push(transit);
      updateAgent(nextAgents, indexById, request.agentId, {
        behaviorState: "stair_transition",
        targetStair: link.id,
        stairTransition: {
          status: "in_transit",
          linkId: link.id,
          from: { ...request.from },
          to: { ...request.to },
          remainingSec: link.travelCostSec,
          travelCostSec: link.travelCostSec,
          progress: 0
        }
      });
      started.push({ ...transit, linkId: link.id });
    }

    for (const request of record.queue) {
      updateAgent(nextAgents, indexById, request.agentId, {
        behaviorState: "stair_transition",
        targetStair: link.id,
        stairTransition: {
          status: "queued",
          linkId: link.id,
          from: { ...request.from },
          to: { ...request.to },
          remainingSec: link.travelCostSec,
          travelCostSec: link.travelCostSec,
          progress: 0
        }
      });
    }

    record.maxQueue = Math.max(record.maxQueue, record.queue.length);
    byLink[link.id] = record;
  }

  const trafficState = {
    elapsedSec: Math.max(0, finiteNumber(state.elapsedSec, 0)) + dt,
    byLink
  };
  return {
    trafficState,
    agents: nextAgents,
    started,
    completed,
    congestion: getStairCongestion(trafficState, links)
  };
}

export function getStairCongestion(state, links = []) {
  return (Array.isArray(links) ? links : []).map(raw => {
    const link = normalizeStairLink(raw);
    const record = ensureTrafficRecord(state || {}, link.id);
    return {
      id: link.id,
      stairId: link.id,
      type: link.type,
      queued: record.queue.length,
      inTransit: record.inTransit.length,
      capacity: link.congestionCapacity,
      utilization: record.inTransit.length / link.congestionCapacity,
      completed: record.completedCount,
      maxQueue: record.maxQueue
    };
  });
}

export function stairSmokeTransferFactor(linkInput) {
  const link = normalizeStairLink(linkInput);
  const typeMeta = STAIR_TYPE_META[link.type] || STAIR_TYPE_META.indoor;
  return link.verticalSmokeTransfer * typeMeta.smokeRiseFactor;
}

/** Position used while an agent is visually travelling between floor grids. */
export function stairTransitionWorldPosition(transition, floors, options = {}) {
  if (!transition?.from || !transition?.to) return null;
  const progress = Math.max(0, Math.min(1, finiteNumber(transition.progress, 0)));
  const fromFloor = getFloorByIndex(floors, transition.from.floorIndex);
  const toFloor = getFloorByIndex(floors, transition.to.floorIndex);
  const from = gridToWorld(transition.from, { ...options, floor: fromFloor });
  const to = gridToWorld(transition.to, { ...options, floor: toFloor });
  return {
    worldX: from.worldX + (to.worldX - from.worldX) * progress,
    worldY: from.worldY + (to.worldY - from.worldY) * progress,
    worldZ: from.worldZ + (to.worldZ - from.worldZ) * progress
  };
}
