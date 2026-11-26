'use client';

import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { ANALYSIS_DAYS, BEHAVIOURAL_CAP, INDICATORS, RECENT_DAYS, type AgentRisk as Risk, type Confidence, type Evidence, type Finding, type RiskLevel, type RiskOverview } from '../lib/agentRisk';
import type { AgentHealth } from '../lib/agentHealth';

type Props = {
  /** 'loading' until the event history and live reads have returned for the first time. */
  state: 'loading' | 'ok' | 'error';
  error: string;
  agents: Risk[];
  overview: RiskOverview;
  /** Health results (same data source), used for the agent's security events in the report. */
  health: Record<string, AgentHealth>;
  /** Unix seconds at which the data was read; 0 if it never was. */
  checkedAt: number;
  historyOk: boolean;
  failedState: 'complete' | 'partial' | 'unavailable';
  refreshing: boolean;
  onRefresh: () => void;
  explorerBase: string;
  short: (s: string) => string;
  initialSelected?: string;
};

const PILL: Record<RiskLevel, string> = { Low: '', Medium: 'pill-warn', High: 'pill-stop', Critical: 'pill-stop', 'Insufficient data': 'pill-unk' };
const DATA_S: Record<RiskLevel, string> = { Low: 'Healthy', Medium: 'Warning', High: 'Restricted', Critical: 'Restricted', 'Insufficient data': 'Unknown' };
const when = (ts: number) => (ts ? new Date(ts * 1000).toLocaleString() : 'Time unavailable');
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const scoreText = (r: { score: number | null }) => (r.score === null ? 'Insufficient data' : `${r.score} / 100`);
const KIND: Record<Finding['kind'], string> = { confirmed: 'Confirmed on-chain', behavioural: 'Behavioural indicator' };
const SEV_PILL = { High: 'pill-stop', Medium: 'pill-warn', Low: '' } as const;
const CONF_NOTE: Record<Confidence, string> = { High: 'all inputs available', Medium: 'some inputs incomplete', Low: 'important inputs missing or history is thin', None: 'no assessment' };

