// Staking reward dust: reproduction on the frozen BEFORE copy, then proof on the fixed contract.
// LOCAL ONLY (Hardhat 31337). Amounts in wei of SUPER (1 SUPER = 1e18 wei).
const {expect}=require('chai');const {ethers}=require('hardhat');const {time}=require('@nomicfoundation/hardhat-network-helpers');const fs=require('fs');
const S=x=>ethers.parseEther(String(x)),P=10n**18n,evidence={};
const fmt=w=>ethers.formatEther(w)+' SUPER ('+w.toString()+' wei)';
async function deploy(name){
 const [admin,...xs]=await ethers.getSigners();const token=await(await ethers.getContractFactory('SuperionToken')).deploy(admin.address);
 const staking=await(await ethers.getContractFactory(name)).deploy(await token.getAddress(),admin.address,60);
 await token.approve(await staking.getAddress(),ethers.MaxUint256);await staking.grantRole(await staking.OPERATOR_ROLE(),admin.address);
 const actors=xs.slice(0,4);for(const a of actors){await token.transfer(a.address,S('1000000'));await token.connect(a).approve(await staking.getAddress(),ethers.MaxUint256);}
 return {admin,actors,token,staking};
}
async function backing(f){
 const st=f.staking,addr=await st.getAddress();
 expect(await f.token.balanceOf(addr)).to.equal(await st.totalSupply()+await st.totalUnbonding()+await st.totalRewardsOwed()+await st.queuedRewards());
 let e=0n;for(const a of f.actors)e+=await st.earned(a.address);expect(e).to.be.at.most(await st.totalRewardsOwed());
}
async function claimIf(f,a){if(BigInt(await time.latest())>=await f.staking.rewardEligibleAt(a.address)){const b=await f.token.balanceOf(a.address);await f.staking.connect(a).claimRewards();return (await f.token.balanceOf(a.address))-b;}return 0n;}
// odd balances so that per-account division is never exact
const BAL=[S('333.333333333333333333'),S('1000.000000000000000007'),S('1234.567890123456789012'),S('77.777777777777777777')];

async function scenarioFrequentClaims(name,deposits=120){
 const f=await deploy(name);for(let i=0;i<4;i++)await f.staking.connect(f.actors[i]).stake(BAL[i]);await time.increase(61);
 const paid=[0n,0n,0n,0n],exactScaled=[0n,0n,0n,0n];let totalIn=0n;
 for(let k=0;k<deposits;k++){
  const before=await f.staking.rewardPerTokenStored();const amt=S('15')+BigInt(k)*7n; // ~15 SUPER = 1.5% stakers' share of a 1000-SUPER mission
  await f.staking.depositRewards(amt);totalIn+=amt;const inc=(await f.staking.rewardPerTokenStored())-before;
  for(let i=0;i<4;i++){exactScaled[i]+=BAL[i]*inc;paid[i]+=await claimIf(f,f.actors[i]);}
  if(k%20===0)await backing(f);
 }
 await backing(f);
 const owed=await f.staking.totalRewardsOwed(),queued=await f.staking.queuedRewards();let left=0n;for(const a of f.actors)left+=await f.staking.earned(a.address);
 return {f,paid,exactScaled,owed,queued,claimableLeft:left,stuck:owed-left,totalIn};
}

