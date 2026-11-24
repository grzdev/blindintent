// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {BlindIntentVault} from "../BlindIntentVault.sol";

/// @notice Hardhat test harness redirecting PQC precompile lookups to `MockQorePQC`.
contract TestableBlindIntentVault is BlindIntentVault {
    address public immutable mockPqc;

    constructor(address _mockPqc) {
        mockPqc = _mockPqc;
    }

    function _pqcVerifyAddress() internal view override returns (address) {
        return mockPqc;
    }

    function _pqcKeyStatusAddress() internal view override returns (address) {
        return mockPqc;
    }
}
