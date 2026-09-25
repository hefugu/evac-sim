/*
 * Lightweight continuous pedestrian dynamics based on the Social Force family
 * used by FDS+Evac. This module is deliberately independent from DOM/rendering
 * so it can be verified with Node tests.
 *
 * References for default values:
 * - Helbing & Molnar (1995), Social Force Model for Pedestrian Dynamics.
 * - Korhonen & Hostikka, FDS+Evac Technical Reference and User's Guide.
 *
 * Coordinates passed to stepPedestrianDynamics are grid-cell coordinates.
 * Velocities and forces are evaluated in SI units internally.
 */

const EPS = 1e-9;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const FDS_EVAC_PERSON_TYPES = Object.freeze({
  adult: Object.freeze({ radiusMeanM: 0.255, radiusHalfRangeM: 0.035, speedMeanMps: 1.25, speedHalfRangeMps: 0.30 }),
  male: Object.freeze({ radiusMeanM: 0.270, radiusHalfRangeM: 0.020, speedMeanMps: 1.35, speedHalfRangeMps: 0.20 }),
  female: Object.freeze({ radiusMeanM: 0.240, radiusHalfRangeM: 0.020, speedMeanMps: 1.15, speedHalfRangeMps: 0.20 }),
  child: Object.freeze({ radiusMeanM: 0.210, radiusHalfRangeM: 0.015, speedMeanMps: 0.90, speedHalfRangeMps: 0.30 }),
  elderly: Object.freeze({ radiusMeanM: 0.250, radiusHalfRangeM: 0.020, speedMeanMps: 0.80, speedHalfRangeMps: 0.30 })
});

export const SOCIAL_FORCE_DEFAULTS = Object.freeze({
  socialA_N: 2000,
  socialB_M: 0.08,
  anisotropyLambda: 0.30,
  wallA_N: 2000,
  wallB_M: 0.04,
  wallLambda: 0.20,
  contactK_KgM2: 120000,
  tangentialKappa_KgSM: 40000,
  contactDamping_KgS: 500,
  relaxationMinS: 0.8,
  relaxationMaxS: 1.2,
  randomAccelerationStdMps2: 0.10,
  randomAccelerationClampSigma: 3,
  interactionRangeM: 1.20,
  wallInteractionRangeM: 0.80,
  maxSpeedFactor: 1.70,
  maxAccelerationMps2: 12,
  integrationMaxStepS: 0.05,
  smokeAlphaMps: 0.706,
  smokeBetaM2ps: -0.057,
  smokeMinSpeedFactor: 0.10
});

function uniformAround(mean, halfRange, random) {
  return mean + (random() * 2 - 1) * halfRange;
}

