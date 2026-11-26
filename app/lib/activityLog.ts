/**
 * Activity & Security Logs: turns the vault's real on-chain events (and, optionally, reverted transactions
 * reported by the block explorer) into display entries. Pure functions, no ethers dependency, so the logic
 * can be tested in isolation. Nothing here invents data: every entry comes from a parsed contract event or a
 * transaction the explorer reports as reverted.
 */

export type LogCategory = 'transaction' | 'agent' | 'security';
export type LogFilter = 'all' | LogCategory;

/** A vault event already decoded with the deployed ABI. */
export type ParsedLog = { name: string; args: Record<string, any>; blockNumber: number; index: number; transactionHash: string; timestamp: number };
/** A transaction sent to the vault that the explorer reports as reverted (no events are emitted by reverted transactions). */
export type FailedTx = { hash: string; from: string; blockNumber: number; timestamp: number; fn: string; recipient?: string; token?: string; amount?: bigint };

export type LogEntry = {
  key: string;
  categories: LogCategory[];
  type: string;
  description: string;
  timestamp: number;      // unix seconds; 0 = could not be determined
  blockNumber: number;
  index: number;
  agent?: string; recipient?: string; token?: string; amountText?: string;
  /** Raw numeric values, used by Agent Risk Insights. amount = transfer amount (or the amount an agent tried to send in a reverted call). */
  amount?: bigint; limitPerTx?: bigint; limitPerDay?: bigint;
  /** Name of the vault function called, for reverted transactions (decoded from the transaction input). */
  fn?: string;
  hash: string;
  status: 'Success' | 'Failed';
  addresses: string[];    // every wallet address on the entry (used by search)
};

export type Fmt = { short: (a: string) => string; native: (n: bigint) => string };

const low = (a?: string) => (a || '').toLowerCase();
const toBig = (v: any): bigint => { try { return BigInt(v); } catch { return 0n; } };

export function buildEntries(logs: ParsedLog[], failed: FailedTx[], f: Fmt): LogEntry[] {
  const out = new Map<string, LogEntry>(); // keyed so the same log can never appear twice
  const add = (l: { transactionHash: string; index: number; blockNumber: number; timestamp: number }, e: Omit<LogEntry, 'key' | 'timestamp' | 'blockNumber' | 'index' | 'hash' | 'status' | 'addresses'> & { status?: 'Success' | 'Failed' }) => {
    const key = `${l.transactionHash.toLowerCase()}-${l.index}`;
    if (out.has(key)) return;
    const addresses = [e.agent, e.recipient, e.token].filter(Boolean).map(a => low(a)) as string[];
    out.set(key, { ...e, key, timestamp: l.timestamp, blockNumber: l.blockNumber, index: l.index, hash: l.transactionHash, status: e.status || 'Success', addresses });
  };
  for (const l of logs) {
    const a = l.args;
    switch (l.name) {
      case 'AgentRegistered':
        add(l, { categories: ['agent'], type: 'Agent registered', agent: a.agent, limitPerTx: toBig(a.maxNativePerTx), limitPerDay: toBig(a.maxNativePerDay), description: `Agent ${f.short(a.agent)} was registered with limits of ${f.native(toBig(a.maxNativePerTx))} per transaction and ${f.native(toBig(a.maxNativePerDay))} per day.` }); break;
      case 'AgentRevoked':
        add(l, { categories: ['agent', 'security'], type: 'Agent revoked', agent: a.agent, description: `Agent ${f.short(a.agent)} was permanently revoked and lost all vault access.` }); break;
      case 'AgentStatusChanged':
        add(l, { categories: ['agent', 'security'], type: a.paused ? 'Agent paused' : 'Agent resumed', agent: a.agent, description: a.paused ? `Agent ${f.short(a.agent)} was paused by the owner.` : `Agent ${f.short(a.agent)} was resumed by the owner.` }); break;
      case 'AgentLimitsChanged':
        add(l, { categories: ['agent', 'security'], type: 'Spending limits changed', agent: a.agent, limitPerTx: toBig(a.maxNativePerTx), limitPerDay: toBig(a.maxNativePerDay), description: `Limits for agent ${f.short(a.agent)} are now ${f.native(toBig(a.maxNativePerTx))} per transaction and ${f.native(toBig(a.maxNativePerDay))} per day.` }); break;
      case 'RecipientPermissionChanged':
        add(l, { categories: ['security'], type: a.allowed ? 'Recipient added' : 'Recipient removed', recipient: a.recipient, description: a.allowed ? `${f.short(a.recipient)} was added to the approved recipients.` : `${f.short(a.recipient)} was removed from the approved recipients.` }); break;
      case 'TokenPolicyChanged':
        add(l, { categories: ['security'], type: a.allowed ? 'Token permission added' : 'Token permission removed', token: a.token, limitPerTx: toBig(a.maxPerTx), limitPerDay: toBig(a.maxPerDay), amountText: a.allowed ? `limits ${toBig(a.maxPerTx)} per tx / ${toBig(a.maxPerDay)} per day (token units)` : undefined, description: a.allowed ? `Token ${f.short(a.token)} was approved with a limit of ${toBig(a.maxPerTx)} units per transaction and ${toBig(a.maxPerDay)} per day.` : `Token ${f.short(a.token)} permission was removed.` }); break;
      case 'GlobalPauseChanged':
        add(l, { categories: ['security'], type: a.paused ? 'Emergency pause enabled' : 'Emergency pause disabled', description: a.paused ? 'Emergency pause was enabled. All agents are blocked from executing transfers.' : 'Emergency pause was disabled. Agents can execute transfers within their limits again.' }); break;
      case 'NativeTransferExecuted':
        add(l, { categories: ['transaction', 'agent'], type: 'Native transfer executed', agent: a.agent, recipient: a.recipient, amount: toBig(a.amount), amountText: f.native(toBig(a.amount)), description: `Agent ${f.short(a.agent)} sent ${f.native(toBig(a.amount))} to ${f.short(a.recipient)}.` }); break;
      case 'TokenTransferExecuted':
        add(l, { categories: ['transaction', 'agent'], type: 'Token transfer executed', agent: a.agent, recipient: a.recipient, token: a.token, amount: toBig(a.amount), amountText: `${toBig(a.amount)} units`, description: `Agent ${f.short(a.agent)} sent ${toBig(a.amount)} units of token ${f.short(a.token)} to ${f.short(a.recipient)}.` }); break;
      case 'OwnerWithdrawal': {
        const isNative = /^0x0{40}$/i.test(a.asset);
        add(l, { categories: ['transaction', 'security'], type: 'Owner withdrawal', recipient: a.recipient, token: isNative ? undefined : a.asset, amountText: isNative ? f.native(toBig(a.amount)) : `${toBig(a.amount)} units`, description: `The owner withdrew ${isNative ? f.native(toBig(a.amount)) : `${toBig(a.amount)} units of token ${f.short(a.asset)}`} to ${f.short(a.recipient)}.` }); break;
      }
      default: break; // unknown event: never displayed, never guessed
    }
  }
  for (const t of failed) {
    const key = `${t.hash.toLowerCase()}-failed`;
    if (out.has(key)) continue;
    const isTransfer = t.fn === 'executeNative' || t.fn === 'executeTokenTransfer';
    out.set(key, {
      key, categories: ['transaction', 'security'], type: isTransfer ? 'Blocked agent transfer' : 'Failed transaction',
      description: `${isTransfer ? 'An agent transfer call' : `A call to ${t.fn || 'the vault'}`} from ${f.short(t.from)} reverted on-chain. No funds moved. The revert reason is not shown here; open the transaction in the explorer for details.`,
      timestamp: t.timestamp, blockNumber: t.blockNumber, index: Number.MAX_SAFE_INTEGER, hash: t.hash, status: 'Failed', addresses: [low(t.from)], agent: isTransfer ? t.from : undefined,
      fn: t.fn || undefined, recipient: t.recipient, token: t.token, amount: t.amount,
    });
  }
  return sortEntries([...out.values()]);
}

