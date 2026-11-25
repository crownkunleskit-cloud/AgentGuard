/**
 * Agent Health Monitoring: classifies every agent of a vault from real data only.
 *
 * Inputs are (1) the Activity & Security Logs entries already built by activityLog.buildEntries (decoded vault
 * events plus reverted transactions reported by the block explorer) and (2) the live agents(address) /
 * globallyPaused() contract reads. Pure functions with no ethers or React dependency, so the rules can be tested
 * in isolation. Nothing here invents data: a value that cannot be established is `null` (shown as "Unavailable"),
 * never 0, and a status that cannot be verified is "Unknown", never a guess.
 *
 * This is a check performed when the dashboard is opened or refreshed. It is not continuous real-time monitoring.
 */
import type { LogEntry } from './activityLog';

export type HealthStatus = 'Healthy' | 'Inactive' | 'Restricted' | 'Warning' | 'Unknown';
/** complete: every reverted tx was loaded. partial: only the newest ones. unavailable: the explorer could not be read. */
export type FailedDataState = 'complete' | 'partial' | 'unavailable';

/** Live result of agents(address). `ok: false` means the read failed, which is not the same as "not registered". */
export type LiveAgent =
  | { ok: true; registered: boolean; paused: boolean; maxNativePerTx: bigint; maxNativePerDay: bigint; dayStart: bigint; nativeSpentToday: bigint }
  | { ok: false; error: string };

/** An agent with no activity for this many days is classed Inactive. Inactivity is informational, never a security finding. */
export const INACTIVITY_DAYS = 7;
/** Reverted (failed or blocked) attempts within this many days raise a Warning. */
export const WARNING_DAYS = 7;
export const HISTORY_DAYS = 14;
const DAY = 86400;

/** value === null means unavailable. lowerBound means the true number may be higher (history was truncated). */
export type Count = { value: number | null; lowerBound: boolean };
export type ActivityRef = { timestamp: number; blockNumber: number; hash: string; reverted: boolean; type: string };

export type AgentHealth = {
  address: string;
  status: HealthStatus;
  /** Why this status was assigned. The first line is the primary reason. */
  reasons: string[];
  registration: 'Registered' | 'Revoked' | 'Not registered' | 'Unknown';
  registeredEvent: LogEntry | null;
  revokedEvent: LogEntry | null;
  authorization: 'Authorized' | 'Paused by owner' | 'Blocked by emergency pause' | 'Revoked' | 'Unknown';
  live: LiveAgent;
  lastActivity: ActivityRef | null;
  lastActivityState: 'observed' | 'none' | 'unavailable';
  lastSuccess: ActivityRef | null;
  successful: Count; failed: Count; blocked: Count; total: Count;
  successful7d: Count; successful30d: Count;
  revertedData: FailedDataState;
  /** The agent's own transfers and reverted attempts, newest first. */
  transactions: LogEntry[];
  /** Agent-specific security events plus vault-wide emergency pause changes, newest first. */
  securityEvents: LogEntry[];
  /** Per UTC day for the last HISTORY_DAYS days, oldest first. null when timestamps are incomplete. reverted null = not checked. */
  daily: { dayStart: number; successful: number; reverted: number | null }[] | null;
};

export type HealthInput = {
  /** null when the vault's event history could not be read. */
  entries: LogEntry[] | null;
  failedState: FailedDataState;
  /** Keyed by lower-case agent address. A missing key is treated as a failed read. */
  live: Map<string, LiveAgent>;
  /** null when globallyPaused() could not be read. */
  globalPaused: boolean | null;
  /** Agents the dashboard already knows are registered (live mapping). Revoked agents are found from events. */
  knownAgents: string[];
  /** Unix seconds at which the live data was read. */
  now: number;
};

const low = (a?: string) => (a || '').toLowerCase();
const num = (n: number): Count => ({ value: n, lowerBound: false });
const NA: Count = { value: null, lowerBound: false };
const newestFirst = (a: LogEntry, b: LogEntry) => b.blockNumber - a.blockNumber || b.index - a.index;
export const fmtDate = (ts: number) => `${new Date(ts * 1000).toISOString().slice(0, 10)} UTC`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ref = (e: LogEntry): ActivityRef => ({ timestamp: e.timestamp, blockNumber: e.blockNumber, hash: e.hash, reverted: e.status === 'Failed', type: e.type });

const TRANSFER_TYPES = ['Native transfer executed', 'Token transfer executed'];
const BLOCKED_TYPE = 'Blocked agent transfer';

