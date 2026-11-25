import assert from 'node:assert/strict';
import { buildEntries, type FailedTx, type ParsedLog } from '../app/lib/activityLog';
import { computeAgentHealth, computeHealth, currentPermissions, INACTIVITY_DAYS, type HealthInput, type LiveAgent } from '../app/lib/agentHealth';

// Pure-logic tests for Agent Health Monitoring. They feed real activityLog.buildEntries output into the classifier.
const DAY = 86400;
const NOW = 1_800_000_000;
const AGENT = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'b2'.repeat(20);
const OWNER = '0x' + 'c3'.repeat(20);
const RCPT = '0x' + 'd4'.repeat(20);
const TOKEN = '0x' + 'e5'.repeat(20);
const fmt = { short: (a: string) => a.slice(0, 6), native: (n: bigint) => `${n} wei` };
let seq = 0;
const ev = (name: string, args: Record<string, any>, ago: number, block = 1000 - Math.floor(ago / 60)): ParsedLog => ({ name, args, blockNumber: block, index: seq++ % 50, transactionHash: '0x' + (++seq).toString(16).padStart(64, '0'), timestamp: ago < 0 ? 0 : NOW - ago });
const reg = (agent = AGENT, ago = 30 * DAY) => ev('AgentRegistered', { agent, maxNativePerTx: 10n, maxNativePerDay: 100n }, ago);
const sent = (ago: number, agent = AGENT) => ev('NativeTransferExecuted', { agent, recipient: RCPT, amount: 5n }, ago);
const tokenSent = (ago: number) => ev('TokenTransferExecuted', { agent: AGENT, token: TOKEN, recipient: RCPT, amount: 7n }, ago);
const revert = (ago: number, fn = 'executeNative', from = AGENT): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'f'), from, blockNumber: 900 - Math.floor(ago / 60), timestamp: NOW - ago, fn });
const okLive: LiveAgent = { ok: true, registered: true, paused: false, maxNativePerTx: 10n, maxNativePerDay: 100n, dayStart: 0n, nativeSpentToday: 0n };
const input = (logs: ParsedLog[] | null, failed: FailedTx[] = [], over: Partial<HealthInput> = {}): HealthInput => ({
  entries: logs ? buildEntries(logs, failed, fmt) : null, failedState: 'complete', live: new Map([[AGENT, okLive]]), globalPaused: false, knownAgents: [AGENT], now: NOW, ...over,
});

