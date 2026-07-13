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
  place('modeFire', cells[Math.floor(cells.length * 0.55)]);

  const fdsText = [
    'time_s,floor,cx,cy,heat_flux_kw_m2,optical_density_m_1,co_ppm,visibility_m,temperature_c',
    '0,3,10,60,0,0,0,30,20',
    '30,3,10,60,3.0,0.20,250,12,45',
    '60,3,10,60,8.5,0.70,800,4,90'
  ].join('\\n');
  const fdsFile = new File([fdsText], 'fds_risk_sample.csv', { type: 'text/csv' });
  const transfer = new DataTransfer();
  transfer.items.add(fdsFile);
  const fdsInput = document.getElementById('fdsCsvFile');
  fdsInput.files = transfer.files;
  fdsInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);

  document.getElementById('btnStart').click();
  await sleep(1200);
  document.getElementById('btnViewSplit').click();
  await sleep(350);

  const smokeMax = Math.max(...floor.smokeMap.flat());
  const firstAgent = state.agents[0] || null;
  const renderStats = state.render.renderer3d?.renderOnce() || null;
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
    fdsActive: state.hazards.fds.active,
    agents: state.agents.length,
    firstAgent: firstAgent && {
      floorIndex: firstAgent.floorIndex,
      worldX: firstAgent.worldX,
      worldY: firstAgent.worldY,
      worldZ: firstAgent.worldZ,
      behaviorState: firstAgent.behaviorState,
      type: firstAgent.type
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
  await sleep(5200);
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
assert.deepEqual(dialogs, []);

socket.close();
