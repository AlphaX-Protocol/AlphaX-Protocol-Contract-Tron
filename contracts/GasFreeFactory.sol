// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GasFreeAccount.sol";

/**
 * @title GasFreeFactory
 * @author Gemini
 * @notice A factory to deploy GasFreeAccount contracts using CREATE2.
 * This allows for the deterministic calculation of account addresses before they are deployed.
 */
contract GasFreeFactory {
    /// @notice The address of the central controller, passed to each new account.
    address public controller; // Removed immutable

    address public owner; // Added owner
    mapping(address => mapping(uint256 => bool)) public isAccountCreated; // New mapping
    mapping(address => mapping(uint256 => address)) public accounts;
    event OwnerUpdated(address indexed newOwner); // Added event

    modifier onlyOwner() { // Added onlyOwner modifier
        require(msg.sender == owner, "GasFreeFactory: Caller is not the owner");
        _;
    }

    /**
     * @notice Emitted when a new GasFreeAccount is deployed.
     * @param user The EOA of the account owner.
     * @param accountAddress The newly created account address.
     * @param salt A value used to generate a unique address.
     */
    event AccountCreated(address indexed user, address accountAddress, uint256 salt);

    constructor() { // Removed _controller from constructor
        owner = msg.sender; // Set owner on deployment
    }

    // Added setController function
    function setController(address _controller) external onlyOwner {
        require(_controller != address(0), "GasFreeFactory: _controller cannot be zero address");
        controller = _controller;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "GasFreeFactory: New owner is the zero address");
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /**
     * @notice Deploys a new GasFreeAccount for a user with a given salt.
     * @dev Uses CREATE2 for deterministic address generation.
     * @param user The user's EOA who will own the new account.
     * @param salt The salt for CREATE2, allowing for multiple accounts per user if needed.
     * @return accountAddress The address of the newly created account.
     */
    function createAccount(address user, uint256 salt) external returns (address accountAddress) {
        require(controller != address(0), "GasFreeFactory: Controller not set");
        require(!isAccountCreated[user][salt], "GasFreeFactory: Account already exists for this user and salt"); // New check

        bytes32 create2Salt = keccak256(abi.encodePacked(user, salt));
        
        GasFreeAccount newAccount = new GasFreeAccount{salt: create2Salt}(user, controller);
        accountAddress = address(newAccount);

        isAccountCreated[user][salt] = true; // Set mapping to true
        accounts[user][salt] = accountAddress;
        emit AccountCreated(user, accountAddress, salt);
    }

    /**
     * @notice Calculates the deterministic address for a user's account.
     * @param user The user's EOA.
     * @param salt The salt used for the account.
     * @return The pre-computed address of the GasFreeAccount.
     */
    function getAddress(address user, uint256 salt) public view returns (address) {
        return accounts[user][salt];
    }

    /**
     * @notice Returns the keccak256 hash of the GasFreeAccount's creation code.
     * @dev This is used by off-chain tools to ensure consistent CREATE2 address prediction.
     */
    function getGasFreeAccountCreationCodeHash() public pure returns (bytes32) {
        return keccak256(type(GasFreeAccount).creationCode);
    }
}
