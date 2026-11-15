import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../src/clock.js';
import { Store, StoreLock, idempotencyKey } from '../src/store.js';
import { FileDeliverer, CrashBeforeReceipt } from '../src/deliverer.js';
import { Publisher } from '../src/publisher.js';

const ARTIFACTS = [{ id: 'demo', explanation: '演练指标点，仅用于内部复盘。' }];
const POLICY = {
  materiality: 0.02,
  subscriptions: [
    { id: 'ops-eu', zone: 'Europe/Berlin', localTime: '09:00', countries: ['DE', 'FR'] },
    { id: 'ops-de', zone: 'Europe/Berlin', localTime: '10:00', countries: ['DE'], metrics: ['refund'] },
  ],
  artifacts: ARTIFACTS,
};

function record(id, patch = {}) {
  return {
    id, metric: 'conversion', country: 'DE', period: '2026-W46',
    value: 0.1, cutoff: 10, definition: 'm1', status: 'estimated', ...patch,
  };
}

function baseRecords() {
  return [
    record('r1', { metric: 'conversion', country: 'DE', value: 0.1 }),
    record('r2', { id: 'r2', metric: 'refund', country: 'DE', value: 0.11 }),
    record('r3', { id: 'r3', metric: 'conversion', country: 'FR', value: 0.12 }),
    record('r4', { id: 'r4', metric: 'refund', country: 'FR', value: 0.13 }),
  ];
}

