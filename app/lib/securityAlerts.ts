/**
 * Security Alerts: derives alerts from data AgentGuard already reads. Pure functions, no network, no ethers or React.
 *
 * Sources (all existing features, nothing new is fetched):
 *  - Activity & Security Logs entries (activityLog.buildEntries): status changes, permission changes, pauses, reverted calls.
 *  - Agent Health (agentHealth): live agents(address) read (spend today vs limit) and the Inactive classification.
 *  - Agent Risk Insights (agentRisk): findings with their on-chain evidence, and the risk level.
 *
 * Honesty rules:
 *  - Alerts are computed from the vault's history and live state each time the page is opened or refreshed. This is a periodic
 *    check, NOT a live event stream, and the UI says so.
 *  - Every alert carries a stable id derived from the on-chain fact behind it (tx hash / log key / agent + day), so the same fact
 *    found on every refresh is ONE alert, and read/unread state survives refreshes.
 *  - Unauthorized-recipient and blocked-attempt alerts rely on reverted transactions reported by the block explorer. When those
 *    could not be loaded, the alerts are not produced and a note says the check could not be performed (never "no attempts").
 *  - Nothing is invented: a missing timestamp is 0 (shown as unavailable); unreadable data produces a note, not an alert.
 */
import type { LogEntry } from './activityLog';
import type { AgentHealth, FailedDataState } from './agentHealth';
import type { AgentRisk, Finding } from './agentRisk';

export type AlertSeverity = 'Critical' | 'High' | 'Medium' | 'Low';
export type AlertType = 'Unusual agent activity' | 'Spending limit' | 'Unauthorized recipient' | 'Agent status' | 'High risk' | 'Security event';
export const ALERT_TYPES: AlertType[] = ['Unusual agent activity', 'Spending limit', 'Unauthorized recipient', 'Agent status', 'High risk', 'Security event'];
export const SEVERITIES: AlertSeverity[] = ['Critical', 'High', 'Medium', 'Low'];
const SEV_RANK: Record<AlertSeverity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/** Only events from this many days back are turned into alerts, so the centre shows what is recent rather than the vault's whole history. */
export const ALERT_DAYS = 30;
export const LIMIT_WARN_PCT = 80;
const DAY = 86400;

export type SecurityAlert = {
  /** Stable across refreshes. Used for de-duplication and read/unread tracking. */
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  /** Lower-case agent address, when the alert concerns one agent. AgentGuard V1 stores no agent names on-chain. */
  agent?: string;
  /** Unix seconds; 0 = could not be determined. */
  timestamp: number;
  blockNumber?: number;
  hash?: string;
};

export type AlertInput = {
  health: AgentHealth[];
  risks: AgentRisk[];
  /** null when the vault's event history could not be read. */
  entries: LogEntry[] | null;
  failedState: FailedDataState;
  /** Unix seconds at which the live data was read. */
  now: number;
  short: (a: string) => string;
  native: (n: bigint) => string;
};
export type AlertResult = { alerts: SecurityAlert[]; /** Checks that could not be performed or data that was left out. Never alerts. */ notes: string[] };

const low = (a?: string) => (a || '').toLowerCase();
export const sortAlerts = (a: SecurityAlert[]) => [...a].sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0) || SEV_RANK[x.severity] - SEV_RANK[y.severity] || x.id.localeCompare(y.id));

const STATUS_SEV: Record<string, AlertSeverity> = { 'Agent paused': 'Medium', 'Agent resumed': 'Low', 'Agent revoked': 'High' };
const SECURITY_SEV: Record<string, AlertSeverity> = {
  'Emergency pause enabled': 'Critical', 'Emergency pause disabled': 'Low',
  'Recipient added': 'Low', 'Recipient removed': 'Low', 'Token permission added': 'Low', 'Token permission removed': 'Low',
  'Spending limits changed': 'Low', 'Owner withdrawal': 'Medium',
};

