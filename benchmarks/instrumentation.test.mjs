import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { instrumentSource } from './instrumentation.mjs';

for (const [name, file] of [['core', 'core.js'], ['pedestrian', 'pedestrian-dynamics.js']]) {
  test(`計測変換が現在の ${name} を構文を保って処理し、位置変更時は停止する`, () => {
    const source = readFileSync(new URL(`../sim/js/simulation/${file}`, import.meta.url), 'utf8');
    const transformed = instrumentSource(source, name);
    const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: transformed, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.throws(() => instrumentSource('', name));
    assert.notEqual(transformed, source);
  });
}
