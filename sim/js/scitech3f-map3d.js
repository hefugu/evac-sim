/**
 * Science and Technology High School 3F map calibration and extraction.
 *
 * Every supported drawing uses the same color contract: white corridors,
 * green stairs, yellow exits and black rooms/walls. Labels may also be white,
 * so the largest connected component can be retained to remove glyphs.
 */

export const SCITECH_3F_PROFILE = Object.freeze({
  id: "scitech-3f",
  name: "科学技術高校 3F",
  floorIndex: 2,
  floorName: "3F",
  sourceWidthPx: 600,
  sourceHeightPx: 800,
  gridCellPixels: 4,
  // Seven 4 px grid cells span the measured 2.9 m upper corridor.
  cellSizeMeters: 0.42,
  floorHeightMeters: 3.5,
  wallHeightMeters: 2.8,
  corridorWidthMeters: 2.9,
  corridorHalfWidthMeters: 1.45,
  referenceVerticalMeters: 65.6,
  whiteThreshold: 200
});

export const MAP_CELL_CLASS = Object.freeze({
  wall: 0,
  corridor: 1,
  stair: 2,
  exit: 3
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Checks whether an extracted, renamed image still matches the bundled map profile. */
export function isLikelyScitech3FExtraction(extraction, width, height) {
  const walkableCells = Math.max(0, finiteNumber(extraction?.walkableCells, 0));
  const stairCells = Math.max(0, finiteNumber(extraction?.stairCells, 0));
  // Exact calibrated topology counts distinguish 3F from the other 600x800
  // school maps; dimensions and color ratios alone classify every floor alike.
  return width === SCITECH_3F_PROFILE.sourceWidthPx &&
    height === SCITECH_3F_PROFILE.sourceHeightPx &&
    extraction?.gridWidth === Math.floor(width / SCITECH_3F_PROFILE.gridCellPixels) &&
    extraction?.gridHeight === Math.floor(height / SCITECH_3F_PROFILE.gridCellPixels) &&
    walkableCells === 2889 &&
    stairCells === 640;
}

export function isStairGreen(r, g, b, a = 255) {
  return a > 24 && g >= 145 && g >= r * 1.45 && g >= b * 1.35;
}

export function isExitYellow(r, g, b, a = 255) {
  return a > 24 &&
    r >= 180 &&
    g >= 170 &&
    b <= 160 &&
    r - b >= 60 &&
    g - b >= 40 &&
    Math.abs(r - g) <= 90;
}

export function isWalkableWhite(r, g, b, a = 255, threshold = SCITECH_3F_PROFILE.whiteThreshold) {
  return a > 24 && r > threshold && g > threshold && b > threshold;
}

/** Returns 0=wall, 1=corridor, 2=stair, 3=exit. */
export function classifyColorMapPixel(r, g, b, a = 255, options = {}) {
  if (isExitYellow(r, g, b, a)) return MAP_CELL_CLASS.exit;
  if (isStairGreen(r, g, b, a)) return MAP_CELL_CLASS.stair;
  return isWalkableWhite(r, g, b, a, finiteNumber(options.whiteThreshold, SCITECH_3F_PROFILE.whiteThreshold))
    ? MAP_CELL_CLASS.corridor
    : MAP_CELL_CLASS.wall;
}

export function classifyScitech3FPixel(r, g, b, a = 255, options = {}) {
  return classifyColorMapPixel(r, g, b, a, options);
}

function connectedComponentMask(classGrid, options = {}) {
  const height = classGrid.length;
  const width = height ? classGrid[0].length : 0;
  const visited = Array.from({ length: height }, () => new Uint8Array(width));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const components = [];

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (!classGrid[cy][cx] || visited[cy][cx]) continue;
      const queue = [[cx, cy]];
      const component = [];
      let stairCells = 0;
      let exitCells = 0;
      let minX = cx;
      let minY = cy;
      let maxX = cx;
      let maxY = cy;
      visited[cy][cx] = 1;
      for (let index = 0; index < queue.length; index++) {
        const [x, y] = queue[index];
        component.push([x, y]);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        if (classGrid[y][x] === MAP_CELL_CLASS.stair) stairCells++;
        if (classGrid[y][x] === MAP_CELL_CLASS.exit) exitCells++;
        for (const [dx, dy] of directions) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (visited[ny][nx] || !classGrid[ny][nx]) continue;
          visited[ny][nx] = 1;
          queue.push([nx, ny]);
        }
      }
      components.push({ cells: component, stairCells, exitCells, minX, minY, maxX, maxY });
    }
  }

  components.sort((a, b) => b.cells.length - a.cells.length);
  const largestSize = components[0]?.cells.length || 0;
  const minimumSize = Math.max(
    2,
    Math.floor(finiteNumber(options.minComponentCells, 12)),
    Math.ceil(largestSize * clamp(finiteNumber(options.minComponentShare, 0.05), 0, 1))
  );
  const policy = options.keepAllComponents ? "all" : (options.componentPolicy || "meaningful");
  const kept = components.filter((component, index) => {
    if (policy === "all") return true;
    if (policy === "largest") return index === 0;
    if (index === 0 || component.stairCells > 0 || component.exitCells > 0) return true;
    if (options.keepLargeWhiteComponents === false || component.cells.length < minimumSize) return false;
    const componentWidth = component.maxX - component.minX + 1;
    const componentHeight = component.maxY - component.minY + 1;
    const touchesBoundary = component.minX === 0 || component.minY === 0 ||
      component.maxX === width - 1 || component.maxY === height - 1;
    return !(touchesBoundary && (componentWidth <= 2 || componentHeight <= 2));
  });
  const keep = Array.from({ length: height }, () => new Uint8Array(width));
  kept.forEach(component => {
    component.cells.forEach(([cx, cy]) => { keep[cy][cx] = 1; });
  });
  return {
    keep,
    componentSize: kept.reduce((sum, component) => sum + component.cells.length, 0),
    componentCount: components.length,
    keptComponentCount: kept.length,
    largestComponentSize: largestSize
  };
}

