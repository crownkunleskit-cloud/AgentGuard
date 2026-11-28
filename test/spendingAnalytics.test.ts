import assert from 'node:assert/strict';
import { buildEntries, type FailedTx, type ParsedLog } from '../app/lib/activityLog';
import { computeHealth, type LiveAgent } from '../app/lib/agentHealth';
import { bucketSeries, bucketStart, chartValue, extractSpend, filterSpend, formatAsset, formatUnitsStr, parseDay, presetPeriod, rankAgents, summarize, utilization } from '../app/lib/spendingAnalytics';

// Pure-logic tests for Spending Analytics. Real activityLog.buildEntries output feeds the real analytics code.
const DAY = 86400;
const NOW = 1_800_000_000; // 2027-01-15 08:00:00 UTC, a Friday
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), R1 = '0x' + 'd4'.repeat(20), R2 = '0x' + 'd5'.repeat(20), USDC = '0x' + 'e5'.repeat(20), DAI = '0x' + 'e6'.repeat(20);
const E18 = 10n ** 18n;
const fmt = { short: (a: string) => a.slice(0, 6), native: (n: bigint) => `${n} wei` };
let seq = 0, blk = 100;
const ev = (name: string, args: Record<string, any>, ago: number): ParsedLog => ({ name, args, blockNumber: (blk += 10), index: seq++ % 40, transactionHash: '0x' + (++seq).toString(16).padStart(64, '0'), timestamp: ago < 0 ? 0 : NOW - ago });
const nat = (agent: string, amount: bigint, ago: number, to = R1) => ev('NativeTransferExecuted', { agent, recipient: to, amount }, ago);
const tok = (agent: string, token: string, amount: bigint, ago: number, to = R1) => ev('TokenTransferExecuted', { agent, token, recipient: to, amount }, ago);
const reg = (agent: string, ago = 60 * DAY) => ev('AgentRegistered', { agent, maxNativePerTx: E18, maxNativePerDay: 3n * E18 }, ago);
const failedTx = (fn: string, from: string, ago: number, o: Partial<FailedTx> = {}): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'f'), from, blockNumber: 9000 + seq, timestamp: NOW - ago, fn, ...o });
const entries = (logs: ParsedLog[], failed: FailedTx[] = []) => buildEntries(logs, failed, fmt);
const live = (o: Partial<Extract<LiveAgent, { ok: true }>> = {}): LiveAgent => ({ ok: true, registered: true, paused: false, maxNativePerTx: E18, maxNativePerDay: 3n * E18, dayStart: BigInt(Math.floor(NOW / DAY)), nativeSpentToday: 0n, ...o });
const total = (s: ReturnType<typeof summarize>, asset: string) => s.byAsset.find(a => a.asset === asset);

