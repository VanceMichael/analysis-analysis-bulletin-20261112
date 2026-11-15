import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freezeMaterial, classifyRevision, pointKey } from '../src/issuance.js';
import { FixedClock } from '../src/clock.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records;
const artifacts = [{ id: 'demo', explanation: '演练指标点，仅用于内部复盘。' }];
const clock = new FixedClock(['2026-11-15T06:00:00.000Z']);

function take(n) {
  return seed.slice(0, n).map((record, index) => ({ ...record, id: `t${index}`, period: '2026-W46' }));
}

test('冻结材料包含数据截点、口径指纹、产物哈希与中文解释，且整体可哈希', () => {
  const material = freezeMaterial({ topic: 'ops-weekly', records: take(4), artifacts, clock });
  assert.equal(material.definition, 'm1');
  assert.equal(material.dataCutoff, 10);
  assert.equal(material.artifacts[0].explanation, artifacts[0].explanation);
  assert.match(material.artifacts[0].hash, /^[0-9a-f]{64}$/);
  assert.match(material.materialHash, /^[0-9a-f]{64}$/);
  assert.equal(material.issuedAt, '2026-11-15T06:00:00.000Z');
  // 指标点是快照副本，后续修改输入不影响冻结结果。
  const points = material.points.map(point => point.key);
  assert.deepEqual(points, [...points].sort());
});

test('同一发布批次混用口径版本直接拒绝', () => {
  const records = take(2);
  records[1] = { ...records[1], definition: 'm2' };
  assert.throws(() => freezeMaterial({ topic: 'ops-weekly', records, artifacts, clock }), /口径版本/);
});

test('数值变化超过阈值判定为实质更正并记录逐点差异', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(4), artifacts, clock: new FixedClock(['2026-11-15T06:00:00.000Z']) });
  const revised = take(4).map(record => record.metric === 'refund' && record.country === 'DE'
    ? { ...record, value: record.value + 0.05 } : record);
  const second = freezeMaterial({ topic: 'ops-weekly', records: revised, artifacts, clock: new FixedClock(['2026-11-16T06:00:00.000Z']) });
  const decision = classifyRevision(first, second, 0.02);
  assert.equal(decision.correction, true);
  assert.equal(decision.kind, 'correction');
  assert.deepEqual(decision.reasons, ['value-material']);
  const hit = decision.changed.find(item => item.triggers.includes('value-material'));
  assert.equal(hit.country, 'DE');
  assert.ok(Math.abs(hit.delta - 0.05) < 1e-12);
});

test('阈值内小修归类 minor-revision，留档但不触发分发', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(4), artifacts, clock });
  const revised = take(4).map(record => record.metric === 'conversion' && record.country === 'FR'
    ? { ...record, value: record.value + 0.001 } : record);
  const second = freezeMaterial({ topic: 'ops-weekly', records: revised, artifacts, clock: new FixedClock(['2026-11-17T06:00:00.000Z']) });
  const decision = classifyRevision(first, second, 0.02);
  assert.equal(decision.kind, 'minor-revision');
  assert.equal(decision.correction, false);
  assert.deepEqual(decision.reasons, ['within-materiality']);
});

test('从 estimated 变为 unavailable 即使数值不变也触发更正', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(2), artifacts, clock });
  const revised = take(2).map((record, index) => index === 0 ? { ...record, status: 'unavailable' } : record);
  const second = freezeMaterial({ topic: 'ops-weekly', records: revised, artifacts, clock: new FixedClock(['2026-11-18T06:00:00.000Z']) });
  const decision = classifyRevision(first, second, 0.02);
  assert.equal(decision.correction, true);
  assert.deepEqual(decision.reasons, ['became-unavailable']);
});

test('指标点增删属于 membership 更正；完全相同的材料判定 unchanged', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(4), artifacts, clock });
  const second = freezeMaterial({ topic: 'ops-weekly', records: take(3), artifacts, clock: new FixedClock(['2026-11-19T06:00:00.000Z']) });
  const decision = classifyRevision(first, second, 0.02);
  assert.equal(decision.kind, 'correction');
  assert.deepEqual(decision.reasons, ['membership']);
  const again = freezeMaterial({ topic: 'ops-weekly', records: take(4), artifacts, clock: new FixedClock(['2026-11-20T06:00:00.000Z']) });
  assert.equal(classifyRevision(first, again, 0.02).kind, 'unchanged');
});

test('口径版本跨版本漂移不能作为同系列修订', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(2), artifacts, clock });
  const migrated = take(2).map(record => ({ ...record, definition: 'm2' }));
  const second = freezeMaterial({ topic: 'ops-weekly', records: migrated, artifacts, clock: new FixedClock(['2026-11-21T06:00:00.000Z']) });
  assert.throws(() => classifyRevision(first, second, 0.02), /口径版本/);
});

test('解释片段变化形成 explanation-only 小修，不改指标结论', () => {
  const first = freezeMaterial({ topic: 'ops-weekly', records: take(2), artifacts, clock });
  const second = freezeMaterial({
    topic: 'ops-weekly', records: take(2),
    artifacts: [{ ...artifacts[0], explanation: '修订后的中文解释片段。' }],
    clock: new FixedClock(['2026-11-22T06:00:00.000Z']),
  });
  const decision = classifyRevision(first, second, 0.02);
  assert.equal(decision.kind, 'minor-revision');
  assert.equal(decision.explanationChanged, true);
  assert.deepEqual(decision.reasons, ['explanation-only']);
  assert.equal(pointKey(seed[0]), `${seed[0].metric}|${seed[0].country}|${seed[0].period}`);
});
