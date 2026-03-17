const { TronWeb } = require('tronweb');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const solc = require('solc');

require('dotenv').config();

const waitforTxConfirmation = require('./utils/waitforTxConfirmation.cjs');

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
  },
  nile: {
    fullNode: 'https://api.nileex.io',
    solidityNode: 'https://api.nileex.io',
    eventServer: 'https://api.nileex.io',
    name: 'Nile Testnet',
  }
};

async function main() {
  const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
  const NETWORK = process.env.NETWORK || 'nile';
  const networkConfig = networks[NETWORK];
  if (!networkConfig) throw new Error(`Unknown network: ${NETWORK}`);
  if (!DEPLOYER_PRIVATE_KEY) { console.error("DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }

  const tronWeb = new TronWeb(
    networkConfig.fullNode,
    networkConfig.solidityNode,
    networkConfig.eventServer,
    DEPLOYER_PRIVATE_KEY
  );
  const deployerAddress = tronWeb.address.fromPrivateKey(DEPLOYER_PRIVATE_KEY);
  console.log(`Using account: ${deployerAddress} on ${networkConfig.name}\n`);

  // --- Load deployed addresses ---
  const addrFile = join(__dirname, `../deployed-addresses-uups.${NETWORK}.json`);
  if (!existsSync(addrFile)) {
    throw new Error(`Deployed addresses file not found: ${addrFile}\nRun deployUups.cjs first.`);
  }
  const deployed = JSON.parse(readFileSync(addrFile, 'utf8'));
  const proxyAddress = deployed.dexVaultProxy;
  const oldImplAddress = deployed.dexVaultImplementation;
  console.log(`Proxy address:              ${proxyAddress}`);
  console.log(`Current implementation:     ${oldImplAddress}\n`);

  // =====================================================================
  //  Compile DEXVaultV1 + DEXVaultV2
  //  (same source list as deployUups.cjs to avoid missing-dependency errors)
  // =====================================================================
  console.log("Compiling DEXVaultV1 & DEXVaultV2...");
  const contractFiles = {
    "contracts/DEXVaultV1.sol": readFileSync(join(__dirname, '../contracts/DEXVaultV1.sol'), 'utf8'),
    "contracts/mocks/DEXVaultV2.sol": readFileSync(join(__dirname, '../contracts/mocks/DEXVaultV2.sol'), 'utf8'),
    "contracts/lib/IERC20.sol": readFileSync(join(__dirname, '../contracts/lib/IERC20.sol'), 'utf8'),

    // OpenZeppelin – non-upgradeable
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

    // OpenZeppelin – upgradeable
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
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      evmVersion: 'istanbul'
    },
  };

  const compiledOutput = JSON.parse(solc.compile(JSON.stringify(input)));
  if (compiledOutput.errors) {
    compiledOutput.errors.forEach(err => {
      if (err.type === 'Warning') console.warn(err.formattedMessage);
      else { console.error(err.formattedMessage); throw new Error("Compilation failed."); }
    });
  }

  function getArtifact(name) {
    const solFile = `${name}.sol`;
    const path = Object.keys(compiledOutput.contracts).find(p => p.endsWith(solFile));
    if (!path || !compiledOutput.contracts[path][name]) throw new Error(`Missing artifact: ${name}`);
    return {
      abi: compiledOutput.contracts[path][name].abi,
      bytecode: `0x${compiledOutput.contracts[path][name].evm.bytecode.object}`,
    };
  }

  const DEXVaultV1Artifact = getArtifact('DEXVaultV1');
  const DEXVaultV2Artifact = getArtifact('DEXVaultV2');
  console.log("Compilation successful.\n");

  // =====================================================================
  //  Step 1: Verify current state BEFORE upgrade
  // =====================================================================
  console.log("=== PRE-UPGRADE STATE ===");
  const proxyAsV1 = await tronWeb.contract(DEXVaultV1Artifact.abi, proxyAddress);

  const ownerBefore = tronWeb.address.fromHex(await proxyAsV1.owner().call());
  console.log(`  owner():     ${ownerBefore}`);

  const signersBefore = await proxyAsV1.getSigners().call();
  const signersBeforeReadable = signersBefore.map(s => tronWeb.address.fromHex(s));
  console.log(`  signers:     ${signersBeforeReadable}`);

  let hasVersionBefore = false;
  try {
    await proxyAsV1.version().call();
    hasVersionBefore = true;
  } catch {
    hasVersionBefore = false;
  }
  console.log(`  version():   ${hasVersionBefore ? 'exists (unexpected!)' : 'not available (expected for V1)'}`);
  console.log();

  // =====================================================================
  //  Step 2: Deploy DEXVaultV2 implementation
  // =====================================================================
  console.log("Deploying DEXVaultV2 implementation...");
  const v2UnsignedTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: DEXVaultV2Artifact.abi,
      bytecode: DEXVaultV2Artifact.bytecode,
      feeLimit: 1000_000_000,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 0,
    },
    deployerAddress
  );

  const v2SignedTx = await tronWeb.trx.sign(v2UnsignedTx, DEPLOYER_PRIVATE_KEY);
  const v2Broadcast = await tronWeb.trx.sendRawTransaction(v2SignedTx);
  if (!v2Broadcast.result) {
    throw new Error(`DEXVaultV2 deploy failed: ${decodeErrorMessage(v2Broadcast.message || v2Broadcast.code)}`);
  }
  console.log(`DEXVaultV2 Impl TxID: ${v2Broadcast.txid}`);
  const v2TxInfo = await waitforTxConfirmation(tronWeb, v2Broadcast.txid);
  const newImplAddress = v2TxInfo.contractAddress;
  console.log(`DEXVaultV2 implementation deployed at: ${newImplAddress}\n`);

  // =====================================================================
  //  Step 3: Upgrade proxy → V2 via upgradeToAndCall
  // =====================================================================
  console.log("Calling upgradeToAndCall on proxy...");
  const newImplHex = tronWeb.address.toHex(newImplAddress);

  const upgradeTx = await tronWeb.transactionBuilder.triggerSmartContract(
    proxyAddress,
    "upgradeToAndCall(address,bytes)",
    { feeLimit: 500_000_000, callValue: 0 },
    [
      { type: 'address', value: newImplHex },
      { type: 'bytes', value: '0x' }
    ],
    deployerAddress
  );

  if (!upgradeTx.result || !upgradeTx.result.result) {
    const reason = upgradeTx.result && upgradeTx.result.message
      ? tronWeb.toUtf8(upgradeTx.result.message)
      : "Unknown";
    throw new Error(`upgradeToAndCall simulation failed: ${reason}`);
  }

  const signedUpgradeTx = await tronWeb.trx.sign(upgradeTx.transaction, DEPLOYER_PRIVATE_KEY);
  const upgradeBroadcast = await tronWeb.trx.sendRawTransaction(signedUpgradeTx);
  if (!upgradeBroadcast.result) {
    const rawMsg = upgradeBroadcast.message || upgradeBroadcast.code;
    const msg = typeof rawMsg === 'string' && /^[0-9a-fA-F]+$/.test(rawMsg.replace(/^0x/, ''))
      ? decodeErrorMessage(rawMsg) : (rawMsg ? String(rawMsg) : 'Unknown error');
    throw new Error(`upgradeToAndCall broadcast failed: ${msg}`);
  }
  console.log(`upgradeToAndCall TxID: ${upgradeBroadcast.txid}`);
  await waitforTxConfirmation(tronWeb, upgradeBroadcast.txid);
  console.log("Upgrade transaction confirmed!\n");

  // =====================================================================
  //  Step 4: Verify POST-UPGRADE state
  // =====================================================================
  console.log("=== POST-UPGRADE VERIFICATION ===");
  console.log(`  Old implementation:  ${oldImplAddress}`);
  console.log(`  New implementation:  ${newImplAddress}`);

  // Call version() – should now return "V2"
  const proxyAsV2 = await tronWeb.contract(DEXVaultV2Artifact.abi, proxyAddress);
  const ver = await proxyAsV2.version().call();
  console.log(`  version():           "${ver}"`);

  // Verify state preservation
  const ownerAfter = tronWeb.address.fromHex(await proxyAsV2.owner().call());
  console.log(`  owner():             ${ownerAfter}`);

  const signersAfter = await proxyAsV2.getSigners().call();
  const signersAfterReadable = signersAfter.map(s => tronWeb.address.fromHex(s));
  console.log(`  signers:             ${signersAfterReadable}`);

  console.log();

  // =====================================================================
  //  Summary
  // =====================================================================
  const versionOk = ver === "V2";
  const ownerOk   = ownerAfter === ownerBefore;
  const signersOk = JSON.stringify(signersBeforeReadable) === JSON.stringify(signersAfterReadable);

  console.log("=== TEST RESULTS ===");
  console.log(`  [${versionOk ? 'PASS' : 'FAIL'}] version() returns "V2"`);
  console.log(`  [${ownerOk   ? 'PASS' : 'FAIL'}] owner preserved after upgrade`);
  console.log(`  [${signersOk ? 'PASS' : 'FAIL'}] signers preserved after upgrade`);

  if (versionOk && ownerOk && signersOk) {
    console.log("\nAll upgrade tests passed!");
  } else {
    console.error("\nSome tests FAILED – review output above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
