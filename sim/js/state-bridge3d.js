const CHANNEL_NAME = "evac-sim-3d-view-v1";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function floorIndexOf(value, fallback = 0) {
  return Math.floor(finiteNumber(value?.floorIndex ?? value?.floor, fallback));
}

function hasTopology(floor) {
  if (floor?.baseImage) return true;
  const template = floor?.walkableTemplate;
  if (Array.isArray(template) && template.some(row => row?.some(Boolean))) return true;
  return Array.isArray(floor?.grid) && floor.grid.some(row => row?.some(cell => cell?.walkable || cell?.stair));
}

function floorTemplate(floor) {
  if (Array.isArray(floor?.walkableTemplate)) {
    return floor.walkableTemplate.map(row => Array.isArray(row) ? row.map(Boolean) : []);
  }
  return Array.isArray(floor?.grid)
    ? floor.grid.map(row => Array.isArray(row) ? row.map(cell => !!(cell?.walkable || cell?.stair)) : [])
    : [];
}

function stairCells(floor) {
  if (Array.isArray(floor?.stairs) && floor.stairs.length) {
    return floor.stairs.map(stair => ({
      cx: Math.floor(finiteNumber(stair.cx ?? stair.x, 0)),
      cy: Math.floor(finiteNumber(stair.cy ?? stair.y, 0)),
      type: stair.type || stair.stairType || "indoor"
    }));
  }
  const cells = [];
  (floor?.grid || []).forEach((row, cy) => row?.forEach((cell, cx) => {
    if (cell?.stair) cells.push({ cx, cy, type: cell.stairType || "indoor" });
  }));
  return cells;
}

function compactEndpoint(endpoint = {}) {
  return {
    floorIndex: floorIndexOf(endpoint),
    floor: floorIndexOf(endpoint),
    cx: Math.floor(finiteNumber(endpoint.cx ?? endpoint.x, 0)),
    cy: Math.floor(finiteNumber(endpoint.cy ?? endpoint.y, 0))
  };
}

function compactAgent(agent = {}) {
  const transition = agent.stairTransition
    ? {
        status: agent.stairTransition.status,
        linkId: agent.stairTransition.linkId,
        from: compactEndpoint(agent.stairTransition.from),
        to: compactEndpoint(agent.stairTransition.to),
        remainingSec: finiteNumber(agent.stairTransition.remainingSec, 0),
        travelCostSec: finiteNumber(agent.stairTransition.travelCostSec, 0),
        progress: finiteNumber(agent.stairTransition.progress, 0)
      }
    : null;
  return {
    id: agent.id,
    x: finiteNumber(agent.x ?? agent.cx, 0),
    y: finiteNumber(agent.y ?? agent.cy, 0),
    cx: Math.round(finiteNumber(agent.cx ?? agent.x, 0)),
    cy: Math.round(finiteNumber(agent.cy ?? agent.y, 0)),
    floor: floorIndexOf(agent),
    floorIndex: floorIndexOf(agent),
    worldX: finiteNumber(agent.worldX, 0),
    worldY: finiteNumber(agent.worldY, 0),
    worldZ: finiteNumber(agent.worldZ, 0),
    type: agent.type || "student",
    behaviorState: agent.behaviorState || "normal",
    visibility: finiteNumber(agent.visibility, 1),
    smokeDose: finiteNumber(agent.smokeDose, 0),
    coDose: finiteNumber(agent.coDose ?? agent.coDosePpmMin, 0),
    heatDose: finiteNumber(agent.heatDose, 0),
    stuckTime: finiteNumber(agent.stuckTime, 0),
    targetExit: agent.targetExit ?? agent.targetExitIndex ?? null,
    targetStair: agent.targetStair ?? null,
    dead: !!agent.dead,
    fallen: !!agent.fallen,
    finished: !!agent.finished,
    stairTransition: transition
  };
}

function sourceFloors(state) {
  const floors = state?.map?.floorStates || state?.floors || [];
  return (Array.isArray(floors) ? floors : []).filter(hasTopology);
}

