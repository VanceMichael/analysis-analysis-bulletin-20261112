import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocal, nextRunAt, zoneOffsetAt, wallClockParts } from '../src/schedule.js';

const HOUR = 3600000;

test('普通本地时刻按当前 UTC 偏移解析', () => {
  const day = new Date(Date.UTC(2026, 10, 15));
  const berlin = resolveLocal('Europe/Berlin', day, '09:00');
  assert.equal(berlin.kind, 'normal');
  assert.equal(berlin.instant.toISOString(), '2026-11-15T08:00:00.000Z');
  assert.equal(berlin.offsetMs, HOUR);
  const shanghai = resolveLocal('Asia/Shanghai', day, '09:00');
  assert.equal(shanghai.kind, 'normal');
  assert.equal(shanghai.instant.toISOString(), '2026-11-15T01:00:00.000Z');
});

test('春季 gap 采用 shift-forward，落到跳变后最早有效墙钟', () => {
  // 柏林 2026-03-29 02:30 本地时间不存在，02:00 直接跳到 03:00。
  const day = new Date(Date.UTC(2026, 2, 29));
  const result = resolveLocal('Europe/Berlin', day, '02:30');
  assert.equal(result.kind, 'gap');
  assert.equal(result.policy, 'shift-forward');
  const parts = wallClockParts(result.instant, 'Europe/Berlin');
  assert.deepEqual([parts.hour, parts.minute], [3, 30]);
  assert.equal(result.instant.toISOString(), '2026-03-29T01:30:00.000Z');

  const nyDay = new Date(Date.UTC(2026, 2, 8));
  const ny = resolveLocal('America/New_York', nyDay, '02:30');
  assert.equal(ny.kind, 'gap');
  const nyParts = wallClockParts(ny.instant, 'America/New_York');
  assert.deepEqual([nyParts.hour, nyParts.minute], [3, 30]);
  assert.equal(ny.instant.toISOString(), '2026-03-08T07:30:00.000Z');
});

test('秋季 overlap 默认取较早的一次出现（夏令时）', () => {
  // 柏林 2026-10-25 02:30 出现两次：00:30Z(CEST,+2) 与 01:30Z(CET,+1)。
  const day = new Date(Date.UTC(2026, 9, 25));
  const earlier = resolveLocal('Europe/Berlin', day, '02:30', 'earlier');
  assert.equal(earlier.kind, 'ambiguous');
  assert.equal(earlier.policy, 'earlier');
  assert.equal(earlier.instant.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(earlier.offsetMs, 2 * HOUR);
  assert.deepEqual(earlier.alternatives, [
    '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z',
  ]);

  const later = resolveLocal('Europe/Berlin', day, '02:30', 'later');
  assert.equal(later.kind, 'ambiguous');
  assert.equal(later.instant.toISOString(), '2026-10-25T01:30:00.000Z');
  assert.equal(later.offsetMs, HOUR);
});

test('纽约回退重叠时刻同样可确定解析', () => {
  // 纽约 2026-11-01 01:30 出现两次：05:30Z(EDT,-4) 与 06:30Z(EST,-5)。
  const day = new Date(Date.UTC(2026, 10, 1));
  const earlier = resolveLocal('America/New_York', day, '01:30', 'earlier');
  assert.equal(earlier.kind, 'ambiguous');
  assert.equal(earlier.instant.toISOString(), '2026-11-01T05:30:00.000Z');
  const later = resolveLocal('America/New_York', day, '01:30', 'later');
  assert.equal(later.instant.toISOString(), '2026-11-01T06:30:00.000Z');
});

test('无夏令时的时区永远是 normal 且偏移稳定', () => {
  const day = new Date(Date.UTC(2026, 2, 29));
  const result = resolveLocal('Asia/Shanghai', day, '02:30');
  assert.equal(result.kind, 'normal');
  assert.equal(result.offsetMs, 8 * HOUR);
  assert.equal(zoneOffsetAt(result.instant, 'Asia/Shanghai'), 8 * HOUR);
});

test('nextRunAt 从给定瞬间向后推进，不返回过去时刻', () => {
  // 2026-11-15T08:30Z 已过柏林当天 09:00（08:00Z），应排到次日。
  const next = nextRunAt('Europe/Berlin', '09:00', new Date(Date.UTC(2026, 10, 15, 8, 30)));
  assert.equal(next.instant.toISOString(), '2026-11-16T08:00:00.000Z');
  const sameDay = nextRunAt('Europe/Berlin', '09:00', new Date(Date.UTC(2026, 10, 15, 7, 0)));
  assert.equal(sameDay.instant.toISOString(), '2026-11-15T08:00:00.000Z');
});

test('非法本地时刻与未知策略被拒绝', () => {
  const day = new Date(Date.UTC(2026, 10, 15));
  assert.throws(() => resolveLocal('Europe/Berlin', day, '24:00'), /HH:MM|范围/);
  assert.throws(() => resolveLocal('Europe/Berlin', day, '9点'), /HH:MM/);
  assert.throws(() => resolveLocal('Europe/Berlin', day, '09:00', 'middle'), /earlier/);
});
