import test from 'node:test';
import assert from 'node:assert/strict';
import { canWalkSegment } from '../sim/js/simulation/grid-movement.js';
import { computePotentialFieldFromSeedsModule as potential } from '../sim/js/simulation/potential.js';
import { createStairTrafficState, enqueueStairTransition, stepStairTraffic } from '../sim/js/simulation/stairs3d.js';

test('continuous movement rejects wall corners, intermediate walls and out-of-bounds', () => {
  const open = (x, y) => x >= 0 && y >= 0 && x < 4 && y < 4 && !(x === 1 && y === 0);
  assert.equal(canWalkSegment(0, 0, 1, 1, open), false);
  assert.equal(canWalkSegment(0, 0, 3, 0, open), false);
  assert.equal(canWalkSegment(0, 0, -1, 0, open), false);
  assert.equal(canWalkSegment(0.4, 1, 1, 0.4, open), false);
  assert.equal(canWalkSegment(0, 0, 0, 1, open), true);
  assert.equal(canWalkSegment(1, 1, 0.5, 1.5, open), true);
});

test('weighted exit field chooses a longer clean path and charges the forward destination', () => {
  const grid = Array.from({length: 3}, () => Array.from({length: 5}, () => ({walkable: true})));
  const ctx = { grid, floorStates: [{grid}], floorCount: 1, gridW: 5, gridH: 3, currentFloor: 0,
    isAgentTraversableCell: (f,x,y) => !!grid[y]?.[x], getLinkedStairDestinations: () => [],
    traversalCost: (f,x,y) => y === 1 && x === 2 ? 100 : 0 };
  const field = potential([{floor: 0, cx: 4, cy: 1}], ctx)[0];
  assert.ok(field[1][0] < 6);
  assert.ok(field[0][2] < field[1][1]);
  // A person already inside the hazardous cell can leave without paying the
  // destination's risk again on a backwards expansion.
  assert.equal(field[1][2], 2);
});

const link = {id: 'a', from: {floorIndex: 1, cx: 0, cy: 0}, to: {floorIndex: 0, cx: 0, cy: 0},
  travelCostSec: 1, congestionCapacity: 2};
function traveling(links = [link], people = [{id: 1, floor: 1, x: 0, y: 0}]) {
  let traffic = createStairTrafficState(links);
  people.forEach((a, i) => { traffic = enqueueStairTransition(traffic, links[i % links.length], a).state; });
  return stepStairTraffic(traffic, links, people, 0.1);
}

test('a full or burning stair landing holds a traveller until it becomes available', () => {
  const start = traveling();
  const blockers = [{id: 2, floor: 0, x: 0, y: 0}, {id: 3, floor: 0, x: 0, y: 0}];
  const held = stepStairTraffic(start.trafficState, [link], [...start.agents, ...blockers], 2);
  assert.equal(held.completed.length, 0);
  assert.equal(held.agents[0].stairTransition.remainingSec, 0);
  const fire = stepStairTraffic(held.trafficState, [link], held.agents.slice(0, 1), 1, {canArrive: () => false});
  assert.equal(fire.completed.length, 0);
  const clear = stepStairTraffic(fire.trafficState, [link], fire.agents, 0.1);
  assert.equal(clear.completed.length, 1);
  assert.equal(clear.agents[0].floor, 0);
});

test('simultaneous arrivals across different links reserve landing capacity together', () => {
  const other = {...link, id: 'b'};
  const start = traveling([link, other], [1,2,3,4].map(id => ({id, floor: 1, x: 0, y: 0})));
  const arrivals = stepStairTraffic(start.trafficState, [link, other], start.agents, 2);
  assert.equal(arrivals.completed.length, 2);
  assert.equal(arrivals.agents.filter(a => a.floor === 0).length, 2);
  assert.equal(arrivals.agents.filter(a => a.stairTransition?.status === 'in_transit').length, 2);
});

