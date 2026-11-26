import assert from 'node:assert/strict';
import { buildEntries, type FailedTx, type ParsedLog } from '../app/lib/activityLog';
import { computeAgentHealth, type HealthInput, type LiveAgent } from '../app/lib/agentHealth';
import { BEHAVIOURAL_CAP, computeAgentRisk, computeRisk, INDICATORS, levelFor, type RiskContext } from '../app/lib/agentRisk';

// Pure-logic tests for Agent Risk Insights. Real activityLog.buildEntries output is fed into the real Health + Risk code.
const DAY = 86400, HOUR = 3600;
const NOW = 1_800_000_000;
const AGENT = '0x' + 'a1'.repeat(20), OTHER = '0x' + 'b2'.repeat(20), RCPT = '0x' + 'd4'.repeat(20), RCPT2 = '0x' + 'd5'.repeat(20), BAD = '0x' + 'ee'.repeat(20), TOKEN = '0x' + 'e5'.repeat(20);
const fmt = { short: (a: string) => a.slice(0, 6), native: (n: bigint) => `${n} wei` };
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({ now: NOW, failedState: 'complete', short: fmt.short, native: fmt.native, ...o });
let blk = 100, seq = 0;
const ev = (name: string, args: Record<string, any>, ago: number, block?: number): ParsedLog => ({ name, args, blockNumber: block ?? (blk += 10), index: seq++ % 40, transactionHash: '0x' + (++seq).toString(16).padStart(64, '0'), timestamp: ago < 0 ? 0 : NOW - ago });
const reg = (ago = 40 * DAY, perTx = 100n) => ev('AgentRegistered', { agent: AGENT, maxNativePerTx: perTx, maxNativePerDay: 1000n }, ago);
const allow = (r = RCPT, ago = 39 * DAY) => ev('RecipientPermissionChanged', { recipient: r, allowed: true }, ago);
const sent = (ago: number, amount = 10n, to = RCPT) => ev('NativeTransferExecuted', { agent: AGENT, recipient: to, amount }, ago);
const revertNative = (ago: number, to: string, amount: bigint, block: number, from = AGENT): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'f'), from, blockNumber: block, timestamp: NOW - ago, fn: 'executeNative', recipient: to, amount });
const revertAdmin = (ago: number, fn: string, block: number): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'e'), from: AGENT, blockNumber: block, timestamp: NOW - ago, fn });
const okLive: LiveAgent = { ok: true, registered: true, paused: false, maxNativePerTx: 100n, maxNativePerDay: 1000n, dayStart: 0n, nativeSpentToday: 0n };

function risk(logs: ParsedLog[], failed: FailedTx[] = [], o: { failedState?: 'complete' | 'partial' | 'unavailable'; entriesNull?: boolean } = {}) {
  const entries = buildEntries(logs, failed, fmt);
  const failedState = o.failedState ?? 'complete';
  const hin: HealthInput = { entries: o.entriesNull ? null : entries, failedState, live: new Map([[AGENT, okLive]]), globalPaused: false, knownAgents: [AGENT], now: NOW };
  return computeAgentRisk(computeAgentHealth(AGENT, hin), o.entriesNull ? null : entries, ctx({ failedState }));
}
/** A healthy history: registered 40d ago, recipient approved, `n` small transfers spread over the last 14 days. */
const steady = (n = 14) => [reg(), allow(), ...Array.from({ length: n }, (_, i) => sent((i + 1.5) * DAY))];
// block numbers: all events above use increasing blocks; reverts at 5000+ happen after all of them
const LATE = 9000;

