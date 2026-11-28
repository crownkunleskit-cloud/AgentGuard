import assert from 'node:assert/strict';
import { buildEntries, type FailedTx, type ParsedLog } from '../app/lib/activityLog';
import { computeHealth, type FailedDataState, type LiveAgent } from '../app/lib/agentHealth';
import { computeRisk } from '../app/lib/agentRisk';
import { ALERT_DAYS, computeAlerts, loadRead, readKey, saveRead, type KeyValueStore } from '../app/lib/securityAlerts';

// Pure-logic tests for Security Alerts. Real activityLog.buildEntries output goes through the real Health and Risk code.
const DAY = 86400;
const NOW = 1_800_000_000;
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), RCPT = '0x' + 'd4'.repeat(20), BAD = '0x' + 'ee'.repeat(20), BAD2 = '0x' + 'ef'.repeat(20);
const fmt = { short: (a: string) => a.slice(0, 6), native: (n: bigint) => `${n} wei` };
let seq = 0, blk = 100;
const ev = (name: string, args: Record<string, any>, ago: number): ParsedLog => ({ name, args, blockNumber: (blk += 10), index: seq++ % 40, transactionHash: '0x' + (++seq).toString(16).padStart(64, '0'), timestamp: ago < 0 ? 0 : NOW - ago });
const reg = (agent = A, ago = 40 * DAY) => ev('AgentRegistered', { agent, maxNativePerTx: 100n, maxNativePerDay: 1000n }, ago);
const allow = (r = RCPT) => ev('RecipientPermissionChanged', { recipient: r, allowed: true }, 39 * DAY);
const sent = (ago: number, agent = A) => ev('NativeTransferExecuted', { agent, recipient: RCPT, amount: 10n }, ago);
const revert = (ago: number, to: string, amount = 10n, block = 9000 + seq, from = A): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'f'), from, blockNumber: block, timestamp: NOW - ago, fn: 'executeNative', recipient: to, amount });
const adminRevert = (ago: number, block: number): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'e'), from: A, blockNumber: block, timestamp: NOW - ago, fn: 'setRecipient' });
const live = (o: Partial<Extract<LiveAgent, { ok: true }>> = {}): LiveAgent => ({ ok: true, registered: true, paused: false, maxNativePerTx: 100n, maxNativePerDay: 1000n, dayStart: BigInt(Math.floor(NOW / DAY)), nativeSpentToday: 0n, ...o });

function run(logs: ParsedLog[], failed: FailedTx[] = [], o: { liveMap?: Map<string, LiveAgent>; failedState?: FailedDataState; entriesNull?: boolean; now?: number } = {}) {
  const now = o.now ?? NOW;
  const entries = o.entriesNull ? null : buildEntries(logs, failed, fmt);
  const failedState = o.failedState ?? 'complete';
  const liveMap = o.liveMap ?? new Map<string, LiveAgent>([[A, live()]]);
  const health = computeHealth({ entries, failedState, live: liveMap, globalPaused: false, knownAgents: [...liveMap.keys()], now });
  const risk = computeRisk(health.agents, entries, { now, failedState, short: fmt.short, native: fmt.native });
  return computeAlerts({ health: health.agents, risks: risk.agents, entries, failedState, now, short: fmt.short, native: fmt.native });
}
const steady = () => [reg(), allow(), ...Array.from({ length: 6 }, (_, i) => sent((i + 1.5) * DAY))];
const ofType = (r: ReturnType<typeof run>, t: string) => r.alerts.filter(a => a.type === t);

