// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AneTestToken} from "../src/AneTestToken.sol";
import {AneFaucet} from "../src/AneFaucet.sol";
import {AneFaucetBase} from "../src/AneFaucetBase.sol";

contract AneFaucetTest is Test {
    AneTestToken internal token;
    AneFaucet internal faucet;

    address internal admin = makeAddr("admin");
    uint256 internal userPk = 0x123456;
    address internal user;
    address internal relayer = makeAddr("relayer");
    address internal peer = makeAddr("peer");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        vm.warp(1_700_000_000);
        user = vm.addr(userPk);

        token = new AneTestToken(admin);
        faucet = new AneFaucet(address(token), admin, 1_600e18, 24 hours, 3_200e18);

        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(admin);
        token.grantRole(minterRole, address(faucet));
    }

    function test_DirectClaimAndCooldownEnforcement() public {
        uint256 claimed = faucet.claim(user);
        assertEq(claimed, 1_600e18);
        assertEq(token.balanceOf(user), 1_600e18);

        // Second claim within 24 hours reverts (REQ-002)
        uint64 expectedNext = uint64(block.timestamp + 24 hours);
        vm.expectRevert(
            abi.encodeWithSelector(
                AneFaucetBase.FaucetCooldownActive.selector, user, expectedNext, uint64(block.timestamp)
            )
        );
        faucet.claim(user);

        // After 24 hours, user can claim again
        vm.warp(block.timestamp + 24 hours + 1);
        faucet.claim(user);
        assertEq(token.balanceOf(user), 3_200e18);
    }

    function test_DailyMintCapAndNextDayReset() public {
        address user1 = makeAddr("user1");
        address user2 = makeAddr("user2");
        address user3 = makeAddr("user3");

        faucet.claim(user1); // 1,600 tANE
        faucet.claim(user2); // 3,200 tANE (hits daily cap of 3,200 tANE)

        vm.expectRevert(abi.encodeWithSelector(AneFaucetBase.DailyMintCapExceeded.selector, 1_600e18, 0));
        faucet.claim(user3);

        // Next UTC day resets daily cap
        vm.warp(block.timestamp + 1 days);
        faucet.claim(user3);
        assertEq(token.balanceOf(user3), 1_600e18);
    }

    function test_GaslessRelayedClaim() public {
        bytes32 campaignId = keccak256("quickstart-v1");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("claim-nonce-1");

        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("AneFaucet"), keccak256("1"), block.chainid, address(faucet))
        );
        bytes32 structHash = keccak256(abi.encode(faucet.FAUCET_CLAIM_TYPEHASH(), user, campaignId, deadline, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Relayer submits claim for 0-ETH user
        vm.prank(relayer);
        faucet.relayedClaim(user, campaignId, deadline, nonce, sig);
        assertEq(token.balanceOf(user), 1_600e18);

        // Replay of same nonce reverts
        vm.warp(block.timestamp + 25 hours);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AneFaucetBase.RelayedNonceAlreadyUsed.selector, nonce));
        faucet.relayedClaim(user, campaignId, deadline + 25 hours, nonce, sig);
    }

    function test_PausedFaucetNeverBlocksTokenTransfers() public {
        // REQ-001 & REQ-002 invariant: Faucet pause/abuse controls never restrict ordinary token transfers
        faucet.claim(user);

        vm.prank(admin);
        faucet.pause();

        vm.expectRevert();
        faucet.claim(peer);

        // Ordinary token transfer works seamlessly while faucet is paused
        vm.prank(user);
        token.transfer(peer, 160e18);
        assertEq(token.balanceOf(peer), 160e18);
    }
}
