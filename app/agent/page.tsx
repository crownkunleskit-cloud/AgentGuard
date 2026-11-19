'use client';

import { useState } from 'react';
import { BrowserProvider, Contract, formatEther, parseEther, isAddress } from 'ethers';

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_RH_CHAIN_ID || process.env.NEXT_PUBLIC_RH_TESTNET_CHAIN_ID || '46630');
const NETWORK_NAME = process.env.NEXT_PUBLIC_RH_NETWORK_NAME || (CHAIN_ID === 4663 ? 'MAINNET' : 'TESTNET');
const EXPLORER = process.env.NEXT_PUBLIC_RH_EXPLORER_URL || (CHAIN_ID === 4663 ? 'https://robinhoodchain.blockscout.com' : 'https://explorer.testnet.chain.robinhood.com');
const VAULT_ABI = [
  'function owner() view returns(address)',
  'function globallyPaused() view returns(bool)',
  'function agents(address) view returns(bool registered,bool paused,uint128 maxNativePerTx,uint128 maxNativePerDay,uint64 dayStart,uint128 nativeSpentToday)',
  'function allowedRecipients(address) view returns(bool)',
  'function executeNative(address payable recipient,uint128 amount)',
];

declare global { interface Window { ethereum?: any } }

export default function AgentExecutionPage() {
  const [agent, setAgent] = useState('');
  const [vault, setVault] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('0.001');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Switch Rabby to your registered agent account, then connect it here.');
  const [txHash, setTxHash] = useState('');

  async function connectAgent() {
    try {
      if (!window.ethereum) throw new Error('No injected wallet found. Open this page in the same browser as Rabby.');
      const p = new BrowserProvider(window.ethereum);
      await p.send('eth_requestAccounts', []);
      const network = await p.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`Switch your wallet to Robinhood Chain ${NETWORK_NAME} (chain ID ${CHAIN_ID}).`);
      const s = await p.getSigner();
      const a = await s.getAddress();
      setAgent(a);
      setMessage(`Connected registered agent: ${a}`);
    } catch (e: any) { setMessage(e.shortMessage || e.reason || e.message || 'Wallet connection failed.'); }
  }

  async function execute() {
    setBusy(true); setTxHash('');
    try {
      if (!window.ethereum) throw new Error('Rabby wallet was not detected.');
      if (!isAddress(vault)) throw new Error('Enter the full protected vault address.');
      if (!isAddress(recipient)) throw new Error('Enter a valid recipient address.');
      const value = parseEther(amount);
      if (value <= 0n) throw new Error('Transfer amount must be greater than zero.');
      const p = new BrowserProvider(window.ethereum);
      const network = await p.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`Wrong network. Switch to Robinhood Chain ${NETWORK_NAME} (chain ID ${CHAIN_ID}).`);
      const s = await p.getSigner();
      const signerAddress = await s.getAddress();
      const c = new Contract(vault, VAULT_ABI, s);
      const code = await p.getCode(vault);
      if (code === '0x') throw new Error('No vault contract exists at that address on this network. Check the full vault address.');
      const [policy, globallyPaused, recipientAllowed, balance] = await Promise.all([
        c.agents(signerAddress), c.globallyPaused(), c.allowedRecipients(recipient), p.getBalance(vault)
      ]);
      if (!policy.registered) throw new Error('This wallet is not registered as an agent in the selected vault.');
      if (policy.paused || globallyPaused) throw new Error('AgentGuard protection is paused. Ask the vault owner to resume it.');
      if (!recipientAllowed) throw new Error('Recipient is not approved by the vault owner.');
      if (value > policy.maxNativePerTx) throw new Error(`Amount exceeds the per-transaction limit of ${formatEther(policy.maxNativePerTx)} ETH.`);
      const today = BigInt(Math.floor(Date.now() / 86400000));
      const chainDay = BigInt(Math.floor(Date.now() / 86400000));
      const spent = policy.dayStart === chainDay ? policy.nativeSpentToday : 0n;
      if (spent + value > policy.maxNativePerDay) throw new Error(`Amount exceeds the remaining daily limit. Daily cap: ${formatEther(policy.maxNativePerDay)} ETH.`);
      if (value > balance) throw new Error(`Vault balance is insufficient. Current balance: ${formatEther(balance)} ETH.`);
      // A read-only simulation gives a clearer error before Rabby opens the signing prompt.
      await c.executeNative.staticCall(recipient, value);
      const tx = await c.executeNative(recipient, value);
      setTxHash(tx.hash);
      setMessage('Transaction submitted. Waiting for network confirmation…');
      await tx.wait();
      setMessage('SUCCESS: AgentGuard executed the permitted native transfer.');
    } catch (e: any) {
      setMessage(e.shortMessage || e.reason || e.info?.error?.message || e.message || 'Transfer failed.');
    } finally { setBusy(false); }
  }

  return <main style={{minHeight:'100vh',background:'#070b09',color:'#f3f7f4',padding:'40px 20px',fontFamily:'Arial,sans-serif'}}>
    <section style={{maxWidth:720,margin:'0 auto',background:'#101914',border:'1px solid #293a2e',borderRadius:18,padding:28}}>
      <div style={{color:'#9bea61',fontSize:12,letterSpacing:2,fontWeight:700}}>AGENTGUARD V1 · {NETWORK_NAME} TOOL</div>
      <h1 style={{fontSize:30,margin:'12px 0'}}>Agent transaction execution</h1>
      <p style={{color:'#aab8ae',lineHeight:1.6}}>This page is for the registered agent wallet only. The vault contract enforces the recipient allowlist, pause state and spending limits. It does not expose or request private keys.</p>
      <div style={{background:'#0a100c',border:'1px solid #304434',padding:14,borderRadius:10,margin:'20px 0'}}>
        <div style={{fontSize:11,color:'#9bea61',marginBottom:6}}>CONNECTED AGENT WALLET</div>
        <code style={{fontSize:13,wordBreak:'break-all'}}>{agent || 'Connect the registered agent wallet'}</code>
        <button onClick={connectAgent} style={buttonStyle} disabled={busy}>Connect agent wallet</button>
        {agent && <p style={{color:'#9bea61',fontSize:13,marginBottom:0}}>Connected: {agent}</p>}
      </div>
      <label style={labelStyle}>Full protected vault address<input style={inputStyle} value={vault} onChange={e=>setVault(e.target.value)} placeholder="0x…" /></label>
      <label style={labelStyle}>Approved recipient address<input style={inputStyle} value={recipient} onChange={e=>setRecipient(e.target.value)} placeholder="Enter an owner-approved recipient 0x…" /></label>
      <label style={labelStyle}>Transfer amount (ETH)<input style={inputStyle} type="number" min="0" step="0.0001" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
      <button onClick={execute} disabled={busy || !agent} style={{...buttonStyle,width:'100%',opacity:(busy || !agent) ? 0.5 : 1}}>{busy?'Processing…':'Execute protected transfer'}</button>
      <div style={{marginTop:18,padding:14,borderRadius:10,background:'#0a100c',border:'1px solid #304434',color:'#c8d5cc',fontSize:13,lineHeight:1.6,overflowWrap:'anywhere'}}>{message}{txHash && <p><a style={{color:'#9bea61'}} href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction on explorer</a></p>}</div>
      <p style={{fontSize:11,color:'#819087',marginTop:18}}>Use only the network configured for this build. The agent wallet needs native coin for gas. The vault must hold enough ETH for the transfer. Never paste a private key or recovery phrase here.</p>
    </section>
  </main>;
}

const labelStyle: React.CSSProperties = {display:'block',fontSize:13,color:'#c9d5cc',marginTop:16};
const inputStyle: React.CSSProperties = {display:'block',width:'100%',boxSizing:'border-box',marginTop:7,padding:'13px 14px',borderRadius:8,border:'1px solid #34463a',background:'#080e0a',color:'#f3f7f4',outline:'none'};
const buttonStyle: React.CSSProperties = {display:'block',marginTop:14,padding:'12px 18px',border:0,borderRadius:8,background:'#9bea61',color:'#071007',fontWeight:700,cursor:'pointer'};
