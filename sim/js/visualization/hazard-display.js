/** Read-only display transforms. Scales below are presentation ranges, NOT tenability limits. */
export const DEFAULT_HAZARD_DISPLAY = Object.freeze({ smokeDisplayMode: 'physical', smokeMetric: 'extinction',
  fireMetric: 'intensity', dataSourceOverlay: 'none', analysisGamma: 0.55 });
const clamp01 = x => Math.max(0, Math.min(1, x));
export const finiteValue = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
const nonnegative = x => Math.max(0, finiteValue(x) ?? 0);

/** Beer–Lambert: T = exp(-K L), alpha = 1-T. K [m^-1], L [m]. */
export function computeSmokeOpacityPhysical(K, L) { return -Math.expm1(-nonnegative(K) * nonnegative(L)); }
/** Display ONLY: gamma < 1 raises low nonzero alpha without inventing smoke at K=0 or L=0. */
export function computeSmokeOpacityAnalysis(K, L, gamma = 0.55) {
  return computeSmokeOpacityPhysical(K, L) ** Math.max(0.05, Math.min(1, finiteValue(gamma) ?? 0.55));
}
export function computeSmokeDisplayOpacity(K, L, { mode = 'physical', gamma = 0.55 } = {}) {
  return mode === 'analysis' ? computeSmokeOpacityAnalysis(K, L, gamma) : computeSmokeOpacityPhysical(K, L);
}
/** Center chord through one cell-wide layer box, y vertical; uniform K, no scattering or ray marching.
 * L = min(width/|dx|, depth/|dy|, width/|dz|) [m], d is unit viewing direction. */
export function computeSmokeViewPathLength({ cellSizeMeters = 0.5, layerDepthMeters = 0, viewDirection = { x: 0, y: 1, z: 0 } } = {}) {
  const width = nonnegative(cellSizeMeters), depth = nonnegative(layerDepthMeters);
  if (!width || !depth) return 0;
  const d = ['x', 'y', 'z'].map(k => finiteValue(viewDirection[k]) ?? 0);
  const length = Math.hypot(...d);
  if (!length) return depth;
  return Math.min(...[width, depth, width].map((size, i) => Math.abs(d[i]) > 1e-10 ? size * length / Math.abs(d[i]) : Infinity));
}

export const SOURCE_COLORS = Object.freeze({ fds: '#55e4ff', fallback: '#a0a8b0', mixed: '#dd92ff', none: '#63717d' });
const sourceCategory = source => /fds/i.test(source || '') ? 'fds' : /fallback|reduced|t2/i.test(source || '') ? 'fallback' : 'none';
const fdsAliases = {
  smokeDensity: ['opticalDensityM1', 'smokeDensity'], eyeLevelSmokeDensity: ['opticalDensityM1', 'smokeDensity'],
  extinctionCoefficientM1: ['opticalDensityM1'], eyeLevelExtinctionCoefficientM1: ['opticalDensityM1'],
  opticalDensityBase10M1: ['opticalDensityM1'], visibilityM: ['visibilityM', 'opticalDensityM1'],
  visibilityMeters: ['visibilityM', 'opticalDensityM1'], coPpm: ['coPpm'], eyeLevelCoPpm: ['coPpm'],
  eyeLevelTemperatureC: ['temperatureC'], heatFluxKwM2: ['heatFluxKwM2']
};
export function resolveFieldDisplaySource(cell = {}, key) {
  if (key.endsWith('DataSource')) return sourceCategory(cell[key]);
  if (/^upperLayer|^smokeLayer|^smokeTemperatureC$/.test(key)) return sourceCategory(cell.upperLayerDataSource || 'reduced_order_nist');
  if (['hrrKw', 'fireAgeSec', 'fireIntensity', 'ignitionTime', 'spreadSourceCell', 'fireSource'].includes(key)) return 'fallback';
  const fields = cell.fdsFields;
  if ((fdsAliases[key] || []).some(alias => fields?.includes(alias)) || cell.fireFdsFields?.includes(key)) return 'fds';
  // Marker arrays are authoritative for partial overlays; aggregate source alone is insufficient.
  if (Array.isArray(fields) || Array.isArray(cell.fireFdsFields)) return 'fallback';
  if (key === 'temperatureC') return 'fallback'; // core temperature is not the FDS eye-height reading
  if (fdsAliases[key]) return sourceCategory(cell.eyeLevelDataSource || cell.smokeDataSource || 'reduced_order_nist');
  return 'fallback';
}
export function resolveHazardDisplaySource(cell = {}, fields) {
  const keys = fields || ['eyeLevelExtinctionCoefficientM1', 'coPpm', 'eyeLevelTemperatureC', 'heatFluxKwM2', 'upperLayerCoPpm'];
  const sources = new Set(keys.filter(key => cell[key] != null).map(key => resolveFieldDisplaySource(cell, key)));
  if (!sources.size) {
    for (const key of ['smokeDataSource', 'fireDataSource', 'hazardDataSource']) {
      const value = sourceCategory(cell[key]); if (value !== 'none') sources.add(value);
    }
  }
  if (sources.has('fds') && sources.has('fallback')) return 'mixed';
  return sources.has('fds') ? 'fds' : sources.has('fallback') ? 'fallback' : 'none';
}
export function sourceOverlayMatches(filter, source) {
  return filter === 'mixed' ? source !== 'none' : filter !== 'none' && (filter === source || source === 'mixed');
}

