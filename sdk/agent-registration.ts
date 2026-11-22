import type { Contract } from 'ethers';

export async function preflightAgentRegistration(
  contract: Contract,
  ownerAddress: string,
  agentAddress: string,
  maxPerTransaction: bigint,
  maxPerDay: bigint,
): Promise<'already-registered' | 'ready'> {
  const [liveOwner, current] = await Promise.all([contract.owner(), contract.agents(agentAddress)]);
  if (String(liveOwner).toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error('The connected wallet is not the live owner of this vault. Reconnect the owner wallet.');
  }
  if (current.registered) return 'already-registered';
  await contract.registerAgent.staticCall(agentAddress, maxPerTransaction, maxPerDay);
  return 'ready';
}
