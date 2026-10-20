// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneAgentVault} from "../src/AneAgentVault.sol";
import {AneVaultFactory} from "../src/AneVaultFactory.sol";

/// @notice The owner-signed vault actions a relayer submits so an owner never needs ETH (#77, ADR-0006):
/// setPolicyWithSig, revokeWithSig, and funding by an EIP-3009 transfer into the vault. The relayer here holds
/// no tANE and is never the owner, so these tests show who signs and who pays.
contract AneAgentVaultSignedActionsTest is Test {
    AneTestToken internal token;
    AneVaultFactory internal factory;
    AneAgentVault internal vault;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");
    uint256 internal ownerPk = 0xA11CE;
    address internal owner;
    uint256 internal agentPk = 0xB0B;
    address internal agent;

    function setUp() public {
        vm.warp(1_700_000_000);
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        token = new AneTestToken(admin);
        bytes32 minterRole = token.MINTER_ROLE();
        vm.startPrank(admin);
        token.grantRole(minterRole, admin);
        token.mint(owner, 10_000e18);
        vm.stopPrank();
        factory = new AneVaultFactory(address(token));
        // Anyone may create a vault for an owner; the relayer does it here.
        vm.prank(relayer);
        vault = AneAgentVault(factory.createVault(owner, bytes32("signed")));
    }

    function _policy() internal view returns (AneAgentVault.PolicyInput memory) {
        return AneAgentVault.PolicyInput({
            agentSigner: agent,
            maxTotalSpend: 320e18,
            maxPerTx: 64e18,
            dailyLimit: 0,
            expiry: uint64(block.timestamp + 7 days),
            budgetMode: AneAgentVault.BudgetMode.FIXED,
            revolvingTreasuryCeiling: 0
        });
    }

    function _signPolicy(
        uint256 pk,
        AneAgentVault target,
        AneAgentVault.PolicyInput memory p,
        uint64 version,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                target.SET_POLICY_TYPEHASH(),
                address(target),
                p.agentSigner,
                p.maxTotalSpend,
                p.maxPerTx,
                p.dailyLimit,
                p.expiry,
                uint8(p.budgetMode),
                p.revolvingTreasuryCeiling,
                version,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", target.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _signRevoke(uint256 pk, AneAgentVault target, uint64 version, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(target.REVOKE_TYPEHASH(), address(target), version, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", target.domainSeparator(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    // ---- setPolicyWithSig -------------------------------------------------------------------------------------

    function test_SetPolicyWithSig_SubmittedByRelayer() public {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);

        vm.prank(relayer);
        vault.setPolicyWithSig(p, version, deadline, sig);

        assertEq(vault.agentSigner(), agent);
        assertEq(vault.maxTotalSpend(), 320e18);
        assertEq(vault.policyVersion(), version + 1);
        assertTrue(vault.active());
    }

    function test_SetPolicyWithSig_ReplayRejectedByPolicyVersion() public {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);
        vm.prank(relayer);
        vault.setPolicyWithSig(p, version, deadline, sig);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.InvalidPolicyVersion.selector, version, version + 1));
        vault.setPolicyWithSig(p, version, deadline, sig);
    }

    function test_SetPolicyWithSig_RejectsNonOwnerSigner() public {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(agentPk, vault, p, version, deadline);
        vm.prank(relayer);
        vm.expectRevert(AneAgentVault.InvalidSignature.selector);
        vault.setPolicyWithSig(p, version, deadline, sig);
    }

    function test_SetPolicyWithSig_RejectsAlteredPolicy() public {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);
        p.maxTotalSpend = 10_000e18; // the relayer raises the cap the owner signed
        vm.prank(relayer);
        vm.expectRevert(AneAgentVault.InvalidSignature.selector);
        vault.setPolicyWithSig(p, version, deadline, sig);
    }

    function test_SetPolicyWithSig_RejectsExpiredDeadline() public {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);
        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.SignatureExpired.selector, deadline, deadline + 1));
        vault.setPolicyWithSig(p, version, deadline, sig);
    }

    function test_SetPolicyWithSig_BoundToOneVault() public {
        // Same owner, second vault: a signature for one vault must not apply to the other.
        vm.prank(relayer);
        AneAgentVault other = AneAgentVault(factory.createVault(owner, bytes32("other")));
        uint64 version = vault.policyVersion();
        assertEq(other.policyVersion(), version);
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);
        vm.prank(relayer);
        vm.expectRevert(AneAgentVault.InvalidSignature.selector);
        other.setPolicyWithSig(p, version, deadline, sig);
    }

    // ---- revokeWithSig ----------------------------------------------------------------------------------------

    function _delegate() internal {
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        AneAgentVault.PolicyInput memory p = _policy();
        bytes memory sig = _signPolicy(ownerPk, vault, p, version, deadline);
        vm.prank(relayer);
        vault.setPolicyWithSig(p, version, deadline, sig);
    }

    function test_RevokeWithSig_SubmittedByRelayer_AndNotReplayable() public {
        _delegate();
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signRevoke(ownerPk, vault, version, deadline);

        vm.prank(relayer);
        vault.revokeWithSig(version, deadline, sig);
        assertFalse(vault.active());
        assertEq(vault.policyVersion(), version + 1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.InvalidPolicyVersion.selector, version, version + 1));
        vault.revokeWithSig(version, deadline, sig);
    }

    function test_RevokeWithSig_RejectsNonOwnerSignerAndExpiredDeadline() public {
        _delegate();
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory agentSig = _signRevoke(agentPk, vault, version, deadline);
        vm.prank(relayer);
        vm.expectRevert(AneAgentVault.InvalidSignature.selector);
        vault.revokeWithSig(version, deadline, agentSig);

        bytes memory ownerSig = _signRevoke(ownerPk, vault, version, deadline);
        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.SignatureExpired.selector, deadline, deadline + 1));
        vault.revokeWithSig(version, deadline, ownerSig);
        assertTrue(vault.active());
    }

    function test_RevokeWithSig_StaleAfterAnyPolicyChange() public {
        // A revocation signed for one policy epoch can't be held back and used against a later one.
        _delegate();
        uint64 version = vault.policyVersion();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldRevoke = _signRevoke(ownerPk, vault, version, deadline);
        _delegate();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneAgentVault.InvalidPolicyVersion.selector, version, version + 1));
        vault.revokeWithSig(version, deadline, oldRevoke);
    }

    // ---- funding by an EIP-3009 transfer (fundWithPermit can't be relayed; see #77) ------------------------

    function test_FundingByRelayedTransferWithAuthorization() public {
        uint256 value = 1_600e18;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("fund-1");
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), owner, address(vault), value, 0, validBefore, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));

        assertEq(token.balanceOf(relayer), 0, "the relayer holds no tANE");
        vm.prank(relayer);
        token.transferWithAuthorization(owner, address(vault), value, 0, validBefore, nonce, abi.encodePacked(r, s, v));

        assertEq(token.balanceOf(owner), 10_000e18 - value, "the owner paid");
        assertEq(token.balanceOf(address(vault)), value, "the vault received it");
        assertEq(token.balanceOf(relayer), 0, "the relayer spent no tANE");

        // The agent can spend it once delegated; the deposit isn't counted as owner principal (the accepted gap).
        _delegate();
        assertEq(vault.spendableBalance(), 320e18);
        assertEq(vault.ownerPrincipalDeposited(), 0);
    }

    function test_FundWithPermit_CannotBeRelayed() public {
        // The finding on #77: fundWithPermit treats msg.sender as the permit owner, so a relayer can't use it.
        uint256 value = 100e18;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(permitTypehash, owner, address(vault), value, token.nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(relayer);
        vm.expectRevert();
        vault.fundWithPermit(value, deadline, v, r, s);
        assertEq(token.balanceOf(owner), 10_000e18);
    }
}
