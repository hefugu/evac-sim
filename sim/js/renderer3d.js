/**
 * Dependency-free 2.5D renderer for the shared evacuation simulation state.
 *
 * This module deliberately owns no simulation clock and never mutates `state`.
 * Each visual frame reads state.map.floorStates and state.agents again, so the
 * 2D and 3D views always describe the same simulation.
 */

const TAU = Math.PI * 2;

const DEFAULT_LAYERS = Object.freeze({
  floors: true,
  walls: true,
  stairs: true,
  fire: true,
  smoke: true,
  exits: true,
  spawns: true,
  agents: true,
  hud: true
});

const LAYER_ALIASES = Object.freeze({
  floor: "floors",
  floors: "floors",
  wall: "walls",
  walls: "walls",
  stair: "stairs",
  stairs: "stairs",
  fire: "fire",
  fires: "fire",
  smoke: "smoke",
  exit: "exits",
  exits: "exits",
  spawn: "spawns",
  spawns: "spawns",
  agent: "agents",
  agents: "agents",
  hud: "hud"
});

const DEFAULT_OPTIONS = Object.freeze({
  cellSizeMeters: 0.5,
  floorHeightMeters: 3.5,
  wallHeightMeters: 2.8,
  fovDegrees: 50,
  nearPlaneMeters: 0.08,
  minCameraDistance: 2,
  maxCameraDistance: 5000,
  maxDevicePixelRatio: 2,
  maxSmokeSamples: 2400,
  smokeThreshold: 0.025,
  fireThreshold: 0.001,
  background: "#07121a",
  floorColor: "#d4d9dc",
  alternateFloorColor: "#c4cdd2",
  wallColor: "#17232b",
  wallEdgeColor: "rgba(126, 151, 162, 0.82)",
  autoResize: true,
  autoStart: false,
  showControlsHint: true
});

