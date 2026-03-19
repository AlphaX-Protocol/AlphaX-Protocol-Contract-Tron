// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./lib/IERC20.sol";
import "./interfaces/IGasFreeAccount.sol";

interface IDEXVault {
    function depositERC20(address token, uint256 amount, address receiver) external;
    function depositETH(address receiver) external payable;
}

/**
 * @title GasFreeController
 * @author Gemini
 * @notice This contract acts as a relayer for gasless transfers. It verifies EIP712
 * signatures from users, creates their smart contract wallets (GasFreeAccount) on
 * their behalf, and executes token transfers. The party calling `executePermitTransfer`
 * (the Service Provider) pays the gas fees.
 */
contract GasFreeController is EIP712, ReentrancyGuard {
    /// @dev EIP712 type hash for the PermitTransfer struct.
    bytes32 private constant PERMIT_TRANSFER_TYPEHASH = keccak256(
        "PermitTransfer(address token,address serviceProvider,address user,address receiver,address gasFreeAddress,uint256 value,uint256 maxFee,uint256 deadline,uint256 version,uint256 nonce)"
    );

    /// @dev Matches the structure in the GasFree documentation for signature verification.
    struct PermitTransfer {
        address token;
        address serviceProvider;
        address user;
        address receiver;
        address gasFreeAddress;
        uint256 value;
        uint256 maxFee;
        uint256 deadline;
        uint256 version;
        uint256 nonce;
    }
    
    /// @notice Per-user nonces to prevent signature replay attacks.
    mapping(address => uint256) public nonces;

    /// @notice Tracks which tokens have been approved for which user account.
    mapping(address => mapping(address => bool)) public tokenApprovals;

    /// @notice The vault address that can receive deposits (updatable by owner).
    address public vault;

    /// @notice The owner of the controller, who can set fees.
    address public owner;
    
    /// @notice The fee (in token units) for activating a new account.
    uint256 public activateFee;

    /// @notice The fee (in token units) for each TRC20 transfer.
    uint256 public transferFee;

    /// @notice The fee (in sun) for each TRX transfer/deposit.
    uint256 public transferFeeTRX;

    event OwnerUpdated(address indexed newOwner);
    event FeesUpdated(uint256 activateFee, uint256 transferFee, uint256 transferFeeTRX);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event TransferExecuted(
        address indexed user,
        address indexed serviceProvider,
        address token,
        address receiver,
        uint256 value,
        uint256 fee
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "GasFreeController: Caller is not the owner");
        _;
    }

    /**
     * @param name The EIP712 domain name (e.g., "GasFreeController").
     * @param version The EIP712 domain version (e.g., "V1.0.0").
     * @param _vault The address of the DEXVault contract.
     */
    constructor(string memory name, string memory version, address _vault) EIP712(name, version) {
        vault = _vault;
        owner = msg.sender;
    }

    /**
     * @notice Sets the fees for activation and transfers.
     * @dev activateFee/transferFee in token smallest units; transferFeeTRX in sun.
     * @param _activateFee The new fee for account activation.
     * @param _transferFee The new fee for each TRC20 transfer.
     * @param _transferFeeTRX The new fee (in sun) for each TRX transfer/deposit.
     */
    function setFees(uint256 _activateFee, uint256 _transferFee, uint256 _transferFeeTRX) external onlyOwner {
        activateFee = _activateFee;
        transferFee = _transferFee;
        transferFeeTRX = _transferFeeTRX;
        emit FeesUpdated(_activateFee, _transferFee, _transferFeeTRX);
    }
    
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "GasFreeController: New owner is the zero address");
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /**
     * @notice Update the vault address.
     * @param _vault The new vault contract address.
     */
    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "GasFreeController: vault is zero address");
        address oldVault = vault;
        vault = _vault;
        emit VaultUpdated(oldVault, _vault);
    }

    /**
     * @notice Allows the controller owner to trigger an approveToken call on a user's GasFreeAccount.
     * @param gasFreeAccountAddress The address of the user's GasFreeAccount.
     * @param _token The address of the token to approve.
     */
    function approveTokenOnAccount(address gasFreeAccountAddress, address _token) external onlyOwner {
        // The caller (controller owner) is responsible for providing the correct gasFreeAccountAddress.
        IGasFreeAccount(gasFreeAccountAddress).approveToken(_token);
        tokenApprovals[gasFreeAccountAddress][_token] = true;
    }

    /**
     * @notice Verifies a user's signed permit and executes the transfer.
     * @dev This is the main entry point for the Service Provider.
     * @param permit The structured data containing transfer details.
     * @param signature The user's EIP712 signature for the permit.
     */
    function executePermitTransfer(PermitTransfer calldata permit, bytes calldata signature) external nonReentrant {
        require(permit.deadline >= block.timestamp, "GasFreeController: Permit expired");
        require(permit.token != address(0), "GasFreeController: Use TRC20 tokens only");
        bytes32 structHash = _hashPermit(permit);
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        
        require(signer == permit.user && signer != address(0), "GasFreeController: Invalid signature");
        require(nonces[permit.user] == permit.nonce, "GasFreeController: Invalid nonce");
        require(IGasFreeAccount(permit.gasFreeAddress).owner() == permit.user, "GasFreeController: account not owned by user");
        
        nonces[permit.user]++;
        
        uint256 totalFee = transferFee;

        require(permit.maxFee >= totalFee, "GasFreeController: maxFee exceeded");

        if (!tokenApprovals[permit.gasFreeAddress][permit.token]) {
            IGasFreeAccount(permit.gasFreeAddress).approveToken(permit.token);
            tokenApprovals[permit.gasFreeAddress][permit.token] = true;
        }
        
        uint256 totalCost = permit.value + totalFee;
        IERC20 token = IERC20(permit.token);
        require(token.balanceOf(permit.gasFreeAddress) >= totalCost, "GasFreeController: Insufficient balance");

        token.transferFrom(permit.gasFreeAddress, permit.receiver, permit.value);
        token.transferFrom(permit.gasFreeAddress, permit.serviceProvider, totalFee);

        emit TransferExecuted(permit.user, permit.serviceProvider, permit.token, permit.receiver, permit.value, totalFee);
    }

    /**
     * @notice Verifies a user's signed permit and executes a deposit to the DEXVault.
     * @param permit The structured data containing transfer details.
     * @param signature The user's EIP712 signature for the permit.
     */
    function executePermitDepositVault(PermitTransfer calldata permit, bytes calldata signature) external nonReentrant {
        require(vault != address(0), "GasFreeController: vault not set");
        require(permit.deadline >= block.timestamp, "GasFreeController: Permit expired");
        
        bytes32 structHash = _hashPermit(permit);
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        
        require(signer == permit.user && signer != address(0), "GasFreeController: Invalid signature");
        require(nonces[permit.user] == permit.nonce, "GasFreeController: Invalid nonce");
        require(IGasFreeAccount(permit.gasFreeAddress).owner() == permit.user, "GasFreeController: account not owned by user");
        
        nonces[permit.user]++;
        
        uint256 totalFee = permit.token == address(0) ? transferFeeTRX : transferFee;

        require(permit.maxFee >= totalFee, "GasFreeController: maxFee exceeded");

        uint256 totalCost = permit.value + totalFee;

        if (permit.token == address(0)) {
            require(permit.gasFreeAddress.balance >= totalCost, "GasFreeController: Insufficient TRX balance");
            IGasFreeAccount account = IGasFreeAccount(permit.gasFreeAddress);
            account.transferMainCoin(permit.serviceProvider, totalFee);
            account.transferMainCoin(address(this), permit.value);
            IDEXVault(vault).depositETH{value: permit.value}(permit.receiver);
        } else {
            if (!tokenApprovals[permit.gasFreeAddress][permit.token]) {
                IGasFreeAccount(permit.gasFreeAddress).approveToken(permit.token);
                tokenApprovals[permit.gasFreeAddress][permit.token] = true;
            }
            IERC20 token = IERC20(permit.token);
            require(token.balanceOf(permit.gasFreeAddress) >= totalCost, "GasFreeController: Insufficient balance");
            token.transferFrom(permit.gasFreeAddress, permit.serviceProvider, totalFee);
            token.transferFrom(permit.gasFreeAddress, address(this), permit.value);
            token.approve(vault, permit.value);
            IDEXVault(vault).depositERC20(permit.token, permit.value, permit.receiver);
        }

        emit TransferExecuted(permit.user, permit.serviceProvider, permit.token, vault, permit.value, totalFee);
    }

    /**
     * @dev Private function to hash the PermitTransfer struct.
     */
    function _hashPermit(PermitTransfer calldata permit) private pure returns (bytes32) {
        return keccak256(abi.encode(
            PERMIT_TRANSFER_TYPEHASH,
            permit.token,
            permit.serviceProvider,
            permit.user,
            permit.receiver,
            permit.gasFreeAddress,
            permit.value,
            permit.maxFee,
            permit.deadline,
            permit.version,
            permit.nonce
        ));
    }

    /// @notice Allows the controller to receive TRX from GasFreeAccounts for vault deposit.
    receive() external payable {}
}
