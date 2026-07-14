import assert from "node:assert/strict";

const debugBase = process.argv[2] || "http://127.0.0.1:9222";
const appUrl = process.argv[3] || "http://127.0.0.1:8000/sim/";

const pages = await fetch(`${debugBase}/json/list`).then(response => response.json());
const page = pages.find(item => item.type === "page" && item.url === "about:blank") ||
  pages.find(item => item.type === "page" && item.url === appUrl) ||
  pages.find(item => item.type === "page");
if (!page?.webSocketDebuggerUrl) throw new Error("No debuggable Edge page found");
const appOrigin = new URL(appUrl).origin;
for (const extra of pages) {
  if (extra.id === page.id || extra.type !== "page") continue;
  if (extra.url?.startsWith(`${appOrigin}/sim/`)) {
    await fetch(`${debugBase}/json/close/${extra.id}`).catch(() => {});
  }
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const errors = [];
const dialogs = [];
const eventWaiters = new Map();

socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.text || "runtime exception");
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args?.map(item => item.value || item.description).join(" ") || "console error");
  }
  if (message.method === "Page.javascriptDialogOpening") {
    dialogs.push(message.params.message || message.params.type);
    send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  }
  const waiters = eventWaiters.get(message.method);
  if (waiters?.length) waiters.shift()(message.params);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function waitEvent(method, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
    const wrapped = value => {
      clearTimeout(timer);
      resolve(value);
    };
    const waiters = eventWaiters.get(method) || [];
    waiters.push(wrapped);
    eventWaiters.set(method, waiters);
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
  return result.result?.value;
}

await Promise.all([
  send("Runtime.enable"),
  send("Page.enable"),
  send("Log.enable")
]);
const loaded = waitEvent("Page.loadEventFired");
await send("Page.navigate", { url: appUrl });
await loaded;

