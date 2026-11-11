// LOCAL PROTOTYPE (Hardhat 31337). Safe = official SafeL2 1.4.1 bytecode with 3 local signers, threshold 2. Oracle = MOCK.
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S,time}=H;const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {safeCall,prepareSafeTx,executeSafeTx}=require('../helpers/local-safe.cjs');const {governedDeploy,DELAY}=require('../helpers/governed-deploy.cjs');
const fs=require('fs'),evidence=[];
async function fxt(){const f=await H.fixture();f.terms=await ethers.getContractAt('MissionTerms',await f.market.terms());f.engine=await oracle(f.market);return f;}
// PAUSE/JURY FIX + SATURATION FIX: total held = per-seat `reserved` (market) + selected-juror hold (drawEngine.frozenHold).
async function invariant(f){for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved+await f.engine.frozenHold(v.address)).to.be.at.most(i.bond);}}
async function gov(){return governedDeploy(ethers,P);}
async function viaTimelock(g,target,data,{owners=g.owners.slice(0,2),delay=DELAY,salt=ethers.id('op')}={}){
 const TLA=await g.timelock.getAddress();const sched=g.timelock.interface.encodeFunctionData('schedule',[target,0,data,ethers.ZeroHash,salt,delay]);
 return {schedule:()=>safeCall(ethers,g.safe,TLA,sched,owners,g.relayer),
  execute:()=>safeCall(ethers,g.safe,TLA,g.timelock.interface.encodeFunctionData('execute',[target,0,data,ethers.ZeroHash,salt]),g.owners.slice(0,2),g.relayer)};
}

