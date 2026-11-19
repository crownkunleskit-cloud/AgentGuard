import { Contract, Signer, isAddress } from 'ethers';

const ABI = [
  'function executeNative(address payable recipient,uint128 amount)',
  'function executeTokenTransfer(address token,address recipient,uint128 amount)',
];

/**
 * Minimal V1 agent-side client. The signer must belong to the registered agent
 * and must be managed by the agent operator, never by the AgentGuard frontend.
 */
export function createAgentGuardClient(vaultAddress: string, agentSigner: Signer) {
  if (!isAddress(vaultAddress)) throw new Error('Invalid AgentGuard vault address.');
  const contract = new Contract(vaultAddress, ABI, agentSigner);
  return {
    async transferNative(recipient: string, amount: bigint) {
      if (!isAddress(recipient)) throw new Error('Invalid recipient address.');
      if (amount <= 0n) throw new Error('Amount must be greater than zero.');
      const tx = await contract.executeNative(recipient, amount);
      return tx.wait();
    },
    async transferToken(tokenAddress: string, recipient: string, amount: bigint) {
      if (!isAddress(tokenAddress) || !isAddress(recipient)) throw new Error('Invalid token or recipient address.');
      if (amount <= 0n) throw new Error('Amount must be greater than zero.');
      const tx = await contract.executeTokenTransfer(tokenAddress, recipient, amount);
      return tx.wait();
    },
  };
}
