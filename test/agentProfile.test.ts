import assert from 'node:assert/strict';
import { buildEntries, type FailedTx, type ParsedLog } from '../app/lib/activityLog';
import { computeHealth, type LiveAgent } from '../app/lib/agentHealth';
import { computeRisk } from '../app/lib/agentRisk';
import { computeAgentProfile, computeProfiles, type ProfileContext } from '../app/lib/agentProfile';

// Pure-logic tests for Agent Security Profiles. Real activityLog.buildEntries output is fed into the real Health and Risk code.
const DAY = 86400;
const NOW = 1_800_000_000;
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c9'.repeat(20);
const OWNER = '0x' + 'c3'.repeat(20), VAULT = '0x' + 'f7'.repeat(20), RCPT = '0x' + 'd4'.repeat(20), RCPT2 = '0x' + 'd5'.repeat(20), TOKEN = '0x' + 'e5'.repeat(20);
const fmt = { short: (a: string) => a.slice(0, 6), native: (n: bigint) => `${n} wei` };
let seq = 0, blk = 100;
const ev = (name: string, args: Record<string, any>, ago: number): ParsedLog => ({ name, args, blockNumber: (blk += 10), index: seq++ % 40, transactionHash: '0x' + (++seq).toString(16).padStart(64, '0'), timestamp: ago < 0 ? 0 : NOW - ago });
const reg = (agent: string, ago = 30 * DAY) => ev('AgentRegistered', { agent, maxNativePerTx: 10n, maxNativePerDay: 100n }, ago);
const sent = (agent: string, ago: number, to = RCPT) => ev('NativeTransferExecuted', { agent, recipient: to, amount: 5n }, ago);
const revertTx = (from: string, ago: number, to: string, block: number): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'f'), from, blockNumber: block, timestamp: NOW - ago, fn: 'executeNative', recipient: to, amount: 5n });
const live = (o: Partial<Extract<LiveAgent, { ok: true }>> = {}): LiveAgent => ({ ok: true, registered: true, paused: false, maxNativePerTx: 10n, maxNativePerDay: 100n, dayStart: BigInt(Math.floor(NOW / DAY)), nativeSpentToday: 25n, ...o });

type Over = { live?: Map<string, LiveAgent>; globalPaused?: boolean | null; entriesNull?: boolean; failedState?: 'complete' | 'partial' | 'unavailable'; permissions?: ProfileContext['permissions'] };
function build(logs: ParsedLog[], failed: FailedTx[], o: Over = {}) {
  const entries = o.entriesNull ? null : buildEntries(logs, failed, fmt);
  const failedState = o.failedState ?? 'complete';
  const liveMap = o.live ?? new Map<string, LiveAgent>([[A, live()], [B, live({ nativeSpentToday: 0n })]]);
  const globalPaused = o.globalPaused === undefined ? false : o.globalPaused;
  const health = computeHealth({ entries, failedState, live: liveMap, globalPaused, knownAgents: [...liveMap.keys()], now: NOW });
  const risk = computeRisk(health.agents, entries, { now: NOW, failedState, short: fmt.short, native: fmt.native });
  const ctx: ProfileContext = { vault: VAULT, owner: OWNER, chainId: 4663, networkName: 'MAINNET', explorer: 'https://x', permissions: o.permissions === undefined ? { recipients: [RCPT], tokens: [{ address: TOKEN, maxPerTx: 5n, maxPerDay: 9n }] } : o.permissions, globalPaused, entries, now: NOW };
  return computeProfiles(health.agents, risk.agents, ctx);
}
const by = (ps: ReturnType<typeof build>, a: string) => ps.find(p => p.address === a)!;