describe('Per-seat penalty reservation (LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/reservation-governance-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});
 for(const reverse of [false,true])it(`each seat reserves exactly the frozen max penalty in both rounds; released at settlement (jury appeal reverse=${reverse})`,async()=>{
  const f=await loadFixture(fxt),s=await H.firstVerdict(f,true);const d=await f.market.disputes(s.id);expect(d.penalty).to.equal(S('100'));
  for(const a of s.c0)expect((await f.market.verifiers(a)).reserved).to.equal(S('100'));
  await f.terms.setParams({...P,penaltyBps:3000,minPenalty:S('300')});// later rules must not change the reserved amount
  await H.fileAppeal(f,s);
  // PAUSE/SATURATION FIX: right after the freeze every candidate is only EXIT-locked (candidacy); no capacity is held yet.
  const [pool]=await f.engine.population(s.id,1);expect(pool.length).to.be.greaterThan(0);expect(await f.engine.heldPenalty(s.id,1)).to.equal(0n);
  for(const a of pool){expect(await f.engine.candidacy(a)).to.equal(1n);expect(await f.engine.frozenHold(a)).to.equal(0n);expect((await f.market.verifiers(a)).reserved).to.equal(0n);}await invariant(f);
  const a1=await H.draw(f,s.id);for(const a of a1){expect((await f.market.verifiers(a)).reserved).to.equal(S('100'));expect(await f.engine.frozenHold(a)).to.equal(0n);}
  for(const a of pool){expect(await f.engine.candidacy(a)).to.equal(0n);if(!a1.includes(a)){expect(await f.engine.frozenHold(a)).to.equal(0n);expect((await f.market.verifiers(a)).reserved).to.equal(0n);}}expect(await f.engine.heldPenalty(s.id,1)).to.equal(0n);
  await H.vote(f,s.id,reverse?[false,false,false,false,true]:[true,true,true,true,false]);await f.market.resolveDispute(s.id);
  for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved).to.equal(0n);expect(i.duties).to.equal(0n);expect(await f.engine.frozenHold(v.address)).to.equal(0n);}await invariant(f);
 });
 it('Safe 2-of-3 settlement also releases reservations; 1 signature leaves them in place',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f);await H.fileChallenge(f,id);const c=await H.draw(f,id);
  await time.increaseTo((await f.market.rounds(id,0)).revealDeadline+1n);await f.market.resolveStale(id);
  const one=await H.prepared(f,id,false,f.owners.slice(0,1));await expect(H.executeSafeTx(f.safe,f.relayer,one)).to.be.revertedWith('GS020');
  for(const a of c)expect((await f.market.verifiers(a)).reserved).to.equal(S('100'));
  await H.arbitrate(f,id,false);for(const a of c){const i=await f.market.verifiers(a);expect(i.reserved).to.equal(0n);expect(i.bond).to.equal(S('900'));}await invariant(f);
 });
 it('eligibility uses UNRESERVED bond at candidate freeze (before the VRF request); a larger bond can hold two seats',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,penaltyBps:10000});await H.keep(f,f.vs.slice(0,3));
  await f.token.transfer(f.outsider.address,S('3000'));await f.token.connect(f.outsider).approve(await f.staking.getAddress(),ethers.MaxUint256);await f.staking.connect(f.outsider).stake(S('3000'));await f.market.connect(f.outsider).registerVerifierWithStake(S('2000'));
  const a=await H.completed(f);await H.fileChallenge(f,a);const ca=await H.draw(f,a);
  const b=await H.completed(f);await H.fileChallenge(f,b);const [pool]=await f.engine.population(b,0);
  const expected=[...f.vs.slice(0,3).map(v=>v.address),f.outsider.address].filter(x=>!ca.includes(x)||x===f.outsider.address);
  expect(Array.from(pool).sort()).to.deep.equal(expected.sort());
  if(ca.includes(f.outsider.address))expect((await f.market.verifiers(f.outsider.address)).reserved).to.equal(S('1000'));
  evidence.push({case:'freeze-eligibility',firstJury:ca,secondSnapshot:Array.from(pool)});
 });
 it('reserved stake cannot be withdrawn: a seated juror can no longer even exit (StakeReserved), bond stays locked, staking refuses to unstake it',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f);await H.fileChallenge(f,id);const c=await H.draw(f,id);const v=await ethers.getSigner(c[0]);
  await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');const i=await f.market.verifiers(v.address);expect(i.indexPlus1).to.not.equal(0n);expect(i.bond).to.equal(S('1000'));expect(i.reserved).to.equal(S('100'));expect(await f.staking.lockedStake(v.address)).to.equal(S('1000'));
  const free=await f.staking.availableStake(v.address);await expect(f.staking.connect(v).requestUnstake(free+1n)).to.be.revertedWithCustomError(f.staking,'InsufficientUnlocked');
 });
 it('PAUSE/SATURATION FIX: concurrent freezes share candidates without holding capacity; the first PUBLIC result holds its selected, the second skips them and fails to Safe; no stake backs two seats',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,penaltyBps:10000});await H.keep(f,f.vs.slice(0,4));const mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());
  // Replaces the PAUSE/JURY case 'a freeze holds its candidates capacity': a mere freeze no longer holds capacity
  // (that is what let tiny disputes saturate everybody, N1). Both freezes get the 4 candidates, only exit-locked.
  const A=await H.completed(f),B=await H.completed(f);await H.fileChallenge(f,A);await H.fileChallenge(f,B);
  const sa=await f.engine.status(A,0),sb=await f.engine.status(B,0);expect(sa.count).to.equal(4n);expect(sb.count).to.equal(4n);expect(sb.state).to.equal(1n);
  for(const v of f.vs.slice(0,4)){expect(await f.engine.frozenHold(v.address)).to.equal(0n);expect(await f.engine.candidacy(v.address)).to.equal(2n);await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');}await invariant(f);
  await mock.fulfill(sa.requestId,11);const selA=Array.from(await f.engine.selection(A,0));expect(selA.length).to.equal(3);
  for(const v of f.vs.slice(0,4))expect(await f.engine.frozenHold(v.address)).to.equal(selA.includes(v.address)?S('1000'):0n);await invariant(f);
  // B's result: the 3 selected of A have no free capacity (1000 held of 1000) -> skipped; only 1 left < 3 -> Failed (Safe path)
  await mock.fulfill(sb.requestId,22);expect((await f.engine.status(B,0)).state).to.equal(4n);expect(Array.from(await f.engine.selection(B,0))).to.deep.equal([]);await invariant(f);
  await expect(f.market.drawCommittee(B)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
  await f.market.drawCommittee(A);const c=Array.from(await f.market.committeeOf(A));expect(c).to.deep.equal(selA);const out=f.vs.slice(0,4).find(v=>!c.includes(v.address));
  expect(await f.engine.frozenHold(out.address)).to.equal(0n);expect((await f.market.verifiers(out.address)).reserved).to.equal(0n);expect(await f.engine.candidacy(out.address)).to.equal(1n);await invariant(f);
  await expect(f.market.connect(out).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved'); // still a candidate of B
  await H.vote(f,A,[true,true,true]);await f.market.resolveDispute(A);
  const late=async t=>{if(t>BigInt(await time.latest()))await time.increaseTo(t);};
  await late((await f.market.effectiveProtectedDeadline(B))+1n);await f.market.resolveStale(B);expect((await f.market.disputes(B)).phase).to.equal(5n);
  await late((await f.market.effectiveProtectedDeadline(A))+1n);await f.market.finalizeDispute(A);
  for(const v of f.vs.slice(0,4)){const i=await f.market.verifiers(v.address);expect(i.reserved).to.equal(0n);expect(await f.engine.frozenHold(v.address)).to.equal(0n);expect(await f.engine.candidacy(v.address)).to.equal(0n);}await invariant(f);
  await f.market.connect(out).exitVerifier();
 });
});

