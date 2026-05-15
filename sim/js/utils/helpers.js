export function parseNum(input, fallback = 0) {
  const n = Number(input?.value);
  return Number.isFinite(n) ? n : fallback;
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}