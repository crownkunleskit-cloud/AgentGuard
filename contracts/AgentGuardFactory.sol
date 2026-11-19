// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentGuardVault.sol";

contract AgentGuardFactory {
    mapping(address => address) public vaultOf;
    event VaultCreated(address indexed owner, address indexed vault);

    error VaultAlreadyExists();

    function createVault() external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultAlreadyExists();
        vault = address(new AgentGuardVault(msg.sender));
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }
}
