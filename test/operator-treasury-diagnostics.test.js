// LOCAL DIAGNOSTICS (Hardhat 31337). Section A (operator): unchanged code, still RISK reproductions.
// Section B (treasury): UPDATED after the approved change (new 5 % split 25/15/10 on 1000 SUPER; treasury address frozen per job).
// Reproduces what the staking OPERATOR_ROLE and the marketplace treasury setting allow TODAY in the governed prototype wiring
// (admin = 48h timelock driven by the official local SafeL2 2-of-3; marketplace pause = Safe). Amounts are in SUPER.
const {expect}=require('chai');const {ethers}=require('hardhat');const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const {safeCall}=require('../helpers/local-safe.cjs');const {governedDeploy,DELAY}=require('../helpers/governed-deploy.cjs');
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require('../scripts/v3/config.cjs');const S=ethers.parseEther,F=ethers.formatEther;const fs=require('fs'),evidence=[];
async function gov(){
 const g=await governedDeploy(ethers,P),st=await g.staking.getAddress(),mk=await g.market.getAddress();
 g.rogue=g.outsider;g.alice=g.vs[8];g.bob=g.vs[9];g.newTreasury=g.relayer;
 for(const a of [g.creator,g.provider,g.challenger,...g.vs]){await g.token.transfer(a.address,S('100000'));await g.token.connect(a).approve(st,ethers.MaxUint256);await g.token.connect(a).approve(mk,ethers.MaxUint256);}
 await g.staking.connect(g.provider).stake(S('5000'));
 for(const v of g.vs.slice(0,6)){await g.staking.connect(v).stake(S('1000'));await g.market.connect(v).registerVerifier();}
 await g.staking.connect(g.alice).stake(S('5000'));await g.staking.connect(g.bob).stake(S('5000'));await time.increase(61);// pure stakers, reward-eligible
 return g;
}
let n=0;async function timelocked(g,target,data){// Safe 2-of-3 -> schedule -> must wait 48h -> execute
 const TL=await g.timelock.getAddress(),salt=ethers.id('op'+(n++)),args=[target,0,data,ethers.ZeroHash,salt];
 await safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('schedule',[...args,DELAY]),g.owners.slice(0,2),g.relayer);
 await expect(safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('execute',args),g.owners.slice(0,2),g.relayer)).to.be.reverted;
 await time.increase(DELAY);await safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('execute',args),g.owners.slice(0,2),g.relayer);
}
// PROTECTION 3 (approved): OPERATOR_ROLE can ONLY go to the official marketplace recorded in the timelock. A contract
// controlled by ONE person (TestOperatorForwarder) is now REFUSED even after the full Safe 2-of-3 + 48h path.
async function rogueContractOperatorRefused(g){
 const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.rogue)).deploy(),FW=await fw.getAddress(),SA=await g.staking.getAddress(),TL=await g.timelock.getAddress(),R=await g.staking.OPERATOR_ROLE();
 const args=[SA,0,g.staking.interface.encodeFunctionData('grantRole',[R,FW]),ethers.ZeroHash,ethers.id('fw-op'+(n++))];
 await safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('schedule',[...args,DELAY]),g.owners.slice(0,2),g.relayer);await time.increase(DELAY);
 await expect(g.timelock.connect(g.safe.runner).execute.staticCall(...args)).to.be.reverted;
 await expect(safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('execute',args),g.owners.slice(0,2),g.relayer)).to.be.revertedWith('GS013');
 expect(await g.staking.hasRole(R,FW)).to.equal(false);return FW;}
// ROLE-POWER documentation only: what OPERATOR_ROLE itself allows is shown by IMPERSONATING the official marketplace
// address in the local test chain (the only holder). No real path gives this role to anyone else any more.
async function grantRogueOperator(g){
 await rogueContractOperatorRefused(g);const M=await g.market.getAddress();
 await ethers.provider.send('hardhat_impersonateAccount',[M]);await ethers.provider.send('hardhat_setBalance',[M,'0xDE0B6B3A7640000']);
 g.rogueOp=await ethers.getSigner(M);g.rogueStaking=g.staking.connect(g.rogueOp);}
