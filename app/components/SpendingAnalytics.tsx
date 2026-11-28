'use client';

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { LIMIT_WARN_PCT } from '../lib/securityAlerts';
import { computeHealth, type FailedDataState, type LiveAgent } from '../lib/agentHealth';
import type { LogEntry } from '../lib/activityLog';
import { bucketSeries, chartValue, extractSpend, filterSpend, formatAsset, parseDay, presetPeriod, rankAgents, summarize, utilization, type AssetKey, type Granularity, type Period, type Preset, type TokenMeta } from '../lib/spendingAnalytics';

const when = (ts: number) => (ts ? new Date(ts * 1000).toLocaleString() : 'Time unavailable');
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const metaCache = new Map<string, TokenMeta>(); // successful token metadata reads only, kept for the browser session so a token is read once
const NA = ({ t = 'Unavailable' }: { t?: string }) => <span className="na">{t}</span>;

type ViewProps = {
  state: 'loading' | 'ok' | 'error'; error: string;
  now: number; checkedAt: number;
  entries: LogEntry[] | null; failedState: FailedDataState;
  health: ReturnType<typeof computeHealth>['agents'];
  knownAgents: string[];
  meta: Map<string, TokenMeta>; metaPending: boolean;
  refreshing: boolean; onRefresh: () => void;
  explorerBase: string; short: (s: string) => string; nativeSymbol: string;
};

