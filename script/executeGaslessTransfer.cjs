const { readFileSync } = require('fs');
const { join } = require('path');
const { TronWeb } = require('tronweb');
const solc = require('solc'); // Import standard solc

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs'); // Import the utility function

const networks = {
  mainnet: {
    fullNode: 'https://api.trongrid.io',
    solidityNode: 'https://api.trongrid.io',
    eventServer: 'https://api.trongrid.io',
    chainId: 728126428,
    name: 'Mainnet'
  },
  nile: {
    fullNode: 'https://api.nileex.io',
    solidityNode: 'https://api.nileex.io',
    eventServer: 'https://api.nileex.io',
    chainId: 3448148188,
    name: 'Nile Testnet'
  }
};

/**
 * 将 TRON 地址转换为合约期望的 20 字节标准 Hex
 */
function toStandardHex(tronWeb, address) {
    // 1. 获取 Hex (通常是 41... 格式)
    let hex = tronWeb.address.toHex(address); 
    
    // 2. 移除 41 前缀 (如果存在)
    // 注意：有些工具返回的 hex 已经带了 0x，有些没带。这里做健壮性处理。
    if (hex.startsWith('0x')) hex = hex.slice(2);
    if (hex.startsWith('41')) hex = hex.slice(2);
    
    // 3. 返回以 0x 开头的 20 字节格式
    return "0x" + hex;
}