export function computeAgentHealth(addr: string, input: HealthInput): AgentHealth {
  const a = low(addr);
  const live: LiveAgent = input.live.get(a) ?? { ok: false, error: 'live state was not read' };
  const entries = input.entries ? [...input.entries].sort(newestFirst) : null;
  const mine = entries ? entries.filter(e => low(e.agent) === a || (e.status === 'Failed' && e.addresses.includes(a))) : [];

  const registeredEvent = mine.find(e => e.type === 'Agent registered') ?? null;
  const lastRevoke = mine.find(e => e.type === 'Agent revoked') ?? null;
  // A revoke only counts if it is newer than the latest registration (a revoked address could be registered again).
  const revokedEvent = lastRevoke && (!registeredEvent || newestFirst(lastRevoke, registeredEvent) < 0) ? lastRevoke : null;

  const transfers = mine.filter(e => e.status === 'Success' && TRANSFER_TYPES.includes(e.type));
  const reverted = mine.filter(e => e.status === 'Failed');
  const blockedList = reverted.filter(e => e.type === BLOCKED_TYPE);
  const failedList = reverted.filter(e => e.type !== BLOCKED_TYPE);
  const revertedKnown = input.failedState !== 'unavailable';
  const lower = input.failedState === 'partial';

  const observed = [...transfers, ...(revertedKnown ? reverted : [])].sort(newestFirst);
  const lastActivity = observed.length ? ref(observed[0]) : null;
  const lastSuccess = transfers.length ? ref(transfers[0]) : null;

  const successful: Count = entries ? num(transfers.length) : NA;
  const failed: Count = entries && revertedKnown ? { value: failedList.length, lowerBound: lower } : NA;
  const blocked: Count = entries && revertedKnown ? { value: blockedList.length, lowerBound: lower } : NA;
  const total: Count = successful.value !== null && failed.value !== null && blocked.value !== null ? { value: successful.value + failed.value + blocked.value, lowerBound: lower } : NA;

  // Time-windowed figures need a block timestamp on every entry involved; otherwise they are unavailable.
  const transferTimesKnown = transfers.every(e => e.timestamp > 0);
  const windowCount = (days: number): Count => (!entries || !transferTimesKnown ? NA : num(transfers.filter(e => e.timestamp >= input.now - days * DAY).length));
  const observedTimesKnown = observed.every(e => e.timestamp > 0);
  let daily: AgentHealth['daily'] = null;
  if (entries && observedTimesKnown) {
    const today = Math.floor(input.now / DAY) * DAY;
    daily = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const start = today - i * DAY;
      const inDay = (e: LogEntry) => e.timestamp >= start && e.timestamp < start + DAY;
      daily.push({ dayStart: start, successful: transfers.filter(inDay).length, reverted: revertedKnown ? reverted.filter(inDay).length : null });
    }
  }

  const securityEvents = entries ? entries.filter(e => (low(e.agent) === a && e.categories.includes('security')) || (e.status === 'Failed' && e.addresses.includes(a)) || e.type.startsWith('Emergency pause')) : [];

  // ─── authorization / registration (from the live contract mapping, which is the source of truth) ───
  let registration: AgentHealth['registration'] = 'Unknown';
  let authorization: AgentHealth['authorization'] = 'Unknown';
  if (live.ok) {
    if (!live.registered) { registration = revokedEvent || registeredEvent ? 'Revoked' : 'Not registered'; authorization = 'Revoked'; }
    else { registration = 'Registered'; authorization = live.paused ? 'Paused by owner' : input.globalPaused === true ? 'Blocked by emergency pause' : input.globalPaused === null ? 'Unknown' : 'Authorized'; }
  }

  // ─── classification ───
  const reasons: string[] = [];
  const recentReverts = reverted.filter(e => e.timestamp === 0 || e.timestamp >= input.now - WARNING_DAYS * DAY);
  const recentBlocked = recentReverts.filter(e => e.type === BLOCKED_TYPE).length;
  const recentFailed = recentReverts.length - recentBlocked;
  const warnLine = () => {
    const parts = [recentBlocked ? plural(recentBlocked, 'blocked agent transfer attempt') : '', recentFailed ? plural(recentFailed, 'other reverted transaction') : ''].filter(Boolean).join(' and ');
    return `${parts} in the last ${WARNING_DAYS} days. A reverted call moves no funds; the revert reason is not decoded here, so open the transaction in the explorer.`;
  };
  const caveat = input.failedState === 'unavailable' ? 'Reverted transactions could not be loaded from the block explorer, so failed or blocked attempts cannot be ruled out.' : input.failedState === 'partial' ? 'Only the most recent reverted transactions could be loaded.' : '';
  let status: HealthStatus;

  if (!live.ok) {
    status = 'Unknown'; reasons.push(`The agent's live authorization could not be read from the vault (${live.error}), so its health cannot be verified.`);
  } else if (!live.registered) {
    status = 'Restricted';
    reasons.push(revokedEvent ? `Agent was revoked${revokedEvent.timestamp ? ` on ${fmtDate(revokedEvent.timestamp)}` : ''} and has lost all vault access.` : 'Agent is no longer registered in this vault, so it has no vault access.');
  } else if (live.paused) {
    status = 'Restricted'; reasons.push('Agent is paused by the vault owner. Its transfers are rejected until it is resumed.');
  } else if (input.globalPaused === true) {
    status = 'Restricted'; reasons.push('The vault-wide Emergency Pause is on. Every agent is blocked until the owner resumes agents.');
  } else if (input.globalPaused === null) {
    status = 'Unknown'; reasons.push('The vault-wide Emergency Pause state could not be read, so the agent\'s authorization cannot be fully verified.');
  } else if (!entries) {
    status = 'Unknown'; reasons.push('The vault\'s on-chain event history could not be read, so activity cannot be verified. The agent is registered and not paused.');
  } else if (recentReverts.length && revertedKnown) {
    status = 'Warning'; reasons.push(warnLine());
  } else {
    // Inactivity is measured from the last observed activity, or from registration when there has been none.
    const since = lastActivity ? lastActivity.timestamp : registeredEvent ? registeredEvent.timestamp : 0;
    if (!since) {
      status = 'Unknown'; reasons.push('Event timestamps could not be retrieved, so recent activity cannot be judged.');
    } else if (input.now - since > INACTIVITY_DAYS * DAY) {
      const days = Math.floor((input.now - since) / DAY);
      status = 'Inactive';
      reasons.push(lastActivity ? `No on-chain activity observed since ${fmtDate(since)} (${plural(days, 'day')}). The agent is still registered and authorized.` : `No on-chain activity observed since registration on ${fmtDate(since)} (${plural(days, 'day')}). The agent is still registered and authorized.`);
      reasons.push('Inactivity is not a security problem.');
    } else {
      status = 'Healthy';
      reasons.push('Agent is registered and authorized, and no failed or blocked attempts were observed in the last ' + WARNING_DAYS + ' days.');
      if (!lastActivity) reasons.push(`No transactions observed yet; the agent was registered on ${fmtDate(since)}.`);
    }
    if ((status === 'Healthy' || status === 'Inactive') && caveat) reasons.push(caveat);
  }
  // Restricted agents may also have recent reverted attempts; say so without changing the primary status.
  if (status === 'Restricted' && entries && revertedKnown && recentReverts.length) reasons.push(`Also: ${warnLine()}`);

  return {
    address: a, status, reasons, registration, registeredEvent, revokedEvent, authorization, live,
    lastActivity, lastActivityState: entries ? (lastActivity ? 'observed' : 'none') : 'unavailable', lastSuccess,
    successful, failed, blocked, total, successful7d: windowCount(7), successful30d: windowCount(30), revertedData: input.failedState,
    transactions: observed, securityEvents, daily,
  };
}

