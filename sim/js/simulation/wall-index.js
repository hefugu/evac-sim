const EPS = 1e-9;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function floorIndexOf(floor, fallback) {
  return Math.floor(finite(floor?.floorIndex ?? floor?.floor, fallback));
}

function walkableAt(floor, cx, cy) {
  const template = floor?.walkableTemplate;
  if (Array.isArray(template)) return !!template?.[cy]?.[cx];
  const cell = floor?.grid?.[cy]?.[cx];
  return !!(cell && (cell.walkable || cell.stair));
}

function bucketKey(floor, bx, by) {
  return `${floor}:${bx}:${by}`;
}

function addSegmentToBucketMap(buckets, segment, bucketSizeM) {
  const minX = Math.min(segment.x1, segment.x2);
  const maxX = Math.max(segment.x1, segment.x2);
  const minY = Math.min(segment.y1, segment.y2);
  const maxY = Math.max(segment.y1, segment.y2);
  const minBx = Math.floor(minX / bucketSizeM);
  const maxBx = Math.floor((maxX - EPS) / bucketSizeM);
  const minBy = Math.floor(minY / bucketSizeM);
  const maxBy = Math.floor((maxY - EPS) / bucketSizeM);

  for (let by = minBy; by <= maxBy; by++) {
    for (let bx = minBx; bx <= maxBx; bx++) {
      const key = bucketKey(segment.floor, bx, by);
      const list = buckets.get(key);
      if (list) list.push(segment);
      else buckets.set(key, [segment]);
    }
  }
}

/**
 * Builds an index of physical wall surfaces bordering walkable space.
 * Fire/smoke hazards are intentionally excluded: they affect routing but are
 * not solid walls.
 */
export function buildWallSpatialIndex(floorsInput, options = {}) {
  const floors = Array.isArray(floorsInput) ? floorsInput : [];
  const bucketSizeM = Math.max(0.25, finite(options.bucketSizeM, 1.0));
  const buckets = new Map();
  const segmentsByFloor = new Map();
  let segmentCount = 0;

  floors.forEach((floor, arrayIndex) => {
    const floorIndex = floorIndexOf(floor, arrayIndex);
    const grid = Array.isArray(floor?.walkableTemplate)
      ? floor.walkableTemplate
      : floor?.grid;
    const height = Array.isArray(grid) ? grid.length : 0;
    const width = height
      ? Math.max(...grid.map(row => Array.isArray(row) ? row.length : 0))
      : 0;
    if (!width || !height) return;

    const cellSizeMeters = Math.max(
      0.01,
      finite(floor?.cellSizeMeters, finite(options.cellSizeMeters, 0.5))
    );
    const half = cellSizeMeters * 0.5;
    const floorSegments = [];

    const push = (x1, y1, x2, y2) => {
      const segment = { floor: floorIndex, x1, y1, x2, y2 };
      floorSegments.push(segment);
      addSegmentToBucketMap(buckets, segment, bucketSizeM);
      segmentCount += 1;
    };

    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        if (!walkableAt(floor, cx, cy)) continue;
        const centerX = cx * cellSizeMeters;
        const centerY = cy * cellSizeMeters;

        if (!walkableAt(floor, cx - 1, cy)) {
          push(centerX - half, centerY - half, centerX - half, centerY + half);
        }
        if (!walkableAt(floor, cx + 1, cy)) {
          push(centerX + half, centerY - half, centerX + half, centerY + half);
        }
        if (!walkableAt(floor, cx, cy - 1)) {
          push(centerX - half, centerY - half, centerX + half, centerY - half);
        }
        if (!walkableAt(floor, cx, cy + 1)) {
          push(centerX - half, centerY + half, centerX + half, centerY + half);
        }
      }
    }

    segmentsByFloor.set(floorIndex, floorSegments);
  });

  return {
    bucketSizeM,
    buckets,
    segmentsByFloor,
    segmentCount
  };
}

export function queryWallSegments(index, floorInput, xMeters, yMeters, rangeMeters = 1) {
  if (!index?.buckets) return [];
  const floor = Math.floor(finite(floorInput, 0));
  const x = finite(xMeters);
  const y = finite(yMeters);
  const range = Math.max(0, finite(rangeMeters, 1));
  const size = Math.max(0.25, finite(index.bucketSizeM, 1));
  const minBx = Math.floor((x - range) / size);
  const maxBx = Math.floor((x + range) / size);
  const minBy = Math.floor((y - range) / size);
  const maxBy = Math.floor((y + range) / size);
  const unique = new Set();
  const result = [];

  for (let by = minBy; by <= maxBy; by++) {
    for (let bx = minBx; bx <= maxBx; bx++) {
      const bucket = index.buckets.get(bucketKey(floor, bx, by));
      if (!bucket) continue;
      for (const segment of bucket) {
        if (unique.has(segment)) continue;
        unique.add(segment);
        result.push(segment);
      }
    }
  }
  return result;
}

export function closestPointOnWallSegment(xMeters, yMeters, segment) {
  const x = finite(xMeters);
  const y = finite(yMeters);
  const x1 = finite(segment?.x1);
  const y1 = finite(segment?.y1);
  const x2 = finite(segment?.x2);
  const y2 = finite(segment?.y2);
  const vx = x2 - x1;
  const vy = y2 - y1;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared <= EPS) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / lengthSquared));
  return { x: x1 + vx * t, y: y1 + vy * t };
}