describe('Spending Analytics: what counts as spending', () => {
  it('counts only successful agent transfers; reverted attempts and owner withdrawals are never spending', () => {
    const logs = [reg(A), nat(A, 2n * E18, 3 * DAY), tok(A, USDC, 5_000_000n, 2 * DAY), ev('OwnerWithdrawal', { asset: '0x' + '0'.repeat(40), recipient: R1, amount: 9n * E18 }, 1 * DAY)];
    const failed = [failedTx('executeNative', A, 1 * DAY, { recipient: R1, amount: 7n * E18 }), failedTx('executeTokenTransfer', A, 1 * DAY, { token: USDC, recipient: R1, amount: 1_000_000n }), failedTx('setRecipient', A, 1 * DAY)];
    const txs = extractSpend(entries(logs, failed));
    assert.equal(txs.filter(t => t.status === 'Success').length, 2);
    assert.equal(txs.filter(t => t.status === 'Failed').length, 2); // listed as attempts, the owner-function call is not a transfer
    const s = summarize(txs);
    assert.equal(s.successfulCount, 2); assert.equal(s.failedAttempts, 2);
    assert.equal(total(s, 'native')!.amount, 2n * E18); assert.equal(total(s, USDC)!.amount, 5_000_000n);
  });

  it('never adds different assets together: native and each token have their own total, and there is no combined figure', () => {
    const txs = extractSpend(entries([reg(A), nat(A, E18, 1 * DAY), tok(A, USDC, 1_000_000n, 1 * DAY), tok(A, DAI, 1_000_000n * E18 / 1_000_000n, 1 * DAY)]));
    const s = summarize(txs);
    assert.deepEqual(s.byAsset.map(a => a.asset).sort(), ['native', USDC, DAI].sort());
    assert.equal(s.byAsset.length, 3); assert.equal(s.successfulCount, 3);
    assert.ok(!('total' in s) && !('totalAmount' in s));
  });

  it('does not double count: duplicate log entries, or the same reverted tx reported twice, appear once', () => {
    const n1 = nat(A, E18, 1 * DAY); const f = failedTx('executeNative', A, 1 * DAY, { recipient: R1, amount: E18 });
    const txs = extractSpend(entries([reg(A), n1, n1], [f, f]));
    assert.equal(txs.filter(t => t.status === 'Success').length, 1); assert.equal(txs.filter(t => t.status === 'Failed').length, 1);
    assert.equal(summarize(txs).byAsset[0].amount, E18);
  });

  it('associates every transfer with the right agent, and an agent\'s totals never include another agent\'s transfers', () => {
    const s = summarize(extractSpend(entries([reg(A), reg(B), nat(A, E18, 1 * DAY), nat(A, E18, 2 * DAY), nat(B, 5n * E18, 3 * DAY), tok(B, USDC, 10n, 3 * DAY)])), [A, B]);
    const a = s.byAgent.find(x => x.agent === A)!, b = s.byAgent.find(x => x.agent === B)!;
    assert.equal(a.count, 2); assert.equal(a.byAsset.length, 1); assert.equal(a.byAsset[0].amount, 2n * E18);
    assert.equal(b.count, 2); assert.equal(b.byAsset.find(x => x.asset === 'native')!.amount, 5n * E18); assert.equal(b.byAsset.find(x => x.asset === USDC)!.amount, 10n);
    assert.equal(total(s, 'native')!.amount, a.byAsset[0].amount + b.byAsset.find(x => x.asset === 'native')!.amount); // parts add up to the whole, per asset
  });

  it('a registered agent with no spending is still listed with zero, and a revoked agent\'s past spending is kept', () => {
    const s = summarize(extractSpend(entries([reg(A), reg(B), nat(B, E18, 5 * DAY), ev('AgentRevoked', { agent: B }, 4 * DAY)])), [A]);
    assert.equal(s.byAgent.find(x => x.agent === A)!.count, 0); assert.equal(s.byAgent.find(x => x.agent === B)!.count, 1);
  });

  it('a failed token attempt is attributed to the token it targeted; one with undecodable amount has a null amount and no effect on totals', () => {
    const txs = extractSpend(entries([reg(A)], [failedTx('executeTokenTransfer', A, DAY, { token: USDC, recipient: R1 })]));
    assert.equal(txs[0].asset, USDC); assert.equal(txs[0].amount, null); assert.equal(summarize(txs).byAsset.length, 0);
  });
});

describe('Spending Analytics: amounts and decimals', () => {
  it('formats native (18) and token decimals exactly, without rounding up', () => {
    assert.equal(formatUnitsStr(E18, 18), '1'); assert.equal(formatUnitsStr(15n * E18 / 10n, 18), '1.5');
    assert.equal(formatUnitsStr(1234567890n, 6), '1,234.56789'); assert.equal(formatUnitsStr(1999999999999999999n, 18), '1.999999');
    assert.equal(formatUnitsStr(5n, 0), '5'); assert.equal(formatUnitsStr(1_000_000_000n * E18, 18), '1,000,000,000');
    assert.equal(formatUnitsStr(1n, 18), '<0.000001'); assert.equal(formatUnitsStr(0n, 18), '0');
  });
  it('shows raw units, never an assumed 18 decimals, when a token\'s decimals could not be read', () => {
    assert.equal(formatAsset(1_000_000n, USDC, 'ETH', { decimals: null, symbol: null }), '1000000 raw units');
    assert.equal(formatAsset(1_000_000n, USDC, 'ETH', undefined), '1000000 raw units');
    assert.equal(formatAsset(1_500_000n, USDC, 'ETH', { decimals: 6, symbol: 'USDC' }), '1.5 USDC');
    assert.equal(formatAsset(1_000_000n * E18, DAI, 'ETH', { decimals: 18, symbol: null }), '1,000,000');
    assert.equal(formatAsset(E18 / 4n, 'native', 'ETH'), '0.25 ETH');
  });
  it('chart values use the same decimals as the displayed amounts', () => {
    assert.equal(chartValue(3n * E18 / 2n, 'native'), 1.5); assert.equal(chartValue(2_500_000n, USDC, { decimals: 6, symbol: 'USDC' }), 2.5); assert.equal(chartValue(7n, USDC, undefined), 7);
  });
});

