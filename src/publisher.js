import { Store, idempotencyKey } from './store.js';
import { freezeMaterial, classifyRevision } from './issuance.js';
import { nextRunAt } from './schedule.js';
import { subscriptionCovers } from './policy.js';
import { CrashBeforeReceipt } from './deliverer.js';

const INITIAL_KIND = 'initial';
const CORRECTION_KIND = 'correction';
const MINOR_KIND = 'minor-revision';

function buildSnapshot(material, versionId, sequence) {
  // 快照是材料的完整不可变副本：收件人即使后来再查，看到的仍是本版数字与解释。
  return {
    versionId,
    sequence,
    topic: material.topic,
    issuedAt: material.issuedAt,
    dataCutoff: material.dataCutoff,
    definition: material.definition,
    inputFingerprint: material.inputFingerprint,
    artifactHash: material.artifactHash,
    materialHash: material.materialHash,
    artifacts: material.artifacts,
    points: material.points,
  };
}

export class Publisher {
  constructor({ store, deliverer, clock, policy }) {
    if (!(store instanceof Store)) throw new Error('Publisher 需要 Store 实例');
    this.store = store;
    this.deliverer = deliverer;
    this.clock = clock;
    this.policy = policy;
  }

  async publishBulletin({ topic, records, artifacts, fromInstant }) {
    const now = this.clock.now();
    const ledger = await this.store.readLedger();
    const bulletin = ledger.bulletins[topic];
    const material = freezeMaterial({ topic, records, artifacts, clock: this.clock });

    let sequence;
    let parentVersionId = null;
    let decision;
    if (!bulletin) {
      sequence = 1;
      decision = { kind: INITIAL_KIND, correction: false, reasons: [], changed: [], explanationChanged: false };
    } else {
      const parent = bulletin.versions[bulletin.versions.length - 1];
      sequence = parent.sequence + 1;
      decision = classifyRevision(parent.material, material, this.policy.materiality);
      parentVersionId = parent.versionId;
      if (decision.kind === 'unchanged') {
        await this.store.appendEvent(ledger, {
          at: now.toISOString(),
          type: 'publish-skipped',
          detail: { topic, parentVersionId, reason: 'material-unchanged' },
        });
        await this.store.writeLedger(ledger);
        return {
          topic, versionId: parent.versionId, sequence: parent.sequence,
          decision, deliveries: [], frozenAt: now.toISOString(),
        };
      }
    }

    const versionId = `${topic}#v${sequence}`;
    const version = {
      versionId,
      sequence,
      topic,
      parentVersionId,
      kind: decision.kind === INITIAL_KIND ? INITIAL_KIND
        : decision.correction ? CORRECTION_KIND : MINOR_KIND,
      material,
      decision,
      frozenAt: now.toISOString(),
    };

    const deliveries = [];
    // 只有初版与实质更正进入分发；minor-revision 只留档，不覆盖旧签发也不产生投递。
    if (version.kind !== MINOR_KIND) {
      const changedKeys = decision.kind === INITIAL_KIND ? []
        : decision.changed.filter(item => item.triggers.length > 0).map(item => item.key);
      const base = fromInstant ?? now;
      for (const subscription of this.policy.subscriptions) {
        const scope = material.points.filter(point => subscriptionCovers(subscription, point));
        if (scope.length === 0) continue;
        if (version.kind === CORRECTION_KIND) {
          const relevant = decision.changed.some(item =>
            item.triggers.length > 0 && subscriptionCovers(subscription, item));
          if (!relevant) continue;
        }
        const overlap = subscription.overlap ?? 'earlier';
        const resolved = nextRunAt(subscription.zone, subscription.localTime,
          new Date(base.getTime() - 1), overlap);
        const key = idempotencyKey(versionId, subscription.id);
        const message = {
          idempotencyKey: key,
          bulletinTopic: topic,
          bulletinId: topic,
          versionId,
          sequence,
          kind: version.kind,
          subscriptionId: subscription.id,
          scheduledAt: resolved.instant.toISOString(),
          timezone: {
            zone: subscription.zone,
            localTime: subscription.localTime,
            resolution: resolved.kind,
            policy: resolved.policy,
            offsetMs: resolved.offsetMs,
            alternatives: resolved.alternatives,
          },
          reason: version.kind === INITIAL_KIND ? 'initial-issuance' : decision.reasons.join('+'),
          changedKeys,
          materialHash: material.materialHash,
          status: 'pending',
          attempts: 0,
          snapshot: buildSnapshot(material, versionId, sequence),
        };
        const { created } = await this.store.enqueue(message);
        const delivery = {
          idempotencyKey: key,
          bulletinTopic: topic,
          versionId,
          sequence,
          kind: version.kind,
          subscriptionId: subscription.id,
          status: 'pending',
          scheduledAt: message.scheduledAt,
          timezone: message.timezone,
          reason: message.reason,
          changedKeys,
          materialHash: material.materialHash,
          enqueuedAt: now.toISOString(),
          attempts: 0,
          lastError: null,
          sentAt: null,
          transport: null,
          deduped: !created,
        };
        ledger.deliveries[key] = delivery;
        deliveries.push(delivery);
      }
    }

    const storedVersion = { ...version };
    if (!bulletin) {
      ledger.bulletins[topic] = { topic, definition: material.definition, versions: [storedVersion] };
    } else {
      bulletin.versions.push(storedVersion);
    }
    await this.store.appendEvent(ledger, {
      at: now.toISOString(),
      type: version.kind === MINOR_KIND ? 'minor-revision-archived' : 'version-frozen',
      detail: {
        topic, versionId, sequence, kind: version.kind,
        parentVersionId, reasons: decision.reasons,
        deliveredTo: deliveries.map(delivery => delivery.subscriptionId),
      },
    });
    await this.store.writeLedger(ledger);

    return {
      topic, versionId, sequence, kind: version.kind,
      decision, deliveries, materialHash: material.materialHash,
      frozenAt: now.toISOString(),
    };
  }

