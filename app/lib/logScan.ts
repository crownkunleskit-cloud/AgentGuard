/**
 * Resilient historical log retrieval for the AgentGuard dashboard.
 *
 * Why this exists: the vault does not expose an enumerable list of agents, so the only way to
 * discover previously registered agents is to read the vault's AgentRegistered events. A single
 * fixed look-back window (or one failed eth_getLogs call) used to make older agents disappear.
 *
 * This module has no dependency on ethers so it can be unit tested in isolation.
 */

export type RawLog = { blockNumber: number; index: number; transactionHash: string; topics: string[]; data: string };

export type LogSource = {
  name: string;
  /** Latest block number as seen by this source. Not needed when `unbounded` is true. */
  getLatest: () => Promise<number>;
  /** Fetch logs for [from, to] inclusive. Must throw on any error (never return partial data silently). */
  getLogs: (address: string, topics: (string | null)[], from: number, to: number | 'latest') => Promise<RawLog[]>;
  /** True for index-backed APIs (e.g. Blockscout) that ignore block ranges. */
  unbounded?: boolean;
};

const MAX_CALLS = 4000;      // hard stop so a broken RPC cannot loop forever
const PARALLEL = 6;          // parallel windows once a node's range limit has been learned

const sortLogs = (logs: RawLog[]) => logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

/**
 * Scan [from, latest] on one source. Tries the whole range in a single call first (nodes accept this
 * when the filter is selective, which an address+topic filter is). If the node rejects the range, the
 * window is halved and remembered, so the remaining blocks are scanned in windows the node accepts.
 * Throws if any part of the range cannot be read. It never returns a partially scanned result.
 */
export async function scanSource(src: LogSource, address: string, topics: (string | null)[], from: number): Promise<RawLog[]> {
  if (src.unbounded) return sortLogs(await src.getLogs(address, topics, from, 'latest'));
  const latest = await src.getLatest();
  if (from > latest) return [];
  const out: RawLog[] = [];
  let span = latest - from + 1;
  let cursor = from;
  let calls = 0;
  while (cursor <= latest) {
    const windows: [number, number][] = [];
    for (let s = cursor, n = 0; s <= latest && n < (span === latest - from + 1 ? 1 : PARALLEL); s += span, n++) windows.push([s, Math.min(latest, s + span - 1)]);
    calls += windows.length;
    if (calls > MAX_CALLS) throw new Error(`${src.name}: too many log requests while scanning history.`);
    try {
      const results = await Promise.all(windows.map(([s, e]) => src.getLogs(address, topics, s, e)));
      for (const r of results) out.push(...r);
      cursor = windows[windows.length - 1][1] + 1;
    } catch (e) {
      if (span <= 1) throw e;
      span = Math.max(1, Math.floor(span / 2));
    }
  }
  return sortLogs(out);
}

/** Try each source in order; return the first complete result. Throws (with every reason) if all fail. */
export async function scanLogs(sources: LogSource[], address: string, topics: (string | null)[], from: number): Promise<RawLog[]> {
  const errors: string[] = [];
  for (const src of sources) {
    try { return await scanSource(src, address, topics, from); }
    catch (e: any) { errors.push(`${src.name}: ${e?.shortMessage || e?.message || String(e)}`); }
  }
  throw new Error(`Could not read vault event history (${errors.join(' | ')})`);
}

/**
 * Blockscout (Etherscan-compatible) logs endpoint. Used only as a fallback when the JSON-RPC nodes
 * cannot serve historical logs. The API returns at most 1,000 rows; a full page is treated as possibly
 * truncated and rejected rather than silently displaying an incomplete agent list.
 */
export function blockscoutSource(baseUrl: string, fetchImpl: typeof fetch = fetch): LogSource {
  const base = baseUrl.replace(/\/$/, '');
  const num = (v: any) => (typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : Number(v || 0));
  return {
    name: 'explorer API',
    unbounded: true,
    getLatest: async () => 0,
    getLogs: async (address, topics, from, to) => {
      const q = new URLSearchParams({ module: 'logs', action: 'getLogs', fromBlock: String(from), toBlock: String(to), address });
      topics.forEach((t, i) => { if (t) q.set(`topic${i}`, t); });
      topics.forEach((t, i) => { if (t && i > 0) q.set(`topic${i - 1}_${i}_opr`, 'and'); });
      const res = await fetchImpl(`${base}/api?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.status === '0' && /no logs found/i.test(String(body.message))) return [];
      if (!Array.isArray(body.result)) throw new Error(String(body.message || 'unexpected response'));
      if (body.result.length >= 1000) throw new Error('result may be truncated (1,000 row limit)');
      return body.result.map((l: any) => ({ blockNumber: num(l.blockNumber), index: num(l.logIndex), transactionHash: l.transactionHash, topics: l.topics.filter(Boolean), data: l.data }));
    },
  };
}
