// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @title AneSixDecimalTestToken (tSIX) — 16ane Sandbox Second Test Asset
/// @notice Free, unbacked, worthless simulation token with 6 decimals, so multi-asset vaults and routing are
///         exercised across a decimals mismatch (REQ-204, ADR-0020). It is not tANE, not convertible to tANE or
///         ANE, and not modelled on any real asset. Transfers are permissionless with no pause or blacklist.
/// @dev ERC-20, ERC20Burnable, EIP-2612 Permit and AccessControlDefaultAdminRules, like tANE but without
///      EIP-3009: the gasless relay path stays tANE-only (ADR-0006).
contract AneSixDecimalTestToken is ERC20, ERC20Burnable, ERC20Permit, AccessControlDefaultAdminRules {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public constant DISCLAIMER =
        "TESTNET SIMULATION TOKEN ONLY. NO INR BACKING, NO REDEMPTION, NO MONETARY VALUE.";

    error ZeroAddress();

    constructor(address initialAdmin)
        ERC20("16ane tSIX (NO CASH VALUE)", "tSIX")
        ERC20Permit("16ane tSIX (NO CASH VALUE)")
        AccessControlDefaultAdminRules(1 days, initialAdmin)
    {
        if (initialAdmin == address(0)) revert ZeroAddress();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Programmatic guard confirming this contract is an unbacked test token (ADR-0002, ADR-0012).
    function isTestToken() external pure returns (bool) {
        return true;
    }

    /// @notice Mints sandbox tSIX to `to`. Restricted to MINTER_ROLE.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
