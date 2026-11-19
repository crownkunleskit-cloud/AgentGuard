'use client';

import { useCallback, useRef, useState } from 'react';
import { CircleAlert, Wallet } from 'lucide-react';
import Rings, { type RingsHandle, type Verdict } from './Rings';
import Guilloche from './Guilloche';
import { Brand } from './Mark';

type Props = {
  onConnect: () => void;
  networkName: string;
  chainId: number;
  factoryAddress: string;
  explorer: string;
  symbol: string;
  configMissing: boolean;
};

const LOCKS = [
  ['Registered agent', 'Only wallets you registered can ask the vault to send anything.'],
  ['Not paused', 'Pause one agent or all of them. A paused agent sends nothing.'],
  ['Approved recipient', 'Funds only go to addresses on your list.'],
  ['Per-transaction limit', 'A ceiling on any single transfer.'],
  ['Daily limit', 'A ceiling on what one agent can move in a day.'],
];

const STOPPED = [
  'wallet is not a registered agent',
  'agent is paused',
  'recipient is not approved',
  'over the per-transaction limit',
  'over the daily limit',
];

// Things a visitor can make the simulated agent do. `lock` is where the vault stops it (-1 = it goes through).
const PLAYS = [
  { label: 'Pay an approved address', lock: -1, amount: '0.004', to: '0x41…9b' },
  { label: 'Send to a stranger', lock: 2, amount: '0.004', to: '0x9f…e2' },
  { label: 'Send too much at once', lock: 3, amount: '0.250', to: '0x41…9b' },
  { label: 'Drain it slowly', lock: 4, amount: '0.009', to: '0x41…9b' },
];

const COMPARE = [
  ['Where the funds sit', 'In the agent’s own wallet', 'In a vault contract you own'],
  ['Who it can pay', 'Any address', 'Only addresses you approved'],
  ['How much it can move', 'Everything it holds', 'Your per-transaction and daily limits'],
  ['When something looks wrong', 'You find out afterwards', 'One transaction pauses every agent'],
  ['Getting funds back', 'Depends on the agent’s key', 'The owner withdraws at any time'],
];

const STEPS = [
  ['Create your vault', 'One transaction deploys a vault contract controlled by your wallet. One vault per owner.'],
  ['Fund it and register your agent', 'Send funds to the vault, then register the wallet address your agent signs with. AgentGuard never sees its private key.'],
  ['Set the rules', 'Limits per transaction and per day for each agent, the addresses it may pay and the tokens it may move.'],
  ['Point your agent at the vault', 'The agent calls the vault instead of sending from its own wallet. The contract checks the rest.'],
];

const CONTROLS = [
  ['Limits for each agent', 'Every registered agent gets its own per-transaction and daily ceiling. Change them whenever you like.'],
  ['Approved recipients', 'Agents can only send to addresses you approved. Any other destination reverts.'],
  ['Token policies', 'Choose which ERC-20 tokens agents may transfer, each with its own limits.'],
  ['Pause and revoke', 'Freeze every agent with one transaction, or pause and permanently revoke a single one.'],
  ['Withdraw at any time', 'The vault belongs to your wallet. The owner can recover funds whenever they want.'],
  ['Everything on the record', 'Each executed transfer emits an event from your vault. The activity log reads straight from the chain.'],
];

const SEED: Verdict[] = [
  { id: 3, amount: '0.007', to: '0x9f…e2', lock: 2 },
  { id: 2, amount: '0.062', to: '0x8c…07', lock: 3 },
  { id: 1, amount: '0.004', to: '0x41…9b', lock: -1 },
];

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/* The mechanism in miniature, with one ring picked out. Ties each lock in the list to its ring in the hero. */
function LockGlyph({ n }: { n: number }) {
  return (
    <svg className="lock-glyph" viewBox="0 0 52 52" width="52" height="52" aria-hidden="true" focusable="false">
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} cx="26" cy="26" r={6 + i * 4.6} fill="none" stroke={i === n ? '#D9B26A' : '#364050'} strokeWidth={i === n ? 2 : 1} />
      ))}
      <circle cx="26" cy="26" r="2" fill="#EEF0F2" />
    </svg>
  );
}

