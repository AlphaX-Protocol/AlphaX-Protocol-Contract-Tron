const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');
const { ethers } = require('ethers');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { networks, toStandardHex } = require('./utils/common.cjs');

const VAULT_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'expireTime', type: 'uint256' },
      { name: 'requestId', type: 'uint256' },
      { name: 'allSigners', type: 'address[]' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    name: 'withdrawETH',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'token', type: 'address' }],
    name: 'getTokenWithdrawLimit',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSigners',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'token', type: 'address' }, { name: 'withdrawLimit', type: 'uint256' }],
    name: 'setWithdrawLimit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'token', type: 'address' }, { name: 'dailyLimit', type: 'uint256' }],
    name: 'setDailyWithdrawLimit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'dailyWithdrawLimit',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const ADDRESS_ZERO = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // 0x0000...0000 in TRON base58
const WITHDRAW_TO = 'TJKLG6mhjUwAAwBPvEdD8dNV6EqMjYvLjK';
const WITHDRAW_AMOUNT_TRX = '10';

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const SIGNER1_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const SIGNER2_PRIVATE_KEY = process.env.USER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  if (!DEPLOYER_PRIVATE_KEY || !SIGNER2_PRIVATE_KEY) {
    console.error('Missing env: DEPLOYER_PRIVATE_KEY, USER_PRIVATE_KEY');
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
  const amountSun = tronWeb.toSun(WITHDRAW_AMOUNT_TRX);

  console.log(`Vault (proxy): ${vaultProxy}`);
  console.log(`Caller:        ${callerAddress} on ${networkConfig.name}`);
  console.log(`Withdraw to:   ${WITHDRAW_TO}`);
  console.log(`Amount:        ${WITHDRAW_AMOUNT_TRX} TRX (${amountSun} sun)`);

  const vault = tronWeb.contract(VAULT_ABI, vaultProxy);

  // Check vault TRX balance
  const vaultBal = await tronWeb.trx.getBalance(vaultProxy);
  console.log(`Vault TRX balance: ${tronWeb.fromSun(vaultBal)} TRX`);

  // Check current signers
  const currentSigners = await vault.getSigners().call();
  const signerAddrs = currentSigners.map(s => {
    try { return tronWeb.address.fromHex(s); } catch { return s; }
  });
  console.log('Vault signers:', signerAddrs);

  // Check per-tx withdraw limit (address(0) for ETH/TRX)
  const withdrawLimit = await vault.getTokenWithdrawLimit(ADDRESS_ZERO).call();
  console.log('TRX per-tx withdraw limit:', tronWeb.fromSun(withdrawLimit), 'TRX');

  if (BigInt(withdrawLimit) === 0n || BigInt(withdrawLimit) < BigInt(amountSun)) {
    const newLimit = tronWeb.toSun('1000');
    console.log(`Setting per-tx withdraw limit to ${tronWeb.fromSun(newLimit)} TRX...`);
    const txId = await vault.setWithdrawLimit(ADDRESS_ZERO, newLimit).send({
      feeLimit: 100_000_000, callValue: 0, shouldPollResponse: false,
    });
    await waitforTxConfirmation(tronWeb, txId);
    console.log('setWithdrawLimit confirmed:', txId);
  }

  // Check daily withdraw limit
  const dailyLimit = await vault.dailyWithdrawLimit(ADDRESS_ZERO).call();
  console.log('TRX daily withdraw limit:', tronWeb.fromSun(dailyLimit), 'TRX');

  if (BigInt(dailyLimit) === 0n || BigInt(dailyLimit) < BigInt(amountSun)) {
    const newDailyLimit = tronWeb.toSun('10000');
    console.log(`Setting daily withdraw limit to ${tronWeb.fromSun(newDailyLimit)} TRX...`);
    const txId = await vault.setDailyWithdrawLimit(ADDRESS_ZERO, newDailyLimit).send({
      feeLimit: 100_000_000, callValue: 0, shouldPollResponse: false,
    });
    await waitforTxConfirmation(tronWeb, txId);
    console.log('setDailyWithdrawLimit confirmed:', txId);
  }

  // Build the operation hash — must match contract: abi.encodePacked("ETHER", chainid, to, amount, expireTime, requestId, address(this))
  const toHex20 = (addr) => toStandardHex(tronWeb, addr).slice(2).toLowerCase();
  const expireTime = Math.floor(Date.now() / 1000) + 3600;
  const requestId = Date.now();

  const operationHash = ethers.solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'address'],
    [
      'ETHER',
      networkConfig.chainId,
      '0x' + toHex20(WITHDRAW_TO),
      amountSun,
      expireTime,
      requestId,
      '0x' + toHex20(vaultProxy),
    ]
  );

  const ethSignedHash = ethers.hashMessage(ethers.getBytes(operationHash));
  console.log('\nOperation hash:', operationHash);
  console.log('Eth-signed hash:', ethSignedHash);

  // Sign with two signers
  const signer1Wallet = new ethers.SigningKey('0x' + SIGNER1_PRIVATE_KEY);
  const signer2Wallet = new ethers.SigningKey('0x' + SIGNER2_PRIVATE_KEY);

  const signature1 = ethers.Signature.from(signer1Wallet.sign(ethers.getBytes(ethSignedHash))).serialized;
  const signature2 = ethers.Signature.from(signer2Wallet.sign(ethers.getBytes(ethSignedHash))).serialized;

  const signer1Address = tronWeb.address.fromPrivateKey(SIGNER1_PRIVATE_KEY);
  const signer2Address = tronWeb.address.fromPrivateKey(SIGNER2_PRIVATE_KEY);
  console.log(`Signer 1: ${signer1Address}`);
  console.log(`Signer 2: ${signer2Address}`);

  // Call withdrawETH
  console.log('\n--- Calling withdrawETH ---');

  const funcSig = 'withdrawETH(address,address,uint256,uint256,uint256,address[],bytes[])';
  const funcParams = [
    { type: 'address', value: callerAddress },
    { type: 'address', value: WITHDRAW_TO },
    { type: 'uint256', value: amountSun },
    { type: 'uint256', value: expireTime },
    { type: 'uint256', value: requestId },
    { type: 'address[]', value: [signer1Address, signer2Address] },
    { type: 'bytes[]', value: [signature1, signature2] },
  ];

  let feeLimit;
  try {
    let energyEstimate = await tronWeb.transactionBuilder.estimateEnergy(
      vaultProxy, funcSig, { callValue: 0 }, funcParams, callerAddress
    );
    if (typeof energyEstimate === 'object' && energyEstimate !== null) {
      energyEstimate = energyEstimate.energy_required || energyEstimate.energy_used || 0;
    }
    const chainParams = await tronWeb.trx.getChainParameters();
    const energyFeeParam = chainParams.find(p => p.key === 'getEnergyFee');
    const energyPrice = energyFeeParam ? Number(energyFeeParam.value) : 420;
    feeLimit = Math.floor(energyEstimate * 1.2 * energyPrice);
    console.log(`Estimated energy: ${energyEstimate} | feeLimit: ${feeLimit} sun`);
  } catch (estimateErr) {
    console.error('estimateEnergy REVERTED — transaction would fail on-chain. Aborting.');
    console.error('Reason:', estimateErr.message || estimateErr);
    process.exit(1);
  }

  const simulationResult = await tronWeb.transactionBuilder.triggerSmartContract(
    vaultProxy, funcSig, { callValue: 0, feeLimit }, funcParams, callerAddress
  );

  if (simulationResult?.result?.result === false) {
    let msg = 'Unknown revert';
    if (simulationResult.result?.message) {
      try { msg = tronWeb.toUtf8(simulationResult.result.message); } catch {
        msg = Buffer.from(simulationResult.result.message.replace(/^0x/, ''), 'hex').toString('utf8');
      }
    }
    console.error('Simulation failed:', msg);
    process.exit(1);
  }
  console.log('Simulation OK.');

  const signedTx = await tronWeb.trx.sign(simulationResult.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastResult = await tronWeb.trx.sendRawTransaction(signedTx);
  if (!broadcastResult.result) {
    console.error('Broadcast failed:', broadcastResult.message || broadcastResult);
    process.exit(1);
  }
  console.log('Tx broadcast OK. TxID:', broadcastResult.txid);
  await waitforTxConfirmation(tronWeb, broadcastResult.txid);

  // Verify balances
  const vaultBalAfter = await tronWeb.trx.getBalance(vaultProxy);
  const recipientBal = await tronWeb.trx.getBalance(WITHDRAW_TO);
  console.log('\n--- Balances After Withdraw ---');
  console.log(`Vault:     ${tronWeb.fromSun(vaultBalAfter)} TRX`);
  console.log(`Recipient: ${tronWeb.fromSun(recipientBal)} TRX`);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
