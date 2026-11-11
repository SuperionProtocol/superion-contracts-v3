const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { S } = require("../scripts/v2/config.cjs");
const { MARKETPLACE_V3_PARAMS_TESTNET: P0, MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL: PM } = require("../scripts/v3/config.cjs");

const Status = { None: 0, Open: 1, Assigned: 2, Completed: 3, Disputed: 4, Finalized: 5, Refunded: 6, Cancelled: 7, Split: 8 };
const Phase = { None: 0, Draw: 1, Voting: 2, Decided: 3, Done: 4 };
const BPS = 10000n;
const salt = (s) => ethers.id("salt-" + s);
const voteCommit = (v, sl, voter, id) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bool", "bytes32", "address", "uint256"], [v, sl, voter, id]));

async function deploy(params = P0) {
  const signers = await ethers.getSigners();
  const [admin, creator, provider, challenger, arbiter, treasury, outsider, ...rest] = signers;
  const vs = rest.slice(0, 12);
  const token = await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
  const staking = await (await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(), admin.address, 60);
  const market = await (await legacyFactory()).deploy(
    await token.getAddress(), await staking.getAddress(), admin.address, admin.address, arbiter.address, treasury.address, params);
  await staking.grantRole(await staking.OPERATOR_ROLE(), await market.getAddress());
  const stAddr = await staking.getAddress(), mAddr = await market.getAddress();
  for (const s of [creator, provider, challenger, outsider, ...vs]) {
    await token.transfer(s.address, S(500000));
    await token.connect(s).approve(stAddr, ethers.MaxUint256);
    await token.connect(s).approve(mAddr, ethers.MaxUint256);
  }
  await staking.connect(provider).stake(S(100000));
  return { admin, creator, provider, challenger, arbiter, treasury, outsider, vs, token, staking, market };
}

async function fx() { return deploy(); }
async function fxWith(n) {
  const f = await deploy();
  for (const v of f.vs.slice(0, n)) { await f.staking.connect(v).stake(S(10000)); await f.market.connect(v).registerVerifier(); }
  return f;
}
const fx3 = () => fxWith(3), fx5 = () => fxWith(5), fx8 = () => fxWith(8), fx12 = () => fxWith(12);

async function completedJob(f, budget = 1000) {
  const id = await f.market.nextJobId();
  await f.market.connect(f.creator).createJob(S(budget), 3600, "ipfs://job");
  await f.market.connect(f.provider).assignJob(id);
  await f.market.connect(f.provider).submitResult(id, "ipfs://res");
  return id;
}
async function challengeAndDraw(f, id, who = f.challenger, s = "x") {
  await f.market.connect(who).challengeJob(id, salt(s + id));
  await mine(1);
  await legacyDraw(f.market.connect(f.outsider),id);
  return f.market.committeeOf(id);
}
/** votes[i] : true / false / null (no commit) / "c" (commit, no reveal) */
async function vote(f, id, committee, votes) {
  for (let i = 0; i < committee.length; i++) {
    if (votes[i] === null) continue;
    const s = await ethers.getSigner(committee[i]);
    await f.market.connect(s).commitVote(id, voteCommit(votes[i] === "c" ? true : votes[i], salt(id + "-" + i), committee[i], id));
  }
  await time.increase(P0.voteCommitWindow + 1);
  for (let i = 0; i < committee.length; i++) {
    if (votes[i] === null || votes[i] === "c") continue;
    const s = await ethers.getSigner(committee[i]);
    await f.market.connect(s).revealVote(id, votes[i], salt(id + "-" + i));
  }
}
const bal = (f, a) => f.token.balanceOf(a.address || a);
const bondOf = async (f, a) => (await f.market.verifiers(a)).bond;

