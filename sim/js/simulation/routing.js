function finiteCell(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Infinity;
}

/**
 * Build a per-floor mask around active fire cells.
 * 1 = normally avoid for evacuation routing, 0 = available.
 */
export function buildFireAvoidanceMasks(
  floorStates,
  gridWidth,
  gridHeight,
  radiusCells = 3
) {
  const width = Math.max(0, Math.floor(Number(gridWidth) || 0));
  const height = Math.max(0, Math.floor(Number(gridHeight) || 0));
  const radius = Math.max(0, Number(radiusCells) || 0);
  const reach = Math.ceil(radius);
  const floors = Array.isArray(floorStates) ? floorStates : [];

  return floors.map(floor => {
    const mask = new Uint8Array(width * height);
    const grid = floor?.grid;
    if (!Array.isArray(grid) || width === 0 || height === 0) return mask;

    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (!grid?.[cy]?.[cx]?.fire) continue;
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (Math.hypot(dx, dy) > radius + 1e-9) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            mask[ny * width + nx] = 1;
          }
        }
      }
    }
    return mask;
  });
}

export function isFireAvoidanceBlocked(masks, floor, cx, cy, gridWidth) {
  const width = Math.max(0, Math.floor(Number(gridWidth) || 0));
  const index = Math.floor(Number(cy) || 0) * width + Math.floor(Number(cx) || 0);
  return !!masks?.[floor]?.[index];
}

export function buildNearestFireDistanceFields(
  floorStates,
  gridWidth,
  gridHeight
) {
  const width = Math.max(0, Math.floor(Number(gridWidth) || 0));
  const height = Math.max(0, Math.floor(Number(gridHeight) || 0));
  const floors = Array.isArray(floorStates) ? floorStates : [];
  const diagonal = Math.SQRT2;

  return floors.map(floor => {
    const distance = new Float32Array(width * height);
    distance.fill(Infinity);
    const grid = floor?.grid;
    if (!Array.isArray(grid) || width === 0 || height === 0) return distance;

    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (grid?.[cy]?.[cx]?.fire) distance[cy * width + cx] = 0;
      }
    }

    // Two-pass 8-neighbour distance transform. It is O(grid cells), which is
    // cheap enough to rebuild whenever fire topology changes and avoids
    // per-agent scans over every active flame.
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        const index = cy * width + cx;
        let best = distance[index];
        if (cx > 0) best = Math.min(best, distance[index - 1] + 1);
        if (cy > 0) best = Math.min(best, distance[index - width] + 1);
        if (cx > 0 && cy > 0) best = Math.min(best, distance[index - width - 1] + diagonal);
        if (cx + 1 < width && cy > 0) best = Math.min(best, distance[index - width + 1] + diagonal);
        distance[index] = best;
      }
    }

    for (let cy = height - 1; cy >= 0; cy--) {
      for (let cx = width - 1; cx >= 0; cx--) {
        const index = cy * width + cx;
        let best = distance[index];
        if (cx + 1 < width) best = Math.min(best, distance[index + 1] + 1);
        if (cy + 1 < height) best = Math.min(best, distance[index + width] + 1);
        if (cx + 1 < width && cy + 1 < height) best = Math.min(best, distance[index + width + 1] + diagonal);
        if (cx > 0 && cy + 1 < height) best = Math.min(best, distance[index + width - 1] + diagonal);
        distance[index] = best;
      }
    }

    return distance;
  });
}

export function fireDistanceAt(fields, floor, cx, cy, gridWidth) {
  const width = Math.max(0, Math.floor(Number(gridWidth) || 0));
  if (!width) return Infinity;
  const x = Math.floor(Number(cx));
  const y = Math.floor(Number(cy));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return Infinity;
  const value = fields?.[floor]?.[y * width + x];
  return Number.isFinite(value) ? value : Infinity;
}

export function moveApproachesFire(
  fields,
  fromFloor,
  fromCx,
  fromCy,
  toFloor,
  toCx,
  toCy,
  gridWidth,
  toleranceCells = 0.05
) {
  if (fromFloor !== toFloor) return false;
  const from = fireDistanceAt(fields, fromFloor, fromCx, fromCy, gridWidth);
  const to = fireDistanceAt(fields, toFloor, toCx, toCy, gridWidth);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return to + Math.max(0, Number(toleranceCells) || 0) < from;
}

/**
 * Extend an already-safe potential field only into the fire-avoidance zone.
 * This gives agents who are already inside the buffer a gradient back out
 * without making the blocked zone part of the normal safe route network.
 *
 * The large per-cell penalty makes the nearest safe boundary strongly
 * preferable to crossing the whole hazard buffer.
 */