describe('Spending Analytics: filters', () => {
  const txs = extractSpend(entries([reg(A), reg(B), nat(A, E18, 1 * DAY), nat(A, 2n * E18, 10 * DAY), nat(B, 4n * E18, 40 * DAY), tok(A, USDC, 7n, 2 * DAY), nat(B, 9n * E18, -1)], [failedTx('executeNative', A, 1 * DAY, { recipient: R1, amount: E18 })]));
  it('filters by agent, asset and status', () => {
    assert.ok(filterSpend(txs, { agent: A }).every(t => t.agent === A)); assert.ok(filterSpend(txs, { asset: USDC }).every(t => t.asset === USDC));
    assert.equal(filterSpend(txs, { status: 'Failed' }).length, 1); assert.equal(filterSpend(txs, { agent: A, asset: 'native', status: 'Success' }).length, 2);
  });
  it('a date range includes only transfers inside it, and excludes undated transfers (their time is unknown)', () => {
    const p = presetPeriod('7d', NOW); const inRange = filterSpend(txs, { period: p, status: 'Success' });
    assert.deepEqual(inRange.map(t => t.amount).sort(), [1n * E18, 7n].sort()); assert.ok(inRange.every(t => t.timestamp > 0));
    assert.equal(summarize(filterSpend(txs, { period: presetPeriod('30d', NOW) })).successfulCount, 3);
    const all = filterSpend(txs, { period: presetPeriod('all', NOW), status: 'Success' }); assert.equal(all.length, 5); assert.ok(all.some(t => t.timestamp === 0));
  });
  it('custom day parsing is strict UTC', () => {
    assert.equal(parseDay('2027-01-15'), Date.UTC(2027, 0, 15) / 1000); assert.equal(parseDay('2027-02-30'), null); assert.equal(parseDay('15/01/2027'), null); assert.equal(parseDay(''), null);
    const p = { from: parseDay('2027-01-04')!, to: parseDay('2027-01-05')! + DAY - 1 }; assert.equal(filterSpend(txs, { period: p, status: 'Success' }).length, 1); // the 10-days-ago transfer
  });
});

describe('Spending Analytics: ranking and time series', () => {
  it('ranks agents by amount of one asset with correct shares, never mixing assets', () => {
    const s = summarize(extractSpend(entries([reg(A), reg(B), nat(A, E18, DAY), nat(B, 3n * E18, DAY), tok(A, USDC, 100n, DAY)])), [A, B]);
    const r = rankAgents(s, 'native'); assert.deepEqual(r.map(x => x.agent), [B, A]); assert.deepEqual(r.map(x => x.sharePct), [75, 25]);
    const u = rankAgents(s, USDC); assert.equal(u[0].agent, A); assert.equal(u[0].sharePct, 100); assert.equal(u[1].sharePct, 0);
    assert.equal(rankAgents(s, DAI)[0].sharePct, null); // no spending in that asset: no share to show
  });
  it('daily buckets: correct amounts and counts, empty days are zero, failed/other-asset/undated are not plotted', () => {
    const txs = extractSpend(entries([reg(A), nat(A, E18, 0.2 * DAY), nat(A, 2n * E18, 0.3 * DAY), nat(A, 4n * E18, 2.5 * DAY), tok(A, USDC, 99n, 0.2 * DAY), nat(A, 50n * E18, -1)], [failedTx('executeNative', A, 0.1 * DAY, { recipient: R1, amount: 8n * E18 })]));
    const s = bucketSeries(txs, 'native', 'day', NOW, presetPeriod('7d', NOW));
    assert.equal(s.buckets.length, 7); assert.equal(s.undated, 1);
    const sum = s.buckets.reduce((x, b) => x + b.amount, 0n); assert.equal(sum, 7n * E18); assert.equal(s.buckets.reduce((x, b) => x + b.count, 0), 3);
    assert.equal(s.buckets[s.buckets.length - 1].amount, 3n * E18); assert.equal(s.buckets.filter(b => b.count === 0).length, 5);
  });
  it('weekly buckets start on Monday (UTC) and monthly on the 1st; bucket totals equal the period total', () => {
    const logs = [reg(A), ...[1, 3, 8, 15, 22, 40, 45].map((d, i) => nat(A, BigInt(i + 1) * E18, d * DAY))];
    const txs = extractSpend(entries(logs)); const all = summarize(txs).byAsset[0].amount;
    const w = bucketSeries(txs, 'native', 'week', NOW); const m = bucketSeries(txs, 'native', 'month', NOW);
    for (const b of w.buckets) assert.equal(new Date(b.start * 1000).getUTCDay(), 1);
    for (const b of m.buckets) assert.equal(new Date(b.start * 1000).getUTCDate(), 1);
    assert.equal(w.buckets.reduce((x, b) => x + b.amount, 0n), all); assert.equal(m.buckets.reduce((x, b) => x + b.amount, 0n), all);
    assert.equal(bucketStart(Date.UTC(2027, 0, 17) / 1000, 'week'), Date.UTC(2027, 0, 11) / 1000 + 0); // Sunday 17 Jan belongs to the week starting Mon 11 Jan
  });
  it('a long history is truncated to the most recent buckets and says so', () => {
    const txs = extractSpend(entries([reg(A), nat(A, E18, 200 * DAY), nat(A, E18, 1 * DAY)]));
    const s = bucketSeries(txs, 'native', 'day', NOW, { from: null, to: null }, 60); assert.equal(s.buckets.length, 60); assert.equal(s.truncated, true);
  });
  it('no transfers means no buckets (an empty state), not made-up zeros', () => { assert.deepEqual(bucketSeries([], 'native', 'day', NOW).buckets, []); });
});

