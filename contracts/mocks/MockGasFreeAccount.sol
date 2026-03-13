// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../interfaces/IGasFreeAccount.sol";
import "../lib/IERC20.sol";

contract MockGasFreeAccount is IGasFreeAccount {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function approveToken(address token) external override {
        // In a real scenario, this would call approve on the token contract.
        // For the mock, we can just simulate the approval by approving the controller to spend the token.
        // The controller address is msg.sender in this context.
        IERC20(token).approve(msg.sender, type(uint256).max);
    }

    function controller() external pure override returns (address) {
        return address(0); // Mock implementation
    }

    function withdraw(address token, address to, uint256 amount) external override {
        // Mock implementation, does nothing
    }
}
