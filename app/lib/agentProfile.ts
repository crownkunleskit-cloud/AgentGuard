/**
 * Agent Security Profiles: assembles one profile per agent from data AgentGuard already reads.
 *
 * Nothing here talks to the network and nothing is stored. Inputs are the results of the existing features:
 *  - Agent Health Monitoring (agentHealth.computeHealth): registration, authorization, live agents(address) read,
 *    last activity, the agent's own transactions and security events.
 *  - Agent Risk Insights (agentRisk.computeRisk): score, level, findings, recommendations.
 *  - The Activity & Security Logs entries (activityLog.buildEntries): registration and management events.
 *  - The live approved recipient / token reads already performed for Agent Health.
 * Pure functions, no ethers or React dependency, so they can be tested in isolation.
 *
 * Rules (same as the rest of the app): a value that cannot be established is `null` / 'Unavailable', never 0 or a guess.
 * Registration dates and security events come only from decoded on-chain events. The profile is read-only
 * visibility: it never changes permissions, limits or vault settings.
 */
import type { LogEntry } from './activityLog';
import type { AgentHealth } from './agentHealth';
import type { AgentRisk } from './agentRisk';

export type PermissionStatus = 'Allowed' | 'Blocked' | 'Not allowed' | 'Unavailable';
export type SecurityStatus = 'Active' | 'Paused' | 'Blocked by emergency pause' | 'Revoked' | 'Unavailable';

export type TokenPolicy = { address: string; maxPerTx: bigint; maxPerDay: bigint };
export type ProfilePermissions = { recipients: string[]; tokens: TokenPolicy[] };

export type ProfileContext = {
  vault: string;
  /** The connected owner wallet, which is the vault owner (the vault is looked up from the factory by this address). */
  owner: string;
  chainId: number;
  networkName: string;
  explorer: string;
  /** null when the approved recipients/tokens could not be read. */
  permissions: ProfilePermissions | null;
  /** null when globallyPaused() could not be read. */
  globalPaused: boolean | null;
  /** null when the vault's event history could not be read. */
  entries: LogEntry[] | null;
  /** Unix seconds at which the live data was read. */
  now: number;
};

export type PermissionRow = { id: 'native' | 'erc20' | 'approve' | 'arbitrary'; label: string; status: PermissionStatus; detail: string };

export type AgentProfile = {
  address: string;
  identity: {
    registration: AgentHealth['registration'];
    registeredAt: number | null;       // unix seconds; null = not available (event missing or no timestamp)
    registeredTx: string | null;
    registeredBlock: number | null;
    revokedAt: number | null;
    revokedTx: string | null;
    vault: string; owner: string;
    network: { name: string; chainId: number; explorer: string };
    /** AgentGuard V1 stores no agent name on-chain. */
    name: null;
  };
  security: {
    status: SecurityStatus;
    agentPaused: boolean | null;
    globalPaused: boolean | null;
    maxNativePerTx: bigint | null;
    maxNativePerDay: bigint | null;
    nativeSpentToday: bigint | null;
    nativeRemainingToday: bigint | null;
    /** Vault-wide in V1: the same list applies to every agent. null = unavailable. */
    recipients: string[] | null;
    tokens: TokenPolicy[] | null;
    permissions: PermissionRow[];
  };
  health: AgentHealth;
  risk: AgentRisk;
  history: {
    /** This agent's successful transfers and reverted attempts, newest first. */
    transactions: LogEntry[];
    /** Reverted attempts only (a subset of `transactions`), newest first. */
    failed: LogEntry[];
    /** This agent's security events plus vault-wide Emergency Pause changes, newest first. */
    securityEvents: LogEntry[];
    /** Registration, limit, pause/resume and revoke events for this agent, newest first. */
    management: LogEntry[];
    /** false when the event history could not be read: then every list above is empty because it is unavailable, not because nothing happened. */
    available: boolean;
  };
};

const low = (a?: string) => (a || '').toLowerCase();
const newestFirst = (a: LogEntry, b: LogEntry) => b.blockNumber - a.blockNumber || b.index - a.index;
const MANAGEMENT_TYPES = ['Agent registered', 'Spending limits changed', 'Agent paused', 'Agent resumed', 'Agent revoked'];

/** Overall status shown in the profile header. Derived only from the live contract read the Health feature already performed. */
function statusOf(h: AgentHealth): SecurityStatus {
  switch (h.authorization) {
    case 'Authorized': return 'Active';
    case 'Paused by owner': return 'Paused';
    case 'Blocked by emergency pause': return 'Blocked by emergency pause';
    case 'Revoked': return 'Revoked';
    default: return 'Unavailable';
  }
}

