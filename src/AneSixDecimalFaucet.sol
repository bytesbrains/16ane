// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AneFaucetBase} from "./AneFaucetBase.sol";
import {AneSixDecimalTestToken} from "./AneSixDecimalTestToken.sol";

/// @title AneSixDecimalFaucet — Bounded Public Sandbox tSIX Faucet
/// @notice Distributes free, worthless sandbox tSIX, the 6-decimal second test asset (REQ-204, ADR-0020), with the
///         same per-recipient cooldowns, daily mint ceilings and gasless relayed claims as the tANE faucet
///         (ADR-0006, ADR-0021). Faucet pause/limits never restrict peer-to-peer tSIX transfers (REQ-001).
/// @dev Its EIP-712 domain is ("AneSixDecimalFaucet", "1"), so a relayed claim signed for the tANE faucet cannot
///      be replayed here, and the reverse.
contract AneSixDecimalFaucet is AneFaucetBase {
    string public constant DISCLAIMER =
        "TEST TOKENS (tSIX) - NO CASH VALUE, NO INR BACKING, NO REDEMPTION OR CONVERSION.";

    constructor(
        address _tsixToken,
        address initialOwner,
        uint256 _claimAmount,
        uint64 _cooldownSeconds,
        uint256 _maxDailyMint
    ) AneFaucetBase(_tsixToken, "AneSixDecimalFaucet", initialOwner, _claimAmount, _cooldownSeconds, _maxDailyMint) {}

    /// @notice The tSIX token this faucet mints.
    function tsixToken() external view returns (AneSixDecimalTestToken) {
        return AneSixDecimalTestToken(address(_faucetToken));
    }
}