export function computeAlerts(input: AlertInput): AlertResult {
  const out = new Map<string, SecurityAlert>(); // keyed by id: the same fact can never produce two alerts
  const notes: string[] = [];
  const add = (a: SecurityAlert) => { if (!out.has(a.id)) out.set(a.id, a); };
  const windowStart = input.now - ALERT_DAYS * DAY;
  const covered = new Set<string>(); // reverted tx hashes already explained by a more specific alert

  if (input.entries === null) notes.push('The vault\'s on-chain event history could not be read, so event-based alerts (status changes, permission changes, blocked attempts, risk findings) are unavailable. This is not an all-clear.');
  if (input.failedState === 'unavailable') notes.push('Reverted transactions could not be loaded from the block explorer, so unauthorized-recipient attempts and other blocked calls cannot be detected right now. This is not an all-clear.');
  else if (input.failedState === 'partial') notes.push('Only the most recent reverted transactions could be loaded, so older blocked attempts may be missing.');

  // ── Risk findings (Agent Risk Insights) → unauthorized recipient / unusual activity ──
  for (const r of input.risks) {
    const a = low(r.address);
    for (const f of r.findings) {
      for (const e of f.evidence) if (e.reverted) covered.add(low(e.hash));
      if (f.id === 'recipient') {
        // One alert per reverted attempt: each is a verifiable on-chain fact (the call reverted and the decoded recipient was not approved at that block).
        for (const e of f.evidence) {
          if (!e.timestamp || e.timestamp < windowStart) continue;
          add({ id: `recipient:${low(e.hash)}`, type: 'Unauthorized recipient', severity: 'High', title: 'Attempt to send to an unapproved recipient', description: `${input.short(a)}: ${e.summary} The call reverted, so no funds moved.`, agent: a, timestamp: e.timestamp, blockNumber: e.blockNumber, hash: e.hash });
        }
      } else {
        const newest = [...f.evidence].sort((x, y) => y.timestamp - x.timestamp || y.blockNumber - x.blockNumber)[0];
        if (!newest) continue;
        add(unusual(a, f, newest, input.short));
      }
    }
    // ── High risk level ──
    if (r.level === 'High' || r.level === 'Critical') {
      const latest = r.findings.reduce((m, f) => Math.max(m, f.latest), 0);
      add({ id: `risk:${a}:${r.level}`, type: 'High risk', severity: r.level === 'Critical' ? 'Critical' : 'High', title: `${r.level} risk agent`, description: `${input.short(a)} has a risk score of ${r.score}/100 (${r.level}, confidence ${r.confidence}). ${r.explanation[0] || ''}`.trim(), agent: a, timestamp: latest });
    }
  }

  // ── Spending limit warnings (live contract state) ──
  const today = Math.floor(input.now / DAY);
  for (const h of input.health) {
    const a = low(h.address); const l = h.live;
    if (!l.ok || !l.registered || l.maxNativePerDay <= 0n) continue;
    const spent = Number(l.dayStart) === today ? l.nativeSpentToday : 0n;
    const level = spent * 100n >= l.maxNativePerDay * 100n ? 100 : spent * 100n >= l.maxNativePerDay * BigInt(LIMIT_WARN_PCT) ? LIMIT_WARN_PCT : 0;
    if (!level) continue;
    const pct = Number((spent * 1000n) / l.maxNativePerDay) / 10;
    add({ id: `limit:${a}:${today}:${level}`, type: 'Spending limit', severity: level === 100 ? 'High' : 'Medium', title: level === 100 ? 'Daily spending limit reached' : `Daily spending limit ${LIMIT_WARN_PCT}% used`,
      description: `${input.short(a)} has spent ${input.native(spent)} of its ${input.native(l.maxNativePerDay)} native-coin daily limit (${pct}%) in the current UTC day, as of the last check.${level === 100 ? ' Further transfers today will be rejected by the vault until the day rolls over or you raise the limit.' : ''}`, agent: a, timestamp: input.now });
  }

  // ── Inactive agents (informational) ──
  for (const h of input.health) {
    if (h.status !== 'Inactive') continue;
    const ts = h.lastActivity?.timestamp || h.registeredEvent?.timestamp || 0;
    add({ id: `inactive:${low(h.address)}:${h.lastActivity?.hash || h.registeredEvent?.hash || 'none'}`, type: 'Agent status', severity: 'Low', title: 'Agent inactive', description: `${input.short(low(h.address))}: ${h.reasons[0]} Inactivity is not a security problem.`, agent: low(h.address), timestamp: ts });
  }

  // ── Event-based alerts (Activity & Security Logs) ──
  if (input.entries) {
    let undated = 0;
    for (const e of input.entries) {
      const statusSev = STATUS_SEV[e.type]; const secSev = SECURITY_SEV[e.type];
      const isRevertedUncovered = e.status === 'Failed' && !covered.has(low(e.hash));
      if (!statusSev && !secSev && !isRevertedUncovered) continue;
      if (!e.timestamp) { undated++; continue; }
      if (e.timestamp < windowStart) continue;
      const base = { timestamp: e.timestamp, blockNumber: e.blockNumber, hash: e.hash, agent: e.agent ? low(e.agent) : undefined };
      if (statusSev) add({ ...base, id: `status:${e.key}`, type: 'Agent status', severity: statusSev, title: e.type, description: e.description });
      else if (secSev) add({ ...base, id: `event:${e.key}`, type: 'Security event', severity: secSev, title: e.type, description: e.description });
      else add({ ...base, id: `event:${e.key}`, type: 'Security event', severity: e.type === 'Blocked agent transfer' ? 'Medium' : 'Low', title: e.type, description: e.description });
    }
    if (undated) notes.push(`${undated} event${undated === 1 ? '' : 's'} had no readable block timestamp and ${undated === 1 ? 'was' : 'were'} left out of the alerts.`);
  }

  return { alerts: sortAlerts([...out.values()]), notes };
}

function unusual(agent: string, f: Finding, newest: Finding['evidence'][number], short: (a: string) => string): SecurityAlert {
  // The id includes the newest evidence, so a NEW occurrence raises a new alert while the same one is never repeated.
  return { id: `unusual:${agent}:${f.id}:${low(newest.hash)}`, type: 'Unusual agent activity', severity: f.severity, title: f.title, description: `${short(agent)}: ${f.summary} ${f.kind === 'confirmed' ? 'Confirmed from on-chain data.' : 'A behavioural indicator, not proof of wrongdoing.'}`, agent, timestamp: f.latest || newest.timestamp, blockNumber: newest.blockNumber, hash: newest.hash };
}

/* ───────── Read / unread state ───────── */

/** The subset of the Web Storage API used here, so the logic can be tested without a browser. */
export type KeyValueStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export const readKey = (chainId: number, vault: string) => `agentguard:alerts:read:${chainId}:${low(vault)}`;
const MAX_READ_IDS = 3000;

/** Returns the set of alert ids marked read. Never throws: an unreadable or corrupt store is an empty set (everything unread). */
export function loadRead(store: KeyValueStore | null, key: string): Set<string> {
  try { const raw = store?.getItem(key); if (!raw) return new Set(); const v = JSON.parse(raw); return new Set(Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string') : []); } catch { return new Set(); }
}
/** Returns false when the state could not be saved (e.g. private browsing). */
export function saveRead(store: KeyValueStore | null, key: string, ids: Set<string>): boolean {
  try { if (!store) return false; store.setItem(key, JSON.stringify([...ids].slice(-MAX_READ_IDS))); return true; } catch { return false; }
}
