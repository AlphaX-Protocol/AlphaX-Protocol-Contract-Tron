const { TronWeb } = require('tronweb');
const { readFileSync } = require('fs');
const { join } = require('path');
const solc = require('solc');

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

async function main() {
  // --- Configuration ---
  const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Please use 'mainnet' or 'nile'.`);
  }

  if (!USER_PRIVATE_KEY) {
    console.error("Missing USER_PRIVATE_KEY in .env file.");
    process.exit(1);
  }

  if (USER_PRIVATE_KEY === DEPLOYER_PRIVATE_KEY) {
    console.log("ℹ️ User and Deployer are using the same wallet. Gas will be paid by this account.");
  }

  // --- Load Deployed Addresses ---
  const deployedAddressesPath = join(__dirname, `../deployed-addresses.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, 'utf8'));
  } catch (error) {
    console.error(`Error loading deployed addresses: ${error.message}`);
    process.exit(1);
  }

  const { userGasFreeAccountAddress, nileUsdtAddress, controllerAddress } = deployedAddresses;

  if (!userGasFreeAccountAddress || !nileUsdtAddress || !controllerAddress) {
    console.error("userGasFreeAccountAddress, nileUsdtAddress, or controllerAddress not found in deployed-addresses.json.");
    process.exit(1);
  }

  // --- Initialize TronWeb ---
  const tronWeb = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    USER_PRIVATE_KEY
  );
  const userAddress = tronWeb.address.fromPrivateKey(USER_PRIVATE_KEY);
  console.log(`Calling approveTokenOnAccount from user address: ${userAddress} on ${networkConfig.name}`);


  // --- Compile Contracts to get ABI for GasFreeController ---
  console.log("Compiling contracts for ABI...");
  const contractNames = ["GasFreeController", "GasFreeAccount", "GasFreeFactory"]; // Need Factory and Account ABI for Controller's interfaces
  const contractFiles = {
    // We need to compile all contracts to get the correct ABI for the controller and its interfaces
    "contracts/GasFreeController.sol": readFileSync(join(__dirname, '../contracts/GasFreeController.sol'), 'utf8'),
    "contracts/GasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/GasFreeFactory.sol'), 'utf8'), // Needed for IGasFreeFactory
    "contracts/GasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/GasFreeAccount.sol'), 'utf8'), // Needed for IGasFreeAccount
    "contracts/lib/IERC20.sol": readFileSync(join(__dirname, '../contracts/lib/IERC20.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeAccount.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeFactory.sol'), 'utf8'),
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
    "@openzeppelin/contracts/utils/Panic.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Panic.sol'), 'utf8')
  };

  const input = {
    language: 'Solidity',
    sources: Object.keys(contractFiles).reduce((acc, file) => {
      acc[file] = { content: contractFiles[file] };
      return acc;
    }, {}),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi'] } },
      evmVersion: 'istanbul'
    },
  };

  const compiledOutput = JSON.parse(solc.compile(JSON.stringify(input)));

  if (compiledOutput.errors) {
    compiledOutput.errors.forEach(err => {
      if (err.type !== 'Warning') {
        console.error(err.formattedMessage);
        throw new Error("Solidity compilation failed.");
      }
    });
  }
  const GasFreeControllerArtifact = compiledOutput.contracts["contracts/GasFreeController.sol"].GasFreeController;
  const gasFreeControllerAbi = GasFreeControllerArtifact.abi;
  // 获取 GasFreeAccount 的 ABI 用于诊断
  const GasFreeAccountArtifact = compiledOutput.contracts["contracts/GasFreeAccount.sol"].GasFreeAccount;


  // --- Call approveTokenOnAccount on Controller ---
  try {
    console.log(`Calling 'approveTokenOnAccount' on controller ${controllerAddress} for account ${userGasFreeAccountAddress} to approve token ${nileUsdtAddress}...`);

    // --- 🔍 诊断步骤：检查链上状态 ---
    console.log("\n🔍 Running Pre-flight Diagnostics...");

    // 1. 检查 Controller 所有权
    const controllerContract = tronWeb.contract(GasFreeControllerArtifact.abi, controllerAddress);
    const onChainOwner = await controllerContract.owner().call();
    // 统一转换为 Hex 格式比较，避免格式差异
    if (tronWeb.address.toHex(onChainOwner) !== tronWeb.address.toHex(userAddress)) {
        console.error(`❌ FAILURE: Current User (${userAddress}) is NOT the owner of GasFreeController.`);
        console.error(`   Controller Owner is: ${tronWeb.address.fromHex(onChainOwner)}`);
        console.error("   Reason: 'approveTokenOnAccount' has onlyOwner modifier.");
        process.exit(1);
    }
    console.log("✅ User is the owner of GasFreeController.");

    // 2. 检查 GasFreeAccount 绑定的 Controller
    try {
        const accountContract = tronWeb.contract(GasFreeAccountArtifact.abi, userGasFreeAccountAddress);
        const storedController = await accountContract.controller().call();
        if (tronWeb.address.toHex(storedController) !== tronWeb.address.toHex(controllerAddress)) {
            console.error(`❌ FAILURE: GasFreeAccount is linked to a DIFFERENT Controller.`);
            console.error(`   Account stores: ${tronWeb.address.fromHex(storedController)}`);
            console.error(`   Current Controller: ${controllerAddress}`);
            console.error("   Reason: GasFreeAccount rejects calls from non-controller addresses.");
            process.exit(1);
        }
        console.log("✅ GasFreeAccount is linked to the correct Controller.");
    } catch (err) {
        console.error(`❌ FAILURE: Could not read from GasFreeAccount (${userGasFreeAccountAddress}).`);
        console.error("   Reason: The account contract might not be deployed yet.");
        process.exit(1);
    }
    console.log("--- Diagnostics Passed ---\n");

    // 1. 使用 triggerSmartContract 进行交易模拟
    const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
      controllerAddress,
      "approveTokenOnAccount(address,address)",
      {
        feeLimit: 100_000_000,
        callValue: 0
      },
      [
        { type: 'address', value: userGasFreeAccountAddress },
        { type: 'address', value: nileUsdtAddress }
      ],
      userAddress
    );

    if (!transaction.result || !transaction.result.result) {
      const revertReason = transaction.result && transaction.result.message ? tronWeb.toUtf8(transaction.result.message) : "Unknown revert reason";
      throw new Error(`Transaction simulation failed: ${revertReason}`);
    }

    console.log("Simulation successful. Signing and broadcasting transaction...");

    // 2. 对模拟生成的交易对象进行签名
    const signedTx = await tronWeb.trx.sign(transaction.transaction, USER_PRIVATE_KEY);

    // 3. 广播交易
    const broadcast = await tronWeb.trx.sendRawTransaction(signedTx);

    if (!broadcast.result) {
      throw new Error(`Broadcast failed: ${broadcast.message ? tronWeb.toUtf8(broadcast.message) : "Unknown error"}`);
    }

    console.log("Transaction sent. TxID:", broadcast.txid);

    await waitforTxConfirmation(tronWeb, broadcast.txid);

    console.log(`✅ Successfully called 'approveTokenOnAccount' on controller for account ${userGasFreeAccountAddress} and token ${nileUsdtAddress}.`);

  } catch (error) {
    console.error("Error calling approveTokenOnAccount:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
