// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IQorePQC} from "./IQorePQC.sol";

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title BlindIntentVault
/// @notice MEV-proof, post-quantum sealed intent settlement vault on QoreChain EVM (Chain ID 9800).
/// @dev Keeps strategy triggers and slippage minimums off-chain inside ML-KEM-1024 QoreSeal envelopes,
///      verifies ML-DSA-87 owner commitments at execution via precompiles 0x...0a01 and 0x...0a02,
///      and settles atomic ERC-20 swaps against on-chain constant-product vault reserves.
contract BlindIntentVault {
    address public constant PQC_VERIFY_PRECOMPILE = 0x0000000000000000000000000000000000000a01;
    address public constant PQC_KEY_STATUS_PRECOMPILE = 0x0000000000000000000000000000000000000a02;
    uint8 public constant ML_DSA_87_ALGORITHM_ID = 1;
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS_DENOM = 10_000;

    enum IntentStatus {
        None,
        Armed,
        Executed,
        Cancelled
    }

    struct SealedIntent {
        address owner;
        address agent;
        address tokenIn;
        address tokenOut;
        uint256 maxAmountIn;
        uint64 deadline;
        bytes32 commitmentHash;
        bytes32 kemEnvelopeHash;
        IntentStatus status;
    }

    address public immutable admin;
    uint256 public nextIntentId = 1;

    mapping(uint256 => SealedIntent) public intents;
    mapping(bytes32 => bool) public usedCommitments;
    mapping(address => uint256) public poolReserves;

    event VaultLiquidityUpdated(
        address indexed provider,
        address indexed token,
        uint256 delta,
        uint256 newReserve
    );

    event PoolSwapped(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event SealedIntentRegistered(
        uint256 indexed intentId,
        address indexed owner,
        address indexed agent,
        address tokenIn,
        address tokenOut,
        uint256 maxAmountIn,
        uint64 deadline,
        bytes32 commitmentHash,
        bytes32 kemEnvelopeHash,
        bytes kemEnvelope
    );

    event SealedIntentSettled(
        uint256 indexed intentId,
        address indexed owner,
        address indexed executor,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 sealedReceiptHash,
        bytes sealedReceipt
    );

    event SealedIntentCancelled(uint256 indexed intentId, address indexed owner);

    error ZeroAddress();
    error SameToken();
    error InvalidAmounts();
    error InvalidDeadline();
    error IntentNotFound();
    error IntentNotArmed();
    error IntentExpired();
    error UnauthorizedCaller();
    error CommitmentMismatch();
    error CommitmentAlreadyUsed();
    error PqcKeyNotRegistered();
    error PqcPossessionUnproven();
    error PqcWrongAlgorithm(uint8 algorithmId);
    error PqcPubkeyMismatch();
    error InvalidMlDsaSignature();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error InsufficientPoolLiquidity(address token, uint256 available);
    error TransferFailed();

    constructor() {
        admin = msg.sender;
    }

    function _pqcVerifyAddress() internal view virtual returns (address) {
        return PQC_VERIFY_PRECOMPILE;
    }

    function _pqcKeyStatusAddress() internal view virtual returns (address) {
        return PQC_KEY_STATUS_PRECOMPILE;
    }

    /// @notice Adds ERC-20 reserve liquidity used for deterministic settlement and market-move demos.
    function addLiquidity(address token, uint256 amount) external {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmounts();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        poolReserves[token] += amount;
        emit VaultLiquidityUpdated(msg.sender, token, amount, poolReserves[token]);
    }

    /// @notice Admin liquidity withdrawal for testnet cleanup after demos.
    function removeLiquidity(address token, uint256 amount, address to) external {
        if (msg.sender != admin) revert UnauthorizedCaller();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || poolReserves[token] < amount) {
            revert InsufficientPoolLiquidity(token, poolReserves[token]);
        }
        poolReserves[token] -= amount;
        _safeTransfer(token, to, amount);
        emit VaultLiquidityUpdated(to, token, 0, poolReserves[token]);
    }

    /// @notice Direct constant-product swap (0.30% fee), also used to simulate market price moves on testnet.
    function swapPool(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert InvalidAmounts();

        amountOut = quotePoolOut(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        poolReserves[tokenIn] += amountIn;
        poolReserves[tokenOut] -= amountOut;
        _safeTransfer(tokenOut, msg.sender, amountOut);

        emit PoolSwapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Registers an encrypted QoreSeal intent envelope and an opaque ML-DSA-87 commitment hash.
    /// @dev Intentionally omits trigger price and `minAmountOut` from contract storage and events.
    function registerSealedIntent(
        address agent,
        address tokenIn,
        address tokenOut,
        uint256 maxAmountIn,
        uint64 deadline,
        bytes32 commitmentHash,
        bytes calldata kemEnvelope
    ) external returns (uint256 intentId) {
        if (agent == address(0) || tokenIn == address(0) || tokenOut == address(0)) {
            revert ZeroAddress();
        }
        if (tokenIn == tokenOut) revert SameToken();
        if (maxAmountIn == 0 || commitmentHash == bytes32(0) || kemEnvelope.length == 0) {
            revert InvalidAmounts();
        }
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (usedCommitments[commitmentHash]) revert CommitmentAlreadyUsed();

        intentId = nextIntentId++;
        bytes32 kemEnvelopeHash = keccak256(kemEnvelope);

        intents[intentId] = SealedIntent({
            owner: msg.sender,
            agent: agent,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            maxAmountIn: maxAmountIn,
            deadline: deadline,
            commitmentHash: commitmentHash,
            kemEnvelopeHash: kemEnvelopeHash,
            status: IntentStatus.Armed
        });

        emit SealedIntentRegistered(
            intentId,
            msg.sender,
            agent,
            tokenIn,
            tokenOut,
            maxAmountIn,
            deadline,
            commitmentHash,
            kemEnvelopeHash,
            kemEnvelope
        );
    }

    /// @notice Cancels an armed intent so it can no longer be settled.
    function cancelSealedIntent(uint256 intentId) external {
        SealedIntent storage intent = intents[intentId];
        if (intent.status == IntentStatus.None) revert IntentNotFound();
        if (intent.status != IntentStatus.Armed) revert IntentNotArmed();
        if (msg.sender != intent.owner) revert UnauthorizedCaller();

        intent.status = IntentStatus.Cancelled;
        emit SealedIntentCancelled(intentId, intent.owner);
    }

    /// @notice Computes the canonical commitment digest verified via QoreChain's ML-DSA-87 precompile.
    function computeCommitmentDigest(
        address owner,
        bytes32 salt,
        address tokenIn,
        address tokenOut,
        uint256 maxAmountIn,
        uint256 minAmountOut,
        uint64 deadline
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    owner,
                    salt,
                    tokenIn,
                    tokenOut,
                    maxAmountIn,
                    minAmountOut,
                    deadline
                )
            );
    }

    /// @notice Constant-product swap quote against current on-chain vault reserves.
    function quotePoolOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) public view returns (uint256 amountOut) {
        uint256 reserveIn = poolReserves[tokenIn];
        uint256 reserveOut = poolReserves[tokenOut];
        if (reserveIn == 0 || reserveOut == 0) {
            revert InsufficientPoolLiquidity(tokenOut, reserveOut);
        }
        uint256 amountInWithFee = amountIn * (BPS_DENOM - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * BPS_DENOM) + amountInWithFee;
        amountOut = numerator / denominator;
        if (amountOut == 0 || amountOut >= reserveOut) {
            revert InsufficientPoolLiquidity(tokenOut, reserveOut);
        }
    }

    /// @notice Read-only helper checking PQC key registration, possession proof, and ML-DSA-87 signature.
    function checkOwnerPqcSignature(
        address owner,
        bytes32 digest,
        bytes calldata ownerPqPubkey,
        bytes calldata ownerPqSignature
    ) external view returns (bool keyReady, bool signatureValid) {
        (bool registered, uint8 algorithmId, bytes memory onChainPubkey, bool possessionProven) =
            IQorePQC(_pqcKeyStatusAddress()).pqcKeyStatus(owner);

        keyReady =
            registered &&
            possessionProven &&
            algorithmId == ML_DSA_87_ALGORITHM_ID &&
            keccak256(onChainPubkey) == keccak256(ownerPqPubkey);

        if (!keyReady) return (false, false);

        signatureValid = IQorePQC(_pqcVerifyAddress()).pqcVerify(
            ownerPqPubkey,
            ownerPqSignature,
            abi.encodePacked(digest)
        );
    }

    /// @notice Settles a sealed intent after validating caller auth, on-chain PQC precompiles,
    ///         replay guards, deadline, and slippage protection.
    function executeSealedIntent(
        uint256 intentId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes32 salt,
        bytes calldata ownerPqPubkey,
        bytes calldata ownerPqSignature,
        bytes calldata sealedReceipt
    ) external returns (uint256 amountOut) {
        SealedIntent storage intent = intents[intentId];
        if (intent.status == IntentStatus.None) revert IntentNotFound();
        if (intent.status != IntentStatus.Armed) revert IntentNotArmed();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (msg.sender != intent.owner && msg.sender != intent.agent) {
            revert UnauthorizedCaller();
        }
        if (amountIn == 0 || amountIn > intent.maxAmountIn) revert InvalidAmounts();

        bytes32 digest = computeCommitmentDigest(
            intent.owner,
            salt,
            intent.tokenIn,
            intent.tokenOut,
            intent.maxAmountIn,
            minAmountOut,
            intent.deadline
        );
        if (digest != intent.commitmentHash) revert CommitmentMismatch();
        if (usedCommitments[digest]) revert CommitmentAlreadyUsed();

        _requireValidOwnerPqc(intent.owner, digest, ownerPqPubkey, ownerPqSignature);

        amountOut = quotePoolOut(intent.tokenIn, intent.tokenOut, amountIn);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        intent.status = IntentStatus.Executed;
        usedCommitments[digest] = true;

        _safeTransferFrom(intent.tokenIn, intent.owner, address(this), amountIn);
        poolReserves[intent.tokenIn] += amountIn;
        poolReserves[intent.tokenOut] -= amountOut;
        _safeTransfer(intent.tokenOut, intent.owner, amountOut);

        emit SealedIntentSettled(
            intentId,
            intent.owner,
            msg.sender,
            intent.tokenIn,
            intent.tokenOut,
            amountIn,
            amountOut,
            keccak256(sealedReceipt),
            sealedReceipt
        );
    }

    function _requireValidOwnerPqc(
        address owner,
        bytes32 digest,
        bytes calldata ownerPqPubkey,
        bytes calldata ownerPqSignature
    ) internal view {
        (bool registered, uint8 algorithmId, bytes memory onChainPubkey, bool possessionProven) =
            IQorePQC(_pqcKeyStatusAddress()).pqcKeyStatus(owner);

        if (!registered) revert PqcKeyNotRegistered();
        if (!possessionProven) revert PqcPossessionUnproven();
        if (algorithmId != ML_DSA_87_ALGORITHM_ID) revert PqcWrongAlgorithm(algorithmId);
        if (keccak256(onChainPubkey) != keccak256(ownerPqPubkey)) revert PqcPubkeyMismatch();

        bool valid = IQorePQC(_pqcVerifyAddress()).pqcVerify(
            ownerPqPubkey,
            ownerPqSignature,
            abi.encodePacked(digest)
        );
        if (!valid) revert InvalidMlDsaSignature();
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        bool ok = IERC20Minimal(token).transfer(to, value);
        if (!ok) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        bool ok = IERC20Minimal(token).transferFrom(from, to, value);
        if (!ok) revert TransferFailed();
    }
}
