'use client';

import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { INACTIVITY_DAYS, WARNING_DAYS, type AgentHealth as Health, type Count, type HealthStatus } from '../lib/agentHealth';

export type HealthPermissions = { recipients: string[]; tokens: { address: string; maxPerTx: bigint; maxPerDay: bigint }[] };

type Props = {
  /** 'loading' until both the event history and the live contract reads have returned for the first time. */
  state: 'loading' | 'ok' | 'error';
  error: string;
  agents: Health[];
  counts: Record<HealthStatus, number>;
  /** Unix seconds at which the live data was read; 0 if it never was. */
  checkedAt: number;
  /** null = approved recipients/tokens could not be read or verified. */
  permissions: HealthPermissions | null;
  historyOk: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  explorerBase: string;
  short: (s: string) => string;
  money: (n: bigint) => string;
  /** Optional: open straight into one agent's detail view. */
  initialSelected?: string;
};

const PILL: Record<HealthStatus, string> = { Healthy: '', Warning: 'pill-warn', Restricted: 'pill-stop', Inactive: 'pill-idle', Unknown: 'pill-unk' };
const ORDER: HealthStatus[] = ['Healthy', 'Warning', 'Restricted', 'Inactive', 'Unknown'];
const count = (c: Count) => (c.value === null ? null : c.lowerBound ? `${c.value}+` : String(c.value));
const when = (ts: number) => (ts ? new Date(ts * 1000).toLocaleString() : 'Time unavailable');

