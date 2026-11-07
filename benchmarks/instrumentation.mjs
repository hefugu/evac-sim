// 計測専用のレスポンス変換。sim/ 配下のファイルを書き換えない。
function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`計測位置を一意に特定できません: ${needle.slice(0, 90)}`);
  return source.replace(needle, replacement);
}

export function instrumentSource(source, moduleName) {
  let result = source.replace(/\r\n/g, '\n');
  const begin = label => `\n    const __benchStart = performance.now();\n    try {`;
  const end = label => `\n    } finally { globalThis.__evacBench?.record('${label}', performance.now() - __benchStart); }\n`;
  if (moduleName === 'core') {
    for (const [label, start, finish] of [
      ['step', '  function stepSimulation(dt) {', '\n  }\n\n  function analyzeBottlenecks'],
      ['routing', '  function rebuildPotentialCache(routeRisk = null) {', '\n  }\n\n  function chooseExitForAgent'],
      ['render', '  function drawScene() {', '\n  }\n\n  document.addEventListener("hazard-display-change", drawScene);']
    ]) {
      result = replaceOnce(result, start, start + begin(label));
      result = replaceOnce(result, finish, end(label) + finish);
    }
    for (const [label, variable] of [['fire', 'fire'], ['smoke', 'smoke'], ['agentBlock', 'agent']]) {
      const needle = `perfProfile.${variable}Ms += performance.now() - ${variable}StartedAt;`;
      result = replaceOnce(result, needle,
        `const __bench${variable}Ms = performance.now() - ${variable}StartedAt;\n` +
        `      perfProfile.${variable}Ms += __bench${variable}Ms;\n` +
        `      globalThis.__evacBench?.record('${label}', __bench${variable}Ms);`);
    }
  } else if (moduleName === 'pedestrian') {
    const signature = '  options = {}\n) {\n  if (!Array.isArray(agents)';
    result = replaceOnce(result, signature, '  options = {}\n) {' + begin('pedestrian') + '\n  if (!Array.isArray(agents)');
    const suffix = '\n  return agents;\n}\n';
    if (!result.endsWith(suffix)) throw new Error('歩行者モジュールの終端が変わりました');
    result = result.slice(0, -suffix.length) + '\n  return agents;' + end('pedestrian') + '}\n';
  } else throw new Error(`未知の計測モジュール: ${moduleName}`);
  return result;
}
