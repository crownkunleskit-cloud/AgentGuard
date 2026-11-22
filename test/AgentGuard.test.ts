import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { Contract, Provider } from 'ethers';
import { preflightAgentRegistration } from '../sdk/agent-registration';
import { findVaultCreationBlock, loadAgentHistory, withTimeout } from '../sdk/discovery';

describe('AgentGuard V1', function () {
  async function fixture() {
    const [owner, agent, recipient, stranger] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory('AgentGuardVault');
    const vault = await Vault.deploy(owner.address);
    await vault.waitForDeployment();
    return { owner, agent, recipient, stranger, vault };
  }


  it('creates exactly one vault per owner through the factory', async function () {
    const Factory = await ethers.getContractFactory('AgentGuardFactory');
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    const [owner] = await ethers.getSigners();
    await expect(factory.createVault()).to.emit(factory, 'VaultCreated');
    expect(await factory.vaultOf(owner.address)).not.to.equal(ethers.ZeroAddress);
    await expect(factory.createVault()).to.be.revertedWithCustomError(factory, 'VaultAlreadyExists');
  });

  it('discovers active agents from each vault with adaptive RPC paging and preflights duplicates', async function () {
    const [owner, agent, revokedAgent, otherOwner, otherAgent] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('AgentGuardFactory');
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    const creationReceipt = await (await factory.createVault()).wait();
    const vaultAddress = await factory.vaultOf(owner.address);
    const vault = await ethers.getContractAt('AgentGuardVault', vaultAddress);
    await vault.registerAgent(agent.address, 100n, 1000n);
    await vault.registerAgent(revokedAgent.address, 100n, 1000n);
    await vault.revokeAgent(revokedAgent.address);

    const historicalAddresses: string[] = [];
    for (let index = 0; index < 20; index++) {
      const historicalAddress = ethers.getAddress(`0x${(index + 1000).toString(16).padStart(40, '0')}`);
      historicalAddresses.push(historicalAddress);
      await vault.registerAgent(historicalAddress, 100n, 1000n);
      if (index % 2 === 0) await vault.revokeAgent(historicalAddress);
    }

    await factory.connect(otherOwner).createVault();
    const otherVault = await ethers.getContractAt('AgentGuardVault', await factory.vaultOf(otherOwner.address));
    await otherVault.connect(otherOwner).registerAgent(otherAgent.address, 100n, 1000n);

    let rangeFailures = 0;
    const limitedProvider = {
      getLogs: async (filter: any) => {
        if (Number(filter.toBlock) - Number(filter.fromBlock) > 4) {
          rangeFailures++;
          throw new Error('block range limit');
        }
        return ethers.provider.getLogs(filter);
      },
    } as unknown as Provider;
    const latestBlock = await ethers.provider.getBlockNumber();
    const creationBlock = await findVaultCreationBlock(limitedProvider, await factory.getAddress(), owner.address, vaultAddress, latestBlock);
    expect(creationBlock).to.equal(creationReceipt?.blockNumber);

    const { rows } = await loadAgentHistory(limitedProvider, vaultAddress, creationBlock, latestBlock);
    const active = new Set<string>();
    for (const { name, parsed } of rows) {
      const address = String(parsed.args.agent).toLowerCase();
      if (name === 'AgentRegistered') active.add(address);
      if (name === 'AgentRevoked') active.delete(address);
    }
    const expectedActive = [agent.address, ...historicalAddresses.filter((_, index) => index % 2 === 1)].map((address) => address.toLowerCase()).sort();
    expect([...active].sort()).to.deep.equal(expectedActive);
    expect(rows.length).to.be.greaterThan(30);
    expect((await vault.agents(agent.address)).registered).to.equal(true);
    expect((await vault.agents(revokedAgent.address)).registered).to.equal(false);
    expect((await otherVault.agents(otherAgent.address)).registered).to.equal(true);
    expect(await preflightAgentRegistration(vault as unknown as Contract, owner.address, agent.address, 100n, 1000n)).to.equal('already-registered');
    expect(await preflightAgentRegistration(vault as unknown as Contract, owner.address, revokedAgent.address, 100n, 1000n)).to.equal('ready');
    expect(rangeFailures).to.be.greaterThan(0);
  });

  it('bounds a stalled RPC request with a timeout', async function () {
    const stalledRequest = new Promise<never>(() => {});
    await expect(withTimeout(stalledRequest, 5)).to.be.rejectedWith('RPC log request timed out');
  });

  it('registers an agent and permits an approved native transfer within limits', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther('2') });
    await vault.registerAgent(agent.address, ethers.parseEther('0.5'), ethers.parseEther('1'));
    await vault.setRecipient(recipient.address, true);
    await expect(vault.connect(agent).executeNative(recipient.address, ethers.parseEther('0.2')))
      .to.emit(vault, 'NativeTransferExecuted');
    expect(await ethers.provider.getBalance(recipient.address)).to.be.greaterThan(0n);
  });

  it('blocks unapproved recipients and daily-limit overruns', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther('2') });
    await vault.registerAgent(agent.address, ethers.parseEther('0.6'), ethers.parseEther('1'));
    await expect(vault.connect(agent).executeNative(recipient.address, ethers.parseEther('0.1'))).to.be.revertedWithCustomError(vault, 'RecipientNotAllowed');
    await vault.setRecipient(recipient.address, true);
    await vault.connect(agent).executeNative(recipient.address, ethers.parseEther('0.6'));
    await expect(vault.connect(agent).executeNative(recipient.address, ethers.parseEther('0.5'))).to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
  });

  it('blocks paused and revoked agents', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther('1') });
    await vault.registerAgent(agent.address, 100n, 1000n);
    await vault.setRecipient(recipient.address, true);
    await vault.setAgentPaused(agent.address, true);
    await expect(vault.connect(agent).executeNative(recipient.address, 10n)).to.be.revertedWithCustomError(vault, 'AgentIsPaused');
    await vault.revokeAgent(agent.address);
    await expect(vault.connect(agent).executeNative(recipient.address, 10n)).to.be.revertedWithCustomError(vault, 'NotAgent');
  });

  it('allows only approved direct ERC20 transfers within token limits', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy();
    await token.waitForDeployment();
    await token.mint(await vault.getAddress(), 1000n);
    await vault.registerAgent(agent.address, 100n, 1000n);
    await vault.setRecipient(recipient.address, true);
    await vault.setTokenPolicy(await token.getAddress(), true, 300n, 500n);
    await vault.connect(agent).executeTokenTransfer(await token.getAddress(), recipient.address, 300n);
    expect(await token.balanceOf(recipient.address)).to.equal(300n);
    await expect(vault.connect(agent).executeTokenTransfer(await token.getAddress(), recipient.address, 250n)).to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
  });

  it('allows owner emergency pause to stop all agents', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await vault.registerAgent(agent.address, 100n, 1000n);
    await vault.setRecipient(recipient.address, true);
    await vault.setGlobalPause(true);
    await expect(vault.connect(agent).executeNative(recipient.address, 10n)).to.be.revertedWithCustomError(vault, 'AgentIsPaused');
  });

  it('restricts administrative functions to the vault owner', async function () {
    const { agent, recipient, vault } = await fixture();
    await expect(vault.connect(agent).registerAgent(recipient.address, 10n, 100n))
      .to.be.revertedWithCustomError(vault, 'NotOwner');
    await expect(vault.connect(agent).setRecipient(recipient.address, true))
      .to.be.revertedWithCustomError(vault, 'NotOwner');
    await expect(vault.connect(agent).setGlobalPause(true))
      .to.be.revertedWithCustomError(vault, 'NotOwner');
  });

  it('rejects zero addresses, duplicate agents, and invalid spending limits', async function () {
    const { owner, agent, vault } = await fixture();
    await expect(vault.registerAgent(ethers.ZeroAddress, 1n, 1n))
      .to.be.revertedWithCustomError(vault, 'ZeroAddress');
    await expect(vault.registerAgent(agent.address, 0n, 1n))
      .to.be.revertedWithCustomError(vault, 'InvalidLimit');
    await expect(vault.registerAgent(agent.address, 2n, 1n))
      .to.be.revertedWithCustomError(vault, 'InvalidLimit');
    await vault.registerAgent(agent.address, 1n, 2n);
    await expect(vault.registerAgent(agent.address, 1n, 2n))
      .to.be.revertedWithCustomError(vault, 'AgentAlreadyRegistered');
    await expect(vault.connect(agent).setAgentLimits(agent.address, 1n, 2n))
      .to.be.revertedWithCustomError(vault, 'NotOwner');
  });

  it('enforces the per-transaction cap and rejects zero-value transfers', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther('1') });
    await vault.registerAgent(agent.address, 100n, 500n);
    await vault.setRecipient(recipient.address, true);
    await expect(vault.connect(agent).executeNative(recipient.address, 0n))
      .to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
    await expect(vault.connect(agent).executeNative(recipient.address, 101n))
      .to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
  });

  it('blocks transfers after a recipient is removed and supports owner pause recovery', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    await owner.sendTransaction({ to: await vault.getAddress(), value: 1000n });
    await vault.registerAgent(agent.address, 100n, 500n);
    await vault.setRecipient(recipient.address, true);
    await vault.setRecipient(recipient.address, false);
    await expect(vault.connect(agent).executeNative(recipient.address, 10n))
      .to.be.revertedWithCustomError(vault, 'RecipientNotAllowed');
    await vault.setRecipient(recipient.address, true);
    await vault.setGlobalPause(true);
    await expect(vault.connect(agent).executeNative(recipient.address, 10n))
      .to.be.revertedWithCustomError(vault, 'AgentIsPaused');
    await vault.setGlobalPause(false);
    await vault.connect(agent).executeNative(recipient.address, 10n);
  });


  it('shares each token daily spending cap across all registered agents in the vault', async function () {
    const [owner, agentA, recipient, stranger, agentB] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory('AgentGuardVault');
    const vault = await Vault.deploy(owner.address);
    await vault.waitForDeployment();

    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy();
    await token.waitForDeployment();
    await token.mint(await vault.getAddress(), 2000n);

    await vault.registerAgent(agentA.address, 100n, 1000n);
    await vault.registerAgent(agentB.address, 100n, 1000n);
    await vault.setRecipient(recipient.address, true);
    await vault.setTokenPolicy(await token.getAddress(), true, 300n, 500n);

    await vault.connect(agentA).executeTokenTransfer(await token.getAddress(), recipient.address, 300n);
    await expect(vault.connect(agentB).executeTokenTransfer(await token.getAddress(), recipient.address, 201n))
      .to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
    await vault.connect(agentB).executeTokenTransfer(await token.getAddress(), recipient.address, 200n);

    expect(await token.balanceOf(recipient.address)).to.equal(500n);
    expect(await vault.tokenSpentToday(await token.getAddress())).to.equal(500n);
  });

  it('enforces ERC20 token policy and rejects unapproved token transfers', async function () {
    const { owner, agent, recipient, vault } = await fixture();
    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy();
    await token.waitForDeployment();
    await token.mint(await vault.getAddress(), 1000n);
    await vault.registerAgent(agent.address, 100n, 500n);
    await vault.setRecipient(recipient.address, true);
    await expect(vault.connect(agent).executeTokenTransfer(await token.getAddress(), recipient.address, 1n))
      .to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
    await vault.setTokenPolicy(await token.getAddress(), true, 100n, 150n);
    await vault.connect(agent).executeTokenTransfer(await token.getAddress(), recipient.address, 100n);
    await expect(vault.connect(agent).executeTokenTransfer(await token.getAddress(), recipient.address, 51n))
      .to.be.revertedWithCustomError(vault, 'SpendLimitExceeded');
  });

});
