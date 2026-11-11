// PAUSE / JURY / GUARD step, ADAPTED by the PAUSE/SATURATION FIX — LOCAL PROTOTYPE ONLY (Hardhat 31337). VRF = authored LOCAL MOCK.
// Before: every frozen candidate HELD one penalty from the VRF request (capacity) => tiny disputes could saturate the pool (N1).
// Now: every frozen candidate is EXIT-locked (engine.candidacy) from the request until seating or an unseated close,
// but holds NO capacity; the penalty is held (engine.frozenHold) only on the SELECTED, in the fulfillment transaction.
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S,time}=H;const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const fs=require('fs'),evidence=[];
async function fxt(){const f=await H.fixture();f.engine=await oracle(f.market);f.mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());return f;}
const signer=a=>ethers.getSigner(a);
async function filed(f){const id=await H.completed(f);await H.fileChallenge(f,id);const d=await f.market.disputes(id),[pool]=await f.engine.population(id,0);return {id,d,pool:Array.from(pool)};}
async function allFree(f){for(const v of f.vs){expect(await f.engine.frozenHold(v.address)).to.equal(0n);expect(await f.engine.candidacy(v.address)).to.equal(0n);}}

describe('PAUSE/JURY FIX adapted by SATURATION FIX: candidate exit-lock + selected hold (LOCAL PROTOTYPE, MOCK VRF)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/pause-jury-guard-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; VRF is a LOCAL MOCK; nothing deployed',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('right after filing (before any VRF result) every frozen candidate is exit-locked but holds NO capacity; non-candidates can leave',async()=>{
  const f=await loadFixture(fxt);const outsiderV=f.vs[9];await H.keep(f,f.vs.slice(0,9));
  const {id,d,pool}=await filed(f);expect(pool.length).to.equal(9);expect((await f.engine.status(id,0)).state).to.equal(1n);expect(await f.engine.heldPenalty(id,0)).to.equal(0n);
  for(const a of pool){expect(await f.engine.candidacy(a)).to.equal(1n);expect(await f.engine.frozenHold(a)).to.equal(0n);expect((await f.market.verifiers(a)).reserved).to.equal(0n);expect((await f.market.verifiers(a)).duties).to.equal(0n);
   await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');}
  // a verifier who joins after the freeze is not in the list and is free to leave
  await f.market.connect(outsiderV).registerVerifier();expect(await f.engine.candidacy(outsiderV.address)).to.equal(0n);await f.market.connect(outsiderV).exitVerifier();
  evidence.push({case:'exit-lock-at-freeze',candidates:pool.length,penalty:d.penalty,capacityHeld:0});
 });

 it('no VRF result before the Draw deadline: the case still goes to Safe, and the whole list is released exactly once (no double release at arbitration)',async()=>{
  const f=await loadFixture(fxt),{id,pool}=await filed(f);
  await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);
  expect((await f.market.disputes(id)).phase).to.equal(5n);expect(await f.engine.heldPenalty(id,0)).to.equal(0n);expect((await f.engine.status(id,0)).state).to.equal(5n);await allFree(f);
  await H.arbitrate(f,id,true);expect((await f.market.jobs(id)).status).to.equal(5n);await allFree(f);
  for(const a of pool){const i=await f.market.verifiers(a);expect(i.reserved).to.equal(0n);await f.market.connect(await signer(a)).exitVerifier();expect((await f.market.verifiers(a)).bond).to.equal(0n);}
  evidence.push({case:'unseated-close-release',released:pool.length});
 });

 it('Safe escalates atomically from Draw (arbitrate) and the list is released in that same transaction',async()=>{
  const f=await loadFixture(fxt),{id,pool}=await filed(f);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);
  await H.arbitrate(f,id,false);expect((await f.market.jobs(id)).status).to.equal(6n);await allFree(f);for(const a of pool)expect((await f.market.verifiers(a)).reserved).to.equal(0n);
 });

 it('result Ready: ONLY the selected hold the penalty (same tx as the result); nobody seats before the deadline: unseated close releases holds and list once',async()=>{
  const f=await loadFixture(fxt),{id,d,pool}=await filed(f);const s=await f.engine.status(id,0);await f.mock.fulfill(s.requestId,7);expect((await f.engine.status(id,0)).state).to.equal(2n);
  const sel=Array.from(await f.engine.selection(id,0));expect(sel.length).to.equal(3);expect(await f.engine.heldPenalty(id,0)).to.equal(d.penalty);
  for(const a of pool){expect(await f.engine.frozenHold(a)).to.equal(sel.includes(a)?d.penalty:0n);expect(await f.engine.candidacy(a)).to.equal(1n);}
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'TooLate');await f.market.resolveStale(id);await allFree(f);
 });

 it('late result after the deadline (engine Closed by the callback) and malformed callback (Failed after request): list stays exit-locked until escalation, then released; no capacity held meanwhile',async()=>{
  for(const mode of ['late','malformed']){
   const f=await loadFixture(fxt),{id,pool}=await filed(f),s=await f.engine.status(id,0);
   if(mode==='late'){await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.mock.fulfill(s.requestId,9);expect((await f.engine.status(id,0)).state).to.equal(5n);}
   else{await f.mock.send(s.requestId,await f.engine.getAddress(),[]);expect((await f.engine.status(id,0)).state).to.equal(4n);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);}
   for(const a of pool){expect(await f.engine.candidacy(a)).to.equal(1n);expect(await f.engine.frozenHold(a)).to.equal(0n);}
   await f.market.resolveStale(id);await allFree(f);
  }
 });

 it('draw that fails AT freeze (too few candidates, or request refused) locks nobody; candidates may leave at once; Safe path after the deadline unchanged',async()=>{
  for(const mode of ['short','refused']){
   const f=await loadFixture(fxt);if(mode==='short')await H.keep(f,f.vs.slice(0,2));else await f.mock.controls(true,false);
   const {id,pool}=await filed(f);expect((await f.engine.status(id,0)).state).to.equal(4n);expect(await f.engine.heldPenalty(id,0)).to.equal(0n);await allFree(f);
   await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
   await f.market.connect(await signer(pool[0])).exitVerifier();
   await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);await H.arbitrate(f,id,true);expect((await f.market.jobs(id)).status).to.equal(5n);await allFree(f);
  }
 });

 it('seating turns the selected hold into a seat reservation and frees every candidate; full settlement leaves nothing held anywhere',async()=>{
  const f=await loadFixture(fxt),{id,d,pool}=await filed(f);const c=await H.draw(f,id);
  for(const a of pool){const sel=c.includes(a);expect(await f.engine.frozenHold(a)).to.equal(0n);expect(await f.engine.candidacy(a)).to.equal(0n);expect((await f.market.verifiers(a)).reserved).to.equal(sel?d.penalty:0n);}
  await H.vote(f,id,[true,true,true]);await f.market.resolveDispute(id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.finalizeDispute(id);
  for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved).to.equal(0n);expect(i.duties).to.equal(0n);}await allFree(f);
 });

 it('two open draws: exit-locks add up, capacity does NOT (both lists full); each draw releases only its own lock/hold',async()=>{
  const f=await loadFixture(fxt),A=await filed(f),B=await filed(f);expect(B.pool.length).to.equal(A.pool.length);const both=A.pool.filter(a=>B.pool.includes(a));expect(both.length).to.equal(A.pool.length);
  for(const a of both){expect(await f.engine.candidacy(a)).to.equal(2n);expect(await f.engine.frozenHold(a)).to.equal(0n);}
  const cA=await H.draw(f,A.id);for(const a of both){expect(await f.engine.candidacy(a)).to.equal(1n);expect(await f.engine.frozenHold(a)).to.equal(0n);}
  for(const a of cA)expect((await f.market.verifiers(a)).reserved).to.equal(A.d.penalty);
  await time.increaseTo((await f.market.effectiveProtectedDeadline(B.id))+1n);await f.market.resolveStale(B.id);await allFree(f);
  for(const a of cA)expect((await f.market.verifiers(a)).reserved).to.equal(A.d.penalty);
 });
});
