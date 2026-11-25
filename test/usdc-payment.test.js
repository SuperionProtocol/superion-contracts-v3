const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("../helpers/filing-shortage-fixture.cjs");
const { oracle } = require("../helpers/legacy-vrf-fixture.cjs");
const { governedDeploy, DELAY } = require("../helpers/governed-deploy.cjs");
const { safeCall } = require("../helpers/local-safe.cjs");

const { P, S } = H;
const U = (n) => ethers.parseUnits(String(n), 6); // 6-decimal USDC helper
const salt = (s) => ethers.id("usdc-salt-" + s);
const voteCommit = (v, sl, voter, id) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bool", "bytes32", "address", "uint256"], [v, sl, voter, id]));

async function governedUsdcFixture() {
  const g = await governedDeploy(ethers, P);
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const feeTok = await (await ethers.getContractFactory("MockFeeToken")).deploy();
  const mAddr = await g.market.getAddress();
  const stAddr = await g.staking.getAddress();

  for (const s of [g.creator, g.provider, g.challenger, g.outsider, ...g.vs]) {
    await g.token.transfer(s.address, S("50000"));
    await g.token.connect(s).approve(stAddr, ethers.MaxUint256);
    await g.token.connect(s).approve(mAddr, ethers.MaxUint256);
    await usdc.mint(s.address, U(100000));
    await usdc.connect(s).approve(mAddr, ethers.MaxUint256);
  }
  await g.staking.connect(g.provider).stake(S("50000"));
  for (const v of g.vs.slice(0, 3)) {
    await g.staking.connect(v).stake(S("1000"));
    await g.market.connect(v).registerVerifier();
  }
  // Whitelist USDC via full 48h Timelock + Safe 2-of-3 governance:
  // maxBudget = 5,000 USDC, superPerUnit = 1e12 (1 USDC = 1 SUPER)
  const TL = await g.timelock.getAddress();
  const callData = g.market.interface.encodeFunctionData("setPaymentToken", [
    await usdc.getAddress(),
    true,
    U(5000),
    10n ** 12n,
  ]);
  const pred = ethers.ZeroHash;
  const sId = ethers.id("whitelist-usdc");
  const sched = g.timelock.interface.encodeFunctionData("schedule", [mAddr, 0n, callData, pred, sId, DELAY]);
  await safeCall(ethers, g.safe, TL, sched, g.owners.slice(0, 2), g.relayer);
  await time.increase(DELAY + 1n);
  const exec = g.timelock.interface.encodeFunctionData("execute", [mAddr, 0n, callData, pred, sId]);
  await safeCall(ethers, g.safe, TL, exec, g.owners.slice(0, 2), g.relayer);

  const engine = await oracle(g.market);
  const mock = await ethers.getContractAt("LocalVrfCoordinatorMock", await engine.coordinator());
  const terms = await ethers.getContractAt("MissionTerms", await g.market.terms());
  return { ...g, usdc, feeTok, engine, mock, terms };
}

async function fulfillAndSeat(f, id, word = 42n) {
  const d = await f.market.disputes(id);
  const st = await f.engine.status(id, d.round);
  await f.mock.fulfill(st.requestId, word);
  await f.market.connect(f.outsider).drawCommittee(id);
  return f.market.committeeOf(id);
}

async function castVotes(f, id, committee, votes) {
  for (let i = 0; i < committee.length; i++) {
    const s = await ethers.getSigner(committee[i]);
    await f.market.connect(s).commitVote(id, voteCommit(votes[i], salt(id + "-" + i), committee[i], id));
  }
  await time.increase(P.voteCommitWindow + 1);
  for (let i = 0; i < committee.length; i++) {
    const s = await ethers.getSigner(committee[i]);
    await f.market.connect(s).revealVote(id, votes[i], salt(id + "-" + i));
  }
}