describe('Agent Health Monitoring classification', () => {
  it('Healthy: registered, authorized, recent activity, no reverts', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(2 * DAY)]));
    assert.equal(h.status, 'Healthy');
    assert.equal(h.registration, 'Registered'); assert.equal(h.authorization, 'Authorized');
    assert.equal(h.successful.value, 1); assert.equal(h.failed.value, 0); assert.equal(h.blocked.value, 0); assert.equal(h.total.value, 1);
    assert.equal(h.lastActivity?.timestamp, NOW - 2 * DAY);
  });

  it('Inactive: registered but no recent activity, and it says inactivity is not a security problem', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(20 * DAY)]));
    assert.equal(h.status, 'Inactive');
    assert.ok(h.reasons.some(r => /not a security problem/i.test(r)));
    assert.notEqual(h.status, 'Warning');
    assert.equal(h.successful7d.value, 0); assert.equal(h.successful30d.value, 1);
  });

  it('inactivity is measured from registration when the agent has never transacted', () => {
    assert.equal(computeAgentHealth(AGENT, input([reg(AGENT, 2 * DAY)])).status, 'Healthy');
    const old = computeAgentHealth(AGENT, input([reg(AGENT, (INACTIVITY_DAYS + 3) * DAY)]));
    assert.equal(old.status, 'Inactive'); assert.equal(old.lastActivityState, 'none'); assert.equal(old.total.value, 0);
  });

  it('Restricted: revoked agent (found from events even though the contract deletes its record)', () => {
    const revoked: LiveAgent = { ok: true, registered: false, paused: false, maxNativePerTx: 0n, maxNativePerDay: 0n, dayStart: 0n, nativeSpentToday: 0n };
    const logs = [reg(), sent(10 * DAY), ev('AgentRevoked', { agent: AGENT }, 3 * DAY)];
    const out = computeHealth(input(logs, [], { live: new Map([[AGENT, revoked]]), knownAgents: [] }));
    assert.equal(out.agents.length, 1, 'revoked agent must still be listed');
    const h = out.agents[0];
    assert.equal(h.status, 'Restricted'); assert.equal(h.registration, 'Revoked'); assert.equal(h.authorization, 'Revoked');
    assert.match(h.reasons[0], /revoked on 20/);
  });

  it('a re-registered agent is not treated as revoked', () => {
    const logs = [reg(AGENT, 30 * DAY), ev('AgentRevoked', { agent: AGENT }, 20 * DAY), reg(AGENT, 1 * DAY)];
    const h = computeAgentHealth(AGENT, input(logs));
    assert.equal(h.revokedEvent, null); assert.equal(h.status, 'Healthy');
  });

  it('Restricted: agent paused by the owner, and vault-wide emergency pause', () => {
    const paused: LiveAgent = { ...okLive, paused: true } as LiveAgent;
    const p = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [], { live: new Map([[AGENT, paused]]) }));
    assert.equal(p.status, 'Restricted'); assert.equal(p.authorization, 'Paused by owner');
    const g = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [], { globalPaused: true }));
    assert.equal(g.status, 'Restricted'); assert.equal(g.authorization, 'Blocked by emergency pause');
  });

  it('Warning: a recent blocked attempt; old reverts do not warn but are still counted', () => {
    const w = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [revert(2 * DAY)]));
    assert.equal(w.status, 'Warning'); assert.equal(w.blocked.value, 1); assert.equal(w.failed.value, 0); assert.equal(w.total.value, 2);
    assert.ok(w.reasons[0].includes('1 blocked agent transfer attempt'));
    const old = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [revert(30 * DAY)]));
    assert.equal(old.status, 'Healthy'); assert.equal(old.blocked.value, 1);
  });

  it('a revert of a non-transfer call from the agent is a failed transaction, and other wallets are never attributed to the agent', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [revert(DAY, 'setRecipient'), revert(DAY, 'setRecipient', OWNER), revert(DAY, 'executeNative', OTHER)]));
    assert.equal(h.failed.value, 1); assert.equal(h.blocked.value, 0); assert.equal(h.status, 'Warning');
  });

  it('Unknown: live authorization could not be read', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [], { live: new Map([[AGENT, { ok: false, error: 'rpc down' }]]) }));
    assert.equal(h.status, 'Unknown'); assert.match(h.reasons[0], /rpc down/); assert.equal(h.registration, 'Unknown');
  });

  it('Unknown: event history unavailable; but a paused agent is still Restricted because that is live data', () => {
    const u = computeAgentHealth(AGENT, input(null));
    assert.equal(u.status, 'Unknown'); assert.equal(u.successful.value, null); assert.equal(u.total.value, null); assert.equal(u.lastActivityState, 'unavailable'); assert.equal(u.daily, null);
    const paused: LiveAgent = { ...okLive, paused: true } as LiveAgent;
    assert.equal(computeAgentHealth(AGENT, input(null, [], { live: new Map([[AGENT, paused]]) })).status, 'Restricted');
  });

  it('Unknown: emergency pause state unreadable', () => {
    assert.equal(computeAgentHealth(AGENT, input([reg(), sent(DAY)], [], { globalPaused: null })).status, 'Unknown');
  });

  it('Unknown: timestamps missing, so inactivity cannot be judged', () => {
    const h = computeAgentHealth(AGENT, input([reg(AGENT, -1), sent(-1)]));
    assert.equal(h.status, 'Unknown'); assert.equal(h.successful7d.value, null); assert.equal(h.daily, null);
    assert.equal(h.successful.value, 1, 'the count itself is still exact');
  });

  it('unavailable reverted data is null, never zero, and cannot prove health', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [], { failedState: 'unavailable' }));
    assert.equal(h.status, 'Healthy'); assert.equal(h.successful.value, 1);
    assert.equal(h.failed.value, null); assert.equal(h.blocked.value, null); assert.equal(h.total.value, null);
    assert.ok(h.reasons.some(r => /cannot be ruled out/.test(r)));
    assert.ok(h.daily && h.daily.every(d => d.reverted === null));
  });

  it('partial reverted data is reported as a lower bound', () => {
    const h = computeAgentHealth(AGENT, input([reg(), sent(DAY)], [revert(DAY)], { failedState: 'partial' }));
    assert.equal(h.blocked.lowerBound, true); assert.equal(h.successful.lowerBound, false);
  });

  it('counts native and token transfers, time windows and daily buckets from real events', () => {
    const logs = [reg(), sent(DAY / 2), tokenSent(3 * DAY), sent(10 * DAY), sent(40 * DAY)];
    const h = computeAgentHealth(AGENT, input(logs));
    assert.equal(h.successful.value, 4); assert.equal(h.successful7d.value, 2); assert.equal(h.successful30d.value, 3);
    assert.equal(h.daily?.length, 14);
    assert.equal(h.daily!.reduce((n, d) => n + d.successful, 0), 3, 'only the 14-day window is bucketed');
    assert.equal(h.transactions.length, 4);
  });

  it('discovers revoked agents from events and live-registered agents missing from events, without duplicates', () => {
    const logs = [reg(AGENT), reg(OTHER, 20 * DAY), reg(AGENT, 5 * DAY)];
    const revoked: LiveAgent = { ok: true, registered: false, paused: false, maxNativePerTx: 0n, maxNativePerDay: 0n, dayStart: 0n, nativeSpentToday: 0n };
    const out = computeHealth(input(logs, [], { knownAgents: [AGENT, AGENT.toUpperCase().replace('0X', '0x'), RCPT], live: new Map([[AGENT, okLive], [OTHER, revoked], [RCPT, okLive]]) }));
    assert.deepEqual(out.agents.map(a => a.address).sort(), [AGENT, OTHER, RCPT].sort());
    assert.equal(out.counts.Restricted, 1);
  });

  it('security events include agent-specific and vault-wide pause events but not other agents', () => {
    const logs = [reg(), reg(OTHER), ev('AgentStatusChanged', { agent: AGENT, paused: true }, DAY), ev('AgentStatusChanged', { agent: OTHER, paused: true }, DAY), ev('GlobalPauseChanged', { paused: true }, 2 * DAY), ev('RecipientPermissionChanged', { recipient: RCPT, allowed: true }, 3 * DAY)];
    const h = computeAgentHealth(AGENT, input(logs));
    assert.deepEqual(h.securityEvents.map(e => e.type).sort(), ['Agent paused', 'Emergency pause enabled']);
  });

  it('replays recipient and token permissions', () => {
    const logs = [ev('RecipientPermissionChanged', { recipient: RCPT, allowed: true }, 5 * DAY), ev('RecipientPermissionChanged', { recipient: OTHER, allowed: true }, 4 * DAY), ev('RecipientPermissionChanged', { recipient: OTHER, allowed: false }, 3 * DAY),
      ev('TokenPolicyChanged', { token: TOKEN, allowed: true, maxPerTx: 5n, maxPerDay: 9n }, 4 * DAY)];
    assert.deepEqual(currentPermissions(buildEntries(logs, [], fmt)), { recipients: [RCPT], tokens: [TOKEN] });
  });
});
