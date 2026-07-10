/**
 * Science and Technology High School 3F map calibration and extraction.
 *
 * The source drawing uses white for corridors, green for stairs and black for
 * rooms/walls.  Labels are also white, so the largest connected component is
 * retained to keep the corridor network while removing isolated glyphs.
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

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function isStairGreen(r, g, b, a = 255) {
  return a > 24 && g >= 145 && g >= r * 1.45 && g >= b * 1.35;
}

export function isWalkableWhite(r, g, b, a = 255, threshold = SCITECH_3F_PROFILE.whiteThreshold) {
  return a > 24 && r > threshold && g > threshold && b > threshold;
}

/** Returns 0=wall, 1=corridor, 2=stair. */
export function classifyScitech3FPixel(r, g, b, a = 255, options = {}) {
  if (isStairGreen(r, g, b, a)) return 2;
  return isWalkableWhite(r, g, b, a, finiteNumber(options.whiteThreshold, SCITECH_3F_PROFILE.whiteThreshold))
    ? 1
    : 0;
}

function largestConnectedMask(classGrid) {
  const height = classGrid.length;
  const width = height ? classGrid[0].length : 0;
  const visited = Array.from({ length: height }, () => new Uint8Array(width));
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let largest = [];

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (!classGrid[cy][cx] || visited[cy][cx]) continue;
      const queue = [[cx, cy]];
      const component = [];
      visited[cy][cx] = 1;
      for (let index = 0; index < queue.length; index++) {
        const [x, y] = queue[index];
        component.push([x, y]);
        for (const [dx, dy] of directions) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (visited[ny][nx] || !classGrid[ny][nx]) continue;
          visited[ny][nx] = 1;
          queue.push([nx, ny]);
        }
      }
      if (component.length > largest.length) largest = component;
    }
  }

  const keep = Array.from({ length: height }, () => new Uint8Array(width));
  largest.forEach(([cx, cy]) => { keep[cy][cx] = 1; });
  return { keep, componentSize: largest.length };
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
      let sampled = 0;
      for (let py = cy * cellPixels; py < Math.min(height, (cy + 1) * cellPixels); py++) {
        for (let px = cx * cellPixels; px < Math.min(width, (cx + 1) * cellPixels); px++) {
          const offset = (py * width + px) * 4;
          const kind = classifyScitech3FPixel(
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3], options
          );
          if (kind === 2) green++;
          else if (kind === 1) white++;
          sampled++;
        }
      }
      if (sampled && green / sampled >= stairCoverage) classes[cy][cx] = 2;
      else if (sampled && (white + green) / sampled >= whiteCoverage) classes[cy][cx] = 1;
    }
  }

  const { keep, componentSize } = options.keepAllComponents
    ? {
        keep: classes.map(row => Uint8Array.from(row, value => value ? 1 : 0)),
        componentSize: classes.reduce((sum, row) => sum + row.reduce((a, value) => a + (value ? 1 : 0), 0), 0)
      }
    : largestConnectedMask(classes);

  const walkableTemplate = Array.from({ length: gridHeight }, () => new Array(gridWidth).fill(false));
  const stairTemplate = Array.from({ length: gridHeight }, () => new Array(gridWidth).fill(false));
  let walkableCells = 0;
  let stairCells = 0;
  let minCx = gridWidth;
  let minCy = gridHeight;
  let maxCx = -1;
  let maxCy = -1;

  for (let cy = 0; cy < gridHeight; cy++) {
    for (let cx = 0; cx < gridWidth; cx++) {
      if (!keep[cy][cx]) continue;
      walkableTemplate[cy][cx] = true;
      stairTemplate[cy][cx] = classes[cy][cx] === 2;
      walkableCells++;
      if (classes[cy][cx] === 2) stairCells++;
      minCx = Math.min(minCx, cx);
      minCy = Math.min(minCy, cy);
      maxCx = Math.max(maxCx, cx);
      maxCy = Math.max(maxCy, cy);
    }
  }

  return {
    gridWidth,
    gridHeight,
    walkableTemplate,
    stairTemplate,
    classes,
    componentSize,
    walkableCells,
    stairCells,
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
