const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('./utils/compile.cjs');
const { networks, decodeErrorMessage } = require('./utils/common.cjs');

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  if (!DEPLOYER_PRIVATE_KEY) {
    console.error('DEPLOYER_PRIVATE_KEY is not set in .env file.');
    process.exit(1);
  }

  const deployedPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  let deployed;
  try {
    deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
  } catch {
    console.error(`Failed to load ${deployedPath}. Run deployUups.cjs first.`);
    process.exit(1);
  }

  const vaultProxy = deployed.dexVaultProxy;
  if (!vaultProxy) {
    console.error('Missing dexVaultProxy in deployed JSON.');
    process.exit(1);
  }

  const tronWeb = new TronWeb(
    networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, DEPLOYER_PRIVATE_KEY
  );
  const callerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log(`Upgrading vault on ${networkConfig.name}`);
  console.log(`Proxy:          ${vaultProxy}`);
  console.log(`Old impl:       ${deployed.dexVaultImplementation}`);
  console.log(`Caller (owner): ${callerAddress}`);

  // ── Compile ────────────────────────────────────────────────────────────
  const artifacts = compileContracts(['core', 'vault']);
  const V1 = artifacts.DEXVaultV1;

  // ── Deploy new implementation ──────────────────────────────────────────
  console.log('\n--- Deploying new DEXVaultV1 implementation ---');
  const createTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: V1.abi,
      bytecode: V1.bytecode,
      feeLimit: 1_000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    callerAddress
  );
  const signedCreate = await tronWeb.trx.sign(createTx, DEPLOYER_PRIVATE_KEY);
  const broadcastCreate = await tronWeb.trx.sendRawTransaction(signedCreate);
  if (!broadcastCreate.result) {
    throw new Error(`Implementation deploy failed: ${decodeErrorMessage(broadcastCreate.message || broadcastCreate.code)}`);
  }
  console.log('Deploy TxID:', broadcastCreate.txid);
  const createInfo = await waitforTxConfirmation(tronWeb, broadcastCreate.txid);
  const newImplAddress = createInfo.contractAddress;
  console.log('New implementation:', newImplAddress);

  // ── Upgrade proxy ──────────────────────────────────────────────────────
  console.log('\n--- Calling upgradeToAndCall on proxy ---');
  const upgradeTx = await tronWeb.transactionBuilder.triggerSmartContract(
    vaultProxy,
    'upgradeToAndCall(address,bytes)',
    { feeLimit: 500_000_000, callValue: 0 },
    [
      { type: 'address', value: tronWeb.address.toHex(newImplAddress) },
      { type: 'bytes', value: '0x' },
    ],
    callerAddress
  );
  if (upgradeTx?.result?.result === false) {
    const reason = upgradeTx.result?.message
      ? decodeErrorMessage(upgradeTx.result.message)
      : 'Unknown';
    throw new Error(`upgradeToAndCall simulation failed: ${reason}`);
  }

  const signedUpgrade = await tronWeb.trx.sign(upgradeTx.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastUpgrade = await tronWeb.trx.sendRawTransaction(signedUpgrade);
  if (!broadcastUpgrade.result) {
    throw new Error(`upgradeToAndCall broadcast failed: ${decodeErrorMessage(broadcastUpgrade.message || broadcastUpgrade.code)}`);
  }
  console.log('Upgrade TxID:', broadcastUpgrade.txid);
  await waitforTxConfirmation(tronWeb, broadcastUpgrade.txid);

  // ── Verify ─────────────────────────────────────────────────────────────
  const vault = tronWeb.contract(V1.abi, vaultProxy);
  const owner = await vault.owner().call();
  const signers = await vault.getSigners().call();
  console.log('\n--- Post-upgrade verification ---');
  console.log('Owner:', tronWeb.address.fromHex(owner));
  console.log('Signers:', signers.map(s => { try { return tronWeb.address.fromHex(s); } catch { return s; } }));

  // ── Update deployed JSON ───────────────────────────────────────────────
  deployed.dexVaultImplementation = newImplAddress;
  writeFileSync(deployedPath, JSON.stringify(deployed, null, 2) + '\n');
  console.log(`\nUpdated ${deployedPath}`);
  console.log('Upgrade complete.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
