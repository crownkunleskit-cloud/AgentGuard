# AgentGuard V1

AgentGuard is an owner-controlled on-chain permission vault for AI-agent wallets. The owner funds a dedicated vault contract, registers agent addresses, and defines the recipients and assets those agents may transfer. The vault contract enforces the rules when an agent calls it.

## What is implemented

- One `AgentGuardVault` per owner through `AgentGuardFactory`.
- Browser-wallet connection and network verification against the configured testnet chain ID.
- Vault discovery from the factory, vault balance reads, and on-chain event history.
- Agent registration with native-coin per-transaction and UTC-day limits.
- On-chain agent pause, resume, limit editing, and permanent revocation.
- Owner-managed recipient allowlist and ERC-20 token policies.
- Global emergency pause, vault funding, and owner native-coin withdrawal.
- Agent execution methods for native coin and direct ERC-20 `transfer(address,uint256)` only.
- Activity history and explorer links when an explorer base URL is configured.

## Important V1 boundaries

AgentGuard protects only assets deposited into the vault. It does not intercept or secure funds held in an ordinary agent EOA. Agents must call `executeNative` or `executeTokenTransfer` on the vault; the agent developer must integrate that call path into their agent. AgentGuard does not receive agent private keys.

V1 deliberately does not support DEX swaps, arbitrary contract calls, token approvals, delegatecall, or generic calldata. Token limits are in the token's smallest units, not USD value. Token daily limits are shared per vault and token, not per agent: all registered agents draw from the same daily allowance for a given token. This prevents multiple agents from multiplying the vault’s token spending ceiling. Recipient and token allowlists are global to the vault. The owner can change policies, pause/revoke agents, and withdraw assets.

This is an unaudited early-stage implementation. Do not use mainnet funds until the contracts have been independently reviewed and the full test suite has passed.

## Requirements

- Node.js 20 or newer
- npm
- A browser wallet that supports the configured Robinhood Chain testnet
- Testnet native coin for contract deployment and transactions

## Install and run locally

```bash
npm install
cp .env.example .env
```

Robinhood Chain testnet and mainnet RPC URLs and chain IDs are included in `.env.example` based on the network details supplied for this project. Verify them against the current official Robinhood Chain documentation before deployment. Use a dedicated testnet-only `DEPLOYER_PRIVATE_KEY`; keep `MAINNET_DEPLOYER_PRIVATE_KEY` separate and never commit `.env`.

Compile and test:

```bash
npm run contracts:compile
npm run contracts:test
```

Deploy the factory:

```bash
npm run contracts:deploy:testnet
```

The script writes a local deployment record under `deployments/`. The deployed V1 factory is preconfigured in the frontend: `0x5ce9DaDE59Ae1Dd6BAF9E2f83c2B703ad8b564E4` on chain ID `46630`. These are public values and can also be overridden with `NEXT_PUBLIC_AGENTGUARD_FACTORY`, `NEXT_PUBLIC_RH_CHAIN_ID`, and `NEXT_PUBLIC_RH_EXPLORER_URL`. The deployer private key is not used by the frontend. Restart the Next.js process after changing environment values.

Run the app:

```bash
npm run dev
```

The owner connects their wallet, creates one vault from the dashboard, funds it, registers agent wallet addresses, and sets recipient/token permissions. Each of these management actions is an on-chain transaction. An agent can only move assets held in the vault and only through the restricted execution functions.

## Agent integration

The registered agent wallet calls the vault directly. The V1 ABI methods are:

```solidity
executeNative(address payable recipient, uint128 amount)
executeTokenTransfer(address token, address recipient, uint128 amount)
```

A minimal ethers-based helper is included at `sdk/agentguard.ts` (`createAgentGuardClient`). The agent must hold the registered agent private key in its own secure runtime. Never paste agent or owner private keys into AgentGuard or the frontend. Before enabling a live agent, test rejected recipients, per-transaction limits, daily limits, paused/revoked agents, global pause, and insufficient vault balances on testnet.

## Verification status for this handoff

The frontend uses browser-wallet and contract interactions with the deployed testnet factory address preconfigured. The expanded contract suite includes regression coverage for shared vault-wide ERC-20 daily limits across multiple agents. Run `npm run contracts:compile`, `npm run contracts:test`, and `npm run build` against the exact release source before any deployment decision. This is an unaudited testnet V1, not a mainnet-ready security product. Run the commands above on a machine with npm registry access before testnet deployment.

## Mainnet deployment configuration

The Hardhat configuration includes Robinhood Chain Mainnet (chain ID `4663`) and the command `npm run contracts:deploy:mainnet`. The deploy script checks the configured chain ID, requires a funded deployer, waits for a successful deployment receipt, verifies bytecode at the deployed address, and writes the transaction hash and block number to the local deployment record.

Mainnet deployment is deliberately blocked unless BOTH of these are set in the local `.env`:

```env
ENABLE_MAINNET_DEPLOYMENT=true
MAINNET_DEPLOYMENT_CONFIRMATION=DEPLOY_AGENTGUARD_TO_ROBINHOOD_MAINNET
```

Do not set these until the exact contracts have passed independent security review and the deployment has been explicitly approved. Never put private keys in Vercel environment variables; the deployer key is only for the local Hardhat deployment process.

### Vercel frontend configuration (after mainnet factory deployment)

Set these public values in Vercel Project Settings → Environment Variables, then redeploy:

