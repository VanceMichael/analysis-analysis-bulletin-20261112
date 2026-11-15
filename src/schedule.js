// 按订阅时区的本地时刻做确定性调度。
// 夏令时处理策略：
//   gap（本地时刻不存在，春季跳变）：shift-forward，取渲染出该墙钟时间的最早有效瞬间；
//   overlap（本地时刻重复，秋季回退）：默认 earlier，取第一次出现（夏令时、较大偏移），
//     可配置 later 取第二次；解析结果连同策略一起写入投递记录，保证可追溯。
const HOUR_MS = 3600000;
// 全球任意时区的墙钟 UTC 表示与跳变时刻最多相差约 14 小时；
// 前后各采 12 小时并覆盖中点，保证拿到跳变两侧的全部偏移。
const PROBE_HOURS = [-12, -6, 0, 6, 12];

const partsFormatterCache = new Map();

function formatter(zone) {
  if (!partsFormatterCache.has(zone)) {
    partsFormatterCache.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsFormatterCache.get(zone);
}

export function wallClockParts(instant, zone) {
  const parts = Object.fromEntries(
    formatter(zone).formatToParts(instant)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// instant 在 zone 内的 UTC 偏移（毫秒，东区为正）。
export function zoneOffsetAt(instant, zone) {
  const parts = wallClockParts(instant, zone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - instant.getTime();
}

function compareParts(left, right) {
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

// 把“zone 内某个 UTC 日期的 localTime 墙钟”解析为绝对瞬间。
// localTime 形如 "HH:MM"；day 为 UTC 年月日（用 Date.UTC 构造，再按 zone 本地化）。
export function resolveLocal(zone, day, localTime, overlapPolicy = 'earlier') {
  if (!['earlier', 'later'].includes(overlapPolicy)) {
    throw new Error('overlap 策略只能是 earlier 或 later');
  }
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error(`本地时刻应为 HH:MM：${localTime}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`本地时刻超出范围：${localTime}`);
  const wall = new Date(day.getTime() + Date.UTC(1970, 0, 1, hour, minute) - Date.UTC(1970, 0, 1));
  // 目标是“zone 本地墙钟”的年月日时分，直接取构造参数，不能把 UTC 墙钟再本地化一次。
  const targetParts = {
    year: day.getUTCFullYear(),
    month: day.getUTCMonth() + 1,
    day: day.getUTCDate(),
    hour,
    minute,
    second: 0,
  };

  // 偏移只在跳变日变化；在墙钟两侧采样，足以覆盖跳变两侧的偏移集合。
  const offsets = new Set();
  for (const delta of PROBE_HOURS) {
    offsets.add(zoneOffsetAt(new Date(wall.getTime() - delta * HOUR_MS), zone));
  }
  const fixed = [...offsets]
    .map(offset => {
      const instant = new Date(wall.getTime() - offset);
      return { offset, instant, valid: zoneOffsetAt(instant, zone) === offset };
    })
    .filter(candidate => candidate.valid)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime());

  if (fixed.length === 1) {
    return { instant: fixed[0].instant, kind: 'normal', policy: null, offsetMs: fixed[0].offset, alternatives: [] };
  }
  if (fixed.length >= 2) {
    const chosen = overlapPolicy === 'later' ? fixed[fixed.length - 1] : fixed[0];
    return {
      instant: chosen.instant,
      kind: 'ambiguous',
      policy: overlapPolicy,
      offsetMs: chosen.offset,
      alternatives: fixed.map(candidate => candidate.instant.toISOString()),
    };
  }

  // 没有固定点：墙钟落在 gap 中。候选瞬间渲染出的墙钟要么在目标之前、
  // 要么在跳变之后；shift-forward 取晚于目标的最早有效瞬间（时间上最小者）。
  const shifted = [...offsets]
    .map(offset => {
      const instant = new Date(wall.getTime() - offset);
      return {
        offset: zoneOffsetAt(instant, zone),
        instant,
        parts: wallClockParts(instant, zone),
      };
    })
    .filter(candidate => compareParts(candidate.parts, targetParts) > 0)
    .sort((left, right) => left.instant.getTime() - right.instant.getTime());
  const chosen = shifted[0];
  if (!chosen) throw new Error(`无法解析时区 ${zone} 的本地时刻 ${localTime}`);
  return { instant: chosen.instant, kind: 'gap', policy: 'shift-forward', offsetMs: chosen.offset, alternatives: [] };
}

// 从 fromInstant 开始，下一次到达订阅本地 localTime 的绝对瞬间（按 zone 本地日历逐日推进）。
export function nextRunAt(zone, localTime, fromInstant, overlapPolicy = 'earlier') {
  let day = new Date(Date.UTC(fromInstant.getUTCFullYear(), fromInstant.getUTCMonth(), fromInstant.getUTCDate()));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const resolved = resolveLocal(zone, day, localTime, overlapPolicy);
    if (resolved.instant.getTime() > fromInstant.getTime()) return resolved;
    day = new Date(day.getTime() + 24 * HOUR_MS);
  }
  throw new Error('本地时刻调度推进失败');
}