const result = await evaluate(`(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { state } = await import('./js/state.js');
  const sampleButton = document.getElementById('btnLoadSample3F');
  if (!sampleButton) throw new Error('sample button missing');
  sampleButton.click();
  for (let i = 0; i < 80; i++) {
    if (state.map.floorStates?.[2]?.baseImage && state.map.floorStates[2].grid?.length) break;
    await sleep(50);
  }
  const floor = state.map.floorStates?.[2];
  if (!floor?.baseImage) throw new Error('3F sample did not load');

  const cells = [];
  floor.grid.forEach((row, cy) => row.forEach((cell, cx) => {
    if (cell.walkable && !cell.stair && !cell.fire) cells.push({ cx, cy });
  }));
  if (cells.length < 30) throw new Error('not enough walkable cells');
  const canvas = document.getElementById('simCanvas');
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / floor.baseImage.width, rect.height / floor.baseImage.height);
  const ox = (rect.width - floor.baseImage.width * scale) / 2;
  const oy = (rect.height - floor.baseImage.height * scale) / 2;
  const place = (buttonId, cell) => {
    document.getElementById(buttonId).click();
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rect.left + ox + (cell.cx + 0.5) * 4 * scale,
      clientY: rect.top + oy + (cell.cy + 0.5) * 4 * scale,
      pointerId: 1,
      button: 0
    }));
  };
  place('modeSpawn', cells[0]);
  place('modeExit', cells[cells.length - 1]);
  const fireCell = cells[Math.floor(cells.length * 0.55)];
  place('modeFire', fireCell);

  const fdsCell = cells[5];
  const temperatureCell = cells[10];
  const fdsText = [
    'time_s,floor,cx,cy,heat_flux_kw_m2,extinction_coefficient_m_1,co_ppm,visibility_m,temperature_c',
    '0,3,' + fdsCell.cx + ',' + fdsCell.cy + ',6.5,0.40,350,7.5,88',
    '0,3,' + fireCell.cx + ',' + fireCell.cy + ',9.0,,,,100',
    // This later sparse update must retain both t=0 cells and must affect
    // routing/exposure even though it contains temperature only.
    '0.5,3,' + temperatureCell.cx + ',' + temperatureCell.cy + ',,,,,500',
    '30,3,' + fdsCell.cx + ',' + fdsCell.cy + ',3.0,0.20,250,12,45',
    '60,3,' + fdsCell.cx + ',' + fdsCell.cy + ',8.5,0.70,800,4,90'
  ].join('\\n');
  const fdsFile = new File([fdsText], 'fds_risk_sample.csv', { type: 'text/csv' });
  const transfer = new DataTransfer();
  transfer.items.add(fdsFile);
  const fdsInput = document.getElementById('fdsCsvFile');
  fdsInput.files = transfer.files;
  fdsInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);

  document.getElementById('btnReset').click();
  await sleep(80);
  const fdsAfterActiveReset = {
    active: state.hazards.fds.active,
    heatFluxKwM2: floor.grid[fdsCell.cy][fdsCell.cx].heatFluxKwM2,
    temperatureC: floor.grid[fdsCell.cy][fdsCell.cx].temperatureC,
    hazardDataSource: floor.grid[fdsCell.cy][fdsCell.cx].hazardDataSource
  };

  // A failed start temporarily removes the FDS overlay while it rebuilds the
  // fallback route/fire baseline. The stopped view must receive it back.
  place('modeErase', cells[cells.length - 1]);
  document.getElementById('btnStart').click();
  await sleep(80);
  const fdsAfterFailedStart = {
    active: state.hazards.fds.active,
    running: state.sim.running,
    heatFluxKwM2: floor.grid[fdsCell.cy][fdsCell.cx].heatFluxKwM2,
    temperatureC: floor.grid[fdsCell.cy][fdsCell.cx].temperatureC,
    hazardDataSource: floor.grid[fdsCell.cy][fdsCell.cx].hazardDataSource
  };
  place('modeExit', cells[cells.length - 1]);
  document.getElementById('btnStart').click();
  const fdsAtSuccessfulStart = {
    heatFluxKwM2: floor.grid[fdsCell.cy][fdsCell.cx].heatFluxKwM2,
    temperatureC: floor.grid[fdsCell.cy][fdsCell.cx].temperatureC,
    hazardDataSource: floor.grid[fdsCell.cy][fdsCell.cx].hazardDataSource
  };
  const exposedAgent = state.agents[0];
  exposedAgent.x = temperatureCell.cx;
  exposedAgent.y = temperatureCell.cy;
  exposedAgent.cx = temperatureCell.cx;
  exposedAgent.cy = temperatureCell.cy;
  exposedAgent.floor = 2;
  exposedAgent.floorIndex = 2;
  exposedAgent.evacDelay = 100;
  await sleep(1200);
  document.getElementById('btnViewSplit').click();
  await sleep(350);

  const smokeMax = Math.max(...floor.smokeMap.flat());
  const firstAgent = state.agents[0] || null;
  const agentCountDuring = state.agents.length;
  const renderStats = state.render.renderer3d?.renderOnce() || null;
  const fdsActive = state.hazards.fds.active;
  const fdsTarget = floor.grid[fdsCell.cy][fdsCell.cx];
  const fdsDuring = {
    heatFluxKwM2: fdsTarget.heatFluxKwM2,
    temperatureC: fdsTarget.temperatureC,
    eyeLevelTemperatureC: fdsTarget.eyeLevelTemperatureC,
    extinctionCoefficientM1: fdsTarget.eyeLevelExtinctionCoefficientM1,
    coPpm: fdsTarget.eyeLevelCoPpm,
    hazardDataSource: fdsTarget.hazardDataSource,
    fireDataSource: fdsTarget.fireDataSource
  };
  const fireTarget = floor.grid[fireCell.cy][fireCell.cx];
  const fireDuring = {
    heatFluxKwM2: fireTarget.heatFluxKwM2,
    temperatureC: fireTarget.temperatureC,
    eyeLevelTemperatureC: fireTarget.eyeLevelTemperatureC,
    fireDataSource: fireTarget.fireDataSource
  };
  const temperatureTarget = floor.grid[temperatureCell.cy][temperatureCell.cx];
  const temperatureOnlyDuring = {
    temperatureC: temperatureTarget.temperatureC,
    eyeLevelTemperatureC: temperatureTarget.eyeLevelTemperatureC,
    heatFluxKwM2: temperatureTarget.heatFluxKwM2,
    fireDataSource: temperatureTarget.fireDataSource,
    temperatureDoseCSeconds: firstAgent?.temperatureDoseCSeconds || 0,
    heatDose: firstAgent?.heatDose || 0
  };
  document.getElementById('btnClearFdsCsv').click();
  await sleep(80);
  const fdsAfter = {
    heatFluxKwM2: fdsTarget.heatFluxKwM2,
    temperatureC: fdsTarget.temperatureC,
    eyeLevelTemperatureC: fdsTarget.eyeLevelTemperatureC,
    extinctionCoefficientM1: fdsTarget.eyeLevelExtinctionCoefficientM1,
    coPpm: fdsTarget.eyeLevelCoPpm,
    hazardDataSource: fdsTarget.hazardDataSource,
    fireDataSource: fdsTarget.fireDataSource
  };
  const fireAfter = {
    heatFluxKwM2: fireTarget.heatFluxKwM2,
    temperatureC: fireTarget.temperatureC,
    eyeLevelTemperatureC: fireTarget.eyeLevelTemperatureC,
    fireDataSource: fireTarget.fireDataSource
  };
  const temperatureOnlyAfter = {
    temperatureC: temperatureTarget.temperatureC,
    eyeLevelTemperatureC: temperatureTarget.eyeLevelTemperatureC,
    fireDataSource: temperatureTarget.fireDataSource
  };

  // Reset must make each manual/Monte-Carlo run start from the same fire age
  // and must remove cells that were ignited by spread in the preceding run.
  const spreadCell = cells[15];
  const spreadTarget = floor.grid[spreadCell.cy][spreadCell.cx];
  Object.assign(spreadTarget, {
    fire: true,
    fireSource: 'spread',
    fireIntensity: 0.7,
    fireAgeSec: 22,
    hrrKw: 900,
    temperatureC: 300,
    heatFluxKwM2: 12,
    heat: 12,
    walkable: false,
    wall: false
  });
  document.getElementById('btnReset').click();
  await sleep(80);
  const resetManual = floor.grid[fireCell.cy][fireCell.cx];
  const resetSpread = floor.grid[spreadCell.cy][spreadCell.cx];
  const resetFireState = {
    manual: {
      fire: resetManual.fire,
      fireSource: resetManual.fireSource,
      fireIntensity: resetManual.fireIntensity,
      fireAgeSec: resetManual.fireAgeSec,
      hrrKw: resetManual.hrrKw,
      temperatureC: resetManual.temperatureC,
      heatFluxKwM2: resetManual.heatFluxKwM2,
      walkable: resetManual.walkable,
      wall: resetManual.wall
    },
    spread: {
      fire: resetSpread.fire,
      fireSource: resetSpread.fireSource ?? null,
      fireAgeSec: resetSpread.fireAgeSec,
      hrrKw: resetSpread.hrrKw,
      temperatureC: resetSpread.temperatureC,
      heatFluxKwM2: resetSpread.heatFluxKwM2,
      walkable: resetSpread.walkable,
      wall: resetSpread.wall
    },
    simTime: state.sim.time,
    agents: state.agents.length
  };
  return {
    floorCount: state.map.floorStates.length,
    floorIndex: floor.floorIndex,
    gridWidth: floor.gridWidth,
    gridHeight: floor.gridHeight,
    walkable: cells.length,
    stairs: floor.stairs.length,
    cellSizeMeters: floor.cellSizeMeters,
    spawns: floor.spawns.length,
    exits: floor.exits.length,
    fires: floor.grid.flat().filter(cell => cell.fire).length,
    fdsActive,
    fdsAfterActiveReset,
    fdsAfterFailedStart,
    fdsAtSuccessfulStart,
    fdsDuring,
    fdsAfter,
    fireDuring,
    fireAfter,
    temperatureOnlyDuring,
    temperatureOnlyAfter,
    resetFireState,
    agents: agentCountDuring,
    firstAgent: firstAgent && {
      floorIndex: firstAgent.floorIndex,
      worldX: firstAgent.worldX,
      worldY: firstAgent.worldY,
      worldZ: firstAgent.worldZ,
      behaviorState: firstAgent.behaviorState,
      type: firstAgent.type,
      temperatureDoseCSeconds: firstAgent.temperatureDoseCSeconds,
      heatDose: firstAgent.heatDose
    },
    smokeMax,
    viewMode: state.render.viewMode,
    canvas3dWidth: document.getElementById('simCanvas3d').width,
    renderer3d: !!state.render.renderer3d,
    stairRender: renderStats && {
      cells: renderStats.stairCells,
      regions: renderStats.stairRegions,
      primitives: renderStats.primitives
    }
  };
})()`);

