import { open, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from './dataset.js';
import { writeResult } from './output.js';

const LEDGER_NAME = 'ledger.json';
const LOCK_NAME = 'lock';
const OUTBOX_DIR = 'outbox';
const MAIL_DIR = 'mail';
const LEDGER_VERSION = 1;

export function idempotencyKey(versionId, subscriptionId) {
  return createHash('sha256').update(`${versionId}\u0000${subscriptionId}`).digest('hex');
}

// 进程间互斥：CLI 不同命令可能先后操作同一状态目录，锁保证 ledger/outbox 串行修改。
export class StoreLock {
  constructor(path, handle) {
    this.path = path;
    this.handle = handle;
  }

  static async acquire(stateDir) {
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, LOCK_NAME);
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      return new StoreLock(path, handle);
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new Error('状态目录已被另一个发布进程占用');
      throw error;
    }
  }

  async release() {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
      await rm(this.path, { force: true });
    }
  }
}

export function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    bulletins: {},
    deliveries: {},
    events: [],
  };
}

export class Store {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.ledgerPath = join(stateDir, LEDGER_NAME);
    this.outboxDir = join(stateDir, OUTBOX_DIR);
    this.mailDir = join(stateDir, MAIL_DIR);
  }

  async init() {
    await mkdir(this.outboxDir, { recursive: true });
    await mkdir(this.mailDir, { recursive: true });
    try {
      await readFile(this.ledgerPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') await writeResult(this.ledgerPath, emptyLedger());
      else throw error;
    }
    return this;
  }

  async readLedger() {
    try {
      const ledger = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      if (ledger.version !== LEDGER_VERSION) throw new Error('不支持的状态文件版本');
      return ledger;
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyLedger();
      throw error;
    }
  }

  async writeLedger(ledger) {
    await writeResult(this.ledgerPath, ledger);
  }

  messagePath(key) {
    return join(this.outboxDir, `${key}.json`);
  }

  async enqueue(message) {
    await mkdir(this.outboxDir, { recursive: true });
    // 幂等键相同即同一投递：已存在的 outbox 记录保持不变，绝不重复入队。
    try {
      const handle = await open(this.messagePath(message.idempotencyKey), 'wx', 0o600);
      await handle.writeFile(JSON.stringify(canonical(message), null, 2) + '\n');
      await handle.sync();
      await handle.close();
      return { created: true };
    } catch (error) {
      if (error && error.code === 'EEXIST') return { created: false };
      throw error;
    }
  }

  async listMessages() {
    let names;
    try {
      names = await readdir(this.outboxDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    const messages = [];
    for (const name of names.filter(file => file.endsWith('.json')).sort()) {
      messages.push(JSON.parse(await readFile(join(this.outboxDir, name), 'utf8')));
    }
    return messages;
  }

  async updateMessage(message) {
    await writeResult(this.messagePath(message.idempotencyKey), message);
  }

  // reconcile 兜底：outbox 记录丢失但 ledger 仍有登记时，依据 ledger 重建待发记录。
  async restoreMessage(message) {
    return this.enqueue(message);
  }

  async appendEvent(ledger, event) {
    ledger.events.push({ at: event.at, type: event.type, detail: event.detail });
  }
}
