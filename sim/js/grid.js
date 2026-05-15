export function makeScalarGrid(width, height, fillValue) {
  return new Array(height).fill(null).map(() => new Array(width).fill(fillValue));
}

export function makeFlowGrid(width, height) {
  return new Array(height).fill(null).map(() =>
    new Array(width).fill(null).map(() => ({ vx: 0, vy: 0, n: 0 }))
  );
}
