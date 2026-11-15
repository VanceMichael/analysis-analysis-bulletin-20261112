import { createHash } from 'node:crypto';
import { canonical, fingerprint, validateRecords } from './dataset.js';

export function pointKey(point) {
  return `${point.metric}|${point.country}|${point.period}`;
}

function hashArtifact(artifact) {
  return createHash('sha256').update(JSON.stringify(canonical({
    id: artifact.id, explanation: artifact.explanation,
  }))).digest('hex');
}

// 把一次签发需要的完整材料一次性冻结：数据截点、口径指纹、产物哈希、解释片段与指标点快照。
// 正文（解释片段）和图（指标点数值）来自同一材料，调用方不能分别再读最新值。
export function freezeMaterial({ topic, records, artifacts, clock, issuedAt }) {
  validateRecords(records);
  if (typeof topic !== 'string' || topic.length === 0) throw new Error('简报主题必须是非空字符串');
  const definitions = [...new Set(records.map(record => record.definition))].sort();
  if (definitions.length !== 1) {
    throw new Error(`同一发布批次不能混用口径版本，发现 ${definitions.length} 个 definition：${definitions.join(', ')}`);
  }
  const frozenArtifacts = artifacts.map(artifact => ({
    id: artifact.id,
    explanation: artifact.explanation,
    hash: hashArtifact(artifact),
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'));

  const points = records
    .map(record => ({
      key: pointKey(record),
      recordId: record.id,
      metric: record.metric,
      country: record.country,
      period: record.period,
      value: record.value,
      status: record.status,
      cutoff: record.cutoff,
      definition: record.definition,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en'));

  const bundle = {
    topic,
    schemaVersion: 1,
    dataCutoff: records.reduce((max, record) => Math.max(max, record.cutoff), 0),
    definition: definitions[0],
    inputFingerprint: fingerprint([...records].sort(
      (left, right) => left.id.localeCompare(right.id, 'en'))),
    artifacts: frozenArtifacts,
    artifactHash: fingerprint(frozenArtifacts),
    points,
  };
  // materialHash 只覆盖材料内容（数据、口径、产物），不含签发时间：
  // 同一份材料在任何时刻重算都得到同一哈希，unchanged 判定才可复现。
  const materialHash = fingerprint(bundle);
  return { ...bundle, issuedAt: (issuedAt ?? clock.now()).toISOString(), materialHash };
}

function indexPoints(material) {
  return new Map(material.points.map(point => [point.key, point]));
}

// 对照已发版本生成候选修订：逐点比较数值、状态与解释/产物差异。
// 更正条件（满足任一即分发）：
//   1. 数值绝对变化严格超过业务阈值 materiality；
//   2. 指标点从可估计（estimated）变成不可估计（unavailable），或其他状态变更；
//   3. 指标点集合发生增删。
// 其余有变化但不触发条件的候选归入 minor-revision：留档但不分发，绝不覆盖旧签发。
export function classifyRevision(prior, next, materiality) {
  if (prior.definition !== next.definition) {
    throw new Error(`口径版本从 ${prior.definition} 变为 ${next.definition}，不能作为同系列修订签发`);
  }
  if (prior.materialHash === next.materialHash) {
    return { kind: 'unchanged', changed: [], reasons: [], correction: false };
  }
  const before = indexPoints(prior);
  const after = indexPoints(next);
  const changed = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldPoint = before.get(key);
    const newPoint = after.get(key);
    const triggers = [];
    let delta = null;
    if (!oldPoint || !newPoint) {
      triggers.push('membership');
    } else {
      delta = newPoint.value - oldPoint.value;
      if (Math.abs(delta) > materiality) triggers.push('value-material');
      if (oldPoint.status !== newPoint.status) {
        triggers.push(oldPoint.status === 'estimated' && newPoint.status === 'unavailable'
          ? 'became-unavailable' : 'status-change');
      }
    }
    changed.push({
      key,
      metric: (newPoint ?? oldPoint).metric,
      country: (newPoint ?? oldPoint).country,
      period: (newPoint ?? oldPoint).period,
      delta,
      triggers,
      from: oldPoint ? { value: oldPoint.value, status: oldPoint.status } : null,
      to: newPoint ? { value: newPoint.value, status: newPoint.status } : null,
    });
  }
  const pointReasons = [...new Set(changed.flatMap(item => item.triggers))].sort();
  const explanationChanged = prior.artifactHash !== next.artifactHash;
  const correction = pointReasons.length > 0;
  return {
    kind: correction ? 'correction' : 'minor-revision',
    correction,
    reasons: correction ? pointReasons : (explanationChanged ? ['explanation-only'] : ['within-materiality']),
    explanationChanged,
    changed,
  };
}
