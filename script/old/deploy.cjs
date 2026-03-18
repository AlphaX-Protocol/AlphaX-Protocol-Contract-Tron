const { TronWeb } = require('tronweb');
const { writeFileSync } = require('fs');
const { join } = require('path');

require('dotenv').config();

const waitforTxConfirmation = require('../utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('../utils/compile.cjs');
const { networks, decodeErrorMessage } = require('../utils/common.cjs');

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Please use 'mainnet' or 'nile'.`);
  }

  if (!DEPLOYER_PRIVATE_KEY) {
    console.error("DEPLOYER_PRIVATE_KEY is not set in .env file.");
    process.exit(1);
  }

  const tronWeb = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    DEPLOYER_PRIVATE_KEY
  );

  const deployerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);
  console.log(`Deploying contracts with account: ${deployerAddress} on ${networkConfig.name}`);
  const usdtAddress = networkConfig.usdtAddress;

  // --- Ensure deployer account exists and has balance (required on TRON) ---
  let account;
  try {
    account = await tronWeb.trx.getAccount(deployerAddress);
  } catch (e) {
    account = null;
  }
  const hasAccount = account && (account.address || account.balance !== undefined);
  const balanceSun = hasAccount && account.balance != null ? Number(account.balance) : 0;
  if (!hasAccount || balanceSun === 0) {
    const faucetHint = NETWORK === 'nile'
      ? '\n\nOn Nile Testnet, the account must be activated with test TRX first. Get test TRX from a faucet, e.g.:\n  https://nileex.io/join/getJoinPage\n  https://faucet.triangleplatform.com/tron/nile\nThen send test TRX to: ' + deployerAddress
      : '\n\nEnsure the deployer address has been activated (has received TRX) and has enough balance for deployment.';
    throw new Error(`Deployer account [${deployerAddress}] does not exist or has no balance on ${networkConfig.name}.${faucetHint}`);
  }

  // --- Compile Contracts ---
  const artifacts = compileContracts(['core', 'vault']);

  // --- 1. Deploy DEXVaultV1 ---
  const DEXVaultV1Artifact = artifacts.DEXVaultV1;
  console.log("Deploying DEXVaultV1...");
  const dexVaultUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: DEXVaultV1Artifact.abi,
      bytecode: DEXVaultV1Artifact.bytecode,
      feeLimit: 1000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    deployerAddress
  );

  const dexVaultSignedTx = await tronWeb.trx.sign(dexVaultUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const dexVaultBroadcast = await tronWeb.trx.sendRawTransaction(dexVaultSignedTx);

  if (!dexVaultBroadcast.result) {
    const msg = decodeErrorMessage(dexVaultBroadcast.message || dexVaultBroadcast.code);
    throw new Error(`DEXVaultV1 Deployment failed: ${msg}`);
  }
  console.log(`DEXVaultV1 Deployment TxID: ${dexVaultBroadcast.txid}`);
  
  const dexVaultTxInfo = await waitforTxConfirmation(tronWeb, dexVaultBroadcast.txid);
  const dexVaultAddress = dexVaultTxInfo.contractAddress;
  console.log(`DEXVaultV1 deployed at: ${dexVaultAddress}`);

  // --- Initialize DEXVaultV1 ---
  console.log("Initializing DEXVaultV1...");
  
  const signerUserAddress = USER_PRIVATE_KEY ? tronWeb.address.fromPrivateKey(USER_PRIVATE_KEY) : deployerAddress;
  const signers = [
      deployerAddress,
      signerUserAddress,
      "TH4mWB3dSF5R3UiZw67Qm27TYTC8jXkNyA"
  ];
  
  const withdrawUSDTLimit = "10000000000"; // 10,000 USDT
  const withdrawETHLimit = "1000000000";   // 1,000 TRX

  console.log("Simulating DEXVaultV1 initialize transaction...");
  const initTransaction = await tronWeb.transactionBuilder.triggerSmartContract(
    dexVaultAddress,
    "initialize(address[],address,uint256,uint256)",
    {
      feeLimit: 500_000_000,
      callValue: 0
    },
    [
      { type: 'address[]', value: signers },
      { type: 'address', value: usdtAddress },
      { type: 'uint256', value: withdrawUSDTLimit },
      { type: 'uint256', value: withdrawETHLimit }
    ],
    deployerAddress
  );

  if (!initTransaction.result || !initTransaction.result.result) {
    const revertReason = initTransaction.result && initTransaction.result.message ? tronWeb.toUtf8(initTransaction.result.message) : "Unknown revert reason";
    throw new Error(`DEXVaultV1 Initialize simulation failed: ${revertReason}`);
  }

  console.log("Simulation successful. Signing and broadcasting...");
  const signedInitTx = await tronWeb.trx.sign(initTransaction.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastInit = await tronWeb.trx.sendRawTransaction(signedInitTx);

  if (!broadcastInit.result) {
    const rawMsg = broadcastInit.message || broadcastInit.code;
    const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, '')) ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
    throw new Error(`Broadcast failed: ${msg}`);
  }
  console.log(`DEXVaultV1 Initialize TxID: ${broadcastInit.txid}`);
  await waitforTxConfirmation(tronWeb, broadcastInit.txid);

  // --- 2. Deploy GasFreeController (with vault in constructor) ---
  const GasFreeControllerArtifact = artifacts.GasFreeController;

  const EIP712_DOMAIN_NAME = "GasFreeController";
  const EIP712_DOMAIN_VERSION = "V1.0.0";

  console.log("Deploying GasFreeController...");
  const vaultAddressHex = tronWeb.address.toHex(dexVaultAddress);
  console.log("vaultAddressHex:", vaultAddressHex);

  const controllerUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: GasFreeControllerArtifact.abi,
      bytecode: GasFreeControllerArtifact.bytecode,
      parameters: [EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, vaultAddressHex],
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
      feeLimit: 500_000_000,
    },
    deployerAddress
  );

  const controllerSignedTx = await tronWeb.trx.sign(controllerUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const controllerTxResult = await tronWeb.trx.sendRawTransaction(controllerSignedTx);
  if (controllerTxResult.code && controllerTxResult.message) {
    const msg = decodeErrorMessage(controllerTxResult.message);
    throw new Error(`Failed to send GasFreeController transaction: ${msg} (Code: ${controllerTxResult.code})`);
  }
  const controllerTxId = controllerTxResult.txid;

  const controllerTxInfo = await waitforTxConfirmation(tronWeb, controllerTxId);
  if (!controllerTxInfo.contractAddress) {
    throw new Error("GasFreeController contract address not found in transaction receipt.");
  }
  const controllerAddress = controllerTxInfo.contractAddress;
  console.log("GasFreeController deployed to:", controllerAddress);

  // --- 3. Set initial fees for GasFreeController ---
  console.log("Setting initial fees for GasFreeController...");
  const controllerInstance = await tronWeb.contract(GasFreeControllerArtifact.abi, controllerAddress);
  const activateFee = tronWeb.toSun('1', 'TRC20'); // 1 USDT
  const transferFee = tronWeb.toSun('1', 'TRC20'); // 1 USDT for TRC20
  const transferFeeTRX = tronWeb.toSun('1'); // 1 TRX (in sun)

  const setFeesTxId = await controllerInstance.setFees(activateFee, transferFee, transferFeeTRX).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setFeesTxId);
  console.log("GasFreeController fees set transaction ID:", setFeesTxId);

  // --- 4. Deploy GasFreeFactory ---
  const GasFreeFactoryArtifact = artifacts.GasFreeFactory;

  console.log("Deploying GasFreeFactory...");
  const factoryUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: GasFreeFactoryArtifact.abi,
      bytecode: GasFreeFactoryArtifact.bytecode,
      parameters: [],
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
      feeLimit: 500_000_000,
    },
    deployerAddress
  );

  const factorySignedTx = await tronWeb.trx.sign(factoryUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const factoryTxResult = await tronWeb.trx.sendRawTransaction(factorySignedTx);
  if (factoryTxResult.code && factoryTxResult.message) {
    const msg = decodeErrorMessage(factoryTxResult.message);
    throw new Error(`Failed to send GasFreeFactory transaction: ${msg} (Code: ${factoryTxResult.code})`);
  }
  const factoryTxId = factoryTxResult.txid;

  const factoryTxInfo = await waitforTxConfirmation(tronWeb, factoryTxId);
  if (!factoryTxInfo.contractAddress) {
    throw new Error("GasFreeFactory contract address not found in transaction receipt.");
  }
  const factoryAddress = factoryTxInfo.contractAddress;
  console.log("GasFreeFactory deployed to:", factoryAddress);

  // --- 5. Set the correct controller address in GasFreeFactory ---
  console.log("Setting controller address in GasFreeFactory...");
  const factoryInstance = await tronWeb.contract(GasFreeFactoryArtifact.abi, factoryAddress);
  const setControllerTxId = await factoryInstance.setController(controllerAddress).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setControllerTxId);
  console.log("GasFreeFactory controller set transaction ID:", setControllerTxId);

  // --- 6. Create an initial GasFreeAccount for the deployer ---
  console.log("Creating initial GasFreeAccount for deployer:", deployerAddress);
  let userGasFreeAccountAddress;

  try {
    const txid = await factoryInstance.createAccount(deployerAddress, 0).send({
      feeLimit: 1_000_000_000,
      callValue: 0,
      originEnergyLimit: 0,
      shouldPollResponse: false,
    });
    console.log(`Account creation transaction sent. TxID: ${txid}`);
    const txInfo = await waitforTxConfirmation(tronWeb, txid);
    userGasFreeAccountAddress = tronWeb.address.fromHex(await factoryInstance.getAddress(deployerAddress, 0).call());
    if (!userGasFreeAccountAddress) {
      throw new Error("GasFreeAccount address not found in transaction receipt.");
    }
    console.log(`GasFreeAccount created successfully at ${userGasFreeAccountAddress}`);
  } catch (error) {
    console.error(`Error creating GasFreeAccount for ${deployerAddress}:`, error);
    process.exit(1);
  }


  console.log("Deployment complete!");

  // --- 7. Save deployed addresses to JSON file ---
  const deployedAddresses = {
    factoryAddress: factoryAddress,
    controllerAddress: controllerAddress,
    userGasFreeAccountAddress: userGasFreeAccountAddress,
    nileUsdtAddress: usdtAddress, // Keep key for compatibility
    dexVaultAddress: dexVaultAddress
  };
  const deployedAddressesPath = join(__dirname, `../../deployed-addresses.${NETWORK}.json`);
  writeFileSync(deployedAddressesPath, JSON.stringify(deployedAddresses, null, 2), 'utf8');
  console.log(`Deployed addresses saved to ${deployedAddressesPath}`);



    // --- 8. Send 33 USDT and 33 TRX to the userGasFreeAccountAddress ---
    const fundAmountUsdt = '33000000'; // 33 USDT (6 decimals)
    const fundAmountTrx = tronWeb.toSun('33'); // 33 TRX in sun
  
    console.log(`Sending 33 USDT to ${userGasFreeAccountAddress}...`);
    const userGasFreeAccountAddressHex = tronWeb.address.toHex(userGasFreeAccountAddress);
    const usdtTransferTx = await tronWeb.transactionBuilder.triggerSmartContract(
      usdtAddress,
      "transfer(address,uint256)",
      { feeLimit: 100_000_000, callValue: 0 },
      [
        { type: 'address', value: userGasFreeAccountAddressHex },
        { type: 'uint256', value: fundAmountUsdt }
      ],
      deployerAddress
    );
    if (!usdtTransferTx.result || !usdtTransferTx.result.result) {
      const reason = usdtTransferTx.result && usdtTransferTx.result.message ? tronWeb.toUtf8(usdtTransferTx.result.message) : "Unknown";
      throw new Error(`USDT transfer simulation failed: ${reason}`);
    }
    const signedUsdtTx = await tronWeb.trx.sign(usdtTransferTx.transaction, DEPLOYER_PRIVATE_KEY);
    const usdtBroadcast = await tronWeb.trx.sendRawTransaction(signedUsdtTx);
    if (!usdtBroadcast.result) {
      const rawMsg = usdtBroadcast.message || usdtBroadcast.code;
      const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, '')) ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
      throw new Error(`USDT transfer broadcast failed: ${msg}`);
    }
    await waitforTxConfirmation(tronWeb, usdtBroadcast.txid);
    console.log(`33 USDT sent to ${userGasFreeAccountAddress}. TxID: ${usdtBroadcast.txid}`);
  
    console.log(`Sending 33 TRX to ${userGasFreeAccountAddress}...`);
    const trxTransferTx = await tronWeb.transactionBuilder.sendTrx(
      userGasFreeAccountAddress,
      fundAmountTrx,
      deployerAddress
    );
    const signedTrxTx = await tronWeb.trx.sign(trxTransferTx, DEPLOYER_PRIVATE_KEY);
    const trxBroadcast = await tronWeb.trx.sendRawTransaction(signedTrxTx);
    if (!trxBroadcast.result) {
      const rawMsg = trxBroadcast.message || trxBroadcast.code;
      const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, '')) ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
      throw new Error(`TRX transfer broadcast failed: ${msg}`);
    }
    await waitforTxConfirmation(tronWeb, trxBroadcast.txid);
    console.log(`33 TRX sent to ${userGasFreeAccountAddress}. TxID: ${trxBroadcast.txid}`);
  


  return {
    factoryAddress: factoryAddress,
    controllerAddress: controllerAddress,
    dexVaultAddress: dexVaultAddress
  };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = main;
