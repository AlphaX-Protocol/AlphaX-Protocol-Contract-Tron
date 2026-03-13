// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGasFreeFactory {
   event AccountCreated(address indexed user, address accountAddress, uint256 salt);
   function createAccount(address user, uint256 salt) external returns (address accountAddress);
   function getAddress(address user, uint256 salt) external view returns (address);
   function isAccountCreated(address, uint256) external view returns (bool);
}
