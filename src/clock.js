// 可注入时钟：演示与测试不等待真实日历，生产路径只依赖 SystemClock。
export class SystemClock {
  now() {
    return new Date();
  }
}

export class FixedClock {
  constructor(instants) {
    if (!Array.isArray(instants) || instants.length === 0) throw new Error('固定时钟至少需要一个时刻');
    this.instants = instants.map(value => value instanceof Date ? value : new Date(value));
    this.cursor = 0;
  }

  now() {
    const instant = this.instants[Math.min(this.cursor, this.instants.length - 1)];
    this.cursor += 1;
    return new Date(instant.getTime());
  }
}

export function toInstant(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`无法解析的时刻：${String(value)}`);
  return instant;
}
