// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AneSixDecimalFaucet} from "../src/AneSixDecimalFaucet.sol";
import {AneSixDecimalTestToken} from "../src/AneSixDecimalTestToken.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";

/// @notice The second test asset and its own vault factory (ADR-0020). One factory per asset is what keeps
///         assets apart: each factory registers only vaults of its own token, so revenue credit and escrow
///         registration can never cross assets. Shared by DeploySandbox and DeploySecondAsset.
library SecondAssetDeployment {
    // The tANE faucet defaults (DeploySandbox, ADR-0006, #61) in tSIX's own 6-decimal base units.
    uint256 internal constant FAUCET_CLAIM = 16_000 * 1e6; // 16,000 tSIX (ZERO cash value)
    uint64 internal constant FAUCET_COOLDOWN = 1 hours; // per recipient
    uint256 internal constant FAUCET_DAILY_CAP = 160_000_000 * 1e6; // a runaway stop, not a throttle

    struct Deployed {
        AneSixDecimalTestToken token;
        AneVaultFactory vaultFactory;
        AneSixDecimalFaucet faucet;
    }

    function deploy(address deployer) internal returns (Deployed memory d) {
        d.token = new AneSixDecimalTestToken(deployer);
        d.vaultFactory = new AneVaultFactory(address(d.token));
        d.faucet = new AneSixDecimalFaucet(address(d.token), deployer, FAUCET_CLAIM, FAUCET_COOLDOWN, FAUCET_DAILY_CAP);
        // As with tANE, the faucet is the only minter (ADR-0021); the deployer keeps only the admin role.
        d.token.grantRole(d.token.MINTER_ROLE(), address(d.faucet));
        console.log("AneSixDecimalTestToken (tSIX):", address(d.token));
        console.log("AneVaultFactory (tSIX):", address(d.vaultFactory));
        console.log("AneSixDecimalFaucet (tSIX):", address(d.faucet));
    }
}

/// @title DeploySecondAsset — Adds the tSIX Test Asset to an Existing Sandbox Deployment
/// @notice Deploys only tSIX, its vault factory and its faucet. Nothing already deployed changes, so tANE vault addresses,
///         the registry and the escrow keep working (ADR-0001 continuity). A fresh `DeploySandbox` run already
///         includes it. Reverts on any chain but Base Sepolia or a local one.
contract DeploySecondAsset is Script {
    error SandboxTestnetOnly(uint256 chainId);

    function run() external returns (SecondAssetDeployment.Deployed memory deployed) {
        _requireTestnetChain();
        // As in DeploySandbox: an encrypted keystore (`--account`) on Base Sepolia, PRIVATE_KEY for local runs.
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        (, address deployer,) = vm.readCallers();
        deployed = SecondAssetDeployment.deploy(deployer);
        vm.stopBroadcast();
    }

    function deployForTest(address deployer) external returns (SecondAssetDeployment.Deployed memory deployed) {
        _requireTestnetChain();
        vm.startPrank(deployer);
        deployed = SecondAssetDeployment.deploy(deployer);
        vm.stopPrank();
    }

    function _requireTestnetChain() internal view {
        if (block.chainid != 84532 && block.chainid != 31337) revert SandboxTestnetOnly(block.chainid);
    }
}
