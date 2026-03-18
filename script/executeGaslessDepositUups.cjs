const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('./utils/compile.cjs');
const { networks, toStandardHex } = require('./utils/common.cjs');

async function main() {
  const USER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}.`);
  if (!USER_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY || !RECIPIENT_ADDRESS) {
    console.error("Missing env vars: DEPLOYER_PRIVATE_KEY, RECIPIENT_ADDRESS.");
    process.exit(1);
  }

  const deployedAddressesPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, 'utf8'));
    console.log(`Loaded addresses from ${deployedAddressesPath}`);
  } catch (error) {
    console.error(`Error: ${error.message}\nRun deployUups.cjs first.`);
    process.exit(1);
  }

  const GAS_FREE_CONTROLLER_ADDRESS = deployedAddresses.controllerAddress;
  const USDT_ADDRESS = deployedAddresses.nileUsdtAddress;
  const DEX_VAULT_ADDRESS = deployedAddresses.dexVaultProxy;
  const userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress;

  if (!GAS_FREE_CONTROLLER_ADDRESS || !USDT_ADDRESS || !DEX_VAULT_ADDRESS) {
    console.error("Missing addresses in deployed-addresses-uups.json.");
    process.exit(1);
  }

  const tronWebUser = new TronWeb(networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, USER_PRIVATE_KEY);
  const tronWebRelayer = new TronWeb(networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, DEPLOYER_PRIVATE_KEY);

  const userAddress = tronWebUser.address.fromPrivateKey(USER_PRIVATE_KEY);
  const relayerAddress = tronWebRelayer.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log("User wallet:", userAddress);
  console.log("Relayer wallet:", relayerAddress, `(${networkConfig.name})`);
  console.log("DEX Vault proxy:", DEX_VAULT_ADDRESS);

  const artifacts = compileContracts(['core']);
  const controller = tronWebRelayer.contract(artifacts.GasFreeController.abi, GAS_FREE_CONTROLLER_ADDRESS);
  const usdt = tronWebRelayer.contract(artifacts.IERC20.abi, USDT_ADDRESS);

  const nonce = await controller.nonces(userAddress).call();
  console.log(`User's current nonce: ${Number(nonce)}`);

  const domain = {
    name: "GasFreeController",
    version: "V1.0.0",
    chainId: networkConfig.chainId,
    verifyingContract: GAS_FREE_CONTROLLER_ADDRESS,
  };

  const types = {
    PermitTransfer: [
      { name: "token", type: "address" },
      { name: "serviceProvider", type: "address" },
      { name: "user", type: "address" },
      { name: "receiver", type: "address" },
      { name: "gasFreeAddress", type: "address" },
      { name: "value", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "version", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const transferValue = tronWebUser.toSun('10', 6); // 10 USDT
  const maxFee = tronWebUser.toSun('1', 6);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const message = {
    token: toStandardHex(tronWebUser, USDT_ADDRESS),
    serviceProvider: toStandardHex(tronWebUser, relayerAddress),
    user: toStandardHex(tronWebUser, userAddress),
    receiver: toStandardHex(tronWebUser, RECIPIENT_ADDRESS),
    gasFreeAddress: toStandardHex(tronWebUser, userGasFreeAccountAddress),
    value: transferValue.toString(),
    maxFee: maxFee.toString(),
    deadline: deadline,
    version: 0,
    nonce: Number(nonce),
  };

  console.log("Message to sign:", JSON.stringify(message, null, 2));

  const signature = tronWebUser.trx.signTypedData(domain, types, message, USER_PRIVATE_KEY);
  console.log("Generated Signature:", signature);

  // Check balance
  const gasFreeAccountBalance = await usdt.balanceOf(userGasFreeAccountAddress).call();
  const gasFreeAccountBalanceFormatted = tronWebRelayer.fromSun(gasFreeAccountBalance, 6);
  if (parseFloat(gasFreeAccountBalanceFormatted) < parseFloat(tronWebRelayer.fromSun(transferValue, 6))) {
    console.error(`Error: GasFreeAccount (${userGasFreeAccountAddress}) has insufficient USDT balance.`);
    console.error(`   Required: ${tronWebRelayer.fromSun(transferValue, 6)} USDT, Available: ${gasFreeAccountBalanceFormatted} USDT`);
    process.exit(1);
  }
  console.log(`GasFreeAccount balance: ${gasFreeAccountBalanceFormatted} USDT (sufficient)`);

  const permitArray = [
    toStandardHex(tronWebRelayer, message.token),
    toStandardHex(tronWebRelayer, message.serviceProvider),
    toStandardHex(tronWebRelayer, message.user),
    toStandardHex(tronWebRelayer, message.receiver),
    toStandardHex(tronWebRelayer, userGasFreeAccountAddress),
    message.value,
    message.maxFee,
    message.deadline,
    message.version,
    message.nonce,
  ];
  let signatureHex = signature;
  if (!signatureHex.startsWith('0x')) signatureHex = '0x' + signatureHex;

  const funcSig = "executePermitDepositVault((address,address,address,address,address,uint256,uint256,uint256,uint256,uint256),bytes)";
  const funcParams = [
    { type: '(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)', value: permitArray },
    { type: 'bytes', value: signatureHex },
  ];

  let energyEstimate = await tronWebRelayer.transactionBuilder.estimateEnergy(
    GAS_FREE_CONTROLLER_ADDRESS, funcSig, { callValue: 0 },
    funcParams, relayerAddress
  );
  if (typeof energyEstimate === 'object' && energyEstimate !== null) {
    energyEstimate = energyEstimate.energy_required || energyEstimate.energy_used || 0;
  }
  console.log(`Estimated Energy: ${energyEstimate}`);

  const chainParams = await tronWebRelayer.trx.getChainParameters();
  const energyFeeParam = chainParams.find(p => p.key === 'getEnergyFee');
  const energyPrice = energyFeeParam ? Number(energyFeeParam.value) : 420;
  const dynamicFeeLimit = Math.floor(energyEstimate * 1.2 * energyPrice);
  console.log(`Dynamic feeLimit: ${dynamicFeeLimit} Sun (${(dynamicFeeLimit / 1_000_000).toFixed(2)} TRX)`);

  const simulationResult = await tronWebRelayer.transactionBuilder.triggerSmartContract(
    GAS_FREE_CONTROLLER_ADDRESS, funcSig,
    { callValue: 0, feeLimit: dynamicFeeLimit },
    funcParams, relayerAddress
  );
  if (simulationResult && simulationResult.result && simulationResult.result.result === false) {
    const revertReason = simulationResult.result.message
      ? tronWebRelayer.toUtf8(simulationResult.result.message) : "Unknown";
    throw new Error(`Simulation reverted: ${revertReason}`);
  }
  console.log("Simulation successful.");

  const signedTransaction = await tronWebRelayer.trx.sign(simulationResult.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastResult = await tronWebRelayer.trx.sendRawTransaction(signedTransaction);
  if (!broadcastResult.result) {
    throw new Error(`Broadcast failed: ${tronWebRelayer.toUtf8(broadcastResult.message)}`);
  }
  console.log(`Broadcast successful! TxID: ${broadcastResult.txid}`);
  await waitforTxConfirmation(tronWebRelayer, broadcastResult.txid);

  // Print balances
  const balGFA = await usdt.balanceOf(userGasFreeAccountAddress).call();
  const balVault = await usdt.balanceOf(DEX_VAULT_ADDRESS).call();
  const balRelayer = await usdt.balanceOf(relayerAddress).call();
  console.log(`\n--- Balances After Deposit ---`);
  console.log(`  GasFreeAccount: ${tronWebRelayer.fromSun(balGFA, 6)} USDT`);
  console.log(`  Vault Proxy:    ${tronWebRelayer.fromSun(balVault, 6)} USDT`);
  console.log(`  Relayer:        ${tronWebRelayer.fromSun(balRelayer, 6)} USDT`);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
