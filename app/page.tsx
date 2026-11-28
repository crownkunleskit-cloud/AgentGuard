'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatEther, parseEther, isAddress, zeroPadValue } from 'ethers';
import { Activity, Bot, ChevronRight, CircleAlert, Copy, ExternalLink, Fingerprint, Bell, HeartPulse, LockKeyhole, Pause, Play, Plus, Power, RefreshCw, TrendingUp, ShieldAlert, SlidersHorizontal, ShieldCheck, Wallet, X } from 'lucide-react';
import Landing from './components/Landing';
import { Brand } from './components/Mark';
import { blockscoutSource, scanLogs, type LogSource, type RawLog } from './lib/logScan';
import { buildEntries, fetchFailedTxs, filterEntries, type FailedTx, type LogEntry, type LogFilter, type ParsedLog } from './lib/activityLog';
import AgentHealthView, { type HealthPermissions } from './components/AgentHealth';
import AgentRiskView from './components/AgentRisk';
import AgentProfilesSection from './components/AgentProfiles';
import SecurityAlertsSection from './components/SecurityAlerts';
import SpendingAnalyticsSection from './components/SpendingAnalytics';
import { computeRisk } from './lib/agentRisk';
import { computeHealth, currentPermissions, type FailedDataState, type LiveAgent } from './lib/agentHealth';

declare global { interface Window { ethereum?: any } }

type Agent = { address: string; registered: boolean; paused: boolean; maxNativePerTx: bigint; maxNativePerDay: bigint; dayStart: bigint; nativeSpentToday: bigint };
type EventRow = { title: string; detail: string; hash: string; block: number; kind: 'good' | 'bad' | 'neutral' };
type AgentsState = 'loading' | 'ok' | 'error';
const LOG_FILTERS: { id: LogFilter; label: string }[] = [{ id: 'all', label: 'All activity' }, { id: 'transaction', label: 'Transactions' }, { id: 'agent', label: 'Agent activity' }, { id: 'security', label: 'Security events' }];
type Page = 'Overview' | 'My agents' | 'Permissions' | 'Activity' | 'Agent Health' | 'Risk Insights' | 'Agent Profiles' | 'Security Alerts' | 'Spending Analytics' | 'Settings';
type Modal = 'agent' | 'recipient' | 'token' | 'fund' | 'withdraw' | 'limits' | 'revoke' | '';

