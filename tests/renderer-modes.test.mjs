import test from "node:test";
import assert from "node:assert/strict";
import {
  createRenderer3D,
  SMOKE_VISUALIZATION_MODES,
  smokeMetricColor,
  smokeVisualizationSample
} from "../sim/js/renderer3d.js";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function canvasStub() {
  const drawing = [];
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return text => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      return (...args) => drawing.push({ method: key, args, stroke: target.strokeStyle, fill: target.fillStyle });
    },
    set(target, key, value) { target[key] = value; return true; }
  });
  return {
    drawing,
    canvas: { width: 900, height: 700, getContext: () => context,
      getBoundingClientRect: () => ({ width: 900, height: 700 }),
      addEventListener() {}, removeEventListener() {} }
  };
}

function floor(floorIndex = 0) {
  return {
    floorIndex, cellSizeMeters: 1, wallHeightMeters: 3, floorHeightMeters: 4,
    grid: Array.from({ length: 3 }, () => Array.from({ length: 5 }, () => ({ walkable: true, wall: false })))
  };
}

test("3D adapter separates physical upper layer and two FDS sampling heights", () => {
  const cell = deepFreeze({
    smokeLayerDepthMeters: 0.6,
    smokeLayerInterfaceHeightMeters: 2.4,
    upperLayerExtinctionCoefficientM1: 0.15,
    upperLayerCoPpm: 150,
    upperLayerTemperatureC: 90,
    smokeDensity: 50, extinctionCoefficientPerM: 9, coPpm: 900, temperatureC: 400,
    smokeDataSource: "fds_csv",
    fdsSamples: [{ sampleHeightMeters: 1.6, opticalDensityM1: 0.9, coPpm: 900 },
      { sampleHeightMeters: 2.8, temperatureC: 180 }]
  });
  const sample = smokeVisualizationSample(cell, 3);
  assert.equal(sample.extinctionCoefficientPerM, 0.15);
  assert.equal(sample.coPpm, 150);
  assert.equal(sample.temperatureC, 90);
  assert.equal(sample.source, "reduced_order_nist");
  assert.equal(sample.layer.interfaceHeightMeters, 2.4);
  assert.ok(Math.abs(sample.layer.depthMeters - 0.6) < 1e-12);
  assert.deepEqual(sample.pointSamples.map(point => point.sampleHeightMeters), [1.6, 2.8]);
  assert.equal(sample.pointSamples[1].coPpm, null, "missing FDS species is not fabricated");
});

test("FDS eye-level density never creates an upper layer when physical depth is zero", () => {
  const sample = smokeVisualizationSample({
    smokeLayerDepthMeters: 0, upperLayerExtinctionCoefficientM1: 0,
    smokeDensity: 20, extinctionCoefficientM1: 2,
    fdsSamples: [{ sampleHeightMeters: 1.6, opticalDensityM1: 2 }]
  }, 3, { legacyDensity: 20 });
  assert.equal(sample.density, 0);
  assert.equal(sample.layer, null);
  assert.equal(sample.pointSamples.length, 1);
});

test("legacy density-only 3D callers still display smoke", () => {
  const sample = smokeVisualizationSample({ smokeDensity: 2, opticalDensity: 0 });
  assert.equal(sample.density, 2);
  assert.equal(sample.extinctionCoefficientPerM, 0.64);
  assert.equal(smokeVisualizationSample(null).density, 0);
});

test("3D visualization modes supply distinct CO, temperature and source colors", () => {
  assert.deepEqual(SMOKE_VISUALIZATION_MODES, ["density", "extinction", "visibility", "co", "temperature", "source"]);
  assert.notEqual(smokeMetricColor("co", { coPpm: 100 }), smokeMetricColor("co", { coPpm: 1000 }));
  assert.notEqual(smokeMetricColor("temperature", { temperatureC: 40 }), smokeMetricColor("temperature", { temperatureC: 190 }));
  assert.equal(smokeMetricColor("source", { source: "fds_csv" }), "#55e4ff");
  assert.equal(smokeMetricColor("source", { source: "reduced_order_nist" }), "#a0a8b0");
  assert.equal(smokeMetricColor('temperature', {coPpm:200,temperatureC:null}), '#63717d');
  assert.notEqual(smokeMetricColor('co', {coPpm:0}), '#63717d');
});

