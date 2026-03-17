// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../DEXVaultV1.sol";

/// @dev Minimal V2 for testing UUPS upgrade – adds a version getter.
contract DEXVaultV2 is DEXVaultV1 {
    function version() public pure returns (string memory) {
        return "V2";
    }
}
