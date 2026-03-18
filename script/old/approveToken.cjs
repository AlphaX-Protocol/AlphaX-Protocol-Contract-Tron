const { TronWeb } = require('tronweb');
const { readFileSync } = require('fs');
const { join } = require('path');

require('dotenv').config();

const waitforTxConfirmation = require('../utils/waitforTxConfirmation.cjs');
const { compileContracts } = require('../utils/compile.cjs');
const { networks } = require('../utils/common.cjs');

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
  const deployedAddressesPath = join(__dirname, `../../deployed-addresses.${NETWORK}.json`);
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
  const artifacts = compileContracts(['core']);
  const GasFreeControllerArtifact = artifacts.GasFreeController;
  const GasFreeAccountArtifact = artifacts.GasFreeAccount;

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