console.log(JSON.stringify(result, null, 2));

assert.equal(result.floorCount, 3);
assert.equal(result.floorIndex, 2);
assert.equal(result.gridWidth, 150);
assert.equal(result.gridHeight, 200);
assert.ok(result.walkable > 2000);
assert.ok(result.stairs > 500);
assert.equal(result.cellSizeMeters, 0.42);
assert.equal(result.spawns, 1);
assert.equal(result.exits, 1);
assert.ok(result.fires >= 1);
assert.equal(result.fdsActive, true);
assert.equal(result.fdsAfterActiveReset.active, true);
assert.equal(result.fdsAfterActiveReset.heatFluxKwM2, 6.5);
assert.equal(result.fdsAfterActiveReset.temperatureC, 88);
assert.equal(result.fdsAfterActiveReset.hazardDataSource, 'fds_csv');
assert.equal(result.fdsAfterFailedStart.active, true);
assert.equal(result.fdsAfterFailedStart.running, false);
assert.equal(result.fdsAfterFailedStart.heatFluxKwM2, 6.5);
assert.equal(result.fdsAfterFailedStart.temperatureC, 88);
assert.equal(result.fdsAfterFailedStart.hazardDataSource, 'fds_csv');
assert.equal(result.fdsAtSuccessfulStart.heatFluxKwM2, 6.5);
assert.equal(result.fdsAtSuccessfulStart.temperatureC, 88);
assert.equal(result.fdsAtSuccessfulStart.hazardDataSource, 'fds_csv');
assert.equal(result.fdsDuring.heatFluxKwM2, 6.5);
assert.equal(result.fdsDuring.temperatureC, 88);
assert.equal(result.fdsDuring.eyeLevelTemperatureC, 88);
assert.equal(result.fdsDuring.extinctionCoefficientM1, 0.4);
assert.equal(result.fdsDuring.coPpm, 350);
assert.equal(result.fdsDuring.hazardDataSource, 'fds_csv');
assert.equal(result.fdsDuring.fireDataSource, 'fds_csv');
assert.equal(result.fdsAfter.heatFluxKwM2, 0);
assert.equal(result.fdsAfter.temperatureC, 20);
assert.notEqual(result.fdsAfter.eyeLevelTemperatureC, 88);
assert.equal(result.fdsAfter.extinctionCoefficientM1, 0);
assert.equal(result.fdsAfter.coPpm, 0);
assert.notEqual(result.fdsAfter.hazardDataSource, 'fds_csv');
assert.notEqual(result.fdsAfter.fireDataSource, 'fds_csv');
assert.equal(result.fireDuring.heatFluxKwM2, 9);
assert.equal(result.fireDuring.temperatureC, 100);
assert.equal(result.fireDuring.eyeLevelTemperatureC, 100);
assert.equal(result.fireDuring.fireDataSource, 'fds_csv');
assert.ok(result.fireAfter.heatFluxKwM2 > 0);
assert.ok(result.fireAfter.heatFluxKwM2 < 9);
assert.notEqual(result.fireAfter.temperatureC, 100);
assert.notEqual(result.fireAfter.eyeLevelTemperatureC, 100);
assert.equal(result.fireAfter.fireDataSource, 'fallback_t2');
assert.equal(result.temperatureOnlyDuring.temperatureC, 500);
assert.equal(result.temperatureOnlyDuring.eyeLevelTemperatureC, 500);
assert.equal(result.temperatureOnlyDuring.heatFluxKwM2, 0);
assert.equal(result.temperatureOnlyDuring.fireDataSource, 'fds_csv');
assert.ok(result.temperatureOnlyDuring.temperatureDoseCSeconds > 0);
assert.ok(result.temperatureOnlyDuring.heatDose > 0);
assert.equal(result.temperatureOnlyAfter.temperatureC, 20);
assert.notEqual(result.temperatureOnlyAfter.eyeLevelTemperatureC, 500);
assert.notEqual(result.temperatureOnlyAfter.fireDataSource, 'fds_csv');
assert.equal(result.resetFireState.manual.fire, true);
assert.equal(result.resetFireState.manual.fireSource, 'manual');
assert.equal(result.resetFireState.manual.fireIntensity, 0.05);
assert.equal(result.resetFireState.manual.fireAgeSec, 0);
assert.equal(result.resetFireState.manual.hrrKw, 0);
assert.equal(result.resetFireState.manual.temperatureC, 20);
assert.equal(result.resetFireState.manual.heatFluxKwM2, 0);
assert.equal(result.resetFireState.manual.walkable, false);
assert.equal(result.resetFireState.manual.wall, false);
assert.equal(result.resetFireState.spread.fire, false);
assert.equal(result.resetFireState.spread.fireSource, null);
assert.equal(result.resetFireState.spread.fireAgeSec, 0);
assert.equal(result.resetFireState.spread.hrrKw, 0);
assert.equal(result.resetFireState.spread.temperatureC, 20);
assert.equal(result.resetFireState.spread.heatFluxKwM2, 0);
assert.equal(result.resetFireState.spread.walkable, true);
assert.equal(result.resetFireState.spread.wall, false);
assert.equal(result.resetFireState.simTime, 0);
assert.equal(result.resetFireState.agents, 0);
assert.ok(result.agents > 0);
assert.equal(result.firstAgent.floorIndex, 2);
assert.ok(Number.isFinite(result.firstAgent.worldX));
assert.equal(result.firstAgent.worldY, 7);
assert.ok(result.smokeMax > 0);
assert.equal(result.viewMode, "split");
assert.ok(result.canvas3dWidth > 0);
assert.equal(result.renderer3d, true);
assert.equal(result.stairRender.cells, 640);
assert.equal(result.stairRender.regions, 5);
assert.ok(result.stairRender.primitives > 0);

