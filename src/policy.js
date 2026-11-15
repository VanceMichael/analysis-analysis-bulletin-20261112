import { readFile } from 'node:fs/promises';

const OVERLAP_POLICIES = new Set(['earlier', 'later']);

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('业务配置必须是对象');
  }
  if (typeof policy.materiality !== 'number' || !Number.isFinite(policy.materiality) || policy.materiality < 0) {
    throw new Error('materiality 必须是非负有限数');
  }
  if (!Array.isArray(policy.subscriptions) || policy.subscriptions.length === 0) {
    throw new Error('subscriptions 至少包含一个收件组');
  }
  const ids = new Set();
  for (const [index, subscription] of policy.subscriptions.entries()) {
    const label = `第 ${index + 1} 个收件组`;
    if (subscription === null || typeof subscription !== 'object' || Array.isArray(subscription)) {
      throw new Error(`${label} 必须是对象`);
    }
    requireString(subscription.id, `${label} 的 id`);
    if (ids.has(subscription.id)) throw new Error(`收件组 id 重复：${subscription.id}`);
    ids.add(subscription.id);
    requireString(subscription.zone, `${label} 的 zone`);
    requireString(subscription.localTime, `${label} 的 localTime`);
    if (!/^\d{2}:\d{2}$/.test(subscription.localTime)) throw new Error(`${label} 的 localTime 应为 HH:MM`);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: subscription.zone });
    } catch {
      throw new Error(`${label} 的时区无法识别：${subscription.zone}`);
    }
    if (!Array.isArray(subscription.countries) || subscription.countries.length === 0
      || subscription.countries.some(country => typeof country !== 'string' || country.length === 0)) {
      throw new Error(`${label} 的 countries 必须是非空字符串数组`);
    }
    if (new Set(subscription.countries).size !== subscription.countries.length) {
      throw new Error(`${label} 的 countries 存在重复`);
    }
    if (subscription.metrics !== undefined) {
      if (!Array.isArray(subscription.metrics) || subscription.metrics.length === 0
        || subscription.metrics.some(metric => typeof metric !== 'string' || metric.length === 0)) {
        throw new Error(`${label} 的 metrics 应为非空字符串数组或省略`);
      }
      if (new Set(subscription.metrics).size !== subscription.metrics.length) {
        throw new Error(`${label} 的 metrics 存在重复`);
      }
    }
    if (subscription.overlap !== undefined && !OVERLAP_POLICIES.has(subscription.overlap)) {
      throw new Error(`${label} 的 overlap 只能是 earlier 或 later`);
    }
  }
  if (!Array.isArray(policy.artifacts)) throw new Error('artifacts 必须是数组');
  for (const [index, artifact] of policy.artifacts.entries()) {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error(`第 ${index + 1} 个分析产物必须是对象`);
    }
    requireString(artifact.id, `第 ${index + 1} 个分析产物的 id`);
    requireString(artifact.explanation, `第 ${index + 1} 个分析产物的 explanation`);
  }
  const artifactIds = new Set(policy.artifacts.map(artifact => artifact.id));
  if (artifactIds.size !== policy.artifacts.length) throw new Error('分析产物 id 重复');
  return policy;
}

export async function loadPolicy(path) {
  const policy = JSON.parse(await readFile(path, 'utf8'));
  return validatePolicy(policy);
}

export function subscriptionCovers(subscription, point) {
  if (!subscription.countries.includes(point.country)) return false;
  if (subscription.metrics && !subscription.metrics.includes(point.metric)) return false;
  return true;
}
