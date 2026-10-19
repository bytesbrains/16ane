// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneRegistry} from "../src/AneRegistry.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneFaucet} from "../src/AneFaucet.sol";
import {AneServiceDirectory} from "../src/AneServiceDirectory.sol";
import {DeploySandbox} from "../script/DeploySandbox.s.sol";

contract AneRegistryTest is Test {
    DeploySandbox internal deployerScript;
    address internal deployer = makeAddr("deployer");

    function setUp() public {
        vm.chainId(84532);
        deployerScript = new DeploySandbox();
    }

    function test_SandboxAndDevEnvironmentSeparation() public {
        // REQ-013: Separate unstable dev environment from stable public sandbox via distinct CREATE2 salts
        DeploySandbox.DeployedStack memory sandbox =
            deployerScript.deployForTest(deployer, deployerScript.SANDBOX_REGISTRY_SALT());
        DeploySandbox.DeployedStack memory dev =
            deployerScript.deployForTest(deployer, deployerScript.DEV_REGISTRY_SALT());

        assertTrue(address(sandbox.registry) != address(dev.registry));
        assertTrue(address(sandbox.taneToken) != address(dev.taneToken));

        (address tok, address fac, address fau, address dir, uint64 ver, uint64 upd) = sandbox.registry.getDeployment();
        assertEq(tok, address(sandbox.taneToken));
        assertEq(fac, address(sandbox.vaultFactory));
        assertEq(fau, address(sandbox.faucet));
        assertEq(dir, address(sandbox.serviceDirectory));
        assertEq(ver, 1);
        assertGt(upd, 0);
    }

    function test_MainnetChainIdRefusal() public {
        // ADR-0001 & ADR-0012: Strictly refuse Base Mainnet (8453) and Ethereum Mainnet (1)
        bytes32 salt = deployerScript.SANDBOX_REGISTRY_SALT();

        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(DeploySandbox.SandboxTestnetOnly.selector, 8453));
        deployerScript.deployForTest(deployer, salt);

        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeploySandbox.SandboxTestnetOnly.selector, 1));
        deployerScript.deployForTest(deployer, salt);
    }

    function test_RegistryWiringValidation() public {
        DeploySandbox.DeployedStack memory sandbox =
            deployerScript.deployForTest(deployer, deployerScript.SANDBOX_REGISTRY_SALT());

        AneTestToken wrongToken = new AneTestToken(deployer);
        AneVaultFactory wrongFactory = new AneVaultFactory(address(wrongToken));

        vm.startPrank(deployer);
        vm.expectRevert(AneRegistry.WiringMismatch.selector);
        sandbox.registry
            .setDeployment(
                address(sandbox.taneToken),
                address(wrongFactory),
                address(sandbox.faucet),
                address(sandbox.serviceDirectory)
            );
        vm.stopPrank();
    }
}
