const { TronWeb } = require('tronweb');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');

require('dotenv').config();

const waitforTxConfirmation = require('../utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('../utils/compile.cjs');
const { networks, decodeErrorMessage } = require('../utils/common.cjs');

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';
  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}`);
  if (!DEPLOYER_PRIVATE_KEY) { console.error("DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }

  const tronWeb = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    DEPLOYER_PRIVATE_KEY
  );
  const deployerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);
  console.log(`Using account: ${deployerAddress} on ${networkConfig.name}\n`);

  // --- Load deployed addresses ---
  const addrFile = join(__dirname, `../../deployed-addresses-uups.${NETWORK}.json`);
  if (!existsSync(addrFile)) {
    throw new Error(`Deployed addresses file not found: ${addrFile}\nRun deployUups.cjs first.`);
  }
  const deployed = JSON.parse(readFileSync(addrFile, 'utf8'));
  const proxyAddress = deployed.dexVaultProxy;
  const oldImplAddress = deployed.dexVaultImplementation;
  console.log(`Proxy address:              ${proxyAddress}`);
  console.log(`Current implementation:     ${oldImplAddress}\n`);

  // =====================================================================
  //  Compile DEXVaultV1 + DEXVaultV2
  // =====================================================================
  const artifacts = compileContracts(['core', 'vault', 'vaultV2']);
  const DEXVaultV1Artifact = artifacts.DEXVaultV1;
  const DEXVaultV2Artifact = artifacts.DEXVaultV2;

  // =====================================================================
  //  Step 1: Verify current state BEFORE upgrade
  // =====================================================================
  console.log("=== PRE-UPGRADE STATE ===");
  const proxyAsV1 = await tronWeb.contract(DEXVaultV1Artifact.abi, proxyAddress);

  const ownerBefore = tronWeb.address.fromHex(await proxyAsV1.owner().call());
  console.log(`  owner():     ${ownerBefore}`);

  const signersBefore = await proxyAsV1.getSigners().call();
  const signersBeforeReadable = signersBefore.map(s => tronWeb.address.fromHex(s));
  console.log(`  signers:     ${signersBeforeReadable}`);

  let hasVersionBefore = false;
  try {
    await proxyAsV1.version().call();
    hasVersionBefore = true;
  } catch {
    hasVersionBefore = false;
  }
  console.log(`  version():   ${hasVersionBefore ? 'exists (unexpected!)' : 'not available (expected for V1)'}`);
  console.log();

  // =====================================================================
  //  Step 2: Deploy DEXVaultV2 implementation
  // =====================================================================
  console.log("Deploying DEXVaultV2 implementation...");
  const v2UnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: DEXVaultV2Artifact.abi,
      bytecode: DEXVaultV2Artifact.bytecode,
      feeLimit: 1000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    deployerAddress
  );

  const v2SignedTx = await tronWeb.trx.sign(v2UnsignedTx, DEPLOYER_PRIVATE_KEY);
  const v2Broadcast = await tronWeb.trx.sendRawTransaction(v2SignedTx);
  if (!v2Broadcast.result) {
    throw new Error(`DEXVaultV2 deploy failed: ${decodeErrorMessage(v2Broadcast.message || v2Broadcast.code)}`);
  }
  console.log(`DEXVaultV2 Impl TxID: ${v2Broadcast.txid}`);
  const v2TxInfo = await waitforTxConfirmation(tronWeb, v2Broadcast.txid);
  const newImplAddress = v2TxInfo.contractAddress;
  console.log(`DEXVaultV2 implementation deployed at: ${newImplAddress}\n`);

  // =====================================================================
  //  Step 3: Upgrade proxy → V2 via upgradeToAndCall
  // =====================================================================
  console.log("Calling upgradeToAndCall on proxy...");
  const newImplHex = tronWeb.address.toHex(newImplAddress);

  const upgradeTx = await tronWeb.transactionBuilder.triggerSmartContract(
    proxyAddress,
    "upgradeToAndCall(address,bytes)",
    { feeLimit: 500_000_000, callValue: 0 },
    [
      { type: 'address', value: newImplHex },
      { type: 'bytes', value: '0x' }
    ],
    deployerAddress
  );

  if (!upgradeTx.result || !upgradeTx.result.result) {
    const reason = upgradeTx.result && upgradeTx.result.message
      ? tronWeb.toUtf8(upgradeTx.result.message)
      : "Unknown";
    throw new Error(`upgradeToAndCall simulation failed: ${reason}`);
  }

  const signedUpgradeTx = await tronWeb.trx.sign(upgradeTx.transaction, DEPLOYER_PRIVATE_KEY);
  const upgradeBroadcast = await tronWeb.trx.sendRawTransaction(signedUpgradeTx);
  if (!upgradeBroadcast.result) {
    const rawMsg = upgradeBroadcast.message || upgradeBroadcast.code;
    const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, ''))
      ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
    throw new Error(`upgradeToAndCall broadcast failed: ${msg}`);
  }
  console.log(`upgradeToAndCall TxID: ${upgradeBroadcast.txid}`);
  await waitforTxConfirmation(tronWeb, upgradeBroadcast.txid);
  console.log("Upgrade transaction confirmed!\n");

  // =====================================================================
  //  Step 4: Verify POST-UPGRADE state
  // =====================================================================
  console.log("=== POST-UPGRADE VERIFICATION ===");
  console.log(`  Old implementation:  ${oldImplAddress}`);
  console.log(`  New implementation:  ${newImplAddress}`);

  // Call version() – should now return "V2"
  const proxyAsV2 = await tronWeb.contract(DEXVaultV2Artifact.abi, proxyAddress);
  const ver = await proxyAsV2.version().call();
  console.log(`  version():           "${ver}"`);

  // Verify state preservation
  const ownerAfter = tronWeb.address.fromHex(await proxyAsV2.owner().call());
  console.log(`  owner():             ${ownerAfter}`);

  const signersAfter = await proxyAsV2.getSigners().call();
  const signersAfterReadable = signersAfter.map(s => tronWeb.address.fromHex(s));
  console.log(`  signers:             ${signersAfterReadable}`);

  console.log();

  // =====================================================================
  //  Summary
  // =====================================================================
  const versionOk = ver === "V2";
  const ownerOk   = ownerAfter === ownerBefore;
  const signersOk = JSON.stringify(signersBeforeReadable) === JSON.stringify(signersAfterReadable);

  console.log("=== TEST RESULTS ===");
  console.log(`  [${versionOk ? 'PASS' : 'FAIL'}] version() returns "V2"`);
  console.log(`  [${ownerOk   ? 'PASS' : 'FAIL'}] owner preserved after upgrade`);
  console.log(`  [${signersOk ? 'PASS' : 'FAIL'}] signers preserved after upgrade`);

  if (versionOk && ownerOk && signersOk) {
    console.log("\nAll upgrade tests passed!");
  } else {
    console.error("\nSome tests FAILED – review output above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