describe('Governance: admin = 48h timelock controlled by the local Safe 2-of-3 (LOCAL PROTOTYPE)',function(){
 it('wiring: no EOA holds admin on marketplace, staking or timelock; Safe holds proposer/executor/canceller, arbiter and marketplace pauser',async()=>{
  const g=await loadFixture(gov),A=ethers.ZeroHash,S_=await g.safe.getAddress(),TL=await g.timelock.getAddress();
  const signers=await ethers.getSigners();
  for(const c of [g.market,g.staking,g.timelock])for(const s of signers)expect(await c.hasRole(A,s.address)).to.equal(false);
  expect(await g.market.hasRole(A,TL)).to.equal(true);expect(await g.staking.hasRole(A,TL)).to.equal(true);expect(await g.timelock.hasRole(A,TL)).to.equal(true);expect(await g.timelock.hasRole(A,S_)).to.equal(false);
  for(const r of ['PROPOSER_ROLE','EXECUTOR_ROLE','CANCELLER_ROLE'])expect(await g.timelock.hasRole(await g.timelock[r](),S_)).to.equal(true);
  expect(await g.market.hasRole(await g.market.ARBITER_ROLE(),S_)).to.equal(true);expect(await g.market.hasRole(await g.market.PAUSER_ROLE(),S_)).to.equal(true);// user-approved (pt82u): Safe pauses/unpauses immediately
  for(const s of signers)expect(await g.market.hasRole(await g.market.PAUSER_ROLE(),s.address)).to.equal(false);
  expect(await g.timelock.getMinDelay()).to.equal(DELAY);
 });
 it('parameter change: Safe 2/2-of-3 schedules, executes only after 48h; 1 signature, owner EOA, Safe-direct and short delay all fail',async()=>{
  const g=await loadFixture(gov),data=g.terms.interface.encodeFunctionData('setParams',[{...P,committeeSize:5,appealCommitteeSize:7}]),T=await g.terms.getAddress();
  await expect(g.terms.connect(g.owners[0]).setParams(P)).to.be.revertedWithCustomError(g.terms,'AccessControlUnauthorizedAccount');
  const S_=await g.safe.getAddress();await ethers.provider.send('hardhat_impersonateAccount',[S_]);await ethers.provider.send('hardhat_setBalance',[S_,'0xDE0B6B3A7640000']);
  await expect(g.terms.connect(await ethers.getSigner(S_)).setParams(P)).to.be.revertedWithCustomError(g.terms,'AccessControlUnauthorizedAccount');
  await expect(g.timelock.connect(g.owners[0]).schedule(T,0,data,ethers.ZeroHash,ethers.id('op'),DELAY)).to.be.revertedWithCustomError(g.timelock,'AccessControlUnauthorizedAccount');
  const short=await viaTimelock(g,T,data,{delay:DELAY-1n});await expect(short.schedule()).to.be.reverted;
  const oneSig=await viaTimelock(g,T,data,{owners:g.owners.slice(0,1)});await expect(oneSig.schedule()).to.be.revertedWith('GS020');
  const op=await viaTimelock(g,T,data);await op.schedule();await expect(op.execute()).to.be.reverted;expect(await g.terms.versionCount()).to.equal(1n);
  await time.increase(DELAY-10n);await expect(op.execute()).to.be.reverted;await time.increase(10n);await op.execute();
  expect(await g.terms.versionCount()).to.equal(2n);expect((await g.terms.current()).committeeSize).to.equal(5n);await expect(op.execute()).to.be.reverted;
 });
 it('granting ARBITER_ROLE (or any role) needs the 48h timelock; Safe cannot grant directly',async()=>{
  const g=await loadFixture(gov),R=await g.market.ARBITER_ROLE(),data=g.market.interface.encodeFunctionData('grantRole',[R,g.outsider.address]),M=await g.market.getAddress();
  const direct=await prepareSafeTx(ethers,g.safe,M,data,g.owners.slice(0,2));await expect(executeSafeTx(g.safe,g.relayer,direct)).to.be.revertedWith('GS013');
  const op=await viaTimelock(g,M,data,{salt:ethers.id('arb')});await op.schedule();expect(await g.market.hasRole(R,g.outsider.address)).to.equal(false);
  // ROLES-GUARD STEP (approved protection 1): even after 48h, ARBITER_ROLE cannot go to an EOA; only to the official Safe.
  await time.increase(DELAY);await expect(op.execute()).to.be.reverted;expect(await g.market.hasRole(R,g.outsider.address)).to.equal(false);
  const ok=await viaTimelock(g,M,g.market.interface.encodeFunctionData('grantRole',[R,await g.safe.getAddress()]),{salt:ethers.id('arb-safe')});await ok.schedule();await time.increase(DELAY);await ok.execute();
  evidence.push({case:'arbiter-grant',note:'EOA refused by the timelock even after 48h; the official Safe accepted'});
 });
 it('the 48h floor cannot be lowered (construction or delayed updateDelay)',async()=>{
  const g=await loadFixture(gov),F=await ethers.getContractFactory('SuperionGovernanceTimelock'),M0=await g.market.getAddress();
  await expect(F.deploy(DELAY-1n,[g.owners[0].address],[g.owners[0].address],ethers.ZeroAddress,M0)).to.be.revertedWithCustomError(g.timelock,'DelayBelowFloor');
  const TL=await g.timelock.getAddress(),data=g.timelock.interface.encodeFunctionData('updateDelay',[3600]);const op=await viaTimelock(g,TL,data,{salt:ethers.id('d')});await op.schedule();await time.increase(DELAY);
  await expect(op.execute()).to.be.reverted;expect(await g.timelock.getMinDelay()).to.equal(DELAY);
  const up=await viaTimelock(g,TL,g.timelock.interface.encodeFunctionData('updateDelay',[DELAY*2n]),{salt:ethers.id('u')});await up.schedule();await time.increase(DELAY);await up.execute();expect(await g.timelock.getMinDelay()).to.equal(DELAY*2n);
 });
 it('arbitration stays immediate for the Safe (ARBITER_ROLE, not delayed) and still needs 2 signatures',async()=>{
  const g=await loadFixture(gov);for(const a of [g.creator,g.provider,...g.vs]){await g.token.transfer(a.address,S('100000'));await g.token.connect(a).approve(await g.staking.getAddress(),ethers.MaxUint256);await g.token.connect(a).approve(await g.market.getAddress(),ethers.MaxUint256);}
  await g.token.transfer(g.challenger.address,S('1000'));await g.token.connect(g.challenger).approve(await g.market.getAddress(),ethers.MaxUint256);
  await g.staking.connect(g.provider).stake(S('5000'));for(const v of g.vs){await g.staking.connect(v).stake(S('1000'));await g.market.connect(v).registerVerifier();}
  const id=await g.market.nextJobId();await g.market.connect(g.creator).createJob(S('1000'),3600,'gov');await g.market.connect(g.provider).assignJob(id);await g.market.connect(g.provider).submitResult(id,'r');
  for(const v of g.vs)await g.market.connect(v).exitVerifier();await g.market.connect(g.challenger).challengeJob(id,ethers.id('c'));
  await time.increaseTo((await g.market.effectiveProtectedDeadline(id))+1n);await g.market.resolveStale(id);
  const data=g.market.interface.encodeFunctionData('arbitrate',[id,true]),M=await g.market.getAddress();
  const one=await prepareSafeTx(ethers,g.safe,M,data,g.owners.slice(0,1));await expect(executeSafeTx(g.safe,g.relayer,one)).to.be.revertedWith('GS020');
  await safeCall(ethers,g.safe,M,data,g.owners.slice(1,3),g.relayer);expect((await g.market.jobs(id)).status).to.equal(5n);
 });
 it('FIXED (approved protection 1): the timelock can NO LONGER grant PAUSER_ROLE to an EOA, even after the 48h delay',async()=>{
  const g=await loadFixture(gov),R=await g.market.PAUSER_ROLE(),M=await g.market.getAddress();
  for(const s of [g.deployer,g.owners[0],g.outsider])await expect(g.market.connect(s).pause()).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount');
  const op=await viaTimelock(g,M,g.market.interface.encodeFunctionData('grantRole',[R,g.outsider.address]),{salt:ethers.id('p')});await op.schedule();
  await expect(op.execute()).to.be.reverted;expect(await g.market.hasRole(R,g.outsider.address)).to.equal(false);
  await time.increase(DELAY);await expect(op.execute()).to.be.reverted;expect(await g.market.hasRole(R,g.outsider.address)).to.equal(false);
  evidence.push({case:'pauser-grant-eoa-refused',note:'refused by SuperionGovernanceTimelock RoleRecipientNotAllowed even after 48h'});
 });
});
