import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('指标点核对显示全部口径指纹，不只取最后一个', () => {

  assert.deepEqual(probe([{definition: 'z'}, {definition: 'a'}, {definition: 'a'}]).definitions, ['a','z']);
  assert.deepEqual(probe([{definition: 'm1'}]).definitions, ['m1']);
});
