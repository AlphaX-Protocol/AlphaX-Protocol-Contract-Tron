// script/utils/waitforTxConfirmation.cjs
const { TronWeb } = require('tronweb');

/**
 * Utility function to wait for transaction confirmation on the Tron network.
 * It polls the transaction info until the transaction is confirmed or fails,
 * or a timeout is reached.
 *
 * @param {TronWeb} tronWeb - The TronWeb instance to use for querying transaction info.
 * @param {string} txID - The transaction ID to wait for.
 * @returns {Promise<Object>} - The transaction info object upon successful confirmation.
 * @throws {Error} If the transaction fails on chain or is not confirmed within the timeout.
 */
async function waitforTxConfirmation(tronWeb, txID) {
  let attempts = 0;
  const maxAttempts = 40; // Increased from 20 to 40 (120 seconds total wait)
  const delay = 3000; // 3 seconds

  while (attempts < maxAttempts) {
    try {
      // Reverting to direct request with POST method as tronWeb.trx.getTransactionInfo seems problematic
      const txInfo = await tronWeb.fullNode.request(
        '/wallet/gettransactioninfobyid',
        { value: txID },
        'post'
      );

      // Check if transaction information is available
      if (!txInfo || Object.keys(txInfo).length === 0) {
        console.log(`Transaction ${txID} not yet found. Attempt ${attempts + 1}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
        continue; // Continue to the next attempt if txInfo is empty
      }

      // Check transaction receipt for success or failure
      if (txInfo.receipt) {
        if (txInfo.receipt.result === 'SUCCESS') {
          console.log(`Transaction ${txID} confirmed in block: ${txInfo.blockNumber}`);
          
          // Compatibility check for contract_address / contractAddress
          const createdAddr = txInfo.contract_address || txInfo.contractAddress;

          if (createdAddr) {
            return { ...txInfo, contractAddress: tronWeb.address.fromHex(createdAddr) };
          }
          return txInfo;
        } else if (txInfo.receipt.result === 'FAILED') {
          console.error(`Transaction ${txID} failed on chain.`);
          console.error(`Reason: ${txInfo.resMessage || 'No message'}`);
          console.error(`Tx Info: ${JSON.stringify(txInfo, null, 2)}`);
          throw new Error(`Transaction ${txID} failed on chain with message: ${txInfo.resMessage || 'No message'}`);
        }
      }

      // Check 'ret' field for potential failure reasons even without a full receipt yet
      if (txInfo.ret && txInfo.ret[0] && txInfo.ret[0].contractRet && txInfo.ret[0].contractRet !== 'SUCCESS') {
        console.error(`Transaction ${txID} failed with contractRet: ${txInfo.ret[0].contractRet}.`);
        console.error(`Tx Info: ${JSON.stringify(txInfo, null, 2)}`);
        throw new Error(`Transaction ${txID} failed with contractRet: ${txInfo.ret[0].contractRet}`);
      }

    } catch (error) {
      // Re-throw if it's a confirmed failure from previous checks or a network error
      if (error.message.includes('failed on chain') || error.message.includes('failed with contractRet')) {
        throw error;
      }
      console.error(`Error fetching transaction info for ${txID}: ${error.message}. Retrying...`);
    }

    console.log(`Waiting for transaction ${txID} to be confirmed... Attempt ${attempts + 1}/${maxAttempts}`);
    await new Promise(resolve => setTimeout(resolve, delay));
    attempts++;
  }
  throw new Error(`Transaction ${txID} not confirmed after ${maxAttempts * delay / 1000} seconds.`);
}

module.exports = waitforTxConfirmation;
