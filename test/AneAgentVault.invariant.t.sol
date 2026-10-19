// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";

contract FixedBudgetHandler is Test {
    AneTestToken public token;
    AneVaultFactory public factory;
    AneAgentVault public vault;
    AneAgentVault public peerVault;

    address public owner = makeAddr("handlerOwner");
    address public agent = makeAddr("handlerAgent");
    address public peerOwner = makeAddr("peerOwner");
    address public peerAgent = makeAddr("peerAgent");
    address public merchant = makeAddr("handlerMerchant");

    uint256 public constant INITIAL_MAX_SPEND = 320e18;
    uint256 public nonceCounter;
    bytes32 public lastPaymentId;

    constructor(AneTestToken _token, AneVaultFactory _factory) {
        token = _token;
        factory = _factory;
    }

    function init() external {
        vault = AneAgentVault(factory.createVault(owner, bytes32("inv-vault")));
        peerVault = AneAgentVault(factory.createVault(peerOwner, bytes32("inv-peer")));

        token.mint(owner, 1_000_000e18);
        token.mint(peerOwner, 1_000_000e18);

        vm.startPrank(owner);
        token.approve(address(vault), 1_600e18);
        vault.fund(1_600e18);
        vault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: agent,
                maxTotalSpend: INITIAL_MAX_SPEND,
                maxPerTx: 160e18,
                dailyLimit: 320e18,
                expiry: uint64(block.timestamp + 365 days),
                budgetMode: AneAgentVault.BudgetMode.FIXED,
                revolvingTreasuryCeiling: 0
            })
        );
        vm.stopPrank();

        vm.startPrank(peerOwner);
        token.approve(address(peerVault), 100_000e18);
        peerVault.fund(100_000e18);
        peerVault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: peerAgent,
                maxTotalSpend: 100_000e18,
                maxPerTx: 10_000e18,
                dailyLimit: 100_000e18,
                expiry: uint64(block.timestamp + 365 days),
                budgetMode: AneAgentVault.BudgetMode.FIXED,
                revolvingTreasuryCeiling: 0
            })
        );
        vm.stopPrank();
    }

    function actionSpend(uint96 rawAmount) external {
        uint256 rem = vault.spendableBalance();
        if (rem == 0) return;
        uint256 maxAllowed = rem > 160e18 ? 160e18 : rem;
        uint256 amount = bound(uint256(rawAmount), 1, maxAllowed);

        nonceCounter += 1;
        bytes32 qId = keccak256(abi.encode("q", nonceCounter));
        bytes32 nId = keccak256(abi.encode("n", nonceCounter));

        vm.prank(agent);
        lastPaymentId = vault.spend(merchant, amount, qId, keccak256("svc"), nId);
    }

    function actionRawInboundTransfer(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000e18);
        vm.prank(peerOwner);
        bool ok = token.transfer(address(vault), amount);
        require(ok);
    }

    function actionVerifiedInboundRevenue(uint96 rawAmount) external {
        uint256 rem = peerVault.spendableBalance();
        if (rem == 0) return;
        uint256 maxAllowed = rem > 500e18 ? 500e18 : rem;
        uint256 amount = bound(uint256(rawAmount), 1, maxAllowed);

        nonceCounter += 1;
        bytes32 qId = keccak256(abi.encode("pq", nonceCounter));
        bytes32 nId = keccak256(abi.encode("pn", nonceCounter));

        vm.prank(peerAgent);
        peerVault.spend(address(vault), amount, qId, keccak256("peer-svc"), nId);
    }

    function actionRefundLastPayment(uint96 rawAmount) external {
        if (lastPaymentId == bytes32(0)) return;
        (, uint256 paid, uint256 refunded,) = vault.payments(lastPaymentId);
        uint256 refundable = paid - refunded;
        if (refundable == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, refundable);

        vm.startPrank(merchant);
        token.approve(address(vault), amount);
        vault.refundPayment(lastPaymentId, amount);
        vm.stopPrank();
    }
}

contract AneAgentVaultInvariantTest is Test {
    AneTestToken internal token;
    AneVaultFactory internal factory;
    FixedBudgetHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new AneTestToken(address(this));
        factory = new AneVaultFactory(address(token));
        handler = new FixedBudgetHandler(token, factory);
        token.grantRole(token.MINTER_ROLE(), address(handler));
        handler.init();

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = FixedBudgetHandler.actionSpend.selector;
        selectors[1] = FixedBudgetHandler.actionRawInboundTransfer.selector;
        selectors[2] = FixedBudgetHandler.actionVerifiedInboundRevenue.selector;
        selectors[3] = FixedBudgetHandler.actionRefundLastPayment.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Core AGENTS.md & REQ-004 invariant: Under FIXED budget mode, cumulative net spend
    ///         and authorizedRemaining never exceed the owner-signed maxTotalSpend, regardless of incoming revenue.
    function invariant_FixedBudgetNeverExceedsMaxTotalSpend() public view {
        AneAgentVault v = handler.vault();
        assertLe(v.cumulativeSpent(), v.maxTotalSpend());
        assertEq(v.effectiveSpendCeiling(), handler.INITIAL_MAX_SPEND());
        assertLe(v.cumulativeSpent() + v.authorizedRemaining(), handler.INITIAL_MAX_SPEND());
    }
}
