import assert from "node:assert/strict";

const debugBase = process.argv[2] || "http://127.0.0.1:9222";
const viewUrl = process.argv[3] || "http://127.0.0.1:8000/sim/3d.html?live=1";
const target = await fetch(`${debugBase}/json/new?${encodeURIComponent(viewUrl)}`, { method: "PUT" })
  .then(response => response.json());
if (!target.webSocketDebuggerUrl) throw new Error("Could not open standalone 3D target");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let id = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  } else if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.text || "runtime exception");
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args?.map(item => item.value || item.description).join(" ") || "console error");
  }
});

function send(method, params = {}) {
  const requestId = ++id;
  socket.send(JSON.stringify({ id: requestId, method, params }));
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
}

await send("Runtime.enable");
const evaluated = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const { state } = await import('./js/state.js');
    for (let i = 0; i < 60; i++) {
      if (state.agents.length && state.map.floorStates?.length) break;
      await sleep(100);
    }
    const floors = state.map.floorStates || [];
    return {
      connection: document.getElementById('standaloneConnection')?.textContent,
      agents: state.agents.length,
      floorIndices: floors.map(floor => floor.floorIndex),
      smokeMax: floors.length ? Math.max(...floors.map(floor => floor.smokeMap?.length ? Math.max(...floor.smokeMap.flat()) : 0)) : 0,
      fires: floors.reduce((sum, floor) => sum + (floor.grid?.flat().filter(cell => cell.fire).length || 0), 0),
      simTime: state.sim.time,
      canvasWidth: document.getElementById('simCanvas3d')?.width || 0
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "bridge evaluation failed");
const result = evaluated.result.value;

console.log(JSON.stringify(result, null, 2));

assert.match(result.connection, /同期中/);
assert.ok(result.agents > 0);
assert.ok(result.floorIndices.includes(1));
assert.ok(result.floorIndices.includes(2));
assert.ok(result.smokeMax > 0);
assert.ok(result.simTime > 0);
assert.ok(result.canvasWidth > 0);
assert.deepEqual(errors, []);

socket.close();
await fetch(`${debugBase}/json/close/${target.id}`);
