/**
 * Spending Analytics: pure functions over data AgentGuard already reads. No network, no ethers, no React.
 *
 * Source of truth: the Activity & Security Logs entries (activityLog.buildEntries), which are decoded from the vault's own
 * on-chain events. A transfer counts as SPENT only when the vault emitted NativeTransferExecuted or TokenTransferExecuted for it,
 * which the contract does only after the transfer succeeded. Reverted calls (which the explorer reports and which emit no event)
 * are listed in the history as failed attempts and are NEVER added to any total.
 *
 * Accuracy rules:
 *  - Amounts are bigint raw units per asset. Different assets are never added together; there is no combined total.
 *  - Decimals come from the token's own decimals() read. If it could not be read, the raw units are shown and labelled; 18 is never assumed.
 *  - Owner withdrawals are the owner moving funds, not agent spending, so they are excluded.
 *  - No USD values: AgentGuard has no price source, and prices are not invented.
 *  - A transfer whose block timestamp could not be read has timestamp 0. It is counted in all-time totals but cannot be placed in
 *    a date range or on the timeline, and the UI says how many were left out.
 */
import type { LogEntry } from './activityLog';
import type { AgentHealth } from './agentHealth';
import { LIMIT_WARN_PCT } from './securityAlerts';

export type AssetKey = 'native' | string; // 'native' or a lower-case ERC-20 address
export type TokenMeta = { decimals: number | null; symbol: string | null };
export type Granularity = 'day' | 'week' | 'month';
export type Period = { from: number | null; to: number | null }; // unix seconds, both inclusive; null = unbounded

export type SpendTx = {
  key: string; hash: string; agent: string; asset: AssetKey;
  /** null only for a reverted call whose amount could not be decoded. Never null for a successful transfer. */
  amount: bigint | null;
  recipient?: string; timestamp: number; blockNumber: number; index: number;
  status: 'Success' | 'Failed';
};

const DAY = 86400;
const low = (a?: string) => (a || '').toLowerCase();

/** Agent transfers (successful) and reverted agent transfer attempts, newest first. Each log entry yields at most one row. */
export function extractSpend(entries: LogEntry[]): SpendTx[] {
  const out = new Map<string, SpendTx>();
  for (const e of entries) {
    let asset: AssetKey | null = null; let amount: bigint | null = null;
    if (e.status === 'Success') {
      if (e.type === 'Native transfer executed') asset = 'native';
      else if (e.type === 'Token transfer executed' && e.token) asset = low(e.token);
      if (!asset || e.amount === undefined || !e.agent) continue;
      amount = e.amount;
    } else {
      if (e.fn === 'executeNative') asset = 'native';
      else if (e.fn === 'executeTokenTransfer' && e.token) asset = low(e.token);
      if (!asset || !e.agent) continue;
      amount = e.amount ?? null;
    }
    if (out.has(e.key)) continue; // the same log can never be counted twice
    out.set(e.key, { key: e.key, hash: e.hash, agent: low(e.agent), asset, amount, recipient: e.recipient ? low(e.recipient) : undefined, timestamp: e.timestamp, blockNumber: e.blockNumber, index: e.index, status: e.status });
  }
  return [...out.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);
}

export type TxFilter = { period?: Period; agent?: string; asset?: AssetKey; status?: 'Success' | 'Failed' };
/** A dated range excludes undated transfers (their time is unknown); an unbounded period includes them. */
export function filterSpend(txs: SpendTx[], f: TxFilter): SpendTx[] {
  const p = f.period || { from: null, to: null }; const bounded = p.from !== null || p.to !== null;
  return txs.filter(t =>
    (!f.agent || t.agent === low(f.agent)) && (!f.asset || t.asset === f.asset) && (!f.status || t.status === f.status) &&
    (!bounded || (t.timestamp > 0 && (p.from === null || t.timestamp >= p.from) && (p.to === null || t.timestamp <= p.to))));
}

export type AssetTotal = { asset: AssetKey; amount: bigint; count: number };
export type AgentSpend = { agent: string; count: number; byAsset: AssetTotal[] };
export type Summary = { successfulCount: number; byAsset: AssetTotal[]; byAgent: AgentSpend[]; failedAttempts: number };