describe('Staking reward dust: BEFORE (frozen copy) vs FIXED (per-account remainder carry) — LOCAL ONLY',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/staking-dust-evidence.json',JSON.stringify({warning:'LOCAL PROTOTYPE ONLY, not an audit, nothing deployed. VRF stays simulated elsewhere in the suite.',...evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('S1 frequent claims, 4 odd balances, 120 deposits of ~15 SUPER: BEFORE strands per-claim fractions; FIXED pays each account exactly floor(own exact entitlement)',async()=>{
  const b=await scenarioFrequentClaims('SuperionStakingV2Before'),a=await scenarioFrequentClaims('SuperionStakingV2');
  expect(b.claimableLeft).to.equal(0n);expect(b.stuck).to.be.greaterThan(100n); // reproduction: wei stuck, owed to nobody claimable
  for(let i=0;i<4;i++){
   const exactFloor=a.exactScaled[i]/P;
   expect(a.paid[i]+await a.f.staking.earned(a.f.actors[i].address)).to.equal(exactFloor); // never more than entitled, nothing lost
   expect(a.paid[i]).to.be.at.least(b.paid[i]);expect(await a.f.staking.rewardRemainder(a.f.actors[i].address)).to.be.lessThan(P);
  }
  expect(a.stuck).to.be.lessThan(b.stuck);expect(a.stuck).to.be.at.most(120n+4n); // <=1 wei per deposit (ceil reserve) + <1 wei per account
  evidence.S1={deposits:120,totalDeposited:fmt(b.totalIn),before:{stuckAfterAllClaims:fmt(b.stuck),paid:b.paid},fixed:{stuckAfterAllClaims:fmt(a.stuck),paid:a.paid},
   explanation:'BEFORE: each claim floors the account share and drops the fraction (<1 wei per account per claim). FIXED: the fraction is carried per account.'};
 });

 it('S2 cross-account fraction (stakes 3 wei / 7 wei, deposit 1 wei): 1 wei stays reserved in BOTH versions — distributing it would need an economic choice',async()=>{
  const out={};
  for(const name of ['SuperionStakingV2Before','SuperionStakingV2']){
   const f=await deploy(name),[a,b,c]=f.actors;await f.staking.connect(a).stake(3n);await f.staking.connect(b).stake(7n);await time.increase(61);await f.staking.depositRewards(1n);
   await f.staking.connect(a).requestUnstake(3n);await f.staking.connect(b).requestUnstake(7n);await time.increase(7*86400);await f.staking.connect(a).completeUnstake();await f.staking.connect(b).completeUnstake();
   await f.staking.connect(c).stake(10n);await time.increase(61);
   expect(await f.staking.totalSupply()).to.equal(10n);expect(await f.staking.totalRewardsOwed()).to.equal(1n);for(const x of[a,b,c])expect(await f.staking.earned(x.address)).to.equal(0n);await backing(f);
   out[name]={reservedWei:1n,claimableWei:0n};
   if(name==='SuperionStakingV2'){expect(await f.staking.rewardRemainder(a.address)).to.equal(3n*10n**17n);expect(await f.staking.rewardRemainder(b.address)).to.equal(7n*10n**17n);}
  }
  evidence.S2={...out,note:'A holds 0.3 wei, B 0.7 wei of the same 1 wei; neither reaches 1 wei. Who gets it is a choice (largest remainder? treasury? next cycle?). Size: 1e-18 SUPER.'};
 });

 it('S3 ceiling over-reservation: single staker of 3 wei, three 1-wei deposits: 1 wei over-reserved in both (<=1 wei per deposit, owed to nobody)',async()=>{
  const res={};
  for(const name of ['SuperionStakingV2Before','SuperionStakingV2']){
   const f=await deploy(name),a=f.actors[0];await f.staking.connect(a).stake(3n);await time.increase(61);for(let i=0;i<3;i++)await f.staking.depositRewards(1n);
   const got=await claimIf(f,a);res[name]={claimedWei:got,leftReserved:await f.staking.totalRewardsOwed()};await backing(f);
  }
  expect(res.SuperionStakingV2Before.claimedWei).to.equal(2n);expect(res.SuperionStakingV2.claimedWei).to.equal(2n);
  expect(res.SuperionStakingV2.leftReserved).to.equal(1n);evidence.S3={...res,exactEntitlement:'3*floor(1e18/3)*3/1e18 = 2.999999999999999997 wei'};
 });

 for(const action of ['restake','requestUnstake','slash'])it(`S4 eligibility delay (${action}): realistic 4.5 SUPER: BEFORE stuck forever in the reserve; FIXED requeues it for the next deposit (approved rule)`,async()=>{
  const out={};
  for(const name of ['SuperionStakingV2Before','SuperionStakingV2']){
   const f=await deploy(name),[a,b,c]=f.actors;await f.staking.connect(b).stake(S('700'));await time.increase(61);
   await f.staking.connect(a).stake(S('300'));                    // A is inside its eligibility delay
   await f.staking.depositRewards(S('15'));                         // stakers' 1.5% of a 1000-SUPER mission
   if(action==='restake')await f.staking.connect(a).stake(1n);
   if(action==='requestUnstake')await f.staking.connect(a).requestUnstake(S('1'));
   if(action==='slash'){await f.staking.lock(a.address,S('1'));await f.staking.slash(a.address,S('1'));}
   await time.increase(61);const ga=await claimIf(f,a),gb=await claimIf(f,b);
   expect(ga).to.equal(0n);expect(gb).to.equal(S('10.5'));
   // everyone leaves, a newcomer arrives: the 4.5 SUPER can be claimed by nobody
   for(const x of[a,b]){const av=await f.staking.availableStake(x.address);if(av>0n)await f.staking.connect(x).requestUnstake(av);}
   await f.staking.connect(c).stake(S('10'));await time.increase(61);expect(await f.staking.earned(c.address)).to.equal(0n);
   // REQUEUE STEP: BEFORE keeps 4.5 SUPER stuck in the reserve; FIXED moves it to the existing queue (next deposit).
   if(name==='SuperionStakingV2Before'){expect(await f.staking.totalRewardsOwed()).to.equal(S('4.5'));expect(await f.staking.queuedRewards()).to.equal(0n);}
   else{expect(await f.staking.totalRewardsOwed()).to.equal(0n);expect(await f.staking.queuedRewards()).to.equal(S('4.5'));expect(await f.staking.cooldownForfeitedScaled()).to.equal(S('4.5')*P);}
   await backing(f);
   out[name]={claimedByA:ga,claimedByB:gb,stuckInReserve:fmt(await f.staking.totalRewardsOwed()),queuedForNextDeposit:fmt(await f.staking.queuedRewards())};
  }
  evidence['S4-'+action]=out;
 });

 it('S4 passive control: the same A who does NOT interact during the delay receives its 4.5 SUPER (existing policy unchanged)',async()=>{
  const f=await deploy('SuperionStakingV2'),[a,b]=f.actors;await f.staking.connect(b).stake(S('700'));await time.increase(61);await f.staking.connect(a).stake(S('300'));await f.staking.depositRewards(S('15'));
  await time.increase(61);expect(await claimIf(f,a)).to.equal(S('4.5'));expect(await claimIf(f,b)).to.equal(S('10.5'));expect(await f.staking.totalRewardsOwed()).to.equal(0n);expect(await f.staking.cooldownForfeitedScaled()).to.equal(0n);
 });

 it('FIXED: forfeiting during the delay never changes earned() of anyone else; tokens held stay identical (reserve -> queue only)',async()=>{
  const f=await deploy('SuperionStakingV2'),[a,b]=f.actors;await f.staking.connect(b).stake(S('700'));await time.increase(61);await f.staking.connect(a).stake(S('300'));await f.staking.depositRewards(S('15'));
  const bal=await f.token.balanceOf(await f.staking.getAddress()),owed=await f.staking.totalRewardsOwed(),eb=await f.staking.earned(b.address);
  const q=await f.staking.queuedRewards();await f.staking.connect(a).stake(1n);expect(await f.token.balanceOf(await f.staking.getAddress())).to.equal(bal+1n);
  expect(await f.staking.totalRewardsOwed()+await f.staking.queuedRewards()).to.equal(owed+q);expect(await f.staking.queuedRewards()).to.equal(q+S('4.5'));expect(await f.staking.earned(b.address)).to.equal(eb);
 });

 for(const seed of [3,11,42,777,2026,9001])it('fuzz seed '+seed+': FIXED stays solvent, never pays above the reserve, and strands no more than BEFORE on the same sequence',async()=>{
  const runs={};
  for(const name of ['SuperionStakingV2Before','SuperionStakingV2']){
   const f=await deploy(name);let st=seed>>>0;const rnd=n=>{st=(Math.imul(st,1664525)+1013904223)>>>0;return st%n;};let paid=0n,dep=0n;
   for(let i=0;i<4;i++)await f.staking.connect(f.actors[i]).stake(BigInt(1+rnd(1000))*P+BigInt(rnd(1e9)));await time.increase(61);
   for(let i=0;i<60;i++){
    const a=f.actors[rnd(4)],op=rnd(6);
    if(op<=1){const amt=BigInt(1+rnd(20))*P+BigInt(rnd(1e9));await f.staking.depositRewards(amt);dep+=amt;}
    else if(op===2)paid+=await claimIf(f,a);
    else if(op===3){await f.staking.connect(a).stake(BigInt(1+rnd(5))*P+BigInt(rnd(1000)));if(rnd(2))await time.increase(61);}
    else if(op===4){const av=await f.staking.availableStake(a.address);if(av>0n)await f.staking.connect(a).requestUnstake(av/3n||1n);}
    else await time.increase(61);
    await backing(f);
   }
   await time.increase(61);for(const a of f.actors)paid+=await claimIf(f,a);await backing(f);
   expect(paid).to.be.at.most(dep);runs[name]={paid,stuck:await f.staking.totalRewardsOwed(),queued:await f.staking.queuedRewards()};
  }
  expect(runs.SuperionStakingV2.paid).to.be.at.least(runs.SuperionStakingV2Before.paid);
  expect(runs.SuperionStakingV2.stuck).to.be.at.most(runs.SuperionStakingV2Before.stuck);
  // conservation: same deposits, same principal => (reserve + queue + paid) identical in both versions
  expect(runs.SuperionStakingV2.stuck+runs.SuperionStakingV2.queued+runs.SuperionStakingV2.paid).to.equal(runs.SuperionStakingV2Before.stuck+runs.SuperionStakingV2Before.queued+runs.SuperionStakingV2Before.paid);
  expect(runs.SuperionStakingV2.queued).to.be.at.least(runs.SuperionStakingV2Before.queued);
  (evidence.fuzz??=[]).push({seed,...runs});
 });
});