async function setup(fault = null, policy = POLICY) {
  const stateDir = await mkdtemp(join(tmpdir(), 'publish-'));
  const store = await new Store(stateDir).init();
  const clock = new FixedClock(['2026-11-15T06:00:00.000Z']);
  const deliverer = new FileDeliverer(store.mailDir, fault ?? {});
  const publisher = new Publisher({ store, deliverer, clock, policy });
  return {
    stateDir, store, clock, deliverer, publisher,
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

test('初版按订阅冻结并入队，订阅过滤与本地时刻同时生效', async () => {
  const harness = await setup();
  try {
    const result = await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    assert.equal(result.kind, 'initial');
    assert.equal(result.deliveries.length, 2);
    const eu = result.deliveries.find(delivery => delivery.subscriptionId === 'ops-eu');
    const de = result.deliveries.find(delivery => delivery.subscriptionId === 'ops-de');
    assert.equal(eu.scheduledAt, '2026-11-15T08:00:00.000Z');
    assert.equal(de.scheduledAt, '2026-11-15T09:00:00.000Z');
    const ledger = await harness.store.readLedger();
    const version = ledger.bulletins['ops-weekly'].versions[0];
    assert.equal(version.material.points.length, 4);
    assert.match(version.material.materialHash, /^[0-9a-f]{64}$/);
    // 入队消息内嵌完整冻结快照，收件内容不依赖最新数据页。
    const messages = await harness.store.listMessages();
    assert.equal(messages.length, 2);
    assert.ok(messages.every(message => message.snapshot.points.length === 4));
    assert.ok(messages.every(message => message.snapshot.artifacts[0].explanation === ARTIFACTS[0].explanation));
  } finally { await harness.cleanup(); }
});

test('到期投递成功后状态收敛，未到期保持 pending', async () => {
  const harness = await setup();
  try {
    await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    const pump = await harness.publisher.pumpDue(new Date('2026-11-15T08:30:00.000Z'));
    assert.equal(pump.considered, 1);
    assert.equal(pump.results[0].outcome, 'sent');
    const ledger = await harness.store.readLedger();
    const [eu, de] = ['ops-eu', 'ops-de'].map(id =>
      ledger.deliveries[idempotencyKey('ops-weekly#v1', id)]);
    assert.equal(eu.status, 'sent');
    assert.equal(de.status, 'pending');
    const files = await readdir(join(harness.stateDir, 'mail', 'ops-eu'));
    assert.equal(files.length, 1);
  } finally { await harness.cleanup(); }
});

test('同一版本重复发布不产生重复入队，幂等键绑定版本与订阅', async () => {
  const harness = await setup();
  try {
    const first = await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    // 用完全相同的材料再发布一次：unchanged，直接返回已发版本。
    const again = await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    assert.equal(again.decision.kind, 'unchanged');
    assert.equal(again.versionId, first.versionId);
    assert.equal((await harness.store.listMessages()).length, 2);

    // 直接重放相同入队请求也不产生第二条消息。
    const [message] = await harness.store.listMessages();
    const replay = await harness.store.enqueue(message);
    assert.equal(replay.created, false);
  } finally { await harness.cleanup(); }
});

test('投递成功但回执写盘前退出，重启 reconcile 不重复发', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'publish-crash-'));
  const crashKey = idempotencyKey('ops-weekly#v1', 'ops-eu');
  try {
    {
      const store = await new Store(stateDir).init();
      const clock = new FixedClock(['2026-11-15T06:00:00.000Z', '2026-11-15T08:00:00.000Z']);
      const deliverer = new FileDeliverer(store.mailDir, {
        crashHook: message => message.idempotencyKey === crashKey ? 'throw' : null,
      });
      const publisher = new Publisher({ store, deliverer, clock, policy: POLICY });
      await publisher.publishBulletin({
        topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
        fromInstant: new Date('2026-11-15T06:00:00.000Z'),
      });
      await assert.rejects(
        publisher.pumpDue(new Date('2026-11-15T08:30:00.000Z')),
        CrashBeforeReceipt,
      );
      // 崩溃信号穿透后：消息仍为 pending、ledger 无成功回执，但邮件文件已落地。
      const stuck = await store.readLedger();
      assert.equal(stuck.deliveries[crashKey].status, 'pending');
      assert.equal(stuck.deliveries[crashKey].attempts, 0);
    }
    const mailBefore = await readdir(join(stateDir, 'mail', 'ops-eu'));
    assert.equal(mailBefore.length, 1);

    // 模拟重启：全新实例读取持久状态执行 reconcile。
    const store = await new Store(stateDir).init();
    const clock = new FixedClock(['2026-11-15T09:00:00.000Z', '2026-11-15T09:00:01.000Z']);
    const deliverer = new FileDeliverer(store.mailDir, {});
    const publisher = new Publisher({ store, deliverer, clock, policy: POLICY });
    const report = await publisher.reconcile();
    const resume = report.repairs.find(item => item.action === 'resume-after-crash');
    assert.ok(resume, '应识别出回执写盘前退出的在途消息');
    const mailAfter = await readdir(join(stateDir, 'mail', 'ops-eu'));
    assert.deepEqual(mailAfter, mailBefore);
    const ledger = await store.readLedger();
    const delivery = ledger.deliveries[crashKey];
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.attempts, 1);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('outbox 丢失而 ledger 仍登记时，reconcile 依据冻结版本重建', async () => {
  const harness = await setup();
  try {
    await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    const [message] = await harness.store.listMessages();
    await rm(harness.store.messagePath(message.idempotencyKey));
    const report = await harness.publisher.reconcile();
    assert.ok(report.repairs.some(item => item.action === 'outbox-rebuilt'));
    const restored = await harness.store.listMessages();
    assert.equal(restored.length, 2);
    assert.ok(restored.some(item => item.idempotencyKey === message.idempotencyKey));
  } finally { await harness.cleanup(); }
});

test('某订阅持续失败时隔离，不影响其他订阅；恢复后 reconcile 补发', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'publish-isolation-'));
  try {
    {
      const store = await new Store(stateDir).init();
      const clock = new FixedClock(['2026-11-15T06:00:00.000Z', '2026-11-15T08:00:00.000Z', '2026-11-15T09:00:00.000Z']);
      const deliverer = new FileDeliverer(store.mailDir, {
        failureHook: message => message.subscriptionId === 'ops-de',
      });
      const publisher = new Publisher({ store, deliverer, clock, policy: POLICY });
      await publisher.publishBulletin({
        topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
        fromInstant: new Date('2026-11-15T06:00:00.000Z'),
      });
      const pump = await publisher.pumpDue(new Date('2026-11-15T09:30:00.000Z'));
      const bySubscription = Object.fromEntries(pump.results.map(item => [item.subscriptionId, item]));
      assert.equal(bySubscription['ops-eu'].outcome, 'sent');
      assert.equal(bySubscription['ops-de'].outcome, 'failed');
      assert.ok(await readdir(join(stateDir, 'mail', 'ops-eu')));
      await assert.rejects(readdir(join(stateDir, 'mail', 'ops-de')));
    }
    // 故障解除后重启对账，失败订阅补发且成功订阅不重发。
    const store = await new Store(stateDir).init();
    const clock = new FixedClock(['2026-11-15T10:00:00.000Z', '2026-11-15T10:00:01.000Z', '2026-11-15T10:00:02.000Z']);
    const publisher = new Publisher({ store, deliverer: new FileDeliverer(store.mailDir, {}), clock, policy: POLICY });
    const report = await publisher.reconcile();
    assert.equal(report.pump.results.filter(item => item.outcome === 'sent').length, 1);
    const ledger = await store.readLedger();
    assert.equal(ledger.deliveries[idempotencyKey('ops-weekly#v1', 'ops-eu')].attempts, 1);
    assert.equal(ledger.deliveries[idempotencyKey('ops-weekly#v1', 'ops-de')].status, 'sent');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('实质更正只分发给覆盖变更点的订阅，并携带原因与差异键', async () => {
  const harness = await setup();
  try {
    await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    await harness.publisher.pumpDue(new Date('2026-11-15T12:00:00.000Z'));
    // FR refund 大幅修正：ops-de 只订阅 DE/refund，不应收到更正。
    const revised = baseRecords().map(row =>
      row.id === 'r4' ? { ...row, value: row.value + 0.1 } : row);
    const correction = await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: revised, artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T12:30:00.000Z'),
    });
    assert.equal(correction.kind, 'correction');
    assert.deepEqual(correction.deliveries.map(delivery => delivery.subscriptionId), ['ops-eu']);
    assert.equal(correction.deliveries[0].reason, 'value-material');
    assert.deepEqual(correction.deliveries[0].changedKeys, ['refund|FR|2026-W46']);
    const ledger = await harness.store.readLedger();
    const v2 = ledger.bulletins['ops-weekly'].versions[1];
    assert.equal(v2.parentVersionId, 'ops-weekly#v1');
    // 旧版本材料仍可完整读取，未被覆盖。
    const v1 = ledger.bulletins['ops-weekly'].versions[0];
    assert.equal(v1.material.points.find(point => point.key === 'refund|FR|2026-W46').value, 0.13);
  } finally { await harness.cleanup(); }
});

