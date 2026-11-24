// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IQorePQC
/// @notice Official interface for QoreChain's built-in Post-Quantum Cryptography EVM precompiles.
/// @dev Precompile addresses must remain lowercase in Solidity source to avoid checksum failures.
interface IQorePQC {
    /// @notice Verifies a raw ML-DSA-87 (FIPS 204) signature against `pubkey` and `message`.
    /// @dev Address: 0x0000000000000000000000000000000000000a01
    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid);

    /// @notice Queries an account's on-chain ML-DSA-87 key registration and proof-of-possession status.
    /// @dev Address: 0x0000000000000000000000000000000000000a02
    function pqcKeyStatus(address account)
        external
        view
        returns (
            bool registered,
            uint8 algorithmId,
            bytes memory pubkey,
            bool possessionProven
        );
}
