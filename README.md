# TRON Gasless Transfer
A simple implementation of gasless USDT transfers on the TRON network.

## Quick Start

### 1. Install Dependencies

Install the required node modules:

```bash
npm install
# or
pnpm install
```

### 2. Configuration

Create a `.env` file in the root directory and configure your private keys:

```ini
NETWORK=nile
USER_PRIVATE_KEY=your_user_private_key
DEPLOYER_PRIVATE_KEY=your_deployer_private_key
RECIPIENT_ADDRESS=target_wallet_address
```

> **Note**: The `DEPLOYER_PRIVATE_KEY` account acts as the Relayer and must have TRX to pay for gas.

### 3. Deploy Contracts

Deploy the Factory and Controller contracts to the Nile Testnet:

```bash
node script/deploy.cjs
```

This will create a `deployed-addresses.nile.json` file (or based on your `NETWORK` setting) with the contract addresses.

### 4. prepare USDT

transfer enough USDT to GasFreeAccount contract (address is in `deployed-addresses.<network>.json`)

### 5. Execute Gasless Transfer / Deposit

Run the script to sign a permit and execute the transfer via the Relayer:

```bash
# Transfer
node script/executeGaslessTransfer.cjs

# Deposit
node script/executeGaslessDeposit.cjs
```

### 6. uups 
```bash

# deploy uups vault
node script/deployUups.cjs

# Deposit usdt
node script/executeGaslessDepositUups.cjs

# Deposit trx
node script/executeGaslessDepositTrxUups.cjs


```