export function extendPotentialIntoFireAvoidanceZone(
  safeField,
  floorStates,
  masks,
  gridWidth,
  gridHeight,
  isAgentTraversableCell,
  avoidanceStepPenalty = 50
) {
  const width = Math.max(0, Math.floor(Number(gridWidth) || 0));
  const height = Math.max(0, Math.floor(Number(gridHeight) || 0));
  if (!Array.isArray(safeField) || width === 0 || height === 0) return safeField;

  const result = safeField.map(floor =>
    Array.from({ length: height }, (_, cy) =>
      Array.from({ length: width }, (_, cx) => finiteCell(floor?.[cy]?.[cx]))
    )
  );

  const dirs = [
    { dx: 1, dy: 0, c: 1 }, { dx: -1, dy: 0, c: 1 },
    { dx: 0, dy: 1, c: 1 }, { dx: 0, dy: -1, c: 1 },
    { dx: 1, dy: 1, c: 1.414 }, { dx: -1, dy: 1, c: 1.414 },
    { dx: 1, dy: -1, c: 1.414 }, { dx: -1, dy: -1, c: 1.414 }
  ];

  for (let floor = 0; floor < result.length; floor++) {
    const queue = [];
    const queued = new Uint8Array(width * height);
    const push = (cx, cy) => {
      const index = cy * width + cx;
      if (queued[index]) return;
      queued[index] = 1;
      queue.push({ cx, cy });
    };

    // Only finite cells touching the blocked zone need to seed the extension.
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (!Number.isFinite(result[floor]?.[cy]?.[cx])) continue;
        for (const d of dirs) {
          const nx = cx + d.dx;
          const ny = cy + d.dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!isFireAvoidanceBlocked(masks, floor, nx, ny, width)) continue;
          push(cx, cy);
          break;
        }
      }
    }

    let qi = 0;
    while (qi < queue.length) {
      const { cx, cy } = queue[qi++];
      queued[cy * width + cx] = 0;
      const base = result[floor][cy][cx];
      if (!Number.isFinite(base)) continue;

      for (const d of dirs) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!isFireAvoidanceBlocked(masks, floor, nx, ny, width)) continue;
        if (!isAgentTraversableCell(floor, nx, ny)) continue;

        if (d.dx !== 0 && d.dy !== 0) {
          if (
            !isAgentTraversableCell(floor, cx + d.dx, cy) ||
            !isAgentTraversableCell(floor, cx, cy + d.dy)
          ) continue;
        }

        const next = base + d.c + Math.max(0, Number(avoidanceStepPenalty) || 0);
        if (next + 1e-9 >= result[floor][ny][nx]) continue;
        result[floor][ny][nx] = next;
        push(nx, ny);
      }
    }
  }

  return result;
}

function bestFieldChoice(fields, floor, cx, cy) {
  if (!Array.isArray(fields) || !fields.length) {
    return { idx: -1, field: null, score: Infinity };
  }
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const score = finiteCell(field?.[floor]?.[cy]?.[cx]);
    if (score < bestScore) {
      bestIdx = index;
      bestScore = score;
    }
  }
  return {
    idx: bestIdx,
    field: bestIdx >= 0 ? fields[bestIdx] : null,
    score: bestScore
  };
}

/**
 * Prefer any fire-safe exit route, regardless of whether an unsafe route is
 * shorter. Only when no safe route exists from the current cell do we fall
 * back to the ordinary potential fields.
 */
export function chooseFireSafeExitField(
  safeFields,
  fallbackFields,
  floor,
  cx,
  cy
) {
  const safe = bestFieldChoice(safeFields, floor, cx, cy);
  if (safe.idx >= 0 && Number.isFinite(safe.score)) {
    return { ...safe, usesFireFallback: false };
  }
  const fallback = bestFieldChoice(fallbackFields, floor, cx, cy);
  return { ...fallback, usesFireFallback: true };
}

export function routeChoiceForExit(
  exitIndex,
  safeFields,
  fallbackFields,
  floor,
  cx,
  cy
) {
  const safeField = safeFields?.[exitIndex] || null;
  const safeScore = finiteCell(safeField?.[floor]?.[cy]?.[cx]);
  if (Number.isFinite(safeScore)) {
    return {
      idx: exitIndex,
      field: safeField,
      score: safeScore,
      usesFireFallback: false
    };
  }

  const fallbackField = fallbackFields?.[exitIndex] || null;
  const fallbackScore = finiteCell(fallbackField?.[floor]?.[cy]?.[cx]);
  return {
    idx: Number.isFinite(fallbackScore) ? exitIndex : -1,
    field: Number.isFinite(fallbackScore) ? fallbackField : null,
    score: fallbackScore,
    usesFireFallback: true
  };
}
