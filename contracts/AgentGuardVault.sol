// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentGuardVault
/// @notice Owner-funded smart account with narrowly-scoped agent permissions.
/// @dev V1 deliberately supports native transfers and direct ERC20 transfers only.
///      It does not permit arbitrary router calls or token approvals.
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract AgentGuardVault {
    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error AgentAlreadyRegistered();
    error AgentNotRegistered();
    error AgentIsPaused();
    error InvalidLimit();
    error RecipientNotAllowed();
    error TokenNotAllowed();
    error InvalidToken();
    error SpendLimitExceeded();
    error UnsupportedCall();
    error TransferFailed();

    address public immutable owner;
    bool public globallyPaused;

    struct AgentPolicy {
        bool registered;
        bool paused;
        uint128 maxNativePerTx;
        uint128 maxNativePerDay;
        uint64 dayStart;
        uint128 nativeSpentToday;
    }

    mapping(address => AgentPolicy) public agents;
    mapping(address => bool) public allowedRecipients;
    mapping(address => bool) public allowedTokens;
    mapping(address => uint128) public tokenMaxPerTx;
    mapping(address => uint128) public tokenMaxPerDay;
    // ERC20 daily accounting is intentionally vault-wide per token, shared by every agent.
    mapping(address => uint64) public tokenDayStart;
    mapping(address => uint128) public tokenSpentToday;
    mapping(address => mapping(address => bool)) public agentRecipientOverride;
    mapping(address => mapping(address => bool)) public agentTokenOverride;

    event AgentRegistered(address indexed agent, uint256 maxNativePerTx, uint256 maxNativePerDay);
    event AgentStatusChanged(address indexed agent, bool paused);
    event AgentLimitsChanged(address indexed agent, uint256 maxNativePerTx, uint256 maxNativePerDay);
    event AgentRevoked(address indexed agent);
    event RecipientPermissionChanged(address indexed recipient, bool allowed);
    event TokenPolicyChanged(address indexed token, bool allowed, uint256 maxPerTx, uint256 maxPerDay);
    event GlobalPauseChanged(bool paused);
    event NativeTransferExecuted(address indexed agent, address indexed recipient, uint256 amount);
    event TokenTransferExecuted(address indexed agent, address indexed token, address indexed recipient, uint256 amount);
    event OwnerWithdrawal(address indexed asset, address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyActiveAgent() {
        AgentPolicy storage policy = agents[msg.sender];
        if (!policy.registered) revert NotAgent();
        if (globallyPaused || policy.paused) revert AgentIsPaused();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    receive() external payable {}

    function registerAgent(address agent, uint128 maxNativePerTx, uint128 maxNativePerDay) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (agents[agent].registered) revert AgentAlreadyRegistered();
        if (maxNativePerTx == 0 || maxNativePerDay < maxNativePerTx) revert InvalidLimit();
        agents[agent] = AgentPolicy(true, false, maxNativePerTx, maxNativePerDay, uint64(block.timestamp / 1 days), 0);
        emit AgentRegistered(agent, maxNativePerTx, maxNativePerDay);
    }

    function setAgentLimits(address agent, uint128 maxNativePerTx, uint128 maxNativePerDay) external onlyOwner {
        if (!agents[agent].registered) revert AgentNotRegistered();
        if (maxNativePerTx == 0 || maxNativePerDay < maxNativePerTx) revert InvalidLimit();
        agents[agent].maxNativePerTx = maxNativePerTx;
        agents[agent].maxNativePerDay = maxNativePerDay;
        emit AgentLimitsChanged(agent, maxNativePerTx, maxNativePerDay);
    }

    function setAgentPaused(address agent, bool paused) external onlyOwner {
        if (!agents[agent].registered) revert AgentNotRegistered();
        agents[agent].paused = paused;
        emit AgentStatusChanged(agent, paused);
    }

    function revokeAgent(address agent) external onlyOwner {
        if (!agents[agent].registered) revert AgentNotRegistered();
        delete agents[agent];
        emit AgentRevoked(agent);
    }

    function setGlobalPause(bool paused) external onlyOwner {
        globallyPaused = paused;
        emit GlobalPauseChanged(paused);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        allowedRecipients[recipient] = allowed;
        emit RecipientPermissionChanged(recipient, allowed);
    }

    function setTokenPolicy(address token, bool allowed, uint128 maxPerTx, uint128 maxPerDay) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (allowed && token.code.length == 0) revert InvalidToken();
        if (allowed && (maxPerTx == 0 || maxPerDay < maxPerTx)) revert InvalidLimit();
        allowedTokens[token] = allowed;
        tokenMaxPerTx[token] = maxPerTx;
        tokenMaxPerDay[token] = maxPerDay;
        emit TokenPolicyChanged(token, allowed, maxPerTx, maxPerDay);
    }

    /// @notice Owner can recover native coin from the vault at any time.
    function ownerWithdrawNative(address payable recipient, uint128 amount) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit OwnerWithdrawal(address(0), recipient, amount);
    }

    /// @notice Owner can recover ERC20 assets from the vault.
    function ownerWithdrawToken(address token, address recipient, uint128 amount) external onlyOwner {
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, recipient, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        emit OwnerWithdrawal(token, recipient, amount);
    }

    /// @notice Agent may transfer native coin only to an owner-approved recipient.
    function executeNative(address payable recipient, uint128 amount) external onlyActiveAgent {
        if (!allowedRecipients[recipient]) revert RecipientNotAllowed();
        AgentPolicy storage policy = agents[msg.sender];
        _rollNativeDay(policy);
        if (amount == 0 || amount > policy.maxNativePerTx || uint256(policy.nativeSpentToday) + amount > policy.maxNativePerDay) revert SpendLimitExceeded();
        policy.nativeSpentToday += amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeTransferExecuted(msg.sender, recipient, amount);
    }

    /// @notice Agent may call only ERC20 transfer(address,uint256), never approve or arbitrary token calldata.
    /// @notice Token daily cap is aggregate across all agents using this vault and token.
    function executeTokenTransfer(address token, address recipient, uint128 amount) external onlyActiveAgent {
        if (!allowedTokens[token]) revert TokenNotAllowed();
        if (!allowedRecipients[recipient]) revert RecipientNotAllowed();
        uint128 perTx = tokenMaxPerTx[token];
        uint128 perDay = tokenMaxPerDay[token];
        if (amount == 0 || amount > perTx) revert SpendLimitExceeded();
        uint64 today = uint64(block.timestamp / 1 days);
        if (tokenDayStart[token] != today) {
            tokenDayStart[token] = today;
            tokenSpentToday[token] = 0;
        }
        if (uint256(tokenSpentToday[token]) + amount > perDay) revert SpendLimitExceeded();
        tokenSpentToday[token] += amount;
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, recipient, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        emit TokenTransferExecuted(msg.sender, token, recipient, amount);
    }

    function _rollNativeDay(AgentPolicy storage policy) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (policy.dayStart != today) {
            policy.dayStart = today;
            policy.nativeSpentToday = 0;
        }
    }
}