const renamedMap = await evaluate(`(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { state } = await import('./js/state.js');
  const { loadBase64ImageAsFile, SAMPLE_3F_BASE64_URL } = await import('./js/sample3f-loader.js');
  document.getElementById('btnStop').click();
  const select = document.getElementById('currentFloor');
  select.value = '2';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const file = await loadBase64ImageAsFile(SAMPLE_3F_BASE64_URL, 'renamed-school-plan.png');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.getElementById('mapFile');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 80; i++) {
    const floor = state.map.floorStates?.[2];
    if (floor?.mapProfile === 'scitech-3f' && floor.stairs?.length) break;
    await sleep(50);
  }
  const floor = state.map.floorStates?.[2];
  const stats = state.render.renderer3d.renderOnce();
  return {
    profile: floor?.mapProfile,
    stairs: floor?.stairs?.length || 0,
    stairCells: stats.stairCells,
    stairRegions: stats.stairRegions
  };
})()`);

console.log(JSON.stringify({ renamedMap }, null, 2));
assert.equal(renamedMap.profile, 'scitech-3f');
assert.equal(renamedMap.stairs, 640);
assert.equal(renamedMap.stairCells, 640);
assert.equal(renamedMap.stairRegions, 5);

const sharedColorMaps = await evaluate(`(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { state } = await import('./js/state.js');
  const { extractColorMapGrid, isLikelyScitech3FExtraction } = await import('./js/scitech3f-map3d.js');
  const parsedFloors = [];
  for (let floorNumber = 1; floorNumber <= 7; floorNumber++) {
    const response = await fetch('../uploads/' + floorNumber + 'F.png');
    if (!response.ok) throw new Error('map fetch failed: ' + floorNumber + 'F');
    const blob = await response.blob();
    const image = await createImageBitmap(blob);
    const imageWidth = image.width;
    const imageHeight = image.height;
    const parsed = extractColorMapGrid(image, { cellPixels: 4, whiteThreshold: 200 });
    image.close();
    parsedFloors.push({
      floor: floorNumber,
      walkable: parsed.walkableCells,
      stairs: parsed.stairCells,
      exits: parsed.exitPoints,
      keptComponents: parsed.keptComponentCount,
      likely3FProfile: isLikelyScitech3FExtraction(parsed, imageWidth, imageHeight),
      leftEdgeWalkable: parsed.walkableTemplate.some(row => row[0] || row[1])
    });
  }

  const select = document.getElementById('currentFloor');
  select.value = '0';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const mapBlob = await fetch('../uploads/1F.png').then(response => response.blob());
  const file = new File([mapBlob], '1F.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.getElementById('mapFile');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 80; i++) {
    const floor = state.map.floorStates?.[0];
    if (floor?.baseImage && floor.exits?.length === 4 && floor.stairs?.length) break;
    await sleep(50);
  }
  const floor = state.map.floorStates?.[0];
  const beforeClear = floor.exits.map(exit => [exit.cx, exit.cy]);
  const canvas = document.getElementById('simCanvas');
  const clickCell = (buttonId, cell) => {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / floor.baseImage.width, rect.height / floor.baseImage.height);
    const ox = (rect.width - floor.baseImage.width * scale) / 2;
    const oy = (rect.height - floor.baseImage.height * scale) / 2;
    document.getElementById(buttonId).click();
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rect.left + ox + (cell.cx + 0.5) * 4 * scale,
      clientY: rect.top + oy + (cell.cy + 0.5) * 4 * scale,
      pointerId: 3,
      button: 0
    }));
  };
  clickCell('modeErase', floor.exits[0]);
  const imageExitCountAfterErase = floor.exits.length;
  let manualExit = null;
  for (let cy = 0; cy < floor.grid.length && !manualExit; cy++) {
    for (let cx = 0; cx < floor.grid[cy].length; cx++) {
      const cell = floor.grid[cy][cx];
      if (cell.walkable && !cell.stair && !floor.exits.some(exit => exit.cx === cx && exit.cy === cy)) {
        manualExit = { cx, cy };
        break;
      }
    }
  }
  if (!manualExit) throw new Error('manual exit cell missing');
  clickCell('modeExit', manualExit);
  const exitCountWithManual = floor.exits.length;
  document.getElementById('btnClearMap').click();
  await sleep(50);
  const afterClear = state.map.floorStates?.[0]?.exits?.map(exit => [exit.cx, exit.cy]) || [];
  const stats = state.render.renderer3d.renderOnce();
  return {
    parsedFloors,
    profile: floor?.mapProfile,
    stairs: floor?.stairs?.length || 0,
    exits: beforeClear,
    imageExitCountAfterErase,
    exitCountWithManual,
    exitsAfterClear: afterClear,
    globalImageExits: state.map.allExitPoints.filter(exit => exit.floor === 0).length,
    exitWalkable: beforeClear.every(([cx, cy]) => floor.grid?.[cy]?.[cx]?.walkable),
    renderer: stats.rendered
  };
})()`);