async function eoaOperatorRefused(g){
 const TL=await g.timelock.getAddress(),args=[await g.staking.getAddress(),0,g.staking.interface.encodeFunctionData('grantRole',[await g.staking.OPERATOR_ROLE(),g.rogue.address]),ethers.ZeroHash,ethers.id('eoa-op')];
 await safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('schedule',[...args,DELAY]),g.owners.slice(0,2),g.relayer);await time.increase(DELAY);
 await expect(g.timelock.connect(g.safe.runner).execute.staticCall(...args)).to.be.reverted;
 await expect(safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('execute',args),g.owners.slice(0,2),g.relayer)).to.be.revertedWith('GS013');}
async function job(g,submit=true){const id=await g.market.nextJobId();await g.market.connect(g.creator).createJob(S('1000'),3600,'diag');await g.market.connect(g.provider).assignJob(id);if(submit)await g.market.connect(g.provider).submitResult(id,'r');return id;}
async function toSafeArbitration(g,id){for(const v of g.vs.slice(0,6))if((await g.market.verifiers(v.address)).indexPlus1!==0n)await g.market.connect(v).exitVerifier();
 await g.market.connect(g.challenger).challengeJob(id,ethers.id('c'+id));await time.increaseTo((await g.market.effectiveProtectedDeadline(id))+1n);await g.market.resolveStale(id);}
const arbitrate=async(g,id,r)=>safeCall(ethers,g.safe,await g.market.getAddress(),g.market.interface.encodeFunctionData('arbitrate',[id,r]),g.owners.slice(0,2),g.relayer);
const bal=async(g,a)=>g.token.balanceOf(a.address||a);