const ORDER: Record<HealthStatus, number> = { Warning: 0, Unknown: 1, Restricted: 2, Inactive: 3, Healthy: 4 };

/** Every agent ever registered in the vault (from events, so revoked ones are included) plus the live-registered ones. */
export function computeHealth(input: HealthInput): { agents: AgentHealth[]; counts: Record<HealthStatus, number> } {
  const set = new Set<string>(input.knownAgents.map(low));
  for (const e of input.entries || []) if (e.type === 'Agent registered' && e.agent) set.add(low(e.agent));
  const agents = [...set].map(a => computeAgentHealth(a, input)).sort((x, y) => ORDER[x.status] - ORDER[y.status] || x.address.localeCompare(y.address));
  const counts: Record<HealthStatus, number> = { Healthy: 0, Inactive: 0, Restricted: 0, Warning: 0, Unknown: 0 };
  for (const h of agents) counts[h.status]++;
  return { agents, counts };
}

/** Replays recipient and token permission events (oldest first) to get the set currently approved according to the logs. */
export function currentPermissions(entries: LogEntry[]): { recipients: string[]; tokens: string[] } {
  const asc = [...entries].sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  const recipients = new Set<string>(); const tokens = new Set<string>();
  for (const e of asc) {
    if (e.type === 'Recipient added' && e.recipient) recipients.add(low(e.recipient));
    else if (e.type === 'Recipient removed' && e.recipient) recipients.delete(low(e.recipient));
    else if (e.type === 'Token permission added' && e.token) tokens.add(low(e.token));
    else if (e.type === 'Token permission removed' && e.token) tokens.delete(low(e.token));
  }
  return { recipients: [...recipients], tokens: [...tokens] };
}
