import { Interface, type Log, type Provider } from 'ethers';

const FACTORY_EVENTS = new Interface(['event VaultCreated(address indexed owner,address indexed vault)']);
const AGENT_EVENTS = new Interface([
  'event AgentRegistered(address indexed agent,uint256 maxNativePerTx,uint256 maxNativePerDay)',
  'event AgentRevoked(address indexed agent)',
]);
const VAULT_EVENTS = new Interface([
  'event RecipientPermissionChanged(address indexed recipient,bool allowed)',
  'event TokenPolicyChanged(address indexed token,bool allowed,uint256 maxPerTx,uint256 maxPerDay)',
  'event NativeTransferExecuted(address indexed agent,address indexed recipient,uint256 amount)',
  'event TokenTransferExecuted(address indexed agent,address indexed token,address indexed recipient,uint256 amount)',
  'event OwnerWithdrawal(address indexed asset,address indexed recipient,uint256 amount)',
]);

export type DiscoveryProgress = { phase: 'locating-vault' | 'loading-agents' | 'loading-history'; completed: number; total: number };

export async function withTimeout<T>(request: Promise<T>, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC log request timed out')), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function isRangeError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /range|too many|limit|response size|block span|timeout|timed out|more than|query returned/.test(message);
}

async function readLogs(provider: Provider, address: string, topics: (string | string[] | null)[], fromBlock: number, toBlock: number, onChunk?: (from: number, to: number) => void) {
  const logs: Log[] = [];
  let cursor = fromBlock;
  let span = 2_000;
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + span - 1);
    try {
      logs.push(...await withTimeout(provider.getLogs({ address, topics, fromBlock: cursor, toBlock: end })));
      onChunk?.(cursor, end);
      cursor = end + 1;
      span = Math.min(2_000, span * 2);
    } catch (error) {
      if (!isRangeError(error) || span === 1) throw error;
      span = Math.max(1, Math.floor(span / 2));
    }
  }
  return logs;
}

export async function findVaultCreationBlock(provider: Provider, factory: string, owner: string, vault: string, latestBlock: number, onProgress?: (progress: DiscoveryProgress) => void) {
  const eventTopic = FACTORY_EVENTS.getEvent('VaultCreated')!.topicHash;
  const ownerTopic = `0x${owner.toLowerCase().slice(2).padStart(64, '0')}`;
  const vaultTopic = `0x${vault.toLowerCase().slice(2).padStart(64, '0')}`;
  let end = latestBlock;
  let span = 2_000;
  let scanned = 0;
  while (end >= 0) {
    const start = Math.max(0, end - span + 1);
    try {
      onProgress?.({ phase: 'locating-vault', completed: scanned, total: latestBlock + 1 });
      const logs = await withTimeout(provider.getLogs({ address: factory, topics: [eventTopic, ownerTopic, vaultTopic], fromBlock: start, toBlock: end }));
      if (logs.length) return Math.min(...logs.map(log => log.blockNumber));
      scanned += end - start + 1;
      end = start - 1;
      span = Math.min(2_000, span * 2);
    } catch (error) {
      if (!isRangeError(error) || span === 1) throw error;
      span = Math.max(1, Math.floor(span / 2));
    }
  }
  throw new Error('The configured factory has no VaultCreated event for this vault. Check the selected network and factory address.');
}

export async function loadAgentHistory(provider: Provider, vault: string, fromBlock: number, latestBlock: number, onProgress?: (progress: DiscoveryProgress) => void) {
  const names = ['AgentRegistered', 'AgentRevoked'] as const;
  const topics = Object.fromEntries(names.map(name => [name, AGENT_EVENTS.getEvent(name)!.topicHash]));
  let completed = 0;
  const logsByName = await Promise.all(names.map(name => readLogs(provider, vault, [topics[name]], fromBlock, latestBlock, (from, to) => {
    completed += to - from + 1;
    onProgress?.({ phase: 'loading-agents', completed: Math.min(completed, (latestBlock - fromBlock + 1) * names.length), total: Math.max(1, (latestBlock - fromBlock + 1) * names.length) });
  })));
  const rows = names.flatMap((name, index) => logsByName[index].map(log => ({ name, log, parsed: AGENT_EVENTS.parseLog(log)! })))
    .sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);
  return { rows };
}

export async function loadVaultHistory(provider: Provider, vault: string, fromBlock: number, latestBlock: number, onProgress?: (progress: DiscoveryProgress) => void) {
  const names = ['RecipientPermissionChanged', 'TokenPolicyChanged', 'NativeTransferExecuted', 'TokenTransferExecuted', 'OwnerWithdrawal'] as const;
  const topics = Object.fromEntries(names.map(name => [name, VAULT_EVENTS.getEvent(name)!.topicHash]));
  let completed = 0;
  const logsByName = await Promise.all(names.map(name => readLogs(provider, vault, [topics[name]], fromBlock, latestBlock, (from, to) => {
    completed += to - from + 1;
      onProgress?.({ phase: 'loading-history', completed: Math.min(completed, (latestBlock - fromBlock + 1) * names.length), total: Math.max(1, (latestBlock - fromBlock + 1) * names.length) });
  })));
  const rows = names.flatMap((name, index) => logsByName[index].map(log => ({ name, log, parsed: VAULT_EVENTS.parseLog(log)! })))
    .sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);
  return { rows, eventTopics: topics };
}