describe('DIAGNOSTIC A: staking OPERATOR_ROLE powers (role now restricted to the official marketplace — protection 3)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/operator-treasury-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 diagnostics only; no contract changed; VRF simulated',cases:evidence},(_,v)=>typeof v==='bigint'?F(v)+' SUPER':v,2)+'\n');});
 it('inventory: only the marketplace holds OPERATOR_ROLE; staking admin = timelock; operator-only functions are exactly lock/unlock/slash; no rate/reward/recipient setter exists',async()=>{
  const g=await loadFixture(gov),R=await g.staking.OPERATOR_ROLE();
  const holders=[];for(const e of await g.staking.queryFilter(g.staking.filters.RoleGranted()))if(await g.staking.hasRole(e.args.role,e.args.account))holders.push([e.args.role===R?'OPERATOR':e.args.role===ethers.ZeroHash?'ADMIN':e.args.role,e.args.account]);
  expect(holders).to.deep.equal([['OPERATOR',await g.market.getAddress()],['ADMIN',await g.timelock.getAddress()]]);
  const writes=g.staking.interface.fragments.filter(f=>f.type==='function'&&!['view','pure'].includes(f.stateMutability)).map(f=>f.name).sort();
  expect(writes).to.deep.equal(['claimRewards','completeUnstake','delegate','delegateBySig','depositRewards','grantRole','lock','renounceRole','requestUnstake','revokeRole','slash','stake','transfer','transferFrom','unlock']);
  for(const [f,a] of [['lock',[g.alice.address,1]],['unlock',[g.alice.address,1]],['slash',[g.alice.address,1]]])await expect(g.staking.connect(g.rogue)[f](...a)).to.be.revertedWithCustomError(g.staking,'AccessControlUnauthorizedAccount').withArgs(g.rogue.address,R);
  expect(await g.staking.rewardEligibilityDelay()).to.equal(60n);expect(await g.staking.UNBONDING_PERIOD()).to.equal(7n*86400n);// immutable / constant
  evidence.push({case:'inventory',roleHolders:holders,stateChangingFunctions:writes,operatorOnly:['lock','unlock','slash'],noSetterFor:['reward rate','unbonding period','eligibility delay','slash recipient']});
 });
 it('FIXED (protection 3): no NEW operator: EOA and one-person contract refused even after Safe 2-of-3 + 48h; Safe direct refused; marketplace still the operator',async()=>{
  const g=await loadFixture(gov),R=await g.staking.OPERATOR_ROLE(),d=g.staking.interface.encodeFunctionData('grantRole',[R,g.rogue.address]);
  await expect(safeCall(ethers,g.safe,await g.staking.getAddress(),d,g.owners.slice(0,2),g.relayer)).to.be.revertedWith('GS013');
  for(const s of [g.deployer,g.owners[0]])await expect(g.staking.connect(s).grantRole(R,g.rogue.address)).to.be.revertedWithCustomError(g.staking,'AccessControlUnauthorizedAccount');
  await eoaOperatorRefused(g);expect(await g.staking.hasRole(R,g.rogue.address)).to.equal(false);
  const FW=await rogueContractOperatorRefused(g);expect(await g.staking.hasRole(R,FW)).to.equal(false);
  expect(await g.staking.hasRole(R,await g.market.getAddress())).to.equal(true);expect(await g.timelock.officialMarket()).to.equal(await g.market.getAddress());
  evidence.push({case:'protection3-one-person-contract',grantAfter48h:'REFUSED (RoleRecipientNotAllowed)',officialMarketStillOperator:true});
 });
 it('ROLE POWER (shown by impersonating the official marketplace; no other holder possible) EXAMPLE 1: once granted, an operator can lock ANY staker without consent (exit blocked) and slash the whole stake TO ITSELF',async()=>{
  const g=await loadFixture(gov);await grantRogueOperator(g);
  await g.rogueStaking.lock(g.alice.address,S('5000'));await expect(g.staking.connect(g.alice).requestUnstake(S('1'))).to.be.revertedWithCustomError(g.staking,'InsufficientUnlocked');
  const b0=await bal(g,g.rogueOp);await g.rogueStaking.slash(g.alice.address,S('5000'));
  expect(await bal(g,g.rogueOp)-b0).to.equal(S('5000'));expect(await g.staking.balanceOf(g.alice.address)).to.equal(0n);
  evidence.push({case:'seize-pure-staker',aliceStakeBefore:S('5000'),aliceStakeAfter:0n,rogueReceived:S('5000'),aliceConsentNeeded:false,note:'role power only, shown by impersonating the official marketplace; protection 3 refuses this role to any other contract'});
 });
 it('ROLE POWER (shown by impersonating the official marketplace; no other holder possible) EXAMPLE 2: an operator can UNLOCK marketplace collateral; the verifier then withdraws while the marketplace still counts the bond, and exit later reverts',async()=>{
  const g=await loadFixture(gov);await grantRogueOperator(g);const v=g.vs[0],tvb=await g.market.totalVerifierBond(),mjb=await g.market.maxJobBudget();
  await g.rogueStaking.unlock(v.address,S('1000'));await g.staking.connect(v).requestUnstake(S('1000'));
  expect((await g.market.verifiers(v.address)).bond).to.equal(S('1000'));expect(await g.market.totalVerifierBond()).to.equal(tvb);expect(await g.market.maxJobBudget()).to.equal(mjb);
  await expect(g.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(g.staking,'InsufficientLocked');
  evidence.push({case:'unlock-market-collateral',marketStillCountsBond:S('1000'),realLockedNow:0n,marketCapacityStillUsesIt:mjb,exitVerifier:'reverts InsufficientLocked',note:'drawCommittee re-checks lockedStake and would refuse this juror (no silent seating)'});
 });
 it('ROLE POWER (shown by impersonating the official marketplace; no other holder possible) EXAMPLE 3: operator cannot touch unbonding stake, accrued rewards, or other stakers balances; but slashing changes future reward shares',async()=>{
  const g=await loadFixture(gov);await grantRogueOperator(g);
  await g.staking.connect(g.alice).requestUnstake(S('2000'));await expect(g.rogueStaking.lock(g.alice.address,S('3001'))).to.be.revertedWithCustomError(g.staking,'InsufficientUnlocked');
  await g.token.approve(await g.staking.getAddress(),ethers.MaxUint256);await g.staking.depositRewards(S('130'));// total stSUPER = 5000 provider +6000 verifiers +3000 alice +5000 bob = 19000 (rewards proportional)
  const aliceEarned=await g.staking.earned(g.alice.address);
  await g.rogueStaking.lock(g.alice.address,S('3000'));await g.rogueStaking.slash(g.alice.address,S('3000'));
  expect(await g.staking.earned(g.alice.address)).to.equal(aliceEarned);// accrued rewards kept
  await g.staking.connect(g.alice).claimRewards();
  await time.increase(7*86400);await g.staking.connect(g.alice).completeUnstake();// unbonding 2000 still paid
  const bob0=await g.staking.earned(g.bob.address);await g.staking.depositRewards(S('160'));const bobGain=await g.staking.earned(g.bob.address)-bob0;// supply now 16000
  expect(bobGain).to.equal(S('50'));await expect(g.rogueStaking.slash(g.bob.address,S('1'))).to.be.revertedWithCustomError(g.staking,'InsufficientLocked');
  evidence.push({case:'limits',aliceAccruedKept:aliceEarned,unbondingPaid:S('2000'),bobShareOf160AfterAliceSlashed:bobGain,bobShareOf160IfAliceNotSlashed:'42.105... SUPER (5000/19000)',slashWithoutPriorLock:'reverts'});
 });
});