/** Newest first. */
export function sortEntries(e: LogEntry[]): LogEntry[] {
  return e.sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);
}

export function filterEntries(entries: LogEntry[], filter: LogFilter, query: string): LogEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(e => (filter === 'all' || e.categories.includes(filter)) && (!q || e.hash.toLowerCase().includes(q) || e.addresses.some(a => a.includes(q))));
}

/**
 * Reverted transactions sent to the vault, from a Blockscout/Etherscan-compatible `txlist` endpoint.
 * Reverted transactions emit no contract events, so the RPC log scan cannot see them; the explorer indexes them.
 * Pages are fetched until exhausted. `complete` is false if the safety cap was hit. Throws on any API failure.
 */
export async function fetchFailedTxs(baseUrl: string, vault: string, fetchImpl: typeof fetch = fetch, maxPages = 10, pageSize = 1000): Promise<{ txs: { hash: string; from: string; blockNumber: number; timestamp: number; input: string }[]; complete: boolean }> {
  const base = baseUrl.replace(/\/$/, '');
  const txs: { hash: string; from: string; blockNumber: number; timestamp: number; input: string }[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ module: 'account', action: 'txlist', address: vault, startblock: '0', endblock: '99999999', page: String(page), offset: String(pageSize), sort: 'desc' });
    const res = await fetchImpl(`${base}/api?${q.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    if (!Array.isArray(body.result)) {
      if (body.status === '0' && /no transactions found/i.test(String(body.message))) return { txs, complete: true };
      throw new Error(String(body.message || 'unexpected explorer response'));
    }
    for (const t of body.result) if (String(t.isError) === '1' || String(t.txreceipt_status) === '0') txs.push({ hash: t.hash, from: t.from, blockNumber: Number(t.blockNumber), timestamp: Number(t.timeStamp), input: t.input || '0x' });
    if (body.result.length < pageSize) return { txs, complete: true };
  }
  return { txs, complete: false };
}
