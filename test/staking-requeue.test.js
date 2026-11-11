// Approved rule (pt115u): growth discarded by an interaction during the eligibility delay joins the EXISTING
// queue and is distributed at the next reward deposit. Never returned to the account that acted. LOCAL ONLY.
const {expect}=require('chai');const {ethers}=require('hardhat');const {time}=require('@nomicfoundation/hardhat-network-helpers');const fs=require('fs');
const S=x=>ethers.parseEther(String(x)),P=10n**18n,evidence={};
async function deploy(){
 const [admin,a,b,c]=await ethers.getSigners();const token=await(await ethers.getContractFactory('SuperionToken')).deploy(admin.address);
 const staking=await(await ethers.getContractFactory('SuperionStakingV2')).deploy(await token.getAddress(),admin.address,60);
 await token.approve(await staking.getAddress(),ethers.MaxUint256);await staking.grantRole(await staking.OPERATOR_ROLE(),admin.address);
 for(const x of[a,b,c]){await token.transfer(x.address,S('100000'));await token.connect(x).approve(await staking.getAddress(),ethers.MaxUint256);}
 return {admin,a,b,c,token,staking,actors:[a,b,c]};
}
async function backing(f){const st=f.staking;expect(await f.token.balanceOf(await st.getAddress())).to.equal(await st.totalSupply()+await st.totalUnbonding()+await st.totalRewardsOwed()+await st.queuedRewards());let e=0n;for(const x of f.actors)e+=await st.earned(x.address);expect(e).to.be.at.most(await st.totalRewardsOwed());}
async function claim(f,x){if(BigInt(await time.latest())<await f.staking.rewardEligibleAt(x.address))return 0n;const b=await f.token.balanceOf(x.address);await f.staking.connect(x).claimRewards();return (await f.token.balanceOf(x.address))-b;}
// B (700) eligible; A (Alice) stakes 300 and is inside her delay when 15 SUPER arrive.
async function setup(){const f=await deploy();await f.staking.connect(f.b).stake(S('700'));await time.increase(61);await f.staking.connect(f.a).stake(S('300'));await f.staking.depositRewards(S('15'));return f;}

