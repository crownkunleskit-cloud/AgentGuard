'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserProvider, Contract, formatEther, parseEther, isAddress } from 'ethers';
import { Activity, Bot, ChevronRight, CircleAlert, Copy, ExternalLink, Fingerprint, LockKeyhole, Pause, Play, Plus, Power, RefreshCw, ShieldAlert, SlidersHorizontal, Wallet, X } from 'lucide-react';
import Landing from './components/Landing';
import { Brand } from './components/Mark';

declare global { interface Window { ethereum?: any } }

type Agent = { address: string; registered: boolean; paused: boolean; maxNativePerTx: bigint; maxNativePerDay: bigint; dayStart: bigint; nativeSpentToday: bigint };
type EventRow = { title: string; detail: string; hash: string; block: number; kind: 'good' | 'bad' | 'neutral' };
type Page = 'Overview' | 'My agents' | 'Permissions' | 'Activity' | 'Settings';
type Modal = 'agent' | 'recipient' | 'token' | 'fund' | 'withdraw' | 'limits' | 'revoke' | '';

/* ───────── Contracts and network: unchanged from the original build ───────── */
const FACTORY_ABI = ['function vaultOf(address) view returns (address)', 'function createVault() returns (address)', 'event VaultCreated(address indexed owner,address indexed vault)'];
const VAULT_ABI = [
  'function owner() view returns(address)', 'function globallyPaused() view returns(bool)', 'function agents(address) view returns(bool registered,bool paused,uint128 maxNativePerTx,uint128 maxNativePerDay,uint64 dayStart,uint128 nativeSpentToday)',
  'function allowedRecipients(address) view returns(bool)', 'function allowedTokens(address) view returns(bool)', 'function tokenMaxPerTx(address) view returns(uint128)', 'function tokenMaxPerDay(address) view returns(uint128)',
  'function registerAgent(address,uint128,uint128)', 'function setAgentLimits(address,uint128,uint128)', 'function setAgentPaused(address,bool)', 'function revokeAgent(address)', 'function setGlobalPause(bool)', 'function setRecipient(address,bool)', 'function setTokenPolicy(address,bool,uint128,uint128)', 'function ownerWithdrawNative(address payable,uint128)', 'function ownerWithdrawToken(address,address,uint128)',
  'event AgentRegistered(address indexed agent,uint256 maxNativePerTx,uint256 maxNativePerDay)', 'event AgentStatusChanged(address indexed agent,bool paused)', 'event AgentRevoked(address indexed agent)', 'event RecipientPermissionChanged(address indexed recipient,bool allowed)', 'event TokenPolicyChanged(address indexed token,bool allowed,uint256 maxPerTx,uint256 maxPerDay)', 'event GlobalPauseChanged(bool paused)', 'event NativeTransferExecuted(address indexed agent,address indexed recipient,uint256 amount)', 'event TokenTransferExecuted(address indexed agent,address indexed token,address indexed recipient,uint256 amount)', 'event OwnerWithdrawal(address indexed asset,address indexed recipient,uint256 amount)',
];
const chainId = Number(process.env.NEXT_PUBLIC_RH_CHAIN_ID || process.env.NEXT_PUBLIC_RH_TESTNET_CHAIN_ID || '46630');
const networkName = process.env.NEXT_PUBLIC_RH_NETWORK_NAME || (chainId === 4663 ? 'MAINNET' : 'TESTNET');
// Public deployment configuration. Keep testnet defaults until a reviewed mainnet factory is deployed.
const factoryAddress = process.env.NEXT_PUBLIC_AGENTGUARD_FACTORY || (chainId === 46630 ? '0x5ce9DaDE59Ae1Dd6BAF9E2f83c2B703ad8b564E4' : '');
const explorer = process.env.NEXT_PUBLIC_RH_EXPLORER_URL || (chainId === 4663 ? 'https://robinhoodchain.blockscout.com' : 'https://explorer.testnet.chain.robinhood.com');
// Display label for the chain's native coin. Presentation only.
const SYMBOL = process.env.NEXT_PUBLIC_RH_NATIVE_SYMBOL || 'ETH';
const ZERO = '0x0000000000000000000000000000000000000000';

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const money = (n: bigint) => `${Number(formatEther(n)).toFixed(4)} ${SYMBOL}`;
const explorerBase = explorer.replace(/\/$/, '');

