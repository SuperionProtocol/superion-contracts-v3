// THREE-LIMITS FIX — LOCAL PROTOTYPE ONLY (Hardhat 31337). VRF = authored LOCAL MOCK (no proof verification).
// Nothing here touches a public network, the real Safe, or any deployed contract.
// (1) skip budget: a real dispute is no longer sent to the Safe after 10 saturated hits while capacity exists in the list;
// (2) a drawn juror slashed elsewhere before drawCommittee is STILL seated (seat penalty held atomically with the result);
// (3) once the result is public, non-selected candidates can leave (engine.releaseCandidate, then exitVerifier).
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S,time}=H;const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {network}=require('hardhat');const fs=require('fs'),evidence=[];
const CALLBACK_LIMIT=BigInt(require('../helpers/vrf-config.cjs').BASE_SEPOLIA_PLANNED.callbackGasLimit);
async function fxt(){const f=await H.fixture();f.engine=await oracle(f.market);f.mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());f.terms=await ethers.getContractAt('MissionTerms',await f.market.terms());return f;}
async function bigFxt(){const f=await fxt();f.extra=[];for(let i=0;i<40;i++){const a=ethers.getAddress(ethers.toBeHex(700000+i,20));await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0x56BC75E2D63100000']);const v=await ethers.getSigner(a);await f.token.transfer(a,S('1000'));await f.token.connect(v).approve(await f.staking.getAddress(),S('1000'));await f.staking.connect(v).stake(S('1000'));await f.market.connect(v).registerVerifier();f.extra.push(v);}return f;}
const signer=a=>ethers.getSigner(a);
async function job(f,budget='1000',stage='completed'){const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S(budget),3600,'job-'+id);if(stage==='open')return id;await f.market.connect(f.provider).assignJob(id);if(stage==='assigned')return id;await f.market.connect(f.provider).submitResult(id,'r-'+id);return id;}
async function challenge(f,id){await f.market.connect(f.challenger).challengeJob(id,ethers.id('c-'+id));return id;}
async function fulfill(f,id,word=42n){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round);return (await f.mock.fulfill(s.requestId,word)).wait();}
async function invariant(f,addrs){for(const a of addrs){const i=await f.market.verifiers(a);expect(i.reserved+await f.engine.frozenHold(a)).to.be.at.most(i.bond);}}
// Off-chain replica of the on-chain selection WITH the capacity skip rule, on the CURRENT state (before the result).
async function simulate(f,id,word){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round),[pool,weights]=await f.engine.population(id,d.round),w=Array.from(weights);let total=w.reduce((a,b)=>a+b,0n);const abi=ethers.AbiCoder.defaultAbiCoder();
 const ok=[];for(const a of pool){const i=await f.market.verifiers(a);ok.push(i.indexPlus1!==0n&&i.bond>=i.reserved+(await f.engine.frozenHold(a))+d.penalty);}
 const seed=ethers.keccak256(abi.encode(['bytes32','uint256','address','address','uint256','uint256','uint256','bytes32','uint256'],[await f.engine.DOMAIN(),31337,await f.engine.getAddress(),await f.market.getAddress(),id,d.round,s.requestId,s.snapshotHash,word]));
 const picks=[],skipped=[];let n=0;while(picks.length<Number(s.size)){if(total===0n)return {picks:null,draws:n,skipped,free:ok.filter(Boolean).length};let r=BigInt(ethers.keccak256(abi.encode(['bytes32','uint256'],[seed,n])))%total;let i=0;while(r>=w[i]){r-=w[i];i++;}total-=w[i];w[i]=0n;n++;if(ok[i])picks.push(pool[i]);else skipped.push(pool[i]);}
 return {picks,draws:n,skipped,free:ok.filter(Boolean).length};}
function penalized(f,rc){return rc.logs.flatMap(l=>{try{const e=f.market.interface.parseLog(l);return e?.name==='VerifierPenalized'?[e.args]:[];}catch{return[];}});}

