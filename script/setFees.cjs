const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');

const networks = {
  mainnet: {
    fullNode: 'https://api.trongrid.io',
    solidityNode: 'https://api.trongrid.io',
    eventServer: 'https://api.trongrid.io',
    name: 'Mainnet'
  },
  nile: {
    fullNode: 'https://api.nileex.io',
    solidityNode: 'https://api.nileex.io',
    eventServer: 'https://api.nileex.io',
    name: 'Nile Testnet'
  }
};

/** Minimal ABI for GasFreeController fee getters and setter */
const CONTROLLER_ABI = [
  {
    inputs: [
      { internalType: 'uint256', name: '_activateFee', type: 'uint256' },
      { internalType: 'uint256', name: '_transferFee', type: 'uint256' },
      { internalType: 'uint256', name: '_transferFeeTRX', type: 'uint256' }
    ],
    name: 'setFees',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'activateFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'transferFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'transferFeeTRX',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
];

/** 1 USDT in smallest unit (6 decimals) */
const ONE_USDT = '1000000';
/** 1 TRX in sun */
const ONE_TRX_SUN = '1000000';

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  }

  if (!DEPLOYER_PRIVATE_KEY) {
    console.error('DEPLOYER_PRIVATE_KEY is not set in .env');
    process.exit(1);
  }

  const tronWeb = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    DEPLOYER_PRIVATE_KEY
  );

  const deployerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  const deployedPath = join(__dirname, `../deployed-addresses.${NETWORK}.json`);
  let deployed;
  try {
    deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to load ${deployedPath}. Run deploy.cjs first.`);
    process.exit(1);
  }

  const controllerAddress = deployed.controllerAddress;
  if (!controllerAddress) {
    console.error('controllerAddress missing in deployed-addresses JSON');
    process.exit(1);
  }

  console.log(`Controller: ${controllerAddress}`);
  console.log(`Caller (owner): ${deployerAddress} on ${networkConfig.name}`);
  console.log(`Setting activateFee and transferFee to 1 USDT (${ONE_USDT}), transferFeeTRX to 1 TRX (${ONE_TRX_SUN} sun)...`);

  const controller = tronWeb.contract(CONTROLLER_ABI, controllerAddress);

  const setFeesTxId = await controller.setFees(ONE_USDT, ONE_USDT, ONE_TRX_SUN).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });

  await waitforTxConfirmation(tronWeb, setFeesTxId);
  console.log('setFees transaction confirmed:', setFeesTxId);

  const [activateFee, transferFee, transferFeeTRX] = await Promise.all([
    controller.activateFee().call(),
    controller.transferFee().call(),
    controller.transferFeeTRX().call()
  ]);
  console.log('Current activateFee:', activateFee.toString());
  console.log('Current transferFee:', transferFee.toString());
  console.log('Current transferFeeTRX:', transferFeeTRX.toString(), '(sun)');
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