describe('DIAGNOSTIC B: marketplace treasury (approved change: new split + frozen address)',function(){
 it('who can set it: only the timelock (Safe 2-of-3 + 48h); Safe direct, deployer and owners refused; event carries only the new address',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress(),d=g.market.interface.encodeFunctionData('setTreasury',[g.newTreasury.address]);
  await expect(safeCall(ethers,g.safe,M,d,g.owners.slice(0,2),g.relayer)).to.be.revertedWith('GS013');
  for(const s of [g.deployer,g.owners[0],g.treasury])await expect(g.market.connect(s).setTreasury(s.address)).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount');
  await timelocked(g,M,d);expect(await g.market.treasury()).to.equal(g.newTreasury.address);
  const ev=(await g.market.queryFilter(g.market.filters.TreasuryUpdated())).map(e=>e.args[0]);expect(ev).to.deep.equal([g.treasury.address,g.newTreasury.address]);
 });
 it('when fees go there: only when the PROVIDER is paid (finalizeJob or provider-wins); 1000 SUPER job -> fee 50 = treasury 25 + stakers 15 + burn 10; creator-wins -> 0 (no fee at all)',async()=>{
  const g=await loadFixture(gov),t=g.treasury;
  const st=await g.staking.getAddress(),a=await job(g),t0=await bal(g,t),p0=await bal(g,g.provider),s0=await bal(g,st),sup0=await g.token.totalSupply();await time.increaseTo((await g.market.effectiveProtectedDeadline(a))+1n);await g.market.finalizeJob(a);
  expect(await bal(g,t)-t0).to.equal(S('25'));expect(await bal(g,st)-s0).to.equal(S('15'));expect(sup0-await g.token.totalSupply()).to.equal(S('10'));expect(await bal(g,g.provider)-p0).to.equal(S('950'));
  const b=await job(g),c=await job(g);for(const v of g.vs.slice(0,6))await g.market.connect(v).exitVerifier();
  for(const x of [b,c])await g.market.connect(g.challenger).challengeJob(x,ethers.id('cc'+x));
  await time.increaseTo((await g.market.effectiveProtectedDeadline(c))+1n);await g.market.resolveStale(b);await g.market.resolveStale(c);
  const t1=await bal(g,t),crb=await bal(g,g.creator),blk=await ethers.provider.getBlockNumber();await arbitrate(g,b,false);expect(await bal(g,t)).to.equal(t1);expect(await bal(g,g.creator)-crb).to.be.at.least(S('1000'));
  expect((await g.market.queryFilter(g.market.filters.TreasuryPaid(),blk+1)).length).to.equal(0);// creator-wins: budget refunded, no fee, no TreasuryPaid (provider guarantee slash follows existing rules)await arbitrate(g,c,true);expect(await bal(g,t)-t1).to.equal(S('25'));
  evidence.push({case:'fee-split-1000',fee:S('50'),treasury:S('25'),stakers:S('15'),burn:S('10'),providerPayout:S('950'),creatorWins:'creator refunded (>= 1000 incl. existing guarantee-slash rules); treasury 0; no TreasuryPaid event'});
 });
 it('zero address is accepted (constructor and setTreasury); a job created while it is zero sends its treasury share to stakers: 40 (= 15 + 25) SUPER',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress();await timelocked(g,M,g.market.interface.encodeFunctionData('setTreasury',[ethers.ZeroAddress]));expect(await g.market.treasury()).to.equal(ethers.ZeroAddress);
  const st=await g.staking.getAddress(),s0=await bal(g,st),id=await job(g);await time.increaseTo((await g.market.effectiveProtectedDeadline(id))+1n);await g.market.finalizeJob(id);
  expect((await g.market.jobs(id)).treasury).to.equal(ethers.ZeroAddress);expect(await bal(g,st)-s0).to.equal(S('40'));
  const {legacyFactory}=require('../helpers/legacy-vrf-fixture.cjs');const m0=await(await legacyFactory()).deploy(await g.token.getAddress(),await g.staking.getAddress(),await g.timelock.getAddress(),await g.safe.getAddress(),await g.safe.getAddress(),ethers.ZeroAddress,P);
  expect(await m0.treasury()).to.equal(ethers.ZeroAddress);
  evidence.push({case:'zero-treasury',stakersReceive:S('40'),insteadOf:S('15'),constructorAcceptsZero:true,setTreasuryAcceptsZero:true});
 });
 it('FIXED: mid-mission change -> the old mission (held >48h in Safe arbitration) pays its FROZEN creation-time address and share; only new missions use the new address/share',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress(),T=await g.terms.getAddress();const old=await job(g);await toSafeArbitration(g,old);
  for(const v of g.vs.slice(0,6))await g.market.connect(v).registerVerifier();
  await timelocked(g,M,g.market.interface.encodeFunctionData('setTreasury',[g.newTreasury.address]));
  await timelocked(g,T,g.terms.interface.encodeFunctionData('setParams',[{...P,treasuryShareBps:1000}]));
  const n0=await bal(g,g.newTreasury),o0=await bal(g,g.treasury);await arbitrate(g,old,true);
  expect((await g.market.jobs(old)).treasury).to.equal(g.treasury.address);expect(await bal(g,g.newTreasury)).to.equal(n0);expect(await bal(g,g.treasury)-o0).to.equal(S('25'));
  const fresh=await job(g),n1=await bal(g,g.newTreasury);await time.increaseTo((await g.market.effectiveProtectedDeadline(fresh))+1n);await g.market.finalizeJob(fresh);expect((await g.market.jobs(fresh)).treasury).to.equal(g.newTreasury.address);expect(await bal(g,g.newTreasury)-n1).to.equal(S('5'));
  evidence.push({case:'mid-mission-FIXED',oldMissionShare:'50 % frozen',oldMissionPaidTo:'OLD frozen treasury',oldMissionAmount:S('25'),newTreasuryReceivedFromOldMission:0n,newMissionShare:'10 % (new version)',newMissionPaidTo:'new treasury',newMissionAmount:S('5')});
 });
});
