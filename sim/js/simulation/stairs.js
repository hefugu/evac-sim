export function stairEndpointKey(floor, cx, cy) {
  return `${floor}:${cx}:${cy}`;
}

export function normalizeStairLinkEndpoints(a, b) {
  const ka = stairEndpointKey(a.floor, a.cx, a.cy);
  const kb = stairEndpointKey(b.floor, b.cx, b.cy);

  return ka <= kb
    ? [
        { floor: a.floor, cx: a.cx, cy: a.cy },
        { floor: b.floor, cx: b.cx, cy: b.cy }
      ]
    : [
        { floor: b.floor, cx: b.cx, cy: b.cy },
        { floor: a.floor, cx: a.cx, cy: a.cy }
      ];
}

export function stairLinkHash(a, b) {
  const [na, nb] = normalizeStairLinkEndpoints(a, b);
  return `${stairEndpointKey(na.floor, na.cx, na.cy)}|${stairEndpointKey(nb.floor, nb.cx, nb.cy)}`;
}