// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice The one call a faucet makes on its token. The faucet must hold the token's MINTER_ROLE.
interface IFaucetMintable {
    function mint(address to, uint256 amount) external;
}

/// @title AneFaucetBase — Bounded Public Sandbox Faucet Logic
/// @notice Grants free, worthless sandbox test tokens with per-recipient cooldowns and daily mint ceilings
///         (REQ-002, REQ-012, ADR-0006), directly or by a gasless EIP-712 relayed claim. Each concrete faucet
///         fixes its token, its on-chain DISCLAIMER and its EIP-712 name; the logic is shared (ADR-0021).
///         Faucet pause/limits never restrict peer-to-peer token transfers (REQ-001).
abstract contract AneFaucetBase is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant FAUCET_CLAIM_TYPEHASH =
        keccak256("FaucetClaim(address recipient,bytes32 campaignId,uint256 deadline,bytes32 nonce)");

    IFaucetMintable internal immutable _faucetToken;

    uint256 public claimAmount;
    uint64 public cooldownSeconds;
    uint256 public maxDailyMint;

    uint64 public currentDayIndex;
    uint256 public currentDayMinted;
    uint256 public totalClaims;
    uint256 public totalMintedByFaucet;

    mapping(address recipient => uint64 lastClaimTimestamp) public lastClaimAt;
    mapping(bytes32 nonce => bool used) public relayedNonceUsed;

    event FaucetClaimed(
        address indexed recipient,
        address indexed caller,
        uint256 amount,
        bytes32 indexed campaignId,
        uint64 nextEligibleTimestamp
    );
    event FaucetConfigUpdated(uint256 claimAmount, uint64 cooldownSeconds, uint256 maxDailyMint);

    error ZeroAddress();
    error InvalidFaucetConfig();
    error FaucetCooldownActive(address recipient, uint64 nextEligibleTimestamp, uint64 currentTimestamp);
    error DailyMintCapExceeded(uint256 requested, uint256 remainingDailyMint);
    error ClaimSignatureExpired(uint256 deadline, uint256 currentTimestamp);
    error RelayedNonceAlreadyUsed(bytes32 nonce);
    error InvalidClaimSignature();

    constructor(
        address token_,
        string memory eip712Name,
        address initialOwner,
        uint256 _claimAmount,
        uint64 _cooldownSeconds,
        uint256 _maxDailyMint
    ) Ownable(initialOwner) EIP712(eip712Name, "1") {
        if (token_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (_claimAmount == 0 || _maxDailyMint < _claimAmount) revert InvalidFaucetConfig();
        _faucetToken = IFaucetMintable(token_);
        claimAmount = _claimAmount;
        cooldownSeconds = _cooldownSeconds;
        maxDailyMint = _maxDailyMint;
        currentDayIndex = uint64(block.timestamp / 1 days);
    }

    /// @notice Permissionless on-chain claim for `recipient` (REQ-002).
    function claim(address recipient) external whenNotPaused nonReentrant returns (uint256 amount) {
        amount = _drip(recipient, bytes32(0));
    }

    /// @notice Gasless relayed claim authorized by an EIP-712 signature from `recipient` (ADR-0006, REQ-105).
    function relayedClaim(
        address recipient,
        bytes32 campaignId,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert ClaimSignatureExpired(deadline, block.timestamp);
        if (relayedNonceUsed[nonce]) revert RelayedNonceAlreadyUsed(nonce);

        bytes32 structHash = keccak256(abi.encode(FAUCET_CLAIM_TYPEHASH, recipient, campaignId, deadline, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, signature) != recipient) revert InvalidClaimSignature();

        relayedNonceUsed[nonce] = true;
        amount = _drip(recipient, campaignId);
    }

    /// @notice Returns the earliest timestamp at which `recipient` can claim again.
    function nextClaimTime(address recipient) public view returns (uint64) {
        uint64 last = lastClaimAt[recipient];
        // Zero is the "never claimed" sentinel, not a balance.
        // slither-disable-next-line incorrect-equality
        if (last == 0) return 0;
        return last + cooldownSeconds;
    }

    /// @notice Returns the remaining tokens the faucet can mint during the current UTC day.
    function remainingDailyAllowance() public view returns (uint256) {
        uint64 today = uint64(block.timestamp / 1 days);
        // Compares UTC day indices, not balances: a different day means the daily counter is stale.
        // slither-disable-next-line incorrect-equality
        uint256 mintedToday = (currentDayIndex == today) ? currentDayMinted : 0;
        return maxDailyMint > mintedToday ? maxDailyMint - mintedToday : 0;
    }

    /// @notice Updates faucet claim size, cooldown, and daily cap (onlyOwner).
    function setFaucetConfig(uint256 _claimAmount, uint64 _cooldownSeconds, uint256 _maxDailyMint) external onlyOwner {
        if (_claimAmount == 0 || _maxDailyMint < _claimAmount) revert InvalidFaucetConfig();
        claimAmount = _claimAmount;
        cooldownSeconds = _cooldownSeconds;
        maxDailyMint = _maxDailyMint;
        emit FaucetConfigUpdated(_claimAmount, _cooldownSeconds, _maxDailyMint);
    }

    /// @notice Pauses faucet grants only (OPERATIONS.md); never affects token transfers (REQ-001).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses faucet grants.
    function unpause() external onlyOwner {
        _unpause();
    }

    function _drip(address recipient, bytes32 campaignId) internal returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();

        uint64 nowTs = uint64(block.timestamp);
        uint64 nextEligible = nextClaimTime(recipient);
        if (nowTs < nextEligible) {
            revert FaucetCooldownActive(recipient, nextEligible, nowTs);
        }

        uint64 today = uint64(block.timestamp / 1 days);
        if (currentDayIndex != today) {
            currentDayIndex = today;
            currentDayMinted = 0;
        }

        amount = claimAmount;
        uint256 remDaily = maxDailyMint > currentDayMinted ? maxDailyMint - currentDayMinted : 0;
        if (amount > remDaily) {
            revert DailyMintCapExceeded(amount, remDaily);
        }

        lastClaimAt[recipient] = nowTs;
        currentDayMinted += amount;
        totalClaims += 1;
        totalMintedByFaucet += amount;

        _faucetToken.mint(recipient, amount);
        emit FaucetClaimed(recipient, msg.sender, amount, campaignId, nowTs + cooldownSeconds);
    }
}
