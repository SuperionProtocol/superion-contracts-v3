const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {expect}=require('chai');
const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');
const {ethers,P,S,fixture,completed,keep,fileChallenge,draw,vote,prepareAppeal,fileAppeal,prepared,arbitrate,snapshot,eligibleArbitration,executeSafeTx,time,mine}=H;
async function solvent(f){
 expect(await f.token.balanceOf(await f.staking.getAddress())).to.be.at.least(await f.staking.totalSupply()+await f.staking.totalUnbonding()+await f.staking.totalRewardsOwed()+await f.staking.queuedRewards());
}
async function terminal(f,id,result,c=[],extraProviderLock=0n){
 const j=await f.market.jobs(id),d=await f.market.disputes(id);
 expect(j.status).to.equal(result?5n:6n);expect(j.budget).to.equal(0n);expect(j.lockedStake).to.equal(0n);expect(d.phase).to.equal(4n);expect(d.bond).to.equal(0n);expect(d.appealBond).to.equal(0n);
 expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);expect(await f.staking.lockedStake(f.provider.address)).to.equal(extraProviderLock);
 for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(0n);await solvent(f);
}
async function noExit(f,id){
 for(const actor of [f.creator,f.provider,f.challenger])for(const method of ['finalizeJob','finalizeDispute','cancelJob','reclaimExpired'])await expect(f.market.connect(actor)[method](id)).to.be.reverted;
 await expect(f.staking.connect(f.provider).requestUnstake(await f.staking.balanceOf(f.provider.address))).to.be.revertedWithCustomError(f.staking,'InsufficientUnlocked');
}
async function signaturesRequired(f,id,result){
 const before=await snapshot(f,id),nonce=await f.safe.nonce();
 for(const n of [0,1])await expect(executeSafeTx(f.safe,f.relayer,await prepared(f,id,result,f.owners.slice(0,n)))).to.be.revertedWith('GS020');
 await expect(f.market.connect(f.owners[0]).arbitrate(id,result)).to.be.revertedWithCustomError(f.market,'AccessControlUnauthorizedAccount');
 expect(await snapshot(f,id)).to.deep.equal(before);expect(await f.safe.nonce()).to.equal(nonce);
}
async function noRepeat(f,id,result,tx){
 const before=await snapshot(f,id),nonce=await f.safe.nonce();
 await expect(executeSafeTx(f.safe,f.relayer,tx.prepared)).to.be.revertedWith('GS026');await expect(arbitrate(f,id,result)).to.be.revertedWith('GS013');
 expect(await snapshot(f,id)).to.deep.equal(before);expect(await f.safe.nonce()).to.equal(nonce);
}
const feeEvents=(f,receipt)=>receipt.logs.map(l=>{try{return f.market.interface.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='VerifierFeePaid');

describe('Timely filing despite verifier shortage: actual official Safe, unchanged Draw/bond rules',function(){
 for(const n of [0,1,2])for(const result of [true,false])it(`first challenge opens with ${n} eligible jurors; no fictitious fees; indefinite hold then Safe ${result}`,async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,f.vs.slice(0,n));expect(await f.market.verifierCount()).to.equal(BigInt(n));
  const chalBefore=await f.token.balanceOf(f.challenger.address);await fileChallenge(f,id);const d=await f.market.disputes(id);
  expect(d.phase).to.equal(1n);expect(d.bond).to.equal(S('100'));expect(chalBefore-await f.token.balanceOf(f.challenger.address)).to.equal(d.bond);
  expect((await f.market.committeeOfRound(id,0)).length).to.equal(0);await mine(1);await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
  const before=await snapshot(f,id);expect(before.escrow).to.equal(S('1100'));await eligibleArbitration(f,id);expect(await snapshot(f,id)).to.deep.equal(before);
  await time.increase(10*365*86400);await noExit(f,id);await signaturesRequired(f,id,result);
  const tx=await arbitrate(f,id,result);expect(feeEvents(f,tx.receipt).length).to.equal(0);await terminal(f,id,result);
  if(result){
   expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(S('1050'));expect(before.supply-await f.token.totalSupply()).to.equal(S('10'));
   expect((await f.token.balanceOf(f.treasury.address))-before.treasury).to.equal(S('25'));expect(await f.staking.totalRewardsOwed()+await f.staking.queuedRewards()).to.equal(S('15'));
  }else{
   expect((await f.token.balanceOf(f.creator.address))-before.creator).to.equal(S('1000'));expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(S('200'));
   expect(before.supply-await f.token.totalSupply()).to.equal(S('900'));expect(before.providerStake-await f.staking.balanceOf(f.provider.address)).to.equal(S('1000'));
  }
  for(const v of f.vs){const info=await f.market.verifiers(v.address);expect(info.duties).to.equal(0n);expect(info.bond).to.equal(n&&f.vs.slice(0,n).includes(v)?S('1000'):0n);}
  await noRepeat(f,id,result,tx);
 });
 it('registered parties are not eligible jurors: filing with only three registered parties cannot select them',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);
  for(const a of [f.creator,f.challenger]){await f.staking.connect(a).stake(S('10000'));await f.market.connect(a).registerVerifier();}
  await f.market.connect(f.provider).registerVerifier();expect(await f.market.verifierCount()).to.equal(3n);await fileChallenge(f,id);await mine(1);
  await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect((await f.market.committeeOf(id)).length).to.equal(0);
  await eligibleArbitration(f,id);const tx=await arbitrate(f,id,true);expect(feeEvents(f,tx.receipt).length).to.equal(0);await terminal(f,id,true,[],S('1000'));
  expect((await f.market.verifiers(f.provider.address)).bond).to.equal(S('1000'));await f.market.connect(f.provider).exitVerifier();expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
 });
 it('a registered verifier can file with only two OTHER eligible jurors, but cannot sit on its own challenge',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,f.vs.slice(0,3));await fileChallenge(f,id,f.vs[0]);await mine(1);
  await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect((await f.market.disputes(id)).challenger).to.equal(f.vs[0].address);
  expect((await f.market.verifiers(f.vs[0].address)).duties).to.equal(0n);await eligibleArbitration(f,id);await arbitrate(f,id,false);await terminal(f,id,false);
 });
 it('adequate verifiers still take the ordinary full-committee path, not immediate Safe arbitration',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await fileChallenge(f,id);expect((await f.market.disputes(id)).phase).to.equal(1n);
  await expect(arbitrate(f,id,true)).to.be.revertedWith('GS013');const c=await draw(f,id);expect(c.length).to.equal(3);
  await vote(f,id,[true,true,true]);await f.market.resolveDispute(id);expect((await f.market.disputes(id)).phase).to.equal(3n);
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.finalizeDispute(id);await terminal(f,id,true,c);
 });
 it('VRF UPDATE: new population after a zero-candidate snapshot cannot replace the fixed jury; Safe remains available',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await fileChallenge(f,id);const cutoff=await f.market.effectiveProtectedDeadline(id);
  for(const v of f.vs.slice(0,3))await f.market.connect(v).registerVerifier();await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect(await f.market.effectiveProtectedDeadline(id)).to.equal(cutoff);
  await eligibleArbitration(f,id);await arbitrate(f,id,true);await terminal(f,id,true);
 });
 for(const n of [0,4])for(const original of [true,false])for(const result of [true,false])it(`appeal opens with only ${n} fresh disjoint jurors; original ${original} -> Safe ${result}, exact existing economics`,async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,original,n);expect(await f.market.verifierCount()).to.equal(BigInt(3+n));
  const appellantBefore=await f.token.balanceOf(s.appellant.address);await fileAppeal(f,s);const d=await f.market.disputes(s.id);
  expect(d.round).to.equal(1n);expect(d.phase).to.equal(1n);expect(d.appealBond).to.equal(S('200'));expect(appellantBefore-await f.token.balanceOf(s.appellant.address)).to.equal(d.appealBond);
  await mine(1);await expect(legacyDraw(f.market,s.id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect((await f.market.committeeOfRound(s.id,1)).length).to.equal(0);
  const before=await snapshot(f,s.id),feesBefore=await Promise.all(s.c0.map(a=>f.token.balanceOf(a)));expect(before.escrow).to.equal(S('1300'));
  await eligibleArbitration(f,s.id);await time.increase(20*365*86400);expect(await snapshot(f,s.id)).to.deep.equal(before);await noExit(f,s.id);
  for(const a of s.c0)expect((await f.market.verifiers(a)).duties).to.equal(1n);await signaturesRequired(f,s.id,result);
  const tx=await arbitrate(f,s.id,result),fees=feeEvents(f,tx.receipt);expect(fees.length).to.equal(3);
  expect(new Set(fees.map(e=>e.args.verifier))).to.deep.equal(new Set(s.c0));for(const e of fees)expect(e.args.amount).to.equal(S('30'));
  for(let i=0;i<s.c0.length;i++){expect((await f.token.balanceOf(s.c0[i]))-feesBefore[i]).to.equal(S('30'));expect((await f.market.verifiers(s.c0[i])).bond).to.equal(S('1000'));}
  await terminal(f,s.id,result,s.c0);expect((await f.market.disputes(s.id)).outcomeValid).to.equal(original);
  const reversed=result!==original;
  if(result){
   const providerExpected=S('960')+(reversed?S('200'):0n);expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(providerExpected);
   expect(before.supply-await f.token.totalSupply()).to.equal(S(reversed?'10':'210'));expect((await f.token.balanceOf(f.treasury.address))-before.treasury).to.equal(S('25'));
  }else{
   expect((await f.token.balanceOf(f.creator.address))-before.creator).to.equal(S('1000')+(reversed?S('200'):0n));expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(S('191'));
   expect(before.supply-await f.token.totalSupply()).to.equal(S(reversed?'819':'1019'));expect(before.providerStake-await f.staking.balanceOf(f.provider.address)).to.equal(S('1000'));
  }
  await noRepeat(f,s.id,result,tx);for(const a of s.c0){await f.market.connect(await ethers.getSigner(a)).exitVerifier();expect(await f.staking.lockedStake(a)).to.equal(0n);}
 });
 it('adequate fresh appeal jurors still form a five-member disjoint jury',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,true,5);await fileAppeal(f,s);const c1=await draw(f,s.id);expect(c1.length).to.equal(5);for(const a of c1)expect(s.c0).to.not.include(a);
  await vote(f,s.id,[true,true,true,true,true]);await f.market.resolveDispute(s.id);await terminal(f,s.id,true,[...s.c0,...c1]);
 });
 it('VRF UPDATE: new disjoint jurors after a fixed insufficient appeal snapshot cannot substitute; Safe reversal exempts old majority',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,false,0);await fileAppeal(f,s);for(const v of s.fresh.slice(0,5))await f.market.connect(v).registerVerifier();
  await expect(f.market.drawCommittee(s.id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');await eligibleArbitration(f,s.id);await arbitrate(f,s.id,true);await terminal(f,s.id,true,s.c0);
  for(const address of s.c0)expect((await f.market.verifiers(address)).bond).to.equal(S('1000'));
 });
 it('zero-jury challenge filing is allowed at the exact inclusive protected deadline',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));await fileChallenge(f,id);expect((await f.market.disputes(id)).phase).to.equal(1n);
 });
 it('zero-jury challenge cannot be filed after its protected deadline; no late bypass is added',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await time.setNextBlockTimestamp((await f.market.effectiveProtectedDeadline(id))+1n);
  await expect(fileChallenge(f,id)).to.be.revertedWithCustomError(f.market,'TooLate');expect((await f.market.jobs(id)).status).to.equal(3n);
 });
 it('zero-disjoint-jury appeal filing is allowed at the exact inclusive protected deadline',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,true,0);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(s.id));await fileAppeal(f,s);expect((await f.market.disputes(s.id)).round).to.equal(1n);
 });
 it('zero-disjoint-jury appeal cannot be filed after its protected deadline',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,true,0);await time.setNextBlockTimestamp((await f.market.effectiveProtectedDeadline(s.id))+1n);await expect(fileAppeal(f,s)).to.be.revertedWithCustomError(f.market,'TooLate');
 });
 it('pause preserves a zero-jury challenge filing right and then the full existing Draw window',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await f.market.pause();await time.increase(86400);
  await expect(fileChallenge(f,id)).to.be.revertedWithCustomError(f.market,'EnforcedPause');await f.market.unpause();await fileChallenge(f,id);
  expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(BigInt(P.arbitrationWindow));
  await f.market.pause();const remaining=(await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());await time.increase(365*86400);
  expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(remaining);await expect(arbitrate(f,id,true)).to.be.revertedWith('GS013');
  await f.market.unpause();await eligibleArbitration(f,id);await arbitrate(f,id,true);await terminal(f,id,true);
 });
 it('pause preserves a zero-disjoint appeal filing right and then its full protected Draw window',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,false,0);await f.market.pause();await time.increase(86400);
  await expect(fileAppeal(f,s)).to.be.revertedWithCustomError(f.market,'EnforcedPause');await f.market.unpause();await fileAppeal(f,s);
  expect((await f.market.effectiveProtectedDeadline(s.id))-BigInt(await time.latest())).to.equal(BigInt(P.arbitrationWindow));
  await f.market.pause();const remain=(await f.market.effectiveProtectedDeadline(s.id))-BigInt(await time.latest());await time.increase(86400);
  expect((await f.market.effectiveProtectedDeadline(s.id))-BigInt(await time.latest())).to.equal(remain);await expect(arbitrate(f,s.id,true)).to.be.revertedWith('GS013');
  await f.market.unpause();await eligibleArbitration(f,s.id);await arbitrate(f,s.id,true);await terminal(f,s.id,true,s.c0);
 });
 it('an already expired zero-jury challenge filing window is never revived by a later pause',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.pause();await time.increase(1000);await f.market.unpause();
  await expect(fileChallenge(f,id)).to.be.revertedWithCustomError(f.market,'TooLate');
 });
 it('an already expired zero-disjoint appeal filing window is never revived by a later pause',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,false,0);await time.increaseTo((await f.market.effectiveProtectedDeadline(s.id))+1n);await f.market.pause();await time.increase(1000);await f.market.unpause();
  await expect(fileAppeal(f,s)).to.be.revertedWithCustomError(f.market,'TooLate');
 });
 it('without an actual timely appeal, a first-jury majority still cannot be bypassed by Safe or registry shortage',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,true,0);await expect(arbitrate(f,s.id,false)).to.be.revertedWith('GS013');
  await expect(f.market.resolveStale(s.id)).to.be.revertedWithCustomError(f.market,'InvalidState');await time.increaseTo((await f.market.effectiveProtectedDeadline(s.id))+1n);await f.market.finalizeDispute(s.id);await terminal(f,s.id,true,s.c0);
 });
 it('shortage does not waive the challenge bond, seed or actor rules; failed funding creates no dispute',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await f.token.connect(f.challenger).approve(await f.market.getAddress(),0);
  await expect(fileChallenge(f,id)).to.be.reverted;expect((await f.market.jobs(id)).status).to.equal(3n);expect((await f.market.disputes(id)).challenger).to.equal(ethers.ZeroAddress);
  await expect(f.market.connect(f.provider).challengeJob(id,ethers.id('bad'))).to.be.revertedWithCustomError(f.market,'NotAllowed');
  await expect(f.market.connect(f.creator).challengeJob(id,ethers.ZeroHash)).to.be.revertedWithCustomError(f.market,'BadCommit');
  await f.token.connect(f.challenger).approve(await f.market.getAddress(),S('100'));await fileChallenge(f,id);
  await expect(fileChallenge(f,id)).to.be.revertedWithCustomError(f.market,'InvalidState');expect((await f.market.disputes(id)).bond).to.equal(S('100'));
 });
 it('appeal shortage does not waive loser-only permissions, its full bond or one-appeal rule',async function(){
  const f=await loadFixture(fixture),s=await prepareAppeal(f,true,0);
  for(const a of [f.provider,f.outsider])await expect(f.market.connect(a).appeal(s.id)).to.be.revertedWithCustomError(f.market,'NotAllowed');
  await f.token.connect(s.appellant).approve(await f.market.getAddress(),0);await expect(fileAppeal(f,s)).to.be.reverted;expect((await f.market.disputes(s.id)).phase).to.equal(3n);expect((await f.market.disputes(s.id)).appellant).to.equal(ethers.ZeroAddress);
  await f.token.connect(s.appellant).approve(await f.market.getAddress(),S('200'));await fileAppeal(f,s);await expect(fileAppeal(f,s)).to.be.revertedWithCustomError(f.market,'InvalidState');
 });
 it('filing with no jury adds no earlier arbiter permission: Draw is inclusive, arbitration strictly afterward',async function(){
  const f=await loadFixture(fixture),id=await completed(f);await keep(f,[]);await fileChallenge(f,id);await expect(arbitrate(f,id,true)).to.be.revertedWith('GS013');
  await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  const tx=await arbitrate(f,id,true);expect(feeEvents(f,tx.receipt).length).to.equal(0);await terminal(f,id,true);
 });
});