describe('Agent Risk Insights', () => {
  it('levels follow the documented thresholds and higher score means higher risk', () => {
    assert.deepEqual([0, 29, 30, 59, 60, 79, 80, 100].map(levelFor), ['Low', 'Low', 'Medium', 'Medium', 'High', 'High', 'Critical', 'Critical']);
  });

  it('Low: steady, normal activity produces no findings and says so', () => {
    const r = risk(steady());
    assert.equal(r.level, 'Low'); assert.equal(r.score, 0); assert.equal(r.findings.length, 0);
    assert.ok(/No significant risk indicators/.test(r.explanation[0]));
  });

  it('Insufficient data: history unavailable, and an agent with no observed activity (never High because it is inactive)', () => {
    assert.equal(risk(steady(), [], { entriesNull: true }).level, 'Insufficient data'); assert.equal(risk(steady(), [], { entriesNull: true }).score, null);
    const idle = risk([reg(), allow()]); assert.equal(idle.level, 'Insufficient data'); assert.equal(idle.score, null);
    const longIdle = risk([reg(), allow(), sent(35 * DAY), sent(36 * DAY)]); assert.equal(longIdle.level, 'Low'); assert.equal(longIdle.findings.length, 0, 'inactivity is not risk');
  });

  it('confirmed: repeated attempts to unapproved recipients -> Medium, with the real transactions as evidence', () => {
    const f = [revertNative(2 * DAY, BAD, 5n, LATE), revertNative(2 * DAY - 60, BAD, 5n, LATE + 1), revertNative(DAY, BAD, 5n, LATE + 2)];
    const r = risk(steady(), f);
    const x = r.findings.find(z => z.id === 'recipient')!;
    assert.equal(x.kind, 'confirmed'); assert.equal(x.count, 3); assert.equal(x.points, 35); assert.equal(r.score, 35); assert.equal(r.level, 'Medium');
    assert.deepEqual(new Set(x.evidence.map(e => e.hash)), new Set(f.map(t => t.hash))); assert.ok(x.evidence.every(e => e.reverted && /not on the approved list/.test(e.summary)));
    assert.ok(r.recommendations.some(t => /Review your approved recipients/.test(t)) && r.recommendations.some(t => /never revokes, pauses/.test(t)));
  });

  it('one weak indicator never labels an agent High: a single attempt is Low', () => {
    const r = risk(steady(), [revertNative(DAY, BAD, 5n, LATE)]);
    assert.equal(r.findings[0].points, 10); assert.equal(r.level, 'Low');
    assert.ok(Math.max(...INDICATORS.map(i => Math.max(...i.tiers.map(t => t[1])))) <= 45, 'no single indicator can reach High');
  });

  it('High and Critical need several concerning behaviours together', () => {
    const f = [...[0, 1, 2, 3, 4].map(i => revertNative(DAY + i, BAD, 5n, LATE + i)), revertAdmin(DAY, 'setRecipient', LATE + 10)];
    let r = risk(steady(), f); assert.equal(r.confirmedPoints, 45 + 25); assert.equal(r.level, 'High');
    const tok = (i: number): FailedTx => ({ hash: '0x' + (++seq).toString(16).padStart(64, 'd'), from: AGENT, blockNumber: LATE + 30 + i, timestamp: NOW - HOUR - i, fn: 'executeTokenTransfer', token: TOKEN, recipient: RCPT, amount: 5n });
    r = risk(steady(), [...f, revertAdmin(DAY, 'revokeAgent', LATE + 11), revertAdmin(DAY, 'setGlobalPause', LATE + 12), tok(0), tok(1), tok(2)]);
    assert.equal(r.findings.find(z => z.id === 'token')!.count, 3);
    assert.equal(r.score, 100); assert.equal(r.level, 'Critical');
    assert.ok(r.recommendations.some(t => /Emergency Pause/.test(t)));
  });

  it('calls after revocation are one confirmed finding; every post-revocation call reverts, so none is also counted as an unapproved recipient', () => {
    const rev = [reg(), allow(), ...Array.from({ length: 6 }, (_, i) => sent((i + 4) * DAY)), ev('AgentRevoked', { agent: AGENT }, 3 * DAY)];
    const f = [...[0, 1, 2, 3].map(i => revertNative(DAY + i, BAD, 5n, LATE + i)), ...[0, 1, 2, 3].map(i => revertNative(HOUR + i, RCPT, 5n, LATE + 20 + i))];
    const r = risk(rev, f);
    assert.equal(r.findings.find(z => z.id === 'revoked')!.count, 8); assert.equal(r.findings.find(z => z.id === 'recipient'), undefined);
    assert.equal(r.score, 40); assert.equal(r.level, 'Medium');
  });

  it('repeated blocked attempts are each counted once (no double counting across indicators)', () => {
    const f = [revertNative(DAY, BAD, 5n, LATE), revertNative(DAY - 1, BAD, 5n, LATE + 1), revertNative(DAY - 2, BAD, 5n, LATE + 2), revertNative(DAY - 3, RCPT, 500n, LATE + 3)];
    const r = risk(steady(), f);
    const counted = r.findings.reduce((n, z) => n + z.evidence.filter(e => e.reverted).length, 0);
    assert.equal(counted, 4); assert.equal(r.findings.find(z => z.id === 'recipient')!.count, 3); assert.equal(r.findings.find(z => z.id === 'limit')!.count, 1);
  });

  it('cause follows the contract check order: paused beats recipient; revoked beats everything; admin calls are their own indicator', () => {
    const logs = [...steady(), ev('AgentStatusChanged', { agent: AGENT, paused: true }, 3 * DAY, 8000)];
    const r = risk(logs, [revertNative(2 * DAY, BAD, 5n, LATE)]);
    assert.equal(r.findings.find(z => z.id === 'recipient'), undefined); assert.equal(r.findings.find(z => z.id === 'paused'), undefined, 'one paused call is below the threshold');
    const r2 = risk(logs, [0, 1, 2].map(i => revertNative(2 * DAY - i, BAD, 5n, LATE + i)));
    assert.equal(r2.findings.find(z => z.id === 'paused')!.count, 3); assert.equal(r2.findings.find(z => z.id === 'recipient'), undefined);
    const r3 = risk(steady(), [revertAdmin(DAY, 'ownerWithdrawNative', LATE)]); assert.equal(r3.findings.find(z => z.id === 'admin')!.points, 25);
  });

  it('normal failures are not treated as malicious: unexplained reverts are Low and capped at 10 points', () => {
    const f = Array.from({ length: 8 }, (_, i) => revertNative(DAY + i * 100, RCPT, 5n, LATE + i)); // approved recipient, within limit -> cause unknown (e.g. low vault balance)
    const r = risk(steady(), f); const x = r.findings.find(z => z.id === 'other')!;
    assert.equal(x.points, 10); assert.equal(x.kind, 'behavioural'); assert.equal(r.level, 'Low');
  });

  it('a revert in the same block as a relevant event is not classified (ambiguous), so it cannot create a confirmed finding', () => {
    const logs = [...steady(), ev('RecipientPermissionChanged', { recipient: BAD, allowed: false }, 2 * DAY, 8000)];
    const r = risk(logs, [0, 1, 2].map(i => revertNative(2 * DAY - i, BAD, 5n, 8000)));
    assert.equal(r.confirmedPoints, 0);
  });

  it('behavioural: unusual transaction frequency (needs a baseline) and is capped below High', () => {
    const logs = [reg(), allow(), ...Array.from({ length: 10 }, (_, i) => sent((i + 2) * DAY)), ...Array.from({ length: 12 }, (_, i) => sent(i * 1000 + 100))];
    const r = risk(logs); const x = r.findings.find(z => z.id === 'spike')!;
    assert.equal(x.kind, 'behavioural'); assert.equal(x.evidence.length, 12); assert.ok(/12 transfers in the last 24 hours/.test(x.summary)); assert.ok(x.points >= 15);
    assert.ok(r.level === 'Low' || r.level === 'Medium'); assert.ok(r.behaviouralPoints <= BEHAVIOURAL_CAP);
  });

  it('no spike verdict without a baseline: a new agent bursting is listed as a check not performed, not a finding', () => {
    const logs = [reg(2 * DAY), allow(), ...Array.from({ length: 12 }, (_, i) => sent(i * 1000 + 100))];
    const r = risk(logs); assert.equal(r.findings.find(z => z.id === 'spike'), undefined); assert.ok(r.checksNotPerformed.some(t => /Frequency spike/.test(t)));
  });

  it('behavioural: unusual transfer amount compared with the agent\'s own history', () => {
    const logs = [reg(), allow(), ...Array.from({ length: 10 }, (_, i) => sent((i + 2) * DAY, 10n)), sent(HOUR, 90n)];
    const r = risk(logs); const x = r.findings.find(z => z.id === 'amount')!;
    assert.equal(x.count, 1); assert.ok(/9\.0x/.test(x.evidence[0].summary)); assert.equal(x.points, 10);
    assert.equal(risk([reg(), allow(), ...Array.from({ length: 10 }, (_, i) => sent((i + 2) * DAY, 10n)), sent(HOUR, 40n)]).findings.find(z => z.id === 'amount'), undefined, '4x the median is within the normal range');
    assert.ok(risk([reg(), allow(), sent(DAY, 10n), sent(HOUR, 900n)]).checksNotPerformed.some(t => /Unusual amount/.test(t)), 'too little history: not performed');
  });

  it('behavioural: several new recipients, only after an established pattern', () => {
    const rs = ['01', '02', '03'].map(x => '0x' + x.repeat(20));
    const logs = [reg(), allow(), ...rs.map(r => allow(r, 3 * DAY)), ...Array.from({ length: 10 }, (_, i) => sent((i + 3) * DAY)), ...rs.map((r, i) => sent(i * HOUR + 100, 10n, r))];
    const x = risk(logs).findings.find(z => z.id === 'newrecipients')!; assert.equal(x.count, 3); assert.equal(x.kind, 'behavioural');
  });

  it('correlation: unusual activity right after a permission change adds points only with another finding', () => {
    const logs = [...steady(), ev('RecipientPermissionChanged', { recipient: BAD, allowed: true }, 2 * DAY + 100, 7000), ev('RecipientPermissionChanged', { recipient: BAD, allowed: false }, 2 * DAY - 7200, 7500)];
    const r = risk(logs, [0, 1, 2].map(i => revertNative(2 * DAY + 50 - i, RCPT2, 500n, 7100 + i))); // above the 100 per-tx limit, shortly after the change
    assert.ok(r.findings.some(z => z.id === 'correlation')); assert.equal(risk(logs).findings.length, 0);
  });

  it('missing data never adds risk: unavailable reverted data -> no blocked-attempt findings, Low confidence, check listed', () => {
    const r = risk(steady(), [revertNative(DAY, BAD, 5n, LATE)], { failedState: 'unavailable' });
    assert.equal(r.score, 0); assert.equal(r.level, 'Low'); assert.equal(r.confidence, 'Low'); assert.ok(r.checksNotPerformed.some(t => /unavailable/.test(t))); assert.ok(r.confidenceNotes.length >= 1);
    assert.equal(risk(steady(), [], { failedState: 'partial' }).confidence, 'Medium');
    assert.equal(risk(steady(), []).confidence, 'High');
  });

  it('events without timestamps are not scored and reduce confidence', () => {
    const f: FailedTx = { ...revertNative(0, BAD, 5n, LATE), timestamp: 0 };
    const r = risk(steady(), [f, { ...f, hash: '0x' + 'dd'.repeat(32) }, { ...f, hash: '0x' + 'cc'.repeat(32) }]);
    assert.equal(r.score, 0); assert.ok(r.notScored.some(t => /without a readable timestamp/.test(t))); assert.equal(r.confidence, 'Medium');
  });

  it('old findings: older than 30 days not scored; 8-30 days weighted 60%; last 7 days full weight', () => {
    const mk = (ago: number) => risk(steady(), [0, 1, 2].map(i => revertNative(ago, BAD, 5n, LATE + i)).map((t, i) => ({ ...t, hash: '0x' + (i + 1 + ago).toString(16).padStart(64, 'a') })));
    assert.equal(mk(2 * DAY).score, 35); assert.equal(mk(15 * DAY).score, 21); const old = mk(35 * DAY); assert.equal(old.score, 0); assert.ok(old.notScored.some(t => /older than 30 days/.test(t)));
  });

  it('the score updates when new observable activity arrives', () => {
    const before = risk(steady(), [revertNative(DAY, BAD, 5n, LATE)]).score!;
    const after = risk(steady(), [revertNative(DAY, BAD, 5n, LATE), revertNative(HOUR, BAD, 5n, LATE + 1), revertNative(60, BAD, 5n, LATE + 2)]).score!;
    assert.ok(after > before, `${before} -> ${after}`);
  });

  it('deterministic and duplicate-safe: same inputs, same output; duplicate entries do not double count', () => {
    const logs = steady(); const f = [revertNative(DAY, BAD, 5n, LATE), revertNative(DAY - 1, BAD, 5n, LATE + 1)];
    assert.deepEqual(risk(logs, f), risk(logs, f));
    const entries = buildEntries(logs, f, fmt); const hin: HealthInput = { entries, failedState: 'complete', live: new Map([[AGENT, okLive]]), globalPaused: false, knownAgents: [AGENT], now: NOW };
    const h = computeAgentHealth(AGENT, hin);
    assert.equal(computeAgentRisk(h, [...entries, ...entries], ctx()).score, computeAgentRisk(h, entries, ctx()).score);
  });

  it('overview aggregates real agent results only', () => {
    const entries = buildEntries([...steady(), ev('AgentRegistered', { agent: OTHER, maxNativePerTx: 1n, maxNativePerDay: 2n }, 5 * DAY)], [0, 1, 2].map(i => revertNative(DAY - i, BAD, 5n, LATE + i)), fmt);
    const live = new Map<string, LiveAgent>([[AGENT, okLive], [OTHER, okLive]]);
    const hs = [AGENT, OTHER].map(a => computeAgentHealth(a, { entries, failedState: 'complete', live, globalPaused: false, knownAgents: [AGENT, OTHER], now: NOW }));
    const { agents, overview } = computeRisk(hs, entries, ctx());
    assert.equal(overview.monitored, 2); assert.equal(overview.medium, 1); assert.equal(overview.insufficient, 1); assert.equal(overview.attention, 1);
    assert.equal(overview.low + overview.medium + overview.high + overview.critical + overview.insufficient, agents.length);
    assert.equal(overview.level, 'Medium'); assert.equal(overview.score, 35); assert.equal(overview.mostConcerning?.finding.id, 'recipient'); assert.ok(overview.recent.length >= 1);
    const empty = computeRisk([], entries, ctx()); assert.equal(empty.overview.level, 'Insufficient data'); assert.equal(empty.overview.mostConcerning, null);
  });
});
