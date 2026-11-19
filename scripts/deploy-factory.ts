import { ethers, network } from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_CHAIN_IDS: Record<string, number> = {
  robinhoodTestnet: 46630,
  robinhoodMainnet: 4663,
};

async function main() {
  const actualChainId = Number((await ethers.provider.getNetwork()).chainId);
  const expectedChainId = EXPECTED_CHAIN_IDS[network.name];

  if (expectedChainId && actualChainId !== expectedChainId) {
    throw new Error(`Wrong network chain ID for ${network.name}: expected ${expectedChainId}, received ${actualChainId}`);
  }
  if (network.name === 'robinhoodMainnet') {
    if (process.env.ENABLE_MAINNET_DEPLOYMENT !== 'true') {
      throw new Error('Mainnet deployment blocked. Set ENABLE_MAINNET_DEPLOYMENT=true only after independent security review and explicit approval.');
    }
    if (process.env.MAINNET_DEPLOYMENT_CONFIRMATION !== 'DEPLOY_AGENTGUARD_TO_ROBINHOOD_MAINNET') {
      throw new Error('Mainnet deployment requires MAINNET_DEPLOYMENT_CONFIRMATION=DEPLOY_AGENTGUARD_TO_ROBINHOOD_MAINNET.');
    }
  }
  if (!expectedChainId && network.name !== 'hardhat' && network.name !== 'localhost') {
    throw new Error(`Deployment blocked on unexpected network: ${network.name}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployer account configured.');
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) throw new Error('Deployer wallet has no native balance for gas.');

  const Factory = await ethers.getContractFactory('AgentGuardFactory');
  const factory = await Factory.deploy();
  const deploymentTx = factory.deploymentTransaction();
  if (!deploymentTx) throw new Error('Could not obtain factory deployment transaction.');
  const receipt = await deploymentTx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Factory deployment transaction failed.');
  await factory.waitForDeployment();
  const address = await factory.getAddress();
  const deployedCode = await ethers.provider.getCode(address);
  if (deployedCode === '0x') throw new Error('Deployment receipt succeeded but no factory bytecode exists at the deployed address.');
  const record = {
    network: network.name,
    chainId: actualChainId,
    factoryAddress: address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    contract: 'AgentGuardFactory',
    solidity: '0.8.24',
  };
  const out = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${network.name}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log('AgentGuardFactory deployed:', address);
  console.log('Chain ID:', actualChainId);
  console.log('Transaction:', receipt.hash);
  console.log('Block:', receipt.blockNumber);
  console.log('Deployment record:', `deployments/${network.name}.json`);
  console.log('Set NEXT_PUBLIC_AGENTGUARD_FACTORY, NEXT_PUBLIC_RH_TESTNET_CHAIN_ID (or the selected chain ID), and NEXT_PUBLIC_RH_EXPLORER_URL for the frontend.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
