# Open-Source GasFree Contracts

This directory contains an open-source implementation of the on-chain logic for a gasless transfer system, based on the features described in the GasFree service documentation. It provides a replacement for the original closed-source contracts.

## Overview

The system allows a "Service Provider" to pay the gas fees for a user's token transfers. Users authorize these transfers by signing an EIP-712 message, which is then submitted to the blockchain by the Service Provider.

The core logic is split into three main contracts:

### 1. `GasFreeController.sol`

This is the main contract and the primary entry point for the system.

- **Verifies Signatures**: It validates EIP-712 signatures from users to authorize transfers.
- **Executes Transfers**: It orchestrates the movement of tokens from the user's wallet to the destination address and collects fees for the Service Provider.
- **Manages State**: It tracks nonces to prevent replay attacks and handles the activation of new user accounts.

### 2. `GasFreeAccount.sol`

This is a simple, minimal smart-contract wallet that is created for each user.

- **Holds Assets**: This contract holds the user's tokens.
- **Delegates Authority**: It grants the `GasFreeController` the authority to move tokens on the user's behalf. This approval is initiated by the controller itself during the first transaction for a specific token.
- **Owned by User**: The user's main wallet address (EOA) is the owner, with the ability to withdraw funds directly (though this requires a standard, gas-paying transaction).

### 3. `GasFreeFactory.sol`

This factory contract is responsible for deploying the `GasFreeAccount` wallets.

- **Deterministic Addresses**: It uses the `CREATE2` opcode to ensure that each user's `GasFreeAccount` address can be calculated upfront, before it is even deployed. This allows users to send funds to their GasFree address before it's officially "activated" on the chain.

## How It Works

1.  **Address Calculation**: The user's unique `GasFreeAccount` address is calculated off-chain using the `GasFreeFactory`'s `getAddress` function. The user can then send tokens (e.g., USDT) to this address.
2.  **User Signature**: The user signs an EIP-712 `PermitTransfer` message that details the recipient, amount, and max fee they are willing to pay.
3.  **Provider Submission**: The Service Provider sends a transaction to the `GasFreeController.executePermitTransfer` function, including the user's signed message. The Service Provider pays the gas for this transaction.
4.  **Controller Execution**:
    - The `GasFreeController` verifies the user's signature and nonce.
    - If this is the user's first transaction, it calls the `GasFreeFactory` to deploy the `GasFreeAccount` contract (this is the "activation").
    - If this is the first time the user is transferring a specific token, the controller calls `approveToken` on the user's `GasFreeAccount` to grant itself spending rights.
    - It then calls `transferFrom` on the token contract to move the funds from the user's `GasFreeAccount` to the final recipient and to the Service Provider's address (for the fee).