export const DISPLAY_METRICS = Object.freeze({
  density: { label: 'Smoke density', unit: 'index', min: 0, max: 5 },
  extinction: { label: 'Extinction K', unit: '1/m', min: 0, max: 2 },
  visibility: { label: 'Visibility', unit: 'm', min: 0, max: 30, reverse: true },
  co: { label: 'CO', unit: 'ppm', min: 0, max: 1200 },
  temperature: { label: 'Temperature', unit: '°C', min: 20, max: 200 },
  heat_flux: { label: 'Heat flux', unit: 'kW/m²', min: 0, max: 10 },
  layer_depth: { label: 'Layer depth', unit: 'm', min: 0, max: 3 },
  intensity: { label: 'Fire intensity', unit: '0–1', min: 0, max: 1 },
  hrr: { label: 'HRR', unit: 'kW', min: 0, max: 2500 },
  age: { label: 'Fire age', unit: 's', min: 0, max: 300 },
  spread_front: { label: 'Spread front', unit: '0/1', min: 0, max: 1 },
  total: { label: 'Composite display index', unit: '0–1', min: 0, max: 1 },
  source: { label: 'Source', unit: 'category', min: 0, max: 3 }
});
export function displayMetricValue(cell = {}, metric, { upper = false, isFront = false } = {}) {
  const fields = { density: upper ? ['upperLayerExtinctionCoefficientM1'] : ['eyeLevelSmokeDensity', 'smokeDensity'],
    extinction: upper ? ['upperLayerExtinctionCoefficientM1'] : ['eyeLevelExtinctionCoefficientM1', 'extinctionCoefficientM1'],
    visibility: upper ? [] : ['visibilityM', 'visibilityMeters'],
    co: upper ? ['upperLayerCoPpm'] : ['eyeLevelCoPpm', 'coPpm'],
    temperature: upper ? ['upperLayerTemperatureC'] : ['eyeLevelTemperatureC', 'smokeTemperatureC', 'temperatureC'],
    heat_flux: ['heatFluxKwM2'], layer_depth: ['smokeLayerDepthMeters'], intensity: ['fireIntensity'], hrr: ['hrrKw'], age: ['fireAgeSec'] };
  if (metric === 'spread_front') return isFront ? 1 : 0;
  if (upper && metric === 'visibility') {
    const K = finiteValue(cell.upperLayerExtinctionCoefficientM1);
    return K == null ? null : K > 0 ? Math.min(30, 3 / K) : 30;
  }
  const value = (fields[metric] || []).map(key => finiteValue(cell[key])).find(x => x != null) ?? null;
  return upper && metric === 'density' && value != null ? value / 0.32 : value;
}
export function normalizeDisplayMetric(metric, value) {
  const spec = DISPLAY_METRICS[metric] || DISPLAY_METRICS.extinction;
  const t = clamp01(((finiteValue(value) ?? spec.min) - spec.min) / (spec.max - spec.min));
  return spec.reverse ? 1 - t : t;
}
export function displayMetricColor(metric, value) {
  if (metric === 'source') return SOURCE_COLORS[value] || SOURCE_COLORS.none;
  const t = normalizeDisplayMetric(metric, value);
  if (metric === 'extinction' || metric === 'density') { const g = Math.round(180 - 140 * t); return `rgb(${g},${g + 4},${g + 8})`; }
  return `rgb(${Math.round(55 + 200 * t)},${Math.round(195 - 140 * t)},${Math.round(230 - 195 * t)})`;
}
export function displayLegend(metric) {
  const spec = DISPLAY_METRICS[metric] || DISPLAY_METRICS.extinction;
  return metric === 'source' ? 'cyan FDS / gray fallback / purple mixed'
    : `${spec.label} [${spec.unit}] ${spec.min}–${spec.max} (clipped); ${['density', 'extinction'].includes(metric) ? 'dark = high' : spec.reverse ? 'red = low, blue = high' : 'blue = low, red = high'}`;
}

