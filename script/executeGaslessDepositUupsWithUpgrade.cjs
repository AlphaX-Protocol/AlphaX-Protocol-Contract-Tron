const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('./utils/compile.cjs');
const { networks, decodeErrorMessage, toStandardHex } = require('./utils/common.cjs');

/**
 * Build and execute a gasless deposit via the GasFreeController.
 * Returns the broadcast txid.
 */
async function executeDeposit(label, {
  tronWebUser, tronWebRelayer, controller, usdt,
  userAddress, relayerAddress, networkConfig,
  GAS_FREE_CONTROLLER_ADDRESS, USDT_ADDRESS, DEX_VAULT_ADDRESS,
  RECIPIENT_ADDRESS, userGasFreeAccountAddress,
  USER_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY,
}) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(70)}`);

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
      { name: "firstTime", type: "bool" },
      { name: "value", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "version", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "operationType", type: "uint8" },
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
    firstTime: false,
    value: transferValue.toString(),
    maxFee: maxFee.toString(),
    deadline: deadline,
    version: 0,
    nonce: Number(nonce),
    operationType: 2,
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
    message.firstTime,
    message.value,
    message.maxFee,
    message.deadline,
    message.version,
    message.nonce,
    message.operationType,
  ];
  let signatureHex = signature;
  if (!signatureHex.startsWith('0x')) signatureHex = '0x' + signatureHex;

  const funcSig = "executePermitDepositVault((address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8),bytes)";
  const funcParams = [
    { type: '(address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8)', value: permitArray },
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
  console.log(`\n--- Balances After ${label} ---`);
  console.log(`  GasFreeAccount: ${tronWebRelayer.fromSun(balGFA, 6)} USDT`);
  console.log(`  Vault Proxy:    ${tronWebRelayer.fromSun(balVault, 6)} USDT`);
  console.log(`  Relayer:        ${tronWebRelayer.fromSun(balRelayer, 6)} USDT`);
}

async function main() {
  const USER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}.`);
  if (!USER_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY || !RECIPIENT_ADDRESS) {
    console.error("Missing env vars: DEPLOYER_PRIVATE_KEY, RECIPIENT_ADDRESS."); process.exit(1);
  }

  // --- Load Deployed Addresses (UUPS) ---
  const deployedAddressesPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, 'utf8'));
    console.log(`Loaded addresses from ${deployedAddressesPath}`);
  } catch (error) {
    console.error(`Error: ${error.message}\nRun deployUups.cjs first.`); process.exit(1);
  }

  const GAS_FREE_CONTROLLER_ADDRESS = deployedAddresses.controllerAddress;
  const USDT_ADDRESS = deployedAddresses.nileUsdtAddress;
  const DEX_VAULT_ADDRESS = deployedAddresses.dexVaultProxy;
  const userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress;

  if (!GAS_FREE_CONTROLLER_ADDRESS || !USDT_ADDRESS || !DEX_VAULT_ADDRESS) {
    console.error("Missing addresses in deployed-addresses-uups.json."); process.exit(1);
  }

  // --- Initialize TronWeb ---
  const tronWebUser = new TronWeb(networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, USER_PRIVATE_KEY);
  const tronWebRelayer = new TronWeb(networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, DEPLOYER_PRIVATE_KEY);

  const userAddress = tronWebUser.address.fromPrivateKey(USER_PRIVATE_KEY);
  const relayerAddress = tronWebRelayer.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log("User wallet:", userAddress);
  console.log("Relayer wallet:", relayerAddress, `(${networkConfig.name})`);
  console.log("DEX Vault proxy:", DEX_VAULT_ADDRESS);

  // =====================================================================
  //  Compile: GasFreeController + IERC20 + DEXVaultV1 + DEXVaultV2
  // =====================================================================
  const artifacts = compileContracts(['core', 'vault', 'vaultV2']);
  const GasFreeControllerArtifact = artifacts.GasFreeController;
  const IERC20Artifact = artifacts.IERC20;
  const DEXVaultV1Artifact = artifacts.DEXVaultV1;
  const DEXVaultV2Artifact = artifacts.DEXVaultV2;

  const controller = tronWebRelayer.contract(GasFreeControllerArtifact.abi, GAS_FREE_CONTROLLER_ADDRESS);
  const usdt = tronWebRelayer.contract(IERC20Artifact.abi, USDT_ADDRESS);

  const depositCtx = {
    tronWebUser, tronWebRelayer, controller, usdt,
    userAddress, relayerAddress, networkConfig,
    GAS_FREE_CONTROLLER_ADDRESS, USDT_ADDRESS, DEX_VAULT_ADDRESS,
    RECIPIENT_ADDRESS, userGasFreeAccountAddress,
    USER_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY,
  };

  // =====================================================================
  //  PHASE 1: Deposit with V1 vault
  // =====================================================================
  await executeDeposit("DEPOSIT #1 — Before Upgrade (V1)", depositCtx);

  // =====================================================================
  //  PHASE 2: Upgrade vault V1 → V2
  // =====================================================================
  console.log(`\n${'='.repeat(70)}`);
  console.log("  UPGRADING VAULT: V1 → V2");
  console.log(`${'='.repeat(70)}`);

  // 2a. Pre-upgrade state
  const proxyAsV1 = await tronWebRelayer.contract(DEXVaultV1Artifact.abi, DEX_VAULT_ADDRESS);
  const ownerBefore = tronWebRelayer.address.fromHex(await proxyAsV1.owner().call());
  const signersBefore = (await proxyAsV1.getSigners().call()).map(s => tronWebRelayer.address.fromHex(s));
  console.log(`  Owner before:   ${ownerBefore}`);
  console.log(`  Signers before: ${signersBefore}`);

  // 2b. Deploy DEXVaultV2 implementation
  console.log("\nDeploying DEXVaultV2 implementation...");
  const v2UnsignedTx = await tronWebRelayer.transactionBuilder.createSmartContract(
    {
      abi: DEXVaultV2Artifact.abi,
      bytecode: DEXVaultV2Artifact.bytecode,
      feeLimit: 1000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    relayerAddress
  );
  const v2SignedTx = await tronWebRelayer.trx.sign(v2UnsignedTx, DEPLOYER_PRIVATE_KEY);
  const v2Broadcast = await tronWebRelayer.trx.sendRawTransaction(v2SignedTx);
  if (!v2Broadcast.result) {
    throw new Error(`DEXVaultV2 deploy failed: ${decodeErrorMessage(v2Broadcast.message || v2Broadcast.code)}`);
  }
  console.log(`DEXVaultV2 Impl TxID: ${v2Broadcast.txid}`);
  const v2TxInfo = await waitforTxConfirmation(tronWebRelayer, v2Broadcast.txid);
  const newImplAddress = v2TxInfo.contractAddress;
  console.log(`DEXVaultV2 implementation deployed at: ${newImplAddress}`);

  // 2c. Call upgradeToAndCall on the proxy
  console.log("\nCalling upgradeToAndCall on proxy...");
  const newImplHex = tronWebRelayer.address.toHex(newImplAddress);
  const upgradeTx = await tronWebRelayer.transactionBuilder.triggerSmartContract(
    DEX_VAULT_ADDRESS,
    "upgradeToAndCall(address,bytes)",
    { feeLimit: 500_000_000, callValue: 0 },
    [
      { type: 'address', value: newImplHex },
      { type: 'bytes', value: '0x' }
    ],
    relayerAddress
  );
  if (!upgradeTx.result || !upgradeTx.result.result) {
    const reason = upgradeTx.result && upgradeTx.result.message
      ? tronWebRelayer.toUtf8(upgradeTx.result.message) : "Unknown";
    throw new Error(`upgradeToAndCall simulation failed: ${reason}`);
  }
  const signedUpgradeTx = await tronWebRelayer.trx.sign(upgradeTx.transaction, DEPLOYER_PRIVATE_KEY);
  const upgradeBroadcast = await tronWebRelayer.trx.sendRawTransaction(signedUpgradeTx);
  if (!upgradeBroadcast.result) {
    const rawMsg = upgradeBroadcast.message || upgradeBroadcast.code;
    const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, ''))
      ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
    throw new Error(`upgradeToAndCall broadcast failed: ${msg}`);
  }
  console.log(`upgradeToAndCall TxID: ${upgradeBroadcast.txid}`);
  await waitforTxConfirmation(tronWebRelayer, upgradeBroadcast.txid);
  console.log("Upgrade confirmed!");

  // 2d. Verify upgrade
  const proxyAsV2 = await tronWebRelayer.contract(DEXVaultV2Artifact.abi, DEX_VAULT_ADDRESS);
  const ver = await proxyAsV2.version().call();
  const ownerAfter = tronWebRelayer.address.fromHex(await proxyAsV2.owner().call());
  const signersAfter = (await proxyAsV2.getSigners().call()).map(s => tronWebRelayer.address.fromHex(s));

  console.log(`\n--- Post-Upgrade Verification ---`);
  console.log(`  version():      "${ver}"`);
  console.log(`  Owner after:    ${ownerAfter}`);
  console.log(`  Signers after:  ${signersAfter}`);
  console.log(`  [${ver === "V2" ? 'PASS' : 'FAIL'}] version() == "V2"`);
  console.log(`  [${ownerAfter === ownerBefore ? 'PASS' : 'FAIL'}] owner preserved`);
  console.log(`  [${JSON.stringify(signersBefore) === JSON.stringify(signersAfter) ? 'PASS' : 'FAIL'}] signers preserved`);

  if (ver !== "V2") throw new Error("Upgrade failed – version() did not return V2");

  // =====================================================================
  //  PHASE 3: Deposit with V2 vault (same proxy address)
  // =====================================================================
  await executeDeposit("DEPOSIT #2 — After Upgrade (V2)", depositCtx);

  // =====================================================================
  //  Final summary
  // =====================================================================
  console.log(`\n${'='.repeat(70)}`);
  console.log("  ALL DONE");
  console.log(`${'='.repeat(70)}`);
  console.log("  1. Deposited USDT to V1 vault via proxy");
  console.log("  2. Upgraded vault V1 → V2 (UUPS)");
  console.log("  3. Deposited USDT to V2 vault via same proxy");
  console.log("  Proxy address unchanged:", DEX_VAULT_ADDRESS);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
