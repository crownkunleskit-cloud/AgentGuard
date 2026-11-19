import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const testnetKey = process.env.DEPLOYER_PRIVATE_KEY;
const mainnetKey = process.env.MAINNET_DEPLOYER_PRIVATE_KEY;

const networks: any = {};
if (testnetKey) {
  networks.robinhoodTestnet = {
    url: process.env.RH_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com',
    chainId: 46630,
    accounts: [testnetKey],
  };
}
if (mainnetKey) {
  networks.robinhoodMainnet = {
    url: process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    chainId: 4663,
    accounts: [mainnetKey],
  };
}

const config: HardhatUserConfig = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 300 } } },
  paths: { sources: './contracts', tests: './test', cache: './cache', artifacts: './artifacts' },
  networks,
};
export default config;
