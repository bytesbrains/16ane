// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AneAgentVault} from "./AneAgentVault.sol";

interface IAneVaultRegistry {
    function isRegisteredVault(address vault) external view returns (bool);
}

/// @title AneTaskEscrow — Deadline-Bounded Escrow for Asynchronous Agent Tasks
/// @notice Locks tANE from an `AneAgentVault` for a long-running task, releases it to the seller in one or
///         more milestones against delivery receipts signed by the buyer, and returns whatever is left to
///         the vault after the deadline, restoring the vault's budget (REQ-201, ADR-0009, E18).
/// @dev Needs no change to the vault. Locking is an ordinary `settlePayment` whose merchant is this
///      contract and whose `quoteId` commits to the task's terms, so the vault's policy (budget, per-payment
///      and daily limits, expiry, revocation) bounds every lock. Returning funds is the vault's own
///      `refundPayment`, which restores `cumulativeSpent` by exactly the amount returned. No arbitration:
///      only the buyer's side can release funds, and only time (or the seller) can return them.
contract AneTaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Task {
        address vault;
        address seller;
        uint256 amount;
        uint256 released;
        uint64 deadline;
        bytes32 specHash;
        bool closed;
    }

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("AneTaskEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @notice The terms a buyer's agent commits to: its SpendIntent's `quoteId` must equal `taskQuoteId(...)`.
    bytes32 public constant TASK_TERMS_TYPEHASH =
        keccak256("TaskTerms(address escrow,address seller,uint64 deadline,bytes32 specHash)");

    /// @notice A delivery receipt: the buyer accepts delivery up to a cumulative amount.
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 taskId,uint256 cumulativeAmount,bytes32 deliveryHash)");

    /// @notice The longest a task may hold a vault's funds, counted from when they were locked.
    uint64 public constant MAX_TASK_DURATION = 30 days;

    address public immutable taneToken;
    address public immutable vaultFactory;

    /// @notice Tasks by id; a task's id is the vault's `paymentId` for the lock.
    mapping(bytes32 taskId => Task task) public tasks;

    event TaskOpened(
        bytes32 indexed taskId,
        address indexed vault,
        address indexed seller,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    );
    event TaskReleased(
        bytes32 indexed taskId,
        address indexed seller,
        uint256 amount,
        uint256 cumulativeReleased,
        bytes32 deliveryHash,
        address approver
    );
    event TaskReturned(bytes32 indexed taskId, address indexed vault, uint256 amount, bool cancelledBySeller);

    error ZeroAddress();
    error InvalidSeller(address seller);
    error UnregisteredVault(address vault);
    error WrongMerchant(address expected, address actual);
    error TermsMismatch(bytes32 expectedQuoteId, bytes32 actualQuoteId);
    error InvalidDeadline(uint64 deadline, uint64 lockedAt);
    error TaskAlreadyOpen(bytes32 taskId);
    error LockMismatch(uint256 expected, uint256 received);
    error TaskNotFound(bytes32 taskId);
    error TaskClosed(bytes32 taskId);
    error DeadlinePassed(uint64 deadline, uint256 currentTimestamp);
    error DeadlineNotReached(uint64 deadline, uint256 currentTimestamp);
    error InvalidReleaseAmount(uint256 cumulativeAmount, uint256 released, uint256 amount);
    error UnauthorizedApprover(address approver);
    error OnlySeller();

    constructor(address _taneToken, address _vaultFactory) {
        if (_taneToken == address(0) || _vaultFactory == address(0)) revert ZeroAddress();
        taneToken = _taneToken;
        vaultFactory = _vaultFactory;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice The `quoteId` a buyer's agent signs to lock funds for these terms. `specHash` identifies the
    ///         job (for example, the hash of its specification and a per-task nonce); the vault refuses a
    ///         second payment with the same quoteId, so two identical tasks need different spec hashes.
    function taskQuoteId(address seller, uint64 deadline, bytes32 specHash) public view returns (bytes32) {
        return keccak256(abi.encode(TASK_TERMS_TYPEHASH, address(this), seller, deadline, specHash));
    }

    /// @notice The EIP-712 digest a buyer signs to release funds up to `cumulativeAmount`.
    function releaseDigest(bytes32 taskId, uint256 cumulativeAmount, bytes32 deliveryHash)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, taskId, cumulativeAmount, deliveryHash));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Locks `intent.amount` from the buyer's vault for a task. Anyone may submit it (the seller, a
    ///         relayer): the agent's signature over a quoteId that commits to the terms is the authorization.
    /// @dev If someone already settled this intent on the vault directly, without opening the task, the
    ///      funds are here but unrecorded; the vault's payment record then proves the lock, and the task is
    ///      adopted instead of settled again, so the funds can never be stranded.
    function openTask(
        AneAgentVault.SpendIntent calldata intent,
        bytes calldata signature,
        address seller,
        uint64 deadline,
        bytes32 specHash
    ) external nonReentrant returns (bytes32 taskId) {
        bool adopt;
        (taskId, adopt) = _checkOpen(intent, seller, deadline, specHash);

        // Recorded before the vault call; if the lock fails, the whole call reverts with it.
        tasks[taskId] = Task({
            vault: intent.vault,
            seller: seller,
            amount: intent.amount,
            released: 0,
            deadline: deadline,
            specHash: specHash,
            closed: false
        });
        if (!adopt) {
            // The vault checks the agent's signature and its whole policy, then transfers exactly
            // `intent.amount` here and records it under the same id.
            if (AneAgentVault(intent.vault).settlePayment(intent, signature) != taskId) {
                revert LockMismatch(intent.amount, 0);
            }
        }
        emit TaskOpened(taskId, intent.vault, seller, intent.amount, deadline, specHash);
    }

    /// @notice Pays the seller up to `cumulativeAmount` of the task in total, on or before the deadline.
    ///         With a signature, it is a delivery receipt from the buyer and anyone may submit it; with an
    ///         empty signature, the caller is the approver. The approver must be the vault's owner, or its
    ///         agent while the agent's delegation is active (revoking the agent voids its receipts, as it
    ///         voids its spend intents). Cumulative amounts make receipts idempotent: each milestone
    ///         receipt supersedes the last, and replaying one pays nothing more.
    function release(bytes32 taskId, uint256 cumulativeAmount, bytes32 deliveryHash, bytes calldata signature)
        external
        nonReentrant
    {
        Task storage task = _openTask(taskId);
        if (block.timestamp > task.deadline) revert DeadlinePassed(task.deadline, block.timestamp);
        if (cumulativeAmount <= task.released || cumulativeAmount > task.amount) {
            revert InvalidReleaseAmount(cumulativeAmount, task.released, task.amount);
        }

        address approver = signature.length == 0
            ? msg.sender
            : ECDSA.recover(releaseDigest(taskId, cumulativeAmount, deliveryHash), signature);
        if (!_isBuyer(task.vault, approver)) revert UnauthorizedApprover(approver);

        uint256 payout = cumulativeAmount - task.released;
        task.released = cumulativeAmount;
        if (cumulativeAmount == task.amount) task.closed = true;

        IERC20(taneToken).safeTransfer(task.seller, payout);
        emit TaskReleased(taskId, task.seller, payout, cumulativeAmount, deliveryHash, approver);
    }

    /// @notice After the deadline, returns everything not released to the buyer's vault. Anyone may call it,
    ///         and the funds can only go to the vault, so neither side can hold them past the deadline.
    function reclaim(bytes32 taskId) external nonReentrant {
        Task storage task = _openTask(taskId);
        if (block.timestamp <= task.deadline) revert DeadlineNotReached(task.deadline, block.timestamp);
        _returnRemaining(taskId, task, false);
    }

    /// @notice The seller gives up the task at any time and returns what has not been released.
    function cancel(bytes32 taskId) external nonReentrant {
        Task storage task = _openTask(taskId);
        if (msg.sender != task.seller) revert OnlySeller();
        _returnRemaining(taskId, task, true);
    }

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }

    /// @dev Checks a task can be opened and whether the vault has already paid its lock (adopt).
    function _checkOpen(AneAgentVault.SpendIntent calldata intent, address seller, uint64 deadline, bytes32 specHash)
        internal
        view
        returns (bytes32 taskId, bool adopt)
    {
        address vault = intent.vault;
        if (!IAneVaultRegistry(vaultFactory).isRegisteredVault(vault)) revert UnregisteredVault(vault);
        if (intent.merchant != address(this)) revert WrongMerchant(address(this), intent.merchant);
        if (seller == address(0) || seller == address(this) || seller == vault) revert InvalidSeller(seller);
        bytes32 expectedQuoteId = taskQuoteId(seller, deadline, specHash);
        if (intent.quoteId != expectedQuoteId) revert TermsMismatch(expectedQuoteId, intent.quoteId);

        taskId = keccak256(abi.encode(block.chainid, vault, address(this), intent.quoteId, intent.nonce));
        if (tasks[taskId].vault != address(0)) revert TaskAlreadyOpen(taskId);

        // slither-disable-next-line unused-return
        (address paidTo, uint256 amountPaid,, uint64 settledAt) = AneAgentVault(vault).payments(taskId);
        adopt = amountPaid != 0;
        if (adopt && (paidTo != address(this) || amountPaid != intent.amount)) {
            revert LockMismatch(intent.amount, amountPaid);
        }
        uint64 lockedAt = adopt ? settledAt : uint64(block.timestamp);
        // Bounded from the lock, not from now, so an adopted task keeps the deadline the agent signed.
        if (deadline <= lockedAt || deadline > lockedAt + MAX_TASK_DURATION) {
            revert InvalidDeadline(deadline, lockedAt);
        }
    }

    function _openTask(bytes32 taskId) internal view returns (Task storage task) {
        task = tasks[taskId];
        if (task.vault == address(0)) revert TaskNotFound(taskId);
        if (task.closed) revert TaskClosed(taskId);
    }

    function _isBuyer(address vault, address approver) internal view returns (bool) {
        AneAgentVault v = AneAgentVault(vault);
        if (approver == v.owner()) return true;
        return approver == v.agentSigner() && v.active() && block.timestamp <= v.expiry();
    }

    /// @dev Refunds through the vault so its budget is restored. Anyone can call `refundPayment` on the
    ///      vault with their own tokens, so part of this payment may already be marked refunded; only what
    ///      is still refundable goes that way, and any excess is a plain transfer, so a third party's early
    ///      refund can never make the return revert and strand the funds here.
    function _returnRemaining(bytes32 taskId, Task storage task, bool cancelledBySeller) internal {
        uint256 remaining = task.amount - task.released;
        task.closed = true;
        address vault = task.vault;

        // slither-disable-next-line unused-return
        (, uint256 amountPaid, uint256 amountRefunded,) = AneAgentVault(vault).payments(taskId);
        uint256 refundable = amountPaid - amountRefunded;
        uint256 viaRefund = remaining < refundable ? remaining : refundable;

        if (viaRefund > 0) {
            IERC20(taneToken).forceApprove(vault, viaRefund);
            AneAgentVault(vault).refundPayment(taskId, viaRefund);
        }
        if (remaining > viaRefund) {
            IERC20(taneToken).safeTransfer(vault, remaining - viaRefund);
        }
        emit TaskReturned(taskId, vault, remaining, cancelledBySeller);
    }
}