function permissionRows(h: AgentHealth, status: SecurityStatus, perms: ProfilePermissions | null): PermissionRow[] {
  const gate = (): { s: PermissionStatus; why: string } =>
    status === 'Active' ? { s: 'Allowed', why: '' }
    : status === 'Paused' ? { s: 'Blocked', why: 'The agent is paused by the vault owner.' }
    : status === 'Blocked by emergency pause' ? { s: 'Blocked', why: 'The vault-wide Emergency Pause is on.' }
    : status === 'Revoked' ? { s: 'Not allowed', why: 'The agent is revoked and has no vault access.' }
    : { s: 'Unavailable', why: 'The agent\'s live authorization could not be read.' };
  const g = gate();

  const native: PermissionRow = g.s === 'Allowed'
    ? { id: 'native', label: 'Native coin transfers', status: 'Allowed', detail: 'To approved recipients only, within the per-transaction and daily limits.' }
    : { id: 'native', label: 'Native coin transfers', status: g.s, detail: g.why };

  let erc20: PermissionRow;
  if (g.s !== 'Allowed') erc20 = { id: 'erc20', label: 'Direct ERC-20 transfers', status: g.s, detail: g.why };
  else if (!perms) erc20 = { id: 'erc20', label: 'Direct ERC-20 transfers', status: 'Unavailable', detail: 'The approved token list could not be read.' };
  else if (!perms.tokens.length) erc20 = { id: 'erc20', label: 'Direct ERC-20 transfers', status: 'Not allowed', detail: 'No ERC-20 token is approved in this vault.' };
  else erc20 = { id: 'erc20', label: 'Direct ERC-20 transfers', status: 'Allowed', detail: `For ${perms.tokens.length} approved token${perms.tokens.length === 1 ? '' : 's'}, to approved recipients, within each token's limits.` };

  return [
    native, erc20,
    // Fixed properties of the AgentGuard V1 contract source (AgentGuardVault.sol): there is no approve or arbitrary-call function.
    { id: 'approve', label: 'Token approvals (approve)', status: 'Not allowed', detail: 'The V1 vault contract has no approve function. An agent can never grant a spender an allowance through the vault.' },
    { id: 'arbitrary', label: 'Arbitrary contract calls', status: 'Not allowed', detail: 'The V1 vault only exposes native and direct ERC-20 transfers. DEX swaps and other contract calls are not possible.' },
  ];
}

export function computeAgentProfile(health: AgentHealth, risk: AgentRisk, ctx: ProfileContext): AgentProfile {
  const a = low(health.address);
  const status = statusOf(health);
  const live = health.live.ok ? health.live : null;
  const registered = live ? live.registered : null;

  // Native spend today follows the same rule as Agent Health: a stored day that is not today means nothing spent yet today.
  const today = Math.floor(ctx.now / 86400);
  const spent = live && live.registered ? (Number(live.dayStart) === today ? live.nativeSpentToday : 0n) : null;
  const perTx = live && live.registered ? live.maxNativePerTx : null;
  const perDay = live && live.registered ? live.maxNativePerDay : null;
  const remaining = perDay !== null && spent !== null ? (perDay > spent ? perDay - spent : 0n) : null;

  const entries = ctx.entries ? [...ctx.entries].sort(newestFirst) : [];
  const management = ctx.entries ? entries.filter(e => low(e.agent) === a && MANAGEMENT_TYPES.includes(e.type)) : [];
  const failed = health.transactions.filter(e => e.status === 'Failed');

  return {
    address: a,
    identity: {
      registration: health.registration,
      registeredAt: health.registeredEvent && health.registeredEvent.timestamp > 0 ? health.registeredEvent.timestamp : null,
      registeredTx: health.registeredEvent?.hash ?? null,
      registeredBlock: health.registeredEvent?.blockNumber ?? null,
      revokedAt: health.revokedEvent && health.revokedEvent.timestamp > 0 ? health.revokedEvent.timestamp : null,
      revokedTx: health.revokedEvent?.hash ?? null,
      vault: ctx.vault, owner: ctx.owner,
      network: { name: ctx.networkName, chainId: ctx.chainId, explorer: ctx.explorer },
      name: null,
    },
    security: {
      status,
      agentPaused: live && registered ? live.paused : null,
      globalPaused: ctx.globalPaused,
      maxNativePerTx: perTx, maxNativePerDay: perDay, nativeSpentToday: spent, nativeRemainingToday: remaining,
      recipients: ctx.permissions ? ctx.permissions.recipients : null,
      tokens: ctx.permissions ? ctx.permissions.tokens : null,
      permissions: permissionRows(health, status, ctx.permissions),
    },
    health, risk,
    history: { transactions: health.transactions, failed, securityEvents: health.securityEvents, management, available: ctx.entries !== null },
  };
}

/** One profile per agent in the Health result (every agent ever registered in the vault, revoked ones included). Order follows `health`. */
export function computeProfiles(health: AgentHealth[], risks: AgentRisk[], ctx: ProfileContext): AgentProfile[] {
  const riskBy = new Map(risks.map(r => [low(r.address), r]));
  const out: AgentProfile[] = [];
  for (const h of health) { const r = riskBy.get(low(h.address)); if (r) out.push(computeAgentProfile(h, r, ctx)); }
  return out;
}