```env
NEXT_PUBLIC_RH_CHAIN_ID=4663
NEXT_PUBLIC_RH_NETWORK_NAME=MAINNET
NEXT_PUBLIC_AGENTGUARD_FACTORY=0xYOUR_VERIFIED_MAINNET_FACTORY
NEXT_PUBLIC_RH_EXPLORER_URL=https://robinhoodchain.blockscout.com
```

Do not switch the frontend to mainnet before the factory is deployed and verified. Until then, keep the existing testnet defaults. The current source has not been independently audited, and these deployment safeguards do not constitute an audit or guarantee of security.

## Activity & Security Logs

The dashboard's **Activity** page (titled "Activity & Security Logs") lists everything the connected vault has emitted, newest first, with filters (All, Transactions, Agent activity, Security events) and search by wallet address or transaction hash. Nothing is stored in the browser: each load reads the vault's full event history from chain (from the block the vault was created in, located through the factory's `VaultCreated` event), using the public RPC, then the wallet RPC, then the block-explorer API, with automatic block-range narrowing when a node limits `eth_getLogs`. Entries are de-duplicated by transaction hash and log index.

Supported by the deployed V1 contracts (real events): agent registered / revoked / paused / resumed / limits changed; native and ERC-20 transfers executed; recipient added / removed; token permission added / removed; emergency pause on / off; owner withdrawals.

Not emitted by the V1 contracts, so NOT tracked as events: transaction requests (V1 has no request flow), ownership changes (the owner is immutable), and rejected calls. Reverted transactions emit no events; the page additionally asks the block explorer's transaction list for reverted transactions sent to the vault and shows them as "Failed" / "Blocked agent transfer" when the explorer returns them. Their revert reason is not decoded, and if the explorer is unreachable the page says so instead of implying there were none.

No contract, deployment or environment-variable changes are needed.

## Agent Risk Insights

The **Risk Insights** page scores every agent from 0 to 100 (higher = riskier) using only the vault's real on-chain history. It reuses the Activity & Security Logs entries and the Agent Health results, and runs when the page is opened or refreshed (it is not continuous monitoring). It is analysis only: nothing is ever revoked, paused, limited or moved automatically. The scoring code is `app/lib/agentRisk.ts` (pure, deterministic, no AI, no network calls); the tables below are rendered from the same `INDICATORS` list the UI shows under "How scores are calculated".

**Levels:** Low 0-29, Medium 30-59, High 60-79, Critical 80-100, or "Insufficient data" (score shown as unavailable).

**Combination:** `score = min(100, confirmed points + min(40, behavioural points))`. Behavioural indicators alone can never exceed Medium, and no single indicator exceeds 45 points. **Recency:** only the last 30 days are scored; a finding whose newest evidence is within 7 days counts 100%, older evidence in the window counts 60%; older or undated evidence is listed as "not scored". **Missing data** never adds risk: it lowers *confidence* (High / Medium / Low) and the affected check is listed under "Checks not performed". **Inactivity** never adds risk.

| Indicator | Type / severity | Points (by evidence count) |
|---|---|---|
| Reverted transfer to a recipient not approved at that block | Confirmed / High | 1: 10, 2: 20, 3+: 35, 5+: 45 |
| Calls after the agent was revoked | Confirmed / High | 1: 20, 2+: 30, 4+: 40 |
| Reverted calls to owner-only functions | Confirmed / High | 1: 25, 2: 35, 3+: 45 |
| Reverted transfer above the per-transaction limit in force | Confirmed / Medium | 1: 8, 2+: 15, 4+: 25 |
| Reverted transfer of a token not approved at that block | Confirmed / Medium | 1: 10, 2: 20, 3+: 30 |
| Repeated unexplained reverts (7 days) | Behavioural / Low | 3+: 5, 5+: 10 |
| Calls while paused (7 days) | Behavioural / Low | 3+: 5, 5+: 10 |
| Frequency spike: 24h transfers >= 5 and >= 3x own 14-day daily average (needs 7+ days, 5+ transfers of history) | Behavioural / Medium | 3x: 15, 6x: 25, 10x: 30 |
| Unusual amount: > 5x the median of 8+ earlier transfers of the same asset (7 days) | Behavioural / Medium | 1: 10, 2+: 20 |
| 3+ first-time recipients (7 days, after 8+ transfers) | Behavioural / Low | 3+: 8, 5+: 15 |
| Another finding's evidence within 24h after a recipient/token approval, limit change or resume | Behavioural / Low | +10 (only with another finding) |

Each reverted agent call is assigned to exactly one cause, following the vault contract's own check order (not registered -> paused -> token/recipient not approved -> over limit), using the permission and limit state replayed from events at that block; if a relevant event shares the block the cause is not guessed. Nothing is double counted.

**Data sources:** (1) the vault's events (full history from the vault's creation block); (2) reverted transactions sent to the vault, from the block explorer's transaction list, decoded with the vault ABI to recover the function, recipient, token and amount the agent tried to use; (3) live `agents(address)` / `globallyPaused()` reads via Agent Health.

**Limitations:** reverted transactions emit no events, so blocked-attempt detections need the explorer API; if it is unreachable those checks are listed as not performed and confidence drops. The revert reason is inferred from on-chain state, not read from the node. Findings are indicators from observable data, not proof of malice. Agents are scored against their own history, so a brand-new agent has no frequency or amount baseline. The V1 contracts record no agent names, no off-chain intent and no attempts that never reached the chain.

No contract, deployment or environment-variable changes are needed.
