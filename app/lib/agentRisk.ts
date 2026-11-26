/**
 * Agent Risk Insights: a transparent, deterministic risk score (0-100) for each agent, computed ONLY from the
 * vault's real on-chain history (the Activity & Security Logs entries) and the Agent Health result.
 * Pure functions, no ethers or React dependency. No randomness, no AI, no network calls: the same inputs always
 * give the same score, and every finding carries the transactions that caused it.
 *
 * ── Scoring model ───────────────────────────────────────────────────────────────────────────────────────
 * Findings are of two kinds:
 *  • CONFIRMED  – a verifiable on-chain fact about the agent's own calls (e.g. it called the vault and the call reverted
 *                 while the recipient was NOT on the approved list at that block). Each reverted agent transfer is
 *                 assigned to exactly ONE category (the contract's own check order), so nothing is double counted.
 *  • BEHAVIOURAL – a statistical pattern compared with the agent's own history (frequency spike, unusual amount,
 *                 new recipients, repeated unexplained reverts). These are indicators, never proof.
 * Each indicator turns an evidence count into points using the tier tables in INDICATORS below.
 * Combination:   score = min(100, Σ confirmed points + min(BEHAVIOURAL_CAP, Σ behavioural points)).
 *   so behavioural indicators alone can never exceed 40 (Medium), and no single indicator exceeds 45.
 * Recency:       only evidence from the last ANALYSIS_DAYS (30) days is scored. A finding whose newest evidence is within
 *                RECENT_DAYS (7) counts in full; older evidence in the window counts 60%. Evidence older than 30 days is
 *                listed as "not scored". Evidence with no readable timestamp is never scored (missing data is not suspicious).
 * Missing data:  never adds risk. It lowers CONFIDENCE and the affected check is listed under "Checks not performed".
 *                If history cannot be read, or the agent has no observed activity, the result is "Insufficient data".
 * Levels:        Low 0-29, Medium 30-59, High 60-79, Critical 80-100. Higher score = higher risk.
 * Inactivity:    never contributes. Normal failures: unexplained reverts contribute at most 10 points.
 */
import type { LogEntry } from './activityLog';
import type { AgentHealth, FailedDataState } from './agentHealth';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical' | 'Insufficient data';
export type Confidence = 'High' | 'Medium' | 'Low' | 'None';
export type FindingKind = 'confirmed' | 'behavioural';
export type Severity = 'Low' | 'Medium' | 'High';
export type IndicatorId = 'recipient' | 'revoked' | 'admin' | 'limit' | 'token' | 'other' | 'paused' | 'spike' | 'amount' | 'newrecipients' | 'correlation';

export const ANALYSIS_DAYS = 30;
export const RECENT_DAYS = 7;
export const OLDER_WEIGHT = 0.6;
export const BEHAVIOURAL_CAP = 40;
export const BASELINE_MIN_DAYS = 7;
export const BASELINE_MIN_TRANSFERS = 5;
export const SPIKE_MIN_24H = 5;
export const SPIKE_RATIO = 3;
export const AMOUNT_MIN_PRIOR = 8;
export const AMOUNT_MULTIPLE = 5;
export const CORRELATION_HOURS = 24;
const DAY = 86400;

type Tier = [number, number]; // [minimum evidence count (or ratio), points]
export type Indicator = { id: IndicatorId; kind: FindingKind; severity: Severity; title: string; rule: string; tiers: Tier[]; unit: string };