function collectMarkerRegions(template) {
  const height = template.length;
  const width = height ? template[0].length : 0;
  const visited = Array.from({ length: height }, () => new Uint8Array(width));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const regions = [];
  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1) {
      if (!template[cy][cx] || visited[cy][cx]) continue;
      const queue = [[cx, cy]];
      const cells = [];
      let sumX = 0;
      let sumY = 0;
      visited[cy][cx] = 1;
      for (let index = 0; index < queue.length; index += 1) {
        const [x, y] = queue[index];
        cells.push([x, y]);
        sumX += x;
        sumY += y;
        for (const [dx, dy] of directions) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (visited[ny][nx] || !template[ny][nx]) continue;
          visited[ny][nx] = 1;
          queue.push([nx, ny]);
        }
      }
      const centerX = sumX / cells.length;
      const centerY = sumY / cells.length;
      const [markerX, markerY] = cells.slice().sort((a, b) => {
        const distanceA = (a[0] - centerX) ** 2 + (a[1] - centerY) ** 2;
        const distanceB = (b[0] - centerX) ** 2 + (b[1] - centerY) ** 2;
        return distanceA - distanceB || a[1] - b[1] || a[0] - b[0];
      })[0];
      regions.push({ cx: markerX, cy: markerY, cellCount: cells.length });
    }
  }
  return regions;
}

/**
 * Downsamples RGBA image data to the simulator grid.
 * Center-pixel sampling matches the legacy 2D grid. `sampleMode: "coverage"`
 * is also available for unusually thin source drawings.
 */
