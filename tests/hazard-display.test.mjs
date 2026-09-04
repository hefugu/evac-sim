import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSmokeOpacityPhysical as physical, computeSmokeOpacityAnalysis as analysis,
  computeSmokeViewPathLength, computeFireVisualStrength, createFireDisplayData, isFireSpreadFront,
  getCellHazardInspection, resolveFieldDisplaySource, resolveHazardDisplaySource } from '../sim/js/visualization/hazard-display.js';

test('Beer–Lambert is monotone, dimensionally K*L and analysis preserves zero', () => {
  assert.equal(physical(0, 1), 0); assert.equal(physical(1, 0), 0);
  assert.ok(Math.abs(physical(2, .5) - (1 - Math.exp(-1))) < 1e-14);
  assert.ok(physical(.2, .5) > physical(.1, .5));
  assert.ok(analysis(.01, .5) > physical(.01, .5));
  assert.equal(analysis(0, .5), 0); assert.equal(analysis(1, 0), 0);
  assert.equal(physical(NaN, 1), 0); assert.equal(physical(-2, 1), 0);
});
test('3D center chord respects depth zero and viewing direction', () => {
  assert.equal(computeSmokeViewPathLength({ cellSizeMeters: 1, layerDepthMeters: 0 }), 0);
  assert.equal(computeSmokeViewPathLength({ cellSizeMeters: 1, layerDepthMeters: .2 }), .2);
  assert.equal(computeSmokeViewPathLength({ cellSizeMeters: 1, layerDepthMeters: .2, viewDirection: {x:1,y:0,z:0} }), 1);
});
test('HRR, fire age and heat flux monotonically drive glyphs without a solver', () => {
  for (const [metric, key] of [['hrr', 'hrrKw'], ['age', 'fireAgeSec'], ['heat_flux', 'heatFluxKwM2']]) {
    assert.ok(computeFireVisualStrength({[key]:2},{metric}) > computeFireVisualStrength({[key]:1},{metric}));
  }
  assert.ok(createFireDisplayData({fire:true,hrrKw:1000}).flameHeightMeters > createFireDisplayData({fire:true,hrrKw:10}).flameHeightMeters);
  const grid = [[{fire:true,walkable:true},{fire:false,walkable:true}]];
  assert.equal(isFireSpreadFront(grid,0,0),true);
  assert.equal(createFireDisplayData(grid[0][0],{metric:'spread_front',isFront:true}).strength,1);
  grid[0][1].wall = true;
  assert.equal(isFireSpreadFront(grid,0,0),false);
});
test('field provenance and inspection retain partial FDS, physical upper layer and missing values', () => {
  const cell = Object.freeze({fdsFields:['coPpm','temperatureC'], coPpm:500, eyeLevelTemperatureC:80,
    upperLayerCoPpm:50, eyeLevelExtinctionCoefficientM1:.1, hrrKw:120, fireAgeSec:14,
    smokeLayerDepthMeters:.4, smokeLayerInterfaceHeightMeters:2.4, fireDataSource:'fds_csv'});
  assert.equal(resolveFieldDisplaySource(cell,'coPpm'),'fds');
  for (const key of ['hrrKw','fireAgeSec','temperatureC','upperLayerCoPpm','eyeLevelExtinctionCoefficientM1']) assert.equal(resolveFieldDisplaySource(cell,key),'fallback');
  assert.equal(resolveHazardDisplaySource(cell),'mixed');
  const state = {map:{floorStates:[{floorIndex:2,grid:[[cell]]}]}};
  const before = JSON.stringify(state);
  const result = getCellHazardInspection(state,{floorIndex:2,cx:0,cy:0});
  assert.equal(result.rows.find(r=>r.key==='hrrKw').value,120);
  assert.equal(result.rows.find(r=>r.key==='smokeDensity').value,null);
  assert.equal(result.rows.find(r=>r.key==='coPpm').unit,'ppm');
  assert.equal(result.rows.find(r=>r.key==='coPpm').source,'fds');
  assert.equal(JSON.stringify(state),before);
});