/** Single source of truth for the scoring tables (also rendered in the UI and the README). */
export const INDICATORS: Indicator[] = [
  { id: 'recipient', kind: 'confirmed', severity: 'High', title: 'Attempts to send to an unapproved recipient', rule: 'The agent called executeNative / executeTokenTransfer and the call reverted, and the decoded recipient was not on the approved list at that block (30 days).', tiers: [[1, 10], [2, 20], [3, 35], [5, 45]], unit: 'attempts' },
  { id: 'revoked', kind: 'confirmed', severity: 'High', title: 'Calls after the agent was revoked', rule: 'The agent called the vault after its registration had been revoked (30 days).', tiers: [[1, 20], [2, 30], [4, 40]], unit: 'calls' },
  { id: 'admin', kind: 'confirmed', severity: 'High', title: 'Attempts to call owner-only functions', rule: 'An agent sent a call to an owner-only function (registration, limits, recipients, tokens, pause, withdrawals) that reverted (30 days).', tiers: [[1, 25], [2, 35], [3, 45]], unit: 'attempts' },
  { id: 'limit', kind: 'confirmed', severity: 'Medium', title: 'Attempts above the per-transaction limit', rule: 'A reverted transfer whose decoded amount exceeded the per-transaction limit in force at that block (30 days).', tiers: [[1, 8], [2, 15], [4, 25]], unit: 'attempts' },
  { id: 'token', kind: 'confirmed', severity: 'Medium', title: 'Attempts to move an unapproved token', rule: 'A reverted token transfer for a token that was not approved at that block (30 days).', tiers: [[1, 10], [2, 20], [3, 30]], unit: 'attempts' },
  { id: 'other', kind: 'behavioural', severity: 'Low', title: 'Repeated unexplained reverted calls', rule: 'Reverted calls whose cause cannot be established from on-chain state (e.g. daily limit reached, vault balance too low, transfer failure). Normal operational failures: capped at 10 points (7 days).', tiers: [[3, 5], [5, 10]], unit: 'reverts' },
  { id: 'paused', kind: 'behavioural', severity: 'Low', title: 'Calls while paused', rule: 'Reverted calls made while the agent or the whole vault was paused. Often a client that keeps polling (7 days).', tiers: [[3, 5], [5, 10]], unit: 'calls' },
  { id: 'spike', kind: 'behavioural', severity: 'Medium', title: 'Sudden increase in transaction frequency', rule: `Transfers in the last 24h are at least ${SPIKE_MIN_24H} and at least ${SPIKE_RATIO}x the agent's own daily average over the previous 14 days. Needs ${BASELINE_MIN_DAYS}+ days and ${BASELINE_MIN_TRANSFERS}+ transfers of history.`, tiers: [[3, 15], [6, 25], [10, 30]], unit: 'x daily average' },
  { id: 'amount', kind: 'behavioural', severity: 'Medium', title: 'Unusual transfer amount', rule: `A transfer in the last 7 days larger than ${AMOUNT_MULTIPLE}x the median of at least ${AMOUNT_MIN_PRIOR} earlier transfers of the same asset by the same agent.`, tiers: [[1, 10], [2, 20]], unit: 'transfers' },
  { id: 'newrecipients', kind: 'behavioural', severity: 'Low', title: 'Several new recipients', rule: `3+ recipients this agent had never paid before, in the last 7 days, after at least ${AMOUNT_MIN_PRIOR} earlier transfers. Informational: the owner approves every recipient.`, tiers: [[3, 8], [5, 15]], unit: 'new recipients' },
  { id: 'correlation', kind: 'behavioural', severity: 'Low', title: 'Unusual activity right after a permission change', rule: `Another finding's evidence occurred within ${CORRELATION_HOURS}h after a recipient/token approval, limit change or resume. Adds 10 points only when another finding exists; the owner's own change may fully explain it.`, tiers: [[1, 10]], unit: 'correlations' },
];
const IND = Object.fromEntries(INDICATORS.map(i => [i.id, i])) as Record<IndicatorId, Indicator>;

