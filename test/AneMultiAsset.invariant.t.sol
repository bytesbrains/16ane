// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneSixDecimalTestToken} from "../src/AneSixDecimalTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";

/// @dev One owner and one agent signer with a tANE vault (FIXED) and a tSIX vault (REVOLVING), plus a tSIX peer
///      vault that pays legitimate same-asset revenue. Ghost totals record what each action did, per asset.
contract MultiAssetHandler is Test {
    AneTestToken public tane;
    AneSixDecimalTestToken public six;
    AneAgentVault public taneVault;
    AneAgentVault public sixVault;
    AneAgentVault public sixPeer;

    address public owner = makeAddr("multiOwner");
    address public agent = makeAddr("multiAgent");
    address public merchant = makeAddr("multiMerchant");

    uint256 public constant TANE_CAP = 320e18;
    uint256 public constant SIX_CAP = 300e6;
    uint256 public constant SIX_CEILING = 500e6;

    uint256 public ghostTaneSpent;
    uint256 public ghostSixSpent;
    uint256 public ghostSixRevenue;
    uint256 public ghostTaneIntoSixVault;
    uint256 public ghostSixIntoTaneVault;
    uint256 internal nonceCounter;

    constructor(
        AneTestToken _tane,
        AneSixDecimalTestToken _six,
        AneVaultFactory taneFactory,
        AneVaultFactory sixFactory
    ) {
        tane = _tane;
        six = _six;
        taneVault = AneAgentVault(taneFactory.createVault(owner, bytes32("agent")));
        sixVault = AneAgentVault(sixFactory.createVault(owner, bytes32("agent")));
        sixPeer = AneAgentVault(sixFactory.createVault(owner, bytes32("peer")));
    }

    function init() external {
        tane.mint(owner, 10_000e18);
        six.mint(owner, 1_000_000e6);
        vm.startPrank(owner);
        tane.approve(address(taneVault), 1_600e18);
        taneVault.fund(1_600e18);
        six.approve(address(sixVault), 1_600e6);
        sixVault.fund(1_600e6);
        six.approve(address(sixPeer), 100_000e6);
        sixPeer.fund(100_000e6);
        vm.stopPrank();

        _delegate(taneVault, TANE_CAP, 160e18, AneAgentVault.BudgetMode.FIXED, 0);
        _delegate(sixVault, SIX_CAP, 50e6, AneAgentVault.BudgetMode.REVOLVING, SIX_CEILING);
        _delegate(sixPeer, 100_000e6, 10_000e6, AneAgentVault.BudgetMode.FIXED, 0);
    }

    function _delegate(AneAgentVault vault, uint256 cap, uint256 perTx, AneAgentVault.BudgetMode mode, uint256 ceiling)
        internal
    {
        vm.prank(owner);
        vault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: agent,
                maxTotalSpend: cap,
                maxPerTx: perTx,
                dailyLimit: 0,
                expiry: uint64(block.timestamp + 365 days),
                budgetMode: mode,
                revolvingTreasuryCeiling: ceiling
            })
        );
    }

    /// @dev Spends a bounded amount the vault can afford; returns 0 (and does nothing) when it can afford none.
    function _spend(AneAgentVault vault, address to, uint256 raw, uint256 perTx) internal returns (uint256 amount) {
        uint256 rem = vault.spendableBalance();
        if (rem == 0) return 0;
        amount = bound(raw, 1, rem < perTx ? rem : perTx);
        nonceCounter += 1;
        vm.prank(agent);
        vault.spend(
            to,
            amount,
            keccak256(abi.encode("q", nonceCounter)),
            keccak256("svc"),
            keccak256(abi.encode("n", nonceCounter))
        );
    }

    function actionSpendTane(uint96 raw) external {
        ghostTaneSpent += _spend(taneVault, merchant, raw, 160e18);
    }

    function actionSpendSix(uint96 raw) external {
        ghostSixSpent += _spend(sixVault, merchant, raw, 50e6);
    }

    function actionTanePaysSixVault(uint96 raw) external {
        uint256 amount = _spend(taneVault, address(sixVault), raw, 160e18);
        ghostTaneSpent += amount;
        ghostTaneIntoSixVault += amount;
    }

    function actionSixPaysTaneVault(uint96 raw) external {
        uint256 amount = _spend(sixVault, address(taneVault), raw, 50e6);
        ghostSixSpent += amount;
        ghostSixIntoTaneVault += amount;
    }

    function actionSixPeerRevenue(uint96 raw) external {
        ghostSixRevenue += _spend(sixPeer, address(sixVault), raw, 10_000e6);
    }
}

contract AneMultiAssetInvariantTest is Test {
    MultiAssetHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        AneTestToken tane = new AneTestToken(address(this));
        AneSixDecimalTestToken six = new AneSixDecimalTestToken(address(this));
        handler =
            new MultiAssetHandler(tane, six, new AneVaultFactory(address(tane)), new AneVaultFactory(address(six)));
        tane.grantRole(tane.MINTER_ROLE(), address(handler));
        six.grantRole(six.MINTER_ROLE(), address(handler));
        handler.init();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = MultiAssetHandler.actionSpendTane.selector;
        selectors[1] = MultiAssetHandler.actionSpendSix.selector;
        selectors[2] = MultiAssetHandler.actionTanePaysSixVault.selector;
        selectors[3] = MultiAssetHandler.actionSixPaysTaneVault.selector;
        selectors[4] = MultiAssetHandler.actionSixPeerRevenue.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Each vault's spend counter moves only with spends in its own asset.
    function invariant_SpendInOneAssetNeverMovesAnothersBudget() public view {
        assertEq(handler.taneVault().cumulativeSpent(), handler.ghostTaneSpent());
        assertEq(handler.sixVault().cumulativeSpent(), handler.ghostSixSpent());
    }

    /// @notice Revenue credit comes only from vaults of the same asset; cross-asset payments credit nothing.
    function invariant_RevenueNeverCrossesAssets() public view {
        assertEq(handler.taneVault().verifiedRevenue(), 0);
        assertEq(handler.sixVault().verifiedRevenue(), handler.ghostSixRevenue());
    }

    /// @notice FIXED mode stays fixed and REVOLVING never exceeds cap plus same-asset revenue (AGENTS.md).
    function invariant_CeilingsHoldPerAsset() public view {
        AneAgentVault t = handler.taneVault();
        AneAgentVault s = handler.sixVault();
        assertEq(t.effectiveSpendCeiling(), handler.TANE_CAP());
        assertLe(t.cumulativeSpent() + t.authorizedRemaining(), handler.TANE_CAP());
        assertLe(s.effectiveSpendCeiling(), handler.SIX_CAP() + handler.ghostSixRevenue());
        assertLe(s.cumulativeSpent(), handler.SIX_CAP() + handler.ghostSixRevenue());
    }

    /// @notice A foreign token paid into a vault is a stray balance, never spendable.
    function invariant_ForeignTokensAreNeverSpendable() public view {
        AneAgentVault t = handler.taneVault();
        AneAgentVault s = handler.sixVault();
        assertEq(handler.six().balanceOf(address(t)), handler.ghostSixIntoTaneVault());
        assertEq(handler.tane().balanceOf(address(s)), handler.ghostTaneIntoSixVault());
        assertLe(t.spendableBalance(), handler.tane().balanceOf(address(t)));
        assertLe(s.spendableBalance(), handler.six().balanceOf(address(s)));
    }
}
