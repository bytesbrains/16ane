// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AneFaucetBase} from "./AneFaucetBase.sol";
import {AneTestToken} from "./AneTestToken.sol";

/// @title AneFaucet — Bounded Public Sandbox tANE Faucet
/// @notice Distributes free, worthless sandbox tANE with per-recipient cooldowns and daily mint ceilings
///         (REQ-002, REQ-012, ADR-0006). Faucet pause/limits never restrict peer-to-peer tANE transfers (REQ-001).
/// @dev The logic lives in AneFaucetBase (ADR-0021). The ABI, storage layout and EIP-712 domain ("AneFaucet", "1")
///      are unchanged from the deployed sandbox faucet, so existing clients and relayed-claim signatures still work.
contract AneFaucet is AneFaucetBase {
    string public constant DISCLAIMER =
        "TEST TOKENS (tANE) - NO CASH VALUE, NO INR BACKING, NO REDEMPTION OR CONVERSION.";

    constructor(
        address _taneToken,
        address initialOwner,
        uint256 _claimAmount,
        uint64 _cooldownSeconds,
        uint256 _maxDailyMint
    ) AneFaucetBase(_taneToken, "AneFaucet", initialOwner, _claimAmount, _cooldownSeconds, _maxDailyMint) {}

    /// @notice The tANE token this faucet mints.
    function taneToken() external view returns (AneTestToken) {
        return AneTestToken(address(_faucetToken));
    }
}
