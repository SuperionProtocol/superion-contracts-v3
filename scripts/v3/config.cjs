// Paramètres V3 — PROPOSITIONS. Testnet = fenêtres courtes pour tester ; mainnet = jours.
const { S, DAY } = require("../v2/config.cjs");

const MARKETPLACE_V3_PARAMS_TESTNET = {
  // Partage approuvé (nouvelles missions) : 5 % de frais = 2,5 % trésorerie + 1,5 % stakers + 1 % brûlé.
  // Ex. mission 1 000 SUPER : frais 50 = trésorerie 25 + stakers 15 + brûlé 10.
  feeBps: 500,
  burnShareBps: 2000,          // 20 % des frais brûlés
  treasuryShareBps: 5000,      // 50 % des frais à la trésorerie (= plafond dur 50 %) ; le reste (30 %) aux stakers
  challengePeriod: 180,
  voteCommitWindow: 150,
  voteRevealWindow: 150,
  appealWindow: 120,
  arbitrationWindow: 3600,
  committeeSize: 3,
  appealCommitteeSize: 5,
  providerStakeBps: 10000,
  slashVerifierBps: 1000,
  slashChallengerBps: 1000,
  bondBps: 1000,               // caution = 10 % de la valeur
  penaltyBps: 500,             // pénalité non-révélation = 5 % de la valeur
  voteFeeBps: 300,             // forfait par vote = 3 % de la valeur
  appealBondMultBps: 20000,    // appel = 2x la caution
  maxJobStakeBps: 5000,        // job <= 50 % du stake total des vérificateurs
  minVerifierStake: S(1000),
  minBond: S(25),
  maxBond: S(100000),
  minPenalty: S(100),
  maxPenalty: S(1000),
  minVoteFee: S(10),
  maxVoteFee: S(5000),
};

// Mainnet : fenêtres réalistes (jours) ; arbitrationWindow (14 j) > chemin Governor+Timelock (~8 j).
const MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL = {
  ...MARKETPLACE_V3_PARAMS_TESTNET,
  // Proposition mainnet NON modifiée par cette étape : anciennes valeurs épinglées explicitement (question ouverte).
  feeBps: 250,
  burnShareBps: 4000,
  treasuryShareBps: 0,          // fixé après les pilotes (gouvernance, plafond 50 % des frais)
  // Montants réglés par la simulation V3 (mechanism/sim/dispute_sim_v3.py, section RECOMMENDED)
  bondBps: 2000,
  penaltyBps: 5000,
  slashVerifierBps: 3000,
  challengePeriod: 3 * DAY,
  voteCommitWindow: 3 * DAY,
  voteRevealWindow: 2 * DAY,
  appealWindow: 3 * DAY,
  arbitrationWindow: 14 * DAY,
  committeeSize: 5,
  appealCommitteeSize: 9,
  minVerifierStake: S(10000),
  minBond: S(250),
  maxBond: S(1000000),
  minPenalty: S(1000),
  maxPenalty: S(10000),
  minVoteFee: S(50),
  maxVoteFee: S(10000),
};

const PARAM_ORDER = Object.keys(MARKETPLACE_V3_PARAMS_TESTNET);
module.exports = { MARKETPLACE_V3_PARAMS_TESTNET, MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL, PARAM_ORDER };