const AGENT_STYLES = Object.freeze({
  teacher: Object.freeze({ color: "#66ccff", outline: "#e8fbff", height: 1.72, width: 0.46, shape: "teacher" }),
  leader: Object.freeze({ color: "#66ffcc", outline: "#eafff9", height: 1.72, width: 0.46, shape: "teacher" }),
  student: Object.freeze({ color: "#7bb8ff", outline: "#eef6ff", height: 1.38, width: 0.38, shape: "student" }),
  child: Object.freeze({ color: "#8ad8ff", outline: "#f1fdff", height: 1.26, width: 0.36, shape: "student" }),
  panic: Object.freeze({ color: "#ff4f9a", outline: "#fff0f7", height: 1.62, width: 0.48, shape: "panic" }),
  elderly: Object.freeze({ color: "#ffd26b", outline: "#fff8dc", height: 1.58, width: 0.44, shape: "person" }),
  adult: Object.freeze({ color: "#ff6688", outline: "#fff0f3", height: 1.68, width: 0.44, shape: "person" }),
  default: Object.freeze({ color: "#ff6688", outline: "#fff0f3", height: 1.62, width: 0.42, shape: "person" })
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function lowerString(value, fallback = "") {
  return typeof value === "string" ? value.toLowerCase() : fallback;
}

function floorIndexOf(value, fallback = 0) {
  return Math.floor(finiteNumber(value?.floorIndex ?? value?.floor, fallback));
}

function endpointX(value) {
  return finiteNumber(value?.cx ?? value?.x, 0);
}

function endpointY(value) {
  return finiteNumber(value?.cy ?? value?.y, 0);
}

function rowWidth(source) {
  if (!Array.isArray(source)) return 0;
  let width = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (Array.isArray(source[index])) width = Math.max(width, source[index].length);
  }
  return width;
}

function mergeMaskRuns(mask, width, height) {
  const runs = [];
  let activeRuns = new Map();
  for (let cy = 0; cy < height; cy += 1) {
    const nextRuns = new Map();
    let cx = 0;
    while (cx < width) {
      while (cx < width && !mask[cy * width + cx]) cx += 1;
      if (cx >= width) break;
      const start = cx;
      while (cx < width && mask[cy * width + cx]) cx += 1;
      const end = cx;
      const key = `${start}:${end}`;
      const run = activeRuns.get(key) || { x0: start, x1: end, y0: cy, y1: cy + 1 };
      run.y1 = cy + 1;
      nextRuns.set(key, run);
    }
    activeRuns.forEach((run, key) => {
      if (!nextRuns.has(key)) runs.push(run);
    });
    activeRuns = nextRuns;
  }
  activeRuns.forEach(run => runs.push(run));
  return runs;
}

/** Groups adjacent stair cells into deterministic regions for rendering. */
export function groupStairCells3D(stairs = []) {
  const unique = new Map();
  for (const stair of Array.isArray(stairs) ? stairs : []) {
    const rawX = Number(stair?.cx ?? stair?.x);
    const rawY = Number(stair?.cy ?? stair?.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
    const floorIndex = floorIndexOf(stair, 0);
    const cx = Math.round(rawX);
    const cy = Math.round(rawY);
    unique.set(`${floorIndex}:${cx}:${cy}`, {
      ...stair,
      floorIndex,
      cx,
      cy,
      type: stair?.type || stair?.stairType || "indoor"
    });
  }

  const remaining = new Set(unique.keys());
  const regions = [];
  for (const firstKey of unique.keys()) {
    if (!remaining.has(firstKey)) continue;
    remaining.delete(firstKey);
    const queue = [unique.get(firstKey)];
    const cells = [];
    let minCx = Infinity;
    let minCy = Infinity;
    let maxCx = -Infinity;
    let maxCy = -Infinity;
    const regionType = queue[0].type;
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index];
      cells.push(cell);
      minCx = Math.min(minCx, cell.cx);
      minCy = Math.min(minCy, cell.cy);
      maxCx = Math.max(maxCx, cell.cx);
      maxCy = Math.max(maxCy, cell.cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${cell.floorIndex}:${cell.cx + dx}:${cell.cy + dy}`;
        if (!remaining.has(key)) continue;
        if (unique.get(key)?.type !== regionType) continue;
        remaining.delete(key);
        queue.push(unique.get(key));
      }
    }

    const width = maxCx - minCx + 1;
    const height = maxCy - minCy + 1;
    const localMask = new Uint8Array(width * height);
    cells.forEach(cell => {
      localMask[(cell.cy - minCy) * width + cell.cx - minCx] = 1;
    });
    const runs = mergeMaskRuns(localMask, width, height).map(run => ({
      x0: run.x0 + minCx,
      x1: run.x1 + minCx,
      y0: run.y0 + minCy,
      y1: run.y1 + minCy
    }));
    regions.push({
      floorIndex: cells[0].floorIndex,
      type: regionType,
      cells,
      runs,
      minCx,
      minCy,
      maxCx,
      maxCy,
      widthCells: width,
      heightCells: height
    });
  }
  return regions.sort((a, b) =>
    a.floorIndex - b.floorIndex || a.minCy - b.minCy || a.minCx - b.minCx
  );
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 1e-8)) return { ...fallback };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function animationNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
}

function requestVisualFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return { type: "raf", id: globalThis.requestAnimationFrame(callback) };
  }
  return { type: "timer", id: globalThis.setTimeout(() => callback(animationNow()), 16) };
}

function cancelVisualFrame(handle) {
  if (!handle) return;
  if (handle.type === "raf" && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle.id);
  } else if (handle.type === "timer") {
    globalThis.clearTimeout(handle.id);
  }
}

function makeNoContextApi() {
  const unavailable = () => ({ rendered: false, reason: "canvas_2d_unavailable" });
  return Object.freeze({
    start: unavailable,
    stop: unavailable,
    renderOnce: unavailable,
    resize: unavailable,
    destroy: unavailable,
    resetCamera: unavailable,
    setLayerVisibility: unavailable
  });
}

/**
 * Create an interactive Canvas-2D perspective renderer.
 *
 * @param {{canvas: HTMLCanvasElement, state: object|Function, options?: object}} input
 * @returns {{start: Function, stop: Function, renderOnce: Function, resize: Function,
 *   destroy: Function, resetCamera: Function, setLayerVisibility: Function}}
 */
export function createRenderer3D({ canvas, state, options = {} } = {}) {
  const context = canvas?.getContext?.("2d", { alpha: false });
  if (!context) return makeNoContextApi();

  const config = {
    ...DEFAULT_OPTIONS,
    ...(options || {})
  };
  config.cellSizeMeters = positiveNumber(config.cellSizeMeters, DEFAULT_OPTIONS.cellSizeMeters);
  config.floorHeightMeters = positiveNumber(config.floorHeightMeters, DEFAULT_OPTIONS.floorHeightMeters);
  config.wallHeightMeters = positiveNumber(config.wallHeightMeters, DEFAULT_OPTIONS.wallHeightMeters);
  config.fovDegrees = clamp(finiteNumber(config.fovDegrees, DEFAULT_OPTIONS.fovDegrees), 20, 100);
  config.maxSmokeSamples = Math.max(64, Math.floor(finiteNumber(config.maxSmokeSamples, DEFAULT_OPTIONS.maxSmokeSamples)));

  const layerVisibility = {
    ...DEFAULT_LAYERS,
    ...(options?.layers || options?.layerVisibility || {})
  };

  const camera = {
    target: { x: 0, y: 0.8, z: 0 },
    yaw: finiteNumber(options?.camera?.yaw, -0.72),
    pitch: clamp(finiteNumber(options?.camera?.pitch, 0.78), 0.08, 1.42),
    distance: positiveNumber(options?.camera?.distance, 18),
    fitted: false,
    userAdjusted: false
  };

  const viewport = { width: 300, height: 150, dpr: 1 };
  const listeners = [];
  let resizeObserver = null;
  let geometryCache = new WeakMap();
  let running = false;
  let destroyed = false;
  let frameHandle = null;
  let lastFloors = [];
  let lastRenderStats = null;
  let activePointerId = null;
  let pointerMode = "orbit";
  let pointerX = 0;
  let pointerY = 0;

  function readState() {
    try {
      const value = typeof state === "function" ? state() : state;
      return value && typeof value === "object" ? value : {};
    } catch (_error) {
      return {};
    }
  }

  function resolveFloors(snapshot) {
    const map = snapshot?.map || {};
    let sourceFloors = Array.isArray(map.floorStates) && map.floorStates.length
      ? map.floorStates
      : (Array.isArray(snapshot?.floors) ? snapshot.floors : []);

    if (!sourceFloors.length && (map.grid || map.baseWalkableTemplate || snapshot?.grid)) {
      sourceFloors = [{
        grid: map.grid || snapshot.grid,
        walkableTemplate: map.baseWalkableTemplate || snapshot.walkableTemplate,
        gridWidth: map.gridW || snapshot.gridW,
        gridHeight: map.gridH || snapshot.gridH,
        exits: snapshot.exits || map.allExitPoints,
        spawns: snapshot.spawns || map.allSpawnPoints,
        smokeMap: snapshot?.sim?.smokeMap,
        floorIndex: map.currentFloor ?? snapshot.currentFloor ?? 0
      }];
    }

    return sourceFloors.filter(Boolean).map((source, arrayIndex) => {
      const grid = Array.isArray(source.grid) ? source.grid : null;
      const template = Array.isArray(source.walkableTemplate)
        ? source.walkableTemplate
        : (Array.isArray(source.baseWalkableTemplate) ? source.baseWalkableTemplate : null);
      const smokeMap = Array.isArray(source.smokeMap) ? source.smokeMap : null;
      const width = Math.max(0, Math.floor(finiteNumber(
        source.gridWidth ?? source.gridW,
        Math.max(rowWidth(grid), rowWidth(template), rowWidth(smokeMap))
      )));
      const height = Math.max(0, Math.floor(finiteNumber(
        source.gridHeight ?? source.gridH,
        Math.max(grid?.length || 0, template?.length || 0, smokeMap?.length || 0)
      )));
      const floorIndex = floorIndexOf(source, arrayIndex);
      const floorHeight = positiveNumber(source.floorHeightMeters, config.floorHeightMeters);
      const cellSize = positiveNumber(source.cellSizeMeters, config.cellSizeMeters);
      return {
        source,
        grid,
        template,
        smokeMap,
        width,
        height,
        floorIndex,
        floorHeight,
        cellSize,
        elevation: floorIndex * floorHeight,
        wallHeight: positiveNumber(source.wallHeightMeters, config.wallHeightMeters),
        name: source.name || `${floorIndex + 1}F`,
        exits: Array.isArray(source.exits) ? source.exits : [],
        spawns: Array.isArray(source.spawns) ? source.spawns : [],
        stairs: Array.isArray(source.stairs) ? source.stairs : []
      };
    }).sort((a, b) => a.floorIndex - b.floorIndex);
  }

  function rawCellAt(floor, cx, cy) {
    const cell = floor.grid?.[cy]?.[cx];
    return cell && typeof cell === "object" ? cell : null;
  }

  function isWalkable(floor, cx, cy) {
    if (cx < 0 || cy < 0 || cx >= floor.width || cy >= floor.height) return false;
    const cell = floor.grid?.[cy]?.[cx];
    if (cell && typeof cell === "object" && cell.stair) return true;
    const template = floor.template?.[cy]?.[cx];
    if (typeof template === "boolean") return template;
    if (template && typeof template === "object") return !!template.walkable && !template.wall;
    if (cell && typeof cell === "object" && cell.walkable != null) {
      return !!cell.walkable && !cell.wall;
    }
    if (typeof cell === "boolean") return cell;
    return !!template;
  }

  function geometryVersion(floor) {
    const value = typeof config.geometryVersion === "function"
      ? config.geometryVersion(floor.source, floor.floorIndex)
      : (floor.source.geometryVersion ?? floor.source.topologyVersion ?? floor.source.walkableVersion ?? null);
    return value;
  }

  function cacheMatches(entry, floor) {
    return !!entry &&
      // A walkable template is the stable topology source while hazard models
      // may replace the richer grid object on every simulation step.
      (floor.template ? true : entry.grid === floor.grid) &&
      entry.template === floor.template &&
      entry.width === floor.width &&
      entry.height === floor.height &&
      entry.cellSize === floor.cellSize &&
      entry.version === geometryVersion(floor);
  }

  function buildGeometry(floor) {
    const { width, height } = floor;
    const mask = new Uint8Array(width * height);
    const stairMask = new Uint8Array(width * height);
    for (let cy = 0; cy < height; cy += 1) {
      const offset = cy * width;
      for (let cx = 0; cx < width; cx += 1) {
        const stair = !!rawCellAt(floor, cx, cy)?.stair || !!floor.source?.stairTemplate?.[cy]?.[cx];
        mask[offset + cx] = isWalkable(floor, cx, cy) || stair ? 1 : 0;
        stairMask[offset + cx] = stair ? 1 : 0;
      }
    }
    floor.stairs.forEach(stair => {
      const rawX = Number(stair?.cx ?? stair?.x);
      const rawY = Number(stair?.cy ?? stair?.y);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
      const cx = Math.round(rawX);
      const cy = Math.round(rawY);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) return;
      mask[cy * width + cx] = 1;
      stairMask[cy * width + cx] = 1;
    });

    // Merge equal horizontal walkable runs through consecutive rows. A large
    // 150x200 corridor therefore becomes a handful of floor polygons instead
    // of up to 30,000 individual cell polygons.
    const floorRuns = mergeMaskRuns(mask, width, height);
    const floorSurfaceMask = mask.slice();
    let hasStairs = false;
    for (let index = 0; index < floorSurfaceMask.length; index += 1) {
      if (!stairMask[index]) continue;
      floorSurfaceMask[index] = 0;
      hasStairs = true;
    }
    // When stair rendering is enabled, remove its footprint from the large
    // merged floor polygons. This prevents average-depth painter sorting from
    // covering a stair surface with the surrounding floor afterwards.
    const floorRunsWithoutStairs = hasStairs
      ? mergeMaskRuns(floorSurfaceMask, width, height)
      : floorRuns;

    // A wall exists only where a walkable cell meets a blocked/outside cell.
    // Collinear one-cell edges are merged into long boundary segments.
    const horizontalEdges = new Map();
    const verticalEdges = new Map();
    const markHorizontal = (edgeY, edgeX) => {
      let row = horizontalEdges.get(edgeY);
      if (!row) {
        row = new Uint8Array(width);
        horizontalEdges.set(edgeY, row);
      }
      row[edgeX] = 1;
    };
    const markVertical = (edgeX, edgeY) => {
      let column = verticalEdges.get(edgeX);
      if (!column) {
        column = new Uint8Array(height);
        verticalEdges.set(edgeX, column);
      }
      column[edgeY] = 1;
    };

    for (let cy = 0; cy < height; cy += 1) {
      for (let cx = 0; cx < width; cx += 1) {
        if (!mask[cy * width + cx]) continue;
        if (cy === 0 || !mask[(cy - 1) * width + cx]) markHorizontal(cy, cx);
        if (cy === height - 1 || !mask[(cy + 1) * width + cx]) markHorizontal(cy + 1, cx);
        if (cx === 0 || !mask[cy * width + cx - 1]) markVertical(cx, cy);
        if (cx === width - 1 || !mask[cy * width + cx + 1]) markVertical(cx + 1, cy);
      }
    }

    const walls = [];
    horizontalEdges.forEach((row, edgeY) => {
      let cx = 0;
      while (cx < width) {
        while (cx < width && !row[cx]) cx += 1;
        if (cx >= width) break;
        const start = cx;
        while (cx < width && row[cx]) cx += 1;
        walls.push({ axis: "x", fixed: edgeY, start, end: cx });
      }
    });
    verticalEdges.forEach((column, edgeX) => {
      let cy = 0;
      while (cy < height) {
        while (cy < height && !column[cy]) cy += 1;
        if (cy >= height) break;
        const start = cy;
        while (cy < height && column[cy]) cy += 1;
        walls.push({ axis: "z", fixed: edgeX, start, end: cy });
      }
    });

    return {
      grid: floor.grid,
      template: floor.template,
      width,
      height,
      cellSize: floor.cellSize,
      version: geometryVersion(floor),
      floorRuns,
      floorRunsWithoutStairs,
      hasStairs,
      walls
    };
  }

  function floorGeometry(floor) {
    const owner = floor.template ||
      (floor.source && typeof floor.source === "object" ? floor.source : floor.grid);
    if (!owner || typeof owner !== "object") return buildGeometry(floor);
    let entry = geometryCache.get(owner);
    if (!cacheMatches(entry, floor)) {
      entry = buildGeometry(floor);
      geometryCache.set(owner, entry);
    }
    return entry;
  }

  function sceneBounds(floors) {
    if (!floors.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    floors.forEach(floor => {
      let hasWalkable = false;
      for (let cy = 0; cy < floor.height; cy += 1) {
        for (let cx = 0; cx < floor.width; cx += 1) {
          if (!isWalkable(floor, cx, cy)) continue;
          hasWalkable = true;
          const half = floor.cellSize * 0.5;
          minX = Math.min(minX, cx * floor.cellSize - half);
          minZ = Math.min(minZ, cy * floor.cellSize - half);
          maxX = Math.max(maxX, cx * floor.cellSize + half);
          maxZ = Math.max(maxZ, cy * floor.cellSize + half);
        }
      }
      if (!hasWalkable) return;
      minY = Math.min(minY, floor.elevation);
      maxY = Math.max(maxY, floor.elevation + floor.wallHeight);
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  function fitCamera(floors, markAsReset = false) {
    const bounds = sceneBounds(floors);
    if (!bounds) {
      camera.target = { x: 0, y: 0.8, z: 0 };
      camera.distance = 18;
      camera.fitted = false;
      camera.userAdjusted = false;
      return cameraSnapshot();
    }
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
    const radius = 0.5 * Math.hypot(spanX, spanZ, spanY * 1.5);
    const halfFov = config.fovDegrees * Math.PI / 360;
    camera.target = {
      x: (bounds.minX + bounds.maxX) * 0.5,
      y: (bounds.minY + bounds.maxY) * 0.5,
      z: (bounds.minZ + bounds.maxZ) * 0.5
    };
    camera.yaw = finiteNumber(options?.camera?.yaw, -0.72);
    camera.pitch = clamp(finiteNumber(options?.camera?.pitch, 0.78), 0.08, 1.42);
    camera.distance = clamp(
      Math.max(4, radius / Math.max(0.1, Math.sin(halfFov)) * 1.12),
      config.minCameraDistance,
      config.maxCameraDistance
    );
    camera.fitted = true;
    camera.userAdjusted = false;
    if (markAsReset) geometryCache = new WeakMap();
    return cameraSnapshot();
  }

  function cameraSnapshot() {
    return {
      target: { ...camera.target },
      yaw: camera.yaw,
      pitch: camera.pitch,
      distance: camera.distance
    };
  }

  function cameraBasis() {
    const cosPitch = Math.cos(camera.pitch);
    const eye = {
      x: camera.target.x + Math.sin(camera.yaw) * cosPitch * camera.distance,
      y: camera.target.y + Math.sin(camera.pitch) * camera.distance,
      z: camera.target.z + Math.cos(camera.yaw) * cosPitch * camera.distance
    };
    const forward = normalize({
      x: camera.target.x - eye.x,
      y: camera.target.y - eye.y,
      z: camera.target.z - eye.z
    });
    const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
    const up = normalize(cross(right, forward), { x: 0, y: 1, z: 0 });
    const focal = (viewport.height * 0.5) /
      Math.tan(config.fovDegrees * Math.PI / 360);
    return { eye, forward, right, up, focal };
  }

  function project(point, basis) {
    const relative = {
      x: point.x - basis.eye.x,
      y: point.y - basis.eye.y,
      z: point.z - basis.eye.z
    };
    const depth = dot(relative, basis.forward);
    if (!(depth > config.nearPlaneMeters)) return null;
    const scale = basis.focal / depth;
    const x = viewport.width * 0.5 + dot(relative, basis.right) * scale;
    const y = viewport.height * 0.5 - dot(relative, basis.up) * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
    return { x, y, depth, scale };
  }

  function pushPolygon(primitives, points, basis, style = {}) {
    const projected = points.map(point => project(point, basis));
    if (projected.some(point => !point)) return null;
    const depth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;
    const primitive = { kind: "polygon", points: projected, depth, order: style.order ?? 0, ...style };
    primitives.push(primitive);
    return primitive;
  }

  function pushLine(primitives, from, to, basis, style = {}) {
    const a = project(from, basis);
    const b = project(to, basis);
    if (!a || !b) return;
    primitives.push({
      kind: "line",
      a,
      b,
      depth: (a.depth + b.depth) * 0.5,
      order: style.order ?? 2,
      ...style
    });
  }

  function pushMarker(primitives, kind, world, height, basis, style = {}) {
    const base = project(world, basis);
    const top = project({ x: world.x, y: world.y + height, z: world.z }, basis);
    if (!base || !top) return;
    primitives.push({
      kind,
      base,
      top,
      depth: (base.depth + top.depth) * 0.5,
      order: style.order ?? 4,
      ...style
    });
  }

  function worldForEndpoint(endpoint, floorByIndex, fallbackFloorIndex = 0) {
    const index = floorIndexOf(endpoint, fallbackFloorIndex);
    const floor = floorByIndex.get(index) || lastFloors[0];
    const cellSize = positiveNumber(endpoint?.cellSizeMeters, floor?.cellSize || config.cellSizeMeters);
    const elevation = floor?.elevation ?? index * positiveNumber(endpoint?.floorHeightMeters, config.floorHeightMeters);
    if (Number.isFinite(Number(endpoint?.worldX)) &&
        Number.isFinite(Number(endpoint?.worldY)) &&
        Number.isFinite(Number(endpoint?.worldZ))) {
      return {
        x: Number(endpoint.worldX),
        y: Number(endpoint.worldY),
        z: Number(endpoint.worldZ),
        floorIndex: index,
        cellSize
      };
    }
    return {
      x: endpointX(endpoint) * cellSize,
      y: elevation,
      z: endpointY(endpoint) * cellSize,
      floorIndex: index,
      cellSize
    };
  }

  function dynamicCells(floor, needStairs, needFire, needSmoke) {
    const stairs = [];
    const fires = [];
    const smoke = [];
    if (!needStairs && !needFire && !needSmoke) return { stairs, fires, smoke };

    const totalCells = floor.width * floor.height;
    const automaticStride = Math.max(1, Math.ceil(Math.sqrt(totalCells / config.maxSmokeSamples)));
    const smokeStride = Math.max(1, Math.floor(positiveNumber(config.smokeStride, automaticStride)));
    const smokeColumns = Math.ceil(floor.width / smokeStride);
    const smokeRows = Math.ceil(floor.height / smokeStride);
    const smokeMaxima = needSmoke ? new Float32Array(smokeColumns * smokeRows) : null;
    for (let cy = 0; cy < floor.height; cy += 1) {
      for (let cx = 0; cx < floor.width; cx += 1) {
        const cell = rawCellAt(floor, cx, cy);
        const stair = !!cell?.stair || !!floor.source?.stairTemplate?.[cy]?.[cx];
        if (needStairs && stair) {
          stairs.push({ cx, cy, type: cell?.stairType || cell?.type || "indoor" });
        }

        if (needFire) {
          const intensity = Math.max(0, finiteNumber(cell?.fireIntensity, cell?.fire ? 1 : 0));
          if (cell?.fire || intensity > config.fireThreshold) fires.push({ cx, cy, intensity: Math.max(0.12, intensity) });
        }

        if (needSmoke) {
          // Keep the maximum value in each sampled block. Sampling only the
          // block origin can make a one-cell hot spot disappear completely.
          const density = Math.max(
            0,
            finiteNumber(cell?.smokeDensity, 0),
            finiteNumber(floor.smokeMap?.[cy]?.[cx], 0),
            finiteNumber(cell?.smoke, 0)
          );
          const bucket = Math.floor(cy / smokeStride) * smokeColumns + Math.floor(cx / smokeStride);
          if (density > smokeMaxima[bucket]) smokeMaxima[bucket] = density;
        }
      }
    }
    if (needSmoke) {
      for (let row = 0; row < smokeRows; row += 1) {
        for (let column = 0; column < smokeColumns; column += 1) {
          const density = smokeMaxima[row * smokeColumns + column];
          if (density <= config.smokeThreshold) continue;
          smoke.push({
            cx: Math.min(floor.width - 1, column * smokeStride + (smokeStride - 1) * 0.5),
            cy: Math.min(floor.height - 1, row * smokeStride + (smokeStride - 1) * 0.5),
            density,
            stride: smokeStride
          });
        }
      }
    }
    return { stairs, fires, smoke };
  }

  function addFloorPrimitives(primitives, floor, geometry, basis) {
    const cell = floor.cellSize;
    const y = floor.elevation;
    if (layerVisibility.floors) {
      const color = Math.abs(floor.floorIndex) % 2
        ? config.alternateFloorColor
        : config.floorColor;
      const floorRuns = layerVisibility.stairs && geometry.hasStairs
        ? geometry.floorRunsWithoutStairs
        : geometry.floorRuns;
      floorRuns.forEach(run => {
        const x0 = (run.x0 - 0.5) * cell;
        const x1 = (run.x1 - 0.5) * cell;
        const z0 = (run.y0 - 0.5) * cell;
        const z1 = (run.y1 - 0.5) * cell;
        pushPolygon(primitives, [
          { x: x0, y, z: z0 },
          { x: x1, y, z: z0 },
          { x: x1, y, z: z1 },
          { x: x0, y, z: z1 }
        ], basis, {
          fill: color,
          stroke: "rgba(255,255,255,0.16)",
          lineWidth: 0.55,
          order: 0
        });
      });
    }

    if (layerVisibility.walls) {
      geometry.walls.forEach(wall => {
        let a;
        let b;
        if (wall.axis === "x") {
          const z = (wall.fixed - 0.5) * cell;
          a = { x: (wall.start - 0.5) * cell, y, z };
          b = { x: (wall.end - 0.5) * cell, y, z };
        } else {
          const x = (wall.fixed - 0.5) * cell;
          a = { x, y, z: (wall.start - 0.5) * cell };
          b = { x, y, z: (wall.end - 0.5) * cell };
        }
        const topA = { ...a, y: y + floor.wallHeight };
        const topB = { ...b, y: y + floor.wallHeight };
        pushPolygon(primitives, [a, b, topB, topA], basis, {
          fill: config.wallColor,
          stroke: config.wallEdgeColor,
          lineWidth: 0.7,
          alpha: 0.9,
          order: 3
        });
        pushLine(primitives, topA, topB, basis, {
          stroke: "rgba(210,230,236,0.56)",
          lineWidth: 0.75,
          order: 3
        });
      });
    }
  }

  function stairKey(floorIndex, cx, cy) {
    return `${floorIndex}:${Math.round(cx)}:${Math.round(cy)}`;
  }

  function normalizeStairEndpoints(link) {
    if (!link || typeof link !== "object") return null;
    const from = link.from || link.a;
    const to = link.to || link.b;
    return from && to ? { from, to, type: link.type || "indoor" } : null;
  }

  function collectStairs(snapshot, floors, dynamicByFloor) {
    const floorByIndex = new Map(floors.map(floor => [floor.floorIndex, floor]));
    const landings = new Map();
    const links = [];
    floors.forEach(floor => {
      const dynamic = dynamicByFloor.get(floor.floorIndex);
      dynamic?.stairs.forEach(stair => landings.set(stairKey(floor.floorIndex, stair.cx, stair.cy), {
        ...stair,
        floorIndex: floor.floorIndex
      }));
      floor.stairs.forEach(stair => {
        if (stair?.from && stair?.to) links.push({ from: stair.from, to: stair.to, type: stair.type });
        if (Number.isFinite(Number(stair?.cx ?? stair?.x))) {
          const floorIndex = floorIndexOf(stair, floor.floorIndex);
          landings.set(stairKey(floorIndex, endpointX(stair), endpointY(stair)), {
            cx: endpointX(stair),
            cy: endpointY(stair),
            floorIndex,
            type: stair.type || stair.stairType || "indoor"
          });
        }
      });
    });

    const rawLinks = snapshot?.map?.stairLinks || snapshot?.stairLinks || [];
    if (Array.isArray(rawLinks)) {
      rawLinks.forEach(raw => {
        const link = normalizeStairEndpoints(raw);
        if (link) links.push(link);
      });
    }
    links.forEach(link => {
      [link.from, link.to].forEach(endpoint => {
        const floorIndex = floorIndexOf(endpoint, 0);
        landings.set(stairKey(floorIndex, endpointX(endpoint), endpointY(endpoint)), {
          cx: endpointX(endpoint),
          cy: endpointY(endpoint),
          floorIndex,
          type: link.type || "indoor"
        });
      });
    });
    const landingCells = [...landings.values()];
    return {
      landings: landingCells,
      regions: groupStairCells3D(landingCells),
      links,
      floorByIndex
    };
  }

  function addStairPrimitives(primitives, stairs, basis) {
    const { landings, regions, links, floorByIndex } = stairs;
    regions.forEach(region => {
      const floor = floorByIndex.get(region.floorIndex);
      if (!floor) return;
      const cell = floor.cellSize || config.cellSizeMeters;
      const baseY = floor.elevation + 0.012;
      const topY = floor.elevation + clamp(cell * 0.28, 0.09, 0.16);
      const palette = region.type === "emergency"
        ? { top: "#ffd34d", side: "#8a5a08", edge: "#fff4be", tread: "#5c3900" }
        : (region.type === "outdoor"
            ? { top: "#20d8c4", side: "#08766e", edge: "#d9fffb", tread: "#034a45" }
            : { top: "#28e36f", side: "#08763a", edge: "#ddffe9", tread: "#034524" });
      const topDepths = [];

      region.runs.forEach(run => {
        const x0 = (run.x0 - 0.5) * cell;
        const x1 = (run.x1 - 0.5) * cell;
        const z0 = (run.y0 - 0.5) * cell;
        const z1 = (run.y1 - 0.5) * cell;
        pushPolygon(primitives, [
          { x: x0, y: baseY, z: z0 },
          { x: x1, y: baseY, z: z0 },
          { x: x1, y: topY, z: z0 },
          { x: x0, y: topY, z: z0 }
        ], basis, { fill: palette.side, stroke: palette.edge, lineWidth: 0.7, order: 2 });
        pushPolygon(primitives, [
          { x: x1, y: baseY, z: z0 },
          { x: x1, y: baseY, z: z1 },
          { x: x1, y: topY, z: z1 },
          { x: x1, y: topY, z: z0 }
        ], basis, { fill: palette.side, stroke: palette.edge, lineWidth: 0.7, order: 2 });
        pushPolygon(primitives, [
          { x: x1, y: baseY, z: z1 },
          { x: x0, y: baseY, z: z1 },
          { x: x0, y: topY, z: z1 },
          { x: x1, y: topY, z: z1 }
        ], basis, { fill: palette.side, stroke: palette.edge, lineWidth: 0.7, order: 2 });
        pushPolygon(primitives, [
          { x: x0, y: baseY, z: z1 },
          { x: x0, y: baseY, z: z0 },
          { x: x0, y: topY, z: z0 },
          { x: x0, y: topY, z: z1 }
        ], basis, { fill: palette.side, stroke: palette.edge, lineWidth: 0.7, order: 2 });
        const topPrimitive = pushPolygon(primitives, [
          { x: x0, y: topY, z: z0 },
          { x: x1, y: topY, z: z0 },
          { x: x1, y: topY, z: z1 },
          { x: x0, y: topY, z: z1 }
        ], basis, {
          fill: palette.top,
          stroke: palette.edge,
          lineWidth: 1.45,
          alpha: 0.98,
          order: 3
        });
        if (topPrimitive) topDepths.push(topPrimitive.depth);
      });

      const x0 = (region.minCx - 0.5) * cell;
      const x1 = (region.maxCx + 0.5) * cell;
      const z0 = (region.minCy - 0.5) * cell;
      const z1 = (region.maxCy + 0.5) * cell;
      const alongZ = region.heightCells >= region.widthCells;
      const longCells = alongZ ? region.heightCells : region.widthCells;
      const treadCount = Math.min(11, Math.max(4, longCells - 1));
      const inset = Math.min(cell * 0.28, (alongZ ? x1 - x0 : z1 - z0) * 0.08);
      // Use the same sort depth as the top surface. `order: 4` then reliably
      // paints tread lines after the opaque top instead of losing far-side
      // lines to tiny average-depth differences.
      const treadDepth = topDepths.length
        ? topDepths.reduce((sum, depth) => sum + depth, 0) / topDepths.length
        : undefined;
      const treadStyle = {
        stroke: palette.tread,
        lineWidth: 1.15,
        alpha: 0.96,
        order: 4,
        ...(Number.isFinite(treadDepth) ? { depth: treadDepth } : {})
      };
      for (let step = 1; step <= treadCount; step += 1) {
        const ratio = step / (treadCount + 1);
        if (alongZ) {
          const z = z0 + (z1 - z0) * ratio;
          pushLine(primitives,
            { x: x0 + inset, y: topY + 0.009, z },
            { x: x1 - inset, y: topY + 0.009, z },
            basis,
            treadStyle
          );
        } else {
          const x = x0 + (x1 - x0) * ratio;
          pushLine(primitives,
            { x, y: topY + 0.009, z: z0 + inset },
            { x, y: topY + 0.009, z: z1 - inset },
            basis,
            treadStyle
          );
        }
      }
    });

    links.forEach(link => {
      const from = worldForEndpoint(link.from, floorByIndex, 0);
      const to = worldForEndpoint(link.to, floorByIndex, from.floorIndex);
      pushLine(primitives,
        { x: from.x, y: from.y + 0.16, z: from.z },
        { x: to.x, y: to.y + 0.16, z: to.z },
        basis,
        {
          stroke: link.type === "outdoor" ? "#7de0ff" : (link.type === "emergency" ? "#ffd166" : "#54f2cf"),
          lineWidth: 2.25,
          alpha: 0.92,
          order: 3
        }
      );
    });
    return { cells: landings.length, regions: regions.length };
  }

  function addHazardPrimitives(primitives, floor, dynamic, basis, timestamp) {
    const cell = floor.cellSize;
    if (layerVisibility.smoke) {
      dynamic.smoke.forEach(sample => {
        const density = clamp(sample.density, 0, 2.5);
        const world = {
          x: sample.cx * cell,
          y: floor.elevation + floor.wallHeight * 0.67,
          z: sample.cy * cell
        };
        const projected = project(world, basis);
        if (!projected) return;
        primitives.push({
          kind: "smoke",
          center: projected,
          depth: projected.depth,
          order: 5,
          radius: Math.max(cell * sample.stride * 0.58, 0.28),
          density,
          phase: ((sample.cx * 17 + sample.cy * 31 + floor.floorIndex * 13) % 97) / 97,
          timestamp
        });
      });
    }

    if (layerVisibility.fire) {
      dynamic.fires.forEach(fire => {
        const world = {
          x: fire.cx * cell,
          y: floor.elevation + 0.03,
          z: fire.cy * cell
        };
        const height = 0.55 + clamp(fire.intensity, 0, 1) * 1.15;
        pushMarker(primitives, "fire", world, height, basis, {
          intensity: fire.intensity,
          phase: ((fire.cx * 19 + fire.cy * 29 + floor.floorIndex * 7) % 101) / 101,
          timestamp,
          order: 6
        });
      });
    }
  }

  function collectEndpoints(snapshot, floors, kind) {
    const output = new Map();
    const add = (endpoint, fallbackFloor) => {
      if (!endpoint || typeof endpoint !== "object") return;
      const floorIndex = floorIndexOf(endpoint, fallbackFloor);
      const key = `${floorIndex}:${endpointX(endpoint)}:${endpointY(endpoint)}`;
      if (!output.has(key)) output.set(key, { ...endpoint, floorIndex });
    };
    floors.forEach(floor => {
      const list = kind === "exit" ? floor.exits : floor.spawns;
      list.forEach(endpoint => add(endpoint, floor.floorIndex));
    });
    const map = snapshot?.map || {};
    const globalList = kind === "exit" ? map.allExitPoints : map.allSpawnPoints;
    if (Array.isArray(globalList)) globalList.forEach(endpoint => add(endpoint, 0));
    const legacy = kind === "exit" ? snapshot?.exits : snapshot?.spawns;
    const currentFloor = finiteNumber(map.currentFloor ?? snapshot?.currentFloor, 0);
    if (Array.isArray(legacy)) legacy.forEach(endpoint => add(endpoint, currentFloor));
    return [...output.values()];
  }

  function addEndpointPrimitives(primitives, snapshot, floors, basis) {
    const floorByIndex = new Map(floors.map(floor => [floor.floorIndex, floor]));
    if (layerVisibility.exits) {
      collectEndpoints(snapshot, floors, "exit").forEach((endpoint, index) => {
        const world = worldForEndpoint(endpoint, floorByIndex, 0);
        pushMarker(primitives, "exit", { x: world.x, y: world.y + 0.04, z: world.z }, 1.22, basis, {
          label: endpoint.label || endpoint.name || String(index + 1),
          order: 7
        });
      });
    }
    if (layerVisibility.spawns) {
      collectEndpoints(snapshot, floors, "spawn").forEach(endpoint => {
        const world = worldForEndpoint(endpoint, floorByIndex, 0);
        pushMarker(primitives, "spawn", { x: world.x, y: world.y + 0.035, z: world.z }, 0.65, basis, {
          order: 4
        });
      });
    }
  }

  function transitionWorldPosition(agent, floorByIndex) {
    const transition = agent?.stairTransition;
    if (!transition?.from || !transition?.to || transition.status === "queued") return null;
    const progress = clamp(finiteNumber(transition.progress, 0), 0, 1);
    const from = worldForEndpoint(transition.from, floorByIndex, floorIndexOf(agent, 0));
    const to = worldForEndpoint(transition.to, floorByIndex, from.floorIndex);
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      z: from.z + (to.z - from.z) * progress
    };
  }

  function agentWorldPosition(agent, floorByIndex) {
    const transition = transitionWorldPosition(agent, floorByIndex);
    if (transition) return transition;
    const hasWorld = Number.isFinite(Number(agent?.worldX)) &&
      Number.isFinite(Number(agent?.worldY)) &&
      Number.isFinite(Number(agent?.worldZ));
    if (hasWorld) {
      return { x: Number(agent.worldX), y: Number(agent.worldY), z: Number(agent.worldZ) };
    }
    const floorIndex = floorIndexOf(agent, 0);
    const floor = floorByIndex.get(floorIndex) || lastFloors[0];
    const cell = floor?.cellSize || config.cellSizeMeters;
    return {
      x: finiteNumber(agent?.x ?? agent?.cx, 0) * cell,
      y: floor?.elevation ?? floorIndex * config.floorHeightMeters,
      z: finiteNumber(agent?.y ?? agent?.cy, 0) * cell
    };
  }

  function addAgentPrimitives(primitives, snapshot, floors, basis) {
    if (!layerVisibility.agents) return;
    const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
    const floorByIndex = new Map(floors.map(floor => [floor.floorIndex, floor]));
    agents.forEach(agent => {
      if (!agent || typeof agent !== "object") return;
      const type = lowerString(agent.type, "default");
      const style = AGENT_STYLES[type] || AGENT_STYLES.default;
      const world = agentWorldPosition(agent, floorByIndex);
      const base = project({ x: world.x, y: world.y + 0.04, z: world.z }, basis);
      const top = project({ x: world.x, y: world.y + style.height, z: world.z }, basis);
      if (!base || !top) return;
      const behavior = lowerString(agent.behaviorState, "normal");
      primitives.push({
        kind: "agent",
        base,
        top,
        depth: (base.depth + top.depth) * 0.5,
        order: 8,
        style,
        type,
        behavior,
        dead: !!agent.dead,
        fallen: !!agent.fallen,
        finished: !!agent.finished,
        opacity: agent.dead ? 0.95 : clamp(finiteNumber(agent.visibility, 1), 0.25, 1),
        widthMeters: style.width,
        id: agent.id
      });
    });
  }

  function drawPolygon(primitive) {
    const points = primitive.points;
    context.save();
    context.globalAlpha = primitive.alpha ?? 1;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
    context.closePath();
    if (primitive.fill) {
      context.fillStyle = primitive.fill;
      context.fill();
    }
    if (primitive.stroke && primitive.lineWidth > 0) {
      context.strokeStyle = primitive.stroke;
      context.lineWidth = primitive.lineWidth;
      context.stroke();
    }
    context.restore();
  }

  function drawLine(primitive) {
    context.save();
    context.globalAlpha = primitive.alpha ?? 1;
    context.strokeStyle = primitive.stroke || "#ffffff";
    context.lineWidth = primitive.lineWidth || 1;
    context.lineCap = primitive.lineCap || "round";
    if (primitive.dash && context.setLineDash) context.setLineDash(primitive.dash);
    context.beginPath();
    context.moveTo(primitive.a.x, primitive.a.y);
    context.lineTo(primitive.b.x, primitive.b.y);
    context.stroke();
    context.restore();
  }

  function drawSmoke(primitive, focal) {
    const density = clamp(primitive.density / 1.8, 0, 1);
    const pulse = 0.94 + Math.sin(primitive.timestamp * 0.00045 + primitive.phase * TAU) * 0.06;
    const radius = clamp(primitive.radius * focal / primitive.center.depth * pulse, 2.5, 54);
    const gray = Math.round(174 - density * 116);
    context.save();
    context.globalAlpha = 0.1 + density * 0.38;
    context.fillStyle = `rgb(${gray}, ${gray + 4}, ${gray + 8})`;
    context.beginPath();
    context.ellipse(primitive.center.x - radius * 0.28, primitive.center.y, radius * 0.68, radius * 0.42, 0, 0, TAU);
    context.ellipse(primitive.center.x + radius * 0.2, primitive.center.y - radius * 0.16, radius * 0.62, radius * 0.48, 0, 0, TAU);
    context.ellipse(primitive.center.x + radius * 0.36, primitive.center.y + radius * 0.14, radius * 0.52, radius * 0.36, 0, 0, TAU);
    context.fill();
    context.restore();
  }

  function drawFire(primitive) {
    const height = Math.max(5, primitive.base.y - primitive.top.y);
    const flicker = 0.82 + 0.18 * Math.sin(primitive.timestamp * 0.012 + primitive.phase * TAU);
    const width = clamp(height * (0.25 + clamp(primitive.intensity, 0, 1) * 0.13) * flicker, 3, 24);
    const x = primitive.base.x;
    const bottom = primitive.base.y;
    const top = bottom - height * flicker;
    context.save();
    context.globalCompositeOperation = "lighter";
    context.fillStyle = "rgba(255, 74, 18, 0.88)";
    context.beginPath();
    context.moveTo(x, top);
    context.bezierCurveTo(x + width * 0.18, top + height * 0.34, x + width, bottom - height * 0.27, x + width * 0.58, bottom);
    context.lineTo(x - width * 0.58, bottom);
    context.bezierCurveTo(x - width, bottom - height * 0.25, x - width * 0.15, top + height * 0.35, x, top);
    context.fill();
    context.fillStyle = "rgba(255, 229, 72, 0.92)";
    context.beginPath();
    context.moveTo(x, top + height * 0.36);
    context.quadraticCurveTo(x + width * 0.48, bottom - height * 0.18, x + width * 0.24, bottom);
    context.lineTo(x - width * 0.25, bottom);
    context.quadraticCurveTo(x - width * 0.36, bottom - height * 0.18, x, top + height * 0.36);
    context.fill();
    context.restore();
  }

  function drawExit(primitive) {
    const height = Math.max(10, primitive.base.y - primitive.top.y);
    const width = clamp(height * 0.82, 12, 38);
    const signHeight = clamp(height * 0.42, 10, 22);
    const x = primitive.top.x;
    const y = primitive.top.y;
    context.save();
    context.shadowColor = "rgba(35, 255, 130, 0.65)";
    context.shadowBlur = 8;
    context.fillStyle = "#16c66d";
    context.strokeStyle = "#dfffee";
    context.lineWidth = 1;
    context.fillRect(x - width * 0.5, y, width, signHeight);
    context.strokeRect(x - width * 0.5, y, width, signHeight);
    context.shadowBlur = 0;
    context.fillStyle = "#ffffff";
    context.font = `700 ${clamp(signHeight * 0.5, 7, 11)}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`EXIT ${primitive.label}`, x, y + signHeight * 0.5);
    context.restore();
  }

  function drawSpawn(primitive) {
    const height = Math.max(6, primitive.base.y - primitive.top.y);
    const radius = clamp(height * 0.42, 4, 14);
    context.save();
    context.strokeStyle = "#44f1c2";
    context.fillStyle = "rgba(68, 241, 194, 0.18)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(primitive.base.x, primitive.base.y, radius, 0, TAU);
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(primitive.base.x, primitive.base.y);
    context.lineTo(primitive.top.x, primitive.top.y);
    context.stroke();
    context.restore();
  }

  function drawAgent(primitive) {
    const { base, top, style } = primitive;
    const height = Math.max(5, Math.hypot(base.x - top.x, base.y - top.y));
    const width = clamp(height * (primitive.widthMeters / style.height), 3.2, 18);
    const headRadius = clamp(width * 0.36, 1.8, 6);
    const dx = base.x - top.x;
    const dy = base.y - top.y;
    const length = Math.max(1e-6, Math.hypot(dx, dy));
    const nx = -dy / length;
    const ny = dx / length;
    const head = {
      x: top.x + dx / length * headRadius,
      y: top.y + dy / length * headRadius
    };
    const shoulder = {
      x: top.x + dx * 0.32,
      y: top.y + dy * 0.32
    };
    const hip = {
      x: top.x + dx * 0.68,
      y: top.y + dy * 0.68
    };

    context.save();
    context.globalAlpha = primitive.finished ? primitive.opacity * 0.42 : primitive.opacity;
    context.lineCap = "round";
    context.lineJoin = "round";
    const color = primitive.dead ? "#25282b" : (primitive.fallen ? "#ff9f2f" : style.color);
    const outline = primitive.dead ? "#c43b3b" : style.outline;

    if (style.shape === "panic") {
      context.fillStyle = color;
      context.strokeStyle = outline;
      context.lineWidth = Math.max(1, width * 0.1);
      context.beginPath();
      context.moveTo(head.x, head.y - width * 0.78);
      context.lineTo(head.x + width * 0.72, hip.y);
      context.lineTo(base.x, base.y);
      context.lineTo(head.x - width * 0.72, hip.y);
      context.closePath();
      context.fill();
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = `800 ${clamp(width * 0.9, 7, 14)}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("!", head.x, shoulder.y + width * 0.18);
    } else {
      context.strokeStyle = outline;
      context.lineWidth = width + 2;
      context.beginPath();
      context.moveTo(shoulder.x, shoulder.y);
      context.lineTo(hip.x, hip.y);
      context.stroke();
      context.strokeStyle = color;
      context.lineWidth = width;
      context.stroke();
      context.fillStyle = color;
      context.strokeStyle = outline;
      context.lineWidth = 1.2;
      context.beginPath();
      context.arc(head.x, head.y, headRadius, 0, TAU);
      context.fill();
      context.stroke();
      if (style.shape === "teacher") {
        context.strokeStyle = "rgba(230, 255, 253, 0.95)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(shoulder.x, shoulder.y, width * 0.9, 0, TAU);
        context.stroke();
      } else if (style.shape === "student") {
        context.fillStyle = "rgba(255,255,255,0.9)";
        context.beginPath();
        context.arc(shoulder.x + nx * width * 0.16, shoulder.y + ny * width * 0.16, Math.max(1, width * 0.14), 0, TAU);
        context.fill();
      }
    }

    if (primitive.behavior === "panic_escape" && style.shape !== "panic") {
      context.strokeStyle = "#ff4f9a";
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(head.x, head.y, width * 0.92, 0, TAU);
      context.stroke();
    }
    if (primitive.dead) {
      context.strokeStyle = "#ff4a4a";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(base.x - width, base.y - width);
      context.lineTo(base.x + width, base.y + width);
      context.moveTo(base.x + width, base.y - width);
      context.lineTo(base.x - width, base.y + width);
      context.stroke();
    }
    context.restore();
  }

  function drawPrimitive(primitive, basis) {
    if (primitive.kind === "polygon") drawPolygon(primitive);
    else if (primitive.kind === "line") drawLine(primitive);
    else if (primitive.kind === "smoke") drawSmoke(primitive, basis.focal);
    else if (primitive.kind === "fire") drawFire(primitive);
    else if (primitive.kind === "exit") drawExit(primitive);
    else if (primitive.kind === "spawn") drawSpawn(primitive);
    else if (primitive.kind === "agent") drawAgent(primitive);
  }

  function clearCanvas() {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    context.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
    const gradient = context.createLinearGradient(0, 0, 0, viewport.height);
    gradient.addColorStop(0, config.background);
    gradient.addColorStop(1, "#102732");
    context.fillStyle = gradient;
    context.fillRect(0, 0, viewport.width, viewport.height);
  }

  function drawEmptyState() {
    const centerX = viewport.width * 0.5;
    const centerY = viewport.height * 0.5;
    context.save();
    context.fillStyle = "rgba(173, 213, 226, 0.18)";
    context.strokeStyle = "rgba(173, 213, 226, 0.48)";
    context.lineWidth = 1.25;
    const boxWidth = Math.min(440, Math.max(210, viewport.width - 48));
    const boxHeight = 112;
    context.fillRect(centerX - boxWidth * 0.5, centerY - boxHeight * 0.5, boxWidth, boxHeight);
    context.strokeRect(centerX - boxWidth * 0.5, centerY - boxHeight * 0.5, boxWidth, boxHeight);
    context.fillStyle = "#e6f5fa";
    context.font = "600 16px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("3D表示用の校舎マップがありません", centerX, centerY - 16);
    context.fillStyle = "#9fc2ce";
    context.font = "13px system-ui, sans-serif";
    context.fillText("2D画面でマップを読み込むか、3Fサンプルを選択してください。", centerX, centerY + 15);
    context.restore();
  }

  function drawHud(snapshot, floors, stats) {
    if (!layerVisibility.hud) return;
    const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
    const simTime = finiteNumber(snapshot?.sim?.time ?? snapshot?.simTime, 0);
    context.save();
    context.textAlign = "left";
    context.textBaseline = "top";
    context.font = "12px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.fillStyle = "rgba(5, 13, 18, 0.72)";
    context.fillRect(12, 12, 222, 46);
    context.fillStyle = "#d9eef5";
    context.fillText(`3D  floors ${floors.length}  agents ${agents.length}`, 22, 20);
    context.fillStyle = "#8eb6c5";
    context.fillText(`simulation t=${simTime.toFixed(1)}s`, 22, 39);

    const legendY = viewport.height - 31;
    const items = [
      { label: "teacher", color: AGENT_STYLES.teacher.color, shape: "square" },
      { label: "student", color: AGENT_STYLES.student.color, shape: "circle" },
      { label: "panic", color: AGENT_STYLES.panic.color, shape: "triangle" }
    ];
    context.fillStyle = "rgba(5, 13, 18, 0.72)";
    context.fillRect(12, legendY - 5, 278, 26);
    let x = 23;
    items.forEach(item => {
      context.fillStyle = item.color;
      context.beginPath();
      if (item.shape === "circle") context.arc(x, legendY + 7, 5, 0, TAU);
      else if (item.shape === "triangle") {
        context.moveTo(x, legendY + 1);
        context.lineTo(x + 6, legendY + 13);
        context.lineTo(x - 6, legendY + 13);
        context.closePath();
      } else context.rect(x - 5, legendY + 2, 10, 10);
      context.fill();
      context.fillStyle = "#d9eef5";
      context.fillText(item.label, x + 10, legendY + 1);
      x += item.label === "student" ? 91 : 84;
    });

    if (config.showControlsHint && viewport.width > 570) {
      const text = "drag: orbit   Shift/right drag: pan   wheel: zoom   double-click: reset";
      context.textAlign = "right";
      context.fillStyle = "rgba(5, 13, 18, 0.66)";
      const width = context.measureText(text).width + 20;
      context.fillRect(viewport.width - width - 12, 12, width, 26);
      context.fillStyle = "#a6c7d2";
      context.fillText(text, viewport.width - 22, 19);
    }

    if (config.debugStats) {
      context.textAlign = "right";
      context.fillStyle = "#89aebc";
      context.fillText(`primitives ${stats.primitives} / smoke ${stats.smokeSamples}`, viewport.width - 16, viewport.height - 20);
    }
    context.restore();
  }

  function dimensionsFromCanvas(explicitWidth, explicitHeight) {
    const rectangle = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : null;
    const currentDpr = positiveNumber(
      config.devicePixelRatio,
      typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1
    );
    const dpr = clamp(currentDpr, 1, positiveNumber(config.maxDevicePixelRatio, 2));
    const width = Math.max(1, finiteNumber(
      explicitWidth,
      rectangle?.width || canvas.clientWidth || canvas.width / dpr || 300
    ));
    const height = Math.max(1, finiteNumber(
      explicitHeight,
      rectangle?.height || canvas.clientHeight || canvas.height / dpr || 150
    ));
    return { width, height, dpr };
  }

  function resize(width, height) {
    if (destroyed) return { ...viewport };
    const next = dimensionsFromCanvas(width, height);
    viewport.width = next.width;
    viewport.height = next.height;
    viewport.dpr = next.dpr;
    const backingWidth = Math.max(1, Math.round(next.width * next.dpr));
    const backingHeight = Math.max(1, Math.round(next.height * next.dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    if (config.manageCanvasStyle && canvas.style) {
      if (Number.isFinite(Number(width))) canvas.style.width = `${next.width}px`;
      if (Number.isFinite(Number(height))) canvas.style.height = `${next.height}px`;
    }
    context.setTransform(next.dpr, 0, 0, next.dpr, 0, 0);
    return { ...viewport };
  }

  function ensureCanvasSize() {
    if (!config.autoResize) return;
    const next = dimensionsFromCanvas();
    if (Math.abs(next.width - viewport.width) > 0.25 ||
        Math.abs(next.height - viewport.height) > 0.25 ||
        next.dpr !== viewport.dpr ||
        canvas.width !== Math.round(next.width * next.dpr) ||
        canvas.height !== Math.round(next.height * next.dpr)) {
      resize();
    }
  }

  function renderOnce(timestamp = animationNow()) {
    if (destroyed) return { rendered: false, reason: "destroyed" };
    ensureCanvasSize();
    clearCanvas();
    const snapshot = readState();
    const floors = resolveFloors(snapshot);
    lastFloors = floors;
    const usableFloors = floors.filter(floor => floor.width > 0 && floor.height > 0);
    if (!usableFloors.length) {
      drawEmptyState();
      lastRenderStats = {
        rendered: true,
        empty: true,
        floors: 0,
        agents: 0,
        primitives: 0,
        smokeSamples: 0,
        stairCells: 0,
        stairRegions: 0
      };
      return { ...lastRenderStats };
    }
    if (!camera.fitted && !camera.userAdjusted) fitCamera(usableFloors);

    const basis = cameraBasis();
    const primitives = [];
    const dynamicByFloor = new Map();
    usableFloors.forEach(floor => {
      const geometry = floorGeometry(floor);
      addFloorPrimitives(primitives, floor, geometry, basis);
      const dynamic = dynamicCells(floor, layerVisibility.stairs, layerVisibility.fire, layerVisibility.smoke);
      dynamicByFloor.set(floor.floorIndex, dynamic);
      addHazardPrimitives(primitives, floor, dynamic, basis, timestamp);
    });

    const stairStats = layerVisibility.stairs
      ? addStairPrimitives(primitives, collectStairs(snapshot, usableFloors, dynamicByFloor), basis)
      : { cells: 0, regions: 0 };
    addEndpointPrimitives(primitives, snapshot, usableFloors, basis);
    addAgentPrimitives(primitives, snapshot, usableFloors, basis);

    primitives.sort((a, b) => (b.depth - a.depth) || (a.order - b.order));
    primitives.forEach(primitive => drawPrimitive(primitive, basis));
    const smokeSamples = [...dynamicByFloor.values()].reduce((sum, dynamic) => sum + dynamic.smoke.length, 0);
    const stats = {
      rendered: true,
      empty: false,
      floors: usableFloors.length,
      agents: Array.isArray(snapshot?.agents) ? snapshot.agents.length : 0,
      primitives: primitives.length,
      smokeSamples,
      stairCells: stairStats.cells,
      stairRegions: stairStats.regions
    };
    drawHud(snapshot, usableFloors, stats);
    lastRenderStats = stats;
    return { ...stats };
  }

  function frame(timestamp) {
    if (!running || destroyed) return;
    renderOnce(timestamp);
    frameHandle = requestVisualFrame(frame);
  }

  function start() {
    if (destroyed || running) return running;
    running = true;
    frameHandle = requestVisualFrame(frame);
    return true;
  }

  function stop() {
    if (!running && !frameHandle) return false;
    running = false;
    cancelVisualFrame(frameHandle);
    frameHandle = null;
    return true;
  }

  function resetCamera() {
    const snapshot = readState();
    const floors = resolveFloors(snapshot).filter(floor => floor.width > 0 && floor.height > 0);
    lastFloors = floors;
    const result = fitCamera(floors, true);
    if (!running) renderOnce();
    return result;
  }

  function setLayerVisibility(layer, visible) {
    if (layer && typeof layer === "object") {
      Object.entries(layer).forEach(([name, value]) => setLayerVisibility(name, value));
      return { ...layerVisibility };
    }
    const normalized = LAYER_ALIASES[lowerString(layer)];
    if (!normalized) return false;
    layerVisibility[normalized] = !!visible;
    if (!running && !destroyed) renderOnce();
    return layerVisibility[normalized];
  }

  function listen(target, type, handler, eventOptions) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, eventOptions);
    listeners.push(() => target.removeEventListener(type, handler, eventOptions));
  }

  function onPointerDown(event) {
    if (destroyed || activePointerId != null) return;
    activePointerId = event.pointerId;
    pointerX = event.clientX;
    pointerY = event.clientY;
    pointerMode = event.shiftKey || event.button === 1 || event.button === 2 ? "pan" : "orbit";
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
  }

  function onPointerMove(event) {
    if (destroyed || event.pointerId !== activePointerId) return;
    const dx = event.clientX - pointerX;
    const dy = event.clientY - pointerY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (pointerMode === "orbit") {
      camera.yaw -= dx * 0.006;
      camera.pitch = clamp(camera.pitch + dy * 0.005, 0.08, 1.42);
    } else {
      const basis = cameraBasis();
      const unitsPerPixel = 2 * camera.distance *
        Math.tan(config.fovDegrees * Math.PI / 360) / Math.max(1, viewport.height);
      const horizontal = -dx * unitsPerPixel;
      const vertical = dy * unitsPerPixel;
      camera.target.x += basis.right.x * horizontal + basis.up.x * vertical;
      camera.target.y += basis.right.y * horizontal + basis.up.y * vertical;
      camera.target.z += basis.right.z * horizontal + basis.up.z * vertical;
    }
    camera.userAdjusted = true;
    if (!running) renderOnce();
    event.preventDefault?.();
  }

  function releasePointer(event) {
    if (event.pointerId !== activePointerId) return;
    canvas.releasePointerCapture?.(event.pointerId);
    activePointerId = null;
    event.preventDefault?.();
  }

  function onWheel(event) {
    const delta = finiteNumber(event.deltaY, 0);
    camera.distance = clamp(
      camera.distance * Math.exp(delta * 0.00125),
      config.minCameraDistance,
      config.maxCameraDistance
    );
    camera.userAdjusted = true;
    if (!running) renderOnce();
    event.preventDefault?.();
  }

  function destroy() {
    if (destroyed) return false;
    stop();
    destroyed = true;
    resizeObserver?.disconnect?.();
    resizeObserver = null;
    listeners.splice(0).forEach(remove => remove());
    geometryCache = new WeakMap();
    lastFloors = [];
    lastRenderStats = null;
    return true;
  }

  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(canvas, "pointerup", releasePointer);
  listen(canvas, "pointercancel", releasePointer);
  listen(canvas, "wheel", onWheel, { passive: false });
  listen(canvas, "contextmenu", event => event.preventDefault?.());
  listen(canvas, "dblclick", event => {
    event.preventDefault?.();
    resetCamera();
  });

  if (config.autoResize && typeof globalThis.ResizeObserver === "function") {
    resizeObserver = new globalThis.ResizeObserver(() => {
      resize();
      if (!running) renderOnce();
    });
    resizeObserver.observe(canvas);
  } else if (config.autoResize) {
    listen(globalThis, "resize", () => {
      resize();
      if (!running) renderOnce();
    });
  }

  resize();
  const api = Object.freeze({
    start,
    stop,
    renderOnce,
    resize,
    destroy,
    resetCamera,
    setLayerVisibility
  });
  if (config.autoStart) start();
  return api;
}

export default createRenderer3D;