describe('THREE-LIMITS FIX (LOCAL PROTOTYPE, MOCK VRF, not deployed, not audited)',function(){
 this.timeout(600000);
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/trois-limites-fix-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; VRF is a LOCAL MOCK; nothing deployed; not an audit',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 // ------------------------------------------------------------------ (1) saturation / skip budget
 it('(1) FIX: a real full-bond-penalty dispute whose result needs MORE than 10 skips (many verifiers already drawn on spam seats, enough capacity left) gets a real jury, not the Safe (start code: Failed after 10 skips)',async()=>{
  const f=await loadFixture(bigFxt);const all=[...f.vs,...f.extra].map(v=>v.address);
  await f.terms.setParams({...P,penaltyBps:10000});const realJob=await job(f,'1000');await f.terms.setParams(P);
  const X=await challenge(f,realJob);expect((await f.market.disputes(X)).penalty).to.equal(S('1000'));expect((await f.engine.status(X,0)).count).to.equal(50n);
  for(let k=0;k<12;k++){const y=await challenge(f,await job(f,'1'));await fulfill(f,y,BigInt(k)*7919n+3n);}
  let word=0n,sim;for(;;word++){sim=await simulate(f,X,word);if(sim.picks&&sim.draws>13&&sim.draws<=3+40)break;}
  const maxHeldSeats=Math.max(...await Promise.all(all.map(async a=>Number((await f.engine.frozenHold(a))/S('100')))));
  const rc=await fulfill(f,X,word);const st=await f.engine.status(X,0);expect(st.state).to.equal(2n);
  expect(Array.from(await f.engine.selection(X,0))).to.deep.equal(sim.picks);for(const a of sim.picks)expect(await f.engine.frozenHold(a)).to.equal(S('1000'));await invariant(f,all);
  await f.market.drawCommittee(X);expect((await f.market.disputes(X)).phase).to.equal(2n);expect(Array.from(await f.market.committeeOf(X))).to.deep.equal(sim.picks);await invariant(f,all);
  evidence.push({case:'fix1-skip-budget',candidates:50,freeCandidatesAtResult:sim.free,drawsNeeded:sim.draws,skips:sim.draws-3,oldBudget:'size+10=13 draws -> Failed->Safe on the start code',newBudget:'size+40',maxSpamSeatsOnOneVerifier:maxHeldSeats,callbackTxGas:rc.gasUsed,outcome:'Ready->Voting'});
 });
 it('(1) still bounded: when fewer than `size` candidates of the frozen list have free capacity (pool genuinely saturated), the draw fails cleanly to the Safe path; nothing is overcommitted, candidates are released',async()=>{
  const f=await loadFixture(fxt);const all=f.vs.map(v=>v.address);await f.terms.setParams({...P,penaltyBps:10000});const realJob=await job(f,'1000');await f.terms.setParams(P);
  const X=await challenge(f,realJob);for(let k=0;k<6;k++){const y=await challenge(f,await job(f,'1'));await fulfill(f,y,BigInt(k)*104729n+1n);}
  let free=0;for(const a of all)if((await f.engine.frozenHold(a))===0n)free++;
  if(free>=3){const extra=[];for(let k=0;k<10&&free>=3;k++){const y=await challenge(f,await job(f,'1'));await fulfill(f,y,BigInt(k)*31n+5n);extra.push(y);free=0;for(const a of all)if((await f.engine.frozenHold(a))===0n)free++;}}
  expect(free).to.be.lessThan(3);await fulfill(f,X,1n);expect((await f.engine.status(X,0)).state).to.equal(4n);await invariant(f,all);
  await expect(f.market.drawCommittee(X)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');await time.increaseTo((await f.market.effectiveProtectedDeadline(X))+1n);await f.market.resolveStale(X);expect((await f.market.disputes(X)).phase).to.equal(5n);
  evidence.push({case:'fix1-residual-pool-exhausted',freeCandidates:free,outcome:'Failed->Safe (documented residual: no free capacity, coverage never diluted)'});
 });
 it('(1) GAS: worst case at the new skip cap (200 candidates, 13 seats, size+40 draws, all but a few saturated) stays under 80 % of the planned callback limit',async()=>{
  const f=await loadFixture(fxt);
  for(let i=0;i<190;i++){const a=ethers.getAddress(ethers.toBeHex(800000+i,20));await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0x56BC75E2D63100000']);const v=await ethers.getSigner(a);await f.token.transfer(a,S('1000'));await f.token.connect(v).approve(await f.staking.getAddress(),S('1000'));await f.staking.connect(v).stake(S('1000'));await f.market.connect(v).registerVerifier();}
  await f.terms.setParams({...P,committeeSize:13,appealCommitteeSize:15,penaltyBps:10000});const X=await job(f,'1000');await f.terms.setParams({...P,committeeSize:13,appealCommitteeSize:15});await challenge(f,X);
  for(let k=0;k<60;k++){const y=await challenge(f,await job(f,'1'));await fulfill(f,y,BigInt(k)*1000003n+7n);}
  const sim=await simulate(f,X,99n);const rc=await fulfill(f,X,99n);const st=(await f.engine.status(X,0)).state;expect(rc.gasUsed).to.be.lessThan(CALLBACK_LIMIT*8n/10n);
  expect(st).to.equal(sim.picks&&sim.draws<=53?2n:4n);
  evidence.push({case:'fix1-callback-gas-worst',candidates:200,seats:13,maxDraws:53,freeCandidatesAtResult:sim.free,finalState:st===4n?'Failed (skip cap) -> Safe path':'Ready',mockTxGas:rc.gasUsed,plannedLimit:CALLBACK_LIMIT});
 });

 // ------------------------------------------------------------------ (2) drawn juror slashed elsewhere before drawCommittee
 it('(2) FIX: a drawn juror slashed on ANOTHER mission (non-reveal) and dropped from the registry before drawCommittee is still seated; the deserved penalty is fully applied (start code: NotEnoughVerifiers -> Safe)',async()=>{
  const f=await loadFixture(fxt);const all=f.vs.map(v=>v.address);
  const other=await challenge(f,await job(f));await H.draw(f,other);const c=Array.from(await f.market.committeeOf(other)),J=c[2];const od=await f.market.disputes(other),rd=await f.market.rounds(other,0),abi=ethers.AbiCoder.defaultAbiCoder();
  for(let i=0;i<3;i++)await f.market.connect(await signer(c[i])).commitVote(other,ethers.keccak256(abi.encode(['bool','bytes32','address','uint256'],[true,ethers.id('o'+i),c[i],other])));
  await time.increaseTo(rd.commitDeadline+1n);for(let i=0;i<2;i++)await f.market.connect(await signer(c[i])).revealVote(other,true,ethers.id('o'+i)); // J never reveals
  await time.increaseTo(rd.revealDeadline+1n);await f.market.resolveDispute(other);
  const X=await challenge(f,await job(f));let word=0n,sim;for(;;word++){sim=await simulate(f,X,word);if(sim.picks&&sim.picks.includes(J))break;}
  await fulfill(f,X,word);expect(Array.from(await f.engine.selection(X,0))).to.deep.equal(sim.picks);
  await expect(f.market.connect(await signer(J)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
  await time.increaseTo((await f.market.effectiveProtectedDeadline(other))+1n);const rc=await(await f.market.finalizeDispute(other)).wait();
  const p=penalized(f,rc);expect(p.map(x=>x.verifier)).to.deep.equal([J]);expect(p[0].amount).to.equal(od.penalty);
  const after=await f.market.verifiers(J);expect(after.bond).to.equal(S('900'));expect(after.indexPlus1).to.equal(0n); // below minVerifierStake: dropped from the registry
  await f.market.drawCommittee(X);expect(Array.from(await f.market.committeeOf(X))).to.deep.equal(sim.picks);expect((await f.market.disputes(X)).phase).to.equal(2n);
  const seated=await f.market.verifiers(J);expect(seated.reserved).to.equal((await f.market.disputes(X)).penalty);expect(seated.duties).to.equal(1n);await invariant(f,all);
  await expect(f.market.connect(await signer(J)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
  // the jury works normally; afterwards J can leave with what is left of its bond
  await H.vote(f,X,[true,true,true]);await f.market.resolveDispute(X);await time.increaseTo((await f.market.effectiveProtectedDeadline(X))+1n);await f.market.finalizeDispute(X);
  const before=await f.staking.lockedStake(J);await f.market.connect(await signer(J)).exitVerifier();expect(await f.staking.lockedStake(J)).to.equal(before-S('900'));
  evidence.push({case:'fix2-slashed-drawn-juror-still-seated',juror:J,bondAfterDeservedPenalty:after.bond,removedFromRegistry:true,seated:true,oldOutcome:'NotEnoughVerifiers -> Safe'});
 });
 it('(2) no cheap sabotage: a drawn juror who gets himself slashed elsewhere on purpose cannot break the jury, cannot leave, and pays the full penalty; a third party cannot change the jury either',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,minVerifierStake:S('500'),maxPenalty:S('500')});const abi=ethers.AbiCoder.defaultAbiCoder();
  const other=await challenge(f,await job(f));await H.draw(f,other);const c=Array.from(await f.market.committeeOf(other)),J=c[2];const rd=await f.market.rounds(other,0);
  const X=await challenge(f,await job(f));let word=0n,sim;for(;;word++){sim=await simulate(f,X,word);if(sim.picks&&sim.picks.includes(J))break;}
  await fulfill(f,X,word);const [pool]=await f.engine.population(X,0);
  for(let i=0;i<3;i++)await f.market.connect(await signer(c[i])).commitVote(other,ethers.keccak256(abi.encode(['bool','bytes32','address','uint256'],[true,ethers.id('s'+i),c[i],other])));
  await time.increaseTo(rd.commitDeadline+1n);for(let i=0;i<2;i++)await f.market.connect(await signer(c[i])).revealVote(other,true,ethers.id('s'+i)); // J withholds on purpose
  await time.increaseTo(rd.revealDeadline+1n);await f.market.resolveDispute(other);await time.increaseTo((await f.market.effectiveProtectedDeadline(other))+1n);
  const rc=await(await f.market.finalizeDispute(other)).wait();expect(penalized(f,rc).map(x=>x.verifier)).to.deep.equal([J]);
  expect((await f.market.verifiers(J)).bond).to.equal(S('900'));await expect(f.market.connect(await signer(J)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
  for(const a of sim.picks)await expect(f.engine.connect(f.outsider).releaseCandidate(X,0,pool.indexOf(a))).to.be.revertedWithCustomError(f.engine,'StillLocked');
  await f.market.connect(f.outsider).drawCommittee(X);expect(Array.from(await f.market.committeeOf(X))).to.deep.equal(sim.picks);
  evidence.push({case:'fix2-no-cheap-sabotage',saboteur:J,penaltyPaid:S('100'),juryAsDrawn:true});
 });

 // ------------------------------------------------------------------ (3) non-selected candidates can leave once the result is public
 it('(3) FIX: once the result is public a NON-selected candidate is released (releaseCandidate) and can exitVerifier with its bond; selected jurors and the Pending phase stay locked; seating still works, no double release',async()=>{
  const f=await loadFixture(fxt);const X=await challenge(f,await job(f));const [pool]=await f.engine.population(X,0);
  for(let i=0;i<pool.length;i++)await expect(f.engine.releaseCandidate(X,0,i)).to.be.revertedWithCustomError(f.engine,'StillLocked'); // Pending: (b) unchanged
  await fulfill(f,X,555n);const sel=Array.from(await f.engine.selection(X,0));const others=pool.filter(a=>!sel.includes(a));
  for(const a of sel){await expect(f.engine.releaseCandidate(X,0,pool.indexOf(a))).to.be.revertedWithCustomError(f.engine,'StillLocked');await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');}
  const leaver=others[0],li=pool.indexOf(leaver);await expect(f.market.connect(await signer(leaver)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved'); // start-code behaviour until release
  await f.engine.connect(f.outsider).releaseCandidate(X,0,li); // permissionless: frees only a non-selected candidate
  await expect(f.engine.releaseCandidate(X,0,li)).to.be.revertedWithCustomError(f.engine,'StillLocked');await expect(f.engine.releaseCandidate(X,0,pool.length)).to.be.revertedWithCustomError(f.engine,'StillLocked');
  expect(await f.engine.candidacy(leaver)).to.equal(0n);const locked=await f.staking.lockedStake(leaver);await f.market.connect(await signer(leaver)).exitVerifier();expect(await f.staking.lockedStake(leaver)).to.equal(locked-S('1000'));
  await f.market.drawCommittee(X);expect(Array.from(await f.market.committeeOf(X))).to.deep.equal(sel);
  for(const a of pool)expect(await f.engine.candidacy(a)).to.equal(0n);
  await expect(f.engine.releaseCandidate(X,0,pool.indexOf(others[1]))).to.be.revertedWithCustomError(f.engine,'StillLocked'); // Consumed: nothing left to release
  evidence.push({case:'fix3-non-selected-exit-after-result',selected:sel,leaver,exitAfterRelease:true,selectedStillLocked:true});
 });
 it('(3) skipped candidates (drawn but without capacity) and every candidate of a Failed draw can be released before the unseated close; the close never double-counts',async()=>{
  const f=await loadFixture(fxt);for(const v of f.vs.slice(0,9)){await f.market.connect(v).exitVerifier();await f.market.connect(v).registerVerifierWithStake(S('10000'));}await f.staking.connect(f.provider).stake(S('60000'));
  const v9=f.vs[9].address;const A=await challenge(f,await job(f,'20000')),B=await challenge(f,await job(f,'20000'));
  let wa=0n;for(;;wa++){const s=await simulate(f,A,wa);if(s.picks&&s.picks.includes(v9))break;}await fulfill(f,A,wa);
  let wb=0n,sb;for(;;wb++){sb=await simulate(f,B,wb);if(sb.picks&&sb.skipped.includes(v9))break;}await fulfill(f,B,wb);
  const [pB]=await f.engine.population(B,0);expect(Array.from(await f.engine.selection(B,0))).to.not.include(v9);expect(await f.engine.candidacy(v9)).to.equal(2n);
  await f.engine.releaseCandidate(B,0,pB.indexOf(v9));expect(await f.engine.candidacy(v9)).to.equal(1n); // still a selected juror of A
  await expect(f.engine.releaseCandidate(A,0,(await f.engine.population(A,0))[0].indexOf(v9))).to.be.revertedWithCustomError(f.engine,'StillLocked');
  // a Failed draw: everybody can be released at once, then the Safe path closes it without underflow
  const g=await loadFixture(fxt);await g.mock.controls(false,false);const Y=await challenge(g,await job(g));const s=await g.engine.status(Y,0);await g.mock.send(s.requestId,await g.engine.getAddress(),[]);expect((await g.engine.status(Y,0)).state).to.equal(4n);
  const [pY]=await g.engine.population(Y,0);for(let i=0;i<pY.length;i++)await g.engine.releaseCandidate(Y,0,i);for(const a of pY)expect(await g.engine.candidacy(a)).to.equal(0n);
  await g.market.connect(await signer(pY[0])).exitVerifier();await time.increaseTo((await g.market.effectiveProtectedDeadline(Y))+1n);await g.market.resolveStale(Y);for(const a of pY)expect(await g.engine.candidacy(a)).to.equal(0n);
  evidence.push({case:'fix3-skipped-and-failed-release',skippedReleased:v9,failedDrawAllReleased:pY.length});
 });
 it('(3) with penalty 0 the selected jurors are still exit-locked after the others are released (fix (b) unchanged), then seated as drawn',async()=>{
  const f=await loadFixture(fxt);await f.terms.setParams({...P,penaltyBps:0,minPenalty:0n});const X=await challenge(f,await job(f));const [pool]=await f.engine.population(X,0);await fulfill(f,X,9n);const sel=Array.from(await f.engine.selection(X,0));
  for(let i=0;i<pool.length;i++)if(!sel.includes(pool[i]))await f.engine.releaseCandidate(X,0,i);
  for(const a of sel){expect(await f.engine.frozenHold(a)).to.equal(0n);expect(await f.engine.candidacy(a)).to.equal(1n);await expect(f.market.connect(await signer(a)).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');}
  await f.market.drawCommittee(X);expect(Array.from(await f.market.committeeOf(X))).to.deep.equal(sel);
 });
});
