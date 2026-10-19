// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AneAgentVault} from "./AneAgentVault.sol";

/// @title AneVaultFactory — Deterministic EIP-1167 Agent Vault Factory
/// @notice Deploys isolated `AneAgentVault` clones for owners (REQ-003, ADR-0003).
contract AneVaultFactory {
    address public immutable taneToken;
    address public immutable vaultImplementation;

    mapping(address vault => bool registered) public isRegisteredVault;
    mapping(address owner => address[] vaults) private _ownerVaults;

    event AgentCreated(address indexed owner, address indexed vault, bytes32 indexed salt);

    error ZeroAddress();

    constructor(address _taneToken) {
        if (_taneToken == address(0)) revert ZeroAddress();
        taneToken = _taneToken;
        vaultImplementation = address(new AneAgentVault(_taneToken, address(this)));
    }

    /// @notice Predicts the deterministic CREATE2 address of an agent vault for `(owner, userSalt)`.
    function predictVaultAddress(address owner, bytes32 userSalt) public view returns (address) {
        bytes32 combinedSalt = keccak256(abi.encode(owner, userSalt));
        return Clones.predictDeterministicAddress(vaultImplementation, combinedSalt, address(this));
    }

    /// @notice Deploys an isolated `AneAgentVault` clone owned by `owner`.
    function createVault(address owner, bytes32 userSalt) public returns (address vault) {
        if (owner == address(0)) revert ZeroAddress();
        bytes32 combinedSalt = keccak256(abi.encode(owner, userSalt));
        vault = Clones.cloneDeterministic(vaultImplementation, combinedSalt);
        isRegisteredVault[vault] = true;
        _ownerVaults[owner].push(vault);
        AneAgentVault(vault).initialize(owner);
        emit AgentCreated(owner, vault, userSalt);
    }

    /// @notice Returns all vaults created for `owner`.
    function getVaultsByOwner(address owner) external view returns (address[] memory) {
        return _ownerVaults[owner];
    }
}
