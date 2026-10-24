// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneSixDecimalTestToken} from "../src/AneSixDecimalTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneRegistry} from "../src/AneRegistry.sol";
import {AneTaskEscrow} from "../src/AneTaskEscrow.sol";
import {DeploySandbox} from "../script/DeploySandbox.s.sol";
import {DeploySecondAsset, SecondAssetDeployment} from "../script/DeploySecondAsset.s.sol";

/// @notice ADR-0020: one vault per asset, one factory per asset. A cap, a spend or revenue in one asset never
///         reaches the budget of another, and the unchanged tANE contracts refuse second-asset vaults.
contract AneMultiAssetTest is Test {
    AneTestToken internal tane;
    AneSixDecimalTestToken internal six;
    AneVaultFactory internal taneFactory;
    AneVaultFactory internal sixFactory;
    AneAgentVault internal taneVault;
    AneAgentVault internal sixVault;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal merchant = makeAddr("merchant");
    uint256 internal nonceCounter;

    function setUp() public {
        vm.warp(1_700_000_000);
        tane = new AneTestToken(admin);
        six = new AneSixDecimalTestToken(admin);
        vm.startPrank(admin);
        tane.grantRole(tane.MINTER_ROLE(), admin);
        six.grantRole(six.MINTER_ROLE(), admin);
        tane.mint(owner, 10_000e18);
        six.mint(owner, 10_000e6);
        vm.stopPrank();

        taneFactory = new AneVaultFactory(address(tane));
        sixFactory = new AneVaultFactory(address(six));
        // The same owner and salt in each factory: one agent, one vault per asset.
        taneVault = AneAgentVault(taneFactory.createVault(owner, bytes32("agent")));
        sixVault = AneAgentVault(sixFactory.createVault(owner, bytes32("agent")));
    }

    // ---- helpers ----

    function _fundAndDelegate(
        AneAgentVault vault,
        uint256 fundAmount,
        uint256 cap,
        uint256 perTx,
        AneAgentVault.BudgetMode mode,
        uint256 ceiling
    ) internal {
        vm.startPrank(owner);
        if (vault.taneToken() == address(tane)) tane.approve(address(vault), fundAmount);
        else six.approve(address(vault), fundAmount);
        vault.fund(fundAmount);
        vault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: agent,
                maxTotalSpend: cap,
                maxPerTx: perTx,
                dailyLimit: 0,
                expiry: uint64(block.timestamp + 30 days),
                budgetMode: mode,
                revolvingTreasuryCeiling: ceiling
            })
        );
        vm.stopPrank();
    }

    function _spend(AneAgentVault vault, address to, uint256 amount) internal returns (bytes32) {
        nonceCounter += 1;
        vm.prank(agent);
        return vault.spend(
            to,
            amount,
            keccak256(abi.encode("q", nonceCounter)),
            keccak256("svc"),
            keccak256(abi.encode("n", nonceCounter))
        );
    }

    // ---- tests ----

    function test_SixDecimalTokenIsAFreeTestAsset() public {
        assertEq(six.decimals(), 6);
        assertEq(six.symbol(), "tSIX");
        assertEq(six.name(), "16ane tSIX (NO CASH VALUE)");
        assertTrue(six.isTestToken());
        assertEq(six.DISCLAIMER(), tane.DISCLAIMER());

        bytes32 minterRole = six.MINTER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, owner, minterRole)
        );
        vm.prank(owner);
        six.mint(owner, 1);
    }

    function test_EachFactoryRegistersOnlyVaultsOfItsOwnAsset() public view {
        assertEq(taneVault.taneToken(), address(tane));
        assertEq(sixVault.taneToken(), address(six));
        assertTrue(address(taneVault) != address(sixVault));
        assertEq(sixFactory.predictVaultAddress(owner, bytes32("agent")), address(sixVault));

        assertTrue(taneFactory.isRegisteredVault(address(taneVault)));
        assertFalse(taneFactory.isRegisteredVault(address(sixVault)));
        assertTrue(sixFactory.isRegisteredVault(address(sixVault)));
        assertFalse(sixFactory.isRegisteredVault(address(taneVault)));
    }

    function test_CapsAndSpendsAreInEachAssetsOwnBaseUnits() public {
        _fundAndDelegate(taneVault, 1_000e18, 100e18, 40e18, AneAgentVault.BudgetMode.FIXED, 0);
        _fundAndDelegate(sixVault, 1_000e6, 10e6, 4e6, AneAgentVault.BudgetMode.FIXED, 0);

        _spend(sixVault, merchant, 2_500_000); // 2.5 tSIX
        assertEq(six.balanceOf(merchant), 2_500_000);
        assertEq(sixVault.cumulativeSpent(), 2_500_000);
        assertEq(sixVault.authorizedRemaining(), 7_500_000);

        // The tANE vault is untouched by the tSIX spend.
        assertEq(taneVault.cumulativeSpent(), 0);
        assertEq(taneVault.authorizedRemaining(), 100e18);

        // 4 tSIX + 1 base unit is over the tSIX per-tx limit, however small it looks next to an 18-decimal cap.
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsPerTxLimit.selector, 4e6 + 1, 4e6));
        nonceCounter += 1;
        vm.prank(agent);
        sixVault.spend(merchant, 4e6 + 1, keccak256("q-over"), keccak256("svc"), keccak256("n-over"));
    }

    function test_CrossAssetPaymentNeverCreditsRevenue() public {
        // Both REVOLVING with headroom, so any revenue credit would raise the ceiling and show.
        _fundAndDelegate(taneVault, 1_000e18, 100e18, 50e18, AneAgentVault.BudgetMode.REVOLVING, 500e18);
        _fundAndDelegate(sixVault, 1_000e6, 10e6, 5e6, AneAgentVault.BudgetMode.REVOLVING, 50e6);
        uint256 taneCeiling = taneVault.effectiveSpendCeiling();
        uint256 sixCeiling = sixVault.effectiveSpendCeiling();

        // 5e18 tANE base units would be five trillion tSIX if it were ever read in tSIX units.
        _spend(taneVault, address(sixVault), 5e18);
        _spend(sixVault, address(taneVault), 5e6);

        assertEq(sixVault.verifiedRevenue(), 0);
        assertEq(taneVault.verifiedRevenue(), 0);
        assertEq(sixVault.effectiveSpendCeiling(), sixCeiling);
        assertEq(taneVault.effectiveSpendCeiling(), taneCeiling);
        // The foreign token is a stray balance, never budget: spendable counts only the vault's own token.
        assertEq(tane.balanceOf(address(sixVault)), 5e18);
        assertEq(sixVault.spendableBalance(), 10e6 - 5e6);
    }

    function test_SameAssetPeerRevenueStillCredits() public {
        // The control for the test above: revenue credit works between vaults of one asset.
        AneAgentVault sixPeer = AneAgentVault(sixFactory.createVault(owner, bytes32("peer")));
        _fundAndDelegate(sixPeer, 1_000e6, 100e6, 50e6, AneAgentVault.BudgetMode.FIXED, 0);
        _fundAndDelegate(sixVault, 1_000e6, 10e6, 5e6, AneAgentVault.BudgetMode.REVOLVING, 50e6);

        _spend(sixPeer, address(sixVault), 3e6);
        assertEq(sixVault.verifiedRevenue(), 3e6);
        assertEq(sixVault.effectiveSpendCeiling(), 13e6);
    }

    function test_TaneEscrowRefusesASecondAssetVault() public {
        AneTaskEscrow escrow = new AneTaskEscrow(address(tane), address(taneFactory));
        AneAgentVault.SpendIntent memory intent = AneAgentVault.SpendIntent({
            vault: address(sixVault),
            merchant: address(escrow),
            amount: 1e6,
            quoteId: escrow.taskQuoteId(merchant, uint64(block.timestamp + 1 days), keccak256("spec")),
            serviceIdHash: keccak256("svc"),
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("n"),
            policyVersion: sixVault.policyVersion()
        });
        // Otherwise the escrow would hold tSIX and release tANE that other tasks locked.
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.UnregisteredVault.selector, address(sixVault)));
        escrow.openTask(intent, "", merchant, uint64(block.timestamp + 1 days), keccak256("spec"));
    }

    function test_SandboxDeploysTheSecondAssetWithoutMovingTheRest() public {
        vm.chainId(84532);
        address deployer = makeAddr("deployer");
        DeploySandbox script = new DeploySandbox();
        DeploySandbox.DeployedStack memory stack = script.deployForTest(deployer, script.SANDBOX_REGISTRY_SALT());

        assertEq(stack.sixDecimalVaultFactory.taneToken(), address(stack.sixDecimalToken));
        // The tSIX faucet is the only minter, as the tANE faucet is for tANE (ADR-0021).
        assertTrue(stack.sixDecimalToken.hasRole(stack.sixDecimalToken.MINTER_ROLE(), address(stack.sixDecimalFaucet)));
        assertFalse(stack.sixDecimalToken.hasRole(stack.sixDecimalToken.MINTER_ROLE(), deployer));
        assertEq(address(stack.sixDecimalFaucet.tsixToken()), address(stack.sixDecimalToken));
        (address token, address factory,,,,) = stack.registry.getDeployment();
        assertEq(token, address(stack.taneToken));
        assertEq(factory, address(stack.vaultFactory));
        assertEq(stack.taskEscrow.vaultFactory(), address(stack.vaultFactory));

        // The registry's wiring check refuses a factory of another asset in the tANE slot.
        vm.prank(deployer);
        vm.expectRevert(AneRegistry.WiringMismatch.selector);
        stack.registry
            .setDeployment(
                address(stack.taneToken),
                address(stack.sixDecimalVaultFactory),
                address(stack.faucet),
                address(stack.serviceDirectory)
            );
    }

    function test_SecondAssetCanBeAddedToALiveSandboxAndRefusesMainnet() public {
        DeploySecondAsset script = new DeploySecondAsset();
        address deployer = makeAddr("deployer");
        vm.chainId(84532);
        SecondAssetDeployment.Deployed memory d = script.deployForTest(deployer);
        assertEq(d.vaultFactory.taneToken(), address(d.token));
        assertTrue(d.token.hasRole(d.token.DEFAULT_ADMIN_ROLE(), deployer));
        assertEq(address(d.faucet.tsixToken()), address(d.token));
        assertEq(d.faucet.owner(), deployer);
        // A claim is 16,000 tSIX in tSIX's own 6-decimal units, not 16,000e18.
        assertEq(d.faucet.claim(makeAddr("tester")), 16_000e6);
        assertEq(d.token.balanceOf(makeAddr("tester")), 16_000e6);

        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(DeploySecondAsset.SandboxTestnetOnly.selector, 8453));
        script.deployForTest(deployer);
    }
}