const RECOMMEND: Record<IndicatorId, string> = {
  recipient: 'Review your approved recipients and the agent\'s configuration. If the agent should not be contacting these addresses, consider lowering its spending limits, and revoke it if suspicious behaviour is confirmed.',
  revoked: 'A revoked agent is still calling your vault (every call reverts and no funds move). Check that its keys are retired and whether the wallet may be compromised.',
  admin: 'A registered agent tried to use owner-only functions, which it can never do. Check the agent software and its keys; consider revoking it if this was not intentional.',
  limit: 'Check that this agent\'s spending limits match what you intended, and consider reducing them if they are higher than the agent needs.',
  token: 'Review which tokens you have approved and whether this agent should be using them.',
  other: 'Open these transactions in the explorer to see why they reverted. Occasional failures (daily limit reached, low vault balance) are normal.',
  paused: 'The agent kept calling while paused. Usually harmless polling; check the agent software if unexpected.',
  spike: 'Review the agent\'s recent transactions. If the activity is not expected, consider lowering its limits, and use Emergency Pause if there is an immediate security concern.',
  amount: 'Review these transfers. Consider lowering the agent\'s per-transaction limit if such amounts are not expected.',
  newrecipients: 'Review your approved recipient list and confirm each address is intended.',
  correlation: 'Confirm the permission change was yours. Activity right after a change is often just the agent using its new permission.',
};

export type Evidence = { hash: string; timestamp: number; blockNumber: number; reverted: boolean; summary: string };
export type Finding = {
  id: IndicatorId; kind: FindingKind; severity: Severity; title: string; summary: string;
  count: number; basePoints: number; weight: number; points: number;
  evidence: Evidence[]; latest: number; recommendation: string;
};
export type AgentRisk = {
  address: string; registration: AgentHealth['registration'];
  score: number | null; level: RiskLevel; confidence: Confidence; confidenceNotes: string[];
  findings: Finding[]; confirmedPoints: number; behaviouralPoints: number; behaviouralRaw: number;
  explanation: string[];
  notScored: string[];       // evidence that exists but was not scored (too old, or no timestamp)
  checksNotPerformed: string[];
  recommendations: string[]; // informational only: AgentGuard never acts automatically
  windowStart: number; windowEnd: number;
};
export type RiskOverview = {
  windowStart: number; windowEnd: number;
  monitored: number; revoked: number;
  low: number; medium: number; high: number; critical: number; insufficient: number; attention: number;
  level: RiskLevel; score: number | null;
  recent: { agent: string; finding: Finding }[];
  mostConcerning: { agent: string; finding: Finding } | null;
};
export type RiskContext = { now: number; failedState: FailedDataState; short: (a: string) => string; native: (n: bigint) => string };

const low = (a?: string) => (a || '').toLowerCase();
const TRANSFER_TYPES = ['Native transfer executed', 'Token transfer executed'];
const ADMIN_FNS = new Set(['registerAgent', 'setAgentLimits', 'setAgentPaused', 'revokeAgent', 'setGlobalPause', 'setRecipient', 'setTokenPolicy', 'ownerWithdrawNative', 'ownerWithdrawToken']);
const asc = (a: LogEntry, b: LogEntry) => a.blockNumber - b.blockNumber || a.index - b.index;
const tier = (n: number, t: Tier[]) => { let p = 0; for (const [min, pts] of t) if (n >= min) p = pts; return p; };