/** Normalized glyph strength; monotone display scaling, not a combustion/injury model. */
export function computeFireVisualStrength(cell = {}, { metric = 'intensity', isFront = false } = {}) {
  return normalizeDisplayMetric(metric, displayMetricValue(cell, metric, { isFront }));
}
export function isFireSpreadFront(grid, cx, cy) {
  if (!grid?.[cy]?.[cx]?.fire) return false;
  return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
    const target = grid[cy + dy]?.[cx + dx];
    return target && !target.fire && !target.wall && (target.walkable || target.stair) && target.flammable !== false;
  });
}
export function createFireDisplayData(cell = {}, { metric = 'intensity', isFront = false, maxHeightMeters = 3 } = {}) {
  const active = !!cell.fire || nonnegative(cell.fireIntensity) > 0;
  const strength = active ? computeFireVisualStrength(cell, { metric, isFront }) : 0;
  // A bounded HRR glyph height [m], not a predicted flame length. No invented burn/decay stage.
  const flameHeightMeters = active ? Math.min(maxHeightMeters, 0.12 + 2.2 * Math.sqrt(nonnegative(cell.hrrKw) / 2500)) : 0;
  return { active, strength, flameHeightMeters, isFront: active && isFront,
    value: displayMetricValue(cell, metric, { isFront }), color: displayMetricColor(metric, displayMetricValue(cell, metric, { isFront })),
    origin: cell.fireSource === 'spread' ? 'spread' : 'source', source: resolveFieldDisplaySource(cell, metric === 'heat_flux' ? 'heatFluxKwM2' : 'hrrKw'),
    hrrKw: finiteValue(cell.hrrKw), fireAgeSec: finiteValue(cell.fireAgeSec), ignitionTime: finiteValue(cell.ignitionTime), spreadSourceCell: cell.spreadSourceCell ?? null };
}

export const INSPECTION_FIELDS = Object.freeze({ smokeDensity: 'index', eyeLevelSmokeDensity: 'index',
  extinctionCoefficientM1: '1/m', eyeLevelExtinctionCoefficientM1: '1/m', opticalDensityBase10M1: '1/m (base 10)',
  visibilityM: 'm', coPpm: 'ppm', upperLayerCoPpm: 'ppm', temperatureC: '°C', smokeTemperatureC: '°C',
  upperLayerTemperatureC: '°C', eyeLevelTemperatureC: '°C', smokeLayerDepthMeters: 'm', smokeLayerInterfaceHeightMeters: 'm',
  heatFluxKwM2: 'kW/m²', fireIntensity: '0–1', hrrKw: 'kW', fireAgeSec: 's', ignitionTime: 's',
  fireSource: '', spreadSourceCell: 'cell', smokeDataSource: '', fireDataSource: '', hazardDataSource: '' });
export function getCellHazardInspection(state, endpoint = {}) {
  const floorIndex = endpoint.floorIndex ?? endpoint.floor ?? state?.map?.currentFloor ?? 0;
  const floors = state?.map?.floorStates || state?.floors || [];
  const floor = floors.find((f, i) => (f.floorIndex ?? f.floor ?? i) === floorIndex);
  const cx = endpoint.cx, cy = endpoint.cy, cell = floor?.grid?.[cy]?.[cx];
  if (!cell) return null;
  return { floorIndex, cx, cy, source: resolveHazardDisplaySource(cell),
    rows: Object.entries(INSPECTION_FIELDS).map(([key, unit]) => ({ key, label: key, unit,
      value: cell[key] ?? (key === 'visibilityM' ? cell.visibilityMeters ?? null : null), source: resolveFieldDisplaySource(cell, key) })) };
}
