// script/utils/checkAccountExists.cjs
const { TronWeb } = require('tronweb');

/**
 * Utility function to check if a contract exists at a given address on the Tron network.
 * It checks if the address has associated code.
 *
 * @param {TronWeb} tronWeb - The TronWeb instance to use.
 * @param {string} address - The address to check.
 * @returns {Promise<boolean>} - True if a contract exists at the address, false otherwise.
 */
async function checkAccountExists(tronWeb, address) {
  try {
    const code = await tronWeb.trx.getContract(address);
    console.warn(address, "code: ", code)
    // If code is not '0x', a contract exists at this address
    return code && code !== '0x';
  } catch (error) {
    console.error(`Error checking account existence for ${address}: ${error.message}`);
    return false;
  }
}

module.exports = checkAccountExists;
