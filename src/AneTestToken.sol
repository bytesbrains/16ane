// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title AneTestToken (tANE) — 16ane Public Sandbox Test Token
/// @notice Free, unbacked, worthless simulation token on EVM testnet (REQ-001, REQ-012, ADR-0002).
/// @dev Implements ERC-20, ERC20Burnable, EIP-2612 Permit, EIP-3009 transferWithAuthorization,
///      and AccessControlDefaultAdminRules. Transfers are 100% permissionless with no pause or blacklist.
contract AneTestToken is ERC20, ERC20Burnable, ERC20Permit, AccessControlDefaultAdminRules, IERC3009 {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string public constant DISCLAIMER =
        "TESTNET SIMULATION TOKEN ONLY. NO INR BACKING, NO REDEMPTION, NO MONETARY VALUE.";

    /// @notice Historical unit illustration: 16 Annas = 1 Rupee (1 tANE illustrates 1 Anna = 6.25 paise; ZERO monetary value).
    uint256 public constant ILLUSTRATIVE_ANNAS_PER_RUPEE = 16;

    bytes32 public constant override TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant override RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant override CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;

    error ZeroAddress();

    constructor(address initialAdmin)
        ERC20("16ane Sandbox (NO CASH VALUE)", "tANE")
        ERC20Permit("16ane Sandbox (NO CASH VALUE)")
        AccessControlDefaultAdminRules(1 days, initialAdmin)
    {
        if (initialAdmin == address(0)) revert ZeroAddress();
    }

    /// @notice Programmatic guard confirming this contract is an unbacked test token (ADR-0002, ADR-0012).
    function isTestToken() external pure returns (bool) {
        return true;
    }

    /// @notice Mints sandbox tANE to `to`. Restricted to MINTER_ROLE (e.g., AneFaucet).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @inheritdoc IERC3009
    function authorizationState(address authorizer, bytes32 nonce) external view override returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @inheritdoc IERC3009
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
    ) external override {
        _validateTimeframeAndUseNonce(from, validAfter, validBefore, nonce);
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _requireValidECDSASignature(from, structHash, v, r, s);
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external override {
        _validateTimeframeAndUseNonce(from, validAfter, validBefore, nonce);
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _requireValidSignature(from, structHash, signature);
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
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
    ) external override {
        if (to != msg.sender) revert CallerMustBePayee(msg.sender, to);
        _validateTimeframeAndUseNonce(from, validAfter, validBefore, nonce);
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _requireValidECDSASignature(from, structHash, v, r, s);
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external override {
        if (to != msg.sender) revert CallerMustBePayee(msg.sender, to);
        _validateTimeframeAndUseNonce(from, validAfter, validBefore, nonce);
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _requireValidSignature(from, structHash, signature);
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external override {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _requireValidECDSASignature(authorizer, structHash, v, r, s);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @inheritdoc IERC3009
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external override {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _requireValidSignature(authorizer, structHash, signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _validateTimeframeAndUseNonce(address authorizer, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
    {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        _authorizationStates[authorizer][nonce] = true;
    }

    function _requireValidECDSASignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s)
        internal
        view
    {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, v, r, s);
        if (recovered != signer) revert InvalidAuthorizationSignature();
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes calldata signature) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) {
            revert InvalidAuthorizationSignature();
        }
    }
}
