const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {expect} = require("chai");
const {ethers} = require("hardhat");
const {time, mine} = require("@nomicfoundation/hardhat-network-helpers");
const {MARKETPLACE_V3_PARAMS_TESTNET:P} = require("../scripts/v3/config.cjs");
const S = ethers.parseEther;
async function setup(n=3){
 const [admin,creator,provider,challenger,arbiter,treasury,...vs]=await ethers.getSigners();
 const token=await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
 const staking=await (await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(),admin.address,60);
 const market=await (await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),admin.address,admin.address,arbiter.address,treasury.address,P);
 await staking.grantRole(await staking.OPERATOR_ROLE(),await market.getAddress());
 for(const s of [creator,provider,challenger,...vs.slice(0,n)]){
  await token.transfer(s.address,S("10000"));
  await token.connect(s).approve(await staking.getAddress(),ethers.MaxUint256);
  await token.connect(s).approve(await market.getAddress(),ethers.MaxUint256);
 }
 await staking.connect(provider).stake(S("1000"));
 for(const v of vs.slice(0,n)){await staking.connect(v).stake(S("1000"));await market.connect(v).registerVerifier();}
 await market.connect(creator).createJob(S("100"),3600,"job");
 await market.connect(provider).assignJob(1);
 await market.connect(provider).submitResult(1,"result");
 return {admin,creator,provider,challenger,vs,token,staking,market};
}
describe("R1/R3/R4 retained + R2/R5 new arbitration PROTOTYPE checks",function(){
 it("R1 FIXED: two one-unit deposits remain funded and claim succeeds with documented one-unit dust",async function(){
  const [admin,alice]=await ethers.getSigners();
  const token=await (await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
  const staking=await (await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(),admin.address,60);
  await token.transfer(alice.address,3n);
  await token.connect(alice).approve(await staking.getAddress(),3n);
  await staking.connect(alice).stake(3n);
  await time.increase(61);
  await token.approve(await staking.getAddress(),2n);
  await staking.depositRewards(1n);await staking.depositRewards(1n);
  expect(await staking.earned(alice.address)).to.equal(1n);
  expect(await staking.totalRewardsOwed()).to.equal(2n);
  expect(await staking.queuedRewards()).to.equal(0n);
  await expect(staking.connect(alice).claimRewards()).to.emit(staking,"RewardClaimed").withArgs(alice.address,1n);
  expect(await token.balanceOf(alice.address)).to.equal(1n);
  expect(await staking.totalRewardsOwed()).to.equal(1n);
  expect(await token.balanceOf(await staking.getAddress())).to.equal(4n); // 3 principal + 1 reserved dust
 });
 it("R2 PROTOTYPE: verifier departure cannot cancel or pay a disputed job without verdict",async function(){
  // PAUSE/JURY FIX: departure now happens BEFORE filing (a frozen candidate can no longer leave after it).
  const f=await setup();await f.market.connect(f.vs[0]).exitVerifier();await f.market.connect(f.challenger).challengeJob(1,ethers.id("cancel"));
  const bond=(await f.market.disputes(1)).bond;
  await expect(legacyDraw(f.market,1)).to.be.revertedWithCustomError(f.market,"NotEnoughVerifiers");
  expect((await f.market.jobs(1)).status).to.equal(4n);expect((await f.market.disputes(1)).bond).to.equal(bond);
  expect((await f.market.committeeOfRound(1,0)).length).to.equal(0);
  const before=await f.token.balanceOf(f.provider.address);await expect(f.market.finalizeJob(1)).to.be.revertedWithCustomError(f.market,"InvalidState");
  await time.increaseTo((await f.market.effectiveProtectedDeadline(1))+1n);await f.market.resolveStale(1);
  expect((await f.market.disputes(1)).phase).to.equal(5n);expect(await f.token.balanceOf(f.provider.address)).to.equal(before);
 });
 it("R3 FIXED: pause preserves challenge time and blocks premature finalization",async function(){
  const f=await setup();const deadline=(await f.market.jobs(1)).challengeDeadline;
  await f.market.pause();
  await expect(f.market.connect(f.creator).challengeJob(1,ethers.id("paused"))).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await time.increaseTo(deadline+1n);await f.market.unpause();
  expect((await f.market.jobs(1)).challengeDeadline).to.equal(deadline);
  expect(await f.market.effectiveProtectedDeadline(1)).to.be.greaterThan(BigInt(await time.latest()));
  await expect(f.market.finalizeJob(1)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await f.market.connect(f.creator).challengeJob(1,ethers.id("preserved"));
  expect((await f.market.jobs(1)).status).to.equal(4n);
 });
 it("R4 FIXED: pause preserves appeal time and blocks premature settlement",async function(){
  const f=await setup(8);
  await f.market.connect(f.challenger).challengeJob(1,ethers.id("appeal"));await mine(1);await legacyDraw(f.market,1);
  const committee=await f.market.committeeOfRound(1,0);
  const salt=ethers.id("vote");
  for(const a of committee){const s=await ethers.getSigner(a);const h=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bool","bytes32","address","uint256"],[true,salt,a,1]));await f.market.connect(s).commitVote(1,h);}
  await time.increaseTo((await f.market.rounds(1,0)).commitDeadline+1n);
  for(const a of committee)await f.market.connect(await ethers.getSigner(a)).revealVote(1,true,salt);
  await f.market.resolveDispute(1);const deadline=(await f.market.disputes(1)).appealDeadline;
  await f.market.pause();
  await expect(f.market.connect(f.creator).appeal(1)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await time.increaseTo(deadline+1n);await f.market.unpause();
  expect(await f.market.effectiveProtectedDeadline(1)).to.be.greaterThan(BigInt(await time.latest()));
  await expect(f.market.finalizeDispute(1)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await f.market.connect(f.creator).appeal(1);
  expect((await f.market.disputes(1)).round).to.equal(1n);
 });
 it("VRF UPDATE: missing callback cannot reroll or extend Draw; escalation retains funds for arbiter",async function(){
  const f=await setup();await f.market.connect(f.challenger).challengeJob(1,ethers.id("retarget"));const deadline=await f.market.effectiveProtectedDeadline(1);
  for(let i=0;i<4;i++){await mine(300);await expect(f.market.drawCommittee(1)).to.be.revertedWithCustomError(f.market,"TooEarly");expect((await f.market.disputes(1)).phase).to.equal(1n);expect(await f.market.effectiveProtectedDeadline(1)).to.equal(deadline);}
  await time.increase(365*24*3600);await expect(legacyDraw(f.market,1)).to.be.revertedWithCustomError(f.market,"TooLate");
  await expect(f.market.resolveStale(1)).to.emit(f.market,"ArbitrationRequested");
  expect((await f.market.jobs(1)).status).to.equal(4n);expect((await f.market.disputes(1)).phase).to.equal(5n);expect((await f.market.disputes(1)).bond).to.be.greaterThan(0n);
 });
});
