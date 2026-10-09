/* Behavioral layer above Social Force. See docs/agent-model-basis.md.
 * Times are scenario inputs, not population constants or a calibrated EDM.
 */
const nonnegative = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;

export function normalizeResponseOptions(options = {}) {
  const minSec = nonnegative(options.minSec);
  const maxSec = Math.max(minSec, nonnegative(options.maxSec, minSec));
  return {
    detectionSec: nonnegative(options.detectionSec),
    minSec,
    modeSec: Math.min(maxSec, Math.max(minSec, nonnegative(options.modeSec, minSec))),
    maxSec
  };
}

export function samplePreMovement(options = {}, random = Math.random) {
  const { detectionSec, minSec, modeSec, maxSec } = normalizeResponseOptions(options);
  let reactionSec = minSec;
  if (maxSec > minSec) {
    const u = Math.min(1, Math.max(0, random()));
    const span = maxSec - minSec;
    reactionSec = u < (modeSec - minSec) / span
      ? minSec + Math.sqrt(u * span * (modeSec - minSec))
      : maxSec - Math.sqrt((1 - u) * span * (maxSec - modeSec));
  }
  return { detectionSec, reactionSec, preMovementSec: detectionSec + reactionSec };
}

export function departureState(agent, timeSec) {
  const elapsed = timeSec - nonnegative(agent.startTime);
  if (elapsed < nonnegative(agent.detectionSec)) return "unaware";
  if (elapsed < nonnegative(agent.evacDelay)) return "pre_movement";
  return "normal";
}

// Supercover traversal of cells centred on integer coordinates. At a corner
// both adjacent cells must be transparent; a diagonal wall cannot be skipped.
export function hasLineOfSight(from, to, cellVisible) {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return false;
  let x = Math.floor(from.x + 0.5), y = Math.floor(from.y + 0.5);
  const endX = Math.floor(to.x + 0.5), endY = Math.floor(to.y + 0.5);
  const dx = to.x - from.x, dy = to.y - from.y;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const deltaX = dx ? 1 / Math.abs(dx) : Infinity;
  const deltaY = dy ? 1 / Math.abs(dy) : Infinity;
  let tx = dx ? (x + (sx > 0 ? 0.5 : -0.5) - from.x) / dx : Infinity;
  let ty = dy ? (y + (sy > 0 ? 0.5 : -0.5) - from.y) / dy : Infinity;
  if (!cellVisible(x, y)) return false;
  while (x !== endX || y !== endY) {
    const crossX = x === endX ? Infinity : tx;
    const crossY = y === endY ? Infinity : ty;
    if (Math.abs(crossX - crossY) < 1e-10) {
      if (!cellVisible(x + sx, y) || !cellVisible(x, y + sy)) return false;
      x += sx; y += sy; tx += deltaX; ty += deltaY;
    } else if (crossX < crossY) {
      x += sx; tx += deltaX;
    } else {
      y += sy; ty += deltaY;
    }
    if (!cellVisible(x, y)) return false;
  }
  return true;
}

export function canPerceiveGuide(agent, guide, context) {
  if (!guide || guide.id === agent.id || guide.floor !== agent.floor ||
      guide.dead || guide.finished || guide.fallen || guide.stairTransition ||
      !["teacher", "leader"].includes(guide.type)) return false;
  if (departureState(guide, context.timeSec) !== "normal") return false;
  const meters = context.cellSizeMetersForFloor(agent.floor);
  const distance = Math.hypot(guide.x - agent.x, guide.y - agent.y) * meters;
  if (distance > context.maxRangeMeters) return false;
  return hasLineOfSight(agent, guide, (x, y) =>
    context.isWalkable(agent.floor, x, y) &&
    distance <= nonnegative(context.visibilityMetersAt(agent.floor, x, y))
  );
}

export function selectVisibleGuide(agent, guides, context) {
  // Keep a visible guide to avoid oscillation between equally near people.
  const previous = guides.find(guide => guide.id === agent.leaderId);
  if (canPerceiveGuide(agent, previous, context)) return previous;
  let best = null, bestDistance = Infinity;
  for (const guide of guides) {
    const distance = Math.hypot(guide.x - agent.x, guide.y - agent.y);
    if (distance < bestDistance && canPerceiveGuide(agent, guide, context)) {
      best = guide; bestDistance = distance;
    }
  }
  return best;
}