function opposingStairTraffic() {
  const start = traveling([link], [1, 2].map(id => ({id, floor: 1, x: 0, y: 0})));
  const people = start.agents.concat([3, 4].map(id => ({id, floor: 0, x: 0, y: 0})));
  let traffic = start.trafficState;
  for (const person of people.slice(2)) traffic = enqueueStairTransition(traffic, link, person).state;
  return { traffic, people };
}

test('opposing stair traffic exchanges FIFO departures with ready arrivals without deadlocking', () => {
  const { traffic, people } = opposingStairTraffic();
  const originalTraffic = structuredClone(traffic), originalPeople = structuredClone(people);
  const exchange = stepStairTraffic(traffic, [link], people, 2);
  assert.deepEqual(exchange.completed.map(a => a.agentId), [1, 2]);
  assert.deepEqual(exchange.started.map(a => a.agentId), [3, 4]);
  assert.equal(exchange.congestion[0].queued, 0);
  assert.equal(exchange.congestion[0].inTransit, link.congestionCapacity);
  for (const floor of [0, 1]) {
    const standing = exchange.agents.filter(a => a.floor === floor && a.stairTransition?.status !== 'in_transit');
    assert.ok(standing.length <= 2);
  }
  assert.deepEqual(traffic, originalTraffic);
  assert.deepEqual(people, originalPeople);
  const finished = stepStairTraffic(exchange.trafficState, [link], exchange.agents, 2);
  assert.deepEqual(finished.completed.map(a => a.agentId), [3, 4]);
  assert.equal(finished.congestion[0].completed, 4);
  assert.equal(finished.congestion[0].inTransit, 0);
});

test('blocked stair landings do not permit a departure-arrival exchange', () => {
  const { traffic, people } = opposingStairTraffic();
  const blocked = stepStairTraffic(traffic, [link], people, 2, { canArrive: () => false });
  assert.equal(blocked.completed.length, 0);
  assert.equal(blocked.started.length, 0);
  assert.equal(blocked.congestion[0].queued, 2);
  assert.equal(blocked.congestion[0].inTransit, 2);
  const clear = stepStairTraffic(blocked.trafficState, [link], blocked.agents, 0.1);
  assert.deepEqual(clear.completed.map(a => a.agentId), [1, 2]);
  assert.deepEqual(clear.started.map(a => a.agentId), [3, 4]);
});

test('each stair exchange requires one ready arrival and keeps later FIFO requests queued', () => {
  const { traffic, people } = opposingStairTraffic();
  traffic.byLink[link.id].inTransit[1].remainingSec = 3;
  const exchange = stepStairTraffic(traffic, [link], people, 1);
  assert.deepEqual(exchange.completed.map(a => a.agentId), [1]);
  assert.deepEqual(exchange.started.map(a => a.agentId), [3]);
  assert.deepEqual(exchange.trafficState.byLink[link.id].queue.map(a => a.agentId), [4]);
  assert.equal(exchange.congestion[0].inTransit, 2);
  assert.equal(exchange.agents.filter(a => a.floor === 0 && a.stairTransition?.status !== 'in_transit').length, 2);
});

test('a blocked opposite-direction queue head does not prevent landing exchanges with directional FIFO', () => {
  const start = traveling([link], [1, 2].map(id => ({id, floor: 1, x: 0, y: 0})));
  const waiting = [{id: 5, floor: 1, x: 0, y: 0}, {id: 4, floor: 0, x: 0, y: 0}, {id: 3, floor: 0, x: 0, y: 0}];
  let traffic = start.trafficState;
  for (const person of waiting) traffic = enqueueStairTransition(traffic, link, person).state;
  const exchange = stepStairTraffic(traffic, [link], start.agents.concat(waiting), 2);
  assert.deepEqual(exchange.completed.map(a => a.agentId), [1, 2]);
  assert.deepEqual(exchange.started.map(a => a.agentId), [4, 3]);
  assert.deepEqual(exchange.trafficState.byLink[link.id].queue.map(a => a.agentId), [5]);
  assert.equal(exchange.congestion[0].inTransit, link.congestionCapacity);
  assert.equal(exchange.agents.filter(a => a.floor === 0 && a.stairTransition?.status !== 'in_transit').length, 2);
});