describe('Security Alerts', () => {
  it('a healthy agent with normal activity raises no alerts', () => {
    const r = run(steady());
    assert.deepEqual(r.alerts, []); assert.deepEqual(r.notes, []);
  });

  it('Unauthorized recipient: one High alert per reverted attempt, with agent, tx hash and timestamp', () => {
    const f1 = revert(2 * DAY, BAD, 10n, 9001), f2 = revert(1 * DAY, BAD2, 10n, 9002);
    const r = run(steady(), [f1, f2]);
    const al = ofType(r, 'Unauthorized recipient');
    assert.equal(al.length, 2);
    for (const a of al) { assert.equal(a.severity, 'High'); assert.equal(a.agent, A); assert.ok(a.hash && a.timestamp > 0); }
    assert.deepEqual(al.map(a => a.hash).sort(), [f1.hash, f2.hash].sort());
    // those reverted calls are explained by the specific alert, so they are not repeated as generic security events
    assert.equal(ofType(r, 'Security event').length, 0);
  });

  it('approved recipient reverts (e.g. an unrelated failure) are not reported as unauthorized-recipient attempts', () => {
    const r = run(steady(), [revert(1 * DAY, RCPT, 10n, 9001)]);
    assert.equal(ofType(r, 'Unauthorized recipient').length, 0);
  });

  it('is de-duplicated: recomputing, or feeding duplicate entries, never changes the alert ids', () => {
    const logs = steady(); const failed = [revert(1 * DAY, BAD, 10n, 9001)];
    const one = run(logs, failed).alerts.map(a => a.id);
    const two = run(logs, failed).alerts.map(a => a.id);
    assert.deepEqual(one, two); assert.equal(new Set(one).size, one.length);
    // the same revert reported twice by the explorer produces one alert
    const dup = run(logs, [failed[0], failed[0]]).alerts.map(a => a.id);
    assert.deepEqual(dup, one);
  });

  it('a NEW occurrence raises a new alert; the old one keeps its id (so its read state survives)', () => {
    const logs = steady(); const f1 = revert(3 * DAY, BAD, 10n, 9001);
    const before = run(logs, [f1]).alerts.map(a => a.id);
    const after = run(logs, [f1, revert(1 * DAY, BAD2, 10n, 9002)]).alerts.map(a => a.id);
    for (const id of before) assert.ok(after.includes(id));
    assert.ok(after.length > before.length);
  });

  it('Unusual agent activity: a transfer above the per-transaction limit is a Medium confirmed finding', () => {
    const r = run(steady(), [revert(1 * DAY, RCPT, 500n, 9001)]);
    const u = ofType(r, 'Unusual agent activity');
    assert.equal(u.length, 1); assert.equal(u[0].severity, 'Medium'); assert.equal(u[0].agent, A);
    assert.ok(/Confirmed from on-chain data/.test(u[0].description));
  });

  it('High-risk: an agent scoring 60+ raises a High-risk alert in addition to its individual alerts', () => {
    const r = run(steady(), [revert(1 * DAY, BAD, 10n, 9001), revert(1.2 * DAY, BAD2, 10n, 9002), revert(1.4 * DAY, BAD, 10n, 9003), adminRevert(1.5 * DAY, 9004)]);
    const hr = ofType(r, 'High risk');
    assert.equal(hr.length, 1); assert.equal(hr[0].agent, A); assert.ok(['High', 'Critical'].includes(hr[0].severity));
    assert.equal(ofType(r, 'Unauthorized recipient').length, 3);
    assert.equal(ofType(r, 'Unusual agent activity').length, 1); // the owner-only call attempt
  });

  it('Spending limit: nothing below 80%, Medium at 80%, High at 100% (a single alert at 100), none for a stale day', () => {
    const at = (spent: bigint, dayOffset = 0) => run(steady(), [], { liveMap: new Map([[A, live({ nativeSpentToday: spent, dayStart: BigInt(Math.floor(NOW / DAY) - dayOffset) })]]) });
    assert.equal(ofType(at(799n), 'Spending limit').length, 0);
    const w = ofType(at(800n), 'Spending limit'); assert.equal(w.length, 1); assert.equal(w[0].severity, 'Medium');
    const f = ofType(at(1000n), 'Spending limit'); assert.equal(f.length, 1); assert.equal(f[0].severity, 'High'); assert.ok(/reached/.test(f[0].title));
    assert.equal(ofType(at(1000n, 1), 'Spending limit').length, 0);
    assert.notEqual(w[0].id, f[0].id);
  });

  it('Spending limit: one alert per agent per day and threshold, and a failed live read raises none', () => {
    const a1 = run(steady(), [], { liveMap: new Map([[A, live({ nativeSpentToday: 900n })]]) }).alerts[0].id;
    const a2 = run(steady(), [], { liveMap: new Map([[A, live({ nativeSpentToday: 950n })]]) }).alerts[0].id;
    assert.equal(a1, a2);
    const bad = run(steady(), [], { liveMap: new Map<string, LiveAgent>([[A, { ok: false, error: 'rpc' }]]) });
    assert.equal(ofType(bad, 'Spending limit').length, 0);
  });

  it('Agent status: paused, resumed and revoked events become alerts with the right severity', () => {
    const logs = [...steady(), ev('AgentStatusChanged', { agent: A, paused: true }, 3 * DAY), ev('AgentStatusChanged', { agent: A, paused: false }, 2.5 * DAY), ev('AgentRevoked', { agent: A }, 1 * DAY)];
    const r = run(logs, [], { liveMap: new Map([[A, live({ registered: false })]]) });
    const st = ofType(r, 'Agent status');
    assert.deepEqual(st.map(a => a.title).sort(), ['Agent paused', 'Agent resumed', 'Agent revoked']);
    assert.equal(st.find(a => a.title === 'Agent revoked')!.severity, 'High');
    assert.equal(st.find(a => a.title === 'Agent paused')!.severity, 'Medium');
  });

  it('Agent status: an agent with no activity for 7+ days raises a Low "inactive" alert that says it is not a security problem', () => {
    const r = run([reg(A, 30 * DAY), allow(), sent(20 * DAY)]);
    const i = ofType(r, 'Agent status');
    assert.equal(i.length, 1); assert.equal(i[0].severity, 'Low'); assert.ok(/not a security problem/.test(i[0].description));
  });

  it('Security events: Emergency Pause is Critical; permission changes and owner withdrawals are surfaced', () => {
    const logs = [...steady(), ev('GlobalPauseChanged', { paused: true }, 1 * DAY), ev('RecipientPermissionChanged', { recipient: BAD, allowed: true }, 2 * DAY), ev('OwnerWithdrawal', { asset: '0x' + '0'.repeat(40), recipient: RCPT, amount: 5n }, 3 * DAY)];
    const sec = ofType(run(logs), 'Security event');
    assert.equal(sec.find(a => a.title === 'Emergency pause enabled')!.severity, 'Critical');
    assert.ok(sec.some(a => a.title === 'Recipient added' && a.severity === 'Low'));
    assert.ok(sec.some(a => a.title === 'Owner withdrawal' && a.severity === 'Medium'));
  });

  it('Security events: a reverted call not explained by a specific alert is shown once as a security event', () => {
    const r = run(steady(), [adminRevert(1 * DAY, 9001)].map(f => ({ ...f, fn: 'unknownFn' })));
    const sec = ofType(r, 'Security event');
    assert.equal(sec.length, 1); assert.equal(sec[0].title, 'Failed transaction');
  });

  it('only the last 30 days produce alerts; undated events are left out and reported in a note', () => {
    const old = [...steady(), ev('GlobalPauseChanged', { paused: true }, (ALERT_DAYS + 5) * DAY), ev('AgentStatusChanged', { agent: A, paused: true }, -1)];
    const r = run(old);
    assert.equal(ofType(r, 'Security event').length, 0); assert.equal(ofType(r, 'Agent status').length, 0);
    assert.ok(r.notes.some(n => /no readable block timestamp/.test(n)));
  });

  it('unreadable data produces notes, never alerts and never an all-clear claim', () => {
    const noHistory = run(steady(), [], { entriesNull: true });
    assert.ok(noHistory.notes.some(n => /could not be read/.test(n) && /not an all-clear/.test(n)));
    const noExplorer = run(steady(), [revert(1 * DAY, BAD, 10n, 9001)], { failedState: 'unavailable' });
    assert.equal(ofType(noExplorer, 'Unauthorized recipient').length, 0);
    assert.ok(noExplorer.notes.some(n => /Reverted transactions could not be loaded/.test(n)));
    const partial = run(steady(), [], { failedState: 'partial' });
    assert.ok(partial.notes.some(n => /most recent reverted/.test(n)));
  });

  it('alerts for one agent never name another agent, and each agent is alerted separately', () => {
    const logs = [...steady(), reg(B), ...Array.from({ length: 6 }, (_, i) => sent((i + 1.5) * DAY, B))];
    const r = run(logs, [revert(1 * DAY, BAD, 10n, 9001, B)], { liveMap: new Map([[A, live()], [B, live({ nativeSpentToday: 1000n })]]) });
    for (const a of ofType(r, 'Unauthorized recipient')) assert.equal(a.agent, B);
    assert.ok(ofType(r, 'Spending limit').every(a => a.agent === B));
    assert.equal(r.alerts.filter(a => a.agent === A).length, 0);
  });

  it('alerts are sorted newest first', () => {
    const r = run(steady(), [revert(1 * DAY, BAD, 10n, 9001), revert(4 * DAY, BAD2, 10n, 9002)], { liveMap: new Map([[A, live({ nativeSpentToday: 900n })]]) });
    for (let i = 1; i < r.alerts.length; i++) assert.ok(r.alerts[i - 1].timestamp >= r.alerts[i].timestamp);
  });
});

