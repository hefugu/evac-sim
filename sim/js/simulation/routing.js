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
