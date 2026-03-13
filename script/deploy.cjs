const { TronWeb } = require('tronweb');
const { readFileSync, writeFileSync } = require('fs'); // Import writeFileSync
const { join } = require('path');
const solc = require('solc'); // Import standard solc

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs'); // Import the utility function

/** Decode TRON API error message: if it's hex-encoded UTF-8, return decoded string. */
function decodeErrorMessage(msg) {
  if (typeof msg !== 'string' || msg.length < 2) return msg;
  const hex = msg.startsWith('0x') ? msg.slice(2) : msg;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return msg;
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return msg;
  }
}

const networks = {
  mainnet: {
    fullNode: 'https://api.trongrid.io',
    solidityNode: 'https://api.trongrid.io',
    eventServer: 'https://api.trongrid.io',
    name: 'Mainnet',
    usdtAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  },
  nile: {
    fullNode: 'https://api.nileex.io',
    solidityNode: 'https://api.nileex.io',
    eventServer: 'https://api.nileex.io',
    name: 'Nile Testnet',
    usdtAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
  }
};

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

  // --- Ensure deployer account exists and has balance (required on TRON) ---
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
  console.log("Compiling contracts...");
  const contractNames = ["GasFreeFactory", "GasFreeController", "DEXVaultV1"];
  const contractFiles = {
    // Local project files
    "contracts/GasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/GasFreeFactory.sol'), 'utf8'),
    "contracts/GasFreeController.sol": readFileSync(join(__dirname, '../contracts/GasFreeController.sol'), 'utf8'),
    "contracts/lib/IERC20.sol": readFileSync(join(__dirname, '../contracts/lib/IERC20.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeAccount.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeFactory.sol'), 'utf8'),
    "contracts/GasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/GasFreeAccount.sol'), 'utf8'),
    "contracts/DEXVaultV1.sol": readFileSync(join(__dirname, '../contracts/DEXVaultV1.sol'), 'utf8'),

    // OpenZeppelin dependencies with virtual paths
    "@openzeppelin/contracts/utils/cryptography/EIP712.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/cryptography/ECDSA.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/cryptography/ECDSA.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/ShortStrings.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/ShortStrings.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/IERC5267.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/IERC5267.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/Strings.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Strings.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/StorageSlot.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/StorageSlot.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/math/Math.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/math/Math.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/math/SafeCast.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/math/SafeCast.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/math/SignedMath.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/math/SignedMath.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/Panic.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Panic.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/ReentrancyGuard.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/ReentrancyGuard.sol'), 'utf8'),
    "@openzeppelin/contracts/token/ERC20/IERC20.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol'), 'utf8'),
    "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol'), 'utf8'),
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/Address.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Address.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/draft-IERC1822.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/draft-IERC1822.sol'), 'utf8'),
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol'), 'utf8'),
    "@openzeppelin/contracts/proxy/beacon/IBeacon.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/proxy/beacon/IBeacon.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/IERC1967.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/IERC1967.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/IERC1363.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/IERC1363.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/IERC20.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/IERC20.sol'), 'utf8'),
    "@openzeppelin/contracts/interfaces/IERC165.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/interfaces/IERC165.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/Errors.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Errors.sol'), 'utf8'),
    "@openzeppelin/contracts/utils/introspection/IERC165.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/introspection/IERC165.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol'), 'utf8'),
    "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol'), 'utf8'),
  };

  const input = {
    language: 'Solidity',
    sources: Object.keys(contractFiles).reduce((acc, file) => {
      acc[file] = { content: contractFiles[file] };
      return acc;
    }, {}),
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
      // Explicitly set EVM version for compatibility
      evmVersion: 'istanbul'
    },
  };
  
  // Use a specific, compatible solc version (e.g., 0.8.19)
  // Note: solc.loadCompiler is async. For synchronous use, ensure the solc version is globally compatible
  // or use a pre-downloaded compiler. For simplicity, we'll try direct compile first.
  const compiler = solc; // Use solc directly as it's installed as 0.8.33 and should be compatible
  const compiledOutput = JSON.parse(compiler.compile(JSON.stringify(input)));

  if (compiledOutput.errors) {
    compiledOutput.errors.forEach(err => {
      if (err.type === 'Warning') {
        console.warn(err.formattedMessage);
      } else {
        console.error(err.formattedMessage);
        throw new Error("Solidity compilation failed.");
      }
    });
  }

  const artifacts = {};
  for (const name of contractNames) {
    const mainContractName = `${name}.sol`; // e.g., "GasFreeFactory.sol"
    const contractPath = Object.keys(compiledOutput.contracts).find(path => path.endsWith(mainContractName));

    if (!contractPath || !compiledOutput.contracts[contractPath] || !compiledOutput.contracts[contractPath][name]) {
        throw new Error(`Compilation output missing for contract: ${name} in path ${contractPath}`);
    }
    
    artifacts[name] = {
      abi: compiledOutput.contracts[contractPath][name].abi,
      bytecode: `0x${compiledOutput.contracts[contractPath][name].evm.bytecode.object}`,
    };
  }
  console.log("Contracts compiled successfully.");

  // --- 1. Deploy DEXVaultV1 ---
  const DEXVaultV1Artifact = artifacts.DEXVaultV1;
  console.log("Deploying DEXVaultV1...");
  const dexVaultUnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
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

  const dexVaultSignedTx = await tronWeb.trx.sign(dexVaultUnsignedTx, DEPLOYER_PRIVATE_KEY);
  const dexVaultBroadcast = await tronWeb.trx.sendRawTransaction(dexVaultSignedTx);

  if (!dexVaultBroadcast.result) {
    const msg = decodeErrorMessage(dexVaultBroadcast.message || dexVaultBroadcast.code);
    throw new Error(`DEXVaultV1 Deployment failed: ${msg}`);
  }
  console.log(`DEXVaultV1 Deployment TxID: ${dexVaultBroadcast.txid}`);
  
  const dexVaultTxInfo = await waitforTxConfirmation(tronWeb, dexVaultBroadcast.txid);
  const dexVaultAddress = dexVaultTxInfo.contractAddress;
  console.log(`DEXVaultV1 deployed at: ${dexVaultAddress}`);

  // --- Initialize DEXVaultV1 ---
  console.log("Initializing DEXVaultV1...");
  
  const signerUserAddress = USER_PRIVATE_KEY ? tronWeb.address.fromPrivateKey(USER_PRIVATE_KEY) : deployerAddress;
  const signers = [
      deployerAddress,
      signerUserAddress,
      "TH4mWB3dSF5R3UiZw67Qm27TYTC8jXkNyA"
  ];
  
  const withdrawUSDTLimit = "10000000000"; // 10,000 USDT
  const withdrawETHLimit = "1000000000";   // 1,000 TRX

  console.log("Simulating DEXVaultV1 initialize transaction...");
  const initTransaction = await tronWeb.transactionBuilder.triggerSmartContract(
    dexVaultAddress,
    "initialize(address[],address,uint256,uint256)",
    {
      feeLimit: 500_000_000,
      callValue: 0
    },
    [
      { type: 'address[]', value: signers },
      { type: 'address', value: usdtAddress },
      { type: 'uint256', value: withdrawUSDTLimit },
      { type: 'uint256', value: withdrawETHLimit }
    ],
    deployerAddress
  );

  if (!initTransaction.result || !initTransaction.result.result) {
    const revertReason = initTransaction.result && initTransaction.result.message ? tronWeb.toUtf8(initTransaction.result.message) : "Unknown revert reason";
    throw new Error(`DEXVaultV1 Initialize simulation failed: ${revertReason}`);
  }

  console.log("Simulation successful. Signing and broadcasting...");
  const signedInitTx = await tronWeb.trx.sign(initTransaction.transaction, DEPLOYER_PRIVATE_KEY);
  const broadcastInit = await tronWeb.trx.sendRawTransaction(signedInitTx);

  if (!broadcastInit.result) {
    const rawMsg = broadcastInit.message || broadcastInit.code;
    const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, '')) ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
    throw new Error(`Broadcast failed: ${msg}`);
  }
  console.log(`DEXVaultV1 Initialize TxID: ${broadcastInit.txid}`);
  await waitforTxConfirmation(tronWeb, broadcastInit.txid);

  // --- 2. Deploy GasFreeController (with vault in constructor) ---
  const GasFreeControllerArtifact = artifacts.GasFreeController;

  const EIP712_DOMAIN_NAME = "GasFreeController";
  const EIP712_DOMAIN_VERSION = "V1.0.0";

  console.log("Deploying GasFreeController...");
  const vaultAddressHex = tronWeb.address.toHex(dexVaultAddress);
  console.log("vaultAddressHex:", vaultAddressHex);

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
    const msg = decodeErrorMessage(controllerTxResult.message);
    throw new Error(`Failed to send GasFreeController transaction: ${msg} (Code: ${controllerTxResult.code})`);
  }
  const controllerTxId = controllerTxResult.txid;

  const controllerTxInfo = await waitforTxConfirmation(tronWeb, controllerTxId);
  if (!controllerTxInfo.contractAddress) {
    throw new Error("GasFreeController contract address not found in transaction receipt.");
  }
  const controllerAddress = controllerTxInfo.contractAddress;
  console.log("GasFreeController deployed to:", controllerAddress);

  // --- 3. Set initial fees for GasFreeController ---
  console.log("Setting initial fees for GasFreeController...");
  const controllerInstance = await tronWeb.contract(GasFreeControllerArtifact.abi, controllerAddress);
  const activateFee = tronWeb.toSun('1', 'TRC20'); // 1 USDT
  const transferFee = tronWeb.toSun('1', 'TRC20'); // 1 USDT for TRC20
  const transferFeeTRX = tronWeb.toSun('1'); // 1 TRX (in sun)

  const setFeesTxId = await controllerInstance.setFees(activateFee, transferFee, transferFeeTRX).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setFeesTxId);
  console.log("GasFreeController fees set transaction ID:", setFeesTxId);

  // --- 4. Deploy GasFreeFactory ---
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
    const msg = decodeErrorMessage(factoryTxResult.message);
    throw new Error(`Failed to send GasFreeFactory transaction: ${msg} (Code: ${factoryTxResult.code})`);
  }
  const factoryTxId = factoryTxResult.txid;

  const factoryTxInfo = await waitforTxConfirmation(tronWeb, factoryTxId);
  if (!factoryTxInfo.contractAddress) {
    throw new Error("GasFreeFactory contract address not found in transaction receipt.");
  }
  const factoryAddress = factoryTxInfo.contractAddress;
  console.log("GasFreeFactory deployed to:", factoryAddress);

  // --- 5. Set the correct controller address in GasFreeFactory ---
  console.log("Setting controller address in GasFreeFactory...");
  const factoryInstance = await tronWeb.contract(GasFreeFactoryArtifact.abi, factoryAddress);
  const setControllerTxId = await factoryInstance.setController(controllerAddress).send({
    feeLimit: 100_000_000,
    callValue: 0,
    shouldPollResponse: false
  });
  await waitforTxConfirmation(tronWeb, setControllerTxId);
  console.log("GasFreeFactory controller set transaction ID:", setControllerTxId);

  // --- 6. Create an initial GasFreeAccount for the deployer ---
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
    const txInfo = await waitforTxConfirmation(tronWeb, txid);
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

  // --- 7. Save deployed addresses to JSON file ---
  const deployedAddresses = {
    factoryAddress: factoryAddress,
    controllerAddress: controllerAddress,
    userGasFreeAccountAddress: userGasFreeAccountAddress,
    nileUsdtAddress: usdtAddress, // Keep key for compatibility
    dexVaultAddress: dexVaultAddress
  };
  const deployedAddressesPath = join(__dirname, `../deployed-addresses.${NETWORK}.json`);
  writeFileSync(deployedAddressesPath, JSON.stringify(deployedAddresses, null, 2), 'utf8');
  console.log(`Deployed addresses saved to ${deployedAddressesPath}`);



    // --- 8. Send 33 USDT and 33 TRX to the userGasFreeAccountAddress ---
    const fundAmountUsdt = '33000000'; // 33 USDT (6 decimals)
    const fundAmountTrx = tronWeb.toSun('33'); // 33 TRX in sun
  
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
    await waitforTxConfirmation(tronWeb, trxBroadcast.txid);
    console.log(`33 TRX sent to ${userGasFreeAccountAddress}. TxID: ${trxBroadcast.txid}`);
  


  return {
    factoryAddress: factoryAddress,
    controllerAddress: controllerAddress,
    dexVaultAddress: dexVaultAddress
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
