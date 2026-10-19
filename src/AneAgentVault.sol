// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IAneVaultFactory {
    function isRegisteredVault(address vault) external view returns (bool);
}

/// @title AneAgentVault — Isolated Agent Treasury & Contract-Enforced Policy Account
/// @notice Enforces bounded agent spending, fixed vs revolving revenue accounting, owner revocation,
///         and verifiable refunds (REQ-003, REQ-004, REQ-005, REQ-008, REQ-107, ADR-0003, ADR-0004, ADR-0009).
contract AneAgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum BudgetMode {
        FIXED,
        REVOLVING
    }

    struct PolicyInput {
        address agentSigner;
        uint256 maxTotalSpend;
        uint256 maxPerTx;
        uint256 dailyLimit;
        uint64 expiry;
        BudgetMode budgetMode;
        uint256 revolvingTreasuryCeiling;
    }

    struct SpendIntent {
        address vault;
        address merchant;
        uint256 amount;
        bytes32 quoteId;
        bytes32 serviceIdHash;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint64 policyVersion;
    }

    struct PaymentRecord {
        address merchant;
        uint256 amountPaid;
        uint256 amountRefunded;
        uint64 settledAt;
    }

    struct AccountingSummary {
        address owner;
        address agentSigner;
        uint256 tokenBalance;
        uint256 ownerPrincipalDeposited;
        uint256 maxTotalSpend;
        uint256 cumulativeSpent;
        uint256 authorizedRemaining;
        uint256 spendableNow;
        uint256 verifiedRevenue;
        uint256 unallocatedBalance;
        uint64 policyVersion;
        uint64 expiry;
        BudgetMode budgetMode;
        uint256 revolvingTreasuryCeiling;
        bool active;
    }

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("AneAgentVault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    bytes32 public constant SPEND_INTENT_TYPEHASH = keccak256(
        "SpendIntent(address vault,address merchant,uint256 amount,bytes32 quoteId,bytes32 serviceIdHash,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint64 policyVersion)"
    );

    bytes32 public constant SET_POLICY_TYPEHASH = keccak256(
        "SetPolicy(address vault,address agentSigner,uint256 maxTotalSpend,uint256 maxPerTx,uint256 dailyLimit,uint64 expiry,uint8 budgetMode,uint256 revolvingTreasuryCeiling,uint64 expectedPolicyVersion,uint256 deadline)"
    );

    bytes32 public constant REVOKE_TYPEHASH =
        keccak256("Revoke(address vault,uint64 expectedPolicyVersion,uint256 deadline)");

    address public immutable taneToken;
    address public immutable factory;

    address private _owner;
    address private _pendingOwner;

    address public agentSigner;
    uint64 public policyVersion;
    uint64 public expiry;
    BudgetMode public budgetMode;
    bool public active;

    uint256 public ownerPrincipalDeposited;
    uint256 public maxTotalSpend;
    uint256 public cumulativeSpent;
    uint256 public maxPerTx;
    uint256 public dailyLimit;
    uint256 public revolvingTreasuryCeiling;
    uint256 public verifiedRevenue;

    uint64 public currentDayIndex;
    uint256 public currentDaySpent;

    mapping(bytes32 nonce => bool used) public nonceUsed;
    mapping(bytes32 quoteId => bool settled) public quoteSettled;
    mapping(bytes32 paymentId => PaymentRecord record) public payments;

    event Initialized(address indexed owner, address indexed vault);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Funded(address indexed vault, address indexed funder, uint256 amount, uint256 ownerPrincipalTotal);
    event DelegationGranted(
        address indexed vault,
        address indexed signer,
        uint64 indexed policyVersion,
        uint256 maxTotalSpend,
        uint256 maxPerTx,
        uint256 dailyLimit,
        uint64 expiry,
        BudgetMode budgetMode,
        uint256 revolvingTreasuryCeiling
    );
    event SignerRotated(
        address indexed vault, address indexed oldSigner, address indexed newSigner, uint64 policyVersion
    );
    event Spent(
        address indexed vault,
        address indexed merchant,
        uint256 amount,
        bytes32 indexed paymentId,
        bytes32 quoteId,
        bytes32 serviceIdHash
    );
    event RevenueReceived(address indexed vault, address indexed sender, uint256 amount, bytes32 indexed paymentId);
    event PaymentRefunded(address indexed vault, address indexed merchant, bytes32 indexed paymentId, uint256 amount);
    event DelegationRevoked(address indexed vault, address indexed revokedSigner, uint64 policyVersion);
    event Withdrawn(address indexed vault, address indexed recipient, uint256 amount);

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error OnlyOwner();
    error OnlyPendingOwner();
    error OnlyAgentSigner();
    error SignerCannotBeOwner();
    error DelegationInactive();
    error DelegationExpired(uint64 expiry, uint256 currentTimestamp);
    error InvalidIntentTarget(address expectedVault, address actualVault);
    error InvalidPolicyVersion(uint64 expectedVersion, uint64 actualVersion);
    error IntentNotYetValid(uint256 validAfter, uint256 currentTimestamp);
    error IntentExpired(uint256 validBefore, uint256 currentTimestamp);
    error NonceAlreadyUsed(bytes32 nonce);
    error QuoteAlreadySettled(bytes32 quoteId);
    error SelfPaymentForbidden();
    error InvalidSignature();
    error ExceedsPerTxLimit(uint256 requested, uint256 maxPerTx);
    error ExceedsDailyLimit(uint256 requested, uint256 remainingDaily);
    error ExceedsAuthorizedBudget(uint256 requested, uint256 authorizedRemaining);
    error InsufficientVaultBalance(uint256 requested, uint256 availableBalance);
    error UnauthorizedRevenueNotifier();
    error PaymentNotFound(bytes32 paymentId);
    error InvalidRefundAmount(uint256 requested, uint256 maxRefundable);
    error SignatureExpired(uint256 deadline, uint256 currentTimestamp);

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwner();
        _;
    }

    constructor(address _taneToken, address _factory) {
        if (_taneToken == address(0) || _factory == address(0)) revert ZeroAddress();
        taneToken = _taneToken;
        factory = _factory;
        // Lock the master implementation contract so it cannot be initialized directly.
        _owner = address(0xdead);
    }

    /// @notice Initializes an EIP-1167 minimal proxy clone for `initialOwner`.
    function initialize(address initialOwner) external {
        if (_owner != address(0)) revert AlreadyInitialized();
        if (initialOwner == address(0)) revert ZeroAddress();
        _owner = initialOwner;
        emit Initialized(initialOwner, address(this));
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function pendingOwner() public view returns (address) {
        return _pendingOwner;
    }

    /// @notice Starts 2-step ownership transfer (Ownable2Step pattern).
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @notice Completes 2-step ownership transfer.
    function acceptOwnership() external {
        if (msg.sender != _pendingOwner) revert OnlyPendingOwner();
        address oldOwner = _owner;
        if (agentSigner == msg.sender) {
            // Prevent new owner from also being the active agentSigner (REQ-003).
            active = false;
            policyVersion += 1;
        }
        _owner = msg.sender;
        _pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    /// @notice Computes the dynamic EIP-712 domain separator for this vault clone and chain ID.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Funds the agent vault with `amount` of tANE from `msg.sender`.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        ownerPrincipalDeposited += amount;
        IERC20(taneToken).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(address(this), msg.sender, amount, ownerPrincipalDeposited);
    }

    /// @notice Funds the vault in a single transaction using an EIP-2612 permit signature.
    function fundWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        ownerPrincipalDeposited += amount;
        try IERC20Permit(taneToken).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        IERC20(taneToken).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(address(this), msg.sender, amount, ownerPrincipalDeposited);
    }

    /// @notice Sets or replaces the delegated spending policy for a new policy epoch (resets cumulativeSpent to 0).
    function setPolicy(PolicyInput calldata input) external onlyOwner {
        _applyPolicy(input);
    }

    /// @notice Sets the delegated spending policy via an owner EIP-712 signature (supports gasless onboarding).
    function setPolicyWithSig(
        PolicyInput calldata input,
        uint64 expectedPolicyVersion,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        if (expectedPolicyVersion != policyVersion) revert InvalidPolicyVersion(expectedPolicyVersion, policyVersion);

        bytes32 structHash = keccak256(
            abi.encode(
                SET_POLICY_TYPEHASH,
                address(this),
                input.agentSigner,
                input.maxTotalSpend,
                input.maxPerTx,
                input.dailyLimit,
                input.expiry,
                uint8(input.budgetMode),
                input.revolvingTreasuryCeiling,
                expectedPolicyVersion,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (ECDSA.recover(digest, signature) != _owner) revert InvalidSignature();

        _applyPolicy(input);
    }

    /// @notice Rotates the compromised or expired `agentSigner` while keeping remaining budget intact.
    function rotateAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        if (newSigner == _owner) revert SignerCannotBeOwner();
        address oldSigner = agentSigner;
        agentSigner = newSigner;
        policyVersion += 1;
        emit SignerRotated(address(this), oldSigner, newSigner, policyVersion);
    }

    /// @notice Immediately revokes agent spending authority and invalidates all prior off-chain signatures (REQ-005).
    function revoke() external onlyOwner {
        _revoke();
    }

    /// @notice Revokes agent spending authority via an owner EIP-712 signature.
    function revokeWithSig(uint64 expectedPolicyVersion, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        if (expectedPolicyVersion != policyVersion) revert InvalidPolicyVersion(expectedPolicyVersion, policyVersion);

        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, address(this), expectedPolicyVersion, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (ECDSA.recover(digest, signature) != _owner) revert InvalidSignature();

        _revoke();
    }

    /// @notice Withdraws `amount` of tANE to `recipient` (REQ-005).
    function withdraw(uint256 amount, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = IERC20(taneToken).balanceOf(address(this));
        if (amount > bal) revert InsufficientVaultBalance(amount, bal);

        if (amount <= ownerPrincipalDeposited) {
            ownerPrincipalDeposited -= amount;
        } else {
            ownerPrincipalDeposited = 0;
        }

        IERC20(taneToken).safeTransfer(recipient, amount);
        emit Withdrawn(address(this), recipient, amount);
    }

    /// @notice Atomically revokes agent authority and sweeps full available tANE balance to `recipient` (REQ-005).
    function revokeAndSweep(address recipient) external onlyOwner nonReentrant returns (uint256 swept) {
        if (recipient == address(0)) revert ZeroAddress();
        _revoke();
        swept = IERC20(taneToken).balanceOf(address(this));
        ownerPrincipalDeposited = 0;
        if (swept > 0) {
            IERC20(taneToken).safeTransfer(recipient, swept);
            emit Withdrawn(address(this), recipient, swept);
        }
    }

    /// @notice Direct spend called by `agentSigner` on-chain (REQ-004, REQ-006).
    function spend(address merchant, uint256 amount, bytes32 quoteId, bytes32 serviceIdHash, bytes32 nonce)
        external
        nonReentrant
        returns (bytes32 paymentId)
    {
        if (msg.sender != agentSigner) revert OnlyAgentSigner();
        paymentId = _executeSpend(merchant, amount, quoteId, serviceIdHash, nonce);
    }

    /// @notice Settles an off-chain EIP-712 `SpendIntent` signed by `agentSigner` (x402 `ane-vault-v1` scheme).
    function settlePayment(SpendIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 paymentId)
    {
        if (intent.vault != address(this)) revert InvalidIntentTarget(address(this), intent.vault);
        if (intent.policyVersion != policyVersion) revert InvalidPolicyVersion(policyVersion, intent.policyVersion);
        if (block.timestamp <= intent.validAfter) revert IntentNotYetValid(intent.validAfter, block.timestamp);
        if (block.timestamp >= intent.validBefore) revert IntentExpired(intent.validBefore, block.timestamp);

        bytes32 structHash = keccak256(
            abi.encode(
                SPEND_INTENT_TYPEHASH,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (ECDSA.recover(digest, signature) != agentSigner) revert InvalidSignature();

        paymentId = _executeSpend(intent.merchant, intent.amount, intent.quoteId, intent.serviceIdHash, intent.nonce);
    }

    /// @notice Called by another registered `AneAgentVault` upon settling a payment to this vault.
    function notifyVerifiedRevenue(uint256 amount, bytes32 paymentId) external {
        if (!IAneVaultFactory(factory).isRegisteredVault(msg.sender) || msg.sender == address(this)) {
            revert UnauthorizedRevenueNotifier();
        }
        verifiedRevenue += amount;
        emit RevenueReceived(address(this), msg.sender, amount, paymentId);
    }

    /// @notice Refunds a previously settled payment, restoring failed-call budget up to `amountPaid` (REQ-008, ADR-0009).
    function refundPayment(bytes32 paymentId, uint256 amount) external nonReentrant {
        PaymentRecord storage rec = payments[paymentId];
        if (rec.amountPaid == 0) revert PaymentNotFound(paymentId);
        uint256 maxRefundable = rec.amountPaid - rec.amountRefunded;
        if (amount == 0 || amount > maxRefundable) revert InvalidRefundAmount(amount, maxRefundable);

        rec.amountRefunded += amount;
        if (cumulativeSpent >= amount) {
            cumulativeSpent -= amount;
        } else {
            cumulativeSpent = 0;
        }

        uint64 today = uint64(block.timestamp / 1 days);
        if (currentDayIndex == today) {
            if (currentDaySpent >= amount) {
                currentDaySpent -= amount;
            } else {
                currentDaySpent = 0;
            }
        }

        IERC20(taneToken).safeTransferFrom(msg.sender, address(this), amount);
        emit PaymentRefunded(address(this), msg.sender, paymentId, amount);
    }

    /// @notice Returns the effective cumulative spend ceiling for the current policy epoch (ADR-0004).
    function effectiveSpendCeiling() public view returns (uint256) {
        if (budgetMode == BudgetMode.FIXED) {
            return maxTotalSpend;
        }
        // In REVOLVING mode, verified revenue can expand the cap up to `cumulativeSpent + revolvingTreasuryCeiling`.
        uint256 expandedCap = maxTotalSpend + verifiedRevenue;
        uint256 revolvingMax = cumulativeSpent + revolvingTreasuryCeiling;
        return Math.min(expandedCap, revolvingMax);
    }

    /// @notice Returns the remaining authorized spend under the policy (independent of raw token balance).
    function authorizedRemaining() public view returns (uint256) {
        if (!active || block.timestamp > expiry) return 0;
        uint256 ceiling = effectiveSpendCeiling();
        if (ceiling <= cumulativeSpent) return 0;
        uint256 totalRem = ceiling - cumulativeSpent;

        if (dailyLimit > 0) {
            uint64 today = uint64(block.timestamp / 1 days);
            uint256 spentToday = (currentDayIndex == today) ? currentDaySpent : 0;
            if (spentToday >= dailyLimit) return 0;
            uint256 dailyRem = dailyLimit - spentToday;
            totalRem = Math.min(totalRem, dailyRem);
        }
        return totalRem;
    }

    /// @notice Returns the actual amount the agent can spend right now (`min(authorizedRemaining, balance)`).
    function spendableBalance() public view returns (uint256) {
        uint256 authRem = authorizedRemaining();
        uint256 bal = IERC20(taneToken).balanceOf(address(this));
        return Math.min(authRem, bal);
    }

    /// @notice Inspectable accounting summary for owners, SDKs, and indexers (REQ-015).
    function getAccountingSummary() external view returns (AccountingSummary memory summary) {
        uint256 bal = IERC20(taneToken).balanceOf(address(this));
        uint256 authRem = authorizedRemaining();
        uint256 spendNow = Math.min(authRem, bal);
        uint256 unallocated = bal > spendNow ? bal - spendNow : 0;

        summary = AccountingSummary({
            owner: _owner,
            agentSigner: agentSigner,
            tokenBalance: bal,
            ownerPrincipalDeposited: ownerPrincipalDeposited,
            maxTotalSpend: maxTotalSpend,
            cumulativeSpent: cumulativeSpent,
            authorizedRemaining: authRem,
            spendableNow: spendNow,
            verifiedRevenue: verifiedRevenue,
            unallocatedBalance: unallocated,
            policyVersion: policyVersion,
            expiry: expiry,
            budgetMode: budgetMode,
            revolvingTreasuryCeiling: revolvingTreasuryCeiling,
            active: active
        });
    }

    function _applyPolicy(PolicyInput calldata input) internal {
        if (input.agentSigner == address(0)) revert ZeroAddress();
        if (input.agentSigner == _owner) revert SignerCannotBeOwner();
        if (input.expiry <= block.timestamp) revert DelegationExpired(input.expiry, block.timestamp);

        agentSigner = input.agentSigner;
        maxTotalSpend = input.maxTotalSpend;
        maxPerTx = input.maxPerTx;
        dailyLimit = input.dailyLimit;
        expiry = input.expiry;
        budgetMode = input.budgetMode;
        revolvingTreasuryCeiling = input.revolvingTreasuryCeiling;

        cumulativeSpent = 0;
        verifiedRevenue = 0;
        currentDayIndex = uint64(block.timestamp / 1 days);
        currentDaySpent = 0;
        policyVersion += 1;
        active = true;

        emit DelegationGranted(
            address(this),
            input.agentSigner,
            policyVersion,
            input.maxTotalSpend,
            input.maxPerTx,
            input.dailyLimit,
            input.expiry,
            input.budgetMode,
            input.revolvingTreasuryCeiling
        );
    }

    function _revoke() internal {
        address oldSigner = agentSigner;
        active = false;
        policyVersion += 1;
        emit DelegationRevoked(address(this), oldSigner, policyVersion);
    }

    function _executeSpend(address merchant, uint256 amount, bytes32 quoteId, bytes32 serviceIdHash, bytes32 nonce)
        internal
        returns (bytes32 paymentId)
    {
        if (!active) revert DelegationInactive();
        if (block.timestamp > expiry) revert DelegationExpired(expiry, block.timestamp);
        if (merchant == address(0)) revert ZeroAddress();
        if (merchant == address(this)) revert SelfPaymentForbidden();
        if (amount == 0) revert ZeroAmount();
        if (nonceUsed[nonce]) revert NonceAlreadyUsed(nonce);
        if (quoteSettled[quoteId]) revert QuoteAlreadySettled(quoteId);

        if (maxPerTx > 0 && amount > maxPerTx) {
            revert ExceedsPerTxLimit(amount, maxPerTx);
        }

        uint64 today = uint64(block.timestamp / 1 days);
        if (currentDayIndex != today) {
            currentDayIndex = today;
            currentDaySpent = 0;
        }
        if (dailyLimit > 0) {
            uint256 remainingDaily = dailyLimit > currentDaySpent ? dailyLimit - currentDaySpent : 0;
            if (amount > remainingDaily) revert ExceedsDailyLimit(amount, remainingDaily);
        }

        uint256 ceiling = effectiveSpendCeiling();
        uint256 remainingTotal = ceiling > cumulativeSpent ? ceiling - cumulativeSpent : 0;
        if (amount > remainingTotal) {
            revert ExceedsAuthorizedBudget(amount, remainingTotal);
        }

        uint256 bal = IERC20(taneToken).balanceOf(address(this));
        if (amount > bal) {
            revert InsufficientVaultBalance(amount, bal);
        }

        nonceUsed[nonce] = true;
        quoteSettled[quoteId] = true;
        cumulativeSpent += amount;
        currentDaySpent += amount;

        paymentId = keccak256(abi.encode(block.chainid, address(this), merchant, quoteId, nonce));
        payments[paymentId] = PaymentRecord({
            merchant: merchant, amountPaid: amount, amountRefunded: 0, settledAt: uint64(block.timestamp)
        });

        IERC20(taneToken).safeTransfer(merchant, amount);

        if (IAneVaultFactory(factory).isRegisteredVault(merchant)) {
            AneAgentVault(merchant).notifyVerifiedRevenue(amount, paymentId);
        }

        emit Spent(address(this), merchant, amount, paymentId, quoteId, serviceIdHash);
    }
}
