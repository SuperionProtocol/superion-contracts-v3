// PAUSE / SATURATION FIX — LOCAL PROTOTYPE ONLY (Hardhat 31337). VRF = authored LOCAL MOCK (no proof verification).
// Nothing here touches a public network, the real Safe, or any deployed contract.
// Covers: (b) regression, N1 saturation, pause matrix (a/N2/N3/N4/N6), frozen timers, callback gas bound.
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S,time,mine}=H;const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {network}=require('hardhat');const fs=require('fs'),evidence=[];
const CALLBACK_LIMIT=BigInt(require('../helpers/vrf-config.cjs').BASE_SEPOLIA_PLANNED.callbackGasLimit);
async function fxt(){const f=await H.fixture();f.engine=await oracle(f.market);f.mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());f.terms=await ethers.getContractAt('MissionTerms',await f.market.terms());return f;}
const signer=a=>ethers.getSigner(a);
const escrow=f=>f.market.getAddress().then(a=>f.token.balanceOf(a));
async function job(f,budget='1000',stage='completed'){const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S(budget),3600,'job-'+id);if(stage==='open')return id;await f.market.connect(f.provider).assignJob(id);if(stage==='assigned')return id;await f.market.connect(f.provider).submitResult(id,'r-'+id);return id;}
async function challenge(f,id){await f.market.connect(f.challenger).challengeJob(id,ethers.id('c-'+id));return id;}
async function fulfill(f,id,word=42n){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round);return (await f.mock.fulfill(s.requestId,word)).wait();}
// Off-chain replica of the selection WITHOUT any skip (randomness index n == seat t), optionally for a hypothetical word.
async function prediction(f,id,word){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round),[pool,weights]=await f.engine.population(id,d.round),w=Array.from(weights);let total=w.reduce((a,b)=>a+b,0n);const abi=ethers.AbiCoder.defaultAbiCoder();
 const seed=ethers.keccak256(abi.encode(['bytes32','uint256','address','address','uint256','uint256','uint256','bytes32','uint256'],[await f.engine.DOMAIN(),31337,await f.engine.getAddress(),await f.market.getAddress(),id,d.round,s.requestId,s.snapshotHash,word??s.word]));
 const out=[];for(let t=0;t<Number(s.size);t++){let r=BigInt(ethers.keccak256(abi.encode(['bytes32','uint256'],[seed,t])))%total;let i=0;while(r>=w[i]){r-=w[i];i++;}out.push(pool[i]);total-=w[i];w[i]=0n;}return out;}