/* ───────── Contracts and network: unchanged from the original build ───────── */
const FACTORY_ABI = ['function vaultOf(address) view returns (address)', 'function createVault() returns (address)', 'event VaultCreated(address indexed owner,address indexed vault)'];
const VAULT_ABI = [
  'function owner() view returns(address)', 'function globallyPaused() view returns(bool)', 'function agents(address) view returns(bool registered,bool paused,uint128 maxNativePerTx,uint128 maxNativePerDay,uint64 dayStart,uint128 nativeSpentToday)',
  'function allowedRecipients(address) view returns(bool)', 'function allowedTokens(address) view returns(bool)', 'function tokenMaxPerTx(address) view returns(uint128)', 'function tokenMaxPerDay(address) view returns(uint128)',
  'function registerAgent(address,uint128,uint128)', 'function setAgentLimits(address,uint128,uint128)', 'function setAgentPaused(address,bool)', 'function revokeAgent(address)', 'function setGlobalPause(bool)', 'function setRecipient(address,bool)', 'function setTokenPolicy(address,bool,uint128,uint128)', 'function ownerWithdrawNative(address payable,uint128)', 'function ownerWithdrawToken(address,address,uint128)',
  // Agent transfer functions. Listed so reverted agent calls can be decoded by name and arguments (Activity logs / Risk Insights).
  'function executeNative(address payable recipient,uint128 amount)', 'function executeTokenTransfer(address token,address recipient,uint128 amount)',
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
// Read-only RPC used to scan vault event history. Defaults are the public endpoints already listed in hardhat.config.ts.
const READ_RPC = process.env.NEXT_PUBLIC_RH_RPC_URL || (chainId === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : chainId === 46630 ? 'https://rpc.testnet.chain.robinhood.com' : '');
const vaultIface = new Interface(VAULT_ABI);

// Activity & Security Logs helpers (the registered-agent discovery in readVault is unchanged and keeps its own copy of this setup).
const rpcLogSource = (name: string, prov: { getBlockNumber(): Promise<number>; getLogs(f: any): Promise<readonly any[]> }): LogSource => ({
  name,
  getLatest: () => prov.getBlockNumber(),
  getLogs: async (address, topics, from, to) => (await prov.getLogs({ address, topics, fromBlock: from, toBlock: to })).map((l: any): RawLog => ({ blockNumber: l.blockNumber, index: l.index, transactionHash: l.transactionHash, topics: [...l.topics], data: l.data })),
});
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const money = (n: bigint) => `${Number(formatEther(n)).toFixed(4)} ${SYMBOL}`;
const explorerBase = explorer.replace(/\/$/, '');

const NAV: { page: Page; icon: React.ReactNode }[] = [
  { page: 'Overview', icon: <Fingerprint /> },
  { page: 'My agents', icon: <Bot /> },
  { page: 'Permissions', icon: <SlidersHorizontal /> },
  { page: 'Activity', icon: <Activity /> },
  { page: 'Agent Health', icon: <HeartPulse /> },
  { page: 'Risk Insights', icon: <ShieldAlert /> },
  { page: 'Agent Profiles', icon: <ShieldCheck /> },
  { page: 'Security Alerts', icon: <Bell /> },
  { page: 'Spending Analytics', icon: <TrendingUp /> },
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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsState, setLogsState] = useState<AgentsState>('loading');
  const [logsError, setLogsError] = useState('');
  const [logsNote, setLogsNote] = useState('');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logLimit, setLogLimit] = useState(100);
  const logsVault = useRef('');
  // Agent Health Monitoring: reuses the Activity & Security Logs data above; adds live contract reads.
  const [failedState, setFailedState] = useState<FailedDataState>('unavailable');
  const [healthLive, setHealthLive] = useState<{ live: Map<string, LiveAgent>; globalPaused: boolean | null; permissions: HealthPermissions | null; checkedAt: number } | null>(null);
  const [healthNonce, setHealthNonce] = useState(0);
  const healthRun = useRef(0);
  const [healthBusy, setHealthBusy] = useState(false);
  const [agentsState, setAgentsState] = useState<AgentsState>('loading');
  const [agentsError, setAgentsError] = useState('');
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
    // Registered agents are not enumerable on-chain, so they are discovered from the vault's AgentRegistered
    // events. The whole history is scanned (from the block the vault was created in), never a fixed recent
    // window, and a failed query is reported as an error instead of being shown as "no agents".
    const sources: LogSource[] = [];
    const rpcSource = (name: string, prov: { getBlockNumber(): Promise<number>; getLogs(f: any): Promise<readonly any[]> }): LogSource => ({
      name,
      getLatest: () => prov.getBlockNumber(),
      getLogs: async (address, topics, from, to) => (await prov.getLogs({ address, topics, fromBlock: from, toBlock: to })).map((l: any): RawLog => ({ blockNumber: l.blockNumber, index: l.index, transactionHash: l.transactionHash, topics: [...l.topics], data: l.data })),
    });
    if (READ_RPC) sources.push(rpcSource('public RPC', new JsonRpcProvider(READ_RPC, chainId, { staticNetwork: true })));
    sources.push(rpcSource('wallet RPC', p));
    if (explorerBase) sources.push(blockscoutSource(explorerBase));
    // The factory's VaultCreated(owner, vault) event gives the vault's creation block; nothing earlier can contain vault events.
    let startBlock = 0;
    try {
      if (isAddress(factoryAddress)) {
        const created = await scanLogs(sources, factoryAddress, [new Interface(FACTORY_ABI).getEvent('VaultCreated')!.topicHash, zeroPadValue(owner, 32).toLowerCase(), zeroPadValue(vault, 32).toLowerCase()], 0);
        if (created.length) startBlock = created[0].blockNumber;
      }
    } catch { startBlock = 0; }
    const readLogs = async (name: string) => (await scanLogs(sources, vault, [vaultIface.getEvent(name)!.topicHash], startBlock)).map(l => ({ args: vaultIface.parseLog({ topics: l.topics, data: l.data })!.args, transactionHash: l.transactionHash, blockNumber: l.blockNumber }));

    try {
      const aLogs = await readLogs('AgentRegistered');
      const agentSet = new Set<string>(); for (const l of aLogs) { const x = (l as any).args?.agent; if (x) agentSet.add(x.toLowerCase()); }
      // Every discovered address is checked against the live agents(address) mapping (source of truth). A failed read throws.
      const checked = await Promise.all([...agentSet].map(async a => ({ a, x: await c.agents(a) })));
      const agentRows: Agent[] = checked.filter(({ x }) => x.registered).map(({ a, x }) => ({ address: a, registered: x.registered, paused: x.paused, maxNativePerTx: x.maxNativePerTx, maxNativePerDay: x.maxNativePerDay, dayStart: x.dayStart, nativeSpentToday: x.nativeSpentToday }));
      setAgents(agentRows); setAgentsState('ok'); setAgentsError('');
    } catch (e: any) {
      setAgentsState('error'); setAgentsError(e.shortMessage || e.message || 'Could not read registered agents.');
      throw e;
    }
    const [rLogs, tLogs, nLogs, ttLogs, wLogs] = await Promise.all([readLogs('RecipientPermissionChanged'), readLogs('TokenPolicyChanged'), readLogs('NativeTransferExecuted'), readLogs('TokenTransferExecuted'), readLogs('OwnerWithdrawal')]);
    const rSet = new Set<string>(); for (const l of rLogs) { const x = (l as any).args; if (x?.allowed) rSet.add(x.recipient.toLowerCase()); else if (x?.recipient) rSet.delete(x.recipient.toLowerCase()); } setRecipients([...rSet]);
    const tSet = new Set<string>(); for (const l of tLogs) { const x = (l as any).args; if (x?.allowed) tSet.add(x.token.toLowerCase()); else if (x?.token) tSet.delete(x.token.toLowerCase()); } setTokens([...tSet]);
    const rows: EventRow[] = [];
    for (const l of nLogs) { const x = (l as any).args; rows.push({ title: 'Native transfer executed', detail: `${short(x.agent)} → ${short(x.recipient)} · ${formatEther(x.amount)} ${SYMBOL}`, hash: l.transactionHash, block: l.blockNumber, kind: 'good' }); }
    for (const l of ttLogs) { const x = (l as any).args; rows.push({ title: 'Token transfer executed', detail: `${short(x.agent)} → ${short(x.recipient)} · token ${short(x.token)}`, hash: l.transactionHash, block: l.blockNumber, kind: 'good' }); }
    for (const l of wLogs) { const x = (l as any).args; rows.push({ title: 'Owner withdrawal', detail: `${short(x.asset)} → ${short(x.recipient)} · ${x.amount.toString()} units`, hash: l.transactionHash, block: l.blockNumber, kind: 'neutral' }); }
    rows.sort((a, b) => b.block - a.block); setEvents(rows.slice(0, 100));
  }, []);

  const refresh = useCallback(async () => { if (!account || !vaultAddress) return; setBusy(true); setAgentsState(st => (st === 'ok' ? st : 'loading')); try { await readVault(vaultAddress, account); } catch (e: any) { notify(e.shortMessage || e.message || 'Could not load vault.'); } finally { setBusy(false); } }, [account, vaultAddress, readVault]);
  // Activity & Security Logs: read from the connected vault's real event history (whole history, from the block the vault was created in).
  const loadLogs = useCallback(async () => {
    if (!account || !vaultAddress) return;
    const vault = vaultAddress; logsVault.current = vault;
    setLogsState(st => (st === 'ok' ? st : 'loading')); setLogsError('');
    try {
      const p = provider();
      const pub = READ_RPC ? new JsonRpcProvider(READ_RPC, chainId, { staticNetwork: true }) : null;
      const sources: LogSource[] = [];
      if (pub) sources.push(rpcLogSource('public RPC', pub));
      sources.push(rpcLogSource('wallet RPC', p));
      if (explorerBase) sources.push(blockscoutSource(explorerBase));
      let start = 0;
      try { if (isAddress(factoryAddress)) { const created = await scanLogs(sources, factoryAddress, [new Interface(FACTORY_ABI).getEvent('VaultCreated')!.topicHash, zeroPadValue(account, 32).toLowerCase(), zeroPadValue(vault, 32).toLowerCase()], 0); if (created.length) start = created[0].blockNumber; } } catch { start = 0; }
      const raw = await scanLogs(sources, vault, [], start); // no topic filter: every event the vault emitted
      const parsed: ParsedLog[] = [];
      for (const l of raw) { try { const pl = vaultIface.parseLog({ topics: l.topics, data: l.data }); if (pl) parsed.push({ name: pl.name, args: pl.args as any, blockNumber: l.blockNumber, index: l.index, transactionHash: l.transactionHash, timestamp: 0 }); } catch { /* not a vault event */ } }
      const blocks = [...new Set(parsed.map(l => l.blockNumber))]; const times = new Map<number, number>();
      for (let i = 0; i < blocks.length; i += 8) await Promise.all(blocks.slice(i, i + 8).map(async n => { for (const prov of [pub, p]) { if (!prov) continue; try { const b = await prov.getBlock(n); if (b) { times.set(n, Number(b.timestamp)); return; } } catch { /* try next provider */ } } }));
      for (const l of parsed) l.timestamp = times.get(l.blockNumber) || 0;
      // Reverted transactions emit no events, so they are only visible through the block explorer's indexed transaction list.
      let failed: FailedTx[] = []; let note = ''; let failedComplete: FailedDataState = 'unavailable';
      try {
        const r = await fetchFailedTxs(explorerBase, vault);
        failed = r.txs.map(t => {
          let fn = ''; let recipient: string | undefined; let token: string | undefined; let amount: bigint | undefined;
          try {
            const d = vaultIface.parseTransaction({ data: t.input }); fn = d?.name || '';
            if (d && fn === 'executeNative') { recipient = d.args[0]; amount = BigInt(d.args[1]); }
            else if (d && fn === 'executeTokenTransfer') { token = d.args[0]; recipient = d.args[1]; amount = BigInt(d.args[2]); }
          } catch { fn = ''; }
          return { hash: t.hash, from: t.from, blockNumber: t.blockNumber, timestamp: t.timestamp, fn, recipient, token, amount };
        });
        failedComplete = r.complete ? 'complete' : 'partial';
        if (!r.complete) note = 'Only the most recent reverted transactions could be loaded from the block explorer.';
      } catch { note = 'Reverted transactions could not be loaded from the block explorer right now, so only successful on-chain events are listed below.'; }
      if (logsVault.current !== vault) return;
      setLogs(buildEntries(parsed, failed, { short, native: n => `${formatEther(n)} ${SYMBOL}` })); setLogsNote(note); setFailedState(failedComplete); setLogsState('ok');
    } catch (e: any) {
      if (logsVault.current !== vault) return;
      setLogsState('error'); setLogsError(e.shortMessage || e.message || 'Could not read vault history.');
    }
  }, [account, vaultAddress, provider]);

  const connect = async () => { try { const p = provider(); const a = await p.send('eth_requestAccounts', []); const net = await p.getNetwork(); setAccount(a[0]); setChain(Number(net.chainId)); } catch (e: any) { notify(e.shortMessage || e.message || 'Wallet connection failed.'); } };

  useEffect(() => { if (!window.ethereum) return; const onAccounts = (a: string[]) => { setAccount(a[0] || ''); setVaultAddress(''); }; const onChain = (c: string) => { setChain(Number(c)); setVaultAddress(''); }; window.ethereum.on?.('accountsChanged', onAccounts); window.ethereum.on?.('chainChanged', onChain); return () => { window.ethereum?.removeListener?.('accountsChanged', onAccounts); window.ethereum?.removeListener?.('chainChanged', onChain); }; }, []);
  useEffect(() => { let live = true; (async () => { if (!account || !chain || !factoryAddress || !chainId || chain !== chainId) return; try { const c = new Contract(factoryAddress, FACTORY_ABI, provider()); const v = await c.vaultOf(account); if (live && v !== ZERO) setVaultAddress(v); else if (live) setVaultAddress(''); } catch (e: any) { notify('Could not read factory. Check the configured factory address and network.'); } })(); return () => { live = false; }; }, [account, chain, provider]);
  useEffect(() => { setLogs([]); setLogsState('loading'); setLogsError(''); setLogsNote(''); setLogLimit(100); }, [vaultAddress]);
  useEffect(() => { if ((page === 'Activity' || page === 'Agent Health' || page === 'Risk Insights' || page === 'Agent Profiles' || page === 'Security Alerts' || page === 'Spending Analytics') && vaultAddress && account && chain === chainId) loadLogs(); }, [page, vaultAddress, account, chain, loadLogs]);
  useEffect(() => { healthRun.current++; setHealthLive(null); setHealthBusy(false); }, [vaultAddress]);

  // Agent Health: every agent ever registered (from the logs, so revoked agents are included) plus the live-registered ones.
  const healthAddrs = useMemo(() => [...new Set([...agents.map(a => a.address.toLowerCase()), ...(logsState === 'ok' ? logs.filter(e => e.type === 'Agent registered' && e.agent).map(e => e.agent!.toLowerCase()) : [])])].sort(), [agents, logs, logsState]);
  const healthPerms = useMemo(() => (logsState === 'ok' ? currentPermissions(logs) : null), [logs, logsState]);
  // Live reads (authorization, pause state, approved recipients/tokens) run each time the page opens or is refreshed. A failed read is
  // recorded as a failure (shown as Unknown / Unavailable), never as "not registered" or "none".
  useEffect(() => {
    if ((page !== 'Agent Health' && page !== 'Risk Insights' && page !== 'Agent Profiles' && page !== 'Security Alerts' && page !== 'Spending Analytics') || !vaultAddress || !account || chain !== chainId) return;
    const vault = vaultAddress; const run = ++healthRun.current; setHealthBusy(true);
    (async () => {
      const live = new Map<string, LiveAgent>(); let globalPaused: boolean | null = null; let permissions: HealthPermissions | null = null;
      const provs: any[] = []; try { if (READ_RPC) provs.push(new JsonRpcProvider(READ_RPC, chainId, { staticNetwork: true })); } catch { /* ignore */ } try { provs.push(provider()); } catch { /* no wallet provider */ }
      const read = async <T,>(fn: (c: Contract) => Promise<T>): Promise<T> => { let last: any = new Error('no RPC available'); for (const pv of provs) { try { return await fn(new Contract(vault, VAULT_ABI, pv)); } catch (e) { last = e; } } throw last; };
      const msg = (e: any) => String(e?.shortMessage || e?.message || e).slice(0, 120);
      await Promise.all([
        (async () => { try { globalPaused = await read(c => c.globallyPaused()); } catch { globalPaused = null; } })(),
        ...healthAddrs.map(async a => { try { const x: any = await read(c => c.agents(a)); live.set(a, { ok: true, registered: x.registered, paused: x.paused, maxNativePerTx: x.maxNativePerTx, maxNativePerDay: x.maxNativePerDay, dayStart: x.dayStart, nativeSpentToday: x.nativeSpentToday }); } catch (e) { live.set(a, { ok: false, error: msg(e) }); } }),
      ]);
      if (healthPerms) {
        try {
          const recs = await Promise.all(healthPerms.recipients.map(async a => ({ a, ok: (await read(c => c.allowedRecipients(a))) as boolean })));
          const toks = await Promise.all(healthPerms.tokens.map(async a => { const [ok, tx, day] = await read(async c => Promise.all([c.allowedTokens(a), c.tokenMaxPerTx(a), c.tokenMaxPerDay(a)])); return { address: a, ok: ok as boolean, maxPerTx: BigInt(tx), maxPerDay: BigInt(day) }; }));
          permissions = { recipients: recs.filter(r => r.ok).map(r => r.a), tokens: toks.filter(t => t.ok).map(({ address, maxPerTx, maxPerDay }) => ({ address, maxPerTx, maxPerDay })) };
        } catch { permissions = null; }
      }
      if (healthRun.current !== run) return; // a newer read (or a different vault) superseded this one
      setHealthLive({ live, globalPaused, permissions, checkedAt: Math.floor(Date.now() / 1000) }); setHealthBusy(false);
    })();
  }, [page, vaultAddress, account, chain, healthAddrs, healthPerms, healthNonce, provider]);
  const refreshHealth = () => { loadLogs(); setHealthNonce(n => n + 1); refresh(); };
  useEffect(() => { setAgents([]); setAgentsState('loading'); setAgentsError(''); }, [vaultAddress]);
  useEffect(() => { if (vaultAddress && account) refresh(); }, [vaultAddress, account, refresh]);

  const ensureNetwork = async () => { if (!chainId) throw new Error('Robinhood Chain ID is not configured in this build.'); if (chain !== chainId) { try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + chainId.toString(16) }] }); } catch { throw new Error(`Switch your wallet to the configured Robinhood Chain network (chain ID ${chainId}).`); } } };
  const transact = async (fn: () => Promise<any>, success: string, afterConfirm?: () => Promise<void>) => { setBusy(true); try { await ensureNetwork(); const tx = await fn(); notify('Transaction submitted. Waiting for confirmation…'); await tx.wait(); if (afterConfirm) await afterConfirm(); notify(success); await refresh(); } catch (e: any) { notify(e.shortMessage || e.reason || e.message || 'Transaction failed.'); } finally { setBusy(false); } };

  const createVault = () => transact(async () => { if (!isAddress(factoryAddress)) throw new Error('The configured factory address is invalid.'); const p = provider(); const code = await p.getCode(factoryAddress); if (code === '0x') throw new Error(`AgentGuard factory contract was not found on this network. Switch to the configured Robinhood Chain network (chain ID ${chainId}).`); const c = await signerContract(factoryAddress, FACTORY_ABI); return c.createVault(); }, `Protected vault created on Robinhood Chain ${networkName}.`, async () => { const c = new Contract(factoryAddress, FACTORY_ABI, provider()); const v = await c.vaultOf(account); if (!isAddress(v) || v === ZERO) throw new Error('Vault creation confirmed, but the factory did not return a vault address. Refresh and check the explorer.'); setVaultAddress(v); });
  const addAgent = () => transact(async () => { if (!isAddress(address)) throw new Error('Enter a valid agent wallet address.'); if (parseEther(perTx) <= 0n || parseEther(perDay) < parseEther(perTx)) throw new Error('Daily limit must be greater than or equal to the per-transaction limit, and both must be above zero.'); const existing = await new Contract(vaultAddress, VAULT_ABI, provider()).agents(address); if (existing.registered) { refresh(); throw new Error('This agent wallet is already registered in your vault. No transaction was sent.'); } const c = await signerContract(vaultAddress, VAULT_ABI); return c.registerAgent(address, parseEther(perTx), parseEther(perDay)); }, 'Agent registered on-chain.', async () => { const c = new Contract(vaultAddress, VAULT_ABI, provider()); const a = await c.agents(address); if (!a.registered) throw new Error('Registration transaction confirmed, but the agent mapping did not update. Refresh and check the explorer.'); setAgents(prev => prev.some(x => x.address === address.toLowerCase()) ? prev : [...prev, { address: address.toLowerCase(), registered: a.registered, paused: a.paused, maxNativePerTx: a.maxNativePerTx, maxNativePerDay: a.maxNativePerDay, dayStart: a.dayStart, nativeSpentToday: a.nativeSpentToday }]); });
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
            <h1>{page === 'Overview' ? 'Security overview' : page === 'Activity' ? 'Activity & Security Logs' : page === 'Agent Health' ? 'Agent Health Monitoring' : page === 'Risk Insights' ? 'Agent Risk Insights' : page === 'Agent Profiles' ? 'Agent Security Profiles' : page === 'Security Alerts' ? 'Security Alerts' : page === 'Spending Analytics' ? 'Spending Analytics' : page}</h1>
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
                  <div><dt>Registered agents</dt><dd>{agentsState === 'ok' || agents.length ? agents.length : agentsState === 'loading' ? '…' : '—'}</dd></div>
                  <div><dt>Approved recipients</dt><dd>{recipients.length}</dd></div>
                  <div><dt>Approved tokens</dt><dd>{tokens.length}</dd></div>
                  <div><dt>Recorded transfers</dt><dd>{events.length}</dd></div>
                </dl>
                <section className="panel">
                  <div className="panel-head">
                    <div><h3>Registered agents</h3><p>Only these addresses can call protected transfer functions.</p></div>
                    <button className="btn btn-primary btn-sm" onClick={() => setModal('agent')}><Plus size={15} /> Register agent</button>
                  </div>
                  <AgentTable status={agentsState} error={agentsError} onRetry={refresh} rows={agents.slice(0, 5)} onToggle={toggleAgent} onRevoke={revokeAgent} onEdit={editAgentLimits} busy={busy} />
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
                <AgentTable status={agentsState} error={agentsError} onRetry={refresh} rows={filteredAgents} onToggle={toggleAgent} onRevoke={revokeAgent} onEdit={editAgentLimits} busy={busy} />
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

            {page === 'Activity' && (() => {
              const shown = filterEntries(logs, logFilter, logQuery);
              return (
                <section className="panel">
                  <div className="panel-head">
                    <div><h3>Activity &amp; security logs</h3><p>Every entry is read from your vault contract&apos;s on-chain events, newest first.</p></div>
                    <button className="btn btn-ghost btn-sm" disabled={logsState === 'loading'} onClick={loadLogs}><RefreshCw size={14} className={logsState === 'loading' ? 'spin' : ''} /> Refresh</button>
                  </div>
                  <div className="log-filters" role="group" aria-label="Filter activity">
                    {LOG_FILTERS.map(f => <button key={f.id} className={`btn btn-sm ${logFilter === f.id ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={logFilter === f.id} onClick={() => { setLogFilter(f.id); setLogLimit(100); }}>{f.label}</button>)}
                  </div>
                  <input className="search" aria-label="Search by wallet address or transaction hash" placeholder="Search by wallet address or transaction hash" value={logQuery} onChange={e => { setLogQuery(e.target.value); setLogLimit(100); }} />
                  {logsState === 'error' && <p className="empty">Could not load the vault history ({logsError}). This is a loading problem, not an empty log. <button className="link" onClick={loadLogs}>Retry</button></p>}
                  {logsState === 'loading' && !logs.length && <p className="empty">Loading activity from the vault…</p>}
                  {logsState !== 'loading' || logs.length ? (
                    <div className="events">
                      {shown.slice(0, logLimit).map(e => (
                        <div className={`event ${e.status === 'Success' && e.categories.includes('transaction') ? 'event-good' : ''}`} key={e.key}>
                          <i aria-hidden="true" />
                          <div className="log-body">
                            <b>{e.type} <span className={`pill ${e.status === 'Failed' ? 'pill-stop' : ''}`}>{e.status}</span></b>
                            <small>{e.description}</small>
                            <small className="log-meta">
                              <span>{e.timestamp ? new Date(e.timestamp * 1000).toLocaleString() : 'Time unavailable'} · Block {e.blockNumber}</span>
                              {e.agent && <span>Agent <code title={e.agent}>{short(e.agent)}</code></span>}
                              {e.recipient && <span>Recipient <code title={e.recipient}>{short(e.recipient)}</code></span>}
                              {e.token && <span>Token <code title={e.token}>{short(e.token)}</code></span>}
                              {e.amountText && <span>Amount {e.amountText}</span>}
                              <span>Tx <a href={`${explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer"><code title={e.hash}>{short(e.hash)}</code></a></span>
                            </small>
                          </div>
                          <a title="Open transaction in explorer" aria-label="Open transaction in explorer" href={`${explorerBase}/tx/${e.hash}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
                        </div>
                      ))}
                      {logsState === 'ok' && !shown.length && <p className="empty">{logs.length ? 'No activity matches this filter or search.' : 'No activity has been recorded for this vault yet.'}</p>}
                    </div>
                  ) : null}
                  {shown.length > logLimit && <button className="btn btn-ghost btn-sm" onClick={() => setLogLimit(n => n + 100)}>Show more ({shown.length - logLimit} remaining)</button>}
                  {logsNote && <small className="help">{logsNote}</small>}
                  <small className="help">The vault contract records successful actions and configuration changes as events. Reverted transactions emit no events, so blocked or failed attempts appear only when the block explorer reports them, and their revert reason is not decoded here.</small>
                </section>
              );
            })()}

            {page === 'Agent Health' && (() => {
              const loading = !healthLive || (logsState === 'loading' && !logs.length) || healthAddrs.some(a => !healthLive.live.has(a)); // live reads for newly discovered agents are still in flight
              const health = healthLive ? computeHealth({ entries: logsState === 'ok' ? logs : null, failedState, live: healthLive.live, globalPaused: healthLive.globalPaused, knownAgents: agents.map(a => a.address), now: healthLive.checkedAt }) : null;
              return <AgentHealthView state={chain !== chainId ? 'error' : loading ? 'loading' : 'ok'} error={`your wallet is on chain ${chain}; switch to chain ${chainId}`} agents={health?.agents || []} counts={health?.counts || { Healthy: 0, Inactive: 0, Restricted: 0, Warning: 0, Unknown: 0 }} checkedAt={healthLive?.checkedAt || 0} permissions={healthLive?.permissions ?? null} historyOk={logsState === 'ok'} refreshing={busy || healthBusy || logsState === 'loading'} onRefresh={refreshHealth} explorerBase={explorerBase} short={short} money={money} />;
            })()}

            {page === 'Risk Insights' && (() => {
              // Agent Risk Insights: deterministic scoring from the same Activity-log entries and Health results (see app/lib/agentRisk.ts).
              const loading = !healthLive || (logsState === 'loading' && !logs.length) || healthAddrs.some(a => !healthLive.live.has(a));
              const entries = logsState === 'ok' ? logs : null;
              const health = healthLive ? computeHealth({ entries, failedState, live: healthLive.live, globalPaused: healthLive.globalPaused, knownAgents: agents.map(a => a.address), now: healthLive.checkedAt }) : null;
              const rctx = { now: healthLive?.checkedAt || Math.floor(Date.now() / 1000), failedState, short, native: (n: bigint) => `${formatEther(n)} ${SYMBOL}` };
              const risk = computeRisk(health?.agents || [], entries, rctx);
              return <AgentRiskView state={chain !== chainId ? 'error' : loading ? 'loading' : 'ok'} error={`your wallet is on chain ${chain}; switch to chain ${chainId}`} agents={risk.agents} overview={risk.overview} health={Object.fromEntries((health?.agents || []).map(h => [h.address, h]))} checkedAt={healthLive?.checkedAt || 0} historyOk={logsState === 'ok'} failedState={failedState} refreshing={busy || healthBusy || logsState === 'loading'} onRefresh={refreshHealth} explorerBase={explorerBase} short={short} />;
            })()}

            {page === 'Agent Profiles' && (
              // Agent Security Profiles is isolated: it only READS the data above (agents, logs, live reads) and computes inside its own
              // error boundary, so a failure here can never affect the agent list or any other page.
              <AgentProfilesSection
                loading={!healthLive || (logsState === 'loading' && !logs.length) || healthAddrs.some(a => !healthLive.live.has(a))}
                wrongChain={chain !== chainId} chain={chain}
                live={healthLive} entries={logsState === 'ok' ? logs : null} failedState={failedState} knownAgents={agents.map(a => a.address)}
                vault={vaultAddress} owner={account} chainId={chainId} networkName={networkName}
                refreshing={busy || healthBusy || logsState === 'loading'} onRefresh={refreshHealth}
                explorerBase={explorerBase} short={short} money={money} native={(n: bigint) => `${formatEther(n)} ${SYMBOL}`} onCopy={copy}
              />
            )}

            {page === 'Security Alerts' && (
              // Security Alerts is isolated: it only READS the data above (agents, logs, live reads) and computes inside its own
              // error boundary, so a failure here can never affect the agent list or any other page.
              <SecurityAlertsSection
                loading={!healthLive || (logsState === 'loading' && !logs.length) || healthAddrs.some(a => !healthLive.live.has(a))}
                wrongChain={chain !== chainId} chain={chain} chainId={chainId} vault={vaultAddress}
                live={healthLive} entries={logsState === 'ok' ? logs : null} failedState={failedState} knownAgents={agents.map(a => a.address)}
                refreshing={busy || healthBusy || logsState === 'loading'} onRefresh={refreshHealth}
                explorerBase={explorerBase} short={short} native={(n: bigint) => `${formatEther(n)} ${SYMBOL}`}
              />
            )}

            {page === 'Spending Analytics' && (
              // Spending Analytics is isolated: it only READS the data above (agents, the vault event log, live reads) and computes inside
              // its own error boundary, so a failure here can never affect the agent list or any other page.
              <SpendingAnalyticsSection
                loading={!healthLive || (logsState === 'loading' && !logs.length) || healthAddrs.some(a => !healthLive.live.has(a))}
                wrongChain={chain !== chainId} chain={chain} chainId={chainId}
                live={healthLive} entries={logsState === 'ok' ? logs : null} failedState={failedState} knownAgents={agents.map(a => a.address)}
                refreshing={busy || healthBusy || logsState === 'loading'} onRefresh={refreshHealth}
                explorerBase={explorerBase} short={short} nativeSymbol={SYMBOL}
                readTokenMeta={async (token: string) => {
                  // One decimals()/symbol() read per distinct token. Public RPC first, then the wallet, like the other live reads.
                  const abi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
                  const provs: any[] = []; try { if (READ_RPC) provs.push(new JsonRpcProvider(READ_RPC, chainId, { staticNetwork: true })); } catch { /* ignore */ } try { provs.push(provider()); } catch { /* no wallet */ }
                  let last: any = new Error('No provider available');
                  for (const pv of provs) {
                    try { const c = new Contract(token, abi, pv); const decimals = Number(await c.decimals()); let symbol: string | null = null; try { symbol = String(await c.symbol()).slice(0, 12) || null; } catch { /* symbol is optional */ } return { decimals, symbol }; }
                    catch (e) { last = e; }
                  }
                  throw last;
                }}
              />
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

function AgentTable({ rows, status, error, onRetry, onToggle, onRevoke, onEdit, busy }: { rows: Agent[]; status: AgentsState; error: string; onRetry: () => void; onToggle: (a: Agent) => void; onRevoke: (a: Agent) => void; onEdit: (a: Agent) => void; busy: boolean }) {
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
      {!rows.length && status === 'loading' && <p className="empty">Loading registered agents from the vault…</p>}
      {!rows.length && status === 'error' && <p className="empty">Could not load registered agents ({error}). This is a loading problem, not an empty vault. <button className="link" onClick={onRetry}>Retry</button></p>}
      {!rows.length && status === 'ok' && <p className="empty">No agents registered in this vault yet.</p>}
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
