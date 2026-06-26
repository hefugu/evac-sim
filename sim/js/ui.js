let refs = null;

function byId(id) {
  return document.getElementById(id);
}

export function getUIRefs() {
  if (refs) return refs;
  refs = {
    simCanvas: byId("simCanvas"),
    mapFileInput: byId("mapFile"),
    thrRange: byId("thrRange"),
    numAgentsInput: byId("numAgents"),
    speedInput: byId("speed"),
    speedVarInput: byId("speedVar"),
    cellSizeMetersInput: byId("cellSizeMeters"),
    startRuleInput: byId("startRule"),
    floorCountInput: byId("floorCount"),
    currentFloorSelect: byId("currentFloor"),
    btnApplyFloors: byId("btnApplyFloors"),
    fdsCsvFileInput: byId("fdsCsvFile"),
    btnClearFdsCsv: byId("btnClearFdsCsv"),
    fdsCsvStatus: byId("fdsCsvStatus"),
    btnStart: byId("btnStart"),
    btnStop: byId("btnStop"),
    btnReset: byId("btnReset"),
    btnClearMap: byId("btnClearMap"),
    btnMonte: byId("btnMonte"),
    btnAnalyze: byId("btnAnalyze"),
    btnOptimizeExit: byId("btnOptimizeExit"),
    btnAutoImprove: byId("btnAutoImprove"),
    btnSavePreset: byId("btnSavePreset"),
    btnLoadPreset: byId("btnLoadPreset"),
    btnExportCsv: byId("btnExportCsv"),
    btnParamHistory: byId("btnParamHistory"),
    optimizeReverseInput: byId("optimizeReverse"),
    logEl: byId("log"),
    statusBar: byId("statusBar"),
    floorLabel: byId("floorLabel"),
    presetNameInput: byId("presetName"),
    presetSelect: byId("presetSelect"),
    vizTrailsInput: byId("vizTrails"),
    vizFlowInput: byId("vizFlow"),
    vizPotentialInput: byId("vizPotential"),
    potentialViewModeInput: byId("potentialViewMode"),
    potentialExitIndexInput: byId("potentialExitIndex"),
    agentPresetInput: byId("agentPreset"),
    ratioChildInput: byId("ratioChild"),
    ratioElderlyInput: byId("ratioElderly"),
    ratioPanicInput: byId("ratioPanic"),
    ratioLeaderInput: byId("ratioLeader"),
    ratioTeacherInput: byId("ratioTeacher"),
    ratioStudentInput: byId("ratioStudent"),
    hudTime: byId("hudTime"),
    hudEvac: byId("hudEvac"),
    hudAvg: byId("hudAvg"),
    hudMax: byId("hudMax"),
    modeButtons: {
      spawn: byId("modeSpawn"),
      exit: byId("modeExit"),
      stair: byId("modeStair"),
      stairLink: byId("modeStairLink"),
      fire: byId("modeFire"),
      erase: byId("modeErase")
    }
  };
  return refs;
}

export function initUI() {
  return getUIRefs();
}

export function bindCoreControls(handlers) {
  const ui = getUIRefs();
  if (handlers?.onStart) ui.btnStart?.addEventListener("click", handlers.onStart);
  if (handlers?.onStop) ui.btnStop?.addEventListener("click", handlers.onStop);
  if (handlers?.onReset) ui.btnReset?.addEventListener("click", handlers.onReset);
  if (handlers?.onModeChange) {
    Object.values(ui.modeButtons).forEach((btn) => {
      if (!btn) return;
      btn.addEventListener("click", () => handlers.onModeChange(btn.dataset.mode));
    });
  }
}