describe("Superion V3 USDC payment support (LOCAL PROTOTYPE)", function () {
  it("governance & whitelist: only Timelock/admin can whitelist; EOA/zero/SUPER/non-whitelisted/fee-on-transfer rejected", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await other.mint(f.creator.address, U(5000));
    await other.connect(f.creator).approve(await f.market.getAddress(), ethers.MaxUint256);

    // Non-admin cannot whitelist
    await expect(
      f.market.connect(f.outsider).setPaymentToken(await other.getAddress(), true, U(5000), 10n ** 12n)
    ).to.be.revertedWithCustomError(f.market, "AccessControlUnauthorizedAccount");
    await expect(
      f.market.connect(f.creator).createJobWithToken(await other.getAddress(), U(100), 3600, "non-whitelisted")
    ).to.be.revertedWithCustomError(f.market, "TokenNotAllowed");

    // Fee-on-transfer rejected (both by whitelist and by balanceOf delta check if ever whitelisted)
    await f.feeTok.transfer(f.creator.address, U(1000));
    await f.feeTok.connect(f.creator).approve(await f.market.getAddress(), ethers.MaxUint256);
    await expect(
      f.market.connect(f.creator).createJobWithToken(await f.feeTok.getAddress(), U(100), 3600, "fee-tok")
    ).to.be.revertedWithCustomError(f.market, "TokenNotAllowed");

    // Invalid params if someone with admin role passes zero, EOA, SUPER, or zero caps
    const TL = await f.timelock.getAddress();
    const { network } = require("hardhat");
    await network.provider.send("hardhat_impersonateAccount", [TL]);
    await network.provider.send("hardhat_setBalance", [TL, "0xDE0B6B3A7640000"]);
    const tlSigner = await ethers.getSigner(TL);
    await expect(
      f.market.connect(tlSigner).setPaymentToken(ethers.ZeroAddress, true, U(100), 10n ** 12n)
    ).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(
      f.market.connect(tlSigner).setPaymentToken(f.outsider.address, true, U(100), 10n ** 12n)
    ).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(
      f.market.connect(tlSigner).setPaymentToken(await f.token.getAddress(), true, U(100), 10n ** 12n)
    ).to.be.revertedWithCustomError(f.market, "InvalidParams");
    await expect(
      f.market.connect(tlSigner).setPaymentToken(await other.getAddress(), true, 0, 10n ** 12n)
    ).to.be.revertedWithCustomError(f.market, "InvalidParams");

    // Even if fee-on-transfer were accidentally whitelisted, balanceOf check rejects it
    await f.market.connect(tlSigner).setPaymentToken(await f.feeTok.getAddress(), true, U(5000), 10n ** 12n);
    await expect(
      f.market.connect(f.creator).createJobWithToken(await f.feeTok.getAddress(), U(100), 3600, "fee-tok-check")
    ).to.be.revertedWithCustomError(f.market, "InvalidParams");
  });

  it("budget caps (oracle-free): bounded by min(tokenMaxBudget, maxJobBudget / superPerUnit) and blocked when 0 verifiers", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    // 3 verifiers * 1000 SUPER = 3000 SUPER -> maxJobBudget = 1500 SUPER -> max USDC = 1500 USDC
    expect(await f.market.maxJobBudget()).to.equal(S("1500"));
    expect(await f.market.maxJobBudgetForToken(uAddr)).to.equal(U(1500));
    await expect(
      f.market.connect(f.creator).createJobWithToken(uAddr, U(1501), 3600, "too-big-stake")
    ).to.be.revertedWithCustomError(f.market, "JobTooLarge");

    // Add more verifier bond -> maxJobBudget rises above 5000 SUPER -> cap becomes cfg.maxBudget = 5000 USDC
    for (const v of f.vs.slice(3, 10)) {
      await f.staking.connect(v).stake(S("2000"));
      await f.market.connect(v).registerVerifierWithStake(S("2000"));
    }
    expect(await f.market.maxJobBudget()).to.equal(S("8500"));
    expect(await f.market.maxJobBudgetForToken(uAddr)).to.equal(U(5000));
    await expect(
      f.market.connect(f.creator).createJobWithToken(uAddr, U(5001), 3600, "too-big-cap")
    ).to.be.revertedWithCustomError(f.market, "JobTooLarge");

    // 5000 USDC succeeds
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(5000), 3600, "ok-cap");
  });

  it("USDC job accepted: 1000 USDC paid -> 950 USDC provider, 50 USDC treasury, 0 burn/stSUPER, provider SUPER stake unlocked", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const mAddr = await f.market.getAddress();
    const supplyBefore = await f.usdc.totalSupply();
    const pUsdc0 = await f.usdc.balanceOf(f.provider.address);
    const tUsdc0 = await f.usdc.balanceOf(f.treasury.address);
    const pLocked0 = await f.staking.lockedStake(f.provider.address);

    const id = await f.market.nextJobId();
    await expect(f.market.connect(f.creator).createJobWithToken(uAddr, U(1000), 3600, "ipfs://usdc-job"))
      .to.emit(f.market, "JobPaymentTokenSet")
      .withArgs(id, uAddr);

    expect(await f.market.jobPaymentToken(id)).to.equal(uAddr);
    expect(await f.market.jobSuperBudget(id)).to.equal(S("1000"));
    expect(await f.usdc.balanceOf(mAddr)).to.equal(U(1000));

    // Provider locks 1000 SUPER (18 decimals) for a 1000 USDC (6 decimals) job
    await f.market.connect(f.provider).assignJob(id);
    expect(await f.staking.lockedStake(f.provider.address) - pLocked0).to.equal(S("1000"));

    await f.market.connect(f.provider).submitResult(id, "ipfs://usdc-res");
    await time.increase(P.challengePeriod + 1);

    await expect(f.market.finalizeJob(id))
      .to.emit(f.market, "JobFinalized")
      .withArgs(id, f.provider.address, U(950), U(50), 0n, 0n);

    expect(await f.usdc.balanceOf(f.provider.address) - pUsdc0).to.equal(U(950));
    expect(await f.usdc.balanceOf(f.treasury.address) - tUsdc0).to.equal(U(50));
    expect(await f.usdc.balanceOf(mAddr)).to.equal(0n);
    expect(await f.usdc.totalSupply()).to.equal(supplyBefore);
    expect(await f.staking.lockedStake(f.provider.address)).to.equal(pLocked0);
  });

  it("USDC job with treasury == address(0) routes fee to fallbackTreasury (Timelock) with 0 stuck USDC", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const TL = await f.timelock.getAddress();
    const { network } = require("hardhat");
    await network.provider.send("hardhat_impersonateAccount", [TL]);
    await network.provider.send("hardhat_setBalance", [TL, "0xDE0B6B3A7640000"]);
    await f.market.connect(await ethers.getSigner(TL)).setTreasury(ethers.ZeroAddress);

    const tlUsdc0 = await f.usdc.balanceOf(TL);
    const pUsdc0 = await f.usdc.balanceOf(f.provider.address);
    const id = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(1000), 3600, "ipfs://zero-treasury");
    await f.market.connect(f.provider).assignJob(id);
    await f.market.connect(f.provider).submitResult(id, "ipfs://res");
    await time.increase(P.challengePeriod + 1);
    await f.market.finalizeJob(id);

    expect(await f.usdc.balanceOf(f.provider.address) - pUsdc0).to.equal(U(950));
    expect(await f.usdc.balanceOf(TL) - tlUsdc0).to.equal(U(50));
    expect(await f.usdc.balanceOf(await f.market.getAddress())).to.equal(0n);
  });

  it("USDC job contested and refunded: creator gets 1000 USDC back; provider SUPER stake slashed 10/10/80 + burned in SUPER", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const mAddr = await f.market.getAddress();

    const cUsdc0 = await f.usdc.balanceOf(f.creator.address);
    const chSuper0 = await f.token.balanceOf(f.challenger.address);
    const supSupply0 = await f.token.totalSupply();

    const id = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(1000), 3600, "ipfs://disputed-usdc");
    await f.market.connect(f.provider).assignJob(id);
    await f.market.connect(f.provider).submitResult(id, "ipfs://bad-res");

    // Challenger posts 100 SUPER bond (10% of 1000 SUPER equivalent)
    await f.market.connect(f.challenger).challengeJob(id, salt("1"));
    expect(chSuper0 - await f.token.balanceOf(f.challenger.address)).to.equal(S("100"));

    const comm = await fulfillAndSeat(f, id);
    await castVotes(f, id, comm, [false, false, false]);
    await f.market.resolveDispute(id);
    await time.increase(P.appealWindow + 1);

    const v0SuperBefore = await f.token.balanceOf(comm[0]);
    await f.market.finalizeDispute(id);

    // Creator receives full 1000 USDC refund; 0 USDC remains in marketplace
    expect(await f.usdc.balanceOf(f.creator.address)).to.equal(cUsdc0);
    expect(await f.usdc.balanceOf(mAddr)).to.equal(0n);

    // Provider's 1000 SUPER stake slashed:
    // - 3 verifiers paid 30 SUPER voteFee each (90 SUPER) from bond, leaving 10 SUPER bondLeft
    // - slash = 1000 SUPER: reimb = 90 SUPER -> rest = 910 SUPER
    // - challenger share = 10% of 910 = 91 SUPER; verifier share = 10% of 910 = 91 SUPER (30.333... each, 1 wei dust burned); burned = 728 SUPER + 1 wei dust
    const chSuperAfter = await f.token.balanceOf(f.challenger.address);
    expect(chSuperAfter - chSuper0).to.equal(S("91")); // +10 bondLeft + 90 reimb + 91 cShare - 100 posted = +91 SUPER
    const v0Gain = (await f.token.balanceOf(comm[0])) - v0SuperBefore;
    expect(v0Gain).to.equal(S("30") + S("91") / 3n);
    const burnedTotal = supSupply0 - await f.token.totalSupply();
    expect(burnedTotal).to.equal(S("728") + 1n);
  });

  it("USDC job contested and upheld (provider wins): verifiers paid in SUPER, provider gets 950 USDC + unlocked SUPER", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const pUsdc0 = await f.usdc.balanceOf(f.provider.address);
    const tUsdc0 = await f.usdc.balanceOf(f.treasury.address);

    const id = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(1000), 3600, "ipfs://upheld-usdc");
    await f.market.connect(f.provider).assignJob(id);
    await f.market.connect(f.provider).submitResult(id, "ipfs://good-res");
    await f.market.connect(f.challenger).challengeJob(id, salt("2"));

    const comm = await fulfillAndSeat(f, id);
    await castVotes(f, id, comm, [true, true, true]);
    await f.market.resolveDispute(id);
    await time.increase(P.appealWindow + 1);
    await f.market.finalizeDispute(id);

    expect(await f.usdc.balanceOf(f.provider.address) - pUsdc0).to.equal(U(950));
    expect(await f.usdc.balanceOf(f.treasury.address) - tUsdc0).to.equal(U(50));
    expect(await f.usdc.balanceOf(await f.market.getAddress())).to.equal(0n);
    expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
  });

  it("USDC job cancelJob & reclaimExpired refund exact USDC; de-whitelisting blocks new jobs only", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const cUsdc0 = await f.usdc.balanceOf(f.creator.address);

    const id1 = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(250), 3600, "cancel-usdc");
    await f.market.connect(f.creator).cancelJob(id1);
    expect(await f.usdc.balanceOf(f.creator.address)).to.equal(cUsdc0);

    const id2 = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(400), 3600, "expire-usdc");
    await f.market.connect(f.provider).assignJob(id2);

    // De-whitelist USDC while id2 is Assigned
    const TL = await f.timelock.getAddress();
    const { network } = require("hardhat");
    await network.provider.send("hardhat_impersonateAccount", [TL]);
    await network.provider.send("hardhat_setBalance", [TL, "0xDE0B6B3A7640000"]);
    await f.market.connect(await ethers.getSigner(TL)).setPaymentToken(uAddr, false, 0, 0);

    await expect(
      f.market.connect(f.creator).createJobWithToken(uAddr, U(100), 3600, "blocked-after-delist")
    ).to.be.revertedWithCustomError(f.market, "TokenNotAllowed");

    // Existing id2 still expires and refunds creator cleanly
    await time.increase(3601);
    await f.market.connect(f.creator).reclaimExpired(id2);
    expect(await f.usdc.balanceOf(f.creator.address)).to.equal(cUsdc0);
    expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
  });

  it("SUPER jobs in the same deployment remain completely unchanged (burn + stSUPER rewards + treasury)", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const pSuper0 = await f.token.balanceOf(f.provider.address);
    const tSuper0 = await f.token.balanceOf(f.treasury.address);
    const stSuper0 = await f.token.balanceOf(await f.staking.getAddress());
    const sup0 = await f.token.totalSupply();

    const id = await f.market.nextJobId();
    await f.market.connect(f.creator).createJob(S("1000"), 3600, "ipfs://super-unchanged");
    expect(await f.market.jobPaymentToken(id)).to.equal(await f.token.getAddress());

    await f.market.connect(f.provider).assignJob(id);
    await f.market.connect(f.provider).submitResult(id, "ipfs://super-res");
    await time.increase(P.challengePeriod + 1);
    await expect(f.market.finalizeJob(id))
      .to.emit(f.market, "JobFinalized")
      .withArgs(id, f.provider.address, S("950"), S("50"), S("10"), S("15"));

    expect(await f.token.balanceOf(f.provider.address) - pSuper0).to.equal(S("950"));
    expect(await f.token.balanceOf(f.treasury.address) - tSuper0).to.equal(S("25"));
    expect(await f.token.balanceOf(await f.staking.getAddress()) - stSuper0).to.equal(S("15"));
    expect(sup0 - await f.token.totalSupply()).to.equal(S("10"));
  });

  it("non-1:1 conversion rate (1 USDC = 2 SUPER), 10% max fee cap, and 0-verifier block", async function () {
    const f = await loadFixture(governedUsdcFixture);
    const uAddr = await f.usdc.getAddress();
    const TL = await f.timelock.getAddress();
    const { network } = require("hardhat");
    await network.provider.send("hardhat_impersonateAccount", [TL]);
    await network.provider.send("hardhat_setBalance", [TL, "0xDE0B6B3A7640000"]);
    const tl = await ethers.getSigner(TL);

    // 1 USDC = 2 SUPER (superPerUnit = 2e12), maxBudget = 5000 USDC; with 3000 SUPER bond -> cap 1500 SUPER -> 750 USDC max
    await f.market.connect(tl).setPaymentToken(uAddr, true, U(5000), 2n * 10n ** 12n);
    expect(await f.market.maxJobBudgetForToken(uAddr)).to.equal(U(750));
    await expect(
      f.market.connect(f.creator).createJobWithToken(uAddr, U(751), 3600, "over-converted-cap")
    ).to.be.revertedWithCustomError(f.market, "JobTooLarge");

    // 10% fee cap (1000 bps) respected; >1000 bps rejected by MissionTerms
    await expect(f.terms.connect(tl).setFees(1001, 2000)).to.be.revertedWithCustomError(f.terms, "InvalidParams");
    await f.terms.connect(tl).setFees(1000, 2000);

    const pUsdc0 = await f.usdc.balanceOf(f.provider.address);
    const tUsdc0 = await f.usdc.balanceOf(f.treasury.address);
    const id = await f.market.nextJobId();
    await f.market.connect(f.creator).createJobWithToken(uAddr, U(500), 3600, "ipfs://rate-2x");
    expect(await f.market.jobSuperBudget(id)).to.equal(S("1000"));
    await f.market.connect(f.provider).assignJob(id);
    expect(await f.staking.lockedStake(f.provider.address)).to.equal(S("1000"));
    await f.market.connect(f.provider).submitResult(id, "ipfs://ok");
    await time.increase(P.challengePeriod + 1);
    await f.market.finalizeJob(id);
    expect(await f.usdc.balanceOf(f.provider.address) - pUsdc0).to.equal(U(450)); // 90%
    expect(await f.usdc.balanceOf(f.treasury.address) - tUsdc0).to.equal(U(50));  // 10%

    // With 0 verifiers, maxJobBudgetForToken is 0 and creation reverts JobTooLarge
    for (const v of f.vs.slice(0, 3)) await f.market.connect(v).exitVerifier();
    expect(await f.market.maxJobBudgetForToken(uAddr)).to.equal(0n);
    await expect(
      f.market.connect(f.creator).createJobWithToken(uAddr, U(1), 3600, "no-verifiers")
    ).to.be.revertedWithCustomError(f.market, "JobTooLarge");
  });
});
