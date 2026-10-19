// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";
import {AneServiceDirectory} from "../src/AneServiceDirectory.sol";

contract AneAgentVaultTest is Test {
    AneTestToken internal token;
    AneVaultFactory internal factory;
    AneServiceDirectory internal directory;

    address internal admin = makeAddr("admin");

    uint256 internal ownerAPk = 0x1111;
    address internal ownerA;
    uint256 internal agentAPk = 0x2222;
    address internal agentA;
    AneAgentVault internal vaultA;

    uint256 internal ownerBPk = 0x3333;
    address internal ownerB;
    uint256 internal agentBPk = 0x4444;
    address internal agentB;
    AneAgentVault internal vaultB;

    address internal merchantEOA = makeAddr("merchantEOA");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(1_700_000_000);
        ownerA = vm.addr(ownerAPk);
        agentA = vm.addr(agentAPk);
        ownerB = vm.addr(ownerBPk);
        agentB = vm.addr(agentBPk);

        token = new AneTestToken(admin);
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(admin);
        token.grantRole(minterRole, admin);

        factory = new AneVaultFactory(address(token));
        directory = new AneServiceDirectory();

        vaultA = AneAgentVault(factory.createVault(ownerA, bytes32("agent-a")));
        vaultB = AneAgentVault(factory.createVault(ownerB, bytes32("agent-b")));

        vm.startPrank(admin);
        token.mint(ownerA, 10_000e18);
        token.mint(ownerB, 10_000e18);
        vm.stopPrank();
    }

    function _fundAndDelegateFixed(
        AneAgentVault vault,
        address vaultOwner,
        address signer,
        uint256 fundAmount,
        uint256 maxTotal,
        uint256 maxPerTx,
        uint256 dailyLimit
    ) internal {
        vm.startPrank(vaultOwner);
        token.approve(address(vault), fundAmount);
        vault.fund(fundAmount);
        vault.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: signer,
                maxTotalSpend: maxTotal,
                maxPerTx: maxPerTx,
                dailyLimit: dailyLimit,
                expiry: uint64(block.timestamp + 7 days),
                budgetMode: AneAgentVault.BudgetMode.FIXED,
                revolvingTreasuryCeiling: 0
            })
        );
        vm.stopPrank();
    }

    function _signSpendIntent(uint256 signerPk, AneAgentVault.SpendIntent memory intent)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                AneAgentVault(intent.vault).SPEND_INTENT_TYPEHASH(),
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
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", AneAgentVault(intent.vault).domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice REQ-003: Owner cannot delegate to their own root key, ensuring key isolation.
    function test_Security_ActorIsolation_OwnerKeyCannotBeAgentSigner() public {
        vm.startPrank(ownerA);
        vm.expectRevert(AneAgentVault.SignerCannotBeOwner.selector);
        vaultA.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: ownerA,
                maxTotalSpend: 320e18,
                maxPerTx: 160e18,
                dailyLimit: 320e18,
                expiry: uint64(block.timestamp + 1 days),
                budgetMode: AneAgentVault.BudgetMode.FIXED,
                revolvingTreasuryCeiling: 0
            })
        );
        vm.stopPrank();
    }

    /// @notice Threat Model Test #1: Agent overspends exact budget by 1 base unit -> revert.
    function test_Security1_OverspendByOneUnitReverts() public {
        _fundAndDelegateFixed(vaultA, ownerA, agentA, 1_600e18, 320e18, 0, 0);

        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsAuthorizedBudget.selector, 320e18 + 1, 320e18));
        vaultA.spend(merchantEOA, 320e18 + 1, keccak256("q1"), keccak256("svc1"), keccak256("n1"));

        // Exact cap succeeds
        vm.prank(agentA);
        vaultA.spend(merchantEOA, 320e18, keccak256("q1"), keccak256("svc1"), keccak256("n1"));
        assertEq(vaultA.authorizedRemaining(), 0);

        // 1 wei more reverts
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsAuthorizedBudget.selector, 1, 0));
        vaultA.spend(merchantEOA, 1, keccak256("q2"), keccak256("svc1"), keccak256("n2"));
    }

    /// @notice Threat Model Test #2: Two concurrent spends exceed cumulative cap -> at most one succeeds.
    function test_Security2_ConcurrentSpendsExceedingCapOnlyOneSucceeds() public {
        _fundAndDelegateFixed(vaultA, ownerA, agentA, 1_600e18, 320e18, 200e18, 0);

        AneAgentVault.SpendIntent memory intent1 = AneAgentVault.SpendIntent({
            vault: address(vaultA),
            merchant: merchantEOA,
            amount: 200e18,
            quoteId: keccak256("q-concurrent-1"),
            serviceIdHash: keccak256("svc"),
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("nonce-c1"),
            policyVersion: vaultA.policyVersion()
        });
        bytes memory sig1 = _signSpendIntent(agentAPk, intent1);

        AneAgentVault.SpendIntent memory intent2 = AneAgentVault.SpendIntent({
            vault: address(vaultA),
            merchant: merchantEOA,
            amount: 200e18,
            quoteId: keccak256("q-concurrent-2"),
            serviceIdHash: keccak256("svc"),
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("nonce-c2"),
            policyVersion: vaultA.policyVersion()
        });
        bytes memory sig2 = _signSpendIntent(agentAPk, intent2);

        vm.prank(relayer);
        vaultA.settlePayment(intent1, sig1);
        assertEq(vaultA.cumulativeSpent(), 200e18);
        assertEq(vaultA.authorizedRemaining(), 120e18);

        // Second concurrent intent for 200 tANE must revert because only 120 tANE remains
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.ExceedsAuthorizedBudget.selector, 200e18, 120e18));
        vaultA.settlePayment(intent2, sig2);
    }

    /// @notice Threat Model Test #3 & #4: Replay, wrong recipient/vault/expiry/policyVersion -> reject.
    function test_Security3And4_ReplayAndInvalidParametersRevert() public {
        _fundAndDelegateFixed(vaultA, ownerA, agentA, 1_600e18, 320e18, 160e18, 0);

        AneAgentVault.SpendIntent memory intent = AneAgentVault.SpendIntent({
            vault: address(vaultA),
            merchant: merchantEOA,
            amount: 16e18,
            quoteId: keccak256("q-valid"),
            serviceIdHash: keccak256("demo.summarize.v1"),
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("nonce-valid"),
            policyVersion: vaultA.policyVersion()
        });
        bytes memory sig = _signSpendIntent(agentAPk, intent);

        // Settle once -> succeeds
        vaultA.settlePayment(intent, sig);

        // Replay exact same intent -> reverts with NonceAlreadyUsed
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.NonceAlreadyUsed.selector, intent.nonce));
        vaultA.settlePayment(intent, sig);

        // Different nonce but same quoteId -> reverts with QuoteAlreadySettled
        AneAgentVault.SpendIntent memory dupQuote = intent;
        dupQuote.nonce = keccak256("nonce-2");
        bytes memory dupQuoteSig = _signSpendIntent(agentAPk, dupQuote);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.QuoteAlreadySettled.selector, intent.quoteId));
        vaultA.settlePayment(dupQuote, dupQuoteSig);

        // Tampered merchant address -> signature recovery fails
        AneAgentVault.SpendIntent memory tampered = intent;
        tampered.nonce = keccak256("nonce-3");
        tampered.quoteId = keccak256("q-3");
        tampered.merchant = makeAddr("attacker");
        vm.expectRevert(AneAgentVault.InvalidSignature.selector);
        vaultA.settlePayment(tampered, sig);

        // Expired intent -> reverts with IntentExpired
        AneAgentVault.SpendIntent memory expiredIntent = intent;
        expiredIntent.nonce = keccak256("nonce-4");
        expiredIntent.quoteId = keccak256("q-4");
        expiredIntent.validBefore = block.timestamp;
        bytes memory expSig = _signSpendIntent(agentAPk, expiredIntent);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.IntentExpired.selector, block.timestamp, block.timestamp));
        vaultA.settlePayment(expiredIntent, expSig);
    }

    /// @notice Threat Model Test #5 & #6 + REQUIREMENTS.md Acceptance Journey (S1 & S2).
    function test_Security5And6_FullAcceptanceJourney_FixedModeRevenueIsolationAndRevoke() public {
        // Given ownerA funds vaultA with 1,600 tANE and delegates max total of 320 tANE (FIXED mode)
        _fundAndDelegateFixed(vaultA, ownerA, agentA, 1_600e18, 320e18, 160e18, 320e18);
        // And ownerB funds vaultB with 1,600 tANE and delegates 320 tANE
        _fundAndDelegateFixed(vaultB, ownerB, agentB, 1_600e18, 320e18, 160e18, 320e18);

        // 1. Agent A pays 16 tANE for a demo endpoint
        AneAgentVault.SpendIntent memory buyIntent = AneAgentVault.SpendIntent({
            vault: address(vaultA),
            merchant: merchantEOA,
            amount: 16e18,
            quoteId: keccak256("q_demo_001"),
            serviceIdHash: keccak256("demo.summarize.v1"),
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("n_buy_1"),
            policyVersion: vaultA.policyVersion()
        });
        bytes memory buySig = _signSpendIntent(agentAPk, buyIntent);
        vaultA.settlePayment(buyIntent, buySig);

        assertEq(vaultA.cumulativeSpent(), 16e18);
        assertEq(vaultA.authorizedRemaining(), 304e18);

        // 2. Agent B buys a 32 tANE data-cleaning service from Agent A (vaultA is merchant)
        vm.prank(agentB);
        vaultB.spend(address(vaultA), 32e18, keccak256("q_clean_001"), keccak256("agentA.clean.v1"), keccak256("n_b1"));

        // 3. Also simulate an unsolicited raw 100 tANE wash transfer to vaultA
        vm.prank(ownerB);
        token.transfer(address(vaultA), 100e18);

        // 4. Verify Threat Model Test #6 & AGENTS.md invariant:
        // Under FIXED mode, incoming revenue (32 tANE verified + 100 tANE raw) NEVER increases spend authority!
        AneAgentVault.AccountingSummary memory sum = vaultA.getAccountingSummary();
        assertEq(sum.tokenBalance, 1_600e18 - 16e18 + 32e18 + 100e18); // 1,716 tANE total in vault
        assertEq(sum.verifiedRevenue, 32e18);
        assertEq(sum.cumulativeSpent, 16e18);
        assertEq(sum.authorizedRemaining, 304e18); // Strictly 320 - 16 = 304 tANE!
        assertEq(sum.spendableNow, 304e18);

        // 5. Threat Model Test #5: Pre-signed intent invalidated immediately when owner revokes
        AneAgentVault.SpendIntent memory preSigned = AneAgentVault.SpendIntent({
            vault: address(vaultA),
            merchant: merchantEOA,
            amount: 16e18,
            quoteId: keccak256("q_after_revoke"),
            serviceIdHash: keccak256("demo.summarize.v1"),
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: keccak256("n_pre_revoke"),
            policyVersion: vaultA.policyVersion()
        });
        bytes memory preSignedSig = _signSpendIntent(agentAPk, preSigned);

        vm.prank(ownerA);
        uint256 swept = vaultA.revokeAndSweep(ownerA);
        assertEq(swept, 1_716e18);
        assertFalse(vaultA.active());
        assertEq(vaultA.authorizedRemaining(), 0);

        // Attempting to submit pre-signed intent after revoke reverts with InvalidPolicyVersion
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.InvalidPolicyVersion.selector, 2, 1));
        vaultA.settlePayment(preSigned, preSignedSig);
    }

    /// @notice REQ-107 & ADR-0004: Revolving mode recycles verified revenue up to ceiling, ignoring raw transfers.
    function test_RevolvingBudgetModeAndWashTransferResistance() public {
        vm.startPrank(ownerA);
        token.approve(address(vaultA), 500e18);
        vaultA.fund(500e18);
        vaultA.setPolicy(
            AneAgentVault.PolicyInput({
                agentSigner: agentA,
                maxTotalSpend: 100e18,
                maxPerTx: 100e18,
                dailyLimit: 250e18,
                expiry: uint64(block.timestamp + 7 days),
                budgetMode: AneAgentVault.BudgetMode.REVOLVING,
                revolvingTreasuryCeiling: 150e18
            })
        );
        vm.stopPrank();

        _fundAndDelegateFixed(vaultB, ownerB, agentB, 1_600e18, 500e18, 200e18, 500e18);

        // Spend 80 tANE -> 20 tANE remaining from initial 100 tANE base allowance
        vm.prank(agentA);
        vaultA.spend(merchantEOA, 80e18, keccak256("q1"), keccak256("s1"), keccak256("n1"));
        assertEq(vaultA.authorizedRemaining(), 20e18);

        // Unverified raw ERC-20 transfer of 1,000 tANE does NOT increase verifiedRevenue or authorizedRemaining!
        vm.prank(ownerB);
        token.transfer(address(vaultA), 1_000e18);
        assertEq(vaultA.verifiedRevenue(), 0);
        assertEq(vaultA.authorizedRemaining(), 20e18);

        // Verified service payment of 60 tANE from vaultB expands cap to min(100 + 60, 80 + 150) = 160 -> 80 remaining
        vm.prank(agentB);
        vaultB.spend(address(vaultA), 60e18, keccak256("qb1"), keccak256("sa1"), keccak256("nb1"));
        assertEq(vaultA.verifiedRevenue(), 60e18);
        assertEq(vaultA.authorizedRemaining(), 80e18);

        // Large verified payment of 300 tANE from vaultB is capped by revolvingTreasuryCeiling (150 tANE remaining max)
        vm.prank(agentB);
        vaultB.spend(address(vaultA), 200e18, keccak256("qb2"), keccak256("sa1"), keccak256("nb2"));
        assertEq(vaultA.authorizedRemaining(), 150e18);
    }

    /// @notice REQ-008 & ADR-0009 (Scenario S4): Verifiable merchant refund restores failed-call budget safely.
    function test_RefundRestoresBudgetUpToOriginalPaymentOnly() public {
        _fundAndDelegateFixed(vaultA, ownerA, agentA, 1_600e18, 160e18, 160e18, 160e18);

        vm.prank(agentA);
        bytes32 paymentId =
            vaultA.spend(merchantEOA, 32e18, keccak256("q_refund_1"), keccak256("svc"), keccak256("n_ref_1"));
        assertEq(vaultA.cumulativeSpent(), 32e18);
        assertEq(vaultA.authorizedRemaining(), 128e18);

        // Merchant cannot refund more than 32 tANE
        vm.startPrank(merchantEOA);
        token.approve(address(vaultA), 100e18);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.InvalidRefundAmount.selector, 33e18, 32e18));
        vaultA.refundPayment(paymentId, 33e18);

        // Merchant refunds full 32 tANE
        vaultA.refundPayment(paymentId, 32e18);
        vm.stopPrank();

        assertEq(vaultA.cumulativeSpent(), 0);
        assertEq(vaultA.authorizedRemaining(), 160e18);
        assertEq(token.balanceOf(address(vaultA)), 1_600e18);
    }

    /// @notice Tests AneServiceDirectory anchoring and lifecycle updates (REQ-101, ADR-0007).
    function test_ServiceDirectoryAnchoring() public {
        bytes32 serviceIdHash = keccak256("demo.summarize.v1");
        bytes32 manifestHash = keccak256('{"service_id":"demo.summarize.v1"}');
        uint64 exp = uint64(block.timestamp + 30 days);

        vm.prank(merchantEOA);
        directory.anchorService(
            serviceIdHash,
            "https://demo.16ane.com/.well-known/16ane-service.json",
            manifestHash,
            exp,
            AneServiceDirectory.ServiceStatus.ACTIVE
        );

        AneServiceDirectory.ServiceAnchor memory anchor = directory.getService(serviceIdHash);
        assertEq(anchor.provider, merchantEOA);
        assertEq(anchor.manifestHash, manifestHash);
        assertEq(uint8(anchor.status), uint8(AneServiceDirectory.ServiceStatus.ACTIVE));

        // Another user cannot hijack merchantEOA's serviceIdHash
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(AneServiceDirectory.NotServiceProvider.selector, serviceIdHash, ownerA, merchantEOA)
        );
        directory.setServiceStatus(serviceIdHash, AneServiceDirectory.ServiceStatus.PAUSED);
    }
}