export default function Landing({ onConnect, networkName, chainId, factoryAddress, explorer, symbol, configMissing }: Props) {
  const rings = useRef<RingsHandle>(null);
  const [log, setLog] = useState<Verdict[]>(SEED);
  const [lock, setLock] = useState(-1);
  const onVerdict = useCallback((v: Verdict) => setLog((l) => [v, ...l].slice(0, 3)), []);
  const net = networkName.toLowerCase();
  const base = explorer.replace(/\/$/, '');

  return (
    <div className="landing">
      <header className="lnav">
        <div className="wrap lnav-in">
          <Brand href="#top" />
          <nav aria-label="Sections">
            <a href="#locks">The five locks</a>
            <a href="#how">How it works</a>
            <a href="#controls">Controls</a>
            <a href="#scope">Scope</a>
          </nav>
          <span className="net"><i />Robinhood Chain <em>{net}</em></span>
          <button className="btn btn-primary btn-sm" onClick={onConnect}><Wallet size={15} /> Connect wallet</button>
        </div>
      </header>

      {configMissing && (
        <div className="wrap"><div className="warning"><CircleAlert size={17} /> Network setup is incomplete. Add the verified chain ID and deployed factory address to the public environment settings before connecting.</div></div>
      )}

      <section className="hero" id="top">
        <div className="hero-rings"><Rings ref={rings} highlight={lock} onVerdict={onVerdict} /></div>
        <div className="wrap">
          <div className="hero-copy">
            <h1>Five locks between your agent and your funds.</h1>
            <p className="lede">AgentGuard is an on-chain vault for the money your AI agent operates. The contract checks every transfer against rules you set. Pass all five and it sends. Fail one and it never leaves the vault.</p>
            <div className="cta">
              <button className="btn btn-primary" onClick={onConnect}><Wallet size={17} /> Connect wallet</button>
              <a className="btn btn-ghost" href="#locks">See the five locks</a>
            </div>

            <div className="play">
              <p>Play the agent. Try to move the money.</p>
              <div className="play-btns">
                {PLAYS.map((p) => (
                  <button key={p.label} onClick={() => rings.current?.fire(p.lock, p.amount, p.to)}>{p.label}</button>
                ))}
              </div>
              <ul className="play-log">
                {log.map((v) => (
                  <li key={v.id} className={v.lock < 0 ? 'ok' : 'no'}>
                    <span>{v.amount} {symbol} to {v.to}</span>
                    <b>{v.lock < 0 ? 'Sent' : `Stopped at lock ${v.lock + 1}: ${STOPPED[v.lock]}`}</b>
                  </li>
                ))}
              </ul>
              <small>A simulation. Nothing here touches your wallet.</small>
            </div>
          </div>
        </div>
      </section>

      <section className="sec locks" id="locks">
        <div className="wrap">
          <div className="sec-head">
            <h2>Every transfer runs the same five checks, in the contract.</h2>
            <p>Your agent can be tricked, confused or simply wrong. The vault can’t be talked into anything. The rules live on-chain, so no prompt and no dashboard can skip them.</p>
          </div>
          <ol className="lock-list">
            {LOCKS.map(([name, text], i) => (
              <li
                key={name}
                className={lock === i ? 'on' : ''}
                tabIndex={0}
                onMouseEnter={() => setLock(i)}
                onMouseLeave={() => setLock(-1)}
                onFocus={() => setLock(i)}
                onBlur={() => setLock(-1)}
              >
                <div className="lock-id"><LockGlyph n={i} /><b>Lock {i + 1}</b></div>
                <strong>{name}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="sec">
        <div className="wrap">
          <div className="sec-head">
            <h2>An agent with a wallet can spend all of it.</h2>
            <p>Giving an autonomous agent its own funded wallet means trusting every decision it will ever make. A vault changes what a bad decision can cost.</p>
          </div>
          <div className="compare" role="table" aria-label="Agent with a wallet compared with agent with a vault">
            <div className="compare-row compare-head" role="row">
              <span role="columnheader" />
              <span role="columnheader">Agent holds a wallet</span>
              <span role="columnheader">Agent calls your vault</span>
            </div>
            {COMPARE.map(([k, a, b]) => (
              <div className="compare-row" role="row" key={k}>
                <span role="rowheader">{k}</span>
                <span role="cell" data-col="Agent holds a wallet">{a}</span>
                <span role="cell" data-col="Agent calls your vault">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="how">
        <div className="wrap how">
          <div>
            <div className="sec-head">
              <h2>Bring your own agent.</h2>
              <p>AgentGuard doesn’t build agents. Use any framework, any model, any strategy. The vault only cares which wallet is asking and whether the transfer fits your rules.</p>
            </div>
            <ol className="steps">
              {STEPS.map(([name, text], i) => (
                <li key={name}><b>{i + 1}</b><div><strong>{name}</strong><span>{text}</span></div></li>
              ))}
            </ol>
          </div>
          <figure className="code">
            <figcaption>What your agent runs</figcaption>
            <pre><code>
<i>{'// ethers v6, signed by the agent wallet you registered'}</i>{'\n'}
{'const vault = new Contract(\n  VAULT_ADDRESS,\n  ['}
<em>{"'function executeNative(address payable, uint128)'"}</em>{'],\n'}
{'  agentSigner,\n);\n\n'}
{'await vault.'}<b>executeNative</b>{"(recipient, parseEther('0.004'));\n"}
<i>{'// reverts unless all five locks pass'}</i>
            </code></pre>
          </figure>
        </div>
      </section>

      <section className="sec" id="controls">
        <div className="wrap">
          <div className="sec-head">
            <h2>You hold every control.</h2>
            <p>The vault is a contract owned by your wallet. Only the owner can change a rule, and every change is a transaction you sign.</p>
          </div>
          <ul className="controls">
            {CONTROLS.map(([name, text]) => (
              <li key={name}><strong>{name}</strong><span>{text}</span></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="sec" id="scope">
        <div className="wrap">
          <div className="sec-head">
            <h2>What version 1 does, and what it doesn’t.</h2>
            <p>Security products should be exact about their edges. These are ours today.</p>
          </div>
          <div className="scope">
            <div>
              <h3>Covered</h3>
              <ul>
                <li>Native coin transfers</li>
                <li>Direct ERC-20 transfers</li>
                <li>Per-agent limits, approved recipients, token policies</li>
                <li>Pause, resume and revoke</li>
              </ul>
            </div>
            <div className="scope-no">
              <h3>Not yet</h3>
              <ul>
                <li>DEX swaps</li>
                <li>Token approvals to spenders</li>
                <li>Arbitrary contract calls</li>
              </ul>
            </div>
            <div className="scope-note">
              <h3>Keep in mind</h3>
              <p>Only assets held by the vault are protected. Anything left in an ordinary agent wallet is outside AgentGuard.</p>
              <p>This build runs on Robinhood Chain {net} (chain ID {chainId}). Review and independently audit the contracts before any mainnet use.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="closing">
        <Guilloche />
        <div className="wrap closing-in">
          <h2>Put a vault between your agent and your funds.</h2>
          <p>Connect the wallet that will own it. Creating the vault is one transaction.</p>
          <button className="btn btn-primary" onClick={onConnect}><Wallet size={17} /> Connect wallet</button>
        </div>
      </section>

      <footer className="lfoot">
        <div className="wrap lfoot-in">
          <div>
            <Brand href="#top" />
            <p>AgentGuard V1. An on-chain permission vault for AI agents.</p>
          </div>
          <ul>
            {factoryAddress && base && (
              <li><a href={`${base}/address/${factoryAddress}`} target="_blank" rel="noreferrer">Vault factory {short(factoryAddress)}</a></li>
            )}
            <li><a href="/agent">Agent execution tool</a></li>
            <li>Robinhood Chain {net}, chain ID {chainId}</li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
