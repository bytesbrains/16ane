// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AneRegistry} from "../src/AneRegistry.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneFaucet} from "../src/AneFaucet.sol";
import {AneServiceDirectory} from "../src/AneServiceDirectory.sol";
import {AneTaskEscrow} from "../src/AneTaskEscrow.sol";
import {AneSixDecimalTestToken} from "../src/AneSixDecimalTestToken.sol";
import {SecondAssetDeployment} from "./DeploySecondAsset.s.sol";

/// @title DeploySandbox — Deterministic Sandbox & Dev Environment Deployment Script
/// @notice Deploys and wires the 16ane public sandbox contracts on Base Sepolia (84532) or Anvil (31337).
///         Strictly reverts on mainnet chain IDs (ADR-0001, ADR-0012, REQ-013).
contract DeploySandbox is Script {
    bytes32 public constant SANDBOX_REGISTRY_SALT = keccak256("16ane.registry.sandbox.v1");
    bytes32 public constant DEV_REGISTRY_SALT = keccak256("16ane.registry.dev.v1");

    // Sized for owners funding agent workloads (ADR-0006, #61); the owner can change them with setFaucetConfig.
    uint256 public constant DEFAULT_FAUCET_CLAIM = 16_000 * 1e18; // 16,000 tANE (illustrative ₹1,000; ZERO cash value)
    uint64 public constant DEFAULT_FAUCET_COOLDOWN = 1 hours; // per recipient
    uint256 public constant DEFAULT_FAUCET_DAILY_CAP = 160_000_000 * 1e18; // ~10,000 claims/day; a runaway stop, not a throttle

    error SandboxTestnetOnly(uint256 chainId);

    struct DeployedStack {
        AneRegistry registry;
        AneTestToken taneToken;
        AneVaultFactory vaultFactory;
        AneFaucet faucet;
        AneServiceDirectory serviceDirectory;
        AneTaskEscrow taskEscrow;
        AneSixDecimalTestToken sixDecimalToken;
        AneVaultFactory sixDecimalVaultFactory;
    }

    function run() external returns (DeployedStack memory stack) {
        _requireTestnetChain(block.chainid);
        bytes32 registrySalt = _resolveRegistrySalt();

        // Preferred for Base Sepolia: an encrypted keystore (`--account <name> --sender <address>`), so the
        // key never sits in the environment (docs/operations/DEPLOY_SANDBOX.md). PRIVATE_KEY remains for
        // CI's dry run and the local E2E harness.
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) {
            vm.startBroadcast(deployerKey);
        } else {
            vm.startBroadcast();
        }
        (, address deployer,) = vm.readCallers();
        stack = _deployAll(deployer, registrySalt);
        vm.stopBroadcast();
    }

    function deployForTest(address deployer, bytes32 registrySalt) public returns (DeployedStack memory stack) {
        _requireTestnetChain(block.chainid);
        vm.startPrank(deployer);
        stack = _deployAll(deployer, registrySalt);
        vm.stopPrank();
    }

    function _deployAll(address deployer, bytes32 registrySalt) internal returns (DeployedStack memory stack) {
        stack.registry = new AneRegistry{salt: registrySalt}(deployer);
        stack.taneToken = new AneTestToken(deployer);
        stack.vaultFactory = new AneVaultFactory(address(stack.taneToken));
        stack.faucet = new AneFaucet(
            address(stack.taneToken), deployer, DEFAULT_FAUCET_CLAIM, DEFAULT_FAUCET_COOLDOWN, DEFAULT_FAUCET_DAILY_CAP
        );
        stack.serviceDirectory = new AneServiceDirectory();
        // Deployed last, so the addresses above don't move. Not in the registry (it has no slot for it):
        // clients take its address from the deploy output or the network file (#21).
        stack.taskEscrow = new AneTaskEscrow(address(stack.taneToken), address(stack.vaultFactory));

        stack.taneToken.grantRole(stack.taneToken.MINTER_ROLE(), address(stack.faucet));
        stack.registry
            .setDeployment(
                address(stack.taneToken),
                address(stack.vaultFactory),
                address(stack.faucet),
                address(stack.serviceDirectory)
            );

        console.log("AneRegistry:", address(stack.registry));
        console.log("AneTestToken (tANE):", address(stack.taneToken));
        console.log("AneVaultFactory:", address(stack.vaultFactory));
        console.log("AneFaucet:", address(stack.faucet));
        console.log("AneServiceDirectory:", address(stack.serviceDirectory));
        console.log("AneTaskEscrow:", address(stack.taskEscrow));

        // The second test asset and its own vault factory (ADR-0020), after everything else so no address above
        // moves. Like the escrow, the registry has no slot for them: clients take them from the deploy output.
        SecondAssetDeployment.Deployed memory second = SecondAssetDeployment.deploy(deployer);
        stack.sixDecimalToken = second.token;
        stack.sixDecimalVaultFactory = second.vaultFactory;
    }

    function _resolveRegistrySalt() internal view returns (bytes32) {
        string memory envName = vm.envOr("ANE_ENV", string("sandbox"));
        if (keccak256(bytes(envName)) == keccak256(bytes("dev"))) {
            return DEV_REGISTRY_SALT;
        }
        return SANDBOX_REGISTRY_SALT;
    }

    function _requireTestnetChain(uint256 chainId) internal pure {
        if (chainId != 84532 && chainId != 31337) {
            revert SandboxTestnetOnly(chainId);
        }
    }
}
