import { getCellHazardInspection, DEFAULT_HAZARD_DISPLAY } from './hazard-display.js';
const panels = new WeakMap();
const sourceLabel = source => ({ fds: 'FDS', fallback: '簡易モデル', mixed: '混在', none: '未取得' }[source] || source || '未取得');
const formatValue = value => value == null ? '未取得' : typeof value === 'number'
  ? Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : '未取得'
  : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** DOM adapter. Reads cell state; only the UI selection under state.viz is updated. */
export function getInspectionPanel(state) {
  if (panels.has(state)) return panels.get(state);
  const host = document.getElementById('hazardInspector');
  let last = '';
  const api = {
    select(endpoint) { state.viz.selectedCell = endpoint ? {...endpoint} : null; api.refresh(); },
    refresh() {
      if (!host) return;
      const result = getCellHazardInspection(state, state.viz.selectedCell || {});
      host.hidden = !state.viz.selectedCell;
      if (host.hidden) return;
      const encoded = JSON.stringify(result);
      if (encoded === last) return;
      last = encoded;
      host.querySelector('[data-inspector-location]').textContent = result
        ? `${result.floorIndex + 1}階 / セル X=${result.cx}, Y=${result.cy} / データ由来: ${sourceLabel(result.source)}` : '選択セルがありません';
      const body = host.querySelector('tbody'); body.replaceChildren();
      for (const row of result?.rows || []) {
        const tr = document.createElement('tr'); tr.dataset.field = row.key;
        for (const value of [row.label, `${formatValue(row.value)}${row.unit ? ' ' + row.unit : ''}`, row.value == null ? '—' : sourceLabel(row.source)]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        body.append(tr);
      }
    }
  };
  host?.querySelector('button')?.addEventListener('click', () => { api.select(null); document.dispatchEvent(new Event('hazard-display-change')); });
  panels.set(state,api); return api;
}

/** All display controls share one UI settings object, separate from simulation/hazard fields. */
export function bindHazardDisplayControls(state, renderer = null) {
  state.viz ||= {};
  state.viz.hazardDisplay ||= {...DEFAULT_HAZARD_DISPLAY};
  const controls = [...document.querySelectorAll('[data-hazard-setting]')];
  function refresh() {
    const settings = state.viz.hazardDisplay;
    controls.forEach(control => { control.value = settings[control.dataset.hazardSetting]; });
    renderer?.setSmokeDisplayMode(settings.smokeDisplayMode);
    renderer?.setSmokeVisualizationMode(settings.smokeMetric);
    renderer?.setFireVisualizationMode(settings.fireMetric);
    renderer?.setDataSourceOverlay(settings.dataSourceOverlay);
  }
  controls.forEach(control => control.addEventListener('change', () => {
    state.viz.hazardDisplay = {...state.viz.hazardDisplay,[control.dataset.hazardSetting]:control.value};
    refresh(); document.dispatchEvent(new Event('hazard-display-change'));
  }));
  refresh();
}