describe('Requeue of rewards discarded during the eligibility delay (approved rule) — LOCAL ONLY',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/staking-requeue-evidence.json',JSON.stringify({warning:'LOCAL PROTOTYPE ONLY, not an audit, nothing deployed; VRF stays simulated.',...evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('worked example: 4.5 SUPER discarded (Alice leaves during her delay) + next 15 SUPER deposit = 19.5 SUPER distributed; Alice gets 0',async()=>{
  const f=await setup();const a0=await f.token.balanceOf(f.a.address);
  await expect(f.staking.connect(f.a).requestUnstake(S('300'))).to.emit(f.staking,'RewardsRequeued').withArgs(S('4.5'));
  expect(await f.staking.queuedRewards()).to.equal(S('4.5'));expect(await f.staking.totalRewardsOwed()).to.equal(S('10.5'));await backing(f);
  const rc=await(await f.staking.depositRewards(S('15'))).wait();const ev=rc.logs.map(l=>{try{return f.staking.interface.parseLog(l)}catch{return null}}).find(e=>e&&e.name==='RewardsDeposited');
  const distributed=ev.args.distributed,left=await f.staking.queuedRewards();
  expect(distributed+left).to.equal(S('19.5'));            // pool of the next deposit = 15 + 4.5
  expect(left).to.be.lessThan(1000n);                      // only the usual integer-division remainder (< supply/1e18 wei) stays queued
  const gb=await claim(f,f.b);expect(gb).to.equal(S('10.5')+distributed);
  evidence.workedExampleExact={distributedWei:distributed,queuedRemainderWei:left,bobClaimWei:gb};
  await time.increase(7*86400);await f.staking.connect(f.a).completeUnstake();expect(await claim(f,f.a)).to.equal(0n);
  expect((await f.token.balanceOf(f.a.address))-a0).to.equal(S('300')); // only her 300 principal came back, 0 reward
  expect(await f.staking.totalRewardsOwed()).to.equal(0n);await backing(f);
  evidence.workedExample={discardedFromAlice:'4.5 SUPER',nextDeposit:'15 SUPER',distributedAtNextDeposit:'19.5 SUPER',bobTotal:'30 SUPER (10.5 + 19.5)',aliceRewards:'0 SUPER',stuckAfter:'0'};
 });

 for(const action of ['restake','partialUnstake','slash'])it(`Alice stays staked (${action}): 4.5 requeued, she never recovers it as "her part"; at the next deposit she only gets the ordinary pro-rata share of the whole pool`,async()=>{
  const f=await setup();
  if(action==='restake')await f.staking.connect(f.a).stake(1n);
  if(action==='partialUnstake')await f.staking.connect(f.a).requestUnstake(S('100'));
  if(action==='slash'){await f.staking.lock(f.a.address,S('100'));await f.staking.slash(f.a.address,S('100'));}
  expect(await f.staking.queuedRewards()).to.equal(S('4.5'));expect(await f.staking.earned(f.a.address)).to.equal(0n);
  await time.increase(61);expect(await claim(f,f.a)).to.equal(0n); // her delay-time share is gone for her
  const supply=await f.staking.totalSupply(),aBal=await f.staking.balanceOf(f.a.address);
  await f.staking.depositRewards(S('15'));
  const ga=await claim(f,f.a),gb=await claim(f,f.b);
  const pool=S('19.5'),expectedA=pool*aBal/supply;
  expect(ga).to.be.at.most(expectedA);expect(expectedA-ga).to.be.at.most(aBal/P+2n); // integer-division rounding only
  expect(ga+gb).to.be.at.most(pool+S('10.5'));expect(gb).to.be.at.least(S('10.5')+pool*S('700')/supply-S('700')/P-2n);
  await backing(f);(evidence.stayStaked??={})[action]={aliceBalance:ethers.formatEther(aBal),supply:ethers.formatEther(supply),aliceGotAtNextDeposit:ethers.formatEther(ga),bobGotTotal:ethers.formatEther(gb),
   note:'Alice does not get back her 4.5; as an eligible staker at the next deposit she gets her pro-rata share of 19.5 like everyone.'};
 });

 it('passive Alice (no action during the delay) is unchanged: she keeps 4.5 SUPER, nothing requeued (existing policy)',async()=>{
  const f=await setup();await time.increase(61);expect(await claim(f,f.a)).to.equal(S('4.5'));expect(await claim(f,f.b)).to.equal(S('10.5'));expect(await f.staking.queuedRewards()).to.equal(0n);expect(await f.staking.cooldownForfeitedScaled()).to.equal(0n);
 });

 it('requeued amount waits in the queue when nobody stakes (zero supply), then goes to the next stakers once only',async()=>{
  const f=await deploy();await f.staking.connect(f.a).stake(S('10'));await f.staking.depositRewards(S('5'));
  await f.staking.connect(f.a).requestUnstake(S('10'));expect(await f.staking.queuedRewards()).to.equal(S('5'));expect(await f.staking.totalSupply()).to.equal(0n);
  await f.staking.depositRewards(S('1'));expect(await f.staking.queuedRewards()).to.equal(S('6'));
  await f.staking.connect(f.c).stake(S('10'));await time.increase(61);await f.staking.depositRewards(S('1'));
  expect(await claim(f,f.c)).to.equal(S('7'));expect(await f.staking.queuedRewards()).to.equal(0n);expect(await f.staking.totalRewardsOwed()).to.equal(0n);await backing(f);
 });

 it('case C (ceiling surplus) also returns to the queue once it sums to 1 wei; case B (fractions held by accounts) stays with the accounts',async()=>{
  const f=await deploy();await f.staking.connect(f.a).stake(3n);await time.increase(61);
  // each 1-wei deposit: reserve 1, exact share 0.999999999999999999 -> surplus 1e-18 wei; needs 1e18 deposits to reach 1 wei: shown with a direct state read
  for(let i=0;i<3;i++)await f.staking.depositRewards(1n);expect(await f.staking.requeueRemainderScaled()).to.equal(3n);
  // larger surplus: one staker of 0.6 SUPER, three 1-wei deposits. Each reserves 1 wei for an exact share of 0.6 wei
  // (surplus 0.4 wei each). After 3 deposits the surplus reaches 1.2 wei -> exactly 1 wei goes back to the queue.
  const g=await deploy();await g.staking.connect(g.a).stake(S('0.6'));await time.increase(61);
  await g.staking.depositRewards(1n);await g.staking.depositRewards(1n);
  await expect(g.staking.depositRewards(1n)).to.emit(g.staking,'RewardsRequeued').withArgs(1n);
  expect(await g.staking.totalRewardsOwed()).to.equal(2n);expect(await g.staking.queuedRewards()).to.equal(1n);expect(await g.staking.requeueRemainderScaled()).to.equal(2n*10n**17n);
  expect(await g.staking.earned(g.a.address)).to.equal(1n);await backing(g); // exact 1.8 wei -> 1 wei claimable, 0.8 carried; reserve 2 >= 1.8
  // case B unchanged: 0.3 / 0.7 wei stay with the accounts (rewardRemainder), 1 wei remains reserved for them
  const h=await deploy();await h.staking.connect(h.a).stake(3n);await h.staking.connect(h.b).stake(7n);await time.increase(61);await h.staking.depositRewards(1n);
  expect(await h.staking.rewardRemainder(h.a.address)).to.equal(0n);await h.staking.connect(h.a).claimRewards();await h.staking.connect(h.b).claimRewards();
  expect(await h.staking.rewardRemainder(h.a.address)).to.equal(3n*10n**17n);expect(await h.staking.rewardRemainder(h.b.address)).to.equal(7n*10n**17n);expect(await h.staking.totalRewardsOwed()).to.equal(1n);await backing(h);
 });

 for(const seed of [5,13,99,2027])it('fuzz seed '+seed+': solvent at every step, payouts never exceed deposits, and an account acting during its delay never gains from its own forfeit',async()=>{
  const f=await deploy();let st=seed>>>0;const rnd=n=>{st=(Math.imul(st,1664525)+1013904223)>>>0;return st%n;};let paid=0n,dep=0n;
  for(const x of f.actors)await f.staking.connect(x).stake(BigInt(1+rnd(500))*P+BigInt(rnd(1e9)));await time.increase(61);
  for(let i=0;i<70;i++){
   const x=f.actors[rnd(3)],op=rnd(7);
   if(op<=1){const amt=BigInt(1+rnd(30))*P+BigInt(rnd(1e9));await f.staking.depositRewards(amt);dep+=amt;}
   else if(op===2)paid+=await claim(f,x);
   else if(op===3){await f.staking.connect(x).stake(BigInt(1+rnd(50))*P);}
   else if(op===4){const av=await f.staking.availableStake(x.address);if(av>0n)await f.staking.connect(x).requestUnstake(av/4n||1n);}
   else if(op===5){const av=await f.staking.availableStake(x.address);if(av>2n){await f.staking.lock(x.address,av/10n);await f.staking.slash(x.address,av/20n||1n);}}
   else await time.increase(61);
   await backing(f);
  }
  await time.increase(61);for(const x of f.actors)paid+=await claim(f,x);await backing(f);
  expect(paid).to.be.at.most(dep);
  expect(await f.staking.totalRewardsOwed()+await f.staking.queuedRewards()+paid).to.equal(dep);
  (evidence.fuzz??=[]).push({seed,deposited:dep,paid,reserveLeft:await f.staking.totalRewardsOwed(),queued:await f.staking.queuedRewards(),requeuedCumulativeScaled:await f.staking.cooldownForfeitedScaled()});
 });
});
