import test from 'node:test';
import assert from 'node:assert/strict';
import { derive2DCellDisplay, createRenderer } from '../sim/js/renderer.js';
import { buildAnalysisOverlay } from '../sim/js/visualization/analysis-overlay.js';
import { createGeometrySnapshot3D, createDynamicSnapshot3D, apply3DBridgeMessage } from '../sim/js/state-bridge3d.js';
import { getCellHazardInspection } from '../sim/js/visualization/hazard-display.js';

test('2D physical/analysis opacity uses eye extinction and never inflates cell state', () => {
  const cell=Object.freeze({eyeLevelExtinctionCoefficientM1:.01, smokeDensity:200, smokeLayerDepthMeters:.5});
  const before=JSON.stringify(cell);
  const physical=derive2DCellDisplay(cell,{cellSizeMeters:1});
  const analysis=derive2DCellDisplay(cell,{cellSizeMeters:1,smokeDisplayMode:'analysis'});
  assert.ok(Math.abs(physical.opacity-(1-Math.exp(-.01)))<1e-14);
  assert.ok(analysis.opacity>physical.opacity);
  assert.equal(derive2DCellDisplay({...cell,smokeLayerDepthMeters:0}).opacity,0);
  assert.ok(derive2DCellDisplay({...cell,smokeLayerDepthMeters:0,fdsFields:['opticalDensityM1']}).opacity>0);
  assert.equal(JSON.stringify(cell),before);
});
test('quantitative overlay retains actual ranges, zero and missing data with units', () => {
  const grid=[[{walkable:true,coPpm:0},{walkable:true,coPpm:30},{walkable:true}]];
  const overlay=buildAnalysisOverlay(grid,'co');
  assert.equal(overlay.minValue,0);assert.equal(overlay.maxValue,30);assert.equal(overlay.unit,'ppm');
  assert.equal(overlay.cells[0][2],null);assert.match(overlay.legend,/0–1200/);
  assert.equal(buildAnalysisOverlay(grid,'none'),null);
});
test('renderer uses shared cells and makes balanced canvas transforms for all new modes', () => {
  const calls=[], saved=[];
  const context=new Proxy({}, {get(target,key) {
    if(key in target)return target[key];
    if(key==='createRadialGradient')return ()=>({addColorStop(){}});
    if(key==='measureText')return text=>({width:text.length*6});
    if(key==='save')return ()=>saved.push(1);
    if(key==='restore')return ()=>{assert.ok(saved.length);saved.pop();};
    return (...args)=>calls.push({key,args,stroke:target.strokeStyle});
  },set(t,k,v){t[k]=v;return true;}});
  const cell=Object.freeze({walkable:true,fire:true,fireIntensity:.2,hrrKw:500,fireAgeSec:20,
    eyeLevelExtinctionCoefficientM1:.04,smokeLayerDepthMeters:.6,fdsFields:['coPpm'],coPpm:80});
  const scene={grid:[[cell]],gridW:1,gridH:1,baseImage:{width:4,height:4},layout:{scale:1,ox:0,oy:0},
    cellSizeMeters:1,currentFloor:0,floorCount:1,stairLinks:[],potentialByExit:[],exits:[],spawns:[],agents:[],allExitPoints:[],
    verticalSmokeTransfers:[{from:{floorIndex:0,cx:0,cy:0},to:{floorIndex:1,cx:0,cy:0},volumeM3:.1}]};
  const before=JSON.stringify(cell);
  const renderer=createRenderer({ctx:context,cvs:{getBoundingClientRect:()=>({width:800,height:500})},cellSizePx:4,typeMeta:{},clamp:(v,a,b)=>Math.max(a,Math.min(b,v))});
  for(const metric of ['density','extinction','visibility','co','temperature']) {
    renderer.render({...scene,hazardDisplay:{smokeMetric:metric,smokeDisplayMode:'analysis',dataSourceOverlay:'mixed'}});
  }
  assert.equal(JSON.stringify(cell),before);assert.equal(saved.length,0);
  assert.ok(calls.some(c=>c.key==='lineTo' && c.stroke==='#ffbd67'),'actual stair transfer arrow');
});
test('bridge inspection preserves raw upper/eye quantities, fire provenance and FDS release', () => {
  const source={map:{floorStates:[{floorIndex:0,grid:[[{walkable:true,fire:true,hrrKw:123,fireAgeSec:15,
    fireSource:'spread',ignitionTime:4,spreadSourceCell:{floorIndex:0,cx:1,cy:0},smokeDensity:2,eyeLevelSmokeDensity:.3,
    coPpm:600,upperLayerCoPpm:120,temperatureC:99,upperLayerTemperatureC:70,eyeLevelTemperatureC:42,
    smokeLayerDepthMeters:.4,smokeLayerInterfaceHeightMeters:2.4,fdsFields:['coPpm'],eyeLevelDataSource:'fds_csv',
    smokeDataSource:'fds_csv',fireDataSource:'fallback_t2',hazardDataSource:'fds_csv'}]]}]} };
  const target={};apply3DBridgeMessage(target,createGeometrySnapshot3D(source));
  apply3DBridgeMessage(target,createDynamicSnapshot3D(source));
  assert.deepEqual(getCellHazardInspection(target,{floorIndex:0,cx:0,cy:0}),getCellHazardInspection(source,{floorIndex:0,cx:0,cy:0}));
  const cell=source.map.floorStates[0].grid[0][0];
  delete cell.fdsFields;delete cell.eyeLevelDataSource;cell.coPpm=120;cell.smokeDataSource='reduced_order_nist';cell.hazardDataSource='reduced_order_nist';
  apply3DBridgeMessage(target,createDynamicSnapshot3D(source));
  const inspection=getCellHazardInspection(target,{floorIndex:0,cx:0,cy:0});
  assert.equal(inspection.rows.find(r=>r.key==='coPpm').source,'fallback');
  assert.equal(inspection.rows.find(r=>r.key==='coPpm').value,120);
  assert.equal(target.map.floorStates[0].grid[0][0].fdsFields,undefined);
});
