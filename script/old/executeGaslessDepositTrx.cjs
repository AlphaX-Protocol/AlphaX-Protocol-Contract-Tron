const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');

require('dotenv').config();

const waitforTxConfirmation = require('../utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('../utils/compile.cjs');
const { networks, toStandardHex } = require('../utils/common.cjs');

/** TRX = address(0) for permit */
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

async function main() {
  const USER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;
  const NETWORK = process.env.NETWORK || 'nile';
  /** TRX amount to deposit (in TRX), e.g. "10" */
  const TRX_DEPOSIT_AMOUNT = process.env.TRX_DEPOSIT_AMOUNT || '10';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Use 'mainnet' or 'nile'.`);
  }

  if (!USER_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY || !RECIPIENT_ADDRESS) {
    console.error('Missing env: USER_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY, RECIPIENT_ADDRESS.');
    process.exit(1);
  }

  const deployedPath = join(__dirname, `../../deployed-addresses.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedPath, 'utf8'));
    console.log(`Loaded deployed addresses from ${deployedPath}`);
  } catch (e) {
    console.error(`Error loading ${deployedPath}. Run deploy.cjs first.`);
    process.exit(1);
  }

  const GAS_FREE_CONTROLLER_ADDRESS = deployedAddresses.controllerAddress;
  const DEX_VAULT_ADDRESS = deployedAddresses.dexVaultAddress;
  const FACTORY_ADDRESS = deployedAddresses.factoryAddress;
  let userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress || null;

  if (!GAS_FREE_CONTROLLER_ADDRESS || !DEX_VAULT_ADDRESS) {
    console.error('Missing controllerAddress or dexVaultAddress in deployed-addresses.');
    process.exit(1);
  }

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

  const userAddress = tronWebUser.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);
  const relayerAddress = tronWebRelayer.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log('User wallet:', userAddress);
  console.log('Relayer wallet:', relayerAddress, `on ${networkConfig.name}`);
  console.log('DEX Vault:', DEX_VAULT_ADDRESS);

  // --- Compile for ABI ---
  const artifacts = compileContracts(['core']);

  const controller = tronWebRelayer.contract(artifacts.GasFreeController.abi, GAS_FREE_CONTROLLER_ADDRESS);

  // Resolve user's GasFreeAccount (factory.getAddress or fallback to deployed)
  if (FACTORY_ADDRESS) {
    const factory = tronWebRelayer.contract(artifacts.GasFreeFactory.abi, FACTORY_ADDRESS);
    const computed = await factory.getAddress(userAddress, 0).call();
    const hex = typeof computed === 'string' ? (computed.startsWith('0x') ? computed : '0x' + computed) : (computed?.toString?.() || '');
    const isZero = !hex || hex === '0x' + '0'.repeat(40) || hex === '0x41' + '0'.repeat(40);
    if (hex && !isZero) {
      // TRON base58 expects 21-byte hex (41 + 20). Contract returns 20-byte address.
      const tronHex = hex.length === 42 ? '0x41' + hex.slice(2) : hex;
      try {
        userGasFreeAccountAddress = tronWebRelayer.address.fromHex(tronHex);
      } catch (e) {
        userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress || null;
      }
    }
  }
  if (!userGasFreeAccountAddress) {
    console.error('User GasFreeAccount address unknown. Deploy an account for this user first (e.g. via deploy.cjs).');
    process.exit(1);
  }
  // Validate: TronWeb getBalance rejects invalid base58
  if (!userGasFreeAccountAddress.startsWith('T')) {
    userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress || null;
    if (!userGasFreeAccountAddress) {
      console.error('Invalid GasFreeAccount address from factory. Ensure deploy.cjs was run for this user.');
      process.exit(1);
    }
  }
 
  console.log("User's GasFreeAccount:", userGasFreeAccountAddress);

  const nonce = await controller.nonces(userAddress).call();
  console.log("User's nonce:", Number(nonce));

  const transferFeeTRX = await controller.transferFeeTRX().call();
  const maxFeeSun = transferFeeTRX.toString();
  console.log("Transfer fee TRX:", maxFeeSun);
  const depositValueSun = tronWebUser.toSun(TRX_DEPOSIT_AMOUNT);
  const totalCostSun = BigInt(depositValueSun) + BigInt(maxFeeSun);
  console.log("Total cost TRX:", totalCostSun);

  const domain = {
    name: 'GasFreeController',
    version: 'V1.0.0',
    chainId: networkConfig.chainId,
    verifyingContract: GAS_FREE_CONTROLLER_ADDRESS
  };
  const types = {
    PermitTransfer: [
      { name: 'token', type: 'address' },
      { name: 'serviceProvider', type: 'address' },
      { name: 'user', type: 'address' },
      { name: 'receiver', type: 'address' },
      { name: 'gasFreeAddress', type: 'address' },
      { name: 'firstTime', type: 'bool' },
      { name: 'value', type: 'uint256' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'version', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'operationType', type: 'uint8' },
    ]
  };
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const message = {
    token: ADDRESS_ZERO,
    serviceProvider: toStandardHex(tronWebUser, relayerAddress),
    user: toStandardHex(tronWebUser, userAddress),
    receiver: toStandardHex(tronWebUser, RECIPIENT_ADDRESS),
    gasFreeAddress: toStandardHex(tronWebUser, userGasFreeAccountAddress),
    firstTime: false,
    value: depositValueSun.toString(),
    maxFee: maxFeeSun,
    deadline,
    version: 0,
    nonce: Number(nonce),
    operationType: 2,
  };

  console.log("message:", message);
  console.log('\n--- Signing PermitTransfer (TRX deposit) ---');
  console.log('Deposit (TRX sun):', depositValueSun, '| maxFee (sun):', maxFeeSun);

  const signature = tronWebUser.trx.signTypedData(domain, types, message, USER_PRIVATE_KEY);
  let signatureHex = signature.startsWith('0x') ? signature : '0x' + signature;

  // --- Check TRX balance of GasFreeAccount ---
  const balanceSun = await tronWebRelayer.trx.getBalance(userGasFreeAccountAddress);
  const balanceNum = typeof balanceSun === 'object' && balanceSun.balance != null ? Number(balanceSun.balance) : Number(balanceSun || 0);
  if (balanceNum < Number(totalCostSun)) {
    console.error(`Insufficient TRX in GasFreeAccount (${userGasFreeAccountAddress}).`);
    console.error(`Required: ${totalCostSun} sun (${TRX_DEPOSIT_AMOUNT} TRX + fee), got: ${balanceNum} sun.`);
    process.exit(1);
  }
  console.log(`GasFreeAccount TRX balance: ${balanceNum} sun (>= ${totalCostSun} required).`);

  const permitArray = [
    ADDRESS_ZERO,
    toStandardHex(tronWebRelayer, relayerAddress),
    toStandardHex(tronWebRelayer, userAddress),
    toStandardHex(tronWebRelayer, RECIPIENT_ADDRESS),
    toStandardHex(tronWebRelayer, userGasFreeAccountAddress),
    message.firstTime,
    message.value,
    message.maxFee,
    message.deadline,
    message.version,
    message.nonce,
    message.operationType,
  ];

  console.log('\n--- Executing executePermitDepositVault (TRX) ---');

  const contractParams = [
    { type: '(address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8)', value: permitArray },
    { type: 'bytes', value: signatureHex },
  ];

  let feeLimit;
  try {
    const energyEstimate = await tronWebRelayer.transactionBuilder.estimateEnergy(
      GAS_FREE_CONTROLLER_ADDRESS,
      'executePermitDepositVault((address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8),bytes)',
      { callValue: 0 },
      contractParams,
      relayerAddress
    );
    const energy = typeof energyEstimate === 'object' && energyEstimate !== null
      ? (energyEstimate.energy_required || energyEstimate.energy_used || 0)
      : 0;
    const chainParams = await tronWebRelayer.trx.getChainParameters();
    const energyFeeParam = chainParams.find(p => p.key === 'getEnergyFee');
    const energyPrice = energyFeeParam ? Number(energyFeeParam.value) : 420;
    feeLimit = Math.floor(energy * 1.2 * energyPrice);
    console.log('Estimated energy:', energy, '| feeLimit:', feeLimit, 'sun');
  } catch (estimateErr) {
    console.error('estimateEnergy failed. Aborting (transaction not sent):', estimateErr.message || estimateErr);
    process.exit(1);
  }

  let simulationResult;
  try {
    simulationResult = await tronWebRelayer.transactionBuilder.triggerSmartContract(
      GAS_FREE_CONTROLLER_ADDRESS,
      'executePermitDepositVault((address,address,address,address,address,bool,uint256,uint256,uint256,uint256,uint256,uint8),bytes)',
      { callValue: 0, feeLimit },
      contractParams,
      relayerAddress
    );
  } catch (triggerErr) {
    console.error('Trigger/simulation error:', triggerErr.message || triggerErr);
    if (triggerErr.result?.result === false && triggerErr.result?.message) {
      try {
        console.error('Revert reason:', tronWebRelayer.toUtf8(triggerErr.result.message));
      } catch (_) {
        console.error('Revert message (raw):', triggerErr.result.message);
      }
    }
    process.exit(1);
  }

  if (simulationResult?.result?.result === false) {
    let msg = 'Unknown revert';
    if (simulationResult.result?.message) {
      try {
        msg = tronWebRelayer.toUtf8(simulationResult.result.message);
      } catch (_) {
        const hex = simulationResult.result.message;
        msg = typeof hex === 'string' && /^[0-9a-fA-F]+$/.test(hex.replace(/^0x/, ''))
          ? Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('utf8')
          : String(hex);
      }
    }
    console.error('Simulation failed. Revert reason:', msg);
    process.exit(1);
  }
  console.log('Simulation OK.');

  const signedTx = await tronWebRelayer.trx.sign(simulationResult.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastResult = await tronWebRelayer.trx.sendRawTransaction(signedTx);

  if (!broadcastResult.result) {
    console.error('Broadcast failed:', broadcastResult.message || broadcastResult);
    process.exit(1);
  }
  console.log('Tx broadcast OK. TxID:', broadcastResult.txid);
  await waitforTxConfirmation(tronWebRelayer, broadcastResult.txid);

  const balanceAccountAfter = await tronWebRelayer.trx.getBalance(userGasFreeAccountAddress);
  const balanceVaultAfter = await tronWebRelayer.trx.getBalance(DEX_VAULT_ADDRESS);
  const balanceRelayerAfter = await tronWebRelayer.trx.getBalance(relayerAddress);
  const accNum = typeof balanceAccountAfter === 'object' ? Number(balanceAccountAfter.balance ?? 0) : Number(balanceAccountAfter ?? 0);
  const vaultNum = typeof balanceVaultAfter === 'object' ? Number(balanceVaultAfter.balance ?? 0) : Number(balanceVaultAfter ?? 0);
  const relNum = typeof balanceRelayerAfter === 'object' ? Number(balanceRelayerAfter.balance ?? 0) : Number(balanceRelayerAfter ?? 0);

  console.log('\n--- TRX balances after deposit ---');
  console.log('GasFreeAccount:', accNum, 'sun');
  console.log('DEX Vault:', vaultNum, 'sun');
  console.log('Relayer:', relNum, 'sun (includes fee)');
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
