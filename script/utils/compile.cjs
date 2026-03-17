const { readFileSync } = require('fs');
const { join, resolve } = require('path');
const solc = require('solc');

const ROOT = resolve(__dirname, '../..');

function read(relPath) {
  const fsPath = relPath.startsWith('@')
    ? join(ROOT, 'node_modules', relPath)
    : join(ROOT, relPath);
  return readFileSync(fsPath, 'utf8');
}

// ---------------------------------------------------------------------------
//  Source-file groups.  Each group is an array of solc virtual paths.
//  Groups can overlap – duplicates are de-duplicated at merge time.
// ---------------------------------------------------------------------------
const GROUPS = {
  // GasFreeController, GasFreeFactory, GasFreeAccount, IERC20 + OZ deps
  core: [
    'contracts/GasFreeController.sol',
    'contracts/GasFreeFactory.sol',
    'contracts/GasFreeAccount.sol',
    'contracts/lib/IERC20.sol',
    'contracts/interfaces/IGasFreeAccount.sol',
    'contracts/interfaces/IGasFreeFactory.sol',
    '@openzeppelin/contracts/utils/cryptography/EIP712.sol',
    '@openzeppelin/contracts/utils/cryptography/ECDSA.sol',
    '@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol',
    '@openzeppelin/contracts/utils/ShortStrings.sol',
    '@openzeppelin/contracts/interfaces/IERC5267.sol',
    '@openzeppelin/contracts/utils/Strings.sol',
    '@openzeppelin/contracts/utils/StorageSlot.sol',
    '@openzeppelin/contracts/utils/math/Math.sol',
    '@openzeppelin/contracts/utils/math/SafeCast.sol',
    '@openzeppelin/contracts/utils/math/SignedMath.sol',
    '@openzeppelin/contracts/utils/Panic.sol',
    '@openzeppelin/contracts/utils/ReentrancyGuard.sol',
  ],

  // DEXVaultV1 + upgradeable OZ deps
  vault: [
    'contracts/DEXVaultV1.sol',
    '@openzeppelin/contracts/token/ERC20/IERC20.sol',
    '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol',
    '@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol',
    '@openzeppelin/contracts/utils/Address.sol',
    '@openzeppelin/contracts/utils/Errors.sol',
    '@openzeppelin/contracts/interfaces/draft-IERC1822.sol',
    '@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol',
    '@openzeppelin/contracts/proxy/beacon/IBeacon.sol',
    '@openzeppelin/contracts/interfaces/IERC1967.sol',
    '@openzeppelin/contracts/interfaces/IERC1363.sol',
    '@openzeppelin/contracts/interfaces/IERC20.sol',
    '@openzeppelin/contracts/interfaces/IERC165.sol',
    '@openzeppelin/contracts/utils/introspection/IERC165.sol',
    '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol',
    '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol',
  ],

  // ERC1967Proxy (for UUPS deployment)
  proxy: [
    '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol',
    '@openzeppelin/contracts/proxy/Proxy.sol',
  ],

  // DEXVaultV2 mock (for upgrade testing)
  vaultV2: [
    'contracts/mocks/DEXVaultV2.sol',
  ],
};

/**
 * Compile Solidity contracts using the specified source groups.
 *
 * @param {string[]} groups - Source groups to include, e.g. ['core', 'vault']
 * @returns {Object} artifacts keyed by contract name: { [name]: { abi, bytecode } }
 *
 * @example
 *   const { compileContracts } = require('./utils/compile.cjs');
 *   const artifacts = compileContracts(['core']);
 *   const { GasFreeController, IERC20 } = artifacts;
 */
function compileContracts(groups) {
  // Merge requested groups, de-duplicate
  const pathSet = new Set();
  for (const g of groups) {
    const files = GROUPS[g];
    if (!files) throw new Error(`Unknown source group: "${g}". Available: ${Object.keys(GROUPS).join(', ')}`);
    files.forEach(f => pathSet.add(f));
  }

  // Build solc sources
  const sources = {};
  for (const p of pathSet) {
    sources[p] = { content: read(p) };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      evmVersion: 'istanbul',
    },
  };

  console.log('Compiling contracts...');
  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    for (const err of output.errors) {
      if (err.type === 'Warning') {
        console.warn(err.formattedMessage);
      } else {
        console.error(err.formattedMessage);
        throw new Error('Solidity compilation failed.');
      }
    }
  }

  // Extract all named contract artifacts
  const artifacts = {};
  for (const [filePath, contracts] of Object.entries(output.contracts)) {
    for (const [name, data] of Object.entries(contracts)) {
      if (artifacts[name]) continue; // first occurrence wins
      artifacts[name] = {
        abi: data.abi,
        bytecode: data.evm?.bytecode?.object
          ? `0x${data.evm.bytecode.object}`
          : undefined,
      };
    }
  }

  console.log('Contracts compiled successfully.');
  return artifacts;
}

module.exports = { compileContracts, GROUPS };