describe("Superion V3 JobMarketplace", function () {
  describe("Params & governance", function () {
    it("rejects committee < 3, even appeal size, treasury share > hard cap; mainnet proposal is valid", async function () {
      const f = await loadFixture(fx);
      const bad = async (o) => expect((await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({ ...P0, ...o })).to.be.revertedWithCustomError(f.market, "InvalidParams");
      await bad({ committeeSize: 1 });
      await bad({ appealCommitteeSize: 3 });
      await bad({ appealCommitteeSize: 6 });
      await bad({ treasuryShareBps: 5001 });
      await bad({ burnShareBps: 6000, treasuryShareBps: 5000 });
      await bad({ appealBondMultBps: 9999 });
      await bad({ maxPenalty: S(2000) });
      await bad({ maxJobStakeBps: 0 });
      await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams(PM);
      expect((await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).current()).arbitrationWindow).to.equal(14 * 86400);
    });
    it("only admin can set params / treasury; arbiter is a dedicated role", async function () {
      const f = await loadFixture(fx);
      await expect((await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).connect(f.outsider).setParams(P0)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await expect(f.market.connect(f.outsider).setTreasury(f.outsider.address)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await expect((await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).connect(f.outsider).setFees(1, 1)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      expect(await f.market.hasRole(await f.market.ARBITER_ROLE(), f.arbiter.address)).to.equal(true);
      await f.market.revokeRole(await f.market.ARBITER_ROLE(), f.arbiter.address);
      await f.market.grantRole(await f.market.ARBITER_ROLE(), f.outsider.address);
      expect(await f.market.hasRole(await f.market.ARBITER_ROLE(), f.outsider.address)).to.equal(true);
    });
  });

  describe("Fix 6: amounts scale with value", function () {
    it("bond / penalty / vote fee = bps of value with floors and caps, bond covers committee fees", async function () {
      const f = await loadFixture(fx);
      let [b, p, fee] = await f.market.disputeAmounts(S(100));
      expect(b).to.equal(S(30)); // max(25 floor, 3 * 10 fee floor)
      expect(p).to.equal(S(100)); expect(fee).to.equal(S(10));
      [b, p, fee] = await f.market.disputeAmounts(S(10000));
      expect(b).to.equal(S(1000)); expect(p).to.equal(S(500)); expect(fee).to.equal(S(300));
      [b, p, fee] = await f.market.disputeAmounts(S(10_000_000));
      expect(b).to.equal(S(100000)); expect(p).to.equal(S(1000)); expect(fee).to.equal(S(5000));
    });
  });

  describe("Fix 8: job value capped by verifier stake", function () {
    it("no verifiers => no job; budget <= maxJobStakeBps of total verifier bond", async function () {
      const f = await loadFixture(fx);
      await expect(f.market.connect(f.creator).createJob(S(1), 3600, "j")).to.be.revertedWithCustomError(f.market, "JobTooLarge");
      for (const v of f.vs.slice(0, 3)) { await f.staking.connect(v).stake(S(10000)); await f.market.connect(v).registerVerifier(); }
      expect(await f.market.totalVerifierBond()).to.equal(S(3000));
      expect(await f.market.maxJobBudget()).to.equal(S(1500));
      await expect(f.market.connect(f.creator).createJob(S(1501), 3600, "j")).to.be.revertedWithCustomError(f.market, "JobTooLarge");
      await f.market.connect(f.creator).createJob(S(1500), 3600, "j");
      await f.market.connect(f.vs[3]).registerVerifierWithStake(0).catch(() => {});
      await f.staking.connect(f.vs[3]).stake(S(10000));
      await f.market.connect(f.vs[3]).registerVerifierWithStake(S(5000));
      expect(await f.market.maxJobBudget()).to.equal(S(4000));
      await f.market.connect(f.vs[0]).exitVerifier();
      expect(await f.market.totalVerifierBond()).to.equal(S(7000));
    });
  });

  describe("Regression: happy path & lifecycle", function () {
    it("finalize after challenge period; fee split treasury / burn / stakers", async function () {
      const f = await loadFixture(fx3);
      const id = await completedJob(f, 1000);
      await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(P0.challengePeriod + 1);
      const p0 = await bal(f, f.provider), t0 = await bal(f, f.treasury);
      await expect(f.market.finalizeJob(id)).to.emit(f.market, "TreasuryPaid");
      const fee = S(1000) * 500n / BPS;
      expect((await bal(f, f.provider)) - p0).to.equal(S(1000) - fee);
      expect((await bal(f, f.treasury)) - t0).to.equal(fee * 5000n / BPS);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n); // provider stake unlocked
    });
    it("cancel, reclaimExpired, pause, provider cannot challenge, creator cannot self-assign", async function () {
      const f = await loadFixture(fx3);
      await f.market.connect(f.creator).createJob(S(10), 3600, "a");
      await expect(f.market.connect(f.creator).assignJob(1)).to.be.revertedWithCustomError(f.market, "NotAllowed");
      await f.market.connect(f.creator).cancelJob(1);
      expect((await f.market.jobs(1)).status).to.equal(Status.Cancelled);
      await f.market.connect(f.creator).createJob(S(10), 100, "b");
      await f.market.connect(f.provider).assignJob(2);
      await time.increase(101);
      await f.market.connect(f.creator).reclaimExpired(2);
      expect((await f.market.jobs(2)).status).to.equal(Status.Refunded);
      const id = await completedJob(f, 10);
      await expect(f.market.connect(f.provider).challengeJob(id, salt("p"))).to.be.revertedWithCustomError(f.market, "NotAllowed");
      await f.market.pause();
      await expect(f.market.connect(f.creator).createJob(S(1), 1, "c")).to.be.revertedWithCustomError(f.market, "EnforcedPause");
    });
  });

  describe("POLICY UPDATE: filing possible without a full jury, escrow protected", function () {
    it("POLICY UPDATE: insufficient verifiers allow filing but never a free refund or automatic payment", async function () {
      const f = await loadFixture(fx3);
      const id = await completedJob(f, 100);
      const id2 = await completedJob(f, 100);
      // A verifier challenger is excluded: only 2 eligible, but filing is timely.
      await f.market.connect(f.vs[0]).challengeJob(id, salt("a"));
      await mine();
      await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market, "NotEnoughVerifiers");
      await f.market.connect(f.vs[2]).exitVerifier();
      await f.market.connect(f.creator).challengeJob(id2, salt("b"));
      await mine();
      await expect(legacyDraw(f.market,id2)).to.be.revertedWithCustomError(f.market, "NotEnoughVerifiers");
      const held = await bal(f, f.market);
      const deadline = await f.market.effectiveProtectedDeadline(id2);
      await time.increaseTo(deadline + 1n);
      for (const job of [id, id2]) {
        await f.market.resolveStale(job);
        expect((await f.market.jobs(job)).status).to.equal(Status.Disputed);
        expect((await f.market.disputes(job)).phase).to.equal(5n);
        await expect(f.market.finalizeJob(job)).to.be.revertedWithCustomError(f.market, "InvalidState");
      }
      expect(await bal(f, f.market)).to.equal(held);
    });
    it("POLICY UPDATE: verifier departure retains funded dispute until arbitration, no cancellation payout", async function () {
      const f = await loadFixture(fx3);
      const id = await completedJob(f, 100);
      const c0 = await bal(f, f.challenger);
      // PAUSE/JURY FIX: the verifier leaves BEFORE filing (frozen candidates can no longer leave after it).
      await f.market.connect(f.vs[0]).exitVerifier();
      await f.market.connect(f.challenger).challengeJob(id, salt("c"));
      const bond = (await f.market.disputes(id)).bond;
      await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market, "NotEnoughVerifiers");
      expect(await bal(f, f.challenger)).to.equal(c0 - bond);
      expect((await f.market.jobs(id)).status).to.equal(Status.Disputed);
      await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
      await time.increaseTo((await f.market.effectiveProtectedDeadline(id)) + 1n);
      await f.market.resolveStale(id);
      expect((await f.market.disputes(id)).phase).to.equal(5n);
      await f.market.connect(f.arbiter).arbitrate(id, true); // EOA role unit test, not Safe proof
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
    });
  });

  describe("Fix 1 & 2: committee draw", function () {
    it("VRF UPDATE: distinct jury excludes parties; no selection before the MOCK callback, independent of block count", async function () {
      const f = await loadFixture(fx5);
      for (const signer of [f.creator, f.challenger]) { await f.staking.connect(signer).stake(S(10000)); await f.market.connect(signer).registerVerifier(); }
      const id = await completedJob(f, 100);
      await f.market.connect(f.challenger).challengeJob(id, salt("e"));
      await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await mine(1);
      await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await fulfillMock(f.market,id);
      await f.market.connect(f.outsider).drawCommittee(id);
      const c = await f.market.committeeOf(id);
      expect(c.length).to.equal(3); expect(new Set(c).size).to.equal(3);
      for (const address of [f.creator.address,f.challenger.address,f.provider.address]) expect(c).to.not.include(address);
      await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,"InvalidState");
    });
    it("VRF UPDATE: one challenge, one request; old blockhash expiry cannot retarget randomness", async function () {
      const f = await loadFixture(fx5),id=await completedJob(f,100);
      await f.market.connect(f.challenger).challengeJob(id,salt("f"));
      expect(f.market.expireUnrevealedChallenge).to.equal(undefined); expect(f.market.revealCommittee).to.equal(undefined);
      const engine=await oracle(f.market),before=await engine.status(id,0);
      await expect(f.market.connect(f.creator).challengeJob(id,salt("g"))).to.be.revertedWithCustomError(f.market,"InvalidState");
      await mine(300); await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,"TooEarly");
      expect((await engine.status(id,0)).requestId).to.equal(before.requestId);
      await fulfillMock(f.market,id);await f.market.drawCommittee(id);expect((await f.market.committeeOf(id)).length).to.equal(3);
    });
    it("VRF UPDATE: consecutive registration does not impose contiguous seats; 60 exact frozen-sampler checks, NOT anti-Sybil proof (equal 10000 bonds: reservation capacity)", async function () {
      // RESERVATION ADAPTATION: 60 disputes stay open, each seat reserves its max penalty; equal bonds of 10000
      // (instead of the 1000 minimum) give every one of the 12 verifiers capacity for all its seats. Weights stay equal.
      const f=await loadFixture(fx),engine=await oracle(f.market),abi=ethers.AbiCoder.defaultAbiCoder();let nonContiguous=0;
      for (const v of f.vs.slice(0, 12)) { await f.staking.connect(v).stake(S(10000)); await f.market.connect(v).registerVerifierWithStake(S(10000)); }
      for(let j=0;j<60;j++){
        const id=await completedJob(f,10);await f.market.connect(f.challenger).challengeJob(id,salt("sy"+j));await fulfillMock(f.market,id);
        const d=await engine.status(id,0),[population,weights]=await engine.population(id,0),w=Array.from(weights);
        const seed=ethers.keccak256(abi.encode(['bytes32','uint256','address','address','uint256','uint256','uint256','bytes32','uint256'],[await engine.DOMAIN(),31337,await engine.getAddress(),await f.market.getAddress(),id,0,d.requestId,d.snapshotHash,d.word]));
        let total=w.reduce((a,b)=>a+b,0n);const expected=[];
        for(let t=0;t<3;t++){let r=BigInt(ethers.keccak256(abi.encode(['bytes32','uint256'],[seed,t]))),i=0;r%=total;while(r>=w[i]){r-=w[i];i++;}expected.push(population[i]);total-=w[i];w[i]=0n;}
        await f.market.drawCommittee(id);const actual=Array.from(await f.market.committeeOf(id));expect(actual).to.deep.equal(expected);expect(new Set(actual).size).to.equal(3);
        const cyclic=population.some((_,start)=>actual.every(a=>[0,1,2].map(k=>population[(start+k)%population.length]).includes(a)));if(!cyclic)nonContiguous++;
      }
      // Exact deterministic invariants, not an unreliable small-sample capture-rate threshold.
      // Three funded identities can legitimately win a majority; the MOCK does not establish unbiased VRF.
      expect(nonContiguous).to.be.greaterThan(0);
    });
    it("draw is stake-weighted: a 10x-bonded verifier is drawn far more often", async function () {
      const f = await loadFixture(fx);
      for (const v of f.vs.slice(0, 7)) { await f.staking.connect(v).stake(S(20000)); await f.market.connect(v).registerVerifier(); }
      await f.staking.connect(f.vs[7]).stake(S(20000));
      await f.market.connect(f.vs[7]).registerVerifierWithStake(S(10000));
      const big = f.vs[7].address; let hits = 0; const N = 30;
      for (let i = 0; i < N; i++) {
        const id = await completedJob(f, 10);
        const c = await challengeAndDraw(f, id, f.challenger, "w" + i);
        if (c.includes(big)) hits++;
      }
      // uniform would be 3/8 = 0.375 ; weighted ~0.8+
      expect(hits / N).to.be.greaterThan(0.6);
    });
  });

  describe("Fix 5 & 7: verifier pay, minority not slashed", function () {
    it("equal vote fee to every revealer (incl. minority); minority not slashed; non-revealer slashed; bond remainder to majority", async function () {
      const f = await loadFixture(fx5);
      const id = await completedJob(f, 1000);
      const c = await challengeAndDraw(f, id);
      const before = await Promise.all(c.map((a) => bal(f, a)));
      const bonds0 = await Promise.all(c.map((a) => bondOf(f, a)));
      await vote(f, id, c, [true, true, false]);
      await f.market.resolveDispute(id);
      expect((await f.market.disputes(id)).phase).to.equal(Phase.Decided);
      await expect(f.market.finalizeDispute(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(P0.appealWindow + 1);
      await f.market.finalizeDispute(id);
      const [bond, , fee] = await f.market.disputeAmounts(S(1000)); // bond 100, fee 30
      const after = await Promise.all(c.map((a) => bal(f, a)));
      const coh = (bond - 3n * fee) / 2n;
      expect(after[0] - before[0]).to.equal(fee + coh);
      expect(after[1] - before[1]).to.equal(fee + coh);
      expect(after[2] - before[2]).to.equal(fee); // minority: paid, not slashed
      for (let i = 0; i < 3; i++) expect(await bondOf(f, c[i])).to.equal(bonds0[i]);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
      expect(await bal(f, f.market)).to.equal(0n);
    });
    it("non-revealer slashed (scaled penalty); invalid outcome: provider slashed, challenger reimbursed, creator refunded", async function () {
      const f = await loadFixture(fx5);
      const id = await completedJob(f, 2400);
      const c = await challengeAndDraw(f, id);
      const cr0 = await bal(f, f.creator), ch0 = await bal(f, f.challenger);
      await vote(f, id, c, [false, false, "c"]);
      await time.increase(P0.voteRevealWindow + 1);
      await f.market.resolveDispute(id);
      await time.increase(P0.appealWindow + 1);
      await f.market.finalizeDispute(id);
      const [bond, pen, fee] = await f.market.disputeAmounts(S(2400)); // pen = 120 (5 %)
      expect(await bondOf(f, c[2])).to.equal(S(1000) - pen);
      expect((await f.market.jobs(id)).status).to.equal(Status.Refunded);
      expect((await bal(f, f.creator)) - cr0).to.equal(S(2400));
      const rest = S(2400) - 2n * fee;
      // challenger: bond back (fees reimbursed from slash) + 10 % of rest of slash
      expect((await bal(f, f.challenger)) - ch0).to.equal(bond + rest * 1000n / BPS);
      expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
      expect(await bal(f, f.market)).to.equal(0n);
    });
  });

  describe("Fix 7: appeal round", function () {
    it("provider appeals an invalid verdict; disjoint 5-member committee overturns; original majority slashed", async function () {
      const f = await loadFixture(fx8);
      const id = await completedJob(f, 1000);
      const c0 = await challengeAndDraw(f, id);
      await vote(f, id, c0, [false, false, true]);
      await f.market.resolveDispute(id);
      await expect(f.market.connect(f.challenger).appeal(id)).to.be.revertedWithCustomError(f.market, "NotAllowed");
      const p0 = await bal(f, f.provider);
      await f.market.connect(f.provider).appeal(id);
      const ab = (await f.market.disputes(id)).appealBond;
      expect(ab).to.equal(S(200));
      await mine(1);
      await legacyDraw(f.market,id);
      const c1 = await f.market.committeeOf(id);
      expect(c1.length).to.equal(5);
      for (const a of c1) expect(c0).to.not.include(a);
      await expect(f.market.connect(await ethers.getSigner(c0[0])).commitVote(id, ethers.id("z"))).to.be.revertedWithCustomError(f.market, "NotAllowed");
      await vote(f, id, c1, [true, true, true, false, true]);
      const b0 = await bondOf(f, c0[0]), b2 = await bondOf(f, c0[2]);
      await f.market.resolveDispute(id);
      const [, pen, fee] = await f.market.disputeAmounts(S(1000));
      expect(await bondOf(f, c0[0])).to.equal(b0 - pen);   // overturned majority slashed
      expect(await bondOf(f, c0[2])).to.equal(b2);         // was right: untouched
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
      const payout = S(1000) - S(1000) * 500n / BPS;
      expect((await bal(f, f.provider)) - p0).to.equal(payout - 5n * fee); // paid: payout - appealBond + (appealBond - 5 fees)
      expect(await bal(f, f.market)).to.equal(0n);
    });
    it("upheld appeal: appeal bond remainder goes to the appeal majority; one appeal only; deadline enforced", async function () {
      const f = await loadFixture(fx8);
      const id = await completedJob(f, 1000);
      const c0 = await challengeAndDraw(f, id);
      await vote(f, id, c0, [true, true, true]);
      await f.market.resolveDispute(id);
      await expect(f.market.connect(f.provider).appeal(id)).to.be.revertedWithCustomError(f.market, "NotAllowed");
      await f.market.connect(f.creator).appeal(id);
      await expect(f.market.connect(f.challenger).appeal(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
      await mine(1); await legacyDraw(f.market,id);
      const c1 = await f.market.committeeOf(id);
      await vote(f, id, c1, [true, true, true, true, false]);
      await f.market.resolveDispute(id);
      expect((await f.market.jobs(id)).status).to.equal(Status.Finalized);
      expect(await bal(f, f.market)).to.equal(0n);
      // late appeal
      const id2 = await completedJob(f, 100);
      const c2 = await challengeAndDraw(f, id2, f.challenger, "late");
      await vote(f, id2, c2, [true, true, true]);
      await f.market.resolveDispute(id2);
      await time.increase(P0.appealWindow + 1);
      await expect(f.market.connect(f.creator).appeal(id2)).to.be.revertedWithCustomError(f.market, "TooLate");
    });
    it("POLICY UPDATE: appeal opens without enough disjoint jurors and holds all funds for arbitration", async function () {
      const f = await loadFixture(fx5);
      const id = await completedJob(f, 100);
      const c0 = await challengeAndDraw(f, id);
      await vote(f, id, c0, [false, false, false]);
      await f.market.resolveDispute(id);
      await f.market.connect(f.provider).appeal(id);
      const d = await f.market.disputes(id);
      expect(d.round).to.equal(1n);
      expect(d.appealBond).to.be.greaterThan(0n);
      await mine();
      await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market, "NotEnoughVerifiers");
      expect((await f.market.committeeOfRound(id, 1)).length).to.equal(0);
      const held = await bal(f, f.market);
      await time.increaseTo((await f.market.effectiveProtectedDeadline(id)) + 1n);
      await f.market.resolveStale(id);
      await time.increase(365 * 86400);
      await expect(f.market.finalizeDispute(id)).to.be.revertedWithCustomError(f.market, "InvalidState");
      expect((await f.market.disputes(id)).phase).to.equal(5n);
      expect(await bal(f, f.market)).to.equal(held);
    });
  });

  describe("Fix 4: arbiter & no-majority fallback", function () {
    it("POLICY UPDATE: no majority: authorized arbiter without expiry; escalation alone does not settle", async function () {
      const f = await loadFixture(fx5);
      const id = await completedJob(f, 100);
      const c = await challengeAndDraw(f, id);
      await vote(f, id, c, [true, false, null]);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "TooEarly");
      await time.increase(P0.voteRevealWindow + 1);
      await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market, "NoMajority");
      await expect(f.market.connect(f.outsider).arbitrate(id, true)).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
      await expect(f.market.resolveStale(id)).to.emit(f.market, "ArbitrationRequested");
      await f.market.connect(f.arbiter).arbitrate(id, false);
      expect((await f.market.jobs(id)).status).to.equal(Status.Refunded);
      expect(await bal(f, f.market)).to.equal(0n);
    });
    it("POLICY UPDATE: absent arbiter means indefinite hold, never 50/50; late binary decision remains possible", async function () {
      const f = await loadFixture(fx5);
      const id = await completedJob(f, 100);
      const c = await challengeAndDraw(f, id);
      const cr0 = await bal(f, f.creator), p0 = await bal(f, f.provider), ch0 = await bal(f, f.challenger);
      await vote(f, id, c, [true, false, null]);
      await time.increase(P0.voteRevealWindow + P0.arbitrationWindow + 2);
      await f.market.resolveStale(id);
      expect((await f.market.jobs(id)).status).to.equal(Status.Disputed);
      expect(await bal(f, f.creator)).to.equal(cr0);
      expect(await bal(f, f.provider)).to.equal(p0);
      expect(await bal(f, f.challenger)).to.equal(ch0);
      expect(await bondOf(f, c[2])).to.equal(S(1000)); // duties/slashing deferred until verdict
      await time.increase(365 * 86400);
      await f.market.connect(f.arbiter).arbitrate(id, false);
      expect((await f.market.jobs(id)).status).to.equal(Status.Refunded);
      expect((await bal(f, f.creator)) - cr0).to.equal(S(100));
      const [, pen] = await f.market.disputeAmounts(S(100));
      expect(await bondOf(f, c[2])).to.equal(S(1000) - pen);
      expect(await bal(f, f.market)).to.equal(0n);
    });
  });

  describe("ATTACK bribery bounds", function () {
    it("max job value <= 50% of total verifier stake; bribing a round-0 majority is exposed to appeal slash", async function () {
      const f = await loadFixture(fx8);
      const cap = await f.market.maxJobBudget();
      expect(cap).to.equal(S(4000));
      await expect(f.market.connect(f.creator).createJob(cap + 1n, 3600, "j")).to.be.revertedWithCustomError(f.market, "JobTooLarge");
    });
  });
});

