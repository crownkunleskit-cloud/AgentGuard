'use client';

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BellRing, ExternalLink, RefreshCw } from 'lucide-react';
import { ALERT_DAYS, ALERT_TYPES, SEVERITIES, computeAlerts, loadRead, readKey, saveRead, type AlertSeverity, type AlertType, type SecurityAlert } from '../lib/securityAlerts';
import { computeHealth, type FailedDataState, type LiveAgent } from '../lib/agentHealth';
import { computeRisk } from '../lib/agentRisk';
import type { LogEntry } from '../lib/activityLog';

const SEV_CLASS: Record<AlertSeverity, string> = { Critical: 'al-critical', High: 'al-high', Medium: 'al-medium', Low: 'al-low' };
const when = (ts: number) => (ts ? new Date(ts * 1000).toLocaleString() : 'Time unavailable');

type ViewProps = {
  state: 'loading' | 'ok' | 'error';
  error: string;
  alerts: SecurityAlert[];
  notes: string[];
  checkedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
  explorerBase: string;
  short: (s: string) => string;
  storageKey: string;
};

function AlertsView(p: ViewProps) {
  const [read, setRead] = useState<Set<string>>(new Set());
  const [saveOk, setSaveOk] = useState(true);
  const [sev, setSev] = useState<AlertSeverity | 'All'>('All');
  const [type, setType] = useState<AlertType | 'All'>('All');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [limit, setLimit] = useState(25);
  const [auto, setAuto] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState('');
  const loadedKey = useRef('');
  const seen = useRef<Set<string> | null>(null);
  const store = () => { try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; } };

  // Read state is kept per chain + vault in this browser only. A vault with a different key never sees another vault's state.
  useEffect(() => { setRead(loadRead(store(), p.storageKey)); loadedKey.current = p.storageKey; seen.current = null; }, [p.storageKey]);
  const persist = (next: Set<string>) => { setRead(next); setSaveOk(saveRead(store(), p.storageKey, next)); };
  const markRead = (id: string) => { if (!read.has(id)) persist(new Set([...read, id])); };
  const markAll = () => persist(new Set([...read, ...p.alerts.map(a => a.id)]));

  // Optional auto-check: re-runs the same refresh as the Refresh button. Off by default because each check re-reads vault history.
  const latest = useRef({ refreshing: p.refreshing, onRefresh: p.onRefresh }); latest.current = { refreshing: p.refreshing, onRefresh: p.onRefresh };
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => { if (!latest.current.refreshing) latest.current.onRefresh(); }, 60_000);
    return () => window.clearInterval(t);
  }, [auto]);

  // Optional browser notifications: only for High/Critical alerts that first appear AFTER this page was opened, never for existing ones.
  const signature = p.alerts.map(a => a.id).join('|');
  useEffect(() => {
    if (p.state !== 'ok') return;
    const ids = new Set(p.alerts.map(a => a.id));
    if (seen.current === null) { seen.current = ids; return; }
    const fresh = p.alerts.filter(a => !seen.current!.has(a.id));
    ids.forEach(i => seen.current!.add(i));
    if (!notifyOn || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const a of fresh.filter(x => (x.severity === 'Critical' || x.severity === 'High') && !read.has(x.id)).slice(0, 3)) { try { new Notification(`AgentGuard: ${a.title}`, { body: a.description, tag: a.id }); } catch { /* not critical */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, p.state]);

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') { setNotifyMsg('This browser does not support notifications.'); return; }
    if (Notification.permission === 'denied') { setNotifyMsg('Notifications are blocked for this site in your browser settings.'); return; }
    try { const r = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); setNotifyOn(r === 'granted'); setNotifyMsg(r === 'granted' ? 'Browser notifications are on while this page is open.' : 'Notification permission was not granted.'); } catch { setNotifyMsg('Could not request notification permission.'); }
  };

  const unread = p.alerts.filter(a => !read.has(a.id));
  const count = (s: AlertSeverity) => unread.filter(a => a.severity === s).length;
  const shown = useMemo(() => p.alerts.filter(a => (sev === 'All' || a.severity === sev) && (type === 'All' || a.type === type) && (!unreadOnly || !read.has(a.id))), [p.alerts, sev, type, unreadOnly, read]);

  const head = (
    <div className="panel-head">
      <div>
        <h3>Security alerts</h3>
        <p>Alerts derived from your vault&apos;s on-chain history and current state. They are checked when this page is opened or refreshed, not streamed live.</p>
      </div>
      <button className="btn btn-ghost btn-sm" disabled={p.refreshing} onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? 'spin' : ''} /> Check now</button>
    </div>
  );

  if (p.state === 'loading') return <section className="panel">{head}<p className="empty">Reading agents and on-chain history from the vault…</p></section>;
  if (p.state === 'error') return <section className="panel">{head}<p className="empty">Could not load alerts ({p.error}). This is a loading problem, not an all-clear. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;

  return (
    <>
      <section className="panel">
        {head}
        <div className="al-summary" aria-label="Unread alerts by severity">
          <div><small>Unread</small><b>{unread.length}</b></div>
          {SEVERITIES.map(s => <div key={s} className={SEV_CLASS[s]}><small>{s}</small><b>{count(s)}</b></div>)}
        </div>
        {p.notes.map((n, i) => <div className="warning" key={i}><span>{n}</span></div>)}
        <div className="al-controls">
          <div className="log-filters" role="group" aria-label="Filter by severity">
            {(['All', ...SEVERITIES] as const).map(s => <button key={s} className={`btn btn-sm ${sev === s ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={sev === s} onClick={() => { setSev(s); setLimit(25); }}>{s === 'All' ? 'All severities' : s}</button>)}
          </div>
          <div className="al-row">
            <label className="al-select">Type
              <select value={type} onChange={e => { setType(e.target.value as AlertType | 'All'); setLimit(25); }}>
                <option value="All">All types</option>
                {ALERT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="al-check"><input type="checkbox" checked={unreadOnly} onChange={e => { setUnreadOnly(e.target.checked); setLimit(25); }} /> Unread only</label>
            <button className="btn btn-ghost btn-sm" disabled={!unread.length} onClick={markAll}>Mark all as read</button>
          </div>
        </div>

        <ul className="al-list">
          {shown.slice(0, limit).map(a => {
            const isRead = read.has(a.id);
            return (
              <li key={a.id} className={`al-item ${SEV_CLASS[a.severity]} ${isRead ? 'is-read' : 'is-unread'}`}>
                <div className="al-top">
                  <span className="al-sev"><i aria-hidden="true" />{a.severity}</span>
                  <span className="pill pill-idle">{a.type}</span>
                  {!isRead && <span className="al-new">Unread</span>}
                </div>
                <b className="al-title">{a.title}</b>
                <p>{a.description}</p>
                <small className="log-meta">
                  <span>{when(a.timestamp)}{a.blockNumber ? ` · Block ${a.blockNumber}` : ''}</span>
                  {a.agent && <span>Agent <code title={a.agent}>{p.short(a.agent)}</code></span>}
                  {a.hash && <span>Tx <a href={`${p.explorerBase}/tx/${a.hash}`} target="_blank" rel="noreferrer"><code title={a.hash}>{p.short(a.hash)}</code></a></span>}
                </small>
                <div className="al-actions">
                  {a.hash && <a className="link" href={`${p.explorerBase}/tx/${a.hash}`} target="_blank" rel="noreferrer">Explorer <ExternalLink size={13} /></a>}
                  {!isRead && <button className="btn btn-ghost btn-sm" onClick={() => markRead(a.id)}>Mark as read</button>}
                </div>
              </li>
            );
          })}
        </ul>
        {!shown.length && <p className="empty">{p.alerts.length ? 'No alerts match these filters.' : 'No alerts were raised from the available data in the last ' + ALERT_DAYS + ' days. This reflects only what could be read; see any notes above.'}</p>}
        {shown.length > limit && <button className="btn btn-ghost btn-sm" onClick={() => setLimit(n => n + 25)}>Show more ({shown.length - limit} remaining)</button>}
        {!saveOk && <small className="help">Read status could not be saved in this browser (storage is unavailable), so it will reset when the page reloads.</small>}
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3>Notification settings</h3><p>Both options are off until you turn them on.</p></div></div>
        <div className="setting"><div><b>Browser notifications</b><p>Show a system notification for new High or Critical alerts that appear while this page is open. Your browser will ask for permission.</p></div><button className="btn btn-ghost btn-sm" onClick={enableNotifications}><BellRing size={14} /> {notifyOn ? 'Enabled' : 'Enable'}</button></div>
        <div className="setting"><div><b>Auto-check every 60 seconds</b><p>Re-reads vault history and state on a timer while this page is open. This uses extra RPC requests, so it is off by default.</p></div><label className="al-check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> {auto ? 'On' : 'Off'}</label></div>
        {notifyMsg && <small className="help">{notifyMsg}</small>}
      </section>

      <small className="help">
        {p.checkedAt ? `Last checked ${when(p.checkedAt)}. ` : ''}Alerts cover the last {ALERT_DAYS} days. Alerts are de-duplicated: the same on-chain event is one alert however often it is re-read. Read status is stored only in this browser, per chain and vault.
        Unauthorized-recipient and blocked-attempt alerts depend on reverted transactions from the block explorer; spending-limit warnings use the agent&apos;s native-coin daily limit (ERC-20 daily usage is vault-wide and is not read here). AgentGuard never pauses, revokes or changes anything because of an alert.
      </small>
    </>
  );
}

/* ───────── Isolated entry point used by app/page.tsx ───────── */
type SectionProps = {
  loading: boolean; wrongChain: boolean; chain: number; chainId: number; vault: string;
  live: { live: Map<string, LiveAgent>; globalPaused: boolean | null; checkedAt: number } | null;
  entries: LogEntry[] | null; failedState: FailedDataState; knownAgents: string[];
  refreshing: boolean; onRefresh: () => void; explorerBase: string;
  short: (s: string) => string; native: (n: bigint) => string;
};

/** A render error in Security Alerts is caught here and shown inline. It can never blank the dashboard or hide the agent list. */
class AlertsBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: string }> {
  state = { failed: '' };
  static getDerivedStateFromError(e: unknown) { return { failed: String((e as any)?.message || e).slice(0, 160) }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel"><div className="panel-head"><div><h3>Security alerts</h3></div></div><p className="empty">Alerts could not be displayed ({this.state.failed}). Your agents, vault and every other page are not affected. <button className="link" onClick={() => { this.setState({ failed: '' }); this.props.onRetry(); }}>Retry</button></p></section>;
  }
}

function AlertsCompute(s: SectionProps) {
  const now = s.live?.checkedAt || Math.floor(Date.now() / 1000);
  const result = useMemo(() => {
    if (!s.live) return { alerts: [] as SecurityAlert[], notes: [] as string[] };
    const health = computeHealth({ entries: s.entries, failedState: s.failedState, live: s.live.live, globalPaused: s.live.globalPaused, knownAgents: s.knownAgents, now });
    const risk = computeRisk(health.agents, s.entries, { now, failedState: s.failedState, short: s.short, native: s.native });
    return computeAlerts({ health: health.agents, risks: risk.agents, entries: s.entries, failedState: s.failedState, now, short: s.short, native: s.native });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.live, s.entries, s.failedState, s.knownAgents.join(',')]);
  return <AlertsView state={s.wrongChain ? 'error' : s.loading ? 'loading' : 'ok'} error={`your wallet is on chain ${s.chain}; switch to chain ${s.chainId}`} alerts={result.alerts} notes={result.notes} checkedAt={s.live?.checkedAt || 0} refreshing={s.refreshing} onRefresh={s.onRefresh} explorerBase={s.explorerBase} short={s.short} storageKey={readKey(s.chainId, s.vault)} />;
}

export default function SecurityAlertsSection(s: SectionProps) {
  return <AlertsBoundary onRetry={s.onRefresh}><AlertsCompute {...s} /></AlertsBoundary>;
}
