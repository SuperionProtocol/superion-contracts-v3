// V2.1 deployment helper (used here only by the V2.1 reproduction test in test/v3.test.js).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry helper for public RPCs: retries while the node still reports the previous tx as pending.
async function withRetry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const m = String(e && (e.message || e));
      if (i >= tries || !/in-flight|nonce too low|replacement|underpriced|could not decode|execution reverted|header not found|missing trie node/i.test(m)) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

async function waitTx(txPromise, log, label) {
  const tx = await (typeof txPromise === "function" ? withRetry(txPromise) : txPromise);
  const rc = await tx.wait();
  if (log) log(`${label}: ${tx.hash}`);
  return { tx, rc, hash: tx.hash };
}

/**
 * Deploys StakingV2, Timelock, Governor, MarketplaceV2 (V2.1) and wires the roles.
 * The deployer holds no admin role at the end (everything goes through the Timelock),
 * except `guardian`: marketplace PAUSER + timelock CANCELLER (emergency veto, revocable by governance).
 */
const ROLE = {
  DEFAULT_ADMIN: "0x" + "00".repeat(32),
  PROPOSER: null, CANCELLER: null, OPERATOR: null,
};

async function deployCore(ethers, { superToken, deployer, guardian, marketParams, gov, log, existing = {} }) {
  ROLE.PROPOSER = ethers.id("PROPOSER_ROLE");
  ROLE.CANCELLER = ethers.id("CANCELLER_ROLE");
  ROLE.OPERATOR = ethers.id("OPERATOR_ROLE");
  const txs = {};
  const dep = await deployer.getAddress();
  const d = async (name, args) => {
    if (existing[name]) {
      if (log) log(`${name} (existing) @ ${existing[name]}`);
      return ethers.getContractAt(name, existing[name], deployer);
    }
    const F = await ethers.getContractFactory(name, deployer);
    const c = await withRetry(() => F.deploy(...args));
    await c.deploymentTransaction().wait();
    await c.waitForDeployment();
    txs[`deploy_${name}`] = c.deploymentTransaction().hash;
    if (log) log(`${name} @ ${await c.getAddress()} (${c.deploymentTransaction().hash})`);
    return c;
  };

  const staking = await d("SuperionStakingV2", [superToken, dep, gov.rewardEligibilityDelay]);
  const stAddr = await staking.getAddress();
  const timelock = await d("SuperionTimelock", [gov.timelockDelay, [], [ethers.ZeroAddress], dep]);
  const tl = await timelock.getAddress();
  const governor = await d("SuperionGovernor", [
    stAddr, tl, gov.votingDelay, gov.votingPeriod, gov.proposalThreshold, gov.quorumPercent, gov.quorumAbsoluteMin,
  ]);
  const market = await d("SuperionJobMarketplaceV2", [superToken, stAddr, tl, guardian, tl, marketParams]);
  const gAddr = await governor.getAddress();
  const mAddr = await market.getAddress();

  // Idempotent grants (roles already in place are skipped). Role ids are computed locally.
  const grant = async (label, c, role, who) => {
    if (await c.hasRole(role, who).catch(() => false)) { if (log) log(`${label}: already done`); return; }
    txs[label] = (await waitTx(() => c.grantRole(role, who), log, label)).hash;
  };
  const renounce = async (label, c, role) => {
    if (!(await c.hasRole(role, dep).catch(() => true))) { if (log) log(`${label}: already done`); return; }
    txs[label] = (await waitTx(() => c.renounceRole(role, dep), log, label)).hash;
  };

  // Timelock: the Governor proposes/cancels; anyone can execute; the guardian can cancel.
  await grant("tl_grant_proposer_governor", timelock, ROLE.PROPOSER, gAddr);
  await grant("tl_grant_canceller_governor", timelock, ROLE.CANCELLER, gAddr);
  if (guardian && guardian !== ethers.ZeroAddress) await grant("tl_grant_canceller_guardian", timelock, ROLE.CANCELLER, guardian);
  // StakingV2: the marketplace locks/slashes; admin -> Timelock
  await grant("st_grant_operator_market", staking, ROLE.OPERATOR, mAddr);
  await grant("st_grant_admin_timelock", staking, ROLE.DEFAULT_ADMIN, tl);
  await renounce("st_renounce_admin_deployer", staking, ROLE.DEFAULT_ADMIN);
  // Marketplace: admin = Timelock from the constructor (ARBITER_ROLE too)
  // Timelock: the deployer renounces its admin role (the timelock administers itself)
  await renounce("tl_renounce_admin_deployer", timelock, ROLE.DEFAULT_ADMIN);

  return { staking, timelock, governor, market, txs };
}

module.exports = { ROLE, deployCore, waitTx, withRetry, sleep };
