// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AneRegistry} from "../src/AneRegistry.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneFaucet} from "../src/AneFaucet.sol";
import {AneServiceDirectory} from "../src/AneServiceDirectory.sol";

/// @title DeploySandbox — Deterministic Sandbox & Dev Environment Deployment Script
/// @notice Deploys and wires the 16ane public sandbox contracts on Base Sepolia (84532) or Anvil (31337).
///         Strictly reverts on mainnet chain IDs (ADR-0001, ADR-0012, REQ-013).
contract DeploySandbox is Script {
    bytes32 public constant SANDBOX_REGISTRY_SALT = keccak256("16ane.registry.sandbox.v1");
    bytes32 public constant DEV_REGISTRY_SALT = keccak256("16ane.registry.dev.v1");

    uint256 public constant DEFAULT_FAUCET_CLAIM = 1_600 * 1e18; // 1,600 tANE (illustrative ₹100; ZERO cash value)
    uint64 public constant DEFAULT_FAUCET_COOLDOWN = 24 hours;
    uint256 public constant DEFAULT_FAUCET_DAILY_CAP = 1_600_000 * 1e18;

    error SandboxTestnetOnly(uint256 chainId);

    struct DeployedStack {
        AneRegistry registry;
        AneTestToken taneToken;
        AneVaultFactory vaultFactory;
        AneFaucet faucet;
        AneServiceDirectory serviceDirectory;
    }

    function run() external returns (DeployedStack memory stack) {
        _requireTestnetChain(block.chainid);

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bytes32 registrySalt = _resolveRegistrySalt();

        vm.startBroadcast(deployerKey);
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
