// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/IERC20.sol";

/**
 * @title GasFreeAccount
 * @author Gemini
 * @notice This is a simple, non-upgradable smart contract wallet for a user.
 * It is owned by a user's EOA and controlled by the central GasFreeController.
 * Its address is deterministically calculated by the GasFreeFactory.
 */
contract GasFreeAccount {
    /// @notice The user's EOA which has withdrawal rights.
    address public immutable owner;

    /// @notice The central controller that can execute gasless transfers.
    address public immutable controller;

    /**
     * @param _owner The user's EOA (Externally Owned Account).
     * @param _controller The address of the single GasFreeController contract.
     */
    constructor(address _owner, address _controller) {
        owner = _owner;
        controller = _controller;
    }

    /**
     * @notice Allows the controller to grant itself max approval for a token.
     * This is called by the controller before the first gasless transfer of a specific token.
     * @param token The address of the TRC20/ERC20 token.
     */
    function approveToken(address token) external {
        require(msg.sender == controller, "GasFreeAccount: Caller is not the controller");
        IERC20(token).approve(controller, type(uint256).max);
    }
    
    function transferMainCoin(address to, uint256 amount) external {
        require(msg.sender == controller, "GasFreeAccount: Caller is not the controller");
        require(address(this).balance >= amount, "GasFreeAccount: Insufficient TRX balance");
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "GasFreeAccount: TRX transfer failed");
    }


    /**
     * @notice Allows the owner to withdraw TRC20 tokens or native TRX from this account.
     * Use address(0) for token to withdraw native TRX; otherwise pass the TRC20 token address.
     * The owner must pay gas for this transaction.
     * @param token The TRC20 token address, or address(0) for native TRX.
     * @param to The address to send the tokens/TRX to.
     * @param amount The amount to withdraw (in token smallest units, or sun for TRX).
     */
    function withdraw(address token, address to, uint256 amount) external {
        require(msg.sender == owner, "GasFreeAccount: Caller is not the owner");
        if (token == address(0)) {
            require(address(this).balance >= amount, "GasFreeAccount: Insufficient TRX balance");
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "GasFreeAccount: TRX transfer failed");
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            require(balance >= amount, "GasFreeAccount: Insufficient balance");
            IERC20(token).transfer(to, amount);
        }
    }


    /// @notice Allows this account to receive native TRX.
    receive() external payable {}
}