export default function AgentRiskView(p: Props) {
  const [selected, setSelected] = useState(p.initialSelected || '');
  const sel = p.agents.find(a => a.address === selected) || null;
  const o = p.overview;

  const head = (
    <div className="panel-head">
      <div>
        <h3>{sel ? 'Agent risk report' : 'Agent risk insights'}</h3>
        <p>Security analysis of each agent&apos;s observable on-chain behaviour. It informs your decisions; it never blocks, pauses, revokes or moves anything.</p>
      </div>
      <button className="btn btn-ghost btn-sm" disabled={p.refreshing} onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? 'spin' : ''} /> Refresh</button>
    </div>
  );
  const foot = (
    <small className="help">
      {p.checkedAt ? `Last analysed ${when(p.checkedAt)}. ` : ''}Analysis period: {day(o.windowStart)} to {day(o.windowEnd)} UTC ({ANALYSIS_DAYS} days). This is not continuous real-time monitoring: scores are calculated from the vault&apos;s on-chain history each time this page is opened or refreshed.
      Findings are indicators from observable data, not accusations. Missing data never adds risk; it lowers confidence and is listed under &quot;Checks not performed&quot;.
    </small>
  );
  const method = (
    <details className="rmethod">
      <summary>How scores are calculated</summary>
      <p>Score 0 to 100 (higher = riskier): Low 0 to 29, Medium 30 to 59, High 60 to 79, Critical 80 to 100. Score = confirmed points + behavioural points, where behavioural points are capped at {BEHAVIOURAL_CAP} (so behavioural indicators alone never exceed Medium) and the total is capped at 100. No single indicator exceeds 45 points.</p>
      <p>Only the last {ANALYSIS_DAYS} days are scored. A finding whose newest evidence is within {RECENT_DAYS} days counts in full; older evidence in the window counts 60%. Evidence without a readable timestamp is not scored. Inactivity never adds risk. Each reverted agent call is assigned to exactly one cause, following the vault contract&apos;s own check order, so nothing is counted twice.</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Indicator</th><th>Type</th><th>Severity</th><th>Points by evidence count / ratio</th></tr></thead>
          <tbody>
            {INDICATORS.map(i => (
              <tr key={i.id}>
                <td data-label="Indicator"><b>{i.title}</b><small className="help">{i.rule}</small></td>
                <td data-label="Type">{i.kind === 'confirmed' ? 'Confirmed' : 'Behavioural'}</td>
                <td data-label="Severity">{i.severity}</td>
                <td data-label="Points">{i.tiers.map(([min, pts]) => `${min}+ ${i.unit}: ${pts}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );

  if (p.state === 'loading') return <section className="panel">{head}<p className="empty">Reading agents and on-chain history from the vault…</p></section>;
  if (p.state === 'error') return <section className="panel">{head}<p className="empty">Could not load risk insights ({p.error}). This is a loading problem, not a clean bill of health. <button className="link" onClick={p.onRefresh}>Retry</button></p></section>;

  const EvidenceList = ({ items }: { items: Evidence[] }) => {
    const [n, setN] = useState(5);
    return (
      <>
        <ul className="revidence">
          {items.slice(0, n).map((e, i) => (
            <li key={e.hash + i}>
              <span>{e.summary}</span>
              <small>{when(e.timestamp)} · <a className="hlink" href={`${p.explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer">tx {p.short(e.hash)}</a>{e.reverted ? ' · reverted' : ''}</small>
            </li>
          ))}
        </ul>
        {items.length > n && <button className="link" onClick={() => setN(x => x + 10)}>Show more ({items.length - n} remaining)</button>}
      </>
    );
  };
  const FindingCard = ({ f, agent, compact }: { f: Finding; agent?: string; compact?: boolean }) => (
    <article className="rfinding" data-kind={f.kind}>
      <div className="hcard-head">
        <b>{f.title}</b>
        <span className="rpills"><span className={`pill ${SEV_PILL[f.severity]}`}>{f.severity} severity</span><span className="pill pill-idle">{KIND[f.kind]}</span></span>
      </div>
      <p className="hreason">{f.summary}{agent && <> Agent <button className="link" onClick={() => setSelected(agent)}><code>{p.short(agent)}</code></button>.</>}</p>
      <small className="help">+{f.points} points{f.weight < 1 ? ` (${f.basePoints} × ${Math.round(f.weight * 100)}% because the newest evidence is older than ${RECENT_DAYS} days)` : ''} · {f.count} evidence item{f.count === 1 ? '' : 's'} · latest {when(f.latest)}</small>
      <EvidenceList items={compact ? f.evidence.slice(0, 2) : f.evidence} />
      {!compact && <div className="hwhy"><b>Recommended owner action (informational)</b><p>{f.recommendation}</p></div>}
    </article>
  );

  /* ───────── Agent risk report ───────── */
  if (sel) {
    const h = p.health[sel.address];
    return (
      <>
        <section className="panel">
          {head}
          <button className="link" onClick={() => setSelected('')}>← All agents</button>
          <div className="hdetail-id">
            <code className="mono" title={sel.address}>{sel.address}</code>
            <span className={`pill ${PILL[sel.level]}`}>{sel.level === 'Insufficient data' ? sel.level : `${sel.level} risk`}</span>
            <a className="btn btn-ghost btn-sm" href={`${p.explorerBase}/address/${sel.address}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> View on Robinhood Chain Explorer</a>
          </div>
          <div className="rscore">
            <div><small>Risk score</small><b>{scoreText(sel)}</b></div>
            <div><small>Confidence</small><b>{sel.confidence === 'None' ? 'None' : sel.confidence}</b><small>{CONF_NOTE[sel.confidence]}</small></div>
            <div><small>Registration</small><b>{sel.registration === 'Unknown' ? 'Unavailable' : sel.registration}</b></div>
            <div><small>Period analysed</small><b>{day(sel.windowStart)} to {day(sel.windowEnd)}</b></div>
          </div>
          {sel.score !== null && <div className="rbar" role="img" aria-label={`Risk score ${sel.score} out of 100`}><i data-level={sel.level} style={{ width: `${sel.score}%` }} /></div>}
          <div className="hwhy"><b>Why this score</b><ul>{sel.explanation.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
          {sel.confidenceNotes.length > 0 && <div className="hwhy"><b>Data limits that reduce confidence</b><ul>{sel.confidenceNotes.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        </section>

        <section className="panel">
          <div className="panel-head"><div><h3>Findings</h3><p>Every finding lists the on-chain transactions behind it. Confirmed findings are verifiable facts; behavioural indicators are patterns compared with this agent&apos;s own history.</p></div></div>
          {sel.findings.length ? <div className="rlist">{sel.findings.map(f => <FindingCard key={f.id} f={f} />)}</div> : <p className="empty">{sel.score === null ? 'Not enough evidence to assess this agent.' : 'No significant risk indicators detected in the available data.'}</p>}
        </section>

        <div className="two">
          <section className="panel">
            <div className="panel-head"><div><h3>Checks not performed</h3><p>Missing or incomplete data is never treated as suspicious or as safe.</p></div></div>
            {sel.checksNotPerformed.length ? <ul className="rnotes">{sel.checksNotPerformed.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="empty">All checks could be performed.</p>}
            {sel.notScored.length > 0 && <><b className="hsub">Evidence not scored</b><ul className="rnotes">{sel.notScored.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
          </section>
          <section className="panel">
            <div className="panel-head"><div><h3>Recommended owner actions</h3><p>Informational. You stay in control.</p></div></div>
            {sel.recommendations.length ? <ul className="rnotes">{sel.recommendations.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="empty">No action suggested.</p>}
          </section>
        </div>

        <section className="panel">
          <div className="panel-head"><div><h3>Relevant security events</h3><p>Pauses, limit changes, revocation and reverted calls involving this agent, plus vault-wide Emergency Pause changes.</p></div></div>
          {h && h.lastActivityState !== 'unavailable' ? (h.securityEvents.length ? (
            <ul className="revidence">{h.securityEvents.slice(0, 10).map(e => <li key={e.key}><span><b>{e.type}</b> · {e.description}</span><small>{when(e.timestamp)} · <a className="hlink" href={`${p.explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer">tx {p.short(e.hash)}</a></small></li>)}</ul>
          ) : <p className="empty">No security events observed for this agent.</p>) : <p className="empty">Unavailable: event history could not be loaded.</p>}
        </section>
        {method}
        {foot}
      </>
    );
  }

  /* ───────── Overview + agent cards ───────── */
  return (
    <>
      <section className="panel">
        {head}
        {!p.historyOk && <div className="warning"><span>The vault&apos;s event history could not be read, so agents show &quot;Insufficient data&quot;. This is not a risk finding. <button className="link" onClick={p.onRefresh}>Retry</button></span></div>}
        {p.historyOk && p.failedState !== 'complete' && <div className="warning"><span>{p.failedState === 'unavailable' ? 'Reverted transactions could not be loaded from the block explorer, so blocked-attempt checks were not performed and confidence is reduced.' : 'Only the most recent reverted transactions could be loaded, so blocked-attempt counts may be incomplete.'}</span></div>}
        <div className="rhead">
          <div><small>Overall vault risk</small><b><span className={`pill ${PILL[o.level]}`}>{o.level === 'Insufficient data' ? o.level : `${o.level} risk`}</span></b><small>{o.score === null ? 'No agent has enough data to assess.' : `Highest agent score: ${o.score} / 100`}</small></div>
          <dl className="rstats">
            <div><dt>Monitored agents</dt><dd>{o.monitored}</dd></div>
            <div><dt>Low risk</dt><dd>{o.low}</dd></div>
            <div><dt>Medium risk</dt><dd>{o.medium}</dd></div>
            <div><dt>High risk</dt><dd>{o.high}</dd></div>
            <div><dt>Critical risk</dt><dd>{o.critical}</dd></div>
            <div><dt>Need attention</dt><dd>{o.attention}</dd></div>
            <div><dt>Insufficient data</dt><dd>{o.insufficient}</dd></div>
          </dl>
        </div>
        <small className="help">Includes {o.revoked} revoked agent{o.revoked === 1 ? '' : 's'}, whose later activity can still show attempts. &quot;Need attention&quot; = Medium, High or Critical.</small>
      </section>

      <div className="two">
        <section className="panel">
          <div className="panel-head"><div><h3>Most concerning observed activity</h3><p>The highest-scoring finding across all agents.</p></div></div>
          {o.mostConcerning ? <FindingCard f={o.mostConcerning.finding} agent={o.mostConcerning.agent} compact /> : <p className="empty">{p.historyOk ? 'No risk indicators detected in the available data.' : 'Unavailable: history could not be loaded.'}</p>}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h3>Recent risk detections</h3><p>Newest evidence first.</p></div></div>
          {o.recent.length ? (
            <ul className="revidence">
              {o.recent.map((r, i) => (
                <li key={r.agent + r.finding.id + i}>
                  <span><b>{r.finding.title}</b> · <button className="link" onClick={() => setSelected(r.agent)}><code>{p.short(r.agent)}</code></button> · +{r.finding.points} · {r.finding.kind === 'confirmed' ? 'confirmed' : 'indicator'}</span>
                  <small>{when(r.finding.latest)}</small>
                </li>
              ))}
            </ul>
          ) : <p className="empty">No detections in the last {ANALYSIS_DAYS} days.</p>}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h3>Agents</h3><p>One risk card per agent, highest score first.</p></div></div>
        {!p.agents.length && <p className="empty">{p.historyOk ? 'No agents have been registered in this vault yet.' : 'No agents could be listed.'}</p>}
        <div className="hgrid">
          {p.agents.map(r => (
            <article className="hcard" data-s={DATA_S[r.level]} key={r.address}>
              <div className="hcard-head">
                <code className="mono" title={r.address}>{p.short(r.address)}</code>
                <span className={`pill ${PILL[r.level]}`}>{r.level === 'Insufficient data' ? r.level : `${r.level} risk`}</span>
              </div>
              <div className="rscorecard"><b>{r.score === null ? '—' : r.score}</b><small>{r.score === null ? 'Not enough evidence' : '/ 100'}</small></div>
              {r.score !== null && <div className="rbar"><i data-level={r.level} style={{ width: `${r.score}%` }} /></div>}
              <p className="hreason">{r.explanation[0]}</p>
              <dl className="hmetrics">
                <div><dt>Registration</dt><dd>{r.registration === 'Unknown' ? <span className="na">Unavailable</span> : r.registration}</dd></div>
                <div><dt>Confidence</dt><dd>{r.confidence === 'None' ? <span className="na">None</span> : r.confidence}</dd></div>
                <div><dt>Confirmed findings</dt><dd>{r.findings.filter(f => f.kind === 'confirmed').length}</dd></div>
                <div><dt>Behavioural indicators</dt><dd>{r.findings.filter(f => f.kind === 'behavioural').length}</dd></div>
              </dl>
              {r.findings.length > 0 && <ul className="hevents">{r.findings.slice(0, 2).map(f => <li key={f.id}><b>{f.title}</b> <small>{f.kind === 'confirmed' ? 'confirmed' : 'indicator'} · +{f.points}</small></li>)}</ul>}
              <div className="hcard-foot">
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(r.address)}>View risk report</button>
                <a className="link" href={`${p.explorerBase}/address/${r.address}`} target="_blank" rel="noreferrer">Explorer <ExternalLink size={13} /></a>
              </div>
            </article>
          ))}
        </div>
      </section>
      {method}
      {foot}
    </>
  );
}