console.log(JSON.stringify({ sharedColorMaps }, null, 2));
assert.deepEqual(sharedColorMaps.parsedFloors.map(floor => floor.exits.length), [4, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(
  sharedColorMaps.parsedFloors.map(floor => floor.likely3FProfile),
  [false, false, true, false, false, false, false]
);
assert.equal(sharedColorMaps.parsedFloors[3].leftEdgeWalkable, false);
assert.equal(sharedColorMaps.profile, null);
assert.ok(sharedColorMaps.stairs > 0);
assert.deepEqual(sharedColorMaps.exits, [[43, 75], [90, 124], [51, 140], [124, 145]]);
assert.equal(sharedColorMaps.imageExitCountAfterErase, 4);
assert.equal(sharedColorMaps.exitCountWithManual, 5);
assert.deepEqual(sharedColorMaps.exitsAfterClear, sharedColorMaps.exits);
assert.equal(sharedColorMaps.globalImageExits, 4);
assert.equal(sharedColorMaps.exitWalkable, true);
assert.equal(sharedColorMaps.renderer, true);

const multiFloor = await evaluate(`(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { state } = await import('./js/state.js');
  const { loadBase64ImageAsFile, SAMPLE_3F_BASE64_URL } = await import('./js/sample3f-loader.js');
  document.getElementById('btnView2D').click();
  document.getElementById('btnStop').click();
  document.getElementById('btnReset').click();
  document.getElementById('btnClearFdsCsv').click();
  const select = document.getElementById('currentFloor');
  select.value = '2';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btnClearMap').click();

  select.value = '1';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const file = await loadBase64ImageAsFile(SAMPLE_3F_BASE64_URL, 'scitech_3f_walkable.png');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const mapInput = document.getElementById('mapFile');
  mapInput.files = transfer.files;
  mapInput.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 60; i++) {
    if (state.map.floorStates?.[1]?.baseImage) break;
    await sleep(50);
  }
  const lower = state.map.floorStates[1];
  const upper = state.map.floorStates[2];
  const endpoint = lower.stairs[0];
  if (!endpoint || !upper.grid?.[endpoint.cy]?.[endpoint.cx]?.stair) throw new Error('matching stairs missing');
  const canvas = document.getElementById('simCanvas');
  const place = (buttonId, cell) => {
    const floor = state.map.floorStates[state.map.currentFloor];
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / floor.baseImage.width, rect.height / floor.baseImage.height);
    const ox = (rect.width - floor.baseImage.width * scale) / 2;
    const oy = (rect.height - floor.baseImage.height * scale) / 2;
    document.getElementById(buttonId).click();
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rect.left + ox + (cell.cx + 0.5) * 4 * scale,
      clientY: rect.top + oy + (cell.cy + 0.5) * 4 * scale,
      pointerId: 2,
      button: 0
    }));
  };
  document.getElementById('stairTravelCost').value = '1';
  document.getElementById('stairCapacity').value = '1';
  document.getElementById('stairSmokeTransfer').value = '0.5';
  place('modeExit', endpoint);
  place('modeStairLink', endpoint);
  select.value = '2';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  place('modeStairLink', endpoint);
  place('modeSpawn', endpoint);
  document.getElementById('numAgents').value = '3';
  document.getElementById('startRule').value = 'simultaneous';
  document.getElementById('btnStart').click();
  lower.smokeMap[endpoint.cy][endpoint.cx] = 3;
  lower.grid[endpoint.cy][endpoint.cx].smokeDensity = 3;
  for (let i = 0; i < 90; i++) {
    if (state.agents.length === 3 && state.agents.every(agent => agent.finished)) break;
    await sleep(100);
  }
  const congestion = state.sim.stairCongestion[0] || null;
  return {
    links: state.map.stairLinks.length,
    agents: state.agents.length,
    completedAgents: state.agents.filter(agent => agent.finished).length,
    transitionedAgents: state.agents.filter(agent => agent.stairTransitionCount >= 1).length,
    upperSmoke: upper.smokeMap[endpoint.cy][endpoint.cx],
    congestion,
    link: state.map.stairLinks[0]
  };
})()`);

console.log(JSON.stringify({ multiFloor }, null, 2));
assert.equal(multiFloor.links, 1);
assert.equal(multiFloor.agents, 3);
assert.equal(multiFloor.completedAgents, 3);
assert.equal(multiFloor.transitionedAgents, 3);
assert.ok(multiFloor.upperSmoke > 0);
assert.equal(multiFloor.link.travelCostSec, 1);
assert.equal(multiFloor.link.congestionCapacity, 1);
assert.equal(multiFloor.congestion.completed, 3);
assert.ok(multiFloor.congestion.maxQueue >= 2);
assert.deepEqual(errors, []);
assert.equal(dialogs.length, 1);
assert.match(dialogs[0], /開始位置と出口/);

socket.close();