test('阈值内小修只留档，不产生新投递且保留全部历史版本', async () => {
  const harness = await setup();
  try {
    await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: baseRecords(), artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-15T06:00:00.000Z'),
    });
    const messagesAfterFirst = (await harness.store.listMessages()).length;
    const revised = baseRecords().map(row =>
      row.id === 'r1' ? { ...row, value: row.value + 0.001 } : row);
    const minor = await harness.publisher.publishBulletin({
      topic: 'ops-weekly', records: revised, artifacts: ARTIFACTS,
      fromInstant: new Date('2026-11-16T06:00:00.000Z'),
    });
    assert.equal(minor.kind, 'minor-revision');
    assert.equal(minor.deliveries.length, 0);
    assert.equal((await harness.store.listMessages()).length, messagesAfterFirst);
    const ledger = await harness.store.readLedger();
    assert.deepEqual(ledger.bulletins['ops-weekly'].versions.map(version => version.kind),
      ['initial', 'minor-revision']);
    assert.ok(ledger.events.some(event => event.type === 'minor-revision-archived'));
  } finally { await harness.cleanup(); }
});

test('锁保证同一状态目录串行修改', async () => {
  const harness = await setup();
  try {
    const lock = await StoreLock.acquire(harness.stateDir);
    await assert.rejects(StoreLock.acquire(harness.stateDir), /占用/);
    await lock.release();
    const again = await StoreLock.acquire(harness.stateDir);
    await again.release();
  } finally { await harness.cleanup(); }
});

test('状态文件版本不被静默接受', async () => {
  const harness = await setup();
  try {
    await writeFile(harness.store.ledgerPath, JSON.stringify({ version: 99, bulletins: {} }));
    await assert.rejects(harness.store.readLedger(), /版本/);
  } finally { await harness.cleanup(); }
});