function gaussianApprox(random) {
  // Box-Muller. Clamp the lower bound away from zero.
  const u1 = Math.max(EPS, random());
  const u2 = Math.max(EPS, random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function personTypeForRole(role) {
  const key = String(role || "adult").toLowerCase();
  if (key === "child") return "child";
  if (key === "elderly") return "elderly";
  if (key === "male") return "male";
  if (key === "female") return "female";
  // Teacher/student/leader/panic are behavioral roles, not physical population
  // classes in FDS+Evac. Keep their physical defaults adult unless configured.
  return "adult";
}

export function sampleFdsEvacPerson(type = "adult", random = Math.random) {
  const key = personTypeForRole(type);
  const profile = FDS_EVAC_PERSON_TYPES[key] || FDS_EVAC_PERSON_TYPES.adult;
  const radiusM = Math.max(0.12, uniformAround(profile.radiusMeanM, profile.radiusHalfRangeM, random));
  const desiredSpeedMps = Math.max(0.15, uniformAround(profile.speedMeanMps, profile.speedHalfRangeMps, random));
  const relaxationTimeS = uniformAround(
    (SOCIAL_FORCE_DEFAULTS.relaxationMinS + SOCIAL_FORCE_DEFAULTS.relaxationMaxS) / 2,
    (SOCIAL_FORCE_DEFAULTS.relaxationMaxS - SOCIAL_FORCE_DEFAULTS.relaxationMinS) / 2,
    random
  );

  // FDS+Evac uses an 80 kg male at Rd=0.27 m and scales other masses by
  // body size. Area scaling preserves that reference exactly.
  const massKg = 80 * (radiusM / 0.27) ** 2;

  return {
    physicalType: key,
    radiusM,
    desiredSpeedMps,
    relaxationTimeS,
    massKg
  };
}

export function smokeAdjustedDesiredSpeed(
  clearSpeedMps,
  extinctionCoefficientM1,
  options = {}
) {
  const cfg = { ...SOCIAL_FORCE_DEFAULTS, ...options };
  const v0 = Math.max(0, finite(clearSpeedMps));
  const K = Math.max(0, finite(extinctionCoefficientM1));
  if (v0 <= 0) return 0;

  // FDS+Evac relation based on Frantzich & Nilsson:
  // v_i(K) = max(v_min, v_i0 * (alpha + beta*K) / alpha)
  const ratio = (cfg.smokeAlphaMps + cfg.smokeBetaM2ps * K) / cfg.smokeAlphaMps;
  return Math.max(v0 * cfg.smokeMinSpeedFactor, v0 * Math.max(0, ratio));
}

function hashKey(floor, bx, by) {
  return `${floor}:${bx}:${by}`;
}

export function buildAgentSpatialHash(
  agents,
  { bucketSizeM = SOCIAL_FORCE_DEFAULTS.interactionRangeM, cellSizeMeters = 0.5 } = {}
) {
  const size = Math.max(0.25, finite(bucketSizeM, 1.2));
  const meters = Math.max(0.01, finite(cellSizeMeters, 0.5));
  const buckets = new Map();

  for (let index = 0; index < (agents?.length || 0); index++) {
    const agent = agents[index];
    if (!agent || agent.dead || agent.finished || agent.stairTransition) continue;
    const floor = Math.floor(finite(agent.floor, 0));
    const xM = finite(agent.x) * meters;
    const yM = finite(agent.y) * meters;
    const bx = Math.floor(xM / size);
    const by = Math.floor(yM / size);
    const key = hashKey(floor, bx, by);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  }

  return { buckets, bucketSizeM: size, cellSizeMeters: meters };
}

export function queryNearbyAgentIndices(hash, agent, rangeM = SOCIAL_FORCE_DEFAULTS.interactionRangeM) {
  if (!hash?.buckets || !agent) return [];
  const size = hash.bucketSizeM;
  const meters = hash.cellSizeMeters;
  const floor = Math.floor(finite(agent.floor, 0));
  const xM = finite(agent.x) * meters;
  const yM = finite(agent.y) * meters;
  const bx = Math.floor(xM / size);
  const by = Math.floor(yM / size);
  const reach = Math.max(1, Math.ceil(Math.max(0, rangeM) / size));
  const result = [];

  for (let oy = -reach; oy <= reach; oy++) {
    for (let ox = -reach; ox <= reach; ox++) {
      const bucket = hash.buckets.get(hashKey(floor, bx + ox, by + oy));
      if (bucket) result.push(...bucket);
    }
  }
  return result;
}

export function potentialDesiredDirection(agent, potentialField) {
  const floor = Math.floor(finite(agent?.floor, 0));
  const plane = potentialField?.[floor];
  if (!plane?.length) return { x: 0, y: 0 };

  const x = Math.round(finite(agent?.x));
  const y = Math.round(finite(agent?.y));
  const center = plane?.[y]?.[x];
  if (!Number.isFinite(center)) return { x: 0, y: 0 };

  const left = Number.isFinite(plane?.[y]?.[x - 1]) ? plane[y][x - 1] : center;
  const right = Number.isFinite(plane?.[y]?.[x + 1]) ? plane[y][x + 1] : center;
  const up = Number.isFinite(plane?.[y - 1]?.[x]) ? plane[y - 1][x] : center;
  const down = Number.isFinite(plane?.[y + 1]?.[x]) ? plane[y + 1][x] : center;

  const gx = (right - left) * 0.5;
  const gy = (down - up) * 0.5;
  const mag = Math.hypot(gx, gy);
  if (mag <= EPS) return { x: 0, y: 0 };
  return { x: -gx / mag, y: -gy / mag };
}

function socialAnisotropyWeight(desiredDirection, normalFromOther, lambda) {
  // phi is measured from the desired direction to the other person.
  const towardOtherX = -normalFromOther.x;
  const towardOtherY = -normalFromOther.y;
  const cosPhi = clamp(
    desiredDirection.x * towardOtherX + desiredDirection.y * towardOtherY,
    -1,
    1
  );
  return lambda + (1 - lambda) * (1 + cosPhi) * 0.5;
}

function closestPointOnCell(xM, yM, cx, cy, cellSizeMeters) {
  const minX = cx * cellSizeMeters - cellSizeMeters * 0.5;
  const maxX = cx * cellSizeMeters + cellSizeMeters * 0.5;
  const minY = cy * cellSizeMeters - cellSizeMeters * 0.5;
  const maxY = cy * cellSizeMeters + cellSizeMeters * 0.5;
  return {
    x: clamp(xM, minX, maxX),
    y: clamp(yM, minY, maxY)
  };
}

function wallForceForAgent(agent, context, cfg, desiredDirection) {
  const cellSize = context.cellSizeMeters;
  const floor = Math.floor(finite(agent.floor, 0));
  const xM = finite(agent.x) * cellSize;
  const yM = finite(agent.y) * cellSize;
  const radius = Math.max(0.1, finite(agent.radiusM, 0.255));
  const rangeCells = Math.max(1, Math.ceil((radius + cfg.wallInteractionRangeM) / cellSize));
  const cx0 = Math.round(finite(agent.x));
  const cy0 = Math.round(finite(agent.y));
  let fx = 0;
  let fy = 0;

  for (let cy = cy0 - rangeCells; cy <= cy0 + rangeCells; cy++) {
    for (let cx = cx0 - rangeCells; cx <= cx0 + rangeCells; cx++) {
      if (context.isWalkable(floor, cx, cy)) continue;
      const nearest = closestPointOnCell(xM, yM, cx, cy, cellSize);
      let dx = xM - nearest.x;
      let dy = yM - nearest.y;
      let distance = Math.hypot(dx, dy);

      // If exactly on/inside the wall AABB, use direction away from wall-cell center.
      if (distance <= EPS) {
        dx = xM - cx * cellSize;
        dy = yM - cy * cellSize;
        distance = Math.hypot(dx, dy);
        if (distance <= EPS) {
          dx = desiredDirection.x || 1;
          dy = desiredDirection.y || 0;
          distance = 1;
        }
      }

      if (distance > radius + cfg.wallInteractionRangeM) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const gap = distance - radius;
      const wallSocial = cfg.wallA_N * Math.exp(-gap / cfg.wallB_M);
      fx += wallSocial * nx;
      fy += wallSocial * ny;

      const overlap = Math.max(0, radius - distance);
      if (overlap > 0) {
        fx += cfg.contactK_KgM2 * overlap * nx;
        fy += cfg.contactK_KgM2 * overlap * ny;
      }
    }
  }

  return { x: fx, y: fy };
}

function interactionForce(agent, other, desiredDirection, cfg) {
  const ax = finite(agent.xM);
  const ay = finite(agent.yM);
  const bx = finite(other.xM);
  const by = finite(other.yM);
  let dx = ax - bx;
  let dy = ay - by;
  let distance = Math.hypot(dx, dy);
  if (distance <= EPS) {
    // Stable deterministic separation for coincident centres.
    const sign = finite(agent.id) <= finite(other.id) ? -1 : 1;
    dx = sign;
    dy = 0;
    distance = 1;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  const tx = -ny;
  const ty = nx;
  const radiusSum = Math.max(0.1, finite(agent.radiusM, 0.255)) +
    Math.max(0.1, finite(other.radiusM, 0.255));
  const gap = distance - radiusSum;

  const currentSpeed = Math.hypot(finite(agent.vxMps), finite(agent.vyMps));
  const desiredSpeed = Math.max(0.1, finite(agent.desiredSpeedMps, 1.25));
  const A = cfg.socialA_N * Math.max(0.5, currentSpeed / desiredSpeed);
  const anisotropy = socialAnisotropyWeight(desiredDirection, { x: nx, y: ny }, cfg.anisotropyLambda);
  let fx = A * Math.exp(-gap / cfg.socialB_M) * anisotropy * nx;
  let fy = A * Math.exp(-gap / cfg.socialB_M) * anisotropy * ny;

  const overlap = Math.max(0, -gap);
  if (overlap > 0) {
    const rvx = finite(agent.vxMps) - finite(other.vxMps);
    const rvy = finite(agent.vyMps) - finite(other.vyMps);
    const relativeNormal = rvx * nx + rvy * ny;
    const relativeTangent = rvx * tx + rvy * ty;
    const normalForce = cfg.contactK_KgM2 * overlap -
      cfg.contactDamping_KgS * Math.min(0, relativeNormal);
    fx += normalForce * nx - cfg.tangentialKappa_KgSM * overlap * relativeTangent * tx;
    fy += normalForce * ny - cfg.tangentialKappa_KgSM * overlap * relativeTangent * ty;
  }

  return { x: fx, y: fy };
}

function truncatedRandomAcceleration(random, cfg) {
  const z = clamp(
    gaussianApprox(random),
    -cfg.randomAccelerationClampSigma,
    cfg.randomAccelerationClampSigma
  );
  return z * cfg.randomAccelerationStdMps2;
}

function normalizeDirection(direction) {
  const x = finite(direction?.x);
  const y = finite(direction?.y);
  const m = Math.hypot(x, y);
  return m > EPS ? { x: x / m, y: y / m } : { x: 0, y: 0 };
}

function positionIsWalkable(agent, xM, yM, context) {
  const cx = Math.round(xM / context.cellSizeMeters);
  const cy = Math.round(yM / context.cellSizeMeters);
  return context.isWalkable(Math.floor(finite(agent.floor, 0)), cx, cy);
}

export function stepPedestrianDynamics(
  agents,
  dt,
  context,
  options = {}
) {
  if (!Array.isArray(agents) || !agents.length || !(dt > 0)) return agents;
  const cfg = { ...SOCIAL_FORCE_DEFAULTS, ...options };
  const cellSizeMeters = Math.max(0.01, finite(context?.cellSizeMeters, 0.5));
  const isWalkable = typeof context?.isWalkable === "function"
    ? context.isWalkable
    : () => true;
  const desiredDirectionFor = typeof context?.desiredDirectionFor === "function"
    ? context.desiredDirectionFor
    : agent => potentialDesiredDirection(agent, agent.potentialField);
  const extinctionAt = typeof context?.extinctionAt === "function"
    ? context.extinctionAt
    : () => 0;
  const random = typeof context?.random === "function" ? context.random : Math.random;
  const canMove = typeof context?.canMove === "function" ? context.canMove : () => true;
  const simContext = { ...context, cellSizeMeters, isWalkable };

  const substeps = Math.max(1, Math.ceil(dt / Math.max(0.005, cfg.integrationMaxStepS)));
  const h = dt / substeps;

  for (let substep = 0; substep < substeps; substep++) {
    const active = agents.map(agent => {
      const clearDesired = Math.max(0, finite(agent.baseDesiredSpeedMps ?? agent.desiredSpeedMps, 1.25));
      const extinction = Math.max(0, finite(extinctionAt(agent)));
      return {
        ...agent,
        xM: finite(agent.x) * cellSizeMeters,
        yM: finite(agent.y) * cellSizeMeters,
        vxMps: finite(agent.vxMps),
        vyMps: finite(agent.vyMps),
        desiredSpeedMps: smokeAdjustedDesiredSpeed(clearDesired, extinction, cfg)
      };
    });
    const hash = buildAgentSpatialHash(active, {
      bucketSizeM: cfg.interactionRangeM,
      cellSizeMeters
    });

    const updates = new Array(agents.length);
    for (let index = 0; index < active.length; index++) {
      const a = active[index];
      const source = agents[index];
      if (!source || source.dead || source.finished || source.fallen || source.stairTransition || !canMove(source)) {
        updates[index] = null;
        continue;
      }

      const desiredDirection = normalizeDirection(desiredDirectionFor(source));
      const tau = clamp(
        finite(source.relaxationTimeS, 1),
        cfg.relaxationMinS * 0.5,
        cfg.relaxationMaxS * 2
      );
      const mass = Math.max(20, finite(source.massKg, 80));
      const desiredVx = desiredDirection.x * a.desiredSpeedMps;
      const desiredVy = desiredDirection.y * a.desiredSpeedMps;

      // Motive force: m * (v0*e - v) / tau.
      let fx = mass * (desiredVx - a.vxMps) / tau;
      let fy = mass * (desiredVy - a.vyMps) / tau;

      const nearby = queryNearbyAgentIndices(hash, a, cfg.interactionRangeM);
      for (const otherIndex of nearby) {
        if (otherIndex === index) continue;
        const b = active[otherIndex];
        if (!b || b.floor !== a.floor) continue;
        const distance = Math.hypot(a.xM - b.xM, a.yM - b.yM);
        if (distance > cfg.interactionRangeM + a.radiusM + b.radiusM) continue;
        const f = interactionForce(a, b, desiredDirection, cfg);
        fx += f.x;
        fy += f.y;
      }

      const wallForce = wallForceForAgent(a, simContext, cfg, desiredDirection);
      fx += wallForce.x;
      fy += wallForce.y;

      // Small stochastic acceleration is part of FDS+Evac. It is bounded and
      // can be disabled by setting randomAccelerationStdMps2=0 for regression tests.
      let ax = fx / mass + truncatedRandomAcceleration(random, cfg);
      let ay = fy / mass + truncatedRandomAcceleration(random, cfg);
      const acceleration = Math.hypot(ax, ay);
      if (acceleration > cfg.maxAccelerationMps2) {
        const scale = cfg.maxAccelerationMps2 / acceleration;
        ax *= scale;
        ay *= scale;
      }

      let vx = a.vxMps + ax * h;
      let vy = a.vyMps + ay * h;
      const speed = Math.hypot(vx, vy);
      const maxSpeed = Math.max(0.2, a.desiredSpeedMps * cfg.maxSpeedFactor);
      if (speed > maxSpeed) {
        vx *= maxSpeed / speed;
        vy *= maxSpeed / speed;
      }

      let nextXM = a.xM + vx * h;
      let nextYM = a.yM + vy * h;

      // Walls remain hard constraints even if the force integration overshoots.
      if (!positionIsWalkable(a, nextXM, nextYM, simContext)) {
        const xOnly = positionIsWalkable(a, nextXM, a.yM, simContext);
        const yOnly = positionIsWalkable(a, a.xM, nextYM, simContext);
        if (xOnly && !yOnly) {
          nextYM = a.yM;
          vy = 0;
        } else if (yOnly && !xOnly) {
          nextXM = a.xM;
          vx = 0;
        } else {
          nextXM = a.xM;
          nextYM = a.yM;
          vx = 0;
          vy = 0;
        }
      }

      updates[index] = {
        x: nextXM / cellSizeMeters,
        y: nextYM / cellSizeMeters,
        vxMps: vx,
        vyMps: vy,
        desiredSpeedMps: a.desiredSpeedMps
      };
    }

    for (let index = 0; index < agents.length; index++) {
      if (updates[index]) Object.assign(agents[index], updates[index]);
    }
  }

  return agents;
}
