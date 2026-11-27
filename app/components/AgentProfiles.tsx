'use client';

import { Component, useState, type ReactNode } from 'react';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { computeProfiles, type AgentProfile, type PermissionStatus, type ProfilePermissions, type SecurityStatus } from '../lib/agentProfile';
import { computeHealth, type FailedDataState, type LiveAgent } from '../lib/agentHealth';
import { computeRisk } from '../lib/agentRisk';
import type { HealthStatus } from '../lib/agentHealth';
import type { RiskLevel } from '../lib/agentRisk';
import type { LogEntry } from '../lib/activityLog';

type Props = {
  /** 'loading' until the event history and live reads have returned for the first time. */
  state: 'loading' | 'ok' | 'error';
  error: string;
  profiles: AgentProfile[];
  /** Unix seconds at which the live data was read; 0 if it never was. */
  checkedAt: number;
  historyOk: boolean;
  failedState: 'complete' | 'partial' | 'unavailable';
  refreshing: boolean;
  onRefresh: () => void;
  explorerBase: string;
  short: (s: string) => string;
  money: (n: bigint) => string;
  onCopy: (text: string) => void;
};

type Tab = 'overview' | 'config' | 'activity' | 'history';
const TABS: { id: Tab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'config', label: 'Configuration' }, { id: 'activity', label: 'Recent activity' }, { id: 'history', label: 'Security history' }];

const HEALTH_PILL: Record<HealthStatus, string> = { Healthy: '', Warning: 'pill-warn', Restricted: 'pill-stop', Inactive: 'pill-idle', Unknown: 'pill-unk' };
const STATUS_PILL: Record<SecurityStatus, string> = { Active: '', Paused: 'pill-warn', 'Blocked by emergency pause': 'pill-stop', Revoked: 'pill-stop', Unavailable: 'pill-unk' };
const RISK_PILL: Record<RiskLevel, string> = { Low: '', Medium: 'pill-warn', High: 'pill-stop', Critical: 'pill-stop', 'Insufficient data': 'pill-unk' };
const PERM_PILL: Record<PermissionStatus, string> = { Allowed: '', Blocked: 'pill-warn', 'Not allowed': 'pill-idle', Unavailable: 'pill-unk' };
const when = (ts: number) => (ts ? new Date(ts * 1000).toLocaleString() : 'Time unavailable');
const riskText = (l: RiskLevel) => (l === 'Insufficient data' ? l : `${l} risk`);
const cnt = (c: { value: number | null; lowerBound: boolean }) => (c.value === null ? null : c.lowerBound ? `${c.value}+` : String(c.value));
const NA = ({ t = 'Unavailable' }: { t?: string }) => <span className="na">{t}</span>;

