// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AneServiceDirectory — Optional On-Chain Anchor for Signed Service Manifests
/// @notice Anchors off-chain HTTPS / A2A service manifest hashes without storing PII on-chain
///         (REQ-101, REQ-PRIV, ADR-0007). No centralized approval is required to anchor or query.
contract AneServiceDirectory {
    enum ServiceStatus {
        NONE,
        ACTIVE,
        PAUSED,
        DEPRECATED
    }

    struct ServiceAnchor {
        address provider;
        string manifestUri;
        bytes32 manifestHash;
        uint64 updatedAt;
        uint64 expiresAt;
        ServiceStatus status;
    }

    mapping(bytes32 serviceIdHash => ServiceAnchor anchor) public services;

    event ServiceAnchored(
        bytes32 indexed serviceIdHash,
        address indexed provider,
        string manifestUri,
        bytes32 manifestHash,
        uint64 expiresAt,
        ServiceStatus status
    );

    error EmptyManifestUri();
    error EmptyManifestHash();
    error InvalidExpiry(uint64 expiresAt, uint256 currentTimestamp);
    error NotServiceProvider(bytes32 serviceIdHash, address caller, address ownerProvider);

    /// @notice Anchors or updates a service manifest reference on-chain.
    function anchorService(
        bytes32 serviceIdHash,
        string calldata manifestUri,
        bytes32 manifestHash,
        uint64 expiresAt,
        ServiceStatus status
    ) external {
        if (bytes(manifestUri).length == 0) revert EmptyManifestUri();
        if (manifestHash == bytes32(0)) revert EmptyManifestHash();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt, block.timestamp);
        if (status == ServiceStatus.NONE) status = ServiceStatus.ACTIVE;

        ServiceAnchor storage existing = services[serviceIdHash];
        if (existing.provider != address(0) && existing.provider != msg.sender) {
            revert NotServiceProvider(serviceIdHash, msg.sender, existing.provider);
        }

        services[serviceIdHash] = ServiceAnchor({
            provider: msg.sender,
            manifestUri: manifestUri,
            manifestHash: manifestHash,
            updatedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            status: status
        });

        emit ServiceAnchored(serviceIdHash, msg.sender, manifestUri, manifestHash, expiresAt, status);
    }

    /// @notice Updates the lifecycle status (ACTIVE, PAUSED, DEPRECATED) of an anchored service.
    function setServiceStatus(bytes32 serviceIdHash, ServiceStatus status) external {
        ServiceAnchor storage existing = services[serviceIdHash];
        if (existing.provider != msg.sender) {
            revert NotServiceProvider(serviceIdHash, msg.sender, existing.provider);
        }
        existing.status = status;
        existing.updatedAt = uint64(block.timestamp);
        emit ServiceAnchored(
            serviceIdHash, msg.sender, existing.manifestUri, existing.manifestHash, existing.expiresAt, status
        );
    }

    /// @notice Returns the anchored manifest record for `serviceIdHash`.
    function getService(bytes32 serviceIdHash) external view returns (ServiceAnchor memory) {
        return services[serviceIdHash];
    }
}
