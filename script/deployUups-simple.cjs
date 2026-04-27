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
    "TBCXtdouS5FS8WMjtz3yh5FqQkzojek4B6",
    "TMyFVsd77vJ6Cv4LKwJeV7YLfRVF8JyerJ",
    "TVca19k8rHwzTQEkCbn7Qpt8vTeaYZWZ7T"
  ];
  const withdrawUSDTLimit = "142000000000";   // 142,000 USDT
  const withdrawETHLimit  = "426000000000";   // 426,000 TRX

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
  //  3. Save deployed addresses
  // ========================================================================
  const deployedAddresses = {
    nileUsdtAddress: usdtAddress,
    dexVaultProxy: dexVaultAddress,
    dexVaultImplementation: implAddress,
  };
  const deployedAddressesPath = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  writeFileSync(deployedAddressesPath, JSON.stringify(deployedAddresses, null, 2), 'utf8');
  console.log(`Deployed addresses saved to ${deployedAddressesPath}`);

  
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
