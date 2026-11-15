import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { SystemClock } from './clock.js';
import { createPublisherContext, StoreLock } from './runtime.js';
import { loadPolicy } from './policy.js';

const KNOWN_COMMANDS = ['summary', 'inspect', 'publish', 'reconcile', 'trace'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!KNOWN_COMMANDS.includes(command)) throw new Error('命令应为 summary、inspect、publish、reconcile 或 trace');
  const result = {
    command,
    input: 'data/records.json',
    policy: 'data/policy.json',
    state: 'var/publish',
    from: null,
  };
  const allowed = command === 'reconcile' || command === 'trace'
    ? ['--policy', '--state']
    : ['--input', '--out', '--policy', '--state', '--topic', '--from'];
  const seen = new Set();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数 ${name ?? ''} 不被 ${command} 接受，应为 ${allowed.join(' ')} 加值`);
    }
    if (seen.has(name)) throw new Error('参数不可重复');
    seen.add(name);
    result[name.slice(2)] = value;
  }
  return result;
}

async function runPublish(options) {
  const clock = new SystemClock();
  const lock = await StoreLock.acquire(resolve(options.state));
  try {
    const { publisher } = await createPublisherContext({
      stateDir: resolve(options.state),
      policyPath: resolve(options.policy),
      clock,
    });
    const dataset = await loadDataset(options.input);
    const policy = await loadPolicy(resolve(options.policy));
    const result = await publisher.publishBulletin({
      topic: options.topic ?? dataset.records[0]?.period ?? 'bulletin',
      records: dataset.records,
      artifacts: policy.artifacts,
      fromInstant: options.from ? new Date(options.from) : undefined,
    });
    return result;
  } finally {
    await lock.release();
  }
}

async function runReconcile(options) {
  const clock = new SystemClock();
  const lock = await StoreLock.acquire(resolve(options.state));
  try {
    const { publisher } = await createPublisherContext({
      stateDir: resolve(options.state),
      policyPath: resolve(options.policy),
      clock,
    });
    return publisher.reconcile();
  } finally {
    await lock.release();
  }
}

async function runTrace(options) {
  const { Store } = await import('./store.js');
  const store = new Store(resolve(options.state));
  const ledger = await store.readLedger();
  const trace = {
    stateDir: resolve(options.state),
    bulletins: Object.fromEntries(Object.values(ledger.bulletins).map(bulletin => [
      bulletin.topic,
      bulletin.versions.map(version => ({
        versionId: version.versionId,
        sequence: version.sequence,
        kind: version.kind,
        parentVersionId: version.parentVersionId,
        frozenAt: version.frozenAt,
        dataCutoff: version.material.dataCutoff,
        definition: version.material.definition,
        inputFingerprint: version.material.inputFingerprint,
        artifactHash: version.material.artifactHash,
        materialHash: version.material.materialHash,
        reasons: version.decision.reasons,
        pointCount: version.material.points.length,
      })),
    ])),
    deliveries: Object.values(ledger.deliveries)
      .sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey))
      .map(delivery => ({
        subscriptionId: delivery.subscriptionId,
        versionId: delivery.versionId,
        kind: delivery.kind,
        status: delivery.status,
        scheduledAt: delivery.scheduledAt,
        sentAt: delivery.sentAt,
        reason: delivery.reason,
        changedKeys: delivery.changedKeys,
        idempotencyKey: delivery.idempotencyKey,
        timezone: delivery.timezone,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
      })),
    events: ledger.events,
  };
  return trace;
}

export async function main(args) {
  const options = parseArguments(args);
  if (options.command === 'publish') return runPublish(options);
  if (options.command === 'reconcile') return runReconcile(options);
  if (options.command === 'trace') return runTrace(options);

  const dataset = await loadDataset(options.input);
  const result = options.command === 'summary' ? summarize(dataset.records)
    : { records: dataset.records.length, fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
  const document = { ...result, inputFingerprint: dataset.fingerprint };
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
