const networks = {
  mainnet: {
    fullNode: 'https://api.trongrid.io',
    solidityNode: 'https://api.trongrid.io',
    eventServer: 'https://api.trongrid.io',
    chainId: 728126428,
    name: 'Mainnet',
    usdtAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  },
  nile: {
    fullNode: 'https://api.nileex.io',
    solidityNode: 'https://api.nileex.io',
    eventServer: 'https://api.nileex.io',
    chainId: 3448148188,
    name: 'Nile Testnet',
    usdtAddress: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  },
};

/** Decode hex-encoded error messages from the TRON API. */
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

/** Convert a TRON address to 0x-prefixed 20-byte hex (for EIP-712 / contract calls). */
function toStandardHex(tronWeb, address) {
  let hex = tronWeb.address.toHex(address);
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.startsWith('41')) hex = hex.slice(2);
  return '0x' + hex;
}

/** Strip TRON 41-prefix → bare 20-byte hex (for raw ABI encoding, no 0x). */
function toAbiAddress(tronWeb, addr) {
  const hex = tronWeb.address.toHex(addr);
  return (hex.startsWith('41') ? hex.substring(2) : hex.replace(/^0x/, '')).toLowerCase();
}

/** Left-pad a hex value to 32 bytes (64 hex chars). */
function pad32(hexVal) {
  return hexVal.padStart(64, '0');
}

module.exports = { networks, decodeErrorMessage, toStandardHex, toAbiAddress, pad32 };
