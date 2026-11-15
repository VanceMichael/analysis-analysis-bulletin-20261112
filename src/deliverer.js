import { access, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from './dataset.js';

// 回执写盘前崩溃：文件已落地，但状态尚未持久化。
export class CrashBeforeReceipt extends Error {
  constructor(message) {
    super(`模拟回执写盘前退出：${message.subscriptionId}`);
    this.name = 'CrashBeforeReceipt';
  }
}

// 项目内文件投递器：把“邮件”写成收件组目录下的 JSON 文件，不接真实邮箱。
// 写入采用临时文件 + 原子替换；同一个幂等键只会落向同一路径，重投天然幂等。
// failureHook / crashHook 仅用于演练故障窗口，生产构造时不传钩子即零故障。
// crashHook 返回 'throw' 时抛出不可吞掉的崩溃信号（单元测试用）；
// 返回 'exit' 时直接以退出码 2 终止进程（演示脚本在子进程中使用）。
export class FileDeliverer {
  constructor(mailDir, { failureHook = null, crashHook = null } = {}) {
    this.mailDir = mailDir;
    this.failureHook = failureHook;
    this.crashHook = crashHook;
  }

  targetPath(message) {
    return join(this.mailDir, message.subscriptionId, `${message.idempotencyKey}.json`);
  }

  async alreadyDelivered(message) {
    try {
      await access(this.targetPath(message));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async send(message, context) {
    if (this.failureHook && this.failureHook(message, context)) {
      throw new Error(`注入的投递失败：${message.subscriptionId}`);
    }
    const destination = this.targetPath(message);
    await mkdir(join(this.mailDir, message.subscriptionId), { recursive: true });
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, JSON.stringify(canonical({
      idempotencyKey: message.idempotencyKey,
      versionId: message.versionId,
      bulletinTopic: message.bulletinTopic,
      subscriptionId: message.subscriptionId,
      scheduledAt: message.scheduledAt,
      deliveredAt: context.deliveredAt,
      reason: message.reason,
      changedKeys: message.changedKeys,
      materialHash: message.materialHash,
      snapshot: message.snapshot,
    }), null, 2) + '\n', { encoding: 'utf8' });
    await rename(temporary, destination);

    // 故障窗口：文件已落地，但进程在回执写入 ledger 之前退出。
    // 信号向上穿透，#attempt 不得把它记成普通失败——真实崩溃时根本没有写盘机会。
    if (this.crashHook) {
      const mode = this.crashHook(message, context);
      if (mode === 'exit') process.exit(2);
      if (mode === 'throw') throw new CrashBeforeReceipt(message);
    }
    return { transport: 'file', path: destination };
  }
}