export function createGeometrySnapshot3D(state) {
  const floors = sourceFloors(state).map((floor, arrayIndex) => {
    const template = floorTemplate(floor);
    const floorIndex = floorIndexOf(floor, arrayIndex);
    return {
      floorIndex,
      name: floor.name || `${floorIndex + 1}F`,
      zMeters: finiteNumber(floor.zMeters ?? floor.elevationMeters, floorIndex * 3.5),
      elevationMeters: finiteNumber(floor.elevationMeters ?? floor.zMeters, floorIndex * 3.5),
      floorHeightMeters: finiteNumber(floor.floorHeightMeters, state?.spatial?.floorHeightMeters || 3.5),
      wallHeightMeters: finiteNumber(floor.wallHeightMeters, state?.spatial?.wallHeightMeters || 2.8),
      cellSizeMeters: finiteNumber(floor.cellSizeMeters, state?.spatial?.cellSizeMeters || 0.5),
      gridWidth: Math.max(0, Math.floor(finiteNumber(floor.gridWidth, template[0]?.length || 0))),
      gridHeight: Math.max(0, Math.floor(finiteNumber(floor.gridHeight, template.length))),
      walkableTemplate: template,
      stairs: stairCells(floor),
      exits: (floor.exits || []).map(exit => ({ cx: exit.cx, cy: exit.cy })),
      spawns: (floor.spawns || []).map(spawn => ({ cx: spawn.cx, cy: spawn.cy, r: spawn.r || 0 }))
    };
  });
  return {
    type: "geometry",
    geometryRevision: finiteNumber(state?.render?.geometryRevision, 0),
    floors,
    spatial: { ...(state?.spatial || {}) }
  };
}

export function createDynamicSnapshot3D(state) {
  const floors = sourceFloors(state).map((floor, arrayIndex) => {
    const fires = [];
    (floor.grid || []).forEach((row, cy) => row?.forEach((cell, cx) => {
      if (!cell?.fire && !(finiteNumber(cell?.fireIntensity, 0) > 0)) return;
      fires.push({
        cx,
        cy,
        fire: !!cell.fire,
        fireIntensity: finiteNumber(cell.fireIntensity, cell.fire ? 0.05 : 0),
        temperatureC: finiteNumber(cell.temperatureC, 20),
        heatFluxKwM2: finiteNumber(cell.heatFluxKwM2, 0)
      });
    }));
    return {
      floorIndex: floorIndexOf(floor, arrayIndex),
      smokeMap: Array.isArray(floor.smokeMap)
        ? floor.smokeMap.map(row => Array.isArray(row) ? row.map(value => finiteNumber(value, 0)) : [])
        : [],
      fires,
      exits: (floor.exits || []).map(exit => ({ cx: exit.cx, cy: exit.cy })),
      spawns: (floor.spawns || []).map(spawn => ({ cx: spawn.cx, cy: spawn.cy, r: spawn.r || 0 }))
    };
  });
  return {
    type: "dynamic",
    revision: finiteNumber(state?.render?.revision, 0),
    simTime: finiteNumber(state?.sim?.time ?? state?.simTime, 0),
    running: !!(state?.sim?.running ?? state?.simRunning),
    floors,
    agents: (state?.agents || []).map(compactAgent),
    stairLinks: (state?.map?.stairLinks || []).map(link => ({
      id: link.id,
      type: link.type || "indoor",
      from: compactEndpoint(link.from || link.a),
      to: compactEndpoint(link.to || link.b),
      widthMeters: finiteNumber(link.widthMeters, 1.5),
      travelCostSec: finiteNumber(link.travelCostSec, 8),
      verticalSmokeTransfer: finiteNumber(link.verticalSmokeTransfer, 0.35),
      congestionCapacity: Math.max(1, Math.floor(finiteNumber(link.congestionCapacity, 2)))
    }))
  };
}

function floorFromGeometry(source) {
  const template = source.walkableTemplate || [];
  const stairIndex = new Map((source.stairs || []).map(stair => [`${stair.cx}:${stair.cy}`, stair]));
  const grid = template.map((row, cy) => row.map((walkable, cx) => {
    const stair = stairIndex.get(`${cx}:${cy}`);
    return {
      walkable: !!walkable || !!stair,
      wall: !walkable && !stair,
      stair: !!stair,
      stairType: stair?.type || null,
      fire: false,
      fireIntensity: 0,
      temperatureC: 20,
      heatFluxKwM2: 0
    };
  }));
  return {
    ...source,
    grid,
    smokeMap: template.map(row => row.map(() => 0)),
    smokeCeil: template.map(row => row.map(() => false))
  };
}

