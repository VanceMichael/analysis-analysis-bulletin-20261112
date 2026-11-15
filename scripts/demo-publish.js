// 可追溯发布演示：全部在临时目录内完成，注入时钟快速演练，不接真实邮箱、不等真实日历。
// 场景顺序：
//   1. 初版冻结并按订阅本地时刻投递；
//   2. 故障窗口——文件已投递、回执写盘前退出，重启 reconcile 不重复发；
//   3. 退款补报形成候选修订：超阈值的实质更正分发，阈值内小修只留档；
//   4. 夏令时 gap/overlap 的确定策略；
//   5. trace 证明谁拿到了哪版、为什么收到更正。
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../src/clock.js';
import { Store, idempotencyKey } from '../src/store.js';
import { FileDeliverer, CrashBeforeReceipt } from '../src/deliverer.js';
import { Publisher } from '../src/publisher.js';
import { resolveLocal, wallClockParts } from '../src/schedule.js';

const TOPIC = 'ops-weekly-2026-W46';
const ARTIFACTS = [{ id: 'weekly-brief', explanation: '运营周会简报：本周转化与退款指标点，口径 m1。' }];
const POLICY = {
  materiality: 0.02,
  subscriptions: [
    { id: 'ops-eu', zone: 'Europe/Berlin', localTime: '09:00', countries: ['DE', 'FR'] },
    // ops-de 安排在最晚时刻，崩溃时同批其他订阅已完成回执，贴合“单进程在最后一封退出”。
    { id: 'ops-de', zone: 'Europe/Berlin', localTime: '11:00', countries: ['DE'], metrics: ['refund'] },
    { id: 'ops-asia', zone: 'Asia/Shanghai', localTime: '09:00', countries: ['DE'] },
  ],
  artifacts: ARTIFACTS,
};

function point(id, patch) {
  return {
    id, metric: 'conversion', country: 'DE', period: '2026-W46',
    value: 0.1, cutoff: 10, definition: 'm1', status: 'estimated', ...patch,
  };
}

function v1Records() {
  return [
    point('r1', { metric: 'conversion', country: 'DE', value: 0.1 }),
    point('r2', { metric: 'refund', country: 'DE', value: 0.11 }),
    point('r3', { metric: 'conversion', country: 'FR', value: 0.12 }),
    point('r4', { metric: 'refund', country: 'FR', value: 0.13 }),
  ];
}

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

