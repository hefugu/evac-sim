export function normalizeAgentRatios(ratios) {
  const sum = Object.values(ratios).reduce((a, b) => a + b, 0);
  if (sum <= 0) return ratios;
  const normalized = {};
  Object.entries(ratios).forEach(([k, v]) => {
    normalized[k] = (v / sum) * 100;
  });
  return normalized;
}
