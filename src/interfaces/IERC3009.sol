// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IERC3009 — Transfer With Authorization Interface (EIP-3009)
/// @notice Supports random 32-byte nonces for concurrent gasless payments (x402 exact scheme).
interface IERC3009 {
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error AuthorizationNotYetValid(uint256 validAfter, uint256 currentTimestamp);
    error AuthorizationExpired(uint256 validBefore, uint256 currentTimestamp);
    error InvalidAuthorizationSignature();
    error CallerMustBePayee(address caller, address payee);

    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function CANCEL_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external;
}