describe('Security Alerts read state', () => {
  const mem = (): KeyValueStore & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } }; };
  it('round-trips read ids per chain and vault, and different vaults never share state', () => {
    const s = mem(); const k1 = readKey(4663, '0xABC'), k2 = readKey(4663, '0xdef');
    assert.equal(k1, readKey(4663, '0xabc'));
    assert.ok(saveRead(s, k1, new Set(['a', 'b'])));
    assert.deepEqual([...loadRead(s, k1)].sort(), ['a', 'b']); assert.equal(loadRead(s, k2).size, 0);
    assert.notEqual(readKey(4663, '0xabc'), readKey(46630, '0xabc'));
  });
  it('corrupt, missing or throwing storage never throws: everything simply shows as unread', () => {
    const s = mem(); s.setItem('k', '{not json'); assert.equal(loadRead(s, 'k').size, 0);
    s.setItem('k', '{"a":1}'); assert.equal(loadRead(s, 'k').size, 0);
    assert.equal(loadRead(null, 'k').size, 0); assert.equal(saveRead(null, 'k', new Set(['x'])), false);
    const boom: KeyValueStore = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    assert.equal(loadRead(boom, 'k').size, 0); assert.equal(saveRead(boom, 'k', new Set(['x'])), false);
  });
  it('read state survives a refresh because alert ids are stable', () => {
    const s = mem(); const key = readKey(4663, '0xv'); const logs = steady(); const f = [revert(1 * DAY, BAD, 10n, 9001)];
    const first = run(logs, f).alerts; saveRead(s, key, new Set([first[0].id]));
    const again = run(logs, f).alerts; const read = loadRead(s, key);
    assert.equal(again.filter(a => !read.has(a.id)).length, first.length - 1);
  });
});
