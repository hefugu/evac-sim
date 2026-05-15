export function rand(min = 0, max = 1) {
  return min + Math.random() * (max - min);
}

export function pickOne(list) {
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}
