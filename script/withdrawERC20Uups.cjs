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
      { name: 'token', type: 'address' },
      { name: 'expireTime', type: 'uint256' },
      { name: 'requestId', type: 'uint256' },
      { name: 'allSigners', type: 'address[]' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    name: 'withdrawERC20',
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

const IERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

const WITHDRAW_TO = 'TJKLG6mhjUwAAwBPvEdD8dNV6EqMjYvLjK';
const WITHDRAW_AMOUNT_USDT = '20';

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const SIGNER1_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const SIGNER2_PRIVATE_KEY = process.env.USER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  if (!DEPLOYER_PRIVATE_KEY || !SIGNER1_PRIVATE_KEY || !SIGNER2_PRIVATE_KEY) {
    console.error('Missing env: DEPLOYER_PRIVATE_KEY, SIGNER1_PRIVATE_KEY, SIGNER2_PRIVATE_KEY');
    process.exit(1);
  }

  const deployedPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  let deployed;
  try {
    deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to load ${deployedPath}. Run deployUups.cjs first.`);
    process.exit(1);
  }

  const vaultProxy = deployed.dexVaultProxy;
  const usdtAddress = deployed.nileUsdtAddress;
  if (!vaultProxy || !usdtAddress) {
    console.error('Missing dexVaultProxy or nileUsdtAddress in deployed JSON.');
    process.exit(1);
  }

  const tronWeb = new TronWeb(
    networkConfig.fullNode, networkConfig.solidityNode, networkConfig.eventServer, DEPLOYER_PRIVATE_KEY
  );
  const callerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log(`Vault (proxy): ${vaultProxy}`);
  console.log(`Caller:        ${callerAddress} on ${networkConfig.name}`);
  console.log(`Withdraw to:   ${WITHDRAW_TO}`);
  console.log(`Amount:        ${WITHDRAW_AMOUNT_USDT} USDT`);

  const vault = tronWeb.contract(VAULT_ABI, vaultProxy);
  const usdt = tronWeb.contract(IERC20_ABI, usdtAddress);

  // Check vault USDT balance
  const vaultBal = await usdt.balanceOf(vaultProxy).call();
  console.log(`Vault USDT balance: ${tronWeb.fromSun(vaultBal, 6)} USDT`);

  // Check current signers
  const currentSigners = await vault.getSigners().call();
  const signerAddrs = currentSigners.map(s => {
    try { return tronWeb.address.fromHex(s); } catch { return s; }
  });
  console.log('Vault signers:', signerAddrs);

  const amountSun = tronWeb.toSun(WITHDRAW_AMOUNT_USDT, 6);

  // Check per-tx withdraw limit
  const withdrawLimit = await vault.getTokenWithdrawLimit(usdtAddress).call();
  console.log('USDT per-tx withdraw limit:', tronWeb.fromSun(withdrawLimit, 6), 'USDT');

  if (BigInt(withdrawLimit) === 0n || BigInt(withdrawLimit) < BigInt(amountSun)) {
    const newLimit = tronWeb.toSun('20000', 6);
    console.log(`Setting per-tx withdraw limit to ${tronWeb.fromSun(newLimit, 6)} USDT...`);
    const txId = await vault.setWithdrawLimit(usdtAddress, newLimit).send({
      feeLimit: 100_000_000, callValue: 0, shouldPollResponse: false,
    });
    await waitforTxConfirmation(tronWeb, txId);
    console.log('setWithdrawLimit confirmed:', txId);
  }

  // Check daily withdraw limit
  const dailyLimit = await vault.dailyWithdrawLimit(usdtAddress).call();
  console.log('USDT daily withdraw limit:', tronWeb.fromSun(dailyLimit, 6), 'USDT');

  if (BigInt(dailyLimit) === 0n || BigInt(dailyLimit) < BigInt(amountSun)) {
    const newDailyLimit = tronWeb.toSun('200000', 6);
    console.log(`Setting daily withdraw limit to ${tronWeb.fromSun(newDailyLimit, 6)} USDT...`);
    const txId = await vault.setDailyWithdrawLimit(usdtAddress, newDailyLimit).send({
      feeLimit: 100_000_000, callValue: 0, shouldPollResponse: false,
    });
    await waitforTxConfirmation(tronWeb, txId);
    console.log('setDailyWithdrawLimit confirmed:', txId);
  }

  // Build the operation hash (must match the contract's logic)
  const toHex20 = (addr) => toStandardHex(tronWeb, addr).slice(2).toLowerCase();
  const expireTime = Math.floor(Date.now() / 1000) + 3600;
  const requestId = Date.now();

  const operationHash = ethers.solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'address'],
    [
      'ERC20',
      networkConfig.chainId,
      '0x' + toHex20(callerAddress),
      '0x' + toHex20(WITHDRAW_TO),
      amountSun,
      '0x' + toHex20(usdtAddress),
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

  const sig1 = signer1Wallet.sign(ethers.getBytes(ethSignedHash));
  const sig2 = signer2Wallet.sign(ethers.getBytes(ethSignedHash));

  const signature1 = ethers.Signature.from(sig1).serialized;
  const signature2 = ethers.Signature.from(sig2).serialized;

  const signer1Address = tronWeb.address.fromPrivateKey(SIGNER1_PRIVATE_KEY);
  const signer2Address = tronWeb.address.fromPrivateKey(SIGNER2_PRIVATE_KEY);

  console.log(`Signer 1: ${signer1Address}`);
  console.log(`Signer 2: ${signer2Address}`);

  // Call withdrawERC20
  console.log('\n--- Calling withdrawERC20 ---');

  const funcSig = 'withdrawERC20(address,address,uint256,address,uint256,uint256,address[],bytes[])';
  const funcParams = [
    { type: 'address', value: callerAddress },
    { type: 'address', value: WITHDRAW_TO },
    { type: 'uint256', value: amountSun },
    { type: 'address', value: usdtAddress },
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
  const vaultBalAfter = await usdt.balanceOf(vaultProxy).call();
  const recipientBal = await usdt.balanceOf(WITHDRAW_TO).call();
  console.log('\n--- Balances After Withdraw ---');
  console.log(`Vault:     ${tronWeb.fromSun(vaultBalAfter, 6)} USDT`);
  console.log(`Recipient: ${tronWeb.fromSun(recipientBal, 6)} USDT`);
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