describe("V2.1 reproduction: challenger re-draw via expireUnrevealedChallenge", function () {
  it("same-block re-challenge after expiry is possible on V2.1 (fixed in V3)", async function () {
    const { deployCore } = require("../scripts/v2/lib.cjs");
    const { MARKETPLACE_PARAMS_TESTNET: MP, GOV_TESTNET: GOV } = require("../scripts/v2/config.cjs");
    const [admin, creator, provider, challenger, v1, v2, v3] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
    const { staking, market } = await deployCore(ethers, { superToken: await token.getAddress(), deployer: admin, guardian: admin.address, marketParams: MP, gov: GOV });
    for (const s of [creator, provider, challenger, v1, v2, v3]) {
      await token.transfer(s.address, S(100000));
      await token.connect(s).approve(await staking.getAddress(), ethers.MaxUint256);
      await token.connect(s).approve(await market.getAddress(), ethers.MaxUint256);
    }
    await staking.connect(provider).stake(S(5000));
    const sc = (x) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [x]));
    await market.connect(creator).createJob(S(100), 3600, "j");
    await market.connect(provider).assignJob(1);
    await market.connect(provider).submitResult(1, "r");
    await market.connect(challenger).challengeJob(1, sc(ethers.id("seed1")));
    // challenger now knows seed1 + blockhash(commitBlock+1) => knows the committee; dislikes it, withholds
    await time.increase(MP.seedRevealWindow + 1);
    await network.provider.send("evm_setAutomine", [false]);
    await market.connect(challenger).expireUnrevealedChallenge(1);
    await market.connect(challenger).challengeJob(1, sc(ethers.id("seed2")), { gasLimit: 1_000_000 });
    await mine(1);
    await network.provider.send("evm_setAutomine", [true]);
    expect((await market.jobs(1)).status).to.equal(4); // Disputed again => re-roll succeeded
    expect((await market.disputes(1)).seedCommit).to.equal(sc(ethers.id("seed2")));
  });
});