async function countMail(store, subscriptionId) {
  try {
    return (await readdir(join(store.mailDir, subscriptionId))).filter(name => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function buildPublisher(stateDir, clock, fault) {
  const store = await new Store(stateDir).init();
  const deliverer = new FileDeliverer(store.mailDir, fault ?? {});
  return { store, publisher: new Publisher({ store, deliverer, clock, policy: POLICY }) };
}

const root = await mkdtemp(join(tmpdir(), 'bulletin-demo-'));
const stateDir = join(root, 'state');
heading(`演示工作目录：${root}`);

// ---- 场景 1：初版冻结 + 按订阅时区调度 ----
heading('场景 1：初版签发，三个订阅按各自本地时刻排队（尚未投递）');
{
  const clock = new FixedClock(['2026-11-13T06:00:00.000Z']);
  const { store, publisher } = await buildPublisher(stateDir, clock);
  const result = await publisher.publishBulletin({
    topic: TOPIC, records: v1Records(), artifacts: ARTIFACTS,
    fromInstant: new Date('2026-11-13T06:00:00.000Z'),
  });
  console.log(`冻结版本 ${result.versionId}，materialHash=${result.materialHash.slice(0, 12)}…`);
  for (const delivery of result.deliveries) {
    console.log(`  ${delivery.subscriptionId.padEnd(9)} 计划 ${delivery.scheduledAt}（${delivery.timezone.zone} ${delivery.timezone.localTime}，${delivery.timezone.resolution}）`);
  }
  const ledger = await store.readLedger();
  console.log('入队后 ledger 状态：', Object.values(ledger.deliveries)
    .map(delivery => `${delivery.subscriptionId}:${delivery.status}`).join(', '));
}

// ---- 场景 2：回执写盘前崩溃，重启 reconcile 收敛 ----
heading('场景 2：故障窗口——投递成功、回执写盘前退出，重启后不重复发');
const crashKey = idempotencyKey(`${TOPIC}#v1`, 'ops-de');
{
  // 第一台进程：ops-eu、ops-asia 正常回执；轮到 ops-de 时文件落地后崩溃。
  const clock = new FixedClock([
    '2026-11-13T06:30:00.000Z',
    '2026-11-13T08:00:00.000Z',
    '2026-11-14T01:00:00.000Z',
    '2026-11-13T09:00:00.000Z',
  ]);
  const { store, publisher } = await buildPublisher(stateDir, clock, {
    crashHook: message => message.idempotencyKey === crashKey ? 'throw' : null,
  });
  try {
    await publisher.pumpDue(new Date('2026-11-14T12:00:00.000Z'));
    throw new Error('应当看到崩溃信号');
  } catch (error) {
    if (!(error instanceof CrashBeforeReceipt)) throw error;
    const ledger = await store.readLedger();
    console.log(`进程在回执写盘前退出（${error.name}）：ops-de 邮件文件已存在，ledger 仍记录 ${ledger.deliveries[crashKey].status}`);
    console.log('同批其他订阅已正常回执：',
      ['ops-eu', 'ops-asia'].map(id => `${id}=${ledger.deliveries[idempotencyKey(`${TOPIC}#v1`, id)].status}`).join(', '));
  }
}
{
  // 模拟重启：全新实例，只读取磁盘状态。
  const clock = new FixedClock(['2026-11-14T13:00:00.000Z', '2026-11-14T13:00:01.000Z']);
  const { store, publisher } = await buildPublisher(stateDir, clock);
  const before = await countMail(store, 'ops-de');
  const report = await publisher.reconcile();
  const after = await countMail(store, 'ops-de');
  console.log('reconcile 修复动作：', report.repairs.map(item => `${item.idempotencyKey.slice(0, 8)}…:${item.action}`).join(', '));
  console.log(`ops-de 邮件文件数 ${before} -> ${after}（幂等重投覆盖同一路径，无重复邮件）`);
  const ledger = await store.readLedger();
  console.log(`恢复后状态：${ledger.deliveries[crashKey].status}，尝试次数=${ledger.deliveries[crashKey].attempts}`);
  console.log('全部 v1 投递收敛：', Object.values(ledger.deliveries)
    .filter(delivery => delivery.versionId === `${TOPIC}#v1`)
    .map(delivery => `${delivery.subscriptionId}:${delivery.status}`).join(', '));
}

// ---- 场景 3a：退款补报，超阈值 -> 实质更正 ----
heading('场景 3a：退款补报，FR refund 变动 0.10 > 阈值 0.02，分发实质更正');
{
  const clock = new FixedClock(['2026-11-15T06:00:00.000Z', '2026-11-15T06:00:01.000Z']);
  const { store, publisher } = await buildPublisher(stateDir, clock);
  const corrected = v1Records().map(row =>
    row.id === 'r4' ? { ...row, value: row.value + 0.1, cutoff: 11 } : row);
  const result = await publisher.publishBulletin({
    topic: TOPIC, records: corrected, artifacts: ARTIFACTS,
    fromInstant: new Date('2026-11-15T06:00:00.000Z'),
  });
  console.log(`新版本 ${result.versionId}，kind=${result.kind}，原因=${result.decision.reasons.join('+')}`);
  for (const changed of result.decision.changed.filter(item => item.triggers.length)) {
    console.log(`  变更点 ${changed.key}: ${changed.from.value} -> ${changed.to.value}（Δ=${changed.delta}），触发 ${changed.triggers.join('+')}`);
  }
  console.log('收到更正的订阅：', result.deliveries.map(delivery =>
    `${delivery.subscriptionId}（原因 ${delivery.reason}）`).join(', ') || '无');
  console.log('未收到：ops-de 只订阅 DE/refund，变更点在 FR；ops-asia 只订阅 DE，均被过滤');
  await publisher.pumpDue(new Date('2026-11-16T12:00:00.000Z'));
}

// ---- 场景 3b：阈值内小修 -> 留档不分发 ----
heading('场景 3b：DE conversion 仅变动 0.001 ≤ 阈值，minor-revision 只留档');
{
  const clock = new FixedClock(['2026-11-16T06:00:00.000Z']);
  const { store, publisher } = await buildPublisher(stateDir, clock);
  const corrected = v1Records()
    .map(row => row.id === 'r4' ? { ...row, value: row.value + 0.1, cutoff: 11 } : row)
    .map(row => row.id === 'r1' ? { ...row, value: row.value + 0.001, cutoff: 11 } : row);
  const result = await publisher.publishBulletin({
    topic: TOPIC, records: corrected, artifacts: ARTIFACTS,
    fromInstant: new Date('2026-11-16T06:00:00.000Z'),
  });
  console.log(`新版本 ${result.versionId}，kind=${result.kind}，原因=${result.decision.reasons.join('+')}，投递数=${result.deliveries.length}`);
  const ledger = await store.readLedger();
  console.log('版本链：', ledger.bulletins[TOPIC].versions
    .map(version => `${version.versionId}(${version.kind})`).join(' -> '));
  const v1 = ledger.bulletins[TOPIC].versions[0];
  console.log(`旧签发未被覆盖：v1 中 refund|FR 仍为 ${v1.material.points.find(p => p.key === 'refund|FR|2026-W46').value}`);
}

// ---- 场景 4：夏令时歧义的确定策略 ----
heading('场景 4：跨时区夏令时歧义（注入日期即时演练）');
{
  const cases = [
    ['Europe/Berlin', new Date(Date.UTC(2026, 2, 29)), '02:30', '春季 gap'],
    ['Europe/Berlin', new Date(Date.UTC(2026, 9, 25)), '02:30', '秋季 overlap'],
    ['America/New_York', new Date(Date.UTC(2026, 2, 8)), '02:30', '春季 gap'],
    ['Asia/Shanghai', new Date(Date.UTC(2026, 2, 29)), '02:30', '无 DST'],
  ];
  for (const [zone, day, localTime, label] of cases) {
    const resolved = resolveLocal(zone, day, localTime, 'earlier');
    const parts = wallClockParts(resolved.instant, zone);
    const rendered = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    console.log(`  ${label.padEnd(9)} ${zone.padEnd(16)} ${localTime} -> ${resolved.instant.toISOString()} 渲染=${rendered} 策略=${resolved.policy ?? 'normal'}`);
  }
}

// ---- 场景 5：trace 汇总“谁拿到了哪版” ----
heading('场景 5：trace 对账——谁拿到了哪版、为什么收到更正');
{
  const store = new Store(stateDir);
  const ledger = await store.readLedger();
  for (const version of ledger.bulletins[TOPIC].versions) {
    console.log(`版本 ${version.versionId} [${version.kind}] 截点=${version.material.dataCutoff} 口径=${version.material.definition} 哈希=${version.material.materialHash.slice(0, 12)}…`);
  }
  for (const delivery of Object.values(ledger.deliveries).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey))) {
    console.log(`  ${delivery.subscriptionId.padEnd(9)} ${delivery.versionId.padEnd(20)} ${delivery.status.padEnd(7)} 原因=${delivery.reason} 尝试=${delivery.attempts}`);
  }
  const mailCounts = Object.fromEntries(
    await Promise.all(POLICY.subscriptions.map(async subscription =>
      [subscription.id, await countMail(store, subscription.id)])));
  console.log('各订阅邮件文件数：', JSON.stringify(mailCounts), '（无任何订阅收到重复邮件）');
}

await rm(root, { recursive: true, force: true });
console.log(`\n演示完成，临时目录已清理：${root}`);
