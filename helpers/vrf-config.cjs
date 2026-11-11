// VRF CONFIGURATION — LOCAL PROTOTYPE.
// Two clearly separated paths:
//   1. LOCAL_SIMULATED : LocalVrfCoordinatorMock deployed on the in-process Hardhat chain (31337).
//      The mock does NOT verify any VRF proof. Randomness is chosen by the test. Simulation only.
//   2. BASE_SEPOLIA_PLANNED : public identifiers of the official Chainlink VRF 2.5 coordinator on
//      Base Sepolia, copied for documentation. *** PAS ENCORE BRANCHÉ / NOT CONNECTED ***
//      - no subscription has been created (subscriptionId is intentionally null),
//      - no LINK bought or sent, no Chainlink account, no deployment, no transaction,
//      - hardhat.config.cjs declares NO public network / RPC URL, so nothing here can reach a network.
//      Mainnet values are deliberately NOT included.
// Switching to the official coordinator later = pass another Config (address/subscription/keyHash/...)
// to the market constructor; the consumer code (contracts/vrf/FrozenVrfDraw.sol) does not change.
'use strict';

const BASE_SEPOLIA_PLANNED = Object.freeze({
  status: 'PAS ENCORE BRANCHÉ — aucun abonnement, aucun LINK, aucun déploiement',
  network: 'base-sepolia (testnet)',
  chainId: 84532n,
  source: 'https://docs.chain.link/vrf/v2-5/supported-networks (lecture publique, 2026-11-09)',
  coordinator: '0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE',
  keyHash: '0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71', // lane "30 gwei"
  linkToken: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410', // documentation only, never used by code here
  subscriptionId: null, // MUST stay null until a funded subscription exists (explicit future decision)
  confirmations: 3,          // network allows 0..200
  callbackGasLimit: 2500000, // = network max. Callback selects + holds; THREE-LIMITS FIX: skip cap size+40, measured worst ~1.86M (200 candidates, 13 seats, mock incl.), see test
  nativePayment: false,      // pay in LINK from the subscription
  documentedLimits: { maxGasLimit: 2500000, minConfirmations: 0, maxConfirmations: 200, maxRandomValues: 500 },
});

const LOCAL_CHAIN_ID = 31337n;
const NOT_CONNECTED = 'VRF Base Sepolia PAS ENCORE BRANCHÉ: aucun abonnement n\'existe (subscriptionId null)';

function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
function isBytes32(h) { return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) && !/^0x0{64}$/.test(h); }

// Validates the shape only. It does not (and cannot) check that a subscription exists or is funded.
function validateEngineConfig(c) {
  if (!isAddress(c.coordinator) || /^0x0{40}$/.test(c.coordinator)) throw Error('VRF config: coordinator invalide');
  if (!isBytes32(c.keyHash)) throw Error('VRF config: keyHash invalide');
  const sub = BigInt(c.subscriptionId ?? 0);
  if (sub <= 0n) throw Error('VRF config: subscriptionId manquant');
  if (!(c.confirmations >= 0 && c.confirmations <= 200)) throw Error('VRF config: confirmations hors limites');
  if (!(c.callbackGasLimit >= 100000 && c.callbackGasLimit <= 2500000)) throw Error('VRF config: callbackGasLimit hors limites');
  if (typeof c.nativePayment !== 'boolean') throw Error('VRF config: nativePayment doit être booléen');
  return { coordinator: c.coordinator, subscriptionId: sub, keyHash: c.keyHash, confirmations: c.confirmations,
    callbackGasLimit: c.callbackGasLimit, nativePayment: c.nativePayment };
}

// Planned real path. Refuses while no subscription exists. Even with an id, this only returns a struct:
// no code in this repository sends it to a public network.
function plannedBaseSepoliaConfig(subscriptionId) {
  if (subscriptionId === undefined || subscriptionId === null) throw Error(NOT_CONNECTED);
  const p = BASE_SEPOLIA_PLANNED;
  return validateEngineConfig({ coordinator: p.coordinator, subscriptionId, keyHash: p.keyHash,
    confirmations: p.confirmations, callbackGasLimit: p.callbackGasLimit, nativePayment: p.nativePayment });
}

// Simulated path: only on the in-process Hardhat chain.
async function localSimulatedConfig(hre, mockAddress, subscriptionId) {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  if (hre.network.name !== 'hardhat' || chainId !== LOCAL_CHAIN_ID) throw Error('LOCAL ONLY: voie simulée refusée hors Hardhat 31337');
  return validateEngineConfig({ coordinator: mockAddress, subscriptionId,
    keyHash: hre.ethers.id('LOCAL_ONLY_NOT_A_NETWORK_KEYHASH'), confirmations: 3, callbackGasLimit: BASE_SEPOLIA_PLANNED.callbackGasLimit, nativePayment: false });
}

// The draw engine is the FIRST contract created by the market constructor (contract nonce 1, EIP-161).
// Its address must be added as consumer of the subscription (addConsumer) before the first dispute.
function predictEngineAddress(ethers, marketAddress) { return ethers.getCreateAddress({ from: marketAddress, nonce: 1 }); }

module.exports = { BASE_SEPOLIA_PLANNED, NOT_CONNECTED, LOCAL_CHAIN_ID, validateEngineConfig, plannedBaseSepoliaConfig,
  localSimulatedConfig, predictEngineAddress };