/** Totals over SUCCESSFUL transfers only, kept separate per asset. `failedAttempts` is informational and never added to anything. */
export function summarize(txs: SpendTx[], knownAgents: string[] = []): Summary {
  const assets = new Map<AssetKey, AssetTotal>(); const agents = new Map<string, Map<AssetKey, AssetTotal>>(); const counts = new Map<string, number>();
  let successfulCount = 0, failedAttempts = 0;
  for (const a of knownAgents) { agents.set(low(a), new Map()); counts.set(low(a), 0); }
  for (const t of txs) {
    if (t.status !== 'Success' || t.amount === null) { if (t.status === 'Failed') failedAttempts++; continue; }
    successfulCount++;
    const a = assets.get(t.asset) || { asset: t.asset, amount: 0n, count: 0 }; a.amount += t.amount; a.count++; assets.set(t.asset, a);
    const m = agents.get(t.agent) || new Map<AssetKey, AssetTotal>(); const x = m.get(t.asset) || { asset: t.asset, amount: 0n, count: 0 }; x.amount += t.amount; x.count++; m.set(t.asset, x); agents.set(t.agent, m);
    counts.set(t.agent, (counts.get(t.agent) || 0) + 1);
  }
  const byAsset = [...assets.values()].sort((a, b) => b.count - a.count || a.asset.localeCompare(b.asset));
  const byAgent = [...agents.entries()].map(([agent, m]) => ({ agent, count: counts.get(agent) || 0, byAsset: [...m.values()].sort((a, b) => b.count - a.count || a.asset.localeCompare(b.asset)) })).sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
  return { successfulCount, byAsset, byAgent, failedAttempts };
}

/** Agents ranked by amount of ONE asset (never across assets). Share is of that asset's total in the same set. */
export function rankAgents(summary: Summary, asset: AssetKey): { agent: string; amount: bigint; count: number; sharePct: number | null }[] {
  const total = summary.byAsset.find(a => a.asset === asset)?.amount ?? 0n;
  return summary.byAgent.map(a => { const x = a.byAsset.find(b => b.asset === asset); const amount = x?.amount ?? 0n; return { agent: a.agent, amount, count: x?.count ?? 0, sharePct: total > 0n ? Number((amount * 10000n) / total) / 100 : null }; })
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : b.count - a.count || a.agent.localeCompare(b.agent)));
}