async function commitAll(f,id,c,answers){const abi=ethers.AbiCoder.defaultAbiCoder();for(let i=0;i<c.length;i++)if(answers[i]!==null)await f.market.connect(await signer(c[i])).commitVote(id,ethers.keccak256(abi.encode(['bool','bytes32','address','uint256'],[answers[i],ethers.id('s'+i),c[i],id])));}
async function revealAll(f,id,c,answers){for(let i=0;i<c.length;i++)if(answers[i]!==null)await f.market.connect(await signer(c[i])).revealVote(id,answers[i],ethers.id('s'+i));}
function penalized(f,rc){return rc.logs.flatMap(l=>{try{const e=f.market.interface.parseLog(l);return e?.name==='VerifierPenalized'?[e.args]:[];}catch{return[];}});}
async function asSafe(f){const a=await f.safe.getAddress();await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0x56BC75E2D63100000']);return ethers.getSigner(a);}

describe('PAUSE/SATURATION FIX (LOCAL PROTOTYPE, MOCK VRF, not deployed, not audited)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/pause-saturation-fix-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; VRF is a LOCAL MOCK; nothing deployed; not an audit',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 // ------------------------------------------------------------------ (b) regression
 for(const round of [0,1])it(`(b) REGRESSION round${round}: once the VRF result is public, the first selected juror cannot exit, re-register or unstake the bond; the planned jury forms`,async()=>{
  const f=await loadFixture(fxt);let id;
  if(round===0){id=await challenge(f,await job(f));}else{const s=await H.firstVerdict(f,true);id=s.id;await H.fileAppeal(f,s);}
  const d=await f.market.disputes(id);await fulfill(f,id,987n);const expected=await prediction(f,id);expect(Array.from(await f.engine.selection(id,round))).to.deep.equal(expected);
  const v=await signer(expected[0]),infoBefore=await f.market.verifiers(v.address),lockedBefore=await f.staking.lockedStake(v.address);
  expect(await f.engine.frozenHold(v.address)).to.equal(d.penalty);expect(await f.engine.candidacy(v.address)).to.equal(1n);
  await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
  await expect(f.market.connect(v).registerVerifier()).to.be.revertedWithCustomError(f.market,'InvalidState');
  await expect(f.market.connect(v).registerVerifierWithStake(S('5000'))).to.be.revertedWithCustomError(f.market,'InvalidState');
  await expect(f.staking.connect(v).requestUnstake(await f.staking.balanceOf(v.address))).to.be.revertedWithCustomError(f.staking,'InsufficientUnlocked');
  expect(await f.market.verifiers(v.address)).to.deep.equal(infoBefore);expect(await f.staking.lockedStake(v.address)).to.equal(lockedBefore);
  const next=await f.mock.nextRequest();await f.market.drawCommittee(id);
  expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(expected);expect((await f.market.disputes(id)).phase).to.equal(2n);expect(await f.mock.nextRequest()).to.equal(next);
  evidence.push({case:'b-regression-round'+round,selected:expected,exitReverted:'StakeReserved',committeeAsPlanned:true});
 });
 it('(b) REGRESSION with penalty 0 (previous documented limit "penalty 0 => no lock"): candidates are still exit-locked, the planned jury forms',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,penaltyBps:0,minPenalty:0n});const id=await challenge(f,await job(f));expect((await f.market.disputes(id)).penalty).to.equal(0n);
  await fulfill(f,id,5n);const sel=Array.from(await f.engine.selection(id,0));for(const a of sel){expect(await f.engine.frozenHold(a)).to.equal(0n);await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');}
  await f.market.drawCommittee(id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(sel);
  evidence.push({case:'b-regression-penalty-0',exitLockedWithoutPenalty:true});
 });
 it('(b) REGRESSION during a pause: result delivered while paused, the selected juror still cannot exit; seating while paused works',async()=>{
  const f=await loadFixture(fxt),id=await challenge(f,await job(f));await f.market.pause();await time.increase(30*86400);await fulfill(f,id,77n);const sel=Array.from(await f.engine.selection(id,0));
  for(const a of sel)await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
  await f.market.drawCommittee(id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(sel);
 });

 // ------------------------------------------------------------------ N1 saturation
 for(const order of ['spam-first','real-first'])it(`N1 FIX (${order}): ten 1-SUPER disputes no longer saturate the verifiers; a real dispute filed meanwhile gets all 10 candidates and a real jury (not the Safe)`,async()=>{
  const f=await loadFixture(fxt),spam=[];for(let i=0;i<10;i++)spam.push(await challenge(f,await job(f,'1')));
  const sd=await f.market.disputes(spam[0]);expect(sd.penalty).to.equal(S('100'));expect(sd.bond).to.equal(S('30'));
  for(const v of f.vs){expect(await f.engine.candidacy(v.address)).to.equal(10n);expect(await f.engine.frozenHold(v.address)).to.equal(0n);}
  const real=await challenge(f,await job(f,'1000'));const st=await f.engine.status(real,0);expect(st.count).to.equal(10n);expect(st.state).to.equal(1n); // baseline: 0 candidates -> Failed -> Safe
  if(order==='spam-first')for(const id of spam)await fulfill(f,id,BigInt(id));
  await fulfill(f,real,4242n);if(order==='real-first')for(const id of spam)await fulfill(f,id,BigInt(id));
  for(const id of [...spam,real])expect((await f.engine.status(id,0)).state).to.equal(2n);
  let maxHeld=0n;for(const v of f.vs){const h=await f.engine.frozenHold(v.address);if(h>maxHeld)maxHeld=h;expect(h).to.be.at.most((await f.market.verifiers(v.address)).bond);}
  await f.market.drawCommittee(real);expect((await f.market.disputes(real)).phase).to.equal(2n);expect((await f.market.committeeOf(real)).length).to.equal(3);
  for(const id of spam)await f.market.drawCommittee(id);
  for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved).to.be.at.most(i.bond);expect(await f.engine.candidacy(v.address)).to.equal(0n);expect(await f.engine.frozenHold(v.address)).to.equal(0n);}
  evidence.push({case:'n1-saturation-'+order,spamDisputes:10,spamPenalty:sd.penalty,spamBondEach:sd.bond,realCandidates:st.count,realPhase:'Voting',maxSelectedHoldOnOneVerifier:maxHeld});
 });
 it('N1 residual (documented): seats still stack, so a real dispute whose penalty equals the whole bond can be blocked by spam juries ALREADY drawn before its result; it then fails cleanly to the Safe, nothing overcommitted',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,penaltyBps:10000});const realJob=await job(f,'1000');await f.terms.setParams(P);
  const spam=[];for(let i=0;i<10;i++)spam.push(await challenge(f,await job(f,'1')));const real=await challenge(f,realJob);expect((await f.market.disputes(real)).penalty).to.equal(S('1000'));expect((await f.engine.status(real,0)).count).to.equal(10n);
  for(const id of spam)await fulfill(f,id,BigInt(id)*7919n);let free=0;for(const v of f.vs)if((await f.engine.frozenHold(v.address))===0n)free++;
  await fulfill(f,real,1n);const state=(await f.engine.status(real,0)).state;
  if(free<3){expect(state).to.equal(4n);await expect(f.market.drawCommittee(real)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');await time.increaseTo((await f.market.effectiveProtectedDeadline(real))+1n);await f.market.resolveStale(real);expect((await f.market.disputes(real)).phase).to.equal(5n);}
  else{expect(state).to.equal(2n);await f.market.drawCommittee(real);}
  for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved+await f.engine.frozenHold(v.address)).to.be.at.most(i.bond);}
  evidence.push({case:'n1-residual-full-bond-penalty',verifiersWithoutSpamSeat:free,realOutcome:state===4n?'Failed->Safe':'Ready->Voting'});
 });

 it('STACKING (adapted probe H3): a 1000-bond verifier can be a candidate of two 1000-penalty draws, but once selected by the first public result it is SKIPPED by the second (no stake backs two seats)',async()=>{
  const f=await loadFixture(fxt);for(const v of f.vs.slice(0,9)){await f.market.connect(v).exitVerifier();await f.market.connect(v).registerVerifierWithStake(S('10000'));}await f.staking.connect(f.provider).stake(S('60000'));
  const v9=f.vs[9].address;const A=await challenge(f,await job(f,'20000')),B=await challenge(f,await job(f,'20000'));expect((await f.market.disputes(A)).penalty).to.equal(S('1000'));
  const [pA]=await f.engine.population(A,0),[pB]=await f.engine.population(B,0);expect(pA.includes(v9)&&pB.includes(v9)).to.equal(true);expect(await f.engine.candidacy(v9)).to.equal(2n);
  let wa=0n;while(!(await prediction(f,A,wa)).includes(v9))wa++;await fulfill(f,A,wa);expect(Array.from(await f.engine.selection(A,0))).to.include(v9);expect(await f.engine.frozenHold(v9)).to.equal(S('1000'));
  let wb=0n;while(!(await prediction(f,B,wb)).includes(v9))wb++;const naive=await prediction(f,B,wb);await fulfill(f,B,wb);const selB=Array.from(await f.engine.selection(B,0));
  expect((await f.engine.status(B,0)).state).to.equal(2n);expect(selB).to.not.include(v9);expect(selB.length).to.equal(3);expect(await f.engine.frozenHold(v9)).to.equal(S('1000'));
  for(const v of f.vs){const i=await f.market.verifiers(v.address);expect(i.reserved+await f.engine.frozenHold(v.address)).to.be.at.most(i.bond);}
  await f.market.drawCommittee(A);await f.market.drawCommittee(B);expect(Array.from(await f.market.committeeOf(B))).to.deep.equal(selB);
  evidence.push({case:'stacking-skip',naiveSelectionB:naive,actualSelectionB:selB,skipped:v9});
 });
 it('ATOMICITY (adapted probe H4): drawCommittee running out of gas rolls back everything; Ready state, selected holds and exit-locks stay intact, then a normal call seats the same jury',async()=>{
  const f=await loadFixture(fxt),id=await challenge(f,await job(f)),d=await f.market.disputes(id);await fulfill(f,id,1n);const sel=Array.from(await f.engine.selection(id,0)),[pool]=await f.engine.population(id,0);
  await expect(f.market.drawCommittee(id,{gasLimit:150000})).to.be.reverted;expect((await f.engine.status(id,0)).state).to.equal(2n);
  for(const a of pool){expect(await f.engine.frozenHold(a)).to.equal(sel.includes(a)?d.penalty:0n);expect(await f.engine.candidacy(a)).to.equal(1n);}
  const g=await(await f.market.drawCommittee(id)).wait();expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(sel);evidence.push({case:'drawCommittee-atomic',drawCommitteeGas:g.gasUsed});
 });

 // ------------------------------------------------------------------ pause matrix
 it('PAUSE MATRIX: every money/work path while paused, with the escrow change of each real transaction',async()=>{
  const f=await loadFixture(fxt),rows=[];const row=async(label,fn,expectErr)=>{const e0=await escrow(f);let result='OK';try{const tx=await fn();await tx.wait?.();}catch(e){const m=String(e.message||e).match(/custom error '([A-Za-z]+)/)||String(e.message||e).match(/reason string '([A-Z0-9]+)'/);result=m?m[1]:("REVERT:"+String(e.message||e).slice(0,300));}const delta=(await escrow(f))-e0;rows.push({action:label,result,escrowDelta:delta});if(expectErr)expect(result,label).to.equal(expectErr);return delta;};
  const open=await job(f,'1000','open'),assignable=await job(f,'1000','open'),expired=await job(f,'1000','assigned'),finOld=await job(f);
  // disputes in different states
  const decOld=await H.firstVerdict(f,true);                                                      // Decided, will expire before pause
  const r1=await H.firstVerdict(f,true);await H.fileAppeal(f,r1);await H.draw(f,r1.id);await H.vote(f,r1.id,[true,true,true,true,true]); // appeal Voting, all revealed
  const staleD=await challenge(f,await job(f));                                                   // Draw, will expire before pause
  await time.increaseTo((await f.market.effectiveProtectedDeadline(staleD))+1n);                   // finOld, decOld, staleD windows expire BEFORE the pause
  const ready=await challenge(f,await job(f));                                                    // Draw, result arrives during pause
  const r0b=await challenge(f,await job(f));await H.draw(f,r0b);await H.vote(f,r0b,[true,true,true]); // round-0 Voting, all revealed
  const dec2=await H.firstVerdict(f,true),finNew2=await job(f),toSubmit=await job(f,'1000','assigned'); // windows still OPEN at the pause
  await f.token.transfer(f.outsider.address,S('2000'));await f.token.connect(f.outsider).approve(await f.staking.getAddress(),ethers.MaxUint256);await f.staking.connect(f.outsider).stake(S('2000'));
  await f.market.pause();
  // delivery deadline stays wall-clock (existing policy) but the provider CAN still deliver while paused; its challenge window starts frozen
  await row('submitResult during pause (no money; challenge window starts frozen)',()=>f.market.connect(f.provider).submitResult(toSubmit,'in-pause'),'OK');
  await time.increase(30*86400);
  await row('createJob',()=>f.market.connect(f.creator).createJob(S('10'),3600,'x'),'EnforcedPause');
  await row('assignJob',()=>f.market.connect(f.provider).assignJob(assignable),'EnforcedPause');
  await row('cancelJob (Open mission)',()=>f.market.connect(f.creator).cancelJob(open),'EnforcedPause');
  await row('reclaimExpired (delivery deadline passed)',()=>f.market.connect(f.creator).reclaimExpired(expired),'EnforcedPause');
  await row('challengeJob',()=>f.market.connect(f.challenger).challengeJob(finNew2,ethers.id('p')),'EnforcedPause');
  await row('appeal',()=>f.market.connect(f.creator).appeal(dec2.id),'EnforcedPause');
  await row('resolveDispute round 0',()=>f.market.resolveDispute(r0b),'EnforcedPause');
  await row('resolveDispute round 1 (appeal, would pay)',()=>f.market.resolveDispute(r1.id),'EnforcedPause');
  const safeSigner=await asSafe(f); // TEST-ONLY impersonation of the local Safe (ARBITER_ROLE) to read the market error directly
  await row('arbitrate (ARBITER_ROLE = Safe)',()=>f.market.connect(safeSigner).arbitrate(staleD,true),'EnforcedPause');
  await network.provider.send('hardhat_stopImpersonatingAccount',[await f.safe.getAddress()]);
  await row('arbitrate via Safe 2/3 execTransaction',()=>H.arbitrate(f,staleD,true),'GS013');
  await row('finalizeJob, challenge window still open before pause',()=>f.market.finalizeJob(finNew2),'TooEarly');
  const dJob=await row('finalizeJob, challenge window expired BEFORE pause (N2 fix)',()=>f.market.finalizeJob(finOld),'OK');expect(dJob).to.equal(-S('1000'));expect((await f.market.jobs(finOld)).status).to.equal(5n);
  await row('finalizeDispute, appeal window still open before pause',()=>f.market.finalizeDispute(dec2.id),'TooEarly');
  await row('finalizeDispute, appeal window expired BEFORE pause',()=>f.market.finalizeDispute(decOld.id),'OK');
  await row('resolveStale, Draw expired BEFORE pause (escalation only)',()=>f.market.resolveStale(staleD),'OK');
  await row('resolveStale, Draw not expired (frozen)',()=>f.market.resolveStale(ready),'TooEarly');
  await row('VRF result + drawCommittee during pause (vote clocks frozen)',async()=>{await fulfill(f,ready,3n);return f.market.drawCommittee(ready);},'OK');
  await row('registerVerifier (newcomer, own stake only)',()=>f.market.connect(f.outsider).registerVerifier(),'OK');
  await row('exitVerifier (free newcomer, own stake only)',()=>f.market.connect(f.outsider).exitVerifier(),'OK');
  for(const r of rows)if(!['finalizeJob, challenge window expired BEFORE pause (N2 fix)','finalizeDispute, appeal window expired BEFORE pause'].includes(r.action))expect(r.escrowDelta,r.action).to.equal(0n);
  // after unpause the delayed actions work again; nothing was lost
  await f.market.unpause();await f.market.connect(f.creator).cancelJob(open);await f.market.connect(f.creator).reclaimExpired(expired);await f.market.resolveDispute(r1.id);await f.market.resolveDispute(r0b);await H.arbitrate(f,staleD,true);
  await f.market.connect(f.challenger).challengeJob(finNew2,ethers.id('after'));await f.market.connect(f.creator).appeal(dec2.id);
  const pend=(await f.market.effectiveProtectedDeadline(toSubmit))-BigInt(await time.latest());expect(pend).to.be.greaterThan(BigInt(P.challengePeriod)-10n); // ~full challenge window after a 30-day pause
  evidence.push({case:'pause-matrix',rows});
 });

 // ------------------------------------------------------------------ frozen timers
 it('TIMERS: challenge window with 90 s left survives a 30-day pause (still ~90 s after resume)',async()=>{
  const f=await loadFixture(fxt),id=await job(f);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))-90n);await f.market.pause();const left=(await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());
  await time.increase(30*86400);await expect(f.market.finalizeJob(id)).to.be.revertedWithCustomError(f.market,'TooEarly');await f.market.unpause();
  expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(left);await f.market.connect(f.challenger).challengeJob(id,ethers.id('in-time'));
  evidence.push({case:'challenge-window-frozen',secondsLeftAtPause:left,pauseDays:30});
 });
 it('TIMERS (N4): a committee formed DURING a 30-day pause loses no vote time; nobody is slashed for paused time; full settlement without any penalty',async()=>{
  const f=await loadFixture(fxt),id=await challenge(f,await job(f));await f.market.pause();await fulfill(f,id,11n);await f.market.drawCommittee(id);const c=Array.from(await f.market.committeeOf(id));
  await time.increase(30*86400);await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market,'EnforcedPause');
  await f.market.unpause();const answers=[true,true,true];await commitAll(f,id,c,answers);const rd=await f.market.rounds(id,0);
  // reveal opens only after the remaining ACTIVE commit time; wall time already far beyond the stored value would not matter
  await time.increase(P.voteCommitWindow);await revealAll(f,id,c,answers);const rc=await(await f.market.resolveDispute(id)).wait();expect(penalized(f,rc).length).to.equal(0);
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);const rc2=await(await f.market.finalizeDispute(id)).wait();expect(penalized(f,rc2).length).to.equal(0);
  for(const a of c)expect((await f.market.verifiers(a)).bond).to.equal(S('1000'));
  evidence.push({case:'vote-clock-frozen-committee-formed-in-pause',pauseDays:30,penalties:0,storedCommitDeadline:rd.commitDeadline});
 });
 it('TIMERS (N4): a juror who never reveals is slashed only after the ACTIVE reveal window, never for time spent in the pause',async()=>{
  const f=await loadFixture(fxt),id=await challenge(f,await job(f));await H.draw(f,id);const c=Array.from(await f.market.committeeOf(id)),answers=[true,true,null];await commitAll(f,id,c,answers);
  await f.market.pause();await time.increase(30*86400);await f.market.unpause();
  // the three jurors still had all their commit time: the 3rd commits after the pause, then simply never reveals
  const abi=ethers.AbiCoder.defaultAbiCoder();await f.market.connect(await signer(c[2])).commitVote(id,ethers.keccak256(abi.encode(['bool','bytes32','address','uint256'],[false,ethers.id('x'),c[2],id])));
  await time.increase(P.voteCommitWindow);await revealAll(f,id,c,answers);await expect(f.market.resolveDispute(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await time.increase(P.voteRevealWindow);const rc=await(await f.market.resolveDispute(id)).wait();await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);const rc2=await(await f.market.finalizeDispute(id)).wait();
  const p=penalized(f,rc2);expect(p.length).to.equal(1);expect(p[0].verifier).to.equal(c[2]);expect(penalized(f,rc).length).to.equal(0);
 });
 it('TIMERS (N6): VRF never answers during a long pause: candidates stay exit-locked (bond intact, never slashed) and are released after resume + remaining Draw window',async()=>{
  const f=await loadFixture(fxt),id=await challenge(f,await job(f)),[pool]=await f.engine.population(id,0);await time.increase(600);await f.market.pause();const left=(await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());
  await time.increase(60*86400);for(const a of pool)await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await f.market.unpause();expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(left);await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);
  for(const a of pool){expect(await f.engine.candidacy(a)).to.equal(0n);expect((await f.market.verifiers(a)).bond).to.equal(S('1000'));await f.market.connect(await signer(a)).exitVerifier();}
  evidence.push({case:'n6-vrf-silent-long-pause',pauseDays:60,drawSecondsLeftAtPause:left,releasedAfter:'resume + remaining Draw window',slashed:0});
 });

 // ------------------------------------------------------------------ callback gas at the skip cap
 // THREE-LIMITS FIX (1), ADAPTED TITLE ONLY: the skip cap is now size+MAX_SKIPS (40, was 10); same assertion (< 80 % of the limit).
 it('GAS: worst case callback (200 candidates, 13 seats, most candidates already held elsewhere -> skip cap size+MAX_SKIPS reached -> Failed) stays under 80 % of the planned limit',async function(){
  this.timeout(600000);const f=await loadFixture(fxt);
  for(let i=0;i<190;i++){const a=ethers.getAddress(ethers.toBeHex(300000+i,20));await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0x56BC75E2D63100000']);const v=await ethers.getSigner(a);await f.token.transfer(a,S('1000'));await f.token.connect(v).approve(await f.staking.getAddress(),S('1000'));await f.staking.connect(v).stake(S('1000'));await f.market.connect(v).registerVerifier();}
  await f.terms.setParams({...P,committeeSize:13,appealCommitteeSize:15,penaltyBps:10000});const X=await job(f,'1000');await f.terms.setParams({...P,committeeSize:13,appealCommitteeSize:15});
  await challenge(f,X);expect((await f.market.disputes(X)).penalty).to.equal(S('1000'));expect((await f.engine.status(X,0)).count).to.equal(200n);
  const ys=[];for(let k=0;k<25;k++){const y=await challenge(f,await job(f,'1'));await fulfill(f,y,BigInt(k)*1000003n+7n);ys.push(y);}
  let free=0;const [pool]=await f.engine.population(X,0);for(const a of pool)if((await f.engine.frozenHold(a))===0n)free++;
  const rc=await fulfill(f,X,99n);const st=(await f.engine.status(X,0)).state;expect(rc.gasUsed).to.be.lessThan(CALLBACK_LIMIT*8n/10n);
  evidence.push({case:'callback-gas-skip-worst',candidates:200,seats:13,freeCandidatesAtResult:free,finalState:st===4n?'Failed (skip cap) -> Safe path':'Ready',mockTxGas:rc.gasUsed,plannedLimit:CALLBACK_LIMIT});
 });
});
