const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { networks } = require('./utils/common.cjs');

const VAULT_ABI = [
  {
    inputs: [{ internalType: 'address[]', name: 'allowedSigners', type: 'address[]' }],
    name: 'changeSigners',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSigners',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const NEW_SIGNERS = [
  'TZFgDSCDQcT6tMtHHSec37aaQY9XJSy8zB',
  'TTcuMEfweu2bxLPgG3sNufQ7Rs81jcFA8P',
  'TQ16ccZfrYUM4AF2YjfSsFsm1YhqSQTChi',
];

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  if (!DEPLOYER_PRIVATE_KEY) {
    console.error('DEPLOYER_PRIVATE_KEY is not set in .env');
    process.exit(1);
  }

  const tronWeb = new TronWeb(
    networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, DEPLOYER_PRIVATE_KEY
  );
  const deployerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  const deployedPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  let deployed;
  try {
    deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to load ${deployedPath}. Run deployUups.cjs first.`);
    process.exit(1);
  }

  const vaultProxy = deployed.dexVaultProxy;
  if (!vaultProxy) {
    console.error('dexVaultProxy missing in deployed-addresses-uups JSON');
    process.exit(1);
  }

  console.log(`DEX Vault (proxy): ${vaultProxy}`);
  console.log(`Caller (owner):    ${deployerAddress} on ${networkConfig.name}`);

  const vault = tronWeb.contract(VAULT_ABI, vaultProxy);

  // Show current signers
  const currentSigners = await vault.getSigners().call();
  const formatted = currentSigners.map(s => {
    try { return tronWeb.address.fromHex(s); } catch { return s; }
  });
  console.log('Current signers:', formatted);

  // Set new signers
  console.log('Setting signers to:', NEW_SIGNERS);
  const txId = await vault.changeSigners(NEW_SIGNERS).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false,
  });

  await waitforTxConfirmation(tronWeb, txId);
  console.log('changeSigners confirmed. TxID:', txId);

  // Verify
  const updatedSigners = await vault.getSigners().call();
  const updatedFormatted = updatedSigners.map(s => {
    try { return tronWeb.address.fromHex(s); } catch { return s; }
  });
  console.log('Updated signers:', updatedFormatted);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
