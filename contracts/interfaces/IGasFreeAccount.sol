// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGasFreeAccount {
    function approveToken(address token) external;
    function withdraw(address token, address to, uint256 amount) external;
    function transferMainCoin(address to, uint256 amount) external;
    function owner() external view returns (address);
    function controller() external view returns (address);
}