test("renderer draws layers, FDS points and stair transfer from frozen shared state only", () => {
  const lower = floor(), upper = floor(1);
  lower.grid[1][2] = {
    walkable: true, wall: false, stair: true,
    smokeLayerDepthMeters: 0.8, smokeLayerInterfaceHeightMeters: 2.2,
    upperLayerExtinctionCoefficientM1: 0.4, upperLayerCoPpm: 230, upperLayerTemperatureC: 110,
    fdsSamples: [{ sampleHeightMeters: 1.6, coPpm: 300, opticalDensityM1: 0.7 }]
  };
  upper.grid[1][2].stair = true;
  const state = deepFreeze({ map: { floorStates: [lower, upper] }, agents: [],
    sim: { time: 12, verticalSmokeTransfers: [{ from: { floorIndex: 0, cx: 2, cy: 1 },
      to: { floorIndex: 1, cx: 2, cy: 1 }, volumeM3: 0.03, sootMassKg: 0.0001 }] } });
  const before = JSON.stringify(state);
  const { canvas, drawing } = canvasStub();
  const renderer = createRenderer3D({ canvas, state, options: { autoResize: false } });
  for (const mode of SMOKE_VISUALIZATION_MODES) {
    assert.equal(renderer.setSmokeVisualizationMode(mode), mode);
    const stats = renderer.renderOnce(1000);
    assert.equal(stats.smokeVisualizationMode, mode);
    assert.equal(stats.smokeSamples, 1);
    assert.equal(stats.fdsSamples, 1);
    assert.equal(stats.stairSmokeTransfers, 1);
    assert.equal(stats.layerInterfaceMinMeters, 2.2);
    assert.ok(Math.abs(stats.maxLayerDepthMeters - 0.8) < 1e-12);
  }
  assert.ok(drawing.some(item => item.stroke === "#55e4ff" && item.method === "arc"), "cyan ring for FDS point");
  assert.ok(drawing.some(item => item.stroke === "#ffbd67" && item.method === "lineTo"), "amber stair flow arrow");
  assert.equal(JSON.stringify(state), before);
  renderer.setSmokeLayerBounds(false);
  assert.equal(renderer.setSmokeVisualizationMode("unknown"), "extinction");
  renderer.destroy();
});

test("empty canvas fallback accepts additive 3D controls without throwing", () => {
  const renderer = createRenderer3D({ canvas: {} });
  assert.doesNotThrow(() => renderer.setSmokeVisualizationMode("source"));
  assert.doesNotThrow(() => renderer.setSmokeLayerBounds(false));
  assert.doesNotThrow(() => renderer.setSmokeDisplayMode('analysis'));
  assert.doesNotThrow(() => renderer.setFireVisualizationMode('hrr'));
  assert.doesNotThrow(() => renderer.setDataSourceOverlay('mixed'));
});

test('3D display controls and picking preserve a frozen fire/smoke state', () => {
  const room=floor();
  room.grid[1][2]={walkable:true,fire:true,fireSource:'spread',hrrKw:500,fireIntensity:.2,fireAgeSec:24,
    heatFluxKwM2:4,smokeLayerDepthMeters:.6,smokeLayerInterfaceHeightMeters:2.4,upperLayerExtinctionCoefficientM1:.05};
  const state=deepFreeze({map:{floorStates:[room]},agents:[],sim:{time:24}}),before=JSON.stringify(state);
  const {canvas}=canvasStub();
  const renderer=createRenderer3D({canvas,state,options:{autoResize:false}});
  renderer.renderOnce();
  const point=renderer.projectCell({floorIndex:0,cx:2,cy:1});
  assert.deepEqual(renderer.pickCell(point.x,point.y),{floorIndex:0,cx:2,cy:1});
  for(const mode of ['physical','analysis'])for(const metric of ['intensity','hrr','age','heat_flux','spread_front']) {
    renderer.setSmokeDisplayMode(mode);renderer.setFireVisualizationMode(metric);renderer.setDataSourceOverlay('mixed');
    const stats=renderer.renderOnce();
    assert.equal(stats.smokeDisplayMode,mode);assert.equal(stats.fireVisualizationMode,metric);
    assert.equal(stats.smokeSamples,1);
  }
  assert.equal(JSON.stringify(state),before);
  renderer.destroy();
});
