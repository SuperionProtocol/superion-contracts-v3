// LOCAL PROTOTYPE TESTS (Hardhat 31337). Oracle = authored MOCK (no VRF proof). Safe = official SafeL2 1.4.1 bytecode, local signers.
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S,time}=H;
const {oracle,legacyFactory}=require('../helpers/legacy-vrf-fixture.cjs');const {network}=require('hardhat');const fs=require('fs');
const evidence=[];
const P1={...P,feeBps:800,providerStakeBps:20000,challengePeriod:600,bondBps:2000,penaltyBps:2000,voteFeeBps:400,committeeSize:5,appealCommitteeSize:7,voteCommitWindow:300,voteRevealWindow:400,appealWindow:900,arbitrationWindow:7200,appealBondMultBps:30000,slashVerifierBps:2000,slashChallengerBps:3000};
const P2={...P,feeBps:900,providerStakeBps:30000,challengePeriod:1200,bondBps:3000,voteFeeBps:600,committeeSize:7,appealCommitteeSize:9,voteCommitWindow:500,voteRevealWindow:500,appealWindow:1800,arbitrationWindow:9000,appealBondMultBps:40000};
async function fxt(){const f=await H.fixture();f.terms=await ethers.getContractAt('MissionTerms',await f.market.terms());f.engine=await oracle(f.market);return f;}
const ts=async rc=>BigInt((await ethers.provider.getBlock(rc.blockNumber)).timestamp);
const send=async p=>(await p).wait();
async function holdersSum(f){const all=await ethers.getSigners();let s=0n;for(const a of [...all.map(x=>x.address),await f.market.getAddress(),await f.staking.getAddress(),await f.safe.getAddress()])s+=await f.token.balanceOf(a);return s;}
async function conserved(f){expect(await holdersSum(f)).to.equal(await f.token.totalSupply());}
function events(f,rc,name){return rc.logs.flatMap(l=>{try{const e=f.market.interface.parseLog(l);return e?.name===name?[e.args]:[];}catch{return[];}});}