export function extractScitech3FGridFromImageData(imageData, width, height, options = {}) {
  const data = imageData?.data || imageData;
  if (!data || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("valid RGBA image data and dimensions are required");
  }
  const cellPixels = Math.max(1, Math.floor(finiteNumber(options.cellPixels, SCITECH_3F_PROFILE.gridCellPixels)));
  const gridWidth = Math.floor(width / cellPixels);
  const gridHeight = Math.floor(height / cellPixels);
  const whiteCoverage = clamp(finiteNumber(options.whiteCoverage, 0.22), 0.01, 1);
  const stairCoverage = clamp(finiteNumber(options.stairCoverage, 0.16), 0.01, 1);
  const exitCoverage = clamp(finiteNumber(options.exitCoverage, 0.16), 0.01, 1);
  const sampleMode = options.sampleMode || "center";
  const classes = Array.from({ length: gridHeight }, () => new Uint8Array(gridWidth));

  for (let cy = 0; cy < gridHeight; cy++) {
    for (let cx = 0; cx < gridWidth; cx++) {
      if (sampleMode === "center") {
        const px = Math.min(width - 1, cx * cellPixels + Math.floor(cellPixels / 2));
        const py = Math.min(height - 1, cy * cellPixels + Math.floor(cellPixels / 2));
        const offset = (py * width + px) * 4;
        classes[cy][cx] = classifyScitech3FPixel(
          data[offset], data[offset + 1], data[offset + 2], data[offset + 3], options
        );
        continue;
      }
      let white = 0;
      let green = 0;
      let yellow = 0;
      let sampled = 0;
      for (let py = cy * cellPixels; py < Math.min(height, (cy + 1) * cellPixels); py++) {
        for (let px = cx * cellPixels; px < Math.min(width, (cx + 1) * cellPixels); px++) {
          const offset = (py * width + px) * 4;
          const kind = classifyScitech3FPixel(
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3], options
          );
          if (kind === MAP_CELL_CLASS.exit) yellow++;
          else if (kind === MAP_CELL_CLASS.stair) green++;
          else if (kind === MAP_CELL_CLASS.corridor) white++;
          sampled++;
        }
      }
      if (sampled && yellow / sampled >= exitCoverage) classes[cy][cx] = MAP_CELL_CLASS.exit;
      else if (sampled && green / sampled >= stairCoverage) classes[cy][cx] = MAP_CELL_CLASS.stair;
      else if (sampled && (white + green + yellow) / sampled >= whiteCoverage) {
        classes[cy][cx] = MAP_CELL_CLASS.corridor;
      }
    }
  }

  const {
    keep,
    componentSize,
    componentCount,
    keptComponentCount,
    largestComponentSize
  } = connectedComponentMask(classes, options);

  const walkableTemplate = Array.from({ length: gridHeight }, () => new Array(gridWidth).fill(false));
  const stairTemplate = Array.from({ length: gridHeight }, () => new Array(gridWidth).fill(false));
  const exitTemplate = Array.from({ length: gridHeight }, () => new Array(gridWidth).fill(false));
  let walkableCells = 0;
  let stairCells = 0;
  let exitCells = 0;
  let minCx = gridWidth;
  let minCy = gridHeight;
  let maxCx = -1;
  let maxCy = -1;

  for (let cy = 0; cy < gridHeight; cy++) {
    for (let cx = 0; cx < gridWidth; cx++) {
      if (!keep[cy][cx]) continue;
      walkableTemplate[cy][cx] = true;
      stairTemplate[cy][cx] = classes[cy][cx] === MAP_CELL_CLASS.stair;
      exitTemplate[cy][cx] = classes[cy][cx] === MAP_CELL_CLASS.exit;
      walkableCells++;
      if (stairTemplate[cy][cx]) stairCells++;
      if (exitTemplate[cy][cx]) exitCells++;
      minCx = Math.min(minCx, cx);
      minCy = Math.min(minCy, cy);
      maxCx = Math.max(maxCx, cx);
      maxCy = Math.max(maxCy, cy);
    }
  }

  const exitPoints = collectMarkerRegions(exitTemplate);
  return {
    gridWidth,
    gridHeight,
    walkableTemplate,
    stairTemplate,
    exitTemplate,
    exitPoints,
    classes,
    componentSize,
    componentCount,
    keptComponentCount,
    largestComponentSize,
    walkableCells,
    stairCells,
    exitCells,
    bounds: walkableCells ? { minCx, minCy, maxCx, maxCy } : null,
    cellPixels
  };
}

export function extractScitech3FGrid(image, options = {}) {
  if (!image?.width || !image?.height || typeof document === "undefined") {
    throw new Error("a decoded browser image is required");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  return extractScitech3FGridFromImageData(imageData, image.width, image.height, options);
}

export function extractColorMapGridFromImageData(imageData, width, height, options = {}) {
  return extractScitech3FGridFromImageData(imageData, width, height, options);
}

export function extractColorMapGrid(image, options = {}) {
  return extractScitech3FGrid(image, options);
}

/** Combines the two supplied real-world references into an adjustable scale. */
export function estimateCellSizeMeters(options = {}) {
  const corridorCells = finiteNumber(options.corridorWidthCells, 0);
  const verticalCells = finiteNumber(options.referenceVerticalCells, 0);
  const corridorEstimate = corridorCells > 0
    ? finiteNumber(options.corridorWidthMeters, SCITECH_3F_PROFILE.corridorWidthMeters) / corridorCells
    : NaN;
  const verticalEstimate = verticalCells > 0
    ? finiteNumber(options.referenceVerticalMeters, SCITECH_3F_PROFILE.referenceVerticalMeters) / verticalCells
    : NaN;
  if (Number.isFinite(corridorEstimate) && Number.isFinite(verticalEstimate)) {
    const corridorWeight = clamp(finiteNumber(options.corridorWeight, 0.7), 0, 1);
    return corridorEstimate * corridorWeight + verticalEstimate * (1 - corridorWeight);
  }
  if (Number.isFinite(corridorEstimate)) return corridorEstimate;
  if (Number.isFinite(verticalEstimate)) return verticalEstimate;
  return finiteNumber(options.fallback, SCITECH_3F_PROFILE.cellSizeMeters);
}
