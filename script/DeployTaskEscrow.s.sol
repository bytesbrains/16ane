// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AneRegistry} from "../src/AneRegistry.sol";
import {AneTaskEscrow} from "../src/AneTaskEscrow.sol";

/// @title DeployTaskEscrow — Adds AneTaskEscrow to an Existing Sandbox Deployment
/// @notice Deploys only the escrow, wired to the tANE token and vault factory that `REGISTRY_ADDRESS` resolves,
///         so a live sandbox gains it without a redeployment (ADR-0001 continuity, ISS-021). A fresh
///         `DeploySandbox` run already includes it. Reverts on any chain but Base Sepolia or a local one.
contract DeployTaskEscrow is Script {
    error SandboxTestnetOnly(uint256 chainId);

    function run() external returns (AneTaskEscrow escrow) {
        AneRegistry registry = AneRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        // As in DeploySandbox: an encrypted keystore (`--account`) on Base Sepolia, PRIVATE_KEY for local runs.
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        escrow = _deploy(registry);
        vm.stopBroadcast();
    }

    function deployForTest(AneRegistry registry) external returns (AneTaskEscrow) {
        return _deploy(registry);
    }

    function _deploy(AneRegistry registry) internal returns (AneTaskEscrow escrow) {
        if (block.chainid != 84532 && block.chainid != 31337) revert SandboxTestnetOnly(block.chainid);
        escrow = new AneTaskEscrow(registry.taneToken(), registry.vaultFactory());
        console.log("AneTaskEscrow:", address(escrow));
    }
}
