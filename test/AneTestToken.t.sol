// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";

contract AneTestTokenTest is Test {
    AneTestToken internal token;

    uint256 internal adminPk = 0xA11CE;
    address internal admin;

    uint256 internal minterPk = 0xB0B;
    address internal minter;

    uint256 internal alicePk = 0xCA11;
    address internal alice;

    uint256 internal bobPk = 0xD00D;
    address internal bob;

    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        admin = vm.addr(adminPk);
        minter = vm.addr(minterPk);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);

        token = new AneTestToken(admin);

        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(admin);
        token.grantRole(minterRole, minter);
    }

    function test_MetadataAndNoValueDisclosures() public view {
        assertEq(token.name(), "16ane Sandbox (NO CASH VALUE)");
        assertEq(token.symbol(), "tANE");
        assertEq(token.decimals(), 18);
        assertTrue(token.isTestToken());
        assertEq(token.ILLUSTRATIVE_ANNAS_PER_RUPEE(), 16);
        assertGt(bytes(token.DISCLAIMER()).length, 20);
    }

    function test_MintRoleRestriction() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1_600e18);

        vm.prank(minter);
        token.mint(alice, 1_600e18);
        assertEq(token.balanceOf(alice), 1_600e18);
    }

    function test_PermissionlessTransfersAndBurns() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        // Anyone can transfer tANE without hosted approval (REQ-001)
        vm.prank(alice);
        token.transfer(bob, 16e18);
        assertEq(token.balanceOf(bob), 16e18);
        assertEq(token.balanceOf(alice), 1_584e18);

        vm.prank(bob);
        token.burn(6e18);
        assertEq(token.balanceOf(bob), 10e18);
    }

    function test_EIP2612Permit() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        uint256 value = 320e18;
        uint256 nonce = token.nonces(alice);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, alice, bob, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        token.permit(alice, bob, value, deadline, v, r, s);
        assertEq(token.allowance(alice, bob), value);

        vm.prank(bob);
        token.transferFrom(alice, bob, 160e18);
        assertEq(token.balanceOf(bob), 160e18);
    }

    function test_EIP3009TransferWithAuthorizationVRS() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        uint256 value = 16e18;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce1 = keccak256("x402-quote-001");

        bytes32 structHash1 = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, value, validAfter, validBefore, nonce1)
        );
        bytes32 digest1 = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest1);

        token.transferWithAuthorization(alice, bob, value, validAfter, validBefore, nonce1, v, r, s);
        assertTrue(token.authorizationState(alice, nonce1));
        assertEq(token.balanceOf(bob), 16e18);

        // Replay with same nonce must revert (Threat Model Test #3)
        vm.expectRevert(abi.encodeWithSelector(IERC3009.AuthorizationAlreadyUsed.selector, alice, nonce1));
        token.transferWithAuthorization(alice, bob, value, validAfter, validBefore, nonce1, v, r, s);
    }

    function test_EIP3009TransferWithAuthorizationBytesOverload() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        uint256 value = 16e18;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce2 = keccak256("x402-quote-002");

        bytes32 structHash2 = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, value, validAfter, validBefore, nonce2)
        );
        bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash2));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(alicePk, digest2);
        bytes memory sig2 = abi.encodePacked(r2, s2, v2);

        token.transferWithAuthorization(alice, bob, value, validAfter, validBefore, nonce2, sig2);
        assertTrue(token.authorizationState(alice, nonce2));
        assertEq(token.balanceOf(bob), 16e18);
    }

    function test_EIP3009ReceiveWithAuthorizationRequiresPayeeCaller() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        uint256 value = 16e18;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("receive-auth-001");

        bytes32 structHash = keccak256(
            abi.encode(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        // Third-party front-runner cannot call receiveWithAuthorization
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IERC3009.CallerMustBePayee.selector, admin, bob));
        token.receiveWithAuthorization(alice, bob, value, validAfter, validBefore, nonce, v, r, s);

        // Payee (bob) succeeds
        vm.prank(bob);
        token.receiveWithAuthorization(alice, bob, value, validAfter, validBefore, nonce, v, r, s);
        assertEq(token.balanceOf(bob), 16e18);
    }

    function test_EIP3009CancelAuthorization() public {
        vm.prank(minter);
        token.mint(alice, 1_600e18);

        bytes32 nonce = keccak256("cancel-me");
        {
            bytes32 cancelStruct = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce));
            bytes32 cancelDigest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), cancelStruct));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, cancelDigest);
            token.cancelAuthorization(alice, nonce, v, r, s);
        }
        assertTrue(token.authorizationState(alice, nonce));

        // Subsequent transferWithAuthorization using canceled nonce must revert
        bytes32 txStruct = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                alice,
                bob,
                16e18,
                block.timestamp - 1,
                block.timestamp + 1 hours,
                nonce
            )
        );
        bytes32 txDigest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), txStruct));
        (uint8 tv, bytes32 tr, bytes32 ts) = vm.sign(alicePk, txDigest);
        bytes memory sig = abi.encodePacked(tr, ts, tv);

        vm.expectRevert(abi.encodeWithSelector(IERC3009.AuthorizationAlreadyUsed.selector, alice, nonce));
        token.transferWithAuthorization(alice, bob, 16e18, block.timestamp - 1, block.timestamp + 1 hours, nonce, sig);
    }

    function testFuzz_TransferWithAuthorizationRandomNonces(uint96 rawAmount, bytes32 nonce) public {
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e18);
        vm.prank(minter);
        token.mint(alice, amount);

        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, amount, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        token.transferWithAuthorization(alice, bob, amount, validAfter, validBefore, nonce, v, r, s);
        assertEq(token.balanceOf(bob), amount);
        assertEq(token.balanceOf(alice), 0);
        assertTrue(token.authorizationState(alice, nonce));
    }
}
