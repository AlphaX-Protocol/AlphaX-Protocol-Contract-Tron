/**
 * Fetch and decode event logs for a transaction on Nile or Mainnet.
 * Usage: node script/getTxEvents.cjs <txId>
 * Example: node script/getTxEvents.cjs 33f15346361c064927802e3146d265256e7cc87f9f13d86b68e340e678a46b8f
 */
const { TronWeb } = require('tronweb');
const NETWORK = process.env.NETWORK || 'nile';
const networks = {
  nile: { fullNode: 'https://api.nileex.io', solidityNode: 'https://api.nileex.io', eventServer: 'https://api.nileex.io' },
  mainnet: { fullNode: 'https://api.trongrid.io', solidityNode: 'https://api.trongrid.io', eventServer: 'https://api.trongrid.io' },
};
const tw = new TronWeb(networks[NETWORK].fullNode, networks[NETWORK].solidityNode, networks[NETWORK].eventServer);

const APPROVAL_TOPIC = '8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPOSIT_TOPIC = '7cfff908a4b583f36430b25d75964c458d8ede8a99bd61be750e97ee1b2f3a96';
const TRANSFER_EXECUTED_TOPIC = '5bd6cbd690f18a2752d8a66b0d30ace67adfa24c7d09b16464e41482155b6769';

function addr(hex) {
  const h = hex.length === 40 ? hex : hex.slice(-40);
  try { return tw.address.fromHex('41' + h); } catch { return '0x' + h; }
}
function u256(hex) { return BigInt('0x' + hex).toString(); }

async function main() {
  const txId = process.argv[2] || '33f15346361c064927802e3146d265256e7cc87f9f13d86b68e340e678a46b8f';
  const info = await tw.fullNode.request('/wallet/gettransactioninfobyid', { value: txId }, 'post');
  if (!info.id) {
    console.error('Transaction not found or request failed:', info);
    process.exit(1);
  }
  console.log('Transaction:', info.id);
  console.log('Block:', info.blockNumber, '| Result:', info.receipt?.result || info.result);
  console.log('');
  const logs = info.log || [];
  if (logs.length === 0) {
    console.log('No event logs.');
    return;
  }
  console.log('=== EVENT LOGS (' + logs.length + ') ===');
  console.log('');
  logs.forEach((log, i) => {
    const contract = addr(log.address);
    const t0 = log.topics[0];
    if (t0 === APPROVAL_TOPIC) {
      console.log((i + 1) + '. Approval (ERC20 @ ' + contract + ')');
      console.log('   owner:   ' + addr(log.topics[1]));
      console.log('   spender: ' + addr(log.topics[2]));
      console.log('   value:   ' + u256(log.data));
      console.log('');
    } else if (t0 === TRANSFER_TOPIC) {
      console.log((i + 1) + '. Transfer (ERC20 @ ' + contract + ')');
      console.log('   from:    ' + addr(log.topics[1]));
      console.log('   to:      ' + addr(log.topics[2]));
      console.log('   value:   ' + (Number(u256(log.data)) / 1e6).toFixed(6) + ' (6 decimals)');
      console.log('');
    } else if (t0 === DEPOSIT_TOPIC) {
      console.log((i + 1) + '. Deposit (Vault @ ' + contract + ')');
      console.log('   owner:   ' + addr(log.topics[1]));
      console.log('   to:      ' + addr(log.topics[2]));
      console.log('   token:   ' + addr(log.topics[3]));
      console.log('   amount:  ' + (Number(u256(log.data)) / 1e6).toFixed(6) + ' (6 decimals)');
      console.log('');
    } else if (t0 === TRANSFER_EXECUTED_TOPIC) {
      console.log((i + 1) + '. TransferExecuted (GasFreeController @ ' + contract + ')');
      console.log('   user:    ' + addr(log.topics[1]));
      console.log('   serviceProvider: ' + addr(log.topics[2]));
      const d = log.data;
      if (d.length >= 256) {
        const token = addr(d.slice(24, 64));
        const receiver = addr(d.slice(64, 104));
        const value = BigInt('0x' + d.slice(104, 136)).toString();
        const fee = BigInt('0x' + d.slice(136, 168)).toString();
        console.log('   token:   ' + token);
        console.log('   receiver: ' + receiver);
        console.log('   value:   ' + (Number(value) / 1e6).toFixed(6) + ' (6 decimals)');
        console.log('   fee:     ' + (Number(fee) / 1e6).toFixed(6) + ' (6 decimals)');
      }
      console.log('');
    } else {
      console.log((i + 1) + '. Unknown event @ ' + contract);
      console.log('   topic0:  ' + t0);
      console.log('   topics:  ' + log.topics.length);
      console.log('   data:    ' + log.data?.slice(0, 66) + '...');
      console.log('');
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