describe('MissionTerms split: rules bound per mission (LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/mission-terms-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; VRF oracle simulated',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('wiring: module deployed by the marketplace constructor, immutable market address, no setter/owner/proxy surface',async()=>{
  const f=await loadFixture(fxt);expect(await f.terms.market()).to.equal(await f.market.getAddress());
  const names=f.terms.interface.fragments.filter(x=>x.type==='function').map(x=>x.name).sort();
  const writes=f.terms.interface.fragments.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).map(x=>x.name).sort();
  expect(writes).to.deep.equal(['bind','setFees','setParams']);expect(names).to.not.include('setMarket');expect(names.some(n=>/owner|upgrade|admin/i.test(n))).to.equal(false);
  expect((await ethers.provider.getCode(await f.terms.getAddress())).length).to.be.greaterThan(2);
  expect(await f.terms.versionCount()).to.equal(1n);const v=await f.terms.current();for(const k of Object.keys(P))expect(v[k]).to.equal(BigInt(P[k]));
 });
 it('forgery: EOAs, the Safe arbiter, admin and a second marketplace cannot bind; only the immutable marketplace can',async()=>{
  const f=await loadFixture(fxt);const id=await H.completed(f);
  for(const who of [f.outsider,f.admin,f.creator])await expect(f.terms.connect(who).bind(999)).to.be.revertedWithCustomError(f.terms,'OnlyMarket');
  const other=await(await legacyFactory()).deploy(await f.token.getAddress(),await f.staking.getAddress(),f.admin.address,f.admin.address,f.admin.address,f.treasury.address,P);
  for(const a of [await other.getAddress(),await f.safe.getAddress()]){await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0xDE0B6B3A7640000']);await expect(f.terms.connect(await ethers.getSigner(a)).bind(1000)).to.be.revertedWithCustomError(f.terms,'OnlyMarket');}
  // TEST-ONLY impersonation of the real marketplace address: even it cannot re-bind an existing mission.
  const m=await f.market.getAddress();await network.provider.send('hardhat_impersonateAccount',[m]);await network.provider.send('hardhat_setBalance',[m,'0xDE0B6B3A7640000']);
  await expect(f.terms.connect(await ethers.getSigner(m)).bind(id)).to.be.revertedWithCustomError(f.terms,'AlreadyBound');
  await expect(f.terms.termsOf(12345)).to.be.revertedWithCustomError(f.terms,'UnknownJob');await expect(f.terms.windows(12345)).to.be.revertedWithCustomError(f.terms,'UnknownJob');
  await expect(f.market.challengeJob(12345,ethers.id('x'))).to.be.revertedWithCustomError(f.market,'InvalidState');
 });
 it('rule changes: same authority as before (marketplace DEFAULT_ADMIN_ROLE), Safe/arbiter/EOA rejected, role changes follow the marketplace',async()=>{
  const f=await loadFixture(fxt);const ROLE=ethers.ZeroHash;
  await expect(f.terms.connect(f.outsider).setParams(P1)).to.be.revertedWithCustomError(f.terms,'AccessControlUnauthorizedAccount').withArgs(f.outsider.address,ROLE);
  await expect(f.terms.connect(f.outsider).setFees(1,1)).to.be.revertedWithCustomError(f.terms,'AccessControlUnauthorizedAccount');
  const safeSigner=await f.safe.getAddress();await network.provider.send('hardhat_impersonateAccount',[safeSigner]);await network.provider.send('hardhat_setBalance',[safeSigner,'0xDE0B6B3A7640000']);
  await expect(f.terms.connect(await ethers.getSigner(safeSigner)).setParams(P1)).to.be.revertedWithCustomError(f.terms,'AccessControlUnauthorizedAccount');
  await expect(f.terms.setParams({...P1,committeeSize:4})).to.be.revertedWithCustomError(f.terms,'InvalidParams');expect(await f.terms.versionCount()).to.equal(1n);
  await expect(f.terms.setParams(P1)).to.emit(f.terms,'ParamsUpdated');expect(await f.terms.versionCount()).to.equal(2n);
  await f.market.grantRole(ROLE,f.outsider.address);await f.terms.connect(f.outsider).setFees(700,1000);const v=await f.terms.current();expect(v.feeBps).to.equal(700n);expect(v.burnShareBps).to.equal(1000n);expect(v.committeeSize).to.equal(5n);
  await f.market.revokeRole(ROLE,f.admin.address);await expect(f.terms.setParams(P)).to.be.revertedWithCustomError(f.terms,'AccessControlUnauthorizedAccount');
  expect(await f.terms.versionCount()).to.equal(3n);expect((await f.terms.version(0)).committeeSize).to.equal(3n);
 });
 it('every stage, first round + jury appeal: rules changed at EACH stage never alter the mission; a parallel newer mission uses its own rules; funds conserved',async()=>{
  const f=await loadFixture(fxt);await conserved(f);
  const id=await f.market.nextJobId();let rc=await send(f.market.connect(f.creator).createJob(S('1000'),3600,'v0'));evidence.push({case:'createJob-gas-with-binding',gas:rc.gasUsed,previousBaseline:'215128'});
  await expect(rc).to.be.ok;expect(await f.terms.jobVersion(id)).to.equal(0n);
  await f.terms.setParams(P1);
  const id1=await f.market.nextJobId();await send(f.market.connect(f.creator).createJob(S('1000'),3600,'v1'));expect(await f.terms.jobVersion(id1)).to.equal(1n);
  await send(f.market.connect(f.provider).assignJob(id));expect((await f.market.jobs(id)).lockedStake).to.equal(S('1000'));
  await send(f.market.connect(f.provider).assignJob(id1));expect((await f.market.jobs(id1)).lockedStake).to.equal(S('2000'));
  await f.terms.setParams(P2);
  rc=await send(f.market.connect(f.provider).submitResult(id,'r'));expect((await f.market.jobs(id)).challengeDeadline).to.equal(await ts(rc)+BigInt(P.challengePeriod));
  rc=await send(f.market.connect(f.provider).submitResult(id1,'r'));expect((await f.market.jobs(id1)).challengeDeadline).to.equal(await ts(rc)+600n);
  await f.terms.setParams(P);
  rc=await send(H.fileChallenge(f,id));let d=await f.market.disputes(id);expect([d.bond,d.penalty,d.voteFee]).to.deep.equal([S('100'),S('100'),S('30')]);expect((await f.engine.status(id,0)).size).to.equal(3n);expect(await f.market.effectiveProtectedDeadline(id)).to.equal(await ts(rc)+BigInt(P.arbitrationWindow));evidence.push({case:'challenge-gas',gas:rc.gasUsed});
  await f.terms.setParams(P2);
  rc=await send(H.fileChallenge(f,id1));d=await f.market.disputes(id1);expect([d.bond,d.penalty,d.voteFee,d.slashVerifierBps,d.slashChallengerBps]).to.deep.equal([S('200'),S('200'),S('40'),2000n,3000n]);expect((await f.engine.status(id1,0)).size).to.equal(5n);expect(await f.market.effectiveProtectedDeadline(id1)).to.equal(await ts(rc)+7200n);
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(S('2300'));await conserved(f);
  await f.terms.setParams(P1);// mid-Draw change
  const c0=await H.draw(f,id);let r=await f.market.rounds(id,0),b=await ethers.provider.getBlock('latest');expect(c0.length).to.equal(3);expect(r.commitDeadline).to.equal(BigInt(b.timestamp+P.voteCommitWindow));expect(r.revealDeadline).to.equal(BigInt(b.timestamp+P.voteCommitWindow+P.voteRevealWindow));
  const c1=await H.draw(f,id1);r=await f.market.rounds(id1,0);b=await ethers.provider.getBlock('latest');expect(c1.length).to.equal(5);expect(r.commitDeadline).to.equal(BigInt(b.timestamp+300));
  await f.terms.setParams(P2);// mid-Voting change
  await H.vote(f,id,[true,true,false]);rc=await send(f.market.resolveDispute(id));expect((await f.market.disputes(id)).appealDeadline).to.equal(await ts(rc)+BigInt(P.appealWindow));
  await f.terms.setParams(P1);// mid-Decided change
  rc=await send(f.market.connect(f.creator).appeal(id));d=await f.market.disputes(id);expect(d.appealBond).to.equal(S('200'));expect((await f.engine.status(id,1)).size).to.equal(5n);expect(await f.market.effectiveProtectedDeadline(id)).to.equal(await ts(rc)+BigInt(P.arbitrationWindow));evidence.push({case:'appeal-gas',gas:rc.gasUsed});
  await H.vote(f,id1,[true,true,true,false,false]);rc=await send(f.market.resolveDispute(id1));expect((await f.market.disputes(id1)).appealDeadline).to.equal(await ts(rc)+900n);
  await f.terms.setParams(P2);// mid-appeal change
  const a1=await H.draw(f,id);r=await f.market.rounds(id,1);b=await ethers.provider.getBlock('latest');expect(a1.length).to.equal(5);for(const x of a1)expect(c0).to.not.include(x);expect(r.commitDeadline).to.equal(BigInt(b.timestamp+P.voteCommitWindow));
  await conserved(f);
  await H.vote(f,id,[false,false,false,false,true]);rc=await send(f.market.resolveDispute(id));
  const pens=events(f,rc,'VerifierPenalized').map(e=>e.amount);expect(pens).to.deep.equal([S('100'),S('100')]);// former majority, job penalty 100 (not 200 of later rules)
  expect((await f.market.jobs(id)).status).to.equal(6n);expect((await f.market.jobs(id)).lockedStake).to.equal(0n);
  // parallel newer mission: no appeal -> its own appeal window (900 s, not P/P2) then its own fee (5 %)
  await expect(f.market.finalizeDispute(id1)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await time.increaseTo(await f.market.effectiveProtectedDeadline(id1)+1n);const before=await f.token.balanceOf(f.provider.address);await send(f.market.finalizeDispute(id1));
  const gained=await f.token.balanceOf(f.provider.address)-before;expect(gained).to.equal(S('920'));// budget 1000 minus its own 8 % fee (v1), not 5 % (v0, new default) nor 9 % (v2)
  evidence.push({case:'parallel-v1-provider-gain',gain:gained});
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);await conserved(f);
  for(const v of f.vs)expect((await f.market.verifiers(v.address)).duties).to.equal(0n);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
 });
 it('Safe 2-of-3 arbitration through the new layout: rule change mid-Draw does not move the eligibility time; 1 signature fails, 2 succeed, no replay',async()=>{
  const f=await loadFixture(fxt);const id=await H.completed(f);await H.keep(f,[]);const rc=await send(H.fileChallenge(f,id));const deadline=await ts(rc)+BigInt(P.arbitrationWindow);
  await f.terms.setParams({...P1,arbitrationWindow:86400});expect(await f.market.effectiveProtectedDeadline(id)).to.equal(deadline);
  await time.setNextBlockTimestamp(deadline);await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');await time.setNextBlockTimestamp(deadline+1n);await f.market.resolveStale(id);
  await time.increase(400*86400);expect((await f.market.jobs(id)).status).to.equal(4n);
  const one=await H.prepared(f,id,false,f.owners.slice(0,1));await expect(H.executeSafeTx(f.safe,f.relayer,one)).to.be.revertedWith('GS020');
  await expect(f.market.connect(f.owners[0]).arbitrate(id,false)).to.be.revertedWithCustomError(f.market,'AccessControlUnauthorizedAccount');
  const two=await H.prepared(f,id,false);await H.executeSafeTx(f.safe,f.relayer,two);expect((await f.market.jobs(id)).status).to.equal(6n);
  await expect(H.executeSafeTx(f.safe,f.relayer,two)).to.be.reverted;expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);await conserved(f);
 });
 it('pause: rule changes while paused do not touch the pause-aware appeal deadline of an existing mission',async()=>{
  const f=await loadFixture(fxt);const s=await H.firstVerdict(f,true);const before=await f.market.effectiveProtectedDeadline(s.id);
  await f.market.pause();await f.terms.setParams({...P,appealWindow:60});await time.increase(1000);await f.market.unpause();
  const after=await f.market.effectiveProtectedDeadline(s.id);expect(after-before).to.be.greaterThanOrEqual(1000n);await time.setNextBlockTimestamp(after);await H.fileAppeal(f,s);
 });
 it('new missions created after a change get the new version; quotes show current rules only',async()=>{
  const f=await loadFixture(fxt);const a=await H.completed(f);await f.terms.setParams(P1);const b=await H.completed(f);
  expect(await f.terms.jobVersion(a)).to.equal(0n);expect(await f.terms.jobVersion(b)).to.equal(1n);
  const [q]=await f.market.disputeAmounts(S('1000'));expect(q).to.equal(S('200'));expect((await f.market.jobs(a)).feeBps).to.equal(BigInt(P.feeBps));expect((await f.market.jobs(b)).feeBps).to.equal(BigInt(P1.feeBps));
  await H.fileChallenge(f,a);await H.fileChallenge(f,b);expect((await f.market.disputes(a)).bond).to.equal(S('100'));expect((await f.market.disputes(b)).bond).to.equal(S('200'));
 });
});