export function levelFor(score: number): Exclude<RiskLevel, 'Insufficient data'> { return score >= 80 ? 'Critical' : score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low'; }

/** Vault state for one agent just BEFORE `block`, replayed from events. `ambiguous` when a relevant event is in the same block. */
function stateBefore(events: LogEntry[], agent: string, block: number) {
  const s = { known: false, registered: false, paused: false, globalPaused: false, perTx: null as bigint | null, recipients: new Set<string>(), tokens: new Map<string, { allowed: boolean; perTx: bigint }>(), ambiguous: false };
  for (const e of events) {
    const mine = low(e.agent) === agent;
    const relevant = (mine && ['Agent registered', 'Agent revoked', 'Agent paused', 'Agent resumed', 'Spending limits changed'].includes(e.type)) || e.type === 'Emergency pause enabled' || e.type === 'Emergency pause disabled' || e.type === 'Recipient added' || e.type === 'Recipient removed' || e.type === 'Token permission added' || e.type === 'Token permission removed';
    if (!relevant) continue;
    if (e.blockNumber === block) { s.ambiguous = true; continue; }
    if (e.blockNumber > block) break;
    switch (e.type) {
      case 'Agent registered': s.known = true; s.registered = true; s.paused = false; s.perTx = e.limitPerTx ?? null; break;
      case 'Agent revoked': s.registered = false; break;
      case 'Agent paused': s.paused = true; break;
      case 'Agent resumed': s.paused = false; break;
      case 'Spending limits changed': s.perTx = e.limitPerTx ?? null; break;
      case 'Emergency pause enabled': s.globalPaused = true; break;
      case 'Emergency pause disabled': s.globalPaused = false; break;
      case 'Recipient added': if (e.recipient) s.recipients.add(low(e.recipient)); break;
      case 'Recipient removed': if (e.recipient) s.recipients.delete(low(e.recipient)); break;
      case 'Token permission added': if (e.token) s.tokens.set(low(e.token), { allowed: true, perTx: e.limitPerTx ?? 0n }); break;
      case 'Token permission removed': if (e.token) s.tokens.set(low(e.token), { allowed: false, perTx: 0n }); break;
    }
  }
  return s;
}

type Cause = 'revoked' | 'paused' | 'admin' | 'token' | 'recipient' | 'limit' | 'other';
/** Assigns a reverted agent call to exactly one cause, following the vault contract's own check order. */
function classifyRevert(e: LogEntry, events: LogEntry[], agent: string): Cause {
  if (e.fn && ADMIN_FNS.has(e.fn)) return 'admin';
  if (e.fn !== 'executeNative' && e.fn !== 'executeTokenTransfer') return 'other';
  const s = stateBefore(events, agent, e.blockNumber);
  if (s.ambiguous || !s.known) return 'other';                 // cannot be established: never guess
  if (!s.registered) return 'revoked';
  if (s.paused || s.globalPaused) return 'paused';
  if (e.recipient === undefined || e.amount === undefined) return 'other';
  if (e.fn === 'executeTokenTransfer') {
    const t = e.token ? s.tokens.get(low(e.token)) : undefined;
    if (!t || !t.allowed) return 'token';
    if (!s.recipients.has(low(e.recipient))) return 'recipient';
    return e.amount > t.perTx ? 'limit' : 'other';
  }
  if (!s.recipients.has(low(e.recipient))) return 'recipient';
  return s.perTx !== null && e.amount > s.perTx ? 'limit' : 'other';
}

function median(v: bigint[]): bigint { const s = [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s[Math.floor(s.length / 2)]; }

export function computeAgentRisk(h: AgentHealth, allEntries: LogEntry[] | null, ctx: RiskContext): AgentRisk {
  const a = h.address.toLowerCase();
  const windowEnd = ctx.now; const windowStart = ctx.now - ANALYSIS_DAYS * DAY;
  const base: AgentRisk = { address: a, registration: h.registration, score: null, level: 'Insufficient data', confidence: 'None', confidenceNotes: [], findings: [], confirmedPoints: 0, behaviouralPoints: 0, behaviouralRaw: 0, explanation: [], notScored: [], checksNotPerformed: [], recommendations: [], windowStart, windowEnd };
  if (!allEntries) { base.explanation.push('The vault\'s on-chain history could not be loaded, so no assessment is possible. This is not a risk finding.'); base.checksNotPerformed.push('All checks: event history unavailable.'); return base; }

  const seen = new Set<string>(); const entries = allEntries.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true))).sort(asc);
  const revertedKnown = ctx.failedState !== 'unavailable';
  const transfers = entries.filter(e => e.status === 'Success' && TRANSFER_TYPES.includes(e.type) && low(e.agent) === a);
  const reverts = revertedKnown ? entries.filter(e => e.status === 'Failed' && e.addresses.includes(a)) : [];
  const confidenceNotes: string[] = []; const checksNotPerformed: string[] = []; const notScored: string[] = [];

  if (transfers.length + reverts.length === 0) {
    base.explanation.push(revertedKnown ? 'No on-chain activity has been observed for this agent, so there is nothing to assess. This is neither a risk finding nor proof the agent is safe.' : 'No successful transfers were observed and reverted transactions could not be loaded, so there is not enough evidence to assess this agent.');
    if (!revertedKnown) checksNotPerformed.push('Blocked-attempt checks: reverted transactions could not be loaded from the block explorer.');
    base.checksNotPerformed = checksNotPerformed; return base;
  }

  const ev = (e: LogEntry, summary: string): Evidence => ({ hash: e.hash, timestamp: e.timestamp, blockNumber: e.blockNumber, reverted: e.status === 'Failed', summary });
  const inWindow = (e: LogEntry) => e.timestamp > 0 && e.timestamp >= windowStart;
  const findings: Finding[] = [];
  const addFinding = (id: IndicatorId, count: number, ratioOrCount: number, evidence: Evidence[], summary: string) => {
    const ind = IND[id]; const basePoints = tier(ratioOrCount, ind.tiers); if (!basePoints || !evidence.length) return;
    const latest = Math.max(...evidence.map(x => x.timestamp));
    const weight = latest >= ctx.now - RECENT_DAYS * DAY ? 1 : OLDER_WEIGHT;
    findings.push({ id, kind: ind.kind, severity: ind.severity, title: ind.title, summary, count, basePoints, weight, points: Math.round(basePoints * weight), evidence: [...evidence].sort((x, y) => y.timestamp - x.timestamp), latest, recommendation: RECOMMEND[id] });
  };

  // ── Reverted calls: each is assigned to exactly one cause ──
  const byCause: Record<Cause, LogEntry[]> = { revoked: [], paused: [], admin: [], token: [], recipient: [], limit: [], other: [] };
  let undated = 0; let tooOld = 0;
  for (const r of reverts) {
    if (r.timestamp === 0) { undated++; continue; }
    if (!inWindow(r)) { tooOld++; continue; }
    byCause[classifyRevert(r, entries, a)].push(r);
  }
  if (undated) notScored.push(`${undated} reverted call${undated === 1 ? '' : 's'} without a readable timestamp (not scored).`);
  if (tooOld) notScored.push(`${tooOld} reverted call${tooOld === 1 ? '' : 's'} older than ${ANALYSIS_DAYS} days (not scored).`);
  const where = (r: LogEntry) => `Block ${r.blockNumber}`;
  const sendTxt = (r: LogEntry) => `${r.fn === 'executeTokenTransfer' ? `${r.amount} units of token ${r.token ? ctx.short(r.token) : '?'}` : r.amount !== undefined ? ctx.native(r.amount) : 'an amount'} to ${r.recipient ? ctx.short(r.recipient) : 'an unknown recipient'}`;
  const recent7 = (l: LogEntry[]) => l.filter(r => r.timestamp >= ctx.now - RECENT_DAYS * DAY);
  const c = byCause;
  addFinding('recipient', c.recipient.length, c.recipient.length, c.recipient.map(r => ev(r, `Tried to send ${sendTxt(r)}. The call reverted and that recipient was not on the approved list. ${where(r)}.`)), `${c.recipient.length} reverted transfer attempt${c.recipient.length === 1 ? '' : 's'} to a recipient that was not approved.`);
  addFinding('revoked', c.revoked.length, c.revoked.length, c.revoked.map(r => ev(r, `Called ${r.fn || 'the vault'} after its registration was revoked. The call reverted. ${where(r)}.`)), `${c.revoked.length} call${c.revoked.length === 1 ? '' : 's'} made after the agent was revoked.`);
  addFinding('admin', c.admin.length, c.admin.length, c.admin.map(r => ev(r, `Tried to call owner-only function ${r.fn}. The call reverted. ${where(r)}.`)), `${c.admin.length} attempt${c.admin.length === 1 ? '' : 's'} to call owner-only functions.`);
  addFinding('limit', c.limit.length, c.limit.length, c.limit.map(r => ev(r, `Tried to send ${sendTxt(r)}, above the per-transaction limit in force at the time. The call reverted. ${where(r)}.`)), `${c.limit.length} transfer attempt${c.limit.length === 1 ? '' : 's'} above the per-transaction limit.`);
  addFinding('token', c.token.length, c.token.length, c.token.map(r => ev(r, `Tried to move ${sendTxt(r)}, a token that was not approved at the time. The call reverted. ${where(r)}.`)), `${c.token.length} transfer attempt${c.token.length === 1 ? '' : 's'} with an unapproved token.`);
  const other7 = recent7(c.other); const paused7 = recent7(c.paused);
  addFinding('other', other7.length, other7.length, other7.map(r => ev(r, `Reverted ${r.fn || 'call'}${r.recipient ? ` (to ${ctx.short(r.recipient)})` : ''}; the cause cannot be established from on-chain state. ${where(r)}.`)), `${other7.length} reverted calls in the last ${RECENT_DAYS} days with no identifiable policy cause.`);
  addFinding('paused', paused7.length, paused7.length, paused7.map(r => ev(r, `Called ${r.fn || 'the vault'} while paused. The call reverted. ${where(r)}.`)), `${paused7.length} call${paused7.length === 1 ? '' : 's'} made while paused in the last ${RECENT_DAYS} days.`);
  const olderOther = c.other.length - other7.length, olderPaused = c.paused.length - paused7.length;
  if (olderOther + olderPaused > 0) notScored.push(`${olderOther + olderPaused} older unexplained or while-paused reverted call${olderOther + olderPaused === 1 ? '' : 's'} (only the last ${RECENT_DAYS} days are scored for these two low-severity indicators).`);

  // ── Behavioural indicators from successful transfers ──
  const tUndated = transfers.filter(t => t.timestamp === 0).length;
  if (tUndated) notScored.push(`${tUndated} transfer${tUndated === 1 ? '' : 's'} without a readable timestamp (ignored by the time-based checks).`);
  const dated = transfers.filter(t => t.timestamp > 0);
  const firstSeen = h.registeredEvent?.timestamp || dated[0]?.timestamp || 0;

  // frequency spike
  if (!firstSeen) checksNotPerformed.push('Frequency spike: no readable start time for this agent.');
  else {
    const baseEnd = ctx.now - DAY; const baseStart = Math.max(ctx.now - 15 * DAY, firstSeen);
    const baseDays = Math.floor((baseEnd - baseStart) / DAY);
    const baseCount = dated.filter(t => t.timestamp >= baseStart && t.timestamp < baseEnd).length;
    if (baseDays < BASELINE_MIN_DAYS || baseCount < BASELINE_MIN_TRANSFERS) checksNotPerformed.push(`Frequency spike: needs ${BASELINE_MIN_DAYS}+ days and ${BASELINE_MIN_TRANSFERS}+ transfers of earlier history (found ${Math.max(0, baseDays)} day${baseDays === 1 ? '' : 's'}, ${baseCount} transfer${baseCount === 1 ? '' : 's'}).`);
    else {
      const mean = baseCount / baseDays; const last24 = dated.filter(t => t.timestamp >= ctx.now - DAY);
      const ratio = last24.length / Math.max(mean, 1);
      if (last24.length >= SPIKE_MIN_24H && ratio >= SPIKE_RATIO) addFinding('spike', last24.length, ratio, last24.map(t => ev(t, `${t.description} ${where(t)}.`)), `${last24.length} transfers in the last 24 hours versus a daily average of ${mean.toFixed(1)} over the previous ${baseDays} days (${ratio.toFixed(1)}x).`);
    }
  }
  // unusual amount and new recipients, causal: each transfer is compared only with EARLIER transfers
  const outliers: Evidence[] = []; const newRecipients = new Map<string, Evidence>();
  const assetPrior = new Map<string, bigint[]>(); const recipientsSeen = new Set<string>(); let priorCount = 0; const thinAssets = new Set<string>();
  for (const t of transfers) {
    const asset = t.token ? low(t.token) : 'native'; const prior = assetPrior.get(asset) || [];
    const recent = t.timestamp > 0 && t.timestamp >= ctx.now - RECENT_DAYS * DAY;
    if (recent && t.amount !== undefined) {
      if (prior.length >= AMOUNT_MIN_PRIOR) {
        const m = median(prior);
        if (m > 0n && t.amount > BigInt(AMOUNT_MULTIPLE) * m) outliers.push(ev(t, `${t.amountText || t.amount.toString()} is ${(Number((t.amount * 100n) / m) / 100).toFixed(1)}x the agent's median of ${prior.length} earlier transfers of this asset. ${where(t)}.`));
      } else thinAssets.add(asset);
    }
    if (recent && t.recipient && !recipientsSeen.has(low(t.recipient)) && priorCount >= AMOUNT_MIN_PRIOR && recipientsSeen.size >= 1 && !newRecipients.has(low(t.recipient))) newRecipients.set(low(t.recipient), ev(t, `First payment to ${ctx.short(t.recipient)} (${recipientsSeen.size} recipient${recipientsSeen.size === 1 ? '' : 's'} paid before). ${where(t)}.`));
    if (t.amount !== undefined) prior.push(t.amount); assetPrior.set(asset, prior);
    if (t.recipient) recipientsSeen.add(low(t.recipient)); priorCount++;
  }
  addFinding('amount', outliers.length, outliers.length, outliers, `${outliers.length} recent transfer${outliers.length === 1 ? '' : 's'} much larger than this agent's own history.`);
  if (!outliers.length && thinAssets.size && dated.some(t => t.timestamp >= ctx.now - RECENT_DAYS * DAY)) checksNotPerformed.push(`Unusual amount: needs ${AMOUNT_MIN_PRIOR}+ earlier transfers of the same asset (not available for ${thinAssets.size} recently used asset${thinAssets.size === 1 ? '' : 's'}).`);
  addFinding('newrecipients', newRecipients.size, newRecipients.size, [...newRecipients.values()], `${newRecipients.size} recipient${newRecipients.size === 1 ? '' : 's'} paid for the first time in the last ${RECENT_DAYS} days.`);

  // correlation with the owner's own permission changes
  const changes = entries.filter(e => e.timestamp > 0 && ((low(e.agent) === a && (e.type === 'Spending limits changed' || e.type === 'Agent resumed')) || e.type === 'Recipient added' || e.type === 'Token permission added'));
  const trigger = findings.filter(f => ['recipient', 'limit', 'token', 'admin', 'spike', 'amount'].includes(f.id));
  const corr: Evidence[] = [];
  for (const f of trigger) for (const x of f.evidence) for (const ch of changes) if (x.timestamp >= ch.timestamp && x.timestamp - ch.timestamp <= CORRELATION_HOURS * 3600 && x.timestamp >= windowStart) { corr.push({ hash: ch.hash, timestamp: ch.timestamp, blockNumber: ch.blockNumber, reverted: false, summary: `${ch.type} (${ch.description}) followed within ${CORRELATION_HOURS}h by: ${x.summary}` }); }
  if (corr.length) { const uniq = [...new Map(corr.map(x => [x.hash + x.summary, x])).values()]; addFinding('correlation', uniq.length, 1, uniq, `Unusual activity within ${CORRELATION_HOURS} hours after a permission change.`); }

  // ── Combine ──
  const confirmedPoints = findings.filter(f => f.kind === 'confirmed').reduce((s, f) => s + f.points, 0);
  const behaviouralRaw = findings.filter(f => f.kind === 'behavioural').reduce((s, f) => s + f.points, 0);
  const behaviouralPoints = Math.min(BEHAVIOURAL_CAP, behaviouralRaw);
  const score = Math.min(100, confirmedPoints + behaviouralPoints);
  const level = levelFor(score);
  findings.sort((x, y) => y.points - x.points || y.latest - x.latest);

  // ── Confidence ──
  let conf = 3;
  if (ctx.failedState === 'unavailable') { conf = 1; confidenceNotes.push('Reverted transactions could not be loaded from the block explorer, so blocked-attempt checks were not performed and the score only reflects successful transfers.'); checksNotPerformed.push('Blocked-attempt checks (unapproved recipient or token, limit excess, owner-only calls, calls after revocation, repeated reverts): reverted transactions unavailable.'); }
  else if (ctx.failedState === 'partial') { conf = Math.min(conf, 2); confidenceNotes.push('Only the most recent reverted transactions could be loaded, so blocked-attempt counts may be incomplete.'); }
  if (undated + tUndated > 0) { conf = Math.max(1, conf - 1); confidenceNotes.push('Some events had no readable timestamp, so time-based checks used only the dated events.'); }
  if (transfers.length < 5) { conf = Math.max(1, conf - 1); confidenceNotes.push(`Only ${transfers.length} successful transfer${transfers.length === 1 ? '' : 's'} observed, so behavioural baselines are limited.`); }
  const confidence: Confidence = conf >= 3 ? 'High' : conf === 2 ? 'Medium' : 'Low';

  // ── Explanation (why this score) ──
  const explanation: string[] = [];
  if (!findings.length) explanation.push(`No significant risk indicators were detected in the available data (${ANALYSIS_DAYS}-day window, ${transfers.length} transfer${transfers.length === 1 ? '' : 's'} and ${reverts.length} reverted call${reverts.length === 1 ? '' : 's'} observed).`);
  else {
    explanation.push(`Score ${score} = ${confirmedPoints} from confirmed findings + ${behaviouralPoints} from behavioural indicators${behaviouralRaw > BEHAVIOURAL_CAP ? ` (capped from ${behaviouralRaw}; behavioural indicators alone never exceed ${BEHAVIOURAL_CAP})` : ''}.`);
    for (const f of findings) explanation.push(`+${f.points} ${f.title} [${f.kind}, ${f.severity} severity${f.weight < 1 ? `, newest evidence older than ${RECENT_DAYS} days: weighted ${Math.round(OLDER_WEIGHT * 100)}%` : ''}]`);
  }
  const recs = [...new Set(findings.map(f => f.recommendation))];
  if (level === 'Critical') recs.push('Use Emergency Pause if there is an immediate security concern, then review the evidence and revoke the agent if suspicious behaviour is confirmed.');
  else if (level === 'High') recs.push('Review the evidence promptly. Consider reducing this agent\'s spending limits and revoking it if suspicious behaviour is confirmed.');
  if (recs.length) recs.push('These are suggestions only. AgentGuard never revokes, pauses, changes limits or moves funds automatically.');

  return { ...base, score, level, confidence, confidenceNotes, findings, confirmedPoints, behaviouralPoints, behaviouralRaw, explanation, notScored, checksNotPerformed, recommendations: recs };
}

