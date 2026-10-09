/** Check every grid cell crossed by a segment (cell centres are integers).
 * At a corner both side cells must be open, just as in the distance field.
 */
export function canWalkSegment(x, y, tx, ty, traversable) {
  if (![x, y, tx, ty].every(Number.isFinite)) return false;
  let cx = Math.round(x), cy = Math.round(y);
  const ex = Math.round(tx), ey = Math.round(ty);
  if (!traversable(cx, cy) || !traversable(ex, ey)) return false;
  const dx = tx - x, dy = ty - y;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const deltaX = dx ? 1 / Math.abs(dx) : Infinity;
  const deltaY = dy ? 1 / Math.abs(dy) : Infinity;
  let nextX = dx ? (cx + sx * 0.5 - x) / dx : Infinity;
  let nextY = dy ? (cy + sy * 0.5 - y) / dy : Infinity;
  while (cx !== ex || cy !== ey) {
    const crossX = cx === ex ? Infinity : nextX;
    const crossY = cy === ey ? Infinity : nextY;
    if (Math.abs(crossX - crossY) < 1e-10) {
      if (!traversable(cx + sx, cy) || !traversable(cx, cy + sy)) return false;
      cx += sx; cy += sy; nextX += deltaX; nextY += deltaY;
    } else if (crossX < crossY) {
      cx += sx; nextX += deltaX;
    } else {
      cy += sy; nextY += deltaY;
    }
    if (!traversable(cx, cy)) return false;
  }
  return true;
}
