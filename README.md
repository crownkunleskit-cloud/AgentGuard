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
