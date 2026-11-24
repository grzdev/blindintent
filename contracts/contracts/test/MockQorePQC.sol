// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IQorePQC} from "../IQorePQC.sol";

/// @notice Local Hardhat test mock simulating QoreChain precompiles 0x...0a01 and 0x...0a02.
contract MockQorePQC is IQorePQC {
    struct Status {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
        bool possessionProven;
    }

    mapping(address => Status) private _statuses;
    mapping(bytes32 => bool) private _validSignatures;

    function setKeyStatus(
        address account,
        bool registered,
        uint8 algorithmId,
        bytes calldata pubkey,
        bool possessionProven
    ) external {
        _statuses[account] = Status({
            registered: registered,
            algorithmId: algorithmId,
            pubkey: pubkey,
            possessionProven: possessionProven
        });
    }

    function setSignatureValid(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message,
        bool isValid
    ) external {
        bytes32 k = keccak256(abi.encode(keccak256(pubkey), keccak256(signature), keccak256(message)));
        _validSignatures[k] = isValid;
    }

    function pqcVerify(
        bytes calldata pubkey,
        bytes calldata signature,
        bytes calldata message
    ) external view returns (bool valid) {
        bytes32 k = keccak256(abi.encode(keccak256(pubkey), keccak256(signature), keccak256(message)));
        return _validSignatures[k];
    }

    function pqcKeyStatus(address account)
        external
        view
        returns (
            bool registered,
            uint8 algorithmId,
            bytes memory pubkey,
            bool possessionProven
        )
    {
        Status memory s = _statuses[account];
        return (s.registered, s.algorithmId, s.pubkey, s.possessionProven);
    }
}