async function main() {
  // --- Configuration ---
  const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY;
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY; // Relayer's private key
  const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;
  const NETWORK = process.env.NETWORK || 'nile';

  const networkConfig = networks[NETWORK];
  if (!networkConfig) {
    throw new Error(`Unknown network: ${NETWORK}. Please use 'mainnet' or 'nile'.`);
  }

  if (!USER_PRIVATE_KEY || !DEPLOYER_PRIVATE_KEY || !RECIPIENT_ADDRESS) {
    console.error("Missing one or more environment variables: USER_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY, RECIPIENT_ADDRESS.");
    process.exit(1);
  }

  // --- Load Deployed Addresses ---
  const deployedAddressesPath = join(__dirname, `../deployed-addresses.${NETWORK}.json`);
  let deployedAddresses;
  try {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, 'utf8'));
    console.log(`Loaded deployed addresses from ${deployedAddressesPath}`);
  } catch (error) {
    console.error(`Error loading deployed addresses from ${deployedAddressesPath}: ${error.message}`);
    console.error("Please run deploy.cjs first to deploy contracts and save addresses.");
    process.exit(1);
  }

  const GAS_FREE_CONTROLLER_ADDRESS = deployedAddresses.controllerAddress;
  const USDT_ADDRESS = deployedAddresses.nileUsdtAddress; // Use the fixed Nile USDT address from JSON

  if (!GAS_FREE_CONTROLLER_ADDRESS || !USDT_ADDRESS) {
    console.error("Missing one or more contract addresses in deployed-addresses.json: controllerAddress, nileUsdtAddress.");
    process.exit(1);
  }

  // --- Initialize TronWeb ---
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

  const userAddress = tronWebUser.address.fromPrivateKey(USER_PRIVATE_KEY);
  const relayerAddress = tronWebRelayer.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);

  console.log("User wallet address:", userAddress);
  console.log(`Relayer wallet address: ${relayerAddress} on ${networkConfig.name}`);

  // --- Compile Contracts ---
  console.log("Compiling contracts for ABI...");
  const contractNames = ["GasFreeController", "GasFreeFactory", "IERC20", "GasFreeAccount"];
  const contractFiles = {
    // Local project files
    "contracts/GasFreeController.sol": readFileSync(join(__dirname, '../contracts/GasFreeController.sol'), 'utf8'),
    "contracts/GasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/GasFreeFactory.sol'), 'utf8'),
    "contracts/lib/IERC20.sol": readFileSync(join(__dirname, '../contracts/lib/IERC20.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeAccount.sol'), 'utf8'),
    "contracts/interfaces/IGasFreeFactory.sol": readFileSync(join(__dirname, '../contracts/interfaces/IGasFreeFactory.sol'), 'utf8'),
    "contracts/GasFreeAccount.sol": readFileSync(join(__dirname, '../contracts/GasFreeAccount.sol'), 'utf8'),

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
    "@openzeppelin/contracts/utils/Panic.sol": readFileSync(join(__dirname, '../node_modules/@openzeppelin/contracts/utils/Panic.sol'), 'utf8')
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
        evmVersion: 'istanbul'
    },
  };

  const compiledOutput = JSON.parse(solc.compile(JSON.stringify(input)));

  if (compiledOutput.errors) {
    let hasError = false;
    compiledOutput.errors.forEach(err => {
      if (err.type === 'Warning') {
        console.warn(err.formattedMessage);
      } else {
        console.error(err.formattedMessage);
        hasError = true;
      }
    });
    if (hasError) {
        throw new Error("Solidity compilation failed.");
    }
  }

  const contractPathMap = {
    "GasFreeController": "contracts/GasFreeController.sol",
    "GasFreeFactory": "contracts/GasFreeFactory.sol",
    "IERC20": "contracts/lib/IERC20.sol",
    "GasFreeAccount": "contracts/GasFreeAccount.sol",
  };

  const artifacts = {};
  for (const name of contractNames) {
    const filePath = contractPathMap[name];
    if (!filePath) {
      throw new Error(`Mapping missing for contract: ${name}. Please add it to contractPathMap.`);
    }
    if (!compiledOutput.contracts[filePath] || !compiledOutput.contracts[filePath][name]) {
        throw new Error(`Compilation output missing for contract: ${name} at path ${filePath}`);
    }
    artifacts[name] = {
      abi: compiledOutput.contracts[filePath][name].abi,
    };
  }
  console.log("Contracts compiled successfully.");


  // --- Attach to Controller Contract ---
  const GasFreeControllerArtifact = artifacts.GasFreeController;
  const IERC20Artifact = artifacts.IERC20;

  const controller = tronWebRelayer.contract(GasFreeControllerArtifact.abi, GAS_FREE_CONTROLLER_ADDRESS);

  // --- User-side: Prepare and Sign PermitTransfer Message ---

  // 1. Fetch current nonce for the user's GasFreeAccount
  const nonce = await controller.nonces(userAddress).call();
  console.log(`User's current nonce: ${Number(nonce)}`); // Nonce from TronWeb is BigNumber

  // 2. EIP-712 Domain (must match GasFreeController.sol)
  // Tron chainId for Nile Testnet is 3448148188 (0xcd8690dc)
  const domain = {
    name: "GasFreeController",
    version: "V1.0.0",
    chainId: networkConfig.chainId,
    verifyingContract: GAS_FREE_CONTROLLER_ADDRESS,
  };

  // 3. EIP-712 Types (must match GasFreeController.sol)
  const types = {
    PermitTransfer: [
      { name: "token", type: "address" },
      { name: "serviceProvider", type: "address" },
      { name: "user", type: "address" },
      { name: "receiver", type: "address" },
      { name: "value", type: "uint256" },
      { name: "maxFee", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "version", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  // 4. Message Data
  const transferValue = tronWebUser.toSun('5', 6); // 5 USDT, assuming 6 decimals for TRC20
  const maxFee = tronWebUser.toSun('0.2', 6); // Max fee user is willing to pay (0.2 USDT)
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  const message = {
    // 使用你之前定义的 toStandardHex 函数
    token: toStandardHex(tronWebUser, USDT_ADDRESS),
    serviceProvider: toStandardHex(tronWebUser, relayerAddress),
    user: toStandardHex(tronWebUser, userAddress),
    receiver: toStandardHex(tronWebUser, RECIPIENT_ADDRESS),
    
    value: transferValue.toString(), 
    maxFee: maxFee.toString(),     
    deadline: deadline,
    version: 0,
    nonce: Number(nonce),
};

  console.log("\n--- User-side: Signing PermitTransfer ---");
  console.log("Message to sign:", JSON.stringify(message, null, 2));

  // 5. User signs the typed data
  const signature = tronWebUser.trx.signTypedData(domain, types, message, USER_PRIVATE_KEY);
  console.log("Generated Signature:", signature);

  // --- Relayer-side: Execute PermitTransfer ---

  console.log("\n--- Relayer-side: Executing PermitTransfer ---");

  // Get the user's GasFreeAccount address from deployed-addresses.json
  const userGasFreeAccountAddress = deployedAddresses.userGasFreeAccountAddress;
  console.log("User's predicted GasFreeAccount address:", userGasFreeAccountAddress);


  // --- Check GasFreeAccount USDT balance --- (Requirement 3)
  const usdt = tronWebRelayer.contract(IERC20Artifact.abi, USDT_ADDRESS);
  const gasFreeAccountBalance = await usdt.balanceOf(userGasFreeAccountAddress).call();
  console.warn("\ngasFreeAccountBalance", gasFreeAccountBalance)
  const gasFreeAccountBalanceFormatted = tronWebRelayer.fromSun(gasFreeAccountBalance, 6);

  if (parseFloat(gasFreeAccountBalanceFormatted) < parseFloat(tronWebRelayer.fromSun(transferValue, 6))) {
    console.error(`\n❌ Error: GasFreeAccount (${userGasFreeAccountAddress}) has insufficient USDT balance.`);
    console.error(`   Required: ${tronWebRelayer.fromSun(transferValue, 6)} USDT, Available: ${gasFreeAccountBalanceFormatted} USDT`);
    process.exit(1);
  }
      console.log(`✅ GasFreeAccount (${userGasFreeAccountAddress}) has sufficient USDT balance: ${gasFreeAccountBalanceFormatted} USDT.`);
  
  
    try {
      // Convert message object to an ordered array for the 'permit' tuple, ensuring addresses are in hex format with '0x' prefix
      const permitArray = [
        toStandardHex(tronWebRelayer, message.token),
        toStandardHex(tronWebRelayer, message.serviceProvider),
        toStandardHex(tronWebRelayer, message.user),
        toStandardHex(tronWebRelayer, message.receiver),
        message.value,
        message.maxFee,
        message.deadline,
        message.version,
        message.nonce,
      ];
      let signatureHex = signature;
      if (!signatureHex.startsWith('0x')) {
          signatureHex = '0x' + signatureHex;
      }
  
      console.log("Simulating executePermitTransfer call with triggerSmartContract...");
      let simulationResult = null;
      try {
        // 1. 预估 Energy 消耗
        let energyEstimate = await tronWebRelayer.transactionBuilder.estimateEnergy(
          GAS_FREE_CONTROLLER_ADDRESS,
          "executePermitTransfer((address,address,address,address,uint256,uint256,uint256,uint256,uint256),bytes,address)",
          {
            callValue: 0,
          },
          [
            { type: '(address,address,address,address,uint256,uint256,uint256,uint256,uint256)', value: permitArray },
            { type: 'bytes', value: signatureHex },
            { type: 'address', value: userGasFreeAccountAddress }
          ],
          relayerAddress
        );

        // Handle case where estimateEnergy returns an object (common in some TronWeb versions)
        if (typeof energyEstimate === 'object' && energyEstimate !== null) {
            energyEstimate = energyEstimate.energy_required || energyEstimate.energy_used || 0;
        }

        console.log(`\n🚀 Estimated Energy consumption: ${energyEstimate}`);

        // 获取当前网络 Energy 价格 (Sun/Energy)，如果获取失败则默认使用 420
        const chainParams = await tronWebRelayer.trx.getChainParameters();
        const energyFeeParam = chainParams.find(p => p.key === 'getEnergyFee');
        const energyPrice = energyFeeParam ? Number(energyFeeParam.value) : 420;

        // 根据预估 Energy * 1.2 * Energy 价格计算 feeLimit (单位: Sun)
        const dynamicFeeLimit = Math.floor(energyEstimate * 1.2 * energyPrice);
        console.log(`   Setting dynamic feeLimit: ${dynamicFeeLimit} Sun (${(dynamicFeeLimit / 1_000_000).toFixed(2)} TRX)\n`);
        
        simulationResult = await tronWebRelayer.transactionBuilder.triggerSmartContract(
          GAS_FREE_CONTROLLER_ADDRESS,
          "executePermitTransfer((address,address,address,address,uint256,uint256,uint256,uint256,uint256),bytes,address)",
          {
            callValue: 0,
            feeLimit: dynamicFeeLimit,
          },
          [
            { type: '(address,address,address,address,uint256,uint256,uint256,uint256,uint256)', value: permitArray },
            { type: 'bytes', value: signatureHex },
            { type: 'address', value: userGasFreeAccountAddress }
          ],
          relayerAddress
        );

        if (simulationResult && simulationResult.result && simulationResult.result.result === false) {
            const revertReason = simulationResult.result.message ? tronWebRelayer.toUtf8(simulationResult.result.message) : "Unknown revert reason";
            throw new Error(`Transaction simulation failed with revert: ${revertReason}`);
        }
        console.log("Simulation successful. Transaction is expected to succeed.");
      } catch (simError) {
        simulationResult = null;
        console.error("Transaction simulation failed:", simError.message || simError);
        console.error("Aborting transaction to avoid unnecessary TRX consumption.");
        process.exit(1);
      }
      
      if (!simulationResult) {
        console.error("Transaction simulation failed. simulationResult is undefined.");
        process.exit(1);
      }

      // 2. 对交易对象进行私钥签名
      // 注意：这里的 transaction 对象包含在 transaction.transaction 属性中
      const signedTransaction = await tronWebRelayer.trx.sign(
          simulationResult.transaction, 
          DEPLOYER_PRIVATE_KEY
      );

      // 3. 广播交易到网络
      const broadcastResult = await tronWebRelayer.trx.sendRawTransaction(signedTransaction);

      if (broadcastResult.result) {
          console.log("✅ 交易广播成功！TxID:", broadcastResult.txid);
          
          // 4. 等待确认
          await waitforTxConfirmation(tronWebRelayer, broadcastResult.txid);
      } else {
          // 如果广播失败，通常是代码逻辑没问题，但网络拒绝（如 Nonce 冲突或余额不足）
          console.error("❌ 广播失败:", tronWebRelayer.toUtf8(broadcastResult.message));
      }
  
      // Verify balances
      const userGasFreeAccountBalanceAfter = await usdt.balanceOf(userGasFreeAccountAddress).call();
      const recipientBalance = await usdt.balanceOf(RECIPIENT_ADDRESS).call();
      const relayerBalance = await usdt.balanceOf(relayerAddress).call();
  
      console.log(`\n--- Balances After Transfer ---`);
      console.log(`User's GasFreeAccount balance: ${tronWebRelayer.fromSun(userGasFreeAccountBalanceAfter, 6)} USDT`);
      console.log(`Recipient (${RECIPIENT_ADDRESS}) balance: ${tronWebRelayer.fromSun(recipientBalance, 6)} USDT`);
      console.log(`Relayer (${relayerAddress}) balance: ${tronWebRelayer.fromSun(relayerBalance, 6)} USDT (includes fees)`);
  
    } catch (error) {
      console.error("Error executing PermitTransfer:", error);
      // Attempt to extract revert reason if available
      if (error.reason) {
          console.error("Revert Reason:", error.reason);
      }
      if (error.message && error.message.includes("revert")) {
          // More generic catch for revert messages
          console.error("Raw Error Message:", error.message);
      }
      process.exit(1);
    }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
