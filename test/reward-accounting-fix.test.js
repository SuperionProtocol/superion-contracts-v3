const {expect}=require("chai");
const {ethers}=require("hardhat");
const {time}=require("@nomicfoundation/hardhat-network-helpers");
const P=10n**18n;
async function fixture(){
 const [admin,...actors]=await ethers.getSigners();
 const token=await(await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
 const staking=await(await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(),admin.address,60);
 await token.approve(await staking.getAddress(),ethers.MaxUint256);
 await staking.grantRole(await staking.OPERATOR_ROLE(),admin.address);
 for(const a of actors.slice(0,4)){
  await token.transfer(a.address,10n**24n);
  await token.connect(a).approve(await staking.getAddress(),ethers.MaxUint256);
 }
 return {admin,actors:actors.slice(0,4),token,staking};
}
async function backing(f){
 const supply=await f.staking.totalSupply(),unbond=await f.staking.totalUnbonding(),owed=await f.staking.totalRewardsOwed(),queued=await f.staking.queuedRewards();
 expect(await f.token.balanceOf(await f.staking.getAddress())).to.equal(supply+unbond+owed+queued);
 let earned=0n;for(const a of f.actors)earned+=await f.staking.earned(a.address);
 expect(earned).to.be.at.most(owed);
}
async function claim(f,a){
 if(BigInt(await time.latest())<await f.staking.rewardEligibleAt(a.address))return;
 const earned=await f.staking.earned(a.address),before=await f.token.balanceOf(a.address);
 await f.staking.connect(a).claimRewards();
 expect((await f.token.balanceOf(a.address))-before).to.equal(earned);
 await backing(f);
}
describe("Reward-accounting correction: funding, claims, transitions and dust",function(){
 it("queued funds with zero supply are distributed once when supply becomes available",async function(){
  const f=await fixture(),a=f.actors[0];await f.staking.depositRewards(1n);await f.staking.depositRewards(1n);
  expect(await f.staking.queuedRewards()).to.equal(2n);expect(await f.staking.totalRewardsOwed()).to.equal(0n);
  await f.staking.connect(a).stake(3n);await time.increase(61);await f.staking.depositRewards(1n);
  expect(await f.staking.earned(a.address)).to.equal(3n);expect(await f.staking.queuedRewards()).to.equal(0n);
  await claim(f,a);expect(await f.staking.totalRewardsOwed()).to.equal(0n);
 });
 it("zero RPT increments retain whole tokens in queue until an increment is representable",async function(){
  const f=await fixture(),a=f.actors[0];await f.staking.connect(a).stake(3n*P);await time.increase(61);
  for(let i=1n;i<=2n;i++){await f.staking.depositRewards(1n);expect(await f.staking.queuedRewards()).to.equal(i);expect(await f.staking.totalRewardsOwed()).to.equal(0n);await backing(f);}
  await f.staking.depositRewards(1n);expect(await f.staking.earned(a.address)).to.equal(3n);await claim(f,a);
 });
 for(const reverse of [false,true])it("proportional exact payouts are independent of claim order: reverse="+reverse,async function(){
  const f=await fixture(),[a,b]=f.actors;await f.staking.connect(a).stake(2n);await f.staking.connect(b).stake(3n);await time.increase(61);
  const a0=await f.token.balanceOf(a.address),b0=await f.token.balanceOf(b.address);
  for(const pool of [20n,15n]){await f.staking.depositRewards(pool);for(const s of reverse?[b,a]:[a,b])await claim(f,s);}
  expect((await f.token.balanceOf(a.address))-a0).to.equal(14n);expect((await f.token.balanceOf(b.address))-b0).to.equal(21n);
  expect(await f.staking.totalRewardsOwed()).to.equal(0n);
 });
 it("an eligible account keeps previously earned integer rewards through a re-stake eligibility reset",async function(){
  const f=await fixture(),a=f.actors[0];await f.staking.connect(a).stake(3n);await time.increase(61);await f.staking.depositRewards(3n);
  await f.staking.connect(a).stake(2n);expect(await f.staking.rewards(a.address)).to.equal(3n);
  await expect(f.staking.connect(a).claimRewards()).to.be.revertedWithCustomError(f.staking,"RewardsNotEligible");
  await time.increase(61);expect(await f.staking.earned(a.address)).to.equal(3n);await claim(f,a);
 });
 it("stake/unbond/slash transitions preserve backing and already accrued rewards",async function(){
  const f=await fixture(),[a,b]=f.actors;await f.staking.connect(a).stake(10n);await f.staking.connect(b).stake(10n);await time.increase(61);
  await f.staking.depositRewards(20n);await f.staking.connect(a).requestUnstake(4n);await backing(f);
  expect(await f.staking.rewards(a.address)).to.equal(10n);
  await f.staking.lock(b.address,5n);await f.staking.slash(b.address,2n);await backing(f);
  await f.staking.depositRewards(14n);await claim(f,a);await claim(f,b);
  await time.increase(7*24*3600+1);await f.staking.connect(a).completeUnstake();await backing(f);
 });
 it("zero supply after full unstake retains old claims, and newly queued funds are not double counted",async function(){
  const f=await fixture(),[a,b]=f.actors;await f.staking.connect(a).stake(5n);await time.increase(61);await f.staking.depositRewards(5n);
  await f.staking.connect(a).requestUnstake(5n);await backing(f);await f.staking.depositRewards(7n);
  expect(await f.staking.queuedRewards()).to.equal(7n);await claim(f,a);
  await f.staking.connect(b).stake(4n);await time.increase(61);await f.staking.depositRewards(1n);
  expect(await f.staking.earned(b.address)).to.equal(8n);await claim(f,b);
 });
 // DUST FIX STEP: the old assertion (5 wei stuck forever) is kept below against the frozen BEFORE copy;
 // the fixed contract now pays each account its own carried fractions (A 2 wei, B 3 wei), nothing stuck.
 it("BEFORE (frozen copy): account-level fractional dust stayed stuck; zero-valued claims did not make it withdrawable",async function(){
  const f=await fixture(),[a,b]=f.actors;f.staking=await(await ethers.getContractFactory("SuperionStakingV2Before")).deploy(await f.token.getAddress(),f.admin.address,60);
  await f.token.approve(await f.staking.getAddress(),ethers.MaxUint256);for(const x of[a,b])await f.token.connect(x).approve(await f.staking.getAddress(),ethers.MaxUint256);
  await f.staking.connect(a).stake(2n);await f.staking.connect(b).stake(3n);await time.increase(61);
  for(let i=0;i<5;i++){await f.staking.depositRewards(1n);await claim(f,a);await claim(f,b);}
  expect(await f.staking.earned(a.address)).to.equal(0n);expect(await f.staking.earned(b.address)).to.equal(0n);
  expect(await f.staking.totalRewardsOwed()).to.equal(5n);expect(await f.staking.queuedRewards()).to.equal(0n);
 });
 it("FIXED: the same sequence pays each account its own carried fractions (A 2 wei, B 3 wei); nothing left reserved",async function(){
  const f=await fixture(),[a,b]=f.actors;await f.staking.connect(a).stake(2n);await f.staking.connect(b).stake(3n);await time.increase(61);
  const a0=await f.token.balanceOf(a.address),b0=await f.token.balanceOf(b.address);
  for(let i=0;i<5;i++){await f.staking.depositRewards(1n);await claim(f,a);await claim(f,b);}
  expect((await f.token.balanceOf(a.address))-a0).to.equal(2n);expect((await f.token.balanceOf(b.address))-b0).to.equal(3n);
  expect(await f.staking.totalRewardsOwed()).to.equal(0n);expect(await f.staking.queuedRewards()).to.equal(0n);
 });
 it("retains existing silent-cooldown behavior: deposits can accrue after eligibility without an intervening interaction",async function(){
  const f=await fixture(),a=f.actors[0];await f.staking.connect(a).stake(5n);await f.staking.depositRewards(5n);
  expect(await f.staking.earned(a.address)).to.equal(0n);
  await expect(f.staking.connect(a).claimRewards()).to.be.revertedWithCustomError(f.staking,"RewardsNotEligible");
  await time.increase(61);expect(await f.staking.earned(a.address)).to.equal(5n);await claim(f,a);
 });
 // REQUEUE STEP (approved): the discarded growth no longer stays reserved forever; it joins the queue for the next deposit.
 it("interacting-cooldown: unbond interaction still discards the account's cooldown growth; it is requeued (not stuck) and stays solvent",async function(){
  const f=await fixture(),a=f.actors[0];await f.staking.connect(a).stake(5n);await f.staking.depositRewards(5n);
  await f.staking.connect(a).requestUnstake(1n);await time.increase(61);
  expect(await f.staking.earned(a.address)).to.equal(0n);expect(await f.staking.totalRewardsOwed()).to.equal(0n);expect(await f.staking.queuedRewards()).to.equal(5n);await backing(f);
  await f.staking.depositRewards(4n);expect(await f.staking.earned(a.address)).to.equal(9n);await claim(f,a);
 });
 it("normal 18-decimal holdings receive exact funded proportional rewards when division is exact",async function(){
  const f=await fixture(),[a,b]=f.actors;await f.staking.connect(a).stake(1000n*P);await f.staking.connect(b).stake(3000n*P);await time.increase(61);
  await f.staking.depositRewards(400n*P);
  expect(await f.staking.earned(a.address)).to.equal(100n*P);expect(await f.staking.earned(b.address)).to.equal(300n*P);
  await claim(f,b);await claim(f,a);expect(await f.staking.totalRewardsOwed()).to.equal(0n);
 });
 for(const seed of [1,7,29,101,2026,65537])it("deterministic mixed-operation funding invariant, seed "+seed,async function(){
  const f=await fixture();let state=seed>>>0;const rnd=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  for(let i=0;i<4;i++)await f.staking.connect(f.actors[i]).stake(BigInt(1+rnd(97))*(seed%2?1n:P));
  await time.increase(61);
  for(let i=0;i<50;i++){
   const a=f.actors[rnd(4)],op=rnd(5);
   if(op<=1)await f.staking.depositRewards(BigInt(1+rnd(1000)));
   else if(op===2)await claim(f,a);
   else if(op===3){await f.staking.connect(a).stake(BigInt(1+rnd(9)));await time.increase(61);}
   else{const available=await f.staking.availableStake(a.address);if(available>0n)await f.staking.connect(a).requestUnstake(available/3n||1n);}
   await backing(f);
  }
  await time.increase(61);for(const a of f.actors)await claim(f,a);
 });
});
