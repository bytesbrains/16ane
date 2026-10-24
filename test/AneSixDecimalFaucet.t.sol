// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneFaucet} from "../src/AneFaucet.sol";
import {AneFaucetBase} from "../src/AneFaucetBase.sol";
import {AneSixDecimalFaucet} from "../src/AneSixDecimalFaucet.sol";
import {AneSixDecimalTestToken} from "../src/AneSixDecimalTestToken.sol";
import {AneTestToken} from "../src/AneTestToken.sol";

/// The tSIX faucet shares AneFaucetBase with the tANE faucet (ADR-0021). These tests pin what must differ: its
/// token, its disclaimer and its EIP-712 domain, so a relayed claim signed for one faucet never works on the other.
contract AneSixDecimalFaucetTest is Test {
    AneSixDecimalTestToken internal six;
    AneSixDecimalFaucet internal sixFaucet;
    AneTestToken internal tane;
    AneFaucet internal taneFaucet;

    address internal admin = makeAddr("admin");
    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal relayer = makeAddr("relayer");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        vm.warp(1_700_000_000);
        user = vm.addr(userPk);

        six = new AneSixDecimalTestToken(admin);
        sixFaucet = new AneSixDecimalFaucet(address(six), admin, 16_000e6, 1 hours, 160_000_000e6);
        tane = new AneTestToken(admin);
        taneFaucet = new AneFaucet(address(tane), admin, 16_000e18, 1 hours, 160_000_000e18);

        vm.startPrank(admin);
        six.grantRole(six.MINTER_ROLE(), address(sixFaucet));
        tane.grantRole(tane.MINTER_ROLE(), address(taneFaucet));
        vm.stopPrank();
    }

    function _sign(address faucet, string memory name, bytes32 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, faucet)
        );
        bytes32 structHash = keccak256(abi.encode(sixFaucet.FAUCET_CLAIM_TYPEHASH(), user, bytes32(0), deadline, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_ClaimMintsTsixInItsOwnBaseUnitsWithItsOwnDisclaimer() public {
        assertEq(address(sixFaucet.tsixToken()), address(six));
        assertEq(sixFaucet.claim(user), 16_000e6);
        assertEq(six.balanceOf(user), 16_000e6);
        assertEq(tane.balanceOf(user), 0);
        assertEq(
            sixFaucet.DISCLAIMER(), "TEST TOKENS (tSIX) - NO CASH VALUE, NO INR BACKING, NO REDEMPTION OR CONVERSION."
        );

        // Shared logic, separate state: the cooldown binds on the tSIX faucet and not on the tANE one.
        vm.expectRevert(
            abi.encodeWithSelector(
                AneFaucetBase.FaucetCooldownActive.selector,
                user,
                uint64(block.timestamp + 1 hours),
                uint64(block.timestamp)
            )
        );
        sixFaucet.claim(user);
        assertEq(taneFaucet.claim(user), 16_000e18);
    }

    function test_RelayedClaimIsBoundToItsOwnFaucet() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("tsix-claim-1");

        // Signed for the tANE faucet's domain: refused by the tSIX faucet even at the tSIX faucet's address.
        bytes memory forTane = _sign(address(taneFaucet), "AneFaucet", nonce, deadline);
        vm.prank(relayer);
        vm.expectRevert(AneFaucetBase.InvalidClaimSignature.selector);
        sixFaucet.relayedClaim(user, bytes32(0), deadline, nonce, forTane);
        bytes memory taneNameAtSixAddress = _sign(address(sixFaucet), "AneFaucet", nonce, deadline);
        vm.prank(relayer);
        vm.expectRevert(AneFaucetBase.InvalidClaimSignature.selector);
        sixFaucet.relayedClaim(user, bytes32(0), deadline, nonce, taneNameAtSixAddress);

        // Signed for its own domain: a gasless claim of tSIX.
        bytes memory forSix = _sign(address(sixFaucet), "AneSixDecimalFaucet", nonce, deadline);
        vm.prank(relayer);
        sixFaucet.relayedClaim(user, bytes32(0), deadline, nonce, forSix);
        assertEq(six.balanceOf(user), 16_000e6);

        // And the reverse: the tSIX signature does nothing on the tANE faucet.
        vm.prank(relayer);
        vm.expectRevert(AneFaucetBase.InvalidClaimSignature.selector);
        taneFaucet.relayedClaim(user, bytes32(0), deadline, nonce, forSix);
    }

    function test_OnlyTheOwnerConfiguresOrPausesAndPauseNeverBlocksTransfers() public {
        sixFaucet.claim(user);

        vm.expectRevert();
        sixFaucet.setFaucetConfig(1e6, 0, 1e6);
        vm.expectRevert();
        sixFaucet.pause();

        vm.prank(admin);
        sixFaucet.pause();
        vm.expectRevert();
        sixFaucet.claim(relayer);

        // REQ-001: a paused faucet never restricts ordinary tSIX transfers.
        vm.prank(user);
        assertTrue(six.transfer(relayer, 1e6));
        assertEq(six.balanceOf(relayer), 1e6);
    }
}
