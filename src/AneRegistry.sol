// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AneTestToken} from "./AneTestToken.sol";
import {AneVaultFactory} from "./AneVaultFactory.sol";
import {AneFaucet} from "./AneFaucet.sol";

/// @title AneRegistry — On-Chain Deployment Directory for 16ane Sandbox
/// @notice Deterministic CREATE2 registry resolving active contract addresses and verifying
///         cross-contract wiring (REQ-010, REQ-013, ADR-0001, ADR-0011).
contract AneRegistry is Ownable2Step {
    address public taneToken;
    address public vaultFactory;
    address public faucet;
    address public serviceDirectory;
    uint64 public version;
    uint64 public updatedAt;

    event DeploymentUpdated(
        uint64 indexed version, address taneToken, address vaultFactory, address faucet, address serviceDirectory
    );

    error ZeroAddress();
    error NotAContract(address target);
    error NotATestToken(address token);
    error WiringMismatch();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Registers a verified set of 16ane sandbox contracts and increments `version`.
    function setDeployment(address _taneToken, address _vaultFactory, address _faucet, address _serviceDirectory)
        external
        onlyOwner
    {
        if (
            _taneToken == address(0) || _vaultFactory == address(0) || _faucet == address(0)
                || _serviceDirectory == address(0)
        ) {
            revert ZeroAddress();
        }
        if (_taneToken.code.length == 0) revert NotAContract(_taneToken);
        if (_vaultFactory.code.length == 0) revert NotAContract(_vaultFactory);
        if (_faucet.code.length == 0) revert NotAContract(_faucet);
        if (_serviceDirectory.code.length == 0) revert NotAContract(_serviceDirectory);

        if (!AneTestToken(_taneToken).isTestToken()) revert NotATestToken(_taneToken);
        if (AneVaultFactory(_vaultFactory).taneToken() != _taneToken) revert WiringMismatch();
        if (address(AneFaucet(_faucet).taneToken()) != _taneToken) revert WiringMismatch();

        taneToken = _taneToken;
        vaultFactory = _vaultFactory;
        faucet = _faucet;
        serviceDirectory = _serviceDirectory;
        version += 1;
        updatedAt = uint64(block.timestamp);

        emit DeploymentUpdated(version, _taneToken, _vaultFactory, _faucet, _serviceDirectory);
    }

    /// @notice Returns the complete active deployment tuple in a single view call.
    function getDeployment()
        external
        view
        returns (
            address _taneToken,
            address _vaultFactory,
            address _faucet,
            address _serviceDirectory,
            uint64 _version,
            uint64 _updatedAt
        )
    {
        return (taneToken, vaultFactory, faucet, serviceDirectory, version, updatedAt);
    }
}