export default function AgentHealthView(p: Props) {
  const [selected, setSelected] = useState(p.initialSelected || '');
  const sel = p.agents.find(a => a.address === selected) || null;
  const ago = (ts: number) => {
    if (!ts || !p.checkedAt) return '';
    const s = Math.max(0, p.checkedAt - ts); const d = Math.floor(s / 86400); const h = Math.floor(s / 3600); const m = Math.floor(s / 60);
    return d >= 1 ? `${d} day${d === 1 ? '' : 's'} ago` : h >= 1 ? `${h} hour${h === 1 ? '' : 's'} ago` : m >= 1 ? `${m} min ago` : 'just now';
  };
  const Val = ({ c }: { c: Count }) => { const t = count(c); return t === null ? <span className="na">Unavailable</span> : <>{t}</>; };
  const lastText = (h: Health) => h.lastActivity ? `${when(h.lastActivity.timestamp)}${h.lastActivity.timestamp ? ` · ${ago(h.lastActivity.timestamp)}` : ''}` : h.lastActivityState === 'unavailable' ? null : 'None observed';

  const head = (
    <div className="panel-head">
      <div>
        <h3>{sel ? 'Agent monitoring detail' : 'Agent health'}</h3>
        <p>Status, activity and security condition of every agent registered in this vault, read from your vault contract&apos;s on-chain history.</p>
      </div>
      <button className="btn btn-ghost btn-sm" disabled={p.refreshing} onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? 'spin' : ''} /> Refresh</button>
    </div>
  );
  const foot = (
    <small className="help">
      {p.checkedAt ? `Last checked ${when(p.checkedAt)}. ` : ''}This is not continuous real-time monitoring: the vault is checked when this page is opened or refreshed, and &quot;last observed activity&quot; is the most recent on-chain event found at that time.
      Inactive means no activity in {INACTIVITY_DAYS} days and is not a security problem. Warning means a failed or blocked attempt in the last {WARNING_DAYS} days. A value shown as Unavailable could not be retrieved; it is never treated as zero.
    </small>
  );

  if (p.state === 'loading') return <section className="panel">{head}<p className="empty">Reading agents and on-chain history from the vault…</p></section>;
  if (p.state === 'error') return <section className="panel">{head}<p className="empty">Could not load agent health ({p.error}). This is a loading problem, not an empty vault. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;

  /* ───────── Detail view ───────── */
  if (sel) {
    const live = sel.live;
    const today = Math.floor(p.checkedAt / 86400);
    const spent = live.ok ? (Number(live.dayStart) === today ? live.nativeSpentToday : 0n) : null;
    const maxBar = sel.daily ? Math.max(1, ...sel.daily.map(d => d.successful + (d.reverted || 0))) : 1;
    return (
      <>
        <section className="panel">
          {head}
          <button className="link" onClick={() => setSelected('')}>← All agents</button>
          <div className="hdetail-id">
            <code className="mono" title={sel.address}>{sel.address}</code>
            <span className={`pill ${PILL[sel.status]}`}>{sel.status}</span>
            <a className="btn btn-ghost btn-sm" href={`${p.explorerBase}/address/${sel.address}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> View on Robinhood Chain Explorer</a>
          </div>
          <div className="hwhy">
            <b>Why this status</b>
            <ul>{sel.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
        </section>

        <div className="two">
          <section className="panel">
            <div className="panel-head"><div><h3>Registration &amp; authorization</h3><p>Current state read from the vault contract.</p></div></div>
            <dl className="hrows">
              <div><dt>Agent name</dt><dd className="na">Not recorded on-chain</dd></div>
              <div><dt>Registration</dt><dd>{sel.registration}</dd></div>
              <div><dt>Registered</dt><dd>{sel.registeredEvent ? <>{when(sel.registeredEvent.timestamp)} · <a className="hlink" href={`${p.explorerBase}/tx/${sel.registeredEvent.hash}`} target="_blank" rel="noreferrer">tx {p.short(sel.registeredEvent.hash)}</a></> : <span className="na">Registration event not found</span>}</dd></div>
              {sel.revokedEvent && <div><dt>Revoked</dt><dd>{when(sel.revokedEvent.timestamp)} · <a className="hlink" href={`${p.explorerBase}/tx/${sel.revokedEvent.hash}`} target="_blank" rel="noreferrer">tx {p.short(sel.revokedEvent.hash)}</a></dd></div>}
              <div><dt>Authorization</dt><dd>{sel.authorization === 'Unknown' ? <span className="na">Unavailable</span> : sel.authorization}</dd></div>
              {live.ok && live.registered && <>
                <div><dt>Max / transaction</dt><dd>{p.money(live.maxNativePerTx)}</dd></div>
                <div><dt>Max / UTC day</dt><dd>{p.money(live.maxNativePerDay)}</dd></div>
                <div><dt>Spent this UTC day</dt><dd>{spent === null ? <span className="na">Unavailable</span> : p.money(spent)}</dd></div>
              </>}
            </dl>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h3>Transaction statistics</h3><p>Observed through this vault only.</p></div></div>
            <dl className="hrows">
              <div><dt>Total observed</dt><dd><Val c={sel.total} /></dd></div>
              <div><dt>Successful</dt><dd><Val c={sel.successful} /></dd></div>
              <div><dt>Failed (reverted)</dt><dd><Val c={sel.failed} /></dd></div>
              <div><dt>Blocked attempts</dt><dd><Val c={sel.blocked} /></dd></div>
              <div><dt>Successful, last 7 days</dt><dd><Val c={sel.successful7d} /></dd></div>
              <div><dt>Successful, last 30 days</dt><dd><Val c={sel.successful30d} /></dd></div>
              <div><dt>Last observed activity</dt><dd>{lastText(sel) ?? <span className="na">Unavailable</span>}</dd></div>
              <div><dt>Last successful transaction</dt><dd>{sel.lastSuccess ? <><a className="hlink" href={`${p.explorerBase}/tx/${sel.lastSuccess.hash}`} target="_blank" rel="noreferrer">{when(sel.lastSuccess.timestamp)}</a></> : sel.lastActivityState === 'unavailable' ? <span className="na">Unavailable</span> : 'None observed'}</dd></div>
            </dl>
            {sel.revertedData !== 'complete' && <small className="help">{sel.revertedData === 'unavailable' ? 'Reverted transactions could not be loaded from the block explorer, so failed and blocked counts are unavailable.' : 'Only the most recent reverted transactions could be loaded, so failed and blocked counts may be higher than shown (marked +).'}</small>}
            <small className="help">A reverted call emits no contract event and its reason is not decoded here. &quot;Blocked&quot; means a reverted call to a transfer function; &quot;Failed&quot; is any other reverted call from this wallet to the vault.</small>
          </section>
        </div>

        <section className="panel">
          <div className="panel-head"><div><h3>Activity over time</h3><p>Observed activity per UTC day, last 14 days.</p></div></div>
          {sel.daily ? (
            <>
              <div className="hbars" role="img" aria-label="Observed agent activity per day for the last 14 days">
                {sel.daily.map(d => (
                  <div key={d.dayStart} title={`${new Date(d.dayStart * 1000).toISOString().slice(0, 10)}: ${d.successful} successful${d.reverted === null ? '' : `, ${d.reverted} reverted`}`}>
                    <span className="hbar"><i className="rev" style={{ height: `${((d.reverted || 0) / maxBar) * 100}%` }} /><i style={{ height: `${(d.successful / maxBar) * 100}%` }} /></span>
                    <small>{new Date(d.dayStart * 1000).getUTCDate()}</small>
                  </div>
                ))}
              </div>
              <small className="help">Brass: successful transfers. Red: reverted attempts{sel.revertedData === 'unavailable' ? ' (not available right now, so not drawn)' : ''}. Days with no bar had no observed activity.</small>
            </>
          ) : <p className="empty">Activity over time is unavailable because event timestamps could not be retrieved.</p>}
        </section>

        <section className="panel">
          <div className="panel-head"><div><h3>Recent transactions</h3><p>This agent&apos;s transfers{sel.revertedData === 'unavailable' ? '' : ' and reverted attempts'}, newest first.</p></div></div>
          <Events rows={sel.transactions} empty={sel.lastActivityState === 'unavailable' ? 'Transaction history is unavailable.' : 'No transactions observed for this agent.'} {...p} />
        </section>

        <section className="panel">
          <div className="panel-head"><div><h3>Recent security events</h3><p>Events about this agent, plus vault-wide Emergency Pause changes that affect every agent.</p></div></div>
          <Events rows={sel.securityEvents} empty={sel.lastActivityState === 'unavailable' ? 'Event history is unavailable.' : 'No security events observed for this agent.'} {...p} />
        </section>

        <section className="panel">
          <div className="panel-head"><div><h3>Approved recipients &amp; token permissions</h3><p>AgentGuard V1 applies these vault-wide, so they apply to every agent, not just this one.</p></div></div>
          {p.permissions ? (
            <>
              <b className="hsub">Approved recipients ({p.permissions.recipients.length})</b>
              {p.permissions.recipients.length ? p.permissions.recipients.map(a => <div className="addr-row" key={a}><code>{a}</code></div>) : <p className="empty">No recipient addresses approved, so this agent cannot send anything yet.</p>}
              <b className="hsub">Approved tokens ({p.permissions.tokens.length})</b>
              {p.permissions.tokens.length ? p.permissions.tokens.map(t => <div className="addr-row" key={t.address}><code>{t.address}</code><small className="mono">{t.maxPerTx.toString()} / tx · {t.maxPerDay.toString()} / day (token units)</small></div>) : <p className="empty">No token contracts approved.</p>}
            </>
          ) : <p className="empty">Approved recipients and tokens are unavailable right now.</p>}
        </section>
        {foot}
      </>
    );
  }

  /* ───────── Agent cards ───────── */
  return (
    <section className="panel">
      {head}
      <div className="hsum" aria-label="Agents by health status">
        {ORDER.map(s => <span key={s} className={`pill ${PILL[s]}`}>{s} <b>{p.counts[s]}</b></span>)}
      </div>
      {!p.historyOk && <div className="warning"><span>The vault&apos;s event history could not be read. Agents currently registered are listed from the live contract, but revoked agents, activity and metrics are unavailable until it loads. <button className="link" onClick={p.onRefresh}>Retry</button></span></div>}
      {!p.agents.length && <p className="empty">{p.historyOk ? 'No agents have been registered in this vault yet.' : 'No agents could be listed.'}</p>}
      <div className="hgrid">
        {p.agents.map(h => {
          const last = lastText(h);
          return (
            <article className="hcard" data-s={h.status} key={h.address}>
              <div className="hcard-head">
                <code className="mono" title={h.address}>{p.short(h.address)}</code>
                <span className={`pill ${PILL[h.status]}`}>{h.status}</span>
              </div>
              <small className="hname">Name: not recorded on-chain · <span title={h.address}>{h.address}</span></small>
              <p className="hreason">{h.reasons[0]}</p>
              <dl className="hmetrics">
                <div><dt>Registration</dt><dd>{h.registration === 'Unknown' ? <span className="na">Unavailable</span> : h.registration}</dd></div>
                <div><dt>Authorization</dt><dd>{h.authorization === 'Unknown' ? <span className="na">Unavailable</span> : h.authorization}</dd></div>
                <div><dt>Last observed activity</dt><dd>{last ?? <span className="na">Unavailable</span>}</dd></div>
                <div><dt>Total transactions</dt><dd><Val c={h.total} /></dd></div>
                <div><dt>Successful</dt><dd><Val c={h.successful} /></dd></div>
                <div><dt>Failed</dt><dd><Val c={h.failed} /></dd></div>
                <div><dt>Blocked attempts</dt><dd><Val c={h.blocked} /></dd></div>
                <div><dt>Security events</dt><dd>{h.lastActivityState === 'unavailable' ? <span className="na">Unavailable</span> : h.securityEvents.length}</dd></div>
              </dl>
              {h.lastActivityState !== 'unavailable' && h.securityEvents.length > 0 && (
                <ul className="hevents">{h.securityEvents.slice(0, 2).map(e => <li key={e.key}><b>{e.type}</b> <small>{e.timestamp ? new Date(e.timestamp * 1000).toLocaleDateString() : 'Time unavailable'}</small></li>)}</ul>
              )}
              <div className="hcard-foot">
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(h.address)}>View details</button>
                <a className="link" href={`${p.explorerBase}/address/${h.address}`} target="_blank" rel="noreferrer">Explorer <ExternalLink size={13} /></a>
              </div>
            </article>
          );
        })}
      </div>
      {foot}
    </section>
  );
}

function Events({ rows, empty, explorerBase, short }: { rows: Health['transactions']; empty: string; explorerBase: string; short: (s: string) => string }) {
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