export function apply3DBridgeMessage(targetState, message) {
  if (!targetState || !message) return false;
  if (message.type === "geometry") {
    targetState.map ||= {};
    targetState.render ||= {};
    targetState.spatial = { ...(targetState.spatial || {}), ...(message.spatial || {}) };
    targetState.map.floorStates = (message.floors || []).map(floorFromGeometry);
    targetState.floors = targetState.map.floorStates;
    targetState.render.geometryRevision = message.geometryRevision || 0;
    return true;
  }
  if (message.type !== "dynamic") return false;
  targetState.map ||= {};
  targetState.sim ||= {};
  const floors = targetState.map.floorStates || [];
  (message.floors || []).forEach(update => {
    const floor = floors.find(item => floorIndexOf(item) === floorIndexOf(update));
    if (!floor) return;
    for (const old of floor._bridgeFireCells || []) {
      const cell = floor.grid?.[old.cy]?.[old.cx];
      if (cell) Object.assign(cell, { fire: false, fireIntensity: 0, temperatureC: 20, heatFluxKwM2: 0 });
    }
    floor.smokeMap = update.smokeMap || floor.smokeMap;
    floor.exits = update.exits || [];
    floor.spawns = update.spawns || [];
    floor._bridgeFireCells = update.fires || [];
    for (const fire of floor._bridgeFireCells) {
      const cell = floor.grid?.[fire.cy]?.[fire.cx];
      if (cell) Object.assign(cell, fire);
    }
  });
  targetState.agents = message.agents || [];
  targetState.map.stairLinks = message.stairLinks || [];
  targetState.sim.time = message.simTime || 0;
  targetState.sim.running = !!message.running;
  targetState.simTime = targetState.sim.time;
  targetState.simRunning = targetState.sim.running;
  targetState.render ||= {};
  targetState.render.revision = message.revision || 0;
  return true;
}

export function create3DStatePublisher(state, options = {}) {
  if (typeof BroadcastChannel !== "function") {
    return { available: false, publishNow: () => false, destroy: () => {} };
  }
  const channel = new BroadcastChannel(options.channelName || CHANNEL_NAME);
  const intervalMs = Math.max(100, finiteNumber(options.intervalMs, 250));
  let timer = null;
  let lastGeometryRevision = -1;
  const clients = new Set();

  const publishGeometry = () => {
    channel.postMessage(createGeometrySnapshot3D(state));
    lastGeometryRevision = finiteNumber(state?.render?.geometryRevision, 0);
  };
  const publishNow = (forceGeometry = false) => {
    const revision = finiteNumber(state?.render?.geometryRevision, 0);
    if (forceGeometry || revision !== lastGeometryRevision) publishGeometry();
    channel.postMessage(createDynamicSnapshot3D(state));
    return true;
  };
  const startPublishing = () => {
    publishNow(true);
    if (!timer) timer = setInterval(() => publishNow(false), intervalMs);
  };
  channel.addEventListener("message", event => {
    if (event.data?.type === "hello") {
      clients.add(event.data.clientId || "anonymous");
      startPublishing();
    } else if (event.data?.type === "bye") {
      clients.delete(event.data.clientId || "anonymous");
      if (!clients.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  });
  return {
    available: true,
    publishNow,
    destroy() {
      if (timer) clearInterval(timer);
      timer = null;
      channel.close();
    }
  };
}

export function create3DStateReceiver(targetState, options = {}) {
  if (typeof BroadcastChannel !== "function") {
    return { available: false, connected: false, requestSnapshot: () => false, destroy: () => {} };
  }
  const channel = new BroadcastChannel(options.channelName || CHANNEL_NAME);
  const clientId = options.clientId || `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const receiver = {
    available: true,
    connected: false,
    requestSnapshot() {
      channel.postMessage({ type: "hello", clientId });
      return true;
    },
    destroy() {
      channel.postMessage({ type: "bye", clientId });
      channel.close();
    }
  };
  channel.addEventListener("message", event => {
    if (!apply3DBridgeMessage(targetState, event.data)) return;
    receiver.connected = true;
    options.onUpdate?.(event.data);
  });
  receiver.requestSnapshot();
  return receiver;
}