describe('Agent Security Profiles', () => {
  it('builds one profile per agent with identity, configuration and the vault/network context', () => {
    const regA = reg(A);
    const ps = build([regA, reg(B, 20 * DAY), sent(A, 2 * DAY)], []);
    assert.equal(ps.length, 2);
    const p = by(ps, A);
    assert.equal(p.identity.registration, 'Registered');
    assert.equal(p.identity.registeredAt, regA.timestamp); assert.equal(p.identity.registeredTx, regA.transactionHash);
    assert.equal(p.identity.vault, VAULT); assert.equal(p.identity.owner, OWNER);
    assert.deepEqual(p.identity.network, { name: 'MAINNET', chainId: 4663, explorer: 'https://x' });
    assert.equal(p.identity.name, null);
    assert.equal(p.security.status, 'Active');
    assert.equal(p.security.maxNativePerTx, 10n); assert.equal(p.security.maxNativePerDay, 100n);
    assert.equal(p.security.nativeSpentToday, 25n); assert.equal(p.security.nativeRemainingToday, 75n);
    assert.deepEqual(p.security.recipients, [RCPT]); assert.equal(p.security.tokens?.[0].address, TOKEN);
  });

  it('reuses the Health and Risk results unchanged', () => {
    const logs = [reg(A), sent(A, 2 * DAY)];
    const entries = buildEntries(logs, [], fmt);
    const live2 = new Map<string, LiveAgent>([[A, live()]]);
    const h = computeHealth({ entries, failedState: 'complete', live: live2, globalPaused: false, knownAgents: [A], now: NOW });
    const r = computeRisk(h.agents, entries, { now: NOW, failedState: 'complete', short: fmt.short, native: fmt.native });
    const p = computeAgentProfile(h.agents[0], r.agents[0], { vault: VAULT, owner: OWNER, chainId: 4663, networkName: 'MAINNET', explorer: 'x', permissions: null, globalPaused: false, entries, now: NOW });
    assert.strictEqual(p.health, h.agents[0]); assert.strictEqual(p.risk, r.agents[0]);
  });

  it('never shows one agent\'s activity, events or risk in another agent\'s profile', () => {
    const ps = build([reg(A), reg(B, 20 * DAY), sent(A, 1 * DAY), sent(A, 2 * DAY), sent(B, 3 * DAY, RCPT2)], [revertTx(B, 1 * DAY, '0x' + 'ee'.repeat(20), 9000)]);
    const pa = by(ps, A), pb = by(ps, B);
    for (const e of pa.history.transactions) assert.equal((e.agent || '').toLowerCase(), A);
    for (const e of pb.history.transactions) assert.equal((e.agent || '').toLowerCase(), B);
    assert.equal(pa.history.transactions.length, 2); assert.equal(pb.history.transactions.length, 2); // B: 1 transfer + 1 reverted attempt
    assert.equal(pa.history.failed.length, 0); assert.equal(pb.history.failed.length, 1);
    assert.ok(pa.history.management.every(e => (e.agent || '').toLowerCase() === A));
    assert.ok(pb.history.management.every(e => (e.agent || '').toLowerCase() === B));
    assert.equal(pa.risk.address, A); assert.equal(pb.risk.address, B);
    assert.equal(pa.health.address, A); assert.equal(pb.health.address, B);
  });

  it('lists registration and management events for the agent only, newest first', () => {
    const logs = [reg(A), ev('AgentLimitsChanged', { agent: A, maxNativePerTx: 20n, maxNativePerDay: 200n }, 10 * DAY), ev('AgentStatusChanged', { agent: A, paused: true }, 5 * DAY), ev('AgentLimitsChanged', { agent: B, maxNativePerTx: 1n, maxNativePerDay: 2n }, 4 * DAY), reg(B, 20 * DAY)];
    const p = by(build(logs, []), A);
    assert.deepEqual(p.history.management.map(e => e.type), ['Agent paused', 'Spending limits changed', 'Agent registered']);
  });

  it('includes vault-wide Emergency Pause changes in security events and keeps transfers out of management', () => {
    const logs = [reg(A), sent(A, 3 * DAY), ev('GlobalPauseChanged', { paused: true }, 2 * DAY)];
    const p = by(build(logs, [], { live: new Map([[A, live()]]), globalPaused: true }), A);
    assert.ok(p.history.securityEvents.some(e => e.type === 'Emergency pause enabled'));
    assert.ok(p.history.management.every(e => e.type !== 'Native transfer executed'));
    assert.equal(p.security.status, 'Blocked by emergency pause'); assert.equal(p.security.globalPaused, true);
    assert.equal(p.security.permissions.find(x => x.id === 'native')!.status, 'Blocked');
  });

  it('paused agent: status Paused and transfers Blocked', () => {
    const p = by(build([reg(A)], [], { live: new Map([[A, live({ paused: true })]]) }), A);
    assert.equal(p.security.status, 'Paused'); assert.equal(p.security.agentPaused, true);
    assert.equal(p.security.permissions.find(x => x.id === 'native')!.status, 'Blocked');
    assert.equal(p.security.permissions.find(x => x.id === 'erc20')!.status, 'Blocked');
  });

  it('revoked agent: no limits are shown, permissions are Not allowed, revocation is recorded', () => {
    const regA = reg(A); const rev = ev('AgentRevoked', { agent: A }, 3 * DAY); // created after the registration, so it has the later block
    const p = by(build([regA, rev], [], { live: new Map([[A, live({ registered: false })]]) }), A);
    assert.equal(p.security.status, 'Revoked'); assert.equal(p.identity.registration, 'Revoked');
    assert.equal(p.security.maxNativePerTx, null); assert.equal(p.security.nativeSpentToday, null); assert.equal(p.security.nativeRemainingToday, null);
    assert.equal(p.identity.revokedTx, rev.transactionHash); assert.equal(p.identity.revokedAt, rev.timestamp);
    assert.equal(p.security.permissions.find(x => x.id === 'native')!.status, 'Not allowed');
  });

  it('spent today is 0 when the stored day is not today, and remaining never goes negative', () => {
    const stale = by(build([reg(A)], [], { live: new Map([[A, live({ dayStart: BigInt(Math.floor(NOW / DAY) - 1), nativeSpentToday: 99n })]]) }), A);
    assert.equal(stale.security.nativeSpentToday, 0n); assert.equal(stale.security.nativeRemainingToday, 100n);
    const over = by(build([reg(A)], [], { live: new Map([[A, live({ nativeSpentToday: 150n })]]) }), A);
    assert.equal(over.security.nativeRemainingToday, 0n);
  });

  it('a failed live read is Unavailable, never "not registered", paused or zero', () => {
    const p = by(build([reg(A)], [], { live: new Map<string, LiveAgent>([[A, { ok: false, error: 'rpc down' }]]) }), A);
    assert.equal(p.security.status, 'Unavailable'); assert.equal(p.identity.registration, 'Unknown');
    assert.equal(p.security.agentPaused, null); assert.equal(p.security.maxNativePerTx, null); assert.equal(p.security.nativeSpentToday, null);
    assert.equal(p.security.permissions.find(x => x.id === 'native')!.status, 'Unavailable');
    assert.equal(p.health.status, 'Unknown');
  });

  it('unreadable permissions are null/Unavailable, an empty approved set is genuinely empty', () => {
    const unread = by(build([reg(A)], [], { permissions: null }), A);
    assert.equal(unread.security.recipients, null); assert.equal(unread.security.tokens, null);
    assert.equal(unread.security.permissions.find(x => x.id === 'erc20')!.status, 'Unavailable');
    const none = by(build([reg(A)], [], { permissions: { recipients: [], tokens: [] } }), A);
    assert.deepEqual(none.security.recipients, []); assert.deepEqual(none.security.tokens, []);
    assert.equal(none.security.permissions.find(x => x.id === 'erc20')!.status, 'Not allowed');
  });

  it('token approvals and arbitrary calls are always reported as not allowed (V1 contract has neither)', () => {
    const p = by(build([reg(A)], []), A);
    assert.equal(p.security.permissions.find(x => x.id === 'approve')!.status, 'Not allowed');
    assert.equal(p.security.permissions.find(x => x.id === 'arbitrary')!.status, 'Not allowed');
    assert.equal(p.security.permissions.find(x => x.id === 'native')!.status, 'Allowed');
    assert.equal(p.security.permissions.find(x => x.id === 'erc20')!.status, 'Allowed');
  });

  it('when event history cannot be read, history is flagged unavailable and registration date is null (not invented)', () => {
    const p = by(build([reg(A)], [], { entriesNull: true, live: new Map([[A, live()]]) }), A);
    assert.equal(p.history.available, false); assert.equal(p.identity.registeredAt, null); assert.equal(p.identity.registeredTx, null);
    assert.equal(p.history.transactions.length, 0); assert.equal(p.history.management.length, 0);
    assert.equal(p.risk.level, 'Insufficient data');
  });

  it('a registration event without a timestamp does not produce a date', () => {
    const p = by(build([reg(A, -1)], [], { live: new Map([[A, live()]]) }), A);
    assert.equal(p.identity.registeredAt, null); assert.ok(p.identity.registeredTx);
  });

  it('failed attempts appear in the failed list and carry the Risk score from Agent Risk Insights', () => {
    const logs = [reg(A), allow(), sent(A, 3 * DAY)];
    function allow() { return ev('RecipientPermissionChanged', { recipient: RCPT, allowed: true }, 29 * DAY); }
    const ps = build(logs, [revertTx(A, 1 * DAY, C, 9000)], { live: new Map([[A, live()]]) });
    const p = ps[0];
    assert.equal(p.history.failed.length, 1); assert.equal(p.history.failed[0].status, 'Failed');
    assert.equal(p.risk.score, 10); assert.equal(p.risk.level, 'Low'); // one unapproved-recipient attempt = 10 points (Agent Risk Insights tier table)
    assert.ok(p.risk.findings.some(f => f.id === 'recipient'));
    assert.equal(p.health.status, 'Warning');
  });

  it('a profile exists for every agent ever registered, including revoked ones, and none are duplicated', () => {
    const logs = [reg(A), reg(B), ev('AgentRevoked', { agent: B }, 3 * DAY)];
    const ps = build(logs, [], { live: new Map<string, LiveAgent>([[A, live()], [B, live({ registered: false })]]) });
    assert.deepEqual(ps.map(p => p.address).sort(), [A, B].sort());
  });

  it('degenerate inputs never throw: no agents, nothing readable, and the inputs are not mutated', () => {
    assert.deepEqual(build([], [], { live: new Map(), entriesNull: true, permissions: null, globalPaused: null }), []);
    const entries = buildEntries([reg(A), sent(A, DAY)], [], fmt); const before = JSON.stringify(entries, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const h = computeHealth({ entries, failedState: 'unavailable', live: new Map<string, LiveAgent>([[A, { ok: false, error: 'x' }]]), globalPaused: null, knownAgents: [A], now: NOW });
    const r = computeRisk(h.agents, entries, { now: NOW, failedState: 'unavailable', short: fmt.short, native: fmt.native });
    const ps = computeProfiles(h.agents, r.agents, { vault: VAULT, owner: OWNER, chainId: 1, networkName: 'X', explorer: '', permissions: null, globalPaused: null, entries, now: NOW });
    assert.equal(ps.length, 1); assert.equal(ps[0].security.status, 'Unavailable');
    assert.equal(JSON.stringify(entries, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
  });

  it('profiles are derived from the agents Health already lists: they never add or drop an agent of their own', () => {
    const logs = [reg(A), reg(B), reg(C)];
    const m = new Map<string, LiveAgent>([[A, live()], [B, live()], [C, live({ registered: false })]]);
    const ps = build(logs, [], { live: m });
    assert.deepEqual(ps.map(p => p.address).sort(), [A, B, C].sort());
  });
});
