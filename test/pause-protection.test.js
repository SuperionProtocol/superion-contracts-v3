const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {expect}=require("chai");
const {ethers}=require("hardhat");
const {time,mine}=require("@nomicfoundation/hardhat-network-helpers");
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require("../scripts/v3/config.cjs");
const S=ethers.parseEther;
async function fixture(n=8){
 const [admin,creator,provider,challenger,arbiter,treasury,...vs]=await ethers.getSigners();
 const token=await(await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
 const staking=await(await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(),admin.address,60);
 const market=await(await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),admin.address,admin.address,arbiter.address,treasury.address,P);
 await staking.grantRole(await staking.OPERATOR_ROLE(),await market.getAddress());
 for(const a of [creator,provider,challenger,...vs.slice(0,n)]){
  await token.transfer(a.address,S("10000"));await token.connect(a).approve(await staking.getAddress(),ethers.MaxUint256);await token.connect(a).approve(await market.getAddress(),ethers.MaxUint256);
 }
 await staking.connect(provider).stake(S("1000"));
 for(const a of vs.slice(0,n)){await staking.connect(a).stake(S("1000"));await market.connect(a).registerVerifier();}
 return {admin,creator,provider,challenger,arbiter,vs,token,staking,market};
}
async function job(f,submit=true){
 const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S("100"),3600,"job");await f.market.connect(f.provider).assignJob(id);
 if(submit)await f.market.connect(f.provider).submitResult(id,"result");return id;
}
async function draw(f,id){await f.market.connect(f.challenger).challengeJob(id,ethers.id("challenge"));await mine(1);await legacyDraw(f.market,id);return f.market.committeeOfRound(id,0);}
async function votes(f,id,c){
 const salt=ethers.id("vote");for(const a of c){const h=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bool","bytes32","address","uint256"],[true,salt,a,id]));await f.market.connect(await ethers.getSigner(a)).commitVote(id,h);}
 await time.increaseTo((await f.market.rounds(id,0)).commitDeadline+1n);
 for(const a of c)await f.market.connect(await ethers.getSigner(a)).revealVote(id,true,salt);
}
async function decided(f){const id=await job(f),c=await draw(f,id);await votes(f,id,c);await f.market.resolveDispute(id);return {id,c};}
async function pausedSpan(f,seconds){await f.market.pause();const start=BigInt(await time.latest());await time.increase(seconds);await f.market.unpause();return BigInt(await time.latest())-start;}
async function remaining(f,id){return (await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());}
async function dutiesZero(f,c){for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(0n);}
describe("Pause protection: Unix API, boundaries, multiple windows and unchanged voting",function(){
 it("missing windows stay zero and pause authorization/repeated calls remain protected",async function(){
  const f=await fixture();expect(await f.market.effectiveProtectedDeadline(999)).to.equal(0n);
  await expect(f.market.connect(f.creator).pause()).to.be.revertedWithCustomError(f.market,"AccessControlUnauthorizedAccount");
  await f.market.pause();await expect(f.market.pause()).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await time.increase(100);expect(await f.market.effectiveProtectedDeadline(999)).to.equal(0n);
  await f.market.unpause();await expect(f.market.unpause()).to.be.revertedWithCustomError(f.market,"ExpectedPause");
 });
 it("without pauses the effective current window equals its original Unix deadline",async function(){
  const f=await fixture(),id=await job(f);expect(await f.market.effectiveProtectedDeadline(id)).to.equal((await f.market.jobs(id)).challengeDeadline);
  const c=await draw(f,id);await votes(f,id,c);await f.market.resolveDispute(id);
  expect(await f.market.effectiveProtectedDeadline(id)).to.equal((await f.market.disputes(id)).appealDeadline);
 });
 it("multiple pauses preserve remaining challenge time during each pause and after resume",async function(){
  const f=await fixture(),id=await job(f),baseline=(await f.market.jobs(id)).challengeDeadline;let elapsed=0n;
  for(const seconds of [37,500,1800]){
   await f.market.pause();const start=BigInt(await time.latest()),r=await remaining(f,id);await time.increase(seconds);
   expect(await remaining(f,id)).to.equal(r);// PAUSE/SATURATION FIX: finalizeJob is no longer blocked by the pause flag itself; the frozen clock refuses it (window still open).
   await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market,"TooEarly");
   await f.market.unpause();elapsed+=BigInt(await time.latest())-start;expect(await remaining(f,id)).to.equal(r);
   expect(await f.market.effectiveProtectedDeadline(id)).to.equal(baseline+elapsed);
  }
  expect((await f.market.jobs(id)).challengeDeadline).to.equal(baseline);
  await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market,"TooEarly");await f.market.connect(f.creator).challengeJob(id,ethers.id("retained"));
 });
 it("a window starting after earlier pauses receives no credit for those earlier pauses",async function(){
  const f=await fixture();await pausedSpan(f,1000);const id=await job(f);
  expect(await f.market.effectiveProtectedDeadline(id)).to.equal((await f.market.jobs(id)).challengeDeadline);
  expect(await remaining(f,id)).to.equal(BigInt(P.challengePeriod));
 });
 it("different jobs retain their own start points across a common pause",async function(){
  const f=await fixture(),id1=await job(f);await pausedSpan(f,40);await time.increase(20);const id2=await job(f);
  const d1=await f.market.effectiveProtectedDeadline(id1),d2=await f.market.effectiveProtectedDeadline(id2),duration=await pausedSpan(f,1000);
  expect(await f.market.effectiveProtectedDeadline(id1)).to.equal(d1+duration);expect(await f.market.effectiveProtectedDeadline(id2)).to.equal(d2+duration);
  expect(d2-d1).to.be.greaterThan(0n);
 });
 it("submission during a pause starts a full protected challenge period at resume",async function(){
  const f=await fixture(),id=await job(f,false);await f.market.pause();await time.increase(100);
  await f.market.connect(f.provider).submitResult(id,"during-pause");expect(await remaining(f,id)).to.equal(BigInt(P.challengePeriod));
  await time.increase(1000);expect(await remaining(f,id)).to.equal(BigInt(P.challengePeriod));await f.market.unpause();
  expect(await remaining(f,id)).to.equal(BigInt(P.challengePeriod));await f.market.connect(f.creator).challengeJob(id,ethers.id("available"));
 });
 it("PAUSE/SATURATION FIX: no verdict can be recorded during pause; after resume the full appeal period starts",async function(){
  const f=await fixture(),id=await job(f),c=await draw(f,id);await votes(f,id,c);await f.market.pause();
  // resolveDispute is now blocked while paused (emergency freeze); the dispute stays in Voting, nothing moves.
  await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market,"EnforcedPause");expect((await f.market.disputes(id)).phase).to.equal(2n);await time.increase(1000);
  await f.market.unpause();await f.market.resolveDispute(id);expect(await remaining(f,id)).to.equal(BigInt(P.appealWindow));
  await f.market.pause();const r=await remaining(f,id);expect(r).to.equal(BigInt(P.appealWindow)-1n);await time.increase(1000);await expect(f.market.finalizeDispute(id)).to.be.revertedWithCustomError(f.market,"TooEarly");expect(await remaining(f,id)).to.equal(r);
  await f.market.unpause();expect(await remaining(f,id)).to.equal(r);await f.market.connect(f.creator).appeal(id);
 });
 it("an already expired challenge window never revives after a pause",async function(){
  const f=await fixture(),id=await job(f);await time.increaseTo((await f.market.jobs(id)).challengeDeadline+1n);await pausedSpan(f,1000);
  expect(await remaining(f,id)).to.be.lessThan(0n);await expect(f.market.connect(f.creator).challengeJob(id,ethers.id("expired"))).to.be.revertedWithCustomError(f.market,"TooLate");
  await f.market.finalizeJob(id);expect((await f.market.jobs(id)).status).to.equal(5n);
 });
 it("an already expired appeal window never revives after a pause",async function(){
  const f=await fixture(),{id,c}=await decided(f);await time.increaseTo((await f.market.disputes(id)).appealDeadline+1n);await pausedSpan(f,1000);
  expect(await remaining(f,id)).to.be.lessThan(0n);await expect(f.market.connect(f.creator).appeal(id)).to.be.revertedWithCustomError(f.market,"TooLate");
  await f.market.finalizeDispute(id);await dutiesZero(f,c);
 });
 it("challenge remains inclusive at its effective boundary after a pause",async function(){
  const f=await fixture(),id=await job(f);await pausedSpan(f,1000);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));
  await f.market.connect(f.creator).challengeJob(id,ethers.id("boundary"));expect((await f.market.jobs(id)).status).to.equal(4n);
 });
 it("payment is forbidden at the exact effective challenge deadline, then allowed afterward",async function(){
  const f=await fixture(),id=await job(f);await pausedSpan(f,1000);const d=await f.market.effectiveProtectedDeadline(id);
  await time.setNextBlockTimestamp(d);await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await time.increaseTo(d+1n);await f.market.finalizeJob(id);expect((await f.market.jobs(id)).status).to.equal(5n);
 });
 it("appeal remains inclusive at its effective boundary after a pause",async function(){
  const f=await fixture(),{id}=await decided(f);await pausedSpan(f,1000);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));
  await f.market.connect(f.creator).appeal(id);expect((await f.market.disputes(id)).round).to.equal(1n);
 });
 it("settlement is forbidden at the effective appeal deadline, then duties and collateral settle correctly",async function(){
  const f=await fixture(),{id,c}=await decided(f);await pausedSpan(f,1000);const d=await f.market.effectiveProtectedDeadline(id);
  await time.setNextBlockTimestamp(d);await expect(f.market.finalizeDispute(id)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await time.increaseTo(d+1n);await f.market.finalizeDispute(id);await dutiesZero(f,c);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
 });
 it("PAUSE/SATURATION FIX (N4): voting deadlines are frozen during the marketplace pause; remaining vote time is honored at resume",async function(){
  const f=await fixture(),id=await job(f),c=await draw(f,id),rd=await f.market.rounds(id,0),left=rd.commitDeadline-BigInt(await time.latest());await f.market.pause();await time.increaseTo(rd.commitDeadline+86400n);
  expect((await f.market.rounds(id,0)).commitDeadline).to.equal(rd.commitDeadline);expect((await f.market.rounds(id,0)).revealDeadline).to.equal(rd.revealDeadline);
  // wall time passed the stored deadline, but the active clock is frozen: a commit is still on time (no real-time race during the pause)
  await f.market.connect(await ethers.getSigner(c[0])).commitVote(id,ethers.id("on-time-in-pause"));
  await f.market.unpause();await f.market.connect(await ethers.getSigner(c[1])).commitVote(id,ethers.id("after-resume"));
  // the remaining commit time (minus the blocks spent) is still there after resume, then the window closes as before
  await time.increase(Number(left));await expect(f.market.connect(await ethers.getSigner(c[2])).commitVote(id,ethers.id("late"))).to.be.revertedWithCustomError(f.market,"TooLate");
 });
 it("PAUSE/SATURATION FIX: no-majority arbitration is blocked during pause (funds stay in escrow); after resume and the remaining reveal time it settles and releases duties/collateral",async function(){
  const f=await fixture(),id=await job(f),c=await draw(f,id),r=await f.market.rounds(id,0);await f.market.pause();await time.increaseTo(r.revealDeadline+86400n);const escrow=await f.token.balanceOf(await f.market.getAddress());
  await expect(f.market.connect(f.arbiter).arbitrate(id,true)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,"TooEarly"); // reveal clock frozen: not stale yet
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(escrow);for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(1n);
  await f.market.unpause();await expect(f.market.connect(f.arbiter).arbitrate(id,true)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await time.increase(P.voteCommitWindow+P.voteRevealWindow+1);
  await f.market.connect(f.arbiter).arbitrate(id,true);expect((await f.market.jobs(id)).status).to.equal(5n);await dutiesZero(f,c);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
 });
 it("POLICY UPDATE + PAUSE/SATURATION FIX: the no-majority stale route does not run on paused time; after resume it escalates but never splits or unlocks automatically",async function(){
  const f=await fixture(),id=await job(f),c=await draw(f,id);await f.market.pause();await time.increaseTo((await f.market.rounds(id,0)).revealDeadline+BigInt(P.arbitrationWindow)+1n);
  const escrow=await f.token.balanceOf(await f.market.getAddress());
  await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,"TooEarly");await f.market.unpause();await time.increase(P.voteCommitWindow+P.voteRevealWindow+1);
  await f.market.resolveStale(id);expect((await f.market.jobs(id)).status).to.equal(4n);expect((await f.market.disputes(id)).phase).to.equal(5n);
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(escrow);expect(await f.staking.lockedStake(f.provider.address)).to.equal(S("100"));
  for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(1n);
  await f.market.connect(f.arbiter).arbitrate(id,true);await dutiesZero(f,c);
 });
 it("PAUSE/JURY FIX: an appeal window that expired BEFORE the pause can be settled DURING the pause (duties, collateral and payment released)",async function(){
  const f=await fixture(),{id,c}=await decided(f);await time.increaseTo((await f.market.disputes(id)).appealDeadline+1n);await f.market.pause();await time.increase(1000);
  await expect(f.market.connect(f.creator).appeal(id)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  const before=await f.token.balanceOf(f.provider.address);await f.market.connect(f.creator).finalizeDispute(id);
  expect((await f.market.jobs(id)).status).to.equal(5n);expect((await f.market.disputes(id)).phase).to.equal(4n);expect(await f.token.balanceOf(f.provider.address)).to.be.greaterThan(before);
  await dutiesZero(f,c);for(const a of c)expect((await f.market.verifiers(a)).reserved).to.equal(0n);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);
  expect(await f.market.paused()).to.equal(true);
 });
 it("PAUSE/JURY FIX + PAUSE/SATURATION FIX: new activity stays blocked while paused (create, assign, cancel, challenge, appeal); unexpired finalizeJob refused",async function(){
  const f=await fixture(),open=await job(f,false),done=await job(f),{id}=await decided(f);await f.market.pause(); // the pause check comes first, whatever the windows
  await expect(f.market.connect(f.creator).createJob(S("100"),3600,"x")).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  const fresh=await f.market.nextJobId();
  await expect(f.market.connect(f.provider).assignJob(open)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  // PAUSE/SATURATION FIX: finalizeJob is not paused by the flag; its challenge window was still open before the pause -> TooEarly.
  await expect(f.market.finalizeJob(done)).to.be.revertedWithCustomError(f.market,"TooEarly");
  await expect(f.market.connect(f.creator).cancelJob(open)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market,"EnforcedPause"); // pause check first
  await expect(f.market.connect(f.creator).challengeJob(done,ethers.id("p"))).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  await expect(f.market.connect(f.creator).appeal(id)).to.be.revertedWithCustomError(f.market,"EnforcedPause");
  expect(await f.market.nextJobId()).to.equal(fresh);
 });
 it("POLICY UPDATE: missing appeal jurors retain the pause-aware Draw deadline and never default-settle",async function(){
  // PAUSE/JURY FIX: the missing juror leaves BEFORE the appeal freeze (a frozen candidate can no longer leave after it).
  const f=await fixture(),{id,c}=await decided(f);const leaving=f.vs.find(a=>!c.includes(a.address));await f.market.connect(leaving).exitVerifier();await pausedSpan(f,1000);await f.market.connect(f.creator).appeal(id);
  const deadline=await f.market.effectiveProtectedDeadline(id);
  await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,"NotEnoughVerifiers");
  expect((await f.market.disputes(id)).round).to.equal(1n);expect(await f.market.effectiveProtectedDeadline(id)).to.equal(deadline);
  await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,"TooEarly");await time.increaseTo(deadline+1n);await f.market.resolveStale(id);
  await expect(f.market.finalizeDispute(id)).to.be.revertedWithCustomError(f.market,"InvalidState");
  await f.market.connect(f.arbiter).arbitrate(id,true);await dutiesZero(f,c);
 });
});
