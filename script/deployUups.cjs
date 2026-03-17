const { TronWeb } = require('tronweb');
const { writeFileSync } = require('fs');
const { join } = require('path');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('./utils/compile.cjs');
const { networks, decodeErrorMessage, toAbiAddress, pad32 } = require('./utils/common.cjs');

/**
 * ABI-encode the ERC1967Proxy constructor args: (address implementation, bytes _data).
 * _data is the encoded initialize() calldata (or empty for two-step deployment).
 */
function buildProxyConstructorArgs(implAddr20Hex, initCalldata) {
  let args = '';
  args += pad32(implAddr20Hex);
  args += pad32('40'); // offset to bytes payload (2 words = 64 = 0x40)

  if (!initCalldata || initCalldata.length === 0) {
    args += pad32('0');
  } else {
    const dataLenBytes = initCalldata.length / 2;
    args += pad32(dataLenBytes.toString(16));
    args += initCalldata;
    const remainder = initCalldata.length % 64;
    if (remainder > 0) args += '0'.repeat(64 - remainder);
  }
  return args;
}

/**
 * Build ABI-encoded calldata for:
 *   initialize(address[] memory allowedSigners, address usdt, uint256 _withdrawUSDTLimit, uint256 _withdrawETHLimit)
 */
function buildInitCalldata(tronWeb, signersAddr20, usdtAddr20, withdrawUSDTLimit, withdrawETHLimit) {
  const sigHash = tronWeb.sha3('initialize(address[],address,uint256,uint256)');
  const selector = (sigHash.startsWith('0x') ? sigHash.slice(2) : sigHash).slice(0, 8);

  let data = selector;
  data += pad32('80'); // offset for address[] (4 static slots * 32 = 128 = 0x80)
  data += pad32(usdtAddr20);
  data += pad32(BigInt(withdrawUSDTLimit).toString(16));
  data += pad32(BigInt(withdrawETHLimit).toString(16));
  data += pad32(signersAddr20.length.toString(16));
  for (const s of signersAddr20) {
    data += pad32(s);
  }
  return data;
}

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

  // --- Ensure deployer account exists and has balance ---
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
  const artifacts = compileContracts(['core', 'vault', 'proxy']);

  // ========================================================================
  //  1. Deploy DEXVaultV1 IMPLEMENTATION (logic contract, not initialised)
  // ========================================================================
  const DEXVaultV1Artifact = artifacts.DEXVaultV1;
  console.log("Deploying DEXVaultV1 implementation...");
  const implUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
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

  const implSignedTx = await tronWeb.trx.sign(implUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const implBroadcast = await tronWeb.trx.sendRawTransaction(implSignedTx);
  if (!implBroadcast.result) {
    throw new Error(`DEXVaultV1 Impl deploy failed: ${decodeErrorMessage(implBroadcast.message || implBroadcast.code)}`);
  }
  console.log(`DEXVaultV1 Impl TxID: ${implBroadcast.txid}`);
  const implTxInfo = await waitforTxConfirmation(tronWeb, implBroadcast.txid);
  const implAddress = implTxInfo.contractAddress;
  console.log(`DEXVaultV1 implementation deployed at: ${implAddress}`);

  // ========================================================================
  //  2. Deploy ERC1967Proxy → points to implementation, calls initialize()
  // ========================================================================
  const signerUserAddress = USER_PRIVATE_KEY ? tronWeb.address.fromPrivateKey(USER_PRIVATE_KEY) : deployerAddress;
  const signers = [
    deployerAddress,
    signerUserAddress,
    "TH4mWB3dSF5R3UiZw67Qm27TYTC8jXkNyA"
  ];
  const withdrawUSDTLimit = "10000000000"; // 10,000 USDT
  const withdrawETHLimit  = "1000000000";  // 1,000 TRX

  const signersHex = signers.map(s => toAbiAddress(tronWeb, s));
  const usdtHex    = toAbiAddress(tronWeb, usdtAddress);
  const implHex    = toAbiAddress(tronWeb, implAddress);

  const initCalldata      = buildInitCalldata(tronWeb, signersHex, usdtHex, withdrawUSDTLimit, withdrawETHLimit);
  const constructorArgs   = buildProxyConstructorArgs(implHex, initCalldata);

  const ERC1967ProxyArtifact = artifacts.ERC1967Proxy;
  const proxyBytecodeWithArgs = ERC1967ProxyArtifact.bytecode + constructorArgs;

  console.log("Deploying ERC1967Proxy (UUPS) with initialize calldata...");
  const proxyUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: ERC1967ProxyArtifact.abi.filter(i => i.type !== 'constructor'),
      bytecode: proxyBytecodeWithArgs,
      feeLimit: 1000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    deployerAddress
  );

  const proxySignedTx = await tronWeb.trx.sign(proxyUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const proxyBroadcast = await tronWeb.trx.sendRawTransaction(proxySignedTx);
  if (!proxyBroadcast.result) {
    throw new Error(`ERC1967Proxy deploy failed: ${decodeErrorMessage(proxyBroadcast.message || proxyBroadcast.code)}`);
  }
  console.log(`ERC1967Proxy TxID: ${proxyBroadcast.txid}`);
  const proxyTxInfo = await waitforTxConfirmation(tronWeb, proxyBroadcast.txid);
  const dexVaultAddress = proxyTxInfo.contractAddress; // proxy IS the vault address
  console.log(`DEXVault UUPS proxy deployed at: ${dexVaultAddress}`);

  // Quick sanity check: read owner through the proxy
  const vaultInstance = await tronWeb.contract(DEXVaultV1Artifact.abi, dexVaultAddress);
  const proxyOwner = await vaultInstance.owner().call();
  console.log(`Proxy owner (should be deployer): ${tronWeb.address.fromHex(proxyOwner)}`);

  // ========================================================================
  //  3. Deploy GasFreeController (with vault / proxy address in constructor)
  // ========================================================================
  const GasFreeControllerArtifact = artifacts.GasFreeController;
  const EIP712_DOMAIN_NAME    = "GasFreeController";
  const EIP712_DOMAIN_VERSION = "V1.0.0";

  console.log("Deploying GasFreeController...");
  const vaultAddressHex = tronWeb.address.toHex(dexVaultAddress);

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
    throw new Error(`Failed to send GasFreeController transaction: ${decodeErrorMessage(controllerTxResult.message)} (Code: ${controllerTxResult.code})`);
  }
  const controllerTxInfo = await waitforTxConfirmation(tronWeb, controllerTxResult.txid);
  if (!controllerTxInfo.contractAddress) {
    throw new Error("GasFreeController contract address not found in transaction receipt.");
  }
  const controllerAddress = controllerTxInfo.contractAddress;
  console.log("GasFreeController deployed to:", controllerAddress);

  // ========================================================================
  //  4. Set initial fees for GasFreeController
  // ========================================================================
  console.log("Setting initial fees for GasFreeController...");
  const controllerInstance = await tronWeb.contract(GasFreeControllerArtifact.abi, controllerAddress);
  const activateFee   = tronWeb.toSun('1', 'TRC20');
  const transferFee   = tronWeb.toSun('1', 'TRC20');
  const transferFeeTRX = tronWeb.toSun('1');

  const setFeesTxId = await controllerInstance.setFees(activateFee, transferFee, transferFeeTRX).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setFeesTxId);
  console.log("GasFreeController fees set transaction ID:", setFeesTxId);

  // ========================================================================
  //  5. Deploy GasFreeFactory
  // ========================================================================
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
    throw new Error(`Failed to send GasFreeFactory transaction: ${decodeErrorMessage(factoryTxResult.message)} (Code: ${factoryTxResult.code})`);
  }
  const factoryTxInfo = await waitforTxConfirmation(tronWeb, factoryTxResult.txid);
  if (!factoryTxInfo.contractAddress) {
    throw new Error("GasFreeFactory contract address not found in transaction receipt.");
  }
  const factoryAddress = factoryTxInfo.contractAddress;
  console.log("GasFreeFactory deployed to:", factoryAddress);

  // ========================================================================
  //  6. Set the controller in GasFreeFactory
  // ========================================================================
  console.log("Setting controller address in GasFreeFactory...");
  const factoryInstance = await tronWeb.contract(GasFreeFactoryArtifact.abi, factoryAddress);
  const setControllerTxId = await factoryInstance.setController(controllerAddress).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setControllerTxId);
  console.log("GasFreeFactory controller set transaction ID:", setControllerTxId);

  // ========================================================================
  //  7. Create an initial GasFreeAccount for the deployer
  // ========================================================================
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
    await waitforTxConfirmation(tronWeb, txid);
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

  // ========================================================================
  //  8. Save deployed addresses
  // ========================================================================
  const deployedAddresses = {
    factoryAddress,
    controllerAddress,
    userGasFreeAccountAddress,
    nileUsdtAddress: usdtAddress,
    dexVaultProxy: dexVaultAddress,
    dexVaultImplementation: implAddress,
  };
  const deployedAddressesPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  writeFileSync(deployedAddressesPath, JSON.stringify(deployedAddresses, null, 2), 'utf8');
  console.log(`Deployed addresses saved to ${deployedAddressesPath}`);

  // ========================================================================
  //  9. Fund the GasFreeAccount with 33 USDT + 33 TRX
  // ========================================================================
  const fundAmountUsdt = '33000000'; // 33 USDT (6 decimals)
  const fundAmountTrx  = tronWeb.toSun('33');

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
  //await waitforTxConfirmation(tronWeb, trxBroadcast.txid);
  console.log(`33 TRX sent to ${userGasFreeAccountAddress}. TxID: ${trxBroadcast.txid}`);

  return {
    factoryAddress,
    controllerAddress,
    dexVaultProxy: dexVaultAddress,
    dexVaultImplementation: implAddress,
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
