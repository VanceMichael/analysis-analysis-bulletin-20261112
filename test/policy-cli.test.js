import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePolicy, subscriptionCovers } from '../src/policy.js';

const validPolicy = {
  materiality: 0.02,
  subscriptions: [
    { id: 'ops-eu', zone: 'Europe/Berlin', localTime: '09:00', countries: ['DE', 'FR'] },
    { id: 'ops-de', zone: 'Europe/Berlin', localTime: '10:00', countries: ['DE'], metrics: ['refund'], overlap: 'later' },
  ],
  artifacts: [{ id: 'demo', explanation: '解释片段' }],
};

test('合法策略通过校验，可选 metrics 与 overlap 被接受', () => {
  assert.deepEqual(validatePolicy(structuredClone(validPolicy)), validPolicy);
});

test('策略的各类非法配置被拒绝', () => {
  assert.throws(() => validatePolicy({ ...validPolicy, materiality: -1 }), /materiality/);
  assert.throws(() => validatePolicy({ ...validPolicy, subscriptions: [] }), /收件组/);
  const duplicated = structuredClone(validPolicy);
  duplicated.subscriptions[1].id = 'ops-eu';
  assert.throws(() => validatePolicy(duplicated), /重复/);
  const badZone = structuredClone(validPolicy);
  badZone.subscriptions[0].zone = 'Mars/Olympus';
  assert.throws(() => validatePolicy(badZone), /时区/);
  const badOverlap = structuredClone(validPolicy);
  badOverlap.subscriptions[0].overlap = 'middle';
  assert.throws(() => validatePolicy(badOverlap), /overlap/);
  const badCountries = structuredClone(validPolicy);
  badCountries.subscriptions[0].countries = ['DE', 'DE'];
  assert.throws(() => validatePolicy(badCountries), /countries/);
  const badArtifact = structuredClone(validPolicy);
  badArtifact.artifacts = [{ id: 'demo' }];
  assert.throws(() => validatePolicy(badArtifact), /explanation/);
});

test('subscriptionCovers 同时应用国家与指标过滤', () => {
  const [eu, de] = validPolicy.subscriptions;
  assert.equal(subscriptionCovers(eu, { country: 'FR', metric: 'refund' }), true);
  assert.equal(subscriptionCovers(de, { country: 'DE', metric: 'refund' }), true);
  assert.equal(subscriptionCovers(de, { country: 'DE', metric: 'conversion' }), false);
  assert.equal(subscriptionCovers(de, { country: 'FR', metric: 'refund' }), false);
});

test('publish/reconcile/trace CLI 端到端可复核', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-publish-'));
  try {
    const policyPath = join(folder, 'policy.json');
    const inputPath = join(folder, 'records.json');
    const stateDir = join(folder, 'state');
    await writeFile(policyPath, JSON.stringify(validPolicy));
    const records = [
      { id: 'a', metric: 'refund', country: 'DE', period: '2026-W46', value: 0.11, cutoff: 10, definition: 'm1', status: 'estimated' },
      { id: 'b', metric: 'refund', country: 'FR', period: '2026-W46', value: 0.13, cutoff: 10, definition: 'm1', status: 'estimated' },
    ];
    await writeFile(inputPath, JSON.stringify({ version: 1, records }));

    const publish = spawnSync(process.execPath, [
      'src/cli.js', 'publish', '--input', inputPath, '--policy', policyPath,
      '--state', stateDir, '--topic', 'weekly',
    ], { encoding: 'utf8' });
    assert.equal(publish.status, 0, publish.stderr);
    const published = JSON.parse(publish.stdout);
    assert.equal(published.versionId, 'weekly#v1');
    assert.equal(published.deliveries.length, 2);

    const reconcile = spawnSync(process.execPath, [
      'src/cli.js', 'reconcile', '--policy', policyPath, '--state', stateDir,
    ], { encoding: 'utf8' });
    assert.equal(reconcile.status, 0, reconcile.stderr);
    const report = JSON.parse(reconcile.stdout);
    assert.ok(Array.isArray(report.repairs));

    const trace = spawnSync(process.execPath, [
      'src/cli.js', 'trace', '--policy', policyPath, '--state', stateDir,
    ], { encoding: 'utf8' });
    assert.equal(trace.status, 0, trace.stderr);
    const traced = JSON.parse(trace.stdout);
    assert.equal(traced.bulletins.weekly[0].versionId, 'weekly#v1');
    assert.equal(traced.deliveries.length, 2);
    assert.ok(traced.events.some(event => event.type === 'version-frozen'));
    assert.ok((await readdir(join(stateDir, 'outbox'))).length >= 1);

    // 未知命令、悬空选项与不支持的参数均保持非零退出码。
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'publish', '--state']).status, 1);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'trace', '--input', inputPath]).status, 1);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'rewrite-history']).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('混用口径版本的批次在 CLI publish 处被拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-mixed-'));
  try {
    const policyPath = join(folder, 'policy.json');
    const inputPath = join(folder, 'records.json');
    const stateDir = join(folder, 'state');
    await writeFile(policyPath, JSON.stringify(validPolicy));
    const records = [
      { id: 'a', metric: 'refund', country: 'DE', period: '2026-W46', value: 0.11, cutoff: 10, definition: 'm1', status: 'estimated' },
      { id: 'b', metric: 'refund', country: 'FR', period: '2026-W46', value: 0.13, cutoff: 10, definition: 'm2', status: 'estimated' },
    ];
    await writeFile(inputPath, JSON.stringify({ version: 1, records }));
    const run = spawnSync(process.execPath, [
      'src/cli.js', 'publish', '--input', inputPath, '--policy', policyPath,
      '--state', stateDir, '--topic', 'weekly',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /口径版本/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