const NAV: { page: Page; icon: React.ReactNode }[] = [
  { page: 'Overview', icon: <Fingerprint /> },
  { page: 'My agents', icon: <Bot /> },
  { page: 'Permissions', icon: <SlidersHorizontal /> },
  { page: 'Activity', icon: <Activity /> },
  { page: 'Settings', icon: <LockKeyhole /> },
];

const MODAL_COPY: Record<Exclude<Modal, ''>, { title: string; text: string }> = {
  agent: { title: 'Register an agent', text: 'Register the wallet address your AI agent will use to call the protected vault. Never share its private key.' },
  recipient: { title: 'Approve a recipient', text: 'Only approved recipient addresses can receive agent transfers.' },
  token: { title: 'Approve an ERC-20 token', text: 'Allow direct transfers of a specific ERC-20 token contract.' },
  fund: { title: 'Fund your vault', text: 'Transfer native coin from your connected owner wallet into the protected vault.' },
  withdraw: { title: 'Withdraw native coin', text: 'Send native coin from the vault to a destination you control.' },
  limits: { title: 'Edit spending limits', text: 'Set the most this agent can send in one transaction and in one UTC day.' },
  revoke: { title: 'Revoke this agent', text: 'Revoking is permanent. The agent wallet loses all access to the vault.' },
};