describe('Spending Analytics: limit utilisation', () => {
  const h = (m: Map<string, LiveAgent>) => computeHealth({ entries: entries([...m.keys()].map(a => reg(a))), failedState: 'complete', live: m, globalPaused: false, knownAgents: [...m.keys()], now: NOW }).agents;
  it('matches the contract\'s configured limit and spent amount, with remaining allowance and 80% / 100% indicators', () => {
    const u = utilization(h(new Map([[A, live({ nativeSpentToday: E18 })], [B, live({ nativeSpentToday: 25n * E18 / 10n })]])), NOW);
    const a = u.find(x => x.agent === A)!, b = u.find(x => x.agent === B)!;
    assert.equal(a.limit, 3n * E18); assert.equal(a.spent, E18); assert.equal(a.remaining, 2n * E18); assert.equal(a.state, 'ok'); assert.ok(Math.abs(a.pct! - 33.33) < 0.01);
    assert.equal(b.state, 'warn'); assert.equal(utilization(h(new Map([[A, live({ nativeSpentToday: 3n * E18 })]])), NOW)[0].state, 'full');
    assert.equal(utilization(h(new Map([[A, live({ nativeSpentToday: 3n * E18 })]])), NOW)[0].remaining, 0n);
  });
  it('a stale stored day means nothing spent today; a failed read is unavailable; a revoked agent has no allowance', () => {
    const u = utilization(h(new Map<string, LiveAgent>([[A, live({ dayStart: BigInt(Math.floor(NOW / DAY) - 1), nativeSpentToday: 3n * E18 })], [B, { ok: false, error: 'rpc' }]])), NOW);
    const ua = u.find(x => x.agent === A)!, ub = u.find(x => x.agent === B)!;
    assert.equal(ua.spent, 0n); assert.equal(ua.state, 'ok'); assert.equal(ub.state, 'unavailable'); assert.equal(ub.limit, null);
    assert.equal(utilization(h(new Map([[A, live({ registered: false })]])), NOW)[0].state, 'revoked');
  });
});

describe('Spending Analytics: failure and edge cases never throw', () => {
  it('empty history, and entries with no transfers, give empty results', () => {
    assert.deepEqual(extractSpend([]), []); const s = summarize([]); assert.equal(s.successfulCount, 0); assert.deepEqual(s.byAsset, []); assert.deepEqual(s.byAgent, []);
    assert.deepEqual(extractSpend(entries([reg(A)])), []);
  });
  it('does not mutate its inputs', () => {
    const e = entries([reg(A), nat(A, E18, DAY)]); const before = JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const t = extractSpend(e); summarize(t); bucketSeries(t, 'native', 'day', NOW); filterSpend(t, { agent: A });
    assert.equal(JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
  });
});
