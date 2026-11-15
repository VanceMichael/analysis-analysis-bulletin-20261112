import { Store, StoreLock } from './store.js';
import { FileDeliverer } from './deliverer.js';
import { Publisher } from './publisher.js';
import { loadPolicy } from './policy.js';

// 组装持久化发布栈：同一状态目录配文件投递器、可注入时钟与业务策略。
// fault 选项只用于本地演练故障窗口，生产路径不传。
export async function createPublisherContext({ stateDir, policyPath, clock, fault = null }) {
  const policy = await loadPolicy(policyPath);
  const store = await new Store(stateDir).init();
  const deliverer = new FileDeliverer(store.mailDir, fault ?? {});
  const publisher = new Publisher({ store, deliverer, clock, policy });
  return { policy, store, deliverer, publisher };
}

export { StoreLock };