export default function Home() {
  const [page, setPage] = useState<Page>('Overview');
  const [account, setAccount] = useState('');
  const [chain, setChain] = useState(0);
  const [vaultAddress, setVaultAddress] = useState('');
  const [vaultBalance, setVaultBalance] = useState('0');
  const [paused, setPaused] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [tokens, setTokens] = useState<string[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<Modal>('');
  const [target, setTarget] = useState<Agent | null>(null);
  const [address, setAddress] = useState('');
  const [perTx, setPerTx] = useState('0.01');
  const [perDay, setPerDay] = useState('0.05');
  const [tokenTx, setTokenTx] = useState('');
  const [tokenDay, setTokenDay] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [search, setSearch] = useState('');

  /* ───────── Wallet and contract logic: unchanged from the original build ───────── */
  const notify = (s: string) => { setToast(s); window.setTimeout(() => setToast(''), 3500); };
  const provider = useCallback(() => { if (!window.ethereum) throw new Error('Install a browser wallet such as MetaMask first.'); return new BrowserProvider(window.ethereum); }, []);
  const signerContract = useCallback(async (addr: string, abi: string[]) => { const p = provider(); const s = await p.getSigner(); return new Contract(addr, abi, s); }, [provider]);

  const readVault = useCallback(async (vault: string, owner: string) => {
    const p = provider(); const c = new Contract(vault, VAULT_ABI, p);
    const [bal, global, code] = await Promise.all([p.getBalance(vault), c.globallyPaused(), p.getCode(vault)]);
    if (code === '0x') throw new Error('Vault address has no contract code on this network.');
    setVaultBalance(formatEther(bal)); setPaused(global);
    // AgentRegistered is the discovery index for the agents mapping (which is
    // not enumerable). Always scan its complete history so agents remain visible
    // after the recent-activity window has moved forward. Keep each RPC request
    // small because providers may cap eth_getLogs ranges.
    const latest = await p.getBlockNumber();
    const recentFromBlock = Math.max(0, latest - 10000);
    const readLogs = async (filter: any, fromBlock: number) => {
      const out: any[] = [];
      for (let start = fromBlock; start <= latest; start += 2000) {
        const end = Math.min(latest, start + 1999);
        out.push(...await c.queryFilter(filter, start, end));
      }
      return out;
    };
    const readAllAgentLogs = async (filter: any) => readLogs(filter, 0);
    const [filterAgents, filterRecipients, filterTokens, filterNative, filterToken, filterWithdraw] = await Promise.all([
      c.filters.AgentRegistered(), c.filters.RecipientPermissionChanged(), c.filters.TokenPolicyChanged(), c.filters.NativeTransferExecuted(), c.filters.TokenTransferExecuted(), c.filters.OwnerWithdrawal(),
    ]);
    const [aLogs, rLogs, tLogs, nLogs, ttLogs, wLogs] = await Promise.all([
      readAllAgentLogs(filterAgents),
      readLogs(filterRecipients, recentFromBlock),
      readLogs(filterTokens, recentFromBlock),
      readLogs(filterNative, recentFromBlock),
      readLogs(filterToken, recentFromBlock),
      readLogs(filterWithdraw, recentFromBlock),
    ]);
    const agentSet = new Set<string>(); for (const l of aLogs) { const x = (l as any).args?.agent; if (x) agentSet.add(x.toLowerCase()); }
    const agentRows: Agent[] = []; for (const a of agentSet) { const x = await c.agents(a); if (x.registered) agentRows.push({ address: a, registered: x.registered, paused: x.paused, maxNativePerTx: x.maxNativePerTx, maxNativePerDay: x.maxNativePerDay, dayStart: x.dayStart, nativeSpentToday: x.nativeSpentToday }); }
    setAgents(agentRows);
    const rSet = new Set<string>(); for (const l of rLogs) { const x = (l as any).args; if (x?.allowed) rSet.add(x.recipient.toLowerCase()); else if (x?.recipient) rSet.delete(x.recipient.toLowerCase()); } setRecipients([...rSet]);
    const tSet = new Set<string>(); for (const l of tLogs) { const x = (l as any).args; if (x?.allowed) tSet.add(x.token.toLowerCase()); else if (x?.token) tSet.delete(x.token.toLowerCase()); } setTokens([...tSet]);
    const rows: EventRow[] = [];
    for (const l of nLogs) { const x = (l as any).args; rows.push({ title: 'Native transfer executed', detail: `${short(x.agent)} → ${short(x.recipient)} · ${formatEther(x.amount)} ${SYMBOL}`, hash: l.transactionHash, block: l.blockNumber, kind: 'good' }); }
    for (const l of ttLogs) { const x = (l as any).args; rows.push({ title: 'Token transfer executed', detail: `${short(x.agent)} → ${short(x.recipient)} · token ${short(x.token)}`, hash: l.transactionHash, block: l.blockNumber, kind: 'good' }); }
    for (const l of wLogs) { const x = (l as any).args; rows.push({ title: 'Owner withdrawal', detail: `${short(x.asset)} → ${short(x.recipient)} · ${x.amount.toString()} units`, hash: l.transactionHash, block: l.blockNumber, kind: 'neutral' }); }
    rows.sort((a, b) => b.block - a.block); setEvents(rows.slice(0, 100));
  }, []);

  const refresh = useCallback(async () => { if (!account || !vaultAddress) return; setBusy(true); try { await readVault(vaultAddress, account); } catch (e: any) { notify(e.shortMessage || e.message || 'Could not load vault.'); } finally { setBusy(false); } }, [account, vaultAddress, readVault]);
  const connect = async () => { try { const p = provider(); const a = await p.send('eth_requestAccounts', []); const net = await p.getNetwork(); setAccount(a[0]); setChain(Number(net.chainId)); } catch (e: any) { notify(e.shortMessage || e.message || 'Wallet connection failed.'); } };

  useEffect(() => { if (!window.ethereum) return; const onAccounts = (a: string[]) => { setAccount(a[0] || ''); setVaultAddress(''); }; const onChain = (c: string) => { setChain(Number(c)); setVaultAddress(''); }; window.ethereum.on?.('accountsChanged', onAccounts); window.ethereum.on?.('chainChanged', onChain); return () => { window.ethereum?.removeListener?.('accountsChanged', onAccounts); window.ethereum?.removeListener?.('chainChanged', onChain); }; }, []);
  useEffect(() => { let live = true; (async () => { if (!account || !chain || !factoryAddress || !chainId || chain !== chainId) return; try { const c = new Contract(factoryAddress, FACTORY_ABI, provider()); const v = await c.vaultOf(account); if (live && v !== ZERO) setVaultAddress(v); else if (live) setVaultAddress(''); } catch (e: any) { notify('Could not read factory. Check the configured factory address and network.'); } })(); return () => { live = false; }; }, [account, chain, provider]);
  useEffect(() => { if (vaultAddress && account) refresh(); }, [vaultAddress, account, refresh]);

  const ensureNetwork = async () => { if (!chainId) throw new Error('Robinhood Chain ID is not configured in this build.'); if (chain !== chainId) { try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + chainId.toString(16) }] }); } catch { throw new Error(`Switch your wallet to the configured Robinhood Chain network (chain ID ${chainId}).`); } } };
  const transact = async (fn: () => Promise<any>, success: string, afterConfirm?: () => Promise<void>) => { setBusy(true); try { await ensureNetwork(); const tx = await fn(); notify('Transaction submitted. Waiting for confirmation…'); await tx.wait(); if (afterConfirm) await afterConfirm(); notify(success); await refresh(); } catch (e: any) { notify(e.shortMessage || e.reason || e.message || 'Transaction failed.'); } finally { setBusy(false); } };

  const createVault = () => transact(async () => { if (!isAddress(factoryAddress)) throw new Error('The configured factory address is invalid.'); const p = provider(); const code = await p.getCode(factoryAddress); if (code === '0x') throw new Error(`AgentGuard factory contract was not found on this network. Switch to the configured Robinhood Chain network (chain ID ${chainId}).`); const c = await signerContract(factoryAddress, FACTORY_ABI); return c.createVault(); }, `Protected vault created on Robinhood Chain ${networkName}.`, async () => { const c = new Contract(factoryAddress, FACTORY_ABI, provider()); const v = await c.vaultOf(account); if (!isAddress(v) || v === ZERO) throw new Error('Vault creation confirmed, but the factory did not return a vault address. Refresh and check the explorer.'); setVaultAddress(v); });
  const addAgent = () => transact(async () => { if (!isAddress(address)) throw new Error('Enter a valid agent wallet address.'); if (parseEther(perTx) <= 0n || parseEther(perDay) < parseEther(perTx)) throw new Error('Daily limit must be greater than or equal to the per-transaction limit, and both must be above zero.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.registerAgent(address, parseEther(perTx), parseEther(perDay)); }, 'Agent registered on-chain.', async () => { const c = new Contract(vaultAddress, VAULT_ABI, provider()); const a = await c.agents(address); if (!a.registered) throw new Error('Registration transaction confirmed, but the agent mapping did not update. Refresh and check the explorer.'); });
  const addRecipient = () => transact(async () => { if (!isAddress(address)) throw new Error('Enter a valid recipient address.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.setRecipient(address, true); }, 'Recipient allowlisted on-chain.');
  const addToken = () => transact(async () => { if (!isAddress(address)) throw new Error('Enter a valid token contract address.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.setTokenPolicy(address, true, BigInt(tokenTx), BigInt(tokenDay)); }, 'Token policy saved on-chain.');
  const fund = () => transact(async () => { const s = await provider().getSigner(); return s.sendTransaction({ to: vaultAddress, value: parseEther(amount) }); }, 'Vault funded.');
  const withdraw = () => transact(async () => { if (!isAddress(recipient)) throw new Error('Enter a valid destination address.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.ownerWithdrawNative(recipient, parseEther(amount)); }, 'Native asset withdrawn.');
  const toggleAgent = (a: Agent) => transact(async () => { const c = await signerContract(vaultAddress, VAULT_ABI); return c.setAgentPaused(a.address, !a.paused); }, a.paused ? 'Agent resumed.' : 'Agent paused.');
  const toggleGlobal = () => transact(async () => { const c = await signerContract(vaultAddress, VAULT_ABI); return c.setGlobalPause(!paused); }, paused ? 'All agents resumed.' : 'Emergency pause enabled.');
  const removeRecipient = (a: string) => transact(async () => { const c = await signerContract(vaultAddress, VAULT_ABI); return c.setRecipient(a, false); }, 'Recipient removed.');
  const removeToken = (a: string) => transact(async () => { const c = await signerContract(vaultAddress, VAULT_ABI); return c.setTokenPolicy(a, false, 0, 0); }, 'Token policy removed.');

  // Same two contract calls as before (setAgentLimits, revokeAgent). The browser prompt() and confirm()
  // boxes are replaced by the 'limits' and 'revoke' dialogs below.
  const editAgentLimits = (a: Agent) => { setTarget(a); setPerTx(formatEther(a.maxNativePerTx)); setPerDay(formatEther(a.maxNativePerDay)); setModal('limits'); };
  const saveAgentLimits = () => transact(async () => { if (!target) throw new Error('No agent selected.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.setAgentLimits(target.address, parseEther(perTx), parseEther(perDay)); }, 'Agent limits updated on-chain.');
  const revokeAgent = (a: Agent) => { setTarget(a); setModal('revoke'); };
  const confirmRevoke = () => transact(async () => { if (!target) throw new Error('No agent selected.'); const c = await signerContract(vaultAddress, VAULT_ABI); return c.revokeAgent(target.address); }, 'Agent revoked.');

  const filteredAgents = useMemo(() => agents.filter(a => a.address.toLowerCase().includes(search.toLowerCase())), [agents, search]);
  const modalClose = () => { if (modal === 'limits') { setPerTx('0.01'); setPerDay('0.05'); } setModal(''); setTarget(null); setAddress(''); setAmount(''); setRecipient(''); };
  const submitModal = async () => {
    if (modal === 'agent') await addAgent();
    if (modal === 'recipient') await addRecipient();
    if (modal === 'token') await addToken();
    if (modal === 'fund') await fund();
    if (modal === 'withdraw') await withdraw();
    if (modal === 'limits') await saveAgentLimits();
    if (modal === 'revoke') await confirmRevoke();
    modalClose();
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => notify('Address copied.')).catch(() => notify(text)); };

  /* ───────── Views ───────── */
  const toastEl = toast ? <div className="toast" role="status">{toast}</div> : null;

  if (!account) {
    return (
      <>
        <Landing onConnect={connect} networkName={networkName} chainId={chainId} factoryAddress={factoryAddress} explorer={explorer} symbol={SYMBOL} configMissing={!chainId || !factoryAddress} />
        {toastEl}
      </>
    );
  }

  const warning = !chainId || !factoryAddress
    ? 'Network setup is incomplete. Add the verified chain ID and deployed factory address to the public environment settings before connecting.'
    : chain !== chainId
      ? `Your wallet is connected to chain ${chain}. Switch to the configured Robinhood Chain network (chain ${chainId}) before managing your vault.`
      : '';

  return (
    <div className="app">
      <aside className="rail">
        <Brand />
        <div className="rail-ws">
          <b>Personal workspace</b>
          <span>Robinhood Chain {networkName.toLowerCase()}</span>
        </div>
        <nav aria-label="Workspace">
          {NAV.map(n => (
            <button key={n.page} onClick={() => setPage(n.page)} className={page === n.page ? 'on' : ''} aria-current={page === n.page ? 'page' : undefined}>
              {n.icon}{n.page}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <b>AgentGuard V1</b>
          <span>On-chain permission vault</span>
          <a href="/agent">Agent execution tool</a>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div>
            <small>Workspace / {page}</small>
            <h1>{page === 'Overview' ? 'Security overview' : page}</h1>
          </div>
          <div className="top-actions">
            <span className="net"><i />Robinhood Chain <em>{networkName.toLowerCase()}</em></span>
            <button className="btn btn-ghost btn-sm mono" onClick={() => notify(account)}><Wallet size={15} /> {short(account)}</button>
          </div>
        </header>

        {warning && <div className="warning"><CircleAlert size={17} /> {warning}</div>}

        {!vaultAddress ? (
          <section className="create">
            <div className="orbit" aria-hidden="true"><i /><i /><i /><i /><i /><b /></div>
            <div className="create-copy">
              <p className="kicker">Wallet connected: <span className="mono">{short(account)}</span></p>
              <h2>Create your protected vault.</h2>
              <p>Your vault is a dedicated smart contract controlled by your wallet. Fund it, register agent addresses, and define what each agent is allowed to do.</p>
              <button className="btn btn-primary" disabled={busy || !factoryAddress} onClick={createVault}><Plus size={17} /> {busy ? 'Processing…' : 'Create protected vault'}</button>
              <small>One vault per owner wallet. Deploying the contract needs gas on Robinhood Chain {networkName.toLowerCase()}.</small>
              <ol className="create-next">
                <li><b>1</b>Create the vault</li>
                <li><b>2</b>Fund it and register your agent</li>
                <li><b>3</b>Set limits and approved recipients</li>
              </ol>
            </div>
          </section>
        ) : (
          <>
            <section className={`vault ${paused ? 'is-paused' : ''}`}>
              <div className="vault-id">
                <small>Protected vault</small>
                <b className="mono">{short(vaultAddress)}</b>
                <span className="vault-tools">
                  <button title="Copy vault address" aria-label="Copy vault address" onClick={() => copy(vaultAddress)}><Copy size={14} /></button>
                  {explorer && <a title="Open in explorer" aria-label="Open vault in explorer" href={`${explorerBase}/address/${vaultAddress}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>}
                </span>
              </div>
              <div>
                <small>Vault balance</small>
                <b className="vault-bal">{Number(vaultBalance).toFixed(5)} <em>{SYMBOL}</em></b>
              </div>
              <div>
                <small>Global control</small>
                <b className="vault-state"><i />{paused ? 'Emergency paused' : 'Protection active'}</b>
              </div>
              <button className={`btn btn-sm ${paused ? 'btn-ghost' : 'btn-stop'}`} disabled={busy} onClick={toggleGlobal}>
                {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume agents' : 'Emergency pause'}
              </button>
            </section>

            {page === 'Overview' && (
              <>
                <div className="intro">
                  <div>
                    <h2>Your agents, under control.</h2>
                    <p>Every permission is enforced by the vault contract, not this dashboard.</p>
                  </div>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={refresh}><RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh</button>
                </div>
                <dl className="stats">
                  <div><dt>Registered agents</dt><dd>{agents.length}</dd></div>
                  <div><dt>Approved recipients</dt><dd>{recipients.length}</dd></div>
                  <div><dt>Approved tokens</dt><dd>{tokens.length}</dd></div>
                  <div><dt>Recorded transfers</dt><dd>{events.length}</dd></div>
                </dl>
                <section className="panel">
                  <div className="panel-head">
                    <div><h3>Registered agents</h3><p>Only these addresses can call protected transfer functions.</p></div>
                    <button className="btn btn-primary btn-sm" onClick={() => setModal('agent')}><Plus size={15} /> Register agent</button>
                  </div>
                  <AgentTable rows={agents.slice(0, 5)} onToggle={toggleAgent} onRevoke={revokeAgent} onEdit={editAgentLimits} busy={busy} />
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div><h3>Recent on-chain activity</h3><p>Events emitted by your vault contract.</p></div>
                    <button className="link" onClick={() => setPage('Activity')}>View all <ChevronRight size={14} /></button>
                  </div>
                  <EventList rows={events.slice(0, 5)} />
                </section>
              </>
            )}

            {page === 'My agents' && (
              <section className="panel">
                <div className="panel-head">
                  <div><h3>Agent registry</h3><p>Register, pause, resume or permanently revoke an agent wallet.</p></div>
                  <button className="btn btn-primary btn-sm" onClick={() => setModal('agent')}><Plus size={15} /> Register agent</button>
                </div>
                <input className="search" id="agent-search" aria-label="Search wallet address" placeholder="Search wallet address" value={search} onChange={e => setSearch(e.target.value)} />
                <AgentTable rows={filteredAgents} onToggle={toggleAgent} onRevoke={revokeAgent} onEdit={editAgentLimits} busy={busy} />
              </section>
            )}

            {page === 'Permissions' && (
              <>
                <div className="intro">
                  <div>
                    <h2>Define the boundaries.</h2>
                    <p>Agents can only transfer to approved recipients and only move approved tokens within configured limits.</p>
                  </div>
                </div>
                <div className="two">
                  <section className="panel">
                    <div className="panel-head">
                      <div><h3>Approved recipients</h3><p>Destination wallets agents may send funds to.</p></div>
                      <button className="btn btn-primary btn-sm" onClick={() => setModal('recipient')}><Plus size={14} /> Add</button>
                    </div>
                    {recipients.length ? recipients.map(a => (
                      <div className="addr-row" key={a}><code>{a}</code><button className="link link-stop" disabled={busy} onClick={() => removeRecipient(a)}>Remove</button></div>
                    )) : <p className="empty">No recipient addresses approved.</p>}
                  </section>
                  <section className="panel">
                    <div className="panel-head">
                      <div><h3>Approved tokens</h3><p>ERC-20 tokens agents may transfer directly.</p></div>
                      <button className="btn btn-primary btn-sm" onClick={() => setModal('token')}><Plus size={14} /> Add</button>
                    </div>
                    {tokens.length ? tokens.map(a => (
                      <div className="addr-row" key={a}><code>{a}</code><button className="link link-stop" disabled={busy} onClick={() => removeToken(a)}>Remove</button></div>
                    )) : <p className="empty">No token contracts approved.</p>}
                  </section>
                </div>
                <div className="notice"><ShieldAlert size={19} /><div><b>V1 execution scope</b><p>AgentGuard V1 allows native coin transfers and direct ERC-20 transfers only. It does not execute DEX swaps, approve spenders, or run arbitrary contract calls.</p></div></div>
              </>
            )}

            {page === 'Activity' && (
              <section className="panel">
                <div className="panel-head">
                  <div><h3>Vault event history</h3><p>Transfer and withdrawal events read from the vault contract.</p></div>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={refresh}><RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh</button>
                </div>
                <EventList rows={events} />
              </section>
            )}

            {page === 'Settings' && (
              <>
                <section className="panel">
                  <div className="panel-head"><div><h3>Vault management</h3><p>Owner wallet: <span className="mono">{account}</span></p></div></div>
                  <div className="setting"><div><b>Fund protected vault</b><p>Send native coin into the vault. Agent spending limits still apply.</p></div><button className="btn btn-primary btn-sm" onClick={() => setModal('fund')}>Add funds</button></div>
                  <div className="setting"><div><b>Withdraw native coin</b><p>Owner can recover native coin from the vault at any time.</p></div><button className="btn btn-ghost btn-sm" onClick={() => setModal('withdraw')}>Withdraw</button></div>
                  <div className="setting"><div><b>Vault contract</b><p className="mono">{vaultAddress}</p></div><button className="btn btn-ghost btn-sm" onClick={() => copy(vaultAddress)}><Copy size={14} /> Copy</button></div>
                  <div className="setting"><div><b>Network</b><p>Configured chain ID: {chainId}. Connected wallet chain ID: {chain}.</p></div><span className={`pill ${chain === chainId ? '' : 'pill-stop'}`}>{chain === chainId ? 'Matched' : 'Wrong network'}</span></div>
                </section>
                <div className="notice"><CircleAlert size={19} /><div><b>Security reminder</b><p>Only assets held by this vault are protected. Assets left in an ordinary agent wallet are not intercepted or protected by AgentGuard. Review and independently audit contracts before mainnet use.</p></div></div>
              </>
            )}
          </>
        )}
      </main>

      {toastEl}

      {modal && (
        <div className="modal-back" onClick={modalClose}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()}>
            <button className="modal-x" aria-label="Close" onClick={modalClose}><X size={18} /></button>
            <p className="kicker">Vault configuration</p>
            <h3 id="modal-title">{MODAL_COPY[modal].title}</h3>
            <p className="modal-text">{MODAL_COPY[modal].text}</p>

            {modal === 'agent' && (
              <>
                <label htmlFor="f-agent">Agent wallet address<input id="f-agent" className="mono" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></label>
                <div className="form-two">
                  <label htmlFor="f-pertx">Max {SYMBOL} / transaction<input id="f-pertx" value={perTx} onChange={e => setPerTx(e.target.value)} type="number" min="0" /></label>
                  <label htmlFor="f-perday">Max {SYMBOL} / day<input id="f-perday" value={perDay} onChange={e => setPerDay(e.target.value)} type="number" min="0" /></label>
                </div>
              </>
            )}
            {modal === 'limits' && target && (
              <>
                <p className="modal-target mono">{target.address}</p>
                <div className="form-two">
                  <label htmlFor="f-limtx">Max {SYMBOL} / transaction<input id="f-limtx" value={perTx} onChange={e => setPerTx(e.target.value)} type="number" min="0" step="any" /></label>
                  <label htmlFor="f-limday">Max {SYMBOL} / UTC day<input id="f-limday" value={perDay} onChange={e => setPerDay(e.target.value)} type="number" min="0" step="any" /></label>
                </div>
              </>
            )}
            {modal === 'revoke' && target && <p className="modal-target mono">{target.address}</p>}
            {modal === 'recipient' && <label htmlFor="f-recipient">Recipient wallet address<input id="f-recipient" className="mono" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></label>}
            {modal === 'token' && (
              <>
                <label htmlFor="f-token">ERC-20 contract address<input id="f-token" className="mono" value={address} onChange={e => setAddress(e.target.value)} placeholder="0x…" /></label>
                <div className="form-two">
                  <label htmlFor="f-toktx">Max token units / tx<input id="f-toktx" value={tokenTx} onChange={e => setTokenTx(e.target.value)} type="number" min="1" /></label>
                  <label htmlFor="f-tokday">Max token units / day<input id="f-tokday" value={tokenDay} onChange={e => setTokenDay(e.target.value)} type="number" min="1" /></label>
                </div>
                <small className="help">Limits use the token&apos;s smallest units. For a 6-decimal token, 1 token = 1,000,000 units.</small>
              </>
            )}
            {(modal === 'fund' || modal === 'withdraw') && (
              <>
                <label htmlFor="f-amount">Amount ({SYMBOL})<input id="f-amount" value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" step="any" placeholder="0.01" /></label>
                {modal === 'withdraw' && <label htmlFor="f-dest">Destination address<input id="f-dest" className="mono" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="0x…" /></label>}
              </>
            )}

            <button className={`btn ${modal === 'revoke' ? 'btn-stop-solid' : 'btn-primary'} modal-submit`} disabled={busy} onClick={submitModal}>
              {busy ? 'Waiting for wallet…' : modal === 'revoke' ? 'Revoke agent on-chain' : 'Confirm on-chain transaction'}
            </button>
            <small className="help">Your wallet will ask you to review and sign this transaction.</small>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentTable({ rows, onToggle, onRevoke, onEdit, busy }: { rows: Agent[]; onToggle: (a: Agent) => void; onRevoke: (a: Agent) => void; onEdit: (a: Agent) => void; busy: boolean }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>Agent wallet</th><th>Status</th><th>Max / tx</th><th>Max / day</th><th>Spent today</th><th><span className="sr">Actions</span></th></tr></thead>
        <tbody>
          {rows.map(a => {
            const pct = a.maxNativePerDay > 0n ? Math.min(100, Number((a.nativeSpentToday * 10000n) / a.maxNativePerDay) / 100) : 0;
            return (
              <tr key={a.address}>
                <td data-label="Agent wallet"><code>{short(a.address)}</code></td>
                <td data-label="Status"><span className={`pill ${a.paused ? 'pill-stop' : ''}`}>{a.paused ? 'Paused' : 'Active'}</span></td>
                <td data-label="Max / tx">{money(a.maxNativePerTx)}</td>
                <td data-label="Max / day">{money(a.maxNativePerDay)}</td>
                <td data-label="Spent today"><span className="spent">{money(a.nativeSpentToday)}<span className="meter"><i style={{ width: `${pct}%` }} /></span></span></td>
                <td className="tbl-actions">
                  <button disabled={busy} title="Edit spending limits" aria-label="Edit spending limits" onClick={() => onEdit(a)}><SlidersHorizontal size={15} /></button>
                  <button disabled={busy} title={a.paused ? 'Resume' : 'Pause'} aria-label={a.paused ? 'Resume agent' : 'Pause agent'} onClick={() => onToggle(a)}>{a.paused ? <Play size={15} /> : <Pause size={15} />}</button>
                  <button disabled={busy} className="act-stop" title="Revoke" aria-label="Revoke agent" onClick={() => onRevoke(a)}><Power size={15} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p className="empty">No agents registered in this vault yet.</p>}
    </div>
  );
}

function EventList({ rows }: { rows: EventRow[] }) {
  return (
    <div className="events">
      {rows.map((e, i) => (
        <div className={`event ${e.kind === 'good' ? 'event-good' : ''}`} key={`${e.hash}-${i}`}>
          <i aria-hidden="true" />
          <div><b>{e.title}</b><small>{e.detail} · Block {e.block}</small></div>
          {explorer && <a title="Open transaction in explorer" aria-label="Open transaction in explorer" href={`${explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>}
        </div>
      ))}
      {!rows.length && <p className="empty">No transfer events recorded yet.</p>}
    </div>
  );
}