/* ───────── Time series (UTC buckets) ───────── */
export type Bucket = { start: number; end: number; amount: bigint; count: number };
const monthStart = (ts: number) => { const d = new Date(ts * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };
const nextMonth = (ts: number) => { const d = new Date(ts * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; };
/** Start of the UTC day / ISO week (Monday) / month containing ts. */
export function bucketStart(ts: number, g: Granularity): number {
  const day = Math.floor(ts / DAY);
  if (g === 'day') return day * DAY;
  if (g === 'week') return (day - ((day + 3) % 7)) * DAY; // 1970-01-01 was a Thursday
  return monthStart(ts);
}
export const bucketNext = (start: number, g: Granularity) => (g === 'day' ? start + DAY : g === 'week' ? start + 7 * DAY : nextMonth(start));

/**
 * Amount of one asset per bucket, successful transfers only. Empty buckets between the first transfer (or the period start) and `now`
 * are zero, which is accurate because the whole vault history was scanned. Undated transfers cannot be placed and are counted in `undated`.
 */
export function bucketSeries(txs: SpendTx[], asset: AssetKey, g: Granularity, now: number, period: Period = { from: null, to: null }, maxBuckets = 60): { buckets: Bucket[]; undated: number; truncated: boolean } {
  const rel = txs.filter(t => t.status === 'Success' && t.amount !== null && t.asset === asset);
  const dated = rel.filter(t => t.timestamp > 0); const undated = rel.length - dated.length;
  const first = period.from ?? (dated.length ? Math.min(...dated.map(t => t.timestamp)) : null);
  if (first === null) return { buckets: [], undated, truncated: false };
  const last = Math.min(period.to ?? now, now);
  const map = new Map<number, Bucket>(); const buckets: Bucket[] = [];
  for (let s = bucketStart(first, g); s <= last; s = bucketNext(s, g)) { const b = { start: s, end: bucketNext(s, g), amount: 0n, count: 0 }; map.set(s, b); buckets.push(b); if (buckets.length > 5000) break; }
  for (const t of dated) { const b = map.get(bucketStart(t.timestamp, g)); if (b) { b.amount += t.amount as bigint; b.count++; } }
  const truncated = buckets.length > maxBuckets;
  return { buckets: truncated ? buckets.slice(-maxBuckets) : buckets, undated, truncated };
}

/* ───────── Spending limit utilisation (native, from the existing live agents() read) ───────── */
export type Utilization = { agent: string; state: 'ok' | 'warn' | 'full' | 'unavailable' | 'revoked'; spent: bigint | null; limit: bigint | null; remaining: bigint | null; pct: number | null };
/** Reuses the live `agents(address)` read already performed for Agent Health. Same UTC-day rule as Agent Health: a stored day that is not today means nothing spent today. */
export function utilization(health: AgentHealth[], now: number): Utilization[] {
  const today = Math.floor(now / DAY);
  return health.map(h => {
    const agent = low(h.address); const l = h.live;
    if (!l.ok) return { agent, state: 'unavailable' as const, spent: null, limit: null, remaining: null, pct: null };
    if (!l.registered) return { agent, state: 'revoked' as const, spent: null, limit: null, remaining: null, pct: null };
    const spent = Number(l.dayStart) === today ? l.nativeSpentToday : 0n; const limit = l.maxNativePerDay;
    const remaining = limit > spent ? limit - spent : 0n;
    const pct = limit > 0n ? Number((spent * 10000n) / limit) / 100 : null;
    const state = limit > 0n && spent >= limit ? 'full' : limit > 0n && spent * 100n >= limit * BigInt(LIMIT_WARN_PCT) ? 'warn' : 'ok';
    return { agent, state, spent, limit, remaining, pct };
  });
}

/* ───────── Formatting ───────── */
/** Exact decimal string for raw / 10^decimals, truncated (never rounded up) to `maxFrac` places, with thousands separators. */
export function formatUnitsStr(raw: bigint, decimals: number, maxFrac = 6): string {
  const neg = raw < 0n; const r = neg ? -raw : raw;
  const s = r.toString().padStart(decimals + 1, '0');
  const whole = decimals ? s.slice(0, -decimals) : s; let frac = decimals ? s.slice(-decimals) : '';
  frac = frac.slice(0, maxFrac).replace(/0+$/, '');
  if (r > 0n && whole === '0' && !frac) return `<${decimals && maxFrac ? '0.' + '0'.repeat(Math.min(maxFrac, decimals) - 1) + '1' : '1'}`;
  return `${neg ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? '.' + frac : ''}`;
}
/** Label for an amount of one asset. Unknown token decimals are never guessed: the raw units are shown and labelled. */
export function formatAsset(raw: bigint, asset: AssetKey, nativeSymbol: string, meta?: TokenMeta, maxFrac = 6): string {
  if (asset === 'native') return `${formatUnitsStr(raw, 18, maxFrac)} ${nativeSymbol}`;
  if (!meta || meta.decimals === null) return `${raw.toString()} raw units`;
  return `${formatUnitsStr(raw, meta.decimals, maxFrac)}${meta.symbol ? ' ' + meta.symbol : ''}`;
}
/** Number used only to size chart bars. Exact figures always come from formatAsset. */
export const chartValue = (raw: bigint, asset: AssetKey, meta?: TokenMeta): number => { const d = asset === 'native' ? 18 : meta?.decimals ?? 0; return Number(formatUnitsStr(raw, d, d || 1).replace(/,/g, '').replace(/^</, '')); };

export type Preset = '7d' | '30d' | '90d' | 'all' | 'custom';
export function presetPeriod(p: Exclude<Preset, 'custom'>, now: number): Period { return p === 'all' ? { from: null, to: null } : { from: bucketStart(now, 'day') - (({ '7d': 7, '30d': 30, '90d': 90 } as const)[p] - 1) * DAY, to: now }; }
/** YYYY-MM-DD (UTC) → unix seconds at 00:00:00 UTC, or null when malformed. */
export function parseDay(v: string): number | null { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return Number.isFinite(t) && new Date(t).getUTCMonth() === +m[2] - 1 ? t / 1000 : null; }
