// V2.1 testnet parameters (short windows), used only by the V2.1 reproduction test.
const { parseUnits } = require("ethers");
const S = (n) => parseUnits(String(n), 18);

const DAY = 24 * 3600;

const MARKETPLACE_PARAMS_TESTNET = {
  feeBps: 250,
  burnShareBps: 5000,
  challengePeriod: 180,
  seedRevealDelay: 60,
  seedRevealWindow: 180,
  voteCommitWindow: 150,
  voteRevealWindow: 150,
  arbitrationWindow: 3600,
  committeeSize: 3,
  providerStakeBps: 10000,
  slashVerifierBps: 2000,
  slashChallengerBps: 1000,
  minVerifierStake: S(1000),
  verifierPenalty: S(100),
  challengeBond: S(25),
};

const GOV_TESTNET = {
  votingDelay: 60,
  votingPeriod: 600,
  proposalThreshold: S(1000),
  quorumPercent: 4,
  quorumAbsoluteMin: S(1000),
  timelockDelay: 300,
  rewardEligibilityDelay: 60,
};
module.exports = { S, DAY, MARKETPLACE_PARAMS_TESTNET, GOV_TESTNET };
