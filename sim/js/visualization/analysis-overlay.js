import { DISPLAY_METRICS, displayMetricValue, displayMetricColor, displayLegend, normalizeDisplayMetric,
  resolveHazardDisplaySource, isFireSpreadFront, finiteValue } from './hazard-display.js';

/** Quantitative heatmap from current cell fields only; never re-runs a hazard calculation. */
export function buildAnalysisOverlay(grid, requestedMode) {
  if (!grid || !requestedMode || requestedMode === 'none') return null;
  const mode = ({optical_density:'extinction',data_source:'source',smoke_density:'density'})[requestedMode] || requestedMode;
  const spec = DISPLAY_METRICS[mode];
  if (!spec) return null;
  const sources = new Set();
  let minValue = Infinity, maxValue = -Infinity;
  const cells = grid.map((row, cy) => row.map((cell, cx) => {
    if (!cell || (!cell.walkable && !cell.fire && !cell.stair)) return null;
    const source = resolveHazardDisplaySource(cell);
    sources.add(source);
    let value = displayMetricValue(cell, mode, {isFront:isFireSpreadFront(grid,cx,cy)});
    if (mode === 'total') {
      // Retained legacy composite DISPLAY index, not an exposure or tenability classifier.
      const normalized = ['heat_flux','extinction','co','visibility'].map(k => normalizeDisplayMetric(k, displayMetricValue(cell,k)));
      value = Math.max(...normalized) * .7 + normalized.reduce((a,b)=>a+b,0) / 4 * .3;
    }
    if (mode === 'source') return {value:source,norm:0,color:displayMetricColor(mode,source),source};
    if (finiteValue(value) == null) return null;
    minValue = Math.min(minValue,value); maxValue = Math.max(maxValue,value);
    return {value, norm:normalizeDisplayMetric(mode,value), color:displayMetricColor(mode,value),source};
  }));
  return {mode,label:spec.label,unit:spec.unit,cells,minValue:Number.isFinite(minValue)?minValue:null,
    maxValue:Number.isFinite(maxValue)?maxValue:null,source:[...sources].join('/'),legend:displayLegend(mode)};
}
