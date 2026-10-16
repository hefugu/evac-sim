// response変換の有無・同seed repeat・比較器を、実production loopで確認する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const common = ['benchmarks/run.mjs', '--scenarios', 'B06', '--populations', '6', '--seconds', '2', '--seed', '0'];
function run(name, extra) {
  execFileSync(process.execPath, [...common, '--out', `benchmarks/results/verification/${name}`, ...extra],
    { cwd: root, stdio: 'inherit', timeout: 180_000 });
}
const read = name => readFile(new URL(`./results/verification/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
run('instrumented', ['--repeats', '2']);
run('plain', ['--no-instrumentation']);
const first = await read('instrumented'), plain = await read('plain');
assert.equal(first.random.seed, 0);
assert.equal(first.runs[1].repeatCheck.initialEqual, true);
assert.equal(first.runs[1].repeatCheck.finalEqual, true);
assert.equal(first.runs[0].initialStateDigest, plain.runs[0].initialStateDigest);
assert.equal(first.runs[0].finalPhysicsDigest, plain.runs[0].finalPhysicsDigest);
assert.equal(first.runs[0].result.performance.timing.step.count, 20);
assert.equal(first.runs[0].result.sampleCoverage.sampleCount, 21);
assert.equal(first.runs[0].result.sampleCoverage.complete, true);
run('comparison', ['--compare', 'benchmarks/results/verification/instrumented.json']);
const comparison = await read('comparison');
assert.equal(comparison.comparison[0].comparable, true);
assert.equal(comparison.runs[0].finalPhysicsDigest, first.runs[0].finalPhysicsDigest);
run('incompatible', ['--no-instrumentation', '--compare', 'benchmarks/results/verification/instrumented.json']);
assert.equal((await read('incompatible')).comparison[0].comparable, false);
console.log('PASS: 試験seed=0の反復、火災・煙を含む計測変換前後の物理digest、0.1秒sample、比較条件の一致/不一致');
