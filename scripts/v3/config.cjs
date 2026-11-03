// V3 parameters — PROPOSALS. Testnet = short windows for testing; mainnet = days.
const { S, DAY } = require("../v2/config.cjs");

const MARKETPLACE_V3_PARAMS_TESTNET = {
  feeBps: 250,
  burnShareBps: 4000,
  treasuryShareBps: 1000,      // 10 % of fees to the treasury (hard cap 50 %)
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
  bondBps: 1000,               // bond = 10 % of the job value
  penaltyBps: 500,             // non-reveal penalty = 5 % of the job value
  voteFeeBps: 300,             // flat fee per vote = 3 % of the job value
  appealBondMultBps: 20000,    // appeal bond = 2x the bond
  maxJobStakeBps: 5000,        // job value <= 50 % of total verifier stake
  minVerifierStake: S(1000),
  minBond: S(25),
  maxBond: S(100000),
  minPenalty: S(100),
  maxPenalty: S(1000),
  minVoteFee: S(10),
  maxVoteFee: S(5000),
};

// Mainnet: realistic windows (days); arbitrationWindow (14 d) > Governor+Timelock path (~8 d).
const MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL = {
  ...MARKETPLACE_V3_PARAMS_TESTNET,
  treasuryShareBps: 0,          // set after the pilots (governance, cap 50 % of fees)
  // Amounts tuned by the V3 simulation (mechanism/sim/dispute_sim_v3.py, section RECOMMENDED)
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
