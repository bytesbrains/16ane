// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneTaskEscrow} from "../src/AneTaskEscrow.sol";

/// @notice REQ-201 / ADR-0009 / ISS-021: escrow for asynchronous tasks, bounded by the vault's policy.
contract AneTaskEscrowTest is Test {
    AneTestToken internal token;
    AneVaultFactory internal factory;
    AneTaskEscrow internal escrow;
    AneAgentVault internal vault;

    address internal admin = makeAddr("admin");
    uint256 internal ownerPk = 0x1111;
    address internal owner;
    uint256 internal agentPk = 0x2222;
    address internal agent;
    uint256 internal sellerPk = 0x5555;
    address internal seller;
    address internal stranger = makeAddr("stranger");

    uint256 internal constant BUDGET = 320e18;
    uint256 internal constant PER_TX = 160e18;
    uint256 internal constant PRICE = 100e18;
    bytes32 internal constant SPEC = keccak256("translate 40 pages; task 1");

    function setUp() public {
        vm.warp(1_700_000_000);
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        seller = vm.addr(sellerPk);

        token = new AneTestToken(admin);
        bytes32 minterRole = token.MINTER_ROLE();
        vm.startPrank(admin);
        token.grantRole(minterRole, admin);
        token.mint(owner, 10_000e18);
        token.mint(stranger, 10_000e18);
        vm.stopPrank();

        factory = new AneVaultFactory(address(token));
        escrow = new AneTaskEscrow(address(token), address(factory));
        vault = AneAgentVault(factory.createVault(owner, bytes32("agent")));

        vm.startPrank(owner);
        token.approve(address(vault), 1_000e18);
        vault.fund(1_000e18);
        vault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: agent,
                maxTotalSpend: BUDGET,
                maxPerTx: PER_TX,
                dailyLimit: 0, // no daily limit, so the total budget is the limit these tests reach
                expiry: uint64(block.timestamp + 60 days),
                budgetMode: AneAgentVault.BudgetMode.FIXED,
                revolvingTreasuryCeiling: 0
            })
        );
        vm.stopPrank();
    }

    // ---- helpers ----

    function _intent(uint256 amount, address taskSeller, uint64 deadline, bytes32 spec, bytes32 nonce)
        internal
        view
        returns (AneAgentVault.SpendIntent memory intent, bytes memory sig)
    {
        intent = AneAgentVault.SpendIntent({
            vault: address(vault),
            merchant: address(escrow),
            amount: amount,
            quoteId: escrow.taskQuoteId(taskSeller, deadline, spec),
            serviceIdHash: keccak256("translation"),
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce,
            policyVersion: vault.policyVersion()
        });
        sig = _signIntent(agentPk, intent);
    }

    // Memory structs assign by reference in Solidity; tests that alter a field need a real copy.
    function _copy(AneAgentVault.SpendIntent memory i) internal pure returns (AneAgentVault.SpendIntent memory) {
        return AneAgentVault.SpendIntent(
            i.vault,
            i.merchant,
            i.amount,
            i.quoteId,
            i.serviceIdHash,
            i.validAfter,
            i.validBefore,
            i.nonce,
            i.policyVersion
        );
    }

    function _signIntent(uint256 pk, AneAgentVault.SpendIntent memory intent) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                vault.SPEND_INTENT_TYPEHASH(),
                intent.vault,
                intent.merchant,
                intent.amount,
                intent.quoteId,
                intent.serviceIdHash,
                intent.validAfter,
                intent.validBefore,
                intent.nonce,
                intent.policyVersion
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _receipt(uint256 pk, bytes32 taskId, uint256 cumulative, bytes32 deliveryHash)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.releaseDigest(taskId, cumulative, deliveryHash));
        return abi.encodePacked(r, s, v);
    }

    function _open(uint256 amount, uint64 deadline) internal returns (bytes32 taskId) {
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(amount, seller, deadline, SPEC, "n1");
        vm.prank(seller); // anyone may submit the agent's signed lock; here the seller does
        taskId = escrow.openTask(intent, sig, seller, deadline, SPEC);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 3 days);
    }

    // ---- locking ----

    function test_OpenLocksWithinPolicyBudget() public {
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);

        assertEq(token.balanceOf(address(escrow)), PRICE);
        assertEq(vault.cumulativeSpent(), PRICE);
        assertEq(vault.authorizedRemaining(), BUDGET - PRICE);

        AneTaskEscrow.Task memory t = escrow.getTask(taskId);
        assertEq(t.vault, address(vault));
        assertEq(t.seller, seller);
        assertEq(t.amount, PRICE);
        assertEq(t.released, 0);
        assertEq(t.deadline, deadline);
        assertEq(t.specHash, SPEC);
        assertFalse(t.closed);

        (address merchant, uint256 paid,,) = vault.payments(taskId);
        assertEq(merchant, address(escrow));
        assertEq(paid, PRICE);
    }

    function test_OpenCannotExceedVaultPolicy() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PER_TX + 1, seller, deadline, SPEC, "n1");
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsPerTxLimit.selector, PER_TX + 1, PER_TX));
        escrow.openTask(intent, sig, seller, deadline, SPEC);

        // Two locks of 160 use the whole 320 budget; a third is refused by the vault, not by the escrow.
        (intent, sig) = _intent(PER_TX, seller, deadline, keccak256("a"), "n2");
        escrow.openTask(intent, sig, seller, deadline, keccak256("a"));
        (intent, sig) = _intent(PER_TX, seller, deadline, keccak256("b"), "n3");
        escrow.openTask(intent, sig, seller, deadline, keccak256("b"));
        (intent, sig) = _intent(1e18, seller, deadline, keccak256("c"), "n4");
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsAuthorizedBudget.selector, 1e18, 0));
        escrow.openTask(intent, sig, seller, deadline, keccak256("c"));
    }

    function test_OpenRejectsTermsTheAgentDidNotSign() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, deadline, SPEC, "n1");

        vm.expectPartialRevert(AneTaskEscrow.TermsMismatch.selector);
        escrow.openTask(intent, sig, stranger, deadline, SPEC); // a different seller
        vm.expectPartialRevert(AneTaskEscrow.TermsMismatch.selector);
        escrow.openTask(intent, sig, seller, deadline + 30 days, SPEC); // a later deadline
        vm.expectPartialRevert(AneTaskEscrow.TermsMismatch.selector);
        escrow.openTask(intent, sig, seller, deadline, keccak256("other job"));
    }

    function test_OpenRejectsWrongMerchantUnregisteredVaultAndBadSeller() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, deadline, SPEC, "n1");

        AneAgentVault.SpendIntent memory direct = _copy(intent);
        direct.merchant = seller;
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.WrongMerchant.selector, address(escrow), seller));
        escrow.openTask(direct, sig, seller, deadline, SPEC);

        AneAgentVault.SpendIntent memory fake = _copy(intent);
        fake.vault = stranger;
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.UnregisteredVault.selector, stranger));
        escrow.openTask(fake, sig, seller, deadline, SPEC);

        for (uint256 i; i < 3; i++) {
            address bad = i == 0 ? address(0) : i == 1 ? address(escrow) : address(vault);
            (intent, sig) = _intent(PRICE, bad, deadline, SPEC, "n1");
            vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.InvalidSeller.selector, bad));
            escrow.openTask(intent, sig, bad, deadline, SPEC);
        }
    }

    function test_DeadlineMustBeInTheFutureAndAtMostThirtyDaysAway() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64[2] memory bad = [nowTs, nowTs + 30 days + 1];
        for (uint256 i; i < bad.length; i++) {
            (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, bad[i], SPEC, "n1");
            vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.InvalidDeadline.selector, bad[i], nowTs));
            escrow.openTask(intent, sig, seller, bad[i], SPEC);
        }
        (AneAgentVault.SpendIntent memory ok, bytes memory okSig) = _intent(PRICE, seller, nowTs + 30 days, SPEC, "n1");
        escrow.openTask(ok, okSig, seller, nowTs + 30 days, SPEC);
    }

    function test_SameTaskCannotBeOpenedTwice() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, deadline, SPEC, "n1");
        bytes32 taskId = escrow.openTask(intent, sig, seller, deadline, SPEC);
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.TaskAlreadyOpen.selector, taskId));
        escrow.openTask(intent, sig, seller, deadline, SPEC);
    }

    // ---- releasing ----

    function test_AgentReceiptsReleaseMilestonesIdempotently() public {
        bytes32 taskId = _open(PRICE, _deadline());

        // Milestone 1: 40 of 100. Anyone (here a stranger, as a relayer) may submit the buyer's receipt.
        bytes memory r1 = _receipt(agentPk, taskId, 40e18, keccak256("chapter 1"));
        vm.prank(stranger);
        escrow.release(taskId, 40e18, keccak256("chapter 1"), r1);
        assertEq(token.balanceOf(seller), 40e18);

        // Replaying milestone 1 pays nothing more.
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.InvalidReleaseAmount.selector, 40e18, 40e18, PRICE));
        escrow.release(taskId, 40e18, keccak256("chapter 1"), r1);

        // Milestone 2 supersedes it: cumulative 100 pays the other 60 and closes the task.
        escrow.release(
            taskId, PRICE, keccak256("all chapters"), _receipt(agentPk, taskId, PRICE, keccak256("all chapters"))
        );
        assertEq(token.balanceOf(seller), PRICE);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertTrue(escrow.getTask(taskId).closed);
        // A delivered task stays spent: the budget is not restored.
        assertEq(vault.cumulativeSpent(), PRICE);
    }

    function test_ReleaseCannotExceedTheLock() public {
        bytes32 taskId = _open(PRICE, _deadline());
        bytes memory r = _receipt(agentPk, taskId, PRICE + 1, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.InvalidReleaseAmount.selector, PRICE + 1, 0, PRICE));
        escrow.release(taskId, PRICE + 1, bytes32(0), r);
    }

    function test_OwnerReleasesDirectlyOrBySignature() public {
        bytes32 taskId = _open(PRICE, _deadline());
        vm.prank(owner);
        escrow.release(taskId, 10e18, keccak256("d"), "");
        escrow.release(taskId, 30e18, keccak256("d2"), _receipt(ownerPk, taskId, 30e18, keccak256("d2")));
        assertEq(token.balanceOf(seller), 30e18);
    }

    function test_OnlyTheBuyerSideCanRelease() public {
        bytes32 taskId = _open(PRICE, _deadline());

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.UnauthorizedApprover.selector, seller));
        escrow.release(taskId, PRICE, bytes32(0), "");

        bytes memory forged = _receipt(sellerPk, taskId, PRICE, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.UnauthorizedApprover.selector, seller));
        escrow.release(taskId, PRICE, bytes32(0), forged);

        // A receipt for one amount cannot be replayed for another.
        bytes memory forTen = _receipt(agentPk, taskId, 10e18, bytes32(0));
        vm.expectPartialRevert(AneTaskEscrow.UnauthorizedApprover.selector);
        escrow.release(taskId, PRICE, bytes32(0), forTen);
    }

    function test_RevokingTheAgentVoidsItsReceipts() public {
        bytes32 taskId = _open(PRICE, _deadline());
        bytes memory agentReceipt = _receipt(agentPk, taskId, PRICE, bytes32(0));

        vm.prank(owner);
        vault.revoke();
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.UnauthorizedApprover.selector, agent));
        escrow.release(taskId, PRICE, bytes32(0), agentReceipt);

        // The owner can still accept delivery.
        escrow.release(taskId, PRICE, bytes32(0), _receipt(ownerPk, taskId, PRICE, bytes32(0)));
        assertEq(token.balanceOf(seller), PRICE);
    }

    function test_NoReleaseAfterTheDeadline() public {
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);
        bytes memory r = _receipt(agentPk, taskId, PRICE, bytes32(0));
        escrow.release(taskId, 1e18, bytes32(0), _receipt(agentPk, taskId, 1e18, bytes32(0))); // on time: fine
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.DeadlinePassed.selector, deadline, deadline + 1));
        escrow.release(taskId, PRICE, bytes32(0), r);
    }

    // ---- returning ----

    function test_BuyerCannotReclaimBeforeTheDeadline() public {
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);
        vm.warp(deadline);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.DeadlineNotReached.selector, deadline, deadline));
        escrow.reclaim(taskId);
    }

    function test_ReclaimAfterDeadlineReturnsTheRestAndRestoresBudget() public {
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);
        escrow.release(taskId, 40e18, bytes32(0), _receipt(agentPk, taskId, 40e18, bytes32(0)));
        uint256 vaultBefore = token.balanceOf(address(vault));

        vm.warp(deadline + 1);
        vm.prank(stranger); // permissionless: the funds can only go back to the vault
        escrow.reclaim(taskId);

        assertEq(token.balanceOf(address(vault)), vaultBefore + 60e18);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(vault.cumulativeSpent(), 40e18, "only the released 40 stays spent");
        (,, uint256 refunded,) = vault.payments(taskId);
        assertEq(refunded, 60e18);
        assertTrue(escrow.getTask(taskId).closed);

        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.TaskClosed.selector, taskId));
        escrow.reclaim(taskId);
    }

    function test_SellerCanCancelAnyTimeAndOnlyTheSeller() public {
        bytes32 taskId = _open(PRICE, _deadline());
        escrow.release(taskId, 25e18, bytes32(0), _receipt(agentPk, taskId, 25e18, bytes32(0)));

        vm.prank(owner);
        vm.expectRevert(AneTaskEscrow.OnlySeller.selector);
        escrow.cancel(taskId);

        vm.prank(seller);
        escrow.cancel(taskId);
        assertEq(vault.cumulativeSpent(), 25e18);
        assertEq(token.balanceOf(seller), 25e18);

        bytes memory r = _receipt(agentPk, taskId, PRICE, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.TaskClosed.selector, taskId));
        escrow.release(taskId, PRICE, bytes32(0), r);
    }

    // ---- griefing ----

    /// Someone settles the agent's signed lock on the vault directly, skipping the escrow. The funds arrive
    /// unrecorded; opening the task adopts the vault's payment record, so they are never stranded.
    function test_DirectSettlementIsAdoptedNotStranded() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, deadline, SPEC, "n1");
        vm.prank(stranger);
        bytes32 paymentId = vault.settlePayment(intent, sig);
        assertEq(token.balanceOf(address(escrow)), PRICE);

        // A forged amount on the same quoteId and nonce does not match the vault's record.
        AneAgentVault.SpendIntent memory inflated = _copy(intent);
        inflated.amount = PRICE * 2;
        vm.expectRevert(abi.encodeWithSelector(AneTaskEscrow.LockMismatch.selector, PRICE * 2, PRICE));
        escrow.openTask(inflated, sig, seller, deadline, SPEC);

        bytes32 taskId = escrow.openTask(intent, sig, seller, deadline, SPEC);
        assertEq(taskId, paymentId);
        assertEq(vault.cumulativeSpent(), PRICE, "adopted, not charged twice");

        vm.warp(deadline + 1);
        escrow.reclaim(taskId);
        assertEq(vault.cumulativeSpent(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    /// An adopted task keeps the deadline the agent signed, even if it has passed by the time it is opened.
    function test_AdoptionAfterTheDeadlineIsImmediatelyReclaimable() public {
        uint64 deadline = _deadline();
        (AneAgentVault.SpendIntent memory intent, bytes memory sig) = _intent(PRICE, seller, deadline, SPEC, "n1");
        vault.settlePayment(intent, sig);
        vm.warp(deadline + 1 days);
        bytes32 taskId = escrow.openTask(intent, sig, seller, deadline, SPEC);
        escrow.reclaim(taskId);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    /// Anyone can refund a vault payment with their own tokens. A third party who refunds the task's
    /// payment first must not make the escrow's own return revert and lock the remainder in.
    function test_ThirdPartyRefundCannotStrandTheRemainder() public {
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);
        vm.startPrank(stranger);
        token.approve(address(vault), 70e18);
        vault.refundPayment(taskId, 70e18);
        vm.stopPrank();
        uint256 vaultBefore = token.balanceOf(address(vault));

        vm.warp(deadline + 1);
        escrow.reclaim(taskId);
        assertEq(token.balanceOf(address(vault)), vaultBefore + PRICE);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(vault.cumulativeSpent(), 0);
    }

    /// Whatever the milestones, the seller's payouts plus the vault's return equal the lock exactly.
    function testFuzz_FundsAreConserved(uint256 m1, uint256 m2, bool sellerCancels) public {
        m1 = bound(m1, 0, PRICE);
        m2 = bound(m2, m1, PRICE);
        uint64 deadline = _deadline();
        bytes32 taskId = _open(PRICE, deadline);
        uint256 vaultBefore = token.balanceOf(address(vault));

        if (m1 > 0) escrow.release(taskId, m1, bytes32(0), _receipt(agentPk, taskId, m1, bytes32(0)));
        if (m2 > m1) escrow.release(taskId, m2, bytes32(0), _receipt(agentPk, taskId, m2, bytes32(0)));
        if (m2 < PRICE) {
            if (sellerCancels) {
                vm.prank(seller);
                escrow.cancel(taskId);
            } else {
                vm.warp(deadline + 1);
                escrow.reclaim(taskId);
            }
        }

        assertEq(token.balanceOf(seller), m2);
        assertEq(token.balanceOf(address(vault)) - vaultBefore, PRICE - m2);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(vault.cumulativeSpent(), m2);
    }
}
