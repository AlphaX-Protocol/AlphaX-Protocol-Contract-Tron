// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IGasFreeFactory.sol";
import "./MockGasFreeAccount.sol";

contract MockGasFreeFactory is IGasFreeFactory {

    function createAccount(address user, uint256 salt) external override returns (address) {
        address accountAddress = getAddress(user, salt);
        // In a real factory, it would deploy the contract.
        // Here we just emit the event. A mock account can be deployed separately in tests if needed.
        emit AccountCreated(user, accountAddress, salt);
        return accountAddress;
    }

    function getAddress(address user, uint256 salt) public view override returns (address) {
        // Use a predictable, but not overly simple, address generation scheme for the mock.
        // This avoids collisions and makes tests more realistic.
        bytes32 hash = keccak256(abi.encodePacked(user, salt, address(this)));
        return address(uint160(uint256(hash)));
    }
}