  async #attempt(message, ledger) {
    const now = this.clock.now().toISOString();
    const delivery = ledger.deliveries[message.idempotencyKey];
    if (delivery && delivery.status === 'sent') {
      return { idempotencyKey: message.idempotencyKey, subscriptionId: message.subscriptionId, outcome: 'already-sent' };
    }
    message.attempts += 1;
    try {
      const receipt = await this.deliverer.send(message, { deliveredAt: now });
      message.status = 'sent';
      message.sentAt = now;
      message.lastError = null;
      await this.store.updateMessage(message);
      if (delivery) {
        delivery.status = 'sent';
        delivery.sentAt = now;
        delivery.attempts = message.attempts;
        delivery.lastError = null;
        delivery.transport = receipt.transport;
      }
      await this.store.appendEvent(ledger, {
        at: now,
        type: 'delivered',
        detail: {
          idempotencyKey: message.idempotencyKey, versionId: message.versionId,
          subscriptionId: message.subscriptionId, attempts: message.attempts,
        },
      });
      return { idempotencyKey: message.idempotencyKey, subscriptionId: message.subscriptionId, outcome: 'sent', attempts: message.attempts };
    } catch (error) {
      // 回执写盘前崩溃：保持 pending 原样向上抛，模拟真实进程退出时“什么都没来得及记”。
      if (error instanceof CrashBeforeReceipt) throw error;
      message.lastError = error.message;
      await this.store.updateMessage(message);
      if (delivery) {
        delivery.status = 'failed';
        delivery.attempts = message.attempts;
        delivery.lastError = error.message;
      }
      await this.store.appendEvent(ledger, {
        at: now,
        type: 'delivery-failed',
        detail: {
          idempotencyKey: message.idempotencyKey, versionId: message.versionId,
          subscriptionId: message.subscriptionId, attempts: message.attempts,
          error: error.message,
        },
      });
      return {
        idempotencyKey: message.idempotencyKey, subscriptionId: message.subscriptionId,
        outcome: 'failed', error: error.message, attempts: message.attempts,
      };
    }
  }

  // 派发所有到期的 pending 消息。按订阅隔离：单个收件组失败不影响其他收件组。
  async pumpDue(limitInstant = this.clock.now()) {
    const ledger = await this.store.readLedger();
    const messages = await this.store.listMessages();
    const due = messages
      .filter(message => message.status === 'pending'
        && new Date(message.scheduledAt).getTime() <= limitInstant.getTime())
      .sort((left, right) =>
        new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime()
        || left.idempotencyKey.localeCompare(right.idempotencyKey));
    const results = [];
    const failedSubscriptions = new Set();
    for (const message of due) {
      if (failedSubscriptions.has(message.subscriptionId)) {
        results.push({
          idempotencyKey: message.idempotencyKey, subscriptionId: message.subscriptionId,
          outcome: 'skipped-isolated',
        });
        continue;
      }
      const result = await this.#attempt(message, ledger);
      // 每封邮件的回执立即持久化：进程在后续投递中崩溃时，已完成的回执不丢。
      await this.store.writeLedger(ledger);
      if (result.outcome === 'failed') failedSubscriptions.add(message.subscriptionId);
      results.push(result);
    }
    return { at: limitInstant.toISOString(), considered: due.length, results };
  }

  // reconcile：以 outbox 与 ledger 双向对账恢复持久状态，不依赖任何内存去重。
  // - 消息文件在、ledger 缺登记：补回 pending；
  // - ledger 是 pending、消息文件丢失：按快照重建；
  // - ledger 已 sent 但消息仍是 pending（回执写盘前退出）：幂等重投并收敛状态；
  // - 消息已 sent 但 ledger 缺登记：以消息为准补登记。
  async reconcile() {
    const now = this.clock.now().toISOString();
    const ledger = await this.store.readLedger();
    const messages = await this.store.listMessages();
    const repairs = [];
    const byKey = new Map(messages.map(message => [message.idempotencyKey, message]));

    for (const message of messages) {
      const delivery = ledger.deliveries[message.idempotencyKey];
      if (!delivery) {
        ledger.deliveries[message.idempotencyKey] = {
          idempotencyKey: message.idempotencyKey,
          bulletinTopic: message.bulletinTopic,
          versionId: message.versionId,
          sequence: message.sequence,
          kind: message.kind,
          subscriptionId: message.subscriptionId,
          status: message.status === 'sent' ? 'sent' : 'pending',
          scheduledAt: message.scheduledAt,
          timezone: message.timezone,
          reason: message.reason,
          changedKeys: message.changedKeys,
          materialHash: message.materialHash,
          enqueuedAt: now,
          attempts: message.attempts ?? 0,
          lastError: message.lastError ?? null,
          sentAt: message.sentAt ?? null,
          transport: message.status === 'sent' ? 'file' : null,
          reconciled: true,
        };
        repairs.push({ idempotencyKey: message.idempotencyKey, action: 'ledger-rebuilt', status: message.status });
      } else if (delivery.status === 'sent' && message.status === 'pending') {
        repairs.push({ idempotencyKey: message.idempotencyKey, action: 'resume-after-crash' });
      } else if (delivery.status === 'pending' && message.status === 'pending') {
        // 回执写盘前退出的在途消息：邮件文件已存在即视为投递成功，按幂等重放收敛。
        if (await this.deliverer.alreadyDelivered(message)) {
          repairs.push({ idempotencyKey: message.idempotencyKey, action: 'resume-after-crash' });
        }
      }
    }

    for (const [key, delivery] of Object.entries(ledger.deliveries)) {
      if (delivery.status === 'pending' && !byKey.has(key)) {
        const bulletin = ledger.bulletins[delivery.bulletinTopic];
        const version = bulletin?.versions.find(item => item.versionId === delivery.versionId);
        if (!version) throw new Error(`无法重建 outbox 记录 ${key}：冻结版本缺失`);
        const message = {
          idempotencyKey: key,
          bulletinTopic: delivery.bulletinTopic,
          bulletinId: delivery.bulletinTopic,
          versionId: delivery.versionId,
          sequence: delivery.sequence,
          kind: delivery.kind,
          subscriptionId: delivery.subscriptionId,
          scheduledAt: delivery.scheduledAt,
          timezone: delivery.timezone,
          reason: delivery.reason,
          changedKeys: delivery.changedKeys,
          materialHash: delivery.materialHash,
          status: 'pending',
          attempts: delivery.attempts ?? 0,
          snapshot: buildSnapshot(version.material, delivery.versionId, delivery.sequence),
        };
        await this.store.restoreMessage(message);
        byKey.set(key, message);
        repairs.push({ idempotencyKey: key, action: 'outbox-rebuilt' });
      }
    }

    await this.store.appendEvent(ledger, {
      at: now,
      type: 'reconcile',
      detail: {
        messages: messages.length,
        deliveries: Object.keys(ledger.deliveries).length,
        repairs,
      },
    });
    await this.store.writeLedger(ledger);

    // 崩溃窗口收敛：到期的 in-flight 消息重投，文件投递器按幂等键覆盖同一路径，不产生第二封。
    const pump = await this.pumpDue(this.clock.now());
    return { at: now, repairs, pump };
  }
}