function AnalyticsView(p: ViewProps) {
  const [preset, setPreset] = useState<Preset>('30d');
  const [fromTxt, setFromTxt] = useState(''); const [toTxt, setToTxt] = useState('');
  const [agent, setAgent] = useState('');
  const [asset, setAsset] = useState<AssetKey>('native');
  const [gran, setGran] = useState<Granularity>('day');
  const [histAsset, setHistAsset] = useState<'all' | AssetKey>('all');
  const [histStatus, setHistStatus] = useState<'all' | 'Success' | 'Failed'>('all');
  const [limit, setLimit] = useState(20);
  // Hooks are declared before any early return below, so their order never changes between renders.
  const all = useMemo(() => (p.entries ? extractSpend(p.entries) : []), [p.entries]);
  const label = (a: AssetKey) => (a === 'native' ? p.nativeSymbol : p.meta.get(a)?.symbol || p.short(a));
  const fmtAmt = (raw: bigint, a: AssetKey) => formatAsset(raw, a, p.nativeSymbol, p.meta.get(a));

  const head = (
    <div className="panel-head">
      <div><h3>Spending analytics</h3><p>How your registered agents have spent funds from this vault, built from the vault&apos;s on-chain transfer events. Amounts are never combined across different tokens.</p></div>
      <button className="btn btn-ghost btn-sm" disabled={p.refreshing} onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? 'spin' : ''} /> Refresh data</button>
    </div>
  );
  if (p.state === 'loading') return <section className="panel">{head}<p className="empty">Reading agents and on-chain history from the vault…</p></section>;
  if (p.state === 'error') return <section className="panel">{head}<p className="empty">Could not load spending analytics ({p.error}). This is a loading problem, not zero spending. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;
  if (p.entries === null) return <section className="panel">{head}<p className="empty">The vault&apos;s on-chain history could not be read, so spending cannot be calculated. This is not zero spending. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;

  /* period → unix range */
  let period: Period; let periodErr = '';
  if (preset === 'custom') {
    const f = fromTxt ? parseDay(fromTxt) : null; const t = toTxt ? parseDay(toTxt) : null;
    period = { from: f, to: t === null ? null : t + 86399 };
    if ((fromTxt && f === null) || (toTxt && t === null)) periodErr = 'Enter dates as YYYY-MM-DD.';
    else if (f !== null && t !== null && f > t + 86399) periodErr = 'The start date is after the end date.';
  } else period = presetPeriod(preset, p.now);

  const scoped = periodErr ? [] : filterSpend(all, { period, agent: agent || undefined });
  const summary = summarize(scoped, agent ? [agent] : p.knownAgents);
  const assets = [...new Set(all.filter(t => t.status === 'Success').map(t => t.asset))].sort((a, b) => (a === 'native' ? -1 : b === 'native' ? 1 : a.localeCompare(b)));
  const curAsset: AssetKey = assets.includes(asset) ? asset : assets[0] || 'native';
  const series = bucketSeries(scoped, curAsset, gran, p.now, preset === 'all' || (preset === 'custom' && period.from === null) ? { from: null, to: period.to } : period);
  const ranking = rankAgents(summary, curAsset);
  const util = utilization(p.health, p.now).filter(u => !agent || u.agent === agent);
  const undatedAll = all.filter(t => t.timestamp === 0 && t.status === 'Success').length;
  const agentsInData = [...new Set([...p.knownAgents.map(a => a.toLowerCase()), ...all.map(t => t.agent)])].sort();
  const hist = scoped.filter(t => (histAsset === 'all' || t.asset === histAsset) && (histStatus === 'all' || t.status === histStatus));
  const rankMax = ranking.reduce((m, r) => (r.amount > m ? r.amount : m), 0n);
  const decimalsUnknown = assets.filter(a => a !== 'native' && p.meta.get(a)?.decimals == null);

  return (
    <>
      <section className="panel">
        {head}
        <div className="sa-filters">
          <div className="log-filters" role="group" aria-label="Period">
            {(['7d', '30d', '90d', 'all', 'custom'] as const).map(k => <button key={k} className={`btn btn-sm ${preset === k ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={preset === k} onClick={() => { setPreset(k); setLimit(20); }}>{k === 'all' ? 'All time' : k === 'custom' ? 'Custom' : `Last ${k.replace('d', '')} days`}</button>)}
          </div>
          <div className="sa-row">
            {preset === 'custom' && <>
              <label className="al-select">From (UTC)<input type="date" value={fromTxt} onChange={e => { setFromTxt(e.target.value); setLimit(20); }} /></label>
              <label className="al-select">To (UTC)<input type="date" value={toTxt} onChange={e => { setToTxt(e.target.value); setLimit(20); }} /></label>
            </>}
            <label className="al-select">Agent
              <select value={agent} onChange={e => { setAgent(e.target.value); setLimit(20); }}>
                <option value="">All agents</option>
                {agentsInData.map(a => <option key={a} value={a}>{p.short(a)}</option>)}
              </select>
            </label>
          </div>
          {periodErr && <small className="help">{periodErr}</small>}
          <small className="help">Periods use UTC days. {preset === 'custom' ? 'Leave a date empty for no limit on that side.' : preset === 'all' ? 'All time includes transfers whose block time could not be read.' : ''}</small>
        </div>
        {p.failedState === 'unavailable' && <div className="warning"><span>Reverted transactions could not be loaded from the block explorer, so failed attempts are not listed. Totals are unaffected: they only ever count transfers the vault recorded as executed.</span></div>}
        {p.failedState === 'partial' && <div className="warning"><span>Only the most recent reverted transactions could be loaded, so older failed attempts may be missing from the history. Totals are unaffected.</span></div>}
        {undatedAll > 0 && <div className="warning"><span>{undatedAll} executed transfer{undatedAll === 1 ? ' has' : 's have'} no readable block time. {undatedAll === 1 ? 'It is' : 'They are'} counted in All time but cannot be placed in a date range or on the timeline.</span></div>}
        {decimalsUnknown.length > 0 && !p.metaPending && <div className="warning"><span>Decimals could not be read for {decimalsUnknown.length} token{decimalsUnknown.length === 1 ? '' : 's'}, so {decimalsUnknown.length === 1 ? 'its' : 'their'} amounts are shown in raw units rather than guessed.</span></div>}
      </section>

      {/* A. Total spending */}
      <section className="panel">
        <div className="panel-head"><div><h3>Total spending</h3><p>Successful agent transfers in the selected period{agent ? ` by ${p.short(agent)}` : ''}. Failed attempts are never counted.</p></div></div>
        <div className="sa-tiles">
          <div className="sa-tile"><small>Successful transactions</small><b>{summary.successfulCount}</b></div>
          {summary.byAsset.map(a => <div className="sa-tile" key={a.asset}><small>Spent · {label(a.asset)}</small><b title={a.asset === 'native' ? undefined : a.asset}>{fmtAmt(a.amount, a.asset)}</b><em>{a.count} transaction{a.count === 1 ? '' : 's'}</em></div>)}
          <div className="sa-tile sa-muted"><small>Failed attempts (not counted)</small><b>{p.failedState === 'unavailable' ? <NA /> : summary.failedAttempts}</b></div>
        </div>
        {!summary.byAsset.length && <p className="empty">No successful agent transfers in this period.</p>}
        <small className="help">Each token has its own total. Different tokens are never added together, and no USD value is shown because AgentGuard has no price source.</small>
      </section>

      {/* B. Over time */}
      <section className="panel">
        <div className="panel-head"><div><h3>Spending over time</h3><p>Amount of one asset per UTC {gran}, successful transfers only.</p></div></div>
        <div className="sa-row">
          <label className="al-select">Asset<select value={curAsset} onChange={e => setAsset(e.target.value)}>{(assets.length ? assets : ['native']).map(a => <option key={a} value={a}>{label(a)}</option>)}</select></label>
          <div className="log-filters" role="group" aria-label="Interval">{(['day', 'week', 'month'] as const).map(g => <button key={g} className={`btn btn-sm ${gran === g ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={gran === g} onClick={() => setGran(g)}>{g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}</button>)}</div>
        </div>
        <Chart buckets={series.buckets} asset={curAsset} meta={p.meta.get(curAsset)} fmt={fmtAmt} gran={gran} />
        {series.truncated && <small className="help">Showing the most recent {series.buckets.length} {gran === 'day' ? 'days' : gran === 'week' ? 'weeks' : 'months'}. Choose a shorter period or a longer interval to see the rest.</small>}
        {series.undated > 0 && <small className="help">{series.undated} transfer{series.undated === 1 ? '' : 's'} without a readable block time {series.undated === 1 ? 'is' : 'are'} not on this chart.</small>}
        {curAsset !== 'native' && p.meta.get(curAsset)?.decimals == null && <small className="help">Decimals for this token could not be read, so the chart axis is in raw units.</small>}
      </section>

      <div className="two">
        {/* C. Agent breakdown */}
        <section className="panel">
          <div className="panel-head"><div><h3>Agent breakdown</h3><p>Ranked by {label(curAsset)} spent (the asset chosen above). Each agent&apos;s other assets are listed separately.</p></div></div>
          {!ranking.length ? <p className="empty">No agents to show.</p> : (
            <ul className="sa-rank">
              {ranking.map(r => {
                const row = summary.byAgent.find(a => a.agent === r.agent)!;
                return (
                  <li key={r.agent}>
                    <div className="sa-rank-top"><code title={r.agent}>{p.short(r.agent)}</code><b>{r.count ? fmtAmt(r.amount, curAsset) : <span className="na">none</span>}</b></div>
                    <div className="sa-bar-track" role="img" aria-label={r.sharePct === null ? 'No share' : `${r.sharePct}% of ${label(curAsset)} spent`}><i style={{ width: `${rankMax > 0n ? Number((r.amount * 10000n) / rankMax) / 100 : 0}%` }} /></div>
                    <small>{row.count} transaction{row.count === 1 ? '' : 's'} in total{r.sharePct !== null ? ` · ${r.sharePct}% of ${label(curAsset)} spent` : ''}{row.byAsset.length > 1 || (row.byAsset.length === 1 && row.byAsset[0].asset !== curAsset) ? ` · ${row.byAsset.map(x => `${fmtAmt(x.amount, x.asset)} (${x.count})`).join(', ')}` : ''}</small>
                    <button className="link" onClick={() => { setAgent(agent === r.agent ? '' : r.agent); setLimit(20); }}>{agent === r.agent ? 'Show all agents' : 'Inspect this agent'}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* D. Token breakdown */}
        <section className="panel">
          <div className="panel-head"><div><h3>Token breakdown</h3><p>Native coin and ERC-20 tokens, each on its own.</p></div></div>
          {!summary.byAsset.length ? <p className="empty">No successful transfers in this period.</p> : (
            <div className="sa-scroll"><table className="sa-table"><thead><tr><th>Asset</th><th>Amount spent</th><th>Txs</th></tr></thead><tbody>
              {summary.byAsset.map(a => (
                <tr key={a.asset}>
                  <td>{a.asset === 'native' ? <>{p.nativeSymbol} <small>native coin</small></> : <>{p.meta.get(a.asset)?.symbol || 'Token'} <small><a className="hlink" href={`${p.explorerBase}/address/${a.asset}`} target="_blank" rel="noreferrer"><code title={a.asset}>{p.short(a.asset)}</code></a></small></>}</td>
                  <td className="num">{fmtAmt(a.amount, a.asset)}{a.asset !== 'native' && p.meta.get(a.asset)?.decimals == null && !p.metaPending && <small> · decimals unavailable</small>}</td>
                  <td className="num">{a.count}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          {p.metaPending && <small className="help">Reading token decimals and symbols…</small>}
        </section>
      </div>

      {/* F. Limit utilisation */}
      <section className="panel">
        <div className="panel-head"><div><h3>Daily spending limit utilization</h3><p>Today&apos;s native-coin spending against each agent&apos;s configured daily limit, from the vault contract (current UTC day). Not affected by the period above.</p></div></div>
        {!util.length ? <p className="empty">No registered agents.</p> : (
          <ul className="sa-util">
            {util.map(u => (
              <li key={u.agent} data-s={u.state}>
                <div className="sa-rank-top"><code title={u.agent}>{p.short(u.agent)}</code>
                  <span className={`pill ${u.state === 'full' ? 'pill-stop' : u.state === 'warn' ? 'pill-warn' : u.state === 'ok' ? '' : 'pill-unk'}`}>{u.state === 'full' ? 'Limit reached' : u.state === 'warn' ? `${LIMIT_WARN_PCT}%+ used` : u.state === 'ok' ? 'Within limit' : u.state === 'revoked' ? 'Revoked' : 'Unavailable'}</span></div>
                {u.pct !== null && u.limit !== null && u.spent !== null && u.remaining !== null ? <>
                  <div className="sa-meter" role="img" aria-label={`${u.pct}% of the daily limit used`}><i style={{ width: `${Math.min(100, u.pct)}%` }} /></div>
                  <small>{fmtAmt(u.spent, 'native')} of {fmtAmt(u.limit, 'native')} used ({u.pct}%) · {fmtAmt(u.remaining, 'native')} remaining</small>
                </> : <small>{u.state === 'revoked' ? 'Revoked agents have no allowance.' : 'The agent\'s live limit could not be read.'}</small>}
              </li>
            ))}
          </ul>
        )}
        <small className="help">ERC-20 daily limits are vault-wide per token and are not read by this page, so only native-coin utilization is shown.</small>
      </section>

      {/* E. History */}
      <section className="panel" id="sa-history">
        <div className="panel-head"><div><h3>Spending history</h3><p>Transfers in the selected period{agent ? ` by ${p.short(agent)}` : ''}, newest first, with failed attempts marked.</p></div></div>
        <div className="sa-row">
          <label className="al-select">Token<select value={histAsset} onChange={e => { setHistAsset(e.target.value); setLimit(20); }}><option value="all">All tokens</option>{assets.map(a => <option key={a} value={a}>{label(a)}</option>)}</select></label>
          <label className="al-select">Status<select value={histStatus} onChange={e => { setHistStatus(e.target.value as 'all' | 'Success' | 'Failed'); setLimit(20); }}><option value="all">All</option><option value="Success">Successful</option><option value="Failed">Failed attempts</option></select></label>
        </div>
        {!hist.length ? <p className="empty">{all.length ? 'No transfers match these filters.' : 'No agent transfers have been recorded in this vault yet.'}</p> : (
          <div className="sa-scroll"><table className="sa-table"><thead><tr><th>Time</th><th>Agent</th><th>Asset</th><th>Amount</th><th>Recipient</th><th>Status</th><th>Tx</th></tr></thead><tbody>
            {hist.slice(0, limit).map(t => (
              <tr key={t.key} className={t.status === 'Failed' ? 'sa-failed' : ''}>
                <td>{when(t.timestamp)}</td>
                <td><code title={t.agent}>{p.short(t.agent)}</code></td>
                <td>{label(t.asset)}</td>
                <td className="num">{t.amount === null ? <NA t="Not decoded" /> : fmtAmt(t.amount, t.asset)}</td>
                <td>{t.recipient ? <code title={t.recipient}>{p.short(t.recipient)}</code> : <NA t="—" />}</td>
                <td><span className={`pill ${t.status === 'Failed' ? 'pill-stop' : ''}`}>{t.status === 'Failed' ? 'Failed · not counted' : 'Success'}</span></td>
                <td><a className="link" href={`${p.explorerBase}/tx/${t.hash}`} target="_blank" rel="noreferrer" title="Open in explorer"><code>{p.short(t.hash)}</code> <ExternalLink size={12} /></a></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        {hist.length > limit && <button className="btn btn-ghost btn-sm" onClick={() => setLimit(n => n + 20)}>Show more ({hist.length - limit} remaining)</button>}
      </section>

      <small className="help">
        {p.checkedAt ? `Data read ${when(p.checkedAt)}. ` : ''}Spending is rebuilt from the vault&apos;s full on-chain event history (from the block the vault was created in) each time this page is opened or refreshed; there is no background polling. Owner withdrawals are not agent spending and are excluded. Transfers are attributed to the agent that the vault recorded as the sender.
      </small>
    </>
  );
}

function Chart({ buckets, asset, meta, fmt, gran }: { buckets: { start: number; amount: bigint; count: number }[]; asset: AssetKey; meta?: TokenMeta; fmt: (r: bigint, a: AssetKey) => string; gran: Granularity }) {
  if (!buckets.length) return <p className="empty">No successful transfers of this asset in the selected period.</p>;
  const W = 640, H = 230, L = 8, R = 8, T = 14, B = 34;
  const vals = buckets.map(b => chartValue(b.amount, asset, meta)); const max = Math.max(...vals, 0);
  const slot = (W - L - R) / buckets.length; const bw = Math.max(2, Math.min(34, slot * 0.7));
  const maxRaw = buckets.reduce((m, b) => (b.amount > m ? b.amount : m), 0n);
  const lbl = (s: number) => (gran === 'month' ? new Date(s * 1000).toISOString().slice(0, 7) : day(s).slice(5));
  const ticks = buckets.length <= 6 ? buckets.map((_, i) => i) : [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];
  return (
    <div className="sa-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bar chart of ${gran}ly spending, highest ${fmt(maxRaw, asset)}`}>
        <line className="sa-axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
        {buckets.map((b, i) => {
          const h = max > 0 ? Math.max(b.amount > 0n ? 2 : 0, (vals[i] / max) * (H - B - T)) : 0; const x = L + i * slot + (slot - bw) / 2;
          return <rect key={b.start} className="sa-col" x={x} y={H - B - h} width={bw} height={h} rx={1}><title>{`${day(b.start)}${gran === 'day' ? '' : ` (${gran})`}: ${fmt(b.amount, asset)} · ${b.count} transaction${b.count === 1 ? '' : 's'}`}</title></rect>;
        })}
        {ticks.map(i => <text key={i} className="sa-tick" x={L + i * slot + slot / 2} y={H - 12} textAnchor={i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle'}>{lbl(buckets[i].start)}</text>)}
      </svg>
      <div className="sa-chart-meta"><span>Highest {gran}: <b>{fmt(maxRaw, asset)}</b></span><span>Hover or focus a bar for its exact amount</span></div>
    </div>
  );
}

/* ───────── Isolated entry point used by app/page.tsx ───────── */
type SectionProps = {
  loading: boolean; wrongChain: boolean; chain: number; chainId: number;
  live: { live: Map<string, LiveAgent>; globalPaused: boolean | null; checkedAt: number } | null;
  entries: LogEntry[] | null; failedState: FailedDataState; knownAgents: string[];
  refreshing: boolean; onRefresh: () => void; explorerBase: string;
  short: (s: string) => string; nativeSymbol: string;
  /** Reads decimals() and symbol() of one ERC-20. Must throw if decimals cannot be read. */
  readTokenMeta: (token: string) => Promise<TokenMeta>;
};

/** A render error in Spending Analytics is caught here and shown inline. It can never blank the dashboard or hide the agent list. */
class AnalyticsBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: string }> {
  state = { failed: '' };
  static getDerivedStateFromError(e: unknown) { return { failed: String((e as any)?.message || e).slice(0, 160) }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel"><div className="panel-head"><div><h3>Spending analytics</h3></div></div><p className="empty">Spending analytics could not be displayed ({this.state.failed}). Your agents, vault and every other page are not affected. <button className="link" onClick={() => { this.setState({ failed: '' }); this.props.onRetry(); }}>Retry</button></p></section>;
  }
}

function AnalyticsCompute(s: SectionProps) {
  const now = s.live?.checkedAt || Math.floor(Date.now() / 1000);
  const health = useMemo(() => (s.live ? computeHealth({ entries: s.entries, failedState: s.failedState, live: s.live.live, globalPaused: s.live.globalPaused, knownAgents: s.knownAgents, now }).agents : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.live, s.entries, s.failedState, s.knownAgents.join(',')]);

  // Token decimals/symbols: ONE read per distinct token, only while this page is open, cached for the session. A failure affects only that token.
  const tokens = useMemo(() => [...new Set((s.entries || []).filter(e => e.type === 'Token transfer executed' && e.token).map(e => e.token!.toLowerCase()))].sort(), [s.entries]);
  const [meta, setMeta] = useState<Map<string, TokenMeta>>(new Map());
  const [pending, setPending] = useState(false);
  const attempted = useRef<Set<string>>(new Set());
  const [nonce, setNonce] = useState(0); // bumped by Refresh so tokens whose metadata read failed are tried again
  const readRef = useRef(s.readTokenMeta); readRef.current = s.readTokenMeta;
  useEffect(() => {
    if (s.wrongChain || !tokens.length) return;
    let live = true;
    const next = new Map<string, TokenMeta>(); const todo: string[] = [];
    for (const t of tokens) { const c = metaCache.get(`${s.chainId}:${t}`); if (c) next.set(t, c); else if (!attempted.current.has(t)) todo.push(t); }
    if (next.size) setMeta(m => new Map([...m, ...next]));
    if (!todo.length) { setPending(false); return; }
    setPending(true);
    (async () => {
      for (const t of todo) {
        attempted.current.add(t);
        try { const m = await readRef.current(t); if (Number.isInteger(m.decimals) && m.decimals! >= 0 && m.decimals! <= 77) { metaCache.set(`${s.chainId}:${t}`, m); if (live) setMeta(prev => new Map(prev).set(t, m)); } }
        catch { /* leave undefined: the UI shows raw units for this token */ }
      }
      if (live) setPending(false);
    })();
    return () => { live = false; };
  }, [tokens, s.chainId, s.wrongChain, nonce]);

  return <AnalyticsView state={s.wrongChain ? 'error' : s.loading ? 'loading' : 'ok'} error={`your wallet is on chain ${s.chain}; switch to chain ${s.chainId}`}
    now={now} checkedAt={s.live?.checkedAt || 0} entries={s.entries} failedState={s.failedState} health={health} knownAgents={s.knownAgents}
    meta={meta} metaPending={pending} refreshing={s.refreshing} onRefresh={() => { attempted.current = new Set(); setNonce(n => n + 1); s.onRefresh(); }}
    explorerBase={s.explorerBase} short={s.short} nativeSymbol={s.nativeSymbol} />;
}

export default function SpendingAnalyticsSection(s: SectionProps) {
  return <AnalyticsBoundary onRetry={s.onRefresh}><AnalyticsCompute {...s} /></AnalyticsBoundary>;
}