export function computeRisk(health: AgentHealth[], entries: LogEntry[] | null, ctx: RiskContext): { agents: AgentRisk[]; overview: RiskOverview } {
  const agents = health.map(h => computeAgentRisk(h, entries, ctx)).sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.address.localeCompare(y.address));
  const scored = agents.filter(r => r.score !== null);
  const top = scored.length ? Math.max(...scored.map(r => r.score as number)) : null;
  const flat = agents.flatMap(r => r.findings.map(finding => ({ agent: r.address, finding })));
  const sev = { High: 3, Medium: 2, Low: 1 } as const;
  const overview: RiskOverview = {
    windowStart: ctx.now - ANALYSIS_DAYS * DAY, windowEnd: ctx.now,
    monitored: agents.length, revoked: agents.filter(r => r.registration === 'Revoked' || r.registration === 'Not registered').length,
    low: agents.filter(r => r.level === 'Low').length, medium: agents.filter(r => r.level === 'Medium').length, high: agents.filter(r => r.level === 'High').length, critical: agents.filter(r => r.level === 'Critical').length,
    insufficient: agents.filter(r => r.level === 'Insufficient data').length,
    attention: agents.filter(r => r.level === 'Medium' || r.level === 'High' || r.level === 'Critical').length,
    level: top === null ? 'Insufficient data' : levelFor(top), score: top,
    recent: [...flat].sort((x, y) => y.finding.latest - x.finding.latest).slice(0, 8),
    mostConcerning: flat.length ? [...flat].sort((x, y) => y.finding.points - x.finding.points || (x.finding.kind === 'confirmed' ? -1 : 1) - (y.finding.kind === 'confirmed' ? -1 : 1) || sev[y.finding.severity] - sev[x.finding.severity] || y.finding.latest - x.finding.latest)[0] : null,
  };
  return { agents, overview };
}