function AgentProfilesView(p: Props) {
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const sel = p.profiles.find(x => x.address === selected) || null;

  const open = (addr: string) => { setSelected(addr); setTab('overview'); };
  const close = () => setSelected('');

  const head = (
    <div className="panel-head">
      <div>
        <h3>{sel ? 'Agent security profile' : 'Agent security profiles'}</h3>
        <p>Identity, configuration, health, risk and history of each registered agent in one place. Read-only: profiles never change permissions or vault settings.</p>
      </div>
      <button className="btn btn-ghost btn-sm" disabled={p.refreshing} onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? 'spin' : ''} /> Refresh</button>
    </div>
  );
  const foot = (
    <small className="help">
      {p.checkedAt ? `Last read ${when(p.checkedAt)}. ` : ''}Profiles are rebuilt from the vault contract and its on-chain history each time this page is opened or refreshed; nothing is stored in your browser. They combine the existing Activity &amp; Security Logs, Agent Health Monitoring and Agent Risk Insights results. This is not continuous real-time monitoring. A value shown as Unavailable could not be retrieved and is never treated as zero or as safe.
    </small>
  );

  if (p.state === 'loading') return <section className="panel">{head}<p className="empty">Reading agents and on-chain history from the vault…</p></section>;
  if (p.state === 'error') return <section className="panel">{head}<p className="empty">Could not load agent profiles ({p.error}). This is a loading problem, not an empty vault. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;

  /* ───────── Profile ───────── */
  if (!sel && selected) {
    return <section className="panel">{head}<button className="link" onClick={close}>← All profiles</button><p className="empty">No profile was found for <code>{selected}</code> in this vault. Only agents registered in your connected vault have a profile.</p></section>;
  }

  if (sel) {
    const { identity: id, security: sec, health: h, risk: r, history: hist } = sel;
    const ago = (ts: number) => {
      if (!ts || !p.checkedAt) return '';
      const s = Math.max(0, p.checkedAt - ts); const d = Math.floor(s / 86400); const hr = Math.floor(s / 3600); const m = Math.floor(s / 60);
      return d >= 1 ? `${d} day${d === 1 ? '' : 's'} ago` : hr >= 1 ? `${hr} hour${hr === 1 ? '' : 's'} ago` : m >= 1 ? `${m} min ago` : 'just now';
    };
    const lastActivity = h.lastActivity ? `${when(h.lastActivity.timestamp)}${h.lastActivity.timestamp ? ` · ${ago(h.lastActivity.timestamp)}` : ''}` : h.lastActivityState === 'unavailable' ? null : 'None observed';
    const Val = ({ c }: { c: { value: number | null; lowerBound: boolean } }) => { const t = cnt(c); return t === null ? <NA /> : <>{t}</>; };
    const histMsg = (empty: string) => (hist.available ? empty : 'Unavailable: the vault\'s event history could not be loaded.');
    const pct = sec.maxNativePerDay && sec.nativeSpentToday !== null && sec.maxNativePerDay > 0n ? Math.min(100, Number((sec.nativeSpentToday * 10000n) / sec.maxNativePerDay) / 100) : 0;

    return (
      <>
        <section className="panel sp-hero" data-s={sec.status}>
          {head}
          <button className="link" onClick={close}>← All profiles</button>
          <div className="sp-id">
            <div className="sp-addr">
              <small>Agent wallet</small>
              <code className="mono" title={sel.address}>{sel.address}</code>
            </div>
            <div className="sp-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => p.onCopy(sel.address)} aria-label="Copy agent wallet address"><Copy size={14} /> Copy address</button>
              <a className="btn btn-ghost btn-sm" href={`${p.explorerBase}/address/${sel.address}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Explorer</a>
            </div>
          </div>
          <div className="sp-badges">
            <div><small>Security status</small><span className={`pill ${STATUS_PILL[sec.status]}`}>{sec.status}</span></div>
            <div><small>Health</small><span className={`pill ${HEALTH_PILL[h.status]}`}>{h.status}</span></div>
            <div><small>Risk</small><span className={`pill ${RISK_PILL[r.level]}`}>{riskText(r.level)}</span></div>
            <div><small>Risk score</small><b>{r.score === null ? <NA t="Insufficient data" /> : `${r.score} / 100`}</b></div>
          </div>
          <nav className="sp-tabs" role="tablist" aria-label="Profile sections">
            {TABS.map(t => <button key={t.id} role="tab" id={`sp-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`sp-panel-${t.id}`} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
          </nav>
        </section>

        {tab === 'overview' && (
          <div role="tabpanel" id="sp-panel-overview" aria-labelledby="sp-tab-overview">
            <div className="two">
              <section className="panel">
                <div className="panel-head"><div><h3>Agent identity</h3><p>Read from the vault contract and its registration event.</p></div></div>
                <dl className="hrows">
                  <div><dt>Agent name</dt><dd><NA t="Not recorded on-chain" /></dd></div>
                  <div><dt>Registration</dt><dd>{id.registration === 'Unknown' ? <NA /> : id.registration}</dd></div>
                  <div><dt>Registered</dt><dd>{id.registeredTx ? <>{id.registeredAt ? when(id.registeredAt) : 'Time unavailable'} · <a className="hlink" href={`${p.explorerBase}/tx/${id.registeredTx}`} target="_blank" rel="noreferrer">tx {p.short(id.registeredTx)}</a></> : <NA t={hist.available ? 'Registration event not found' : 'Unavailable'} />}</dd></div>
                  {id.revokedTx && <div><dt>Revoked</dt><dd>{id.revokedAt ? when(id.revokedAt) : 'Time unavailable'} · <a className="hlink" href={`${p.explorerBase}/tx/${id.revokedTx}`} target="_blank" rel="noreferrer">tx {p.short(id.revokedTx)}</a></dd></div>}
                  <div><dt>Protected vault</dt><dd><a className="hlink" href={`${p.explorerBase}/address/${id.vault}`} target="_blank" rel="noreferrer"><code title={id.vault}>{p.short(id.vault)}</code></a> <button className="link" aria-label="Copy vault address" onClick={() => p.onCopy(id.vault)}>Copy</button></dd></div>
                  <div><dt>Vault owner</dt><dd><code title={id.owner}>{p.short(id.owner)}</code></dd></div>
                  <div><dt>Network</dt><dd>Robinhood Chain {id.network.name.toLowerCase()} (chain ID {id.network.chainId})</dd></div>
                </dl>
              </section>
              <section className="panel">
                <div className="panel-head"><div><h3>Health</h3><p>From Agent Health Monitoring.</p></div></div>
                <div className="hwhy"><b>Why this status</b><ul>{h.reasons.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
                <dl className="hrows">
                  <div><dt>Last observed activity</dt><dd>{lastActivity ?? <NA />}</dd></div>
                  <div><dt>Total transactions</dt><dd><Val c={h.total} /></dd></div>
                  <div><dt>Successful</dt><dd><Val c={h.successful} /></dd></div>
                  <div><dt>Failed / blocked</dt><dd>{cnt(h.failed) === null || cnt(h.blocked) === null ? <NA /> : `${cnt(h.failed)} / ${cnt(h.blocked)}`}</dd></div>
                  <div><dt>Successful, last 7 days</dt><dd><Val c={h.successful7d} /></dd></div>
                </dl>
                {h.status === 'Inactive' && <small className="help">Inactivity warning: no on-chain activity for at least 7 days. This is informational, not a security problem.</small>}
                {h.revertedData !== 'complete' && <small className="help">{h.revertedData === 'unavailable' ? 'Reverted transactions could not be loaded from the block explorer, so failed and blocked counts are unavailable.' : 'Only the most recent reverted transactions could be loaded, so failed and blocked counts may be higher than shown (marked +).'}</small>}
              </section>
            </div>

            <section className="panel">
              <div className="panel-head"><div><h3>Risk assessment</h3><p>From Agent Risk Insights: transparent, deterministic scoring of observed on-chain behaviour.</p></div></div>
              <div className="rscore">
                <div><small>Risk score</small><b>{r.score === null ? 'Insufficient data' : `${r.score} / 100`}</b></div>
                <div><small>Classification</small><b>{riskText(r.level)}</b></div>
                <div><small>Confidence</small><b>{r.confidence === 'None' ? 'None' : r.confidence}</b></div>
              </div>
              {r.score !== null && <div className="rbar" role="img" aria-label={`Risk score ${r.score} out of 100`}><i data-level={r.level} style={{ width: `${r.score}%` }} /></div>}
              <div className="hwhy"><b>Why this score</b><ul>{r.explanation.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
              <b className="hsub">Detected risk factors ({r.findings.length})</b>
              {r.findings.length ? (
                <ul className="revidence">{r.findings.map(f => <li key={f.id}><span><b>{f.title}</b> · {f.summary}</span><small>+{f.points} points · {f.kind === 'confirmed' ? 'confirmed on-chain' : 'behavioural indicator'} · {f.severity} severity · latest {when(f.latest)}</small></li>)}</ul>
              ) : <p className="empty">{r.score === null ? 'Not enough evidence to assess this agent.' : 'No risk factors were detected in the available data.'}</p>}
              <b className="hsub">Security recommendations</b>
              {r.recommendations.length ? <ul className="rnotes">{r.recommendations.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="empty">No action suggested.</p>}
              {r.confidenceNotes.length > 0 && <small className="help">{r.confidenceNotes.join(' ')}</small>}
              {r.checksNotPerformed.length > 0 && <small className="help">Checks not performed: {r.checksNotPerformed.join(' ')}</small>}
            </section>
          </div>
        )}

        {tab === 'config' && (
          <div role="tabpanel" id="sp-panel-config" aria-labelledby="sp-tab-config">
            <div className="two">
              <section className="panel">
                <div className="panel-head"><div><h3>Spending limits</h3><p>Native coin limits enforced for this agent by the vault contract.</p></div></div>
                <dl className="hrows">
                  <div><dt>Current status</dt><dd><span className={`pill ${STATUS_PILL[sec.status]}`}>{sec.status}</span></dd></div>
                  <div><dt>Agent paused</dt><dd>{sec.agentPaused === null ? <NA t={sec.status === 'Revoked' ? 'Not applicable (revoked)' : 'Unavailable'} /> : sec.agentPaused ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Vault Emergency Pause</dt><dd>{sec.globalPaused === null ? <NA /> : sec.globalPaused ? 'On: all agents blocked' : 'Off'}</dd></div>
                  <div><dt>Max / transaction</dt><dd>{sec.maxNativePerTx === null ? <NA t={sec.status === 'Revoked' ? 'None (revoked)' : 'Unavailable'} /> : p.money(sec.maxNativePerTx)}</dd></div>
                  <div><dt>Max / UTC day</dt><dd>{sec.maxNativePerDay === null ? <NA t={sec.status === 'Revoked' ? 'None (revoked)' : 'Unavailable'} /> : p.money(sec.maxNativePerDay)}</dd></div>
                  <div><dt>Spent this UTC day</dt><dd>{sec.nativeSpentToday === null ? <NA /> : <span className="spent">{p.money(sec.nativeSpentToday)}<span className="meter"><i style={{ width: `${pct}%` }} /></span></span>}</dd></div>
                  <div><dt>Remaining today</dt><dd>{sec.nativeRemainingToday === null ? <NA /> : p.money(sec.nativeRemainingToday)}</dd></div>
                </dl>
              </section>
              <section className="panel">
                <div className="panel-head"><div><h3>Transaction permissions</h3><p>What this agent can do through the vault right now.</p></div></div>
                <ul className="sp-perms">
                  {sec.permissions.map(x => <li key={x.id}><div><b>{x.label}</b><span className={`pill ${PERM_PILL[x.status]}`}>{x.status}</span></div><small>{x.detail}</small></li>)}
                </ul>
              </section>
            </div>

            <section className="panel">
              <div className="panel-head"><div><h3>Approved recipients</h3><p>AgentGuard V1 applies the recipient list vault-wide, so it is shared by every agent, not just this one.</p></div></div>
              {sec.recipients === null ? <p className="empty">Approved recipients are unavailable right now.</p> : sec.recipients.length ? sec.recipients.map(a => <div className="addr-row" key={a}><code>{a}</code><button className="link" aria-label="Copy recipient address" onClick={() => p.onCopy(a)}>Copy</button></div>) : <p className="empty">No recipient addresses approved, so this agent cannot send anything yet.</p>}
            </section>

            <section className="panel">
              <div className="panel-head"><div><h3>Token policies</h3><p>Approved ERC-20 tokens and their limits. These are vault-wide, and each token&apos;s daily cap is shared by all agents. Agents can only call transfer; token approvals are not possible in V1.</p></div></div>
              {sec.tokens === null ? <p className="empty">Approved tokens are unavailable right now.</p> : sec.tokens.length ? sec.tokens.map(t => <div className="addr-row" key={t.address}><code>{t.address}</code><small className="mono">{t.maxPerTx.toString()} / tx · {t.maxPerDay.toString()} / day (token units)</small></div>) : <p className="empty">No token contracts approved.</p>}
            </section>
          </div>
        )}

        {tab === 'activity' && (
          <div role="tabpanel" id="sp-panel-activity" aria-labelledby="sp-tab-activity">
            <section className="panel">
              <div className="panel-head"><div><h3>Recent transactions</h3><p>This agent&apos;s transfers{h.revertedData === 'unavailable' ? '' : ' and reverted attempts'}, newest first.</p></div></div>
              <Events rows={hist.transactions} empty={histMsg('No transactions observed for this agent.')} {...p} />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h3>Failed or rejected attempts</h3><p>Calls from this wallet to the vault that reverted. A reverted call moves no funds.</p></div></div>
              {h.revertedData === 'unavailable' ? <p className="empty">Unavailable: reverted transactions could not be loaded from the block explorer.</p> : <Events rows={hist.failed} empty={histMsg('No failed or rejected attempts observed for this agent.')} {...p} />}
              {h.revertedData === 'partial' && <small className="help">Only the most recent reverted transactions could be loaded, so older attempts may be missing.</small>}
              <small className="help">The revert reason is not decoded here; open the transaction in the explorer for details.</small>
            </section>
          </div>
        )}

        {tab === 'history' && (
          <div role="tabpanel" id="sp-panel-history" aria-labelledby="sp-tab-history">
            <section className="panel">
              <div className="panel-head"><div><h3>Security events</h3><p>Events about this agent, reverted attempts, and vault-wide Emergency Pause changes that affect every agent.</p></div></div>
              <Events rows={hist.securityEvents} empty={histMsg('No security events observed for this agent.')} {...p} />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h3>Registration &amp; management events</h3><p>Registration, limit changes, pause or resume, and revocation of this agent.</p></div></div>
              <Events rows={hist.management} empty={histMsg('No registration or management events found for this agent.')} {...p} />
            </section>
          </div>
        )}
        {foot}
      </>
    );
  }

  /* ───────── Profile list ───────── */
  const counts = { total: p.profiles.length, active: p.profiles.filter(x => x.security.status === 'Active').length, attention: p.profiles.filter(x => x.risk.level === 'Medium' || x.risk.level === 'High' || x.risk.level === 'Critical' || x.health.status === 'Warning').length, revoked: p.profiles.filter(x => x.security.status === 'Revoked').length };
  return (
    <section className="panel">
      {head}
      <div className="hsum" aria-label="Profile summary">
        <span className="pill">Profiles <b>{counts.total}</b></span>
        <span className="pill">Active <b>{counts.active}</b></span>
        <span className="pill pill-warn">Need attention <b>{counts.attention}</b></span>
        <span className="pill pill-idle">Revoked <b>{counts.revoked}</b></span>
      </div>
      {!p.historyOk && <div className="warning"><span>The vault&apos;s event history could not be read. Agents currently registered are listed from the live contract, but registration dates, activity and risk are unavailable until it loads. <button className="link" onClick={p.onRefresh}>Retry</button></span></div>}
      {!p.profiles.length && <p className="empty">{p.historyOk ? 'No agents have been registered in this vault yet. Register an agent from the My agents page and its profile will appear here.' : 'No agents could be listed.'}</p>}
      <div className="hgrid">
        {p.profiles.map(x => {
          const last = x.health.lastActivity ? when(x.health.lastActivity.timestamp) : x.health.lastActivityState === 'unavailable' ? null : 'None observed';
          return (
            <article className="hcard" data-s={x.health.status} key={x.address}>
              <div className="hcard-head">
                <code className="mono" title={x.address}>{p.short(x.address)}</code>
                <span className={`pill ${STATUS_PILL[x.security.status]}`}>{x.security.status}</span>
              </div>
              <div className="sp-card-pills">
                <span className={`pill ${HEALTH_PILL[x.health.status]}`}>{x.health.status}</span>
                <span className={`pill ${RISK_PILL[x.risk.level]}`}>{riskText(x.risk.level)}{x.risk.score !== null ? ` · ${x.risk.score}` : ''}</span>
              </div>
              <dl className="hmetrics">
                <div><dt>Registration</dt><dd>{x.identity.registration === 'Unknown' ? <NA /> : x.identity.registration}</dd></div>
                <div><dt>Registered</dt><dd>{x.identity.registeredAt ? new Date(x.identity.registeredAt * 1000).toLocaleDateString() : <NA />}</dd></div>
                <div><dt>Max / tx</dt><dd>{x.security.maxNativePerTx === null ? <NA t="—" /> : p.money(x.security.maxNativePerTx)}</dd></div>
                <div><dt>Max / day</dt><dd>{x.security.maxNativePerDay === null ? <NA t="—" /> : p.money(x.security.maxNativePerDay)}</dd></div>
                <div><dt>Last activity</dt><dd>{last ?? <NA />}</dd></div>
                <div><dt>Security events</dt><dd>{x.history.available ? x.history.securityEvents.length : <NA />}</dd></div>
              </dl>
              <div className="hcard-foot">
                <button className="btn btn-ghost btn-sm" onClick={() => open(x.address)}>Open profile</button>
                <a className="link" href={`${p.explorerBase}/address/${x.address}`} target="_blank" rel="noreferrer">Explorer <ExternalLink size={13} /></a>
              </div>
            </article>
          );
        })}
      </div>
      {foot}
    </section>
  );
}

function Events({ rows, empty, explorerBase, short }: { rows: LogEntry[]; empty: string; explorerBase: string; short: (s: string) => string }) {
  const [limit, setLimit] = useState(10);
  return (
    <>
      <div className="events hevlist">
        {rows.slice(0, limit).map(e => (
          <div className={`event ${e.status === 'Success' && e.categories.includes('transaction') ? 'event-good' : ''}`} key={e.key}>
            <i aria-hidden="true" />
            <div className="log-body">
              <b>{e.type} <span className={`pill ${e.status === 'Failed' ? 'pill-stop' : ''}`}>{e.status}</span></b>
              <small>{e.description}</small>
              <small className="log-meta">
                <span>{when(e.timestamp)} · Block {e.blockNumber}</span>
                {e.recipient && <span>Recipient <code title={e.recipient}>{short(e.recipient)}</code></span>}
                {e.amountText && <span>Amount {e.amountText}</span>}
                <span>Tx <a href={`${explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer"><code title={e.hash}>{short(e.hash)}</code></a></span>
              </small>
            </div>
            <a title="Open transaction in explorer" aria-label="Open transaction in explorer" href={`${explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
          </div>
        ))}
        {!rows.length && <p className="empty">{empty}</p>}
      </div>
      {rows.length > limit && <button className="btn btn-ghost btn-sm" onClick={() => setLimit(n => n + 10)}>Show more ({rows.length - limit} remaining)</button>}
    </>
  );
}

/* ───────── Isolated entry point used by app/page.tsx ───────── */
type SectionProps = Omit<Props, 'state' | 'error' | 'profiles' | 'checkedAt' | 'historyOk'> & {
  loading: boolean; wrongChain: boolean; chain: number;
  live: { live: Map<string, LiveAgent>; globalPaused: boolean | null; permissions: ProfilePermissions | null; checkedAt: number } | null;
  entries: LogEntry[] | null; knownAgents: string[];
  vault: string; owner: string; chainId: number; networkName: string; native: (n: bigint) => string;
};

/** A render error in Agent Security Profiles is caught here and shown inline; it can never blank the dashboard or hide the agent list. */
class ProfilesBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: string }> {
  state = { failed: '' };
  static getDerivedStateFromError(e: unknown) { return { failed: String((e as any)?.message || e).slice(0, 160) }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel"><div className="panel-head"><div><h3>Agent security profiles</h3></div></div><p className="empty">Profiles could not be displayed ({this.state.failed}). Your agents, vault and every other page are not affected. <button className="link" onClick={() => { this.setState({ failed: '' }); this.props.onRetry(); }}>Retry</button></p></section>;
  }
}

function ProfilesCompute(s: SectionProps) {
  const entries = s.entries;
  const health = s.live ? computeHealth({ entries, failedState: s.failedState as FailedDataState, live: s.live.live, globalPaused: s.live.globalPaused, knownAgents: s.knownAgents, now: s.live.checkedAt }) : null;
  const rctx = { now: s.live?.checkedAt || Math.floor(Date.now() / 1000), failedState: s.failedState as FailedDataState, short: s.short, native: s.native };
  const risk = computeRisk(health?.agents || [], entries, rctx);
  const profiles = s.live && health ? computeProfiles(health.agents, risk.agents, { vault: s.vault, owner: s.owner, chainId: s.chainId, networkName: s.networkName, explorer: s.explorerBase, permissions: s.live.permissions, globalPaused: s.live.globalPaused, entries, now: s.live.checkedAt }) : [];
  return <AgentProfilesView state={s.wrongChain ? 'error' : s.loading ? 'loading' : 'ok'} error={`your wallet is on chain ${s.chain}; switch to chain ${s.chainId}`} profiles={profiles} checkedAt={s.live?.checkedAt || 0} historyOk={entries !== null} failedState={s.failedState} refreshing={s.refreshing} onRefresh={s.onRefresh} explorerBase={s.explorerBase} short={s.short} money={s.money} onCopy={s.onCopy} />;
}

export default function AgentProfilesSection(s: SectionProps) {
  return <ProfilesBoundary onRetry={s.onRefresh}><ProfilesCompute {...s} /></ProfilesBoundary>;
}
