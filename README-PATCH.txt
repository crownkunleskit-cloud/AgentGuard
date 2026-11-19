AgentGuard ERC-20 daily cap clarification patch

Replace these files in your existing local AgentGuard project:
- contracts/AgentGuardVault.sol
- test/AgentGuard.test.ts
- README.md

No deployed contract is changed by replacing source files. The new test verifies that two registered agents share one daily token allowance per vault/token. Existing vault deployments are immutable and are not upgraded by this source patch.

After replacing the files, run:
  npm run contracts:compile
  npm run contracts:test
  npm run build

Expected contract test count: 12 (assuming the previous 11-test suite is unchanged).
Do not enable mainnet deployment. Independent security review is still required.
