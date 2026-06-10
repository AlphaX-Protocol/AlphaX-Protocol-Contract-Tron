const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('../utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('../utils/compile.cjs');
const { networks, toStandardHex } = require('../utils/common.cjs');

async function main() {
  // --- Configuration ---
  const USER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY; // Relayer's private key
  const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Please use 'mainnet' or 'nile'.`);
  }

  if (!USER_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY || !RECIPIENT_ADDRESS) {
    console.error("Missing one or more environment variables: USER_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY, RECIPIENT_ADDRESS.");
    process.exit(1);
  }

  // --- Load Deployed Addresses ---
  const deployedAddressesPath = join(__dirname, `../../deployed-addresses.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, 'utf8'));
    console.log(`Loaded deployed addresses from ${deployedAddressesPath}`);
  } catch (error) {
    console.error(`Error loading deployed addresses from ${deployedAddressesPath}: ${error.message}`);
    console.error("Please run deploy.cjs first to deploy contracts and save addresses.");
    process.exit(1);
  }

  const GAS_FREE_CONTROLLER_ADDRESS = deployedAddresses.controllerAddress;
  const USDT_ADDRESS = deployedAddresses.nileUsdtAddress;
  const DEX_VAULT_ADDRESS = deployedAddresses.dexVaultAddress;

  if (!GAS_FREE_CONTROLLER_ADDRESS || !USDT_ADDRESS || !DEX_VAULT_ADDRESS) {
    console.error("Missing one or more contract addresses in deployed-addresses.json: controllerAddress, nileUsdtAddress, dexVaultAddress.");
    process.exit(1);
  }

  // --- Initialize TronWeb ---
  const tronWebUser = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    USER_PRIVATE_KEY
  );

  const tronWebRelayer = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    DEPLOYER_PRIVATE_KEY
  );

  const userAddress = tronWebUser.address.fromPrivateKey(USER_PRIVATE_KEY);
  const relayerAddress = tronWebRelayer.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log("User wallet address:", userAddress);
  console.log(`Relayer wallet address: ${relayerAddress} on ${networkConfig.name}`);
  console.log("DEX Vault address:", DEX_VAULT_ADDRESS);

  // --- Compile Contracts ---
  const artifacts = compileContracts(['core']);


  // --- Attach to Controller Contract ---
  const GasFreeControllerArtifact = artifacts.GasFreeController;
  const IERC20Artifact = artifacts.IERC20;

  const controller = tronWebRelayer.contract(GasFreeControllerArtifact.abi, GAS_FREE_CONTROLLER_ADDRESS);

  // --- User-side: Prepare and Sign PermitTransfer Message ---

  // 1. Fetch current nonce for the user's GasFreeAccount
  const nonce = await controller.nonces(userAddress).call();
  console.log(`User's current nonce: ${Number(nonce)}`);

  // 2. EIP-712 Domain
  const domain = {
    name: "GasFreeController",
    version: "V1.0.0",
    chainId: networkConfig.chainId,
    verifyingContract: GAS_FREE_CONTROLLER_ADDRESS,
  };

  // 3. EIP-712 Types
  const types = {
    PermitTransfer: [
      { name: "token", type: "address" },
      { name: "serviceProvider", type: "address" },
      { name: "user", type: "address" },
      { name: "receiver", type: "address" },
      { name: "gasFreeAddress", type: "address" },
      { name: "firstTime", type: "bool" },
      { name: "value", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "version", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "operationType", type: "uint8" },
    ],
  };

  // 4. Message Data
  const transferValue = tronWebUser.toSun('10', 6); // 10 USDT
  const maxFee = tronWebUser.toSun('1', 6); // Max fee
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress;

  const message = {
    token: toStandardHex(tronWebUser, USDT_ADDRESS),
    serviceProvider: toStandardHex(tronWebUser, relayerAddress),
    user: toStandardHex(tronWebUser, userAddress),
    receiver: toStandardHex(tronWebUser, RECIPIENT_ADDRESS),
    gasFreeAddress: toStandardHex(tronWebUser, userGasFreeAccountAddress),
    firstTime: false,
    value: transferValue.toString(), 
    maxFee: maxFee.toString(),     
    deadline: deadline,
    version: 0,
    nonce: Number(nonce),
    operationType: 2,
};

  console.log("\n--- User-side: Signing PermitTransfer (Deposit) ---");
  console.log("Message to sign:", JSON.stringify(message, null, 2));

  // 5. User signs the typed data
  const signature = tronWebUser.trx.signTypedData(domain, types, message, USER_PRIVATE_KEY);
  console.log("Generated Signature:", signature);

  // --- Relayer-side: Execute PermitDepositVault ---

  console.log("\n--- Relayer-side: Executing PermitDepositVault ---");
  console.log("User's predicted GasFreeAccount address:", userGasFreeAccountAddress);


  // --- Check GasFreeAccount USDT balance ---
  const usdt = tronWebRelayer.contract(IERC20Artifact.abi, USDT_ADDRESS);
  const gasFreeAccountBalance = await usdt.balanceOf(userGasFreeAccountAddress).call();
  const gasFreeAccountBalanceFormatted = tronWebRelayer.fromSun(gasFreeAccountBalance, 6);

  if (parseFloat(gasFreeAccountBalanceFormatted) < parseFloat(tronWebRelayer.fromSun(transferValue, 6))) {
    console.error(`\n❌ Error: GasFreeAccount (${userGasFreeAccountAddress}) has insufficient USDT balance.`);
    console.error(`   Required: ${tronWebRelayer.fromSun(transferValue, 6)} USDT, Available: ${gasFreeAccountBalanceFormatted} USDT`);
    process.exit(1);
  }
      console.log(`✅ GasFreeAccount (${userGasFreeAccountAddress}) has sufficient USDT balance: ${gasFreeAccountBalanceFormatted} USDT.`);
  
  
    try {
      const permitArray = [
        toStandardHex(tronWebRelayer, message.token),
        toStandardHex(tronWebRelayer, message.serviceProvider),
        toStandardHex(tronWebRelayer, message.user),
        toStandardHex(tronWebRelayer, message.receiver),
        toStandardHex(tronWebRelayer, userGasFreeAccountAddress),
        message.firstTime,
        message.value,
        message.maxFee,
        message.deadline,
        message.version,
        message.nonce,
        message.operationType,
      ];
      let signatureHex = signature;
      if (!signatureHex.startsWith('0x')) {
          signatureHex = '0x' + signatureHex;
      }

      console.log("Simulating executePermitDepositVault call with triggerSmartContract...");
      let simulationResult = null;
      try {
        // 1. 预估 Energy 消耗
        let energyEstimate = await tronWebRelayer.transactionBuilder.estimateEnergy(
          GAS_FREE_CONTROLLER_ADDRESS,
          "executePermitDepositVault((address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8),bytes)",
          {
            callValue: 0,
          },
          [
            { type: '(address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8)', value: permitArray },
            { type: 'bytes', value: signatureHex },
          ],
          relayerAddress
        );

        if (typeof energyEstimate === 'object' && energyEstimate !== null) {
            energyEstimate = energyEstimate.energy_required || energyEstimate.energy_used || 0;
        }

        console.log(`\n🚀 Estimated Energy consumption: ${energyEstimate}`);

        const chainParams = await tronWebRelayer.trx.getChainParameters();
        const energyFeeParam = chainParams.find(p => p.key === 'getEnergyFee');
        const energyPrice = energyFeeParam ? Number(energyFeeParam.value) : 420;

        const dynamicFeeLimit = Math.floor(energyEstimate * 1.2 * energyPrice);
        console.log(`   Setting dynamic feeLimit: ${dynamicFeeLimit} Sun (${(dynamicFeeLimit / 1_000_000).toFixed(2)} TRX)\n`);
        
        simulationResult = await tronWebRelayer.transactionBuilder.triggerSmartContract(
          GAS_FREE_CONTROLLER_ADDRESS,
          "executePermitDepositVault((address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8),bytes)",
          {
            callValue: 0,
            feeLimit: dynamicFeeLimit,
          },
          [
            { type: '(address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8)', value: permitArray },
            { type: 'bytes', value: signatureHex },
          ],
          relayerAddress
        );

        if (simulationResult && simulationResult.result && simulationResult.result.result === false) {
            const revertReason = simulationResult.result.message ? tronWebRelayer.toUtf8(simulationResult.result.message) : "Unknown revert reason";
            throw new Error(`Transaction simulation failed with revert: ${revertReason}`);
        }
        console.log("Simulation successful. Transaction is expected to succeed.");
      } catch (simError) {
        simulationResult = null;
        console.error("Transaction simulation failed:", simError.message || simError);
        console.error("Aborting transaction to avoid unnecessary TRX consumption.");
        process.exit(1);
      }
      
      if (!simulationResult) {
        console.error("Transaction simulation failed. simulationResult is undefined.");
        process.exit(1);
      }

      const signedTransaction = await tronWebRelayer.trx.sign(
          simulationResult.transaction, 
          DEPLOYER_PRIVATE_KEY
      );

      const broadcastResult = await tronWebRelayer.trx.sendRawTransaction(signedTransaction);

      if (broadcastResult.result) {
          console.log("✅ 交易广播成功！TxID:", broadcastResult.txid);
          await waitforTxConfirmation(tronWebRelayer, broadcastResult.txid);
      } else {
          console.error("❌ 广播失败:", tronWebRelayer.toUtf8(broadcastResult.message));
      }
  
      // Verify balances
      const userGasFreeAccountBalanceAfter = await usdt.balanceOf(userGasFreeAccountAddress).call();
      const vaultBalance = await usdt.balanceOf(DEX_VAULT_ADDRESS).call();
      const relayerBalance = await usdt.balanceOf(relayerAddress).call();
  
      console.log(`\n--- Balances After Deposit ---`);
      console.log(`User's GasFreeAccount balance: ${tronWebRelayer.fromSun(userGasFreeAccountBalanceAfter, 6)} USDT`);
      console.log(`DEX Vault (${DEX_VAULT_ADDRESS}) balance: ${tronWebRelayer.fromSun(vaultBalance, 6)} USDT`);
      console.log(`Relayer (${relayerAddress}) balance: ${tronWebRelayer.fromSun(relayerBalance, 6)} USDT (includes fees)`);
  
    } catch (error) {
      console.error("Error executing PermitDepositVault:", error);
      if (error.reason) {
          console.error("Revert Reason:", error.reason);
      }
      if (error.message && error.message.includes("revert")) {
          console.error("Raw Error Message:", error.message);
      }
      process.exit(1);
    }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });