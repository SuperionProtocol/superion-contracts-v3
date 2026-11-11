const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {ethers,P,S,time,mine,fixture,completed,fileChallenge,fileAppeal,firstVerdict,arbitrate,snapshot}=H;
const {network}=require('hardhat');const fs=require('fs');const evidence=[];
// PAUSE/SATURATION FIX: the callback now selects the jury and holds the selected penalty (same tx as the result),
// so it is no longer 'lightweight'. Planned limit = documented network maximum; measured worst cases stay < 80 %.
const CALLBACK_LIMIT=BigInt(require('../helpers/vrf-config.cjs').BASE_SEPOLIA_PLANNED.callbackGasLimit);
async function fxt(){const f=await fixture();f.engine=await oracle(f.market);f.mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());await f.token.transfer(f.outsider.address,S('10000'));await f.token.connect(f.outsider).approve(await f.staking.getAddress(),ethers.MaxUint256);await f.staking.connect(f.outsider).stake(S('10000'));return f;}
async function maxFxt(){const f=await fxt();for(let i=0;i<190;i++){const a=ethers.getAddress(ethers.toBeHex(200000+i,20));await network.provider.send('hardhat_impersonateAccount',[a]);await network.provider.send('hardhat_setBalance',[a,'0x56BC75E2D63100000']);const v=await ethers.getSigner(a);await f.token.transfer(a,S('1000'));await f.token.connect(v).approve(await f.staking.getAddress(),S('1000'));await f.staking.connect(v).stake(S('1000'));await f.market.connect(v).registerVerifier();}await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({...P,committeeSize:13,appealCommitteeSize:15});return f;}
async function open(f,round=0){if(!round){const id=await completed(f);await fileChallenge(f,id);return {id,c0:[]};}const s=await firstVerdict(f,true);await fileAppeal(f,s);return s;}
async function result(f,id,word=123n){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round);return (await f.mock.fulfill(s.requestId,word)).wait();}
async function prediction(f,id,wordOverride){const d=await f.market.disputes(id),s=await f.engine.status(id,d.round),[pool,weights]=await f.engine.population(id,d.round),w=Array.from(weights);let total=w.reduce((a,b)=>a+b,0n);const abi=ethers.AbiCoder.defaultAbiCoder(),word=wordOverride??s.word;
 const seed=ethers.keccak256(abi.encode(['bytes32','uint256','address','address','uint256','uint256','uint256','bytes32','uint256'],[await f.engine.DOMAIN(),31337,await f.engine.getAddress(),await f.market.getAddress(),id,d.round,s.requestId,s.snapshotHash,word]));
 const out=[];for(let t=0;t<Number(s.size);t++){let r=BigInt(ethers.keccak256(abi.encode(['bytes32','uint256'],[seed,t])))%total;let i=0;while(r>=w[i]){r-=w[i];i++;}out.push(pool[i]);total-=w[i];w[i]=0n;}return {selected:out,seed};}
async function rawDraw(f,id){return (await f.market.drawCommittee(id)).wait();}
async function toSafe(f,id,value=true){await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);await time.increase(365*86400);const p=await H.prepared(f,id,value,f.owners.slice(0,1));await expect(H.executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS020');return arbitrate(f,id,value);}

describe('Frozen single VRF2.5 request: LOCAL MOCK ONLY, NO real VRF proof verification',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/vrf-evidence.json',JSON.stringify({warning:'LOCAL AUTHORED ORACLE MOCK, NOT PRODUCTION CRYPTOGRAPHIC VRF VERIFICATION',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});
 for(const round of [0,1]){
  it(`round${round}: joining, order changes and governance AFTER request cannot change frozen membership, weights, size or voting clocks`,async()=>{
   const f=await loadFixture(fxt),{id,c0}=await open(f,round),before=await f.engine.status(id,round),[population,weights]=await f.engine.population(id,round);
   const cap=Number(await f.market.verifierCount()),addresses=Array.from(population),fixedWeights=Array.from(weights);while(addresses.length<cap){addresses.push(ethers.ZeroAddress);fixedWeights.push(0n);}
   expect(await f.engine.DOMAIN()).to.equal(ethers.id('SUPERION_FROZEN_VRF_DRAW_V1'));
   expect(before.snapshotHash).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','uint256','address','address','uint256','uint256','address[]','uint256[]','uint256','uint8','uint32','uint32'],[await f.engine.DOMAIN(),31337,await f.engine.getAddress(),await f.market.getAddress(),id,round,addresses,fixedWeights,before.count,before.size,P.voteCommitWindow,P.voteRevealWindow])));
   await result(f,id);const expected=await prediction(f,id);
   await f.market.connect(f.outsider).registerVerifier();const unselected=f.vs.find(v=>population.includes(v.address)&&!expected.selected.includes(v.address));expect(unselected).to.not.equal(undefined);
   // PAUSE/JURY FIX: a frozen candidate can no longer exit/re-register between freeze and seating.
   await expect(f.market.connect(unselected).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');await expect(f.market.connect(unselected).registerVerifier()).to.be.revertedWithCustomError(f.market,'InvalidState');
   await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({...P,minVerifierStake:S('2000'),maxPenalty:S('1000'),committeeSize:5,appealCommitteeSize:7,voteCommitWindow:P.voteCommitWindow+60,voteRevealWindow:P.voteRevealWindow+60});
   expect(await f.engine.population(id,round)).to.deep.equal([population,weights]);expect((await f.engine.status(id,round)).snapshotHash).to.equal(before.snapshotHash);
   const receipt=await rawDraw(f,id),block=await ethers.provider.getBlock(receipt.blockNumber),rd=await f.market.rounds(id,round),actual=Array.from(await f.market.committeeOf(id));expect(actual).to.deep.equal(expected.selected);expect(actual.length).to.equal(round?5:3);for(const a of actual)expect(c0).to.not.include(a);
   await f.market.connect(unselected).exitVerifier();expect((await f.market.verifiers(unselected.address)).bond).to.equal(0n); // released once the jury is seated
   expect(rd.commitDeadline).to.equal(BigInt(block.timestamp+P.voteCommitWindow));expect(rd.revealDeadline).to.equal(BigInt(block.timestamp+P.voteCommitWindow+P.voteRevealWindow));evidence.push({label:'immutable-inputs-'+round,requestId:before.requestId,snapshot:before.snapshotHash,seed:expected.seed,selected:actual});
  });
  it(`round${round}: REGRESSION (pause/jury fix): a predicted juror cannot exit, recover the bond and re-register to send the case to Safe`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round),d=await f.market.disputes(id);await result(f,id);const expected=await prediction(f,id),v=await ethers.getSigner(expected.selected[0]);
   const lockedBefore=await f.staking.lockedStake(v.address),infoBefore=await f.market.verifiers(v.address);expect(await f.engine.frozenHold(v.address)).to.equal(d.penalty);
   await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');
   await expect(f.market.connect(v).registerVerifier()).to.be.revertedWithCustomError(f.market,'InvalidState');
   expect(await f.staking.lockedStake(v.address)).to.equal(lockedBefore);expect(await f.market.verifiers(v.address)).to.deep.equal(infoBefore);
   const next=await f.mock.nextRequest();await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(expected.selected);expect(await f.mock.nextRequest()).to.equal(next);
   expect((await f.market.disputes(id)).phase).to.equal(2n);await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'TooEarly'); // live Voting, not a Safe case
   const after=await f.market.verifiers(v.address);expect(after.duties).to.equal(infoBefore.duties+1n);expect(after.reserved).to.equal(infoBefore.reserved+d.penalty);expect(await f.engine.frozenHold(v.address)).to.equal(0n);
   await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'InvalidState');
   evidence.push({label:'regression-selected-exit-'+round,juror:v.address,exitReverted:'StakeReserved',seated:true});
  });
  it(`round${round}: a frozen candidate cannot exit and rejoin with a larger bond; the frozen lottery weight is unchanged`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round);await result(f,id);const expected=await prediction(f,id),a=await ethers.getSigner(expected.selected[0]);await expect(f.market.connect(a).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({...P,minVerifierStake:S('2000')});await expect(f.market.connect(a).registerVerifier()).to.be.revertedWithCustomError(f.market,'InvalidState');expect((await f.market.verifiers(a.address)).bond).to.equal(S('1000'));
   const [pool,w]=await f.engine.population(id,round);expect(w[pool.indexOf(a.address)]).to.equal(S('1000'));await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(expected.selected);
  });
  it(`round${round}: an unselected candidate stays held until seating, then exits with its full bond; the fixed jury is unchanged`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round);await result(f,id);const p=await prediction(f,id),[pool]=await f.engine.population(id,round),a=pool.find(x=>!p.selected.includes(x)),u=await ethers.getSigner(a);
   await expect(f.market.connect(u).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(p.selected);
   expect(await f.engine.frozenHold(a)).to.equal(0n);const bond=(await f.market.verifiers(a)).bond,locked=await f.staking.lockedStake(a);await f.market.connect(u).exitVerifier();expect((await f.market.verifiers(a)).bond).to.equal(0n);expect(await f.staking.lockedStake(a)).to.equal(locked-bond);
  });
  it(`round${round}: new population cannot repair a snapshot that was insufficient at request time`,async()=>{
   const f=await loadFixture(fxt);let s;
   if(round){const first=await firstVerdict(f,true);for(const v of f.vs.filter(a=>!first.c0.includes(a.address)))await f.market.connect(v).exitVerifier();await fileAppeal(f,first);s=first;}
   else{const id=await completed(f);for(const v of f.vs)await f.market.connect(v).exitVerifier();await fileChallenge(f,id);s={id};}
   const old=await f.mock.nextRequest();await f.market.connect(f.outsider).registerVerifier();for(const v of f.vs)if((await f.market.verifiers(v.address)).indexPlus1===0n)await f.market.connect(v).registerVerifier();
   await expect(f.market.drawCommittee(s.id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect(await f.mock.nextRequest()).to.equal(old);await toSafe(f,s.id,false);expect((await f.market.jobs(s.id)).status).to.equal(6n);
  });
  for(const valid of [true,false])it(`round${round}: rejected/unfunded MOCK request holds all escrow, is never retried, then Safe verdict ${valid}`,async()=>{
   const f=await loadFixture(fxt);let s;if(round){s=await firstVerdict(f,true);await f.mock.setCredits(await f.engine.subscriptionId(),0);await fileAppeal(f,s);}else{const id=await completed(f);await f.mock.setCredits(await f.engine.subscriptionId(),0);await fileChallenge(f,id);s={id};}
   const st=await f.engine.status(s.id,round),held=await snapshot(f,s.id),oldNext=await f.mock.nextRequest();expect(st.state).to.equal(4n);await f.mock.controls(false,false);await f.mock.fundSubscription(await f.engine.subscriptionId(),1000);
   await expect(f.market.drawCommittee(s.id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect(await f.mock.nextRequest()).to.equal(oldNext);expect(await snapshot(f,s.id)).to.deep.equal(held);await toSafe(f,s.id,valid);
   expect((await f.market.jobs(s.id)).status).to.equal(valid?5n:6n);expect((await f.market.disputes(s.id)).bond).to.equal(0n);expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
  });
  it(`round${round}: late result, callback replay after arbitration, and callback after final settlement cannot revive draw`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round),st=await f.engine.status(id,round),held=await snapshot(f,id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.mock.fulfill(st.requestId,111);
   expect((await f.engine.status(id,round)).state).to.equal(5n);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'TooLate');expect(await snapshot(f,id)).to.deep.equal(held);await f.market.resolveStale(id);await f.mock.fulfill(st.requestId,222);await arbitrate(f,id,true);const paid=await snapshot(f,id);await f.mock.fulfill(st.requestId,333);expect(await snapshot(f,id)).to.deep.equal(paid);
  });
  it(`round${round}: callback before deadline and selection AT inclusive deadline work; no blockhash retarget after300 blocks`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round),before=await f.engine.status(id,round);await result(f,id);await mine(300,1);const p=await prediction(f,id);
   await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(p.selected);expect((await f.engine.status(id,round)).requestId).to.equal(before.requestId);expect((await f.engine.status(id,round)).state).to.equal(3n);
  });
  it(`round${round}: pause protects request clock, callback (selection + hold) stays bounded and seating remains permissionless while paused`,async()=>{
   const f=await loadFixture(fxt),{id}=await open(f,round);await f.market.pause();const left=(await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());await time.increase(365*86400);const receipt=await result(f,id,0n);expect(receipt.gasUsed).to.be.lessThan(CALLBACK_LIMIT/4n);expect((await f.engine.status(id,round)).state).to.equal(2n);
   await rawDraw(f,id);expect((await f.market.disputes(id)).phase).to.equal(2n);expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(left);evidence.push({label:'callback-gas-'+round,totalMockTxGas:receipt.gasUsed,callbackLimit:CALLBACK_LIMIT,includesMockOverhead:true});
  });
 }
 it('EOAs cannot forge callbacks, open/pick/close snapshots, replace coordinator or request again',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f),st=await f.engine.status(id,0);await expect(f.engine.connect(f.outsider).rawFulfillRandomWords(st.requestId,[1])).to.be.revertedWithCustomError(f.engine,'OnlyCoordinator');
  await expect(f.engine.close(id,0)).to.be.revertedWithCustomError(f.engine,'OnlyMarket');await expect(f.engine.pick(id,0)).to.be.revertedWithCustomError(f.engine,'OnlyMarket');await expect(f.engine.open(id,0,[],[],0,3,60,60,0)).to.be.revertedWithCustomError(f.engine,'OnlyMarket');expect(f.engine.setCoordinator).to.equal(undefined);expect(f.engine.cancel).to.equal(undefined);expect(await f.engine.market()).to.equal(await f.market.getAddress());
 });
 it('unknown ids, zero word, duplicate callbacks and consumed callbacks cannot overwrite the first accepted result',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f),st=await f.engine.status(id,0);await f.mock.send(999999,await f.engine.getAddress(),[44]);expect((await f.engine.status(id,0)).state).to.equal(1n);await result(f,id,0n);await f.mock.fulfill(st.requestId,999);expect((await f.engine.status(id,0)).word).to.equal(0n);await rawDraw(f,id);await f.mock.fulfill(st.requestId,555);expect((await f.engine.status(id,0)).state).to.equal(3n);expect((await f.engine.status(id,0)).word).to.equal(0n);
 });
 it('malformed authenticated callback fails that request once, without a revert or another random request',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f),st=await f.engine.status(id,0);await f.mock.send(st.requestId,await f.engine.getAddress(),[]);expect((await f.engine.status(id,0)).state).to.equal(4n);await f.mock.fulfill(st.requestId,123);expect((await f.engine.status(id,0)).state).to.equal(4n);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
 });
 it('parallel jobs fulfilled out of order keep authentic request mapping and domain-separated seeds',async()=>{
  const f=await loadFixture(fxt),a=await open(f),b=await open(f),sa=await f.engine.status(a.id,0),sb=await f.engine.status(b.id,0);expect(sa.requestId).to.not.equal(sb.requestId);await result(f,b.id,777);await expect(f.market.drawCommittee(a.id)).to.be.revertedWithCustomError(f.market,'TooEarly');await result(f,a.id,777);
  const pa=await prediction(f,a.id),pb=await prediction(f,b.id);expect(pa.seed).to.not.equal(pb.seed);for(const s of [a,b]){const ref=await f.engine.requests((await f.engine.status(s.id,0)).requestId);expect(ref.jobId).to.equal(s.id);await rawDraw(f,s.id);}expect(Array.from(await f.market.committeeOf(a.id))).to.deep.equal(pa.selected);expect(Array.from(await f.market.committeeOf(b.id))).to.deep.equal(pb.selected);
 });
 it('duplicate request id from a MISBEHAVING MOCK fails the new draw without remapping an old request',async()=>{
  const f=await loadFixture(fxt),a=await open(f),sa=await f.engine.status(a.id,0);await f.mock.controls(false,true);const b=await open(f);expect((await f.engine.status(b.id,0)).state).to.equal(4n);expect((await f.engine.requests(sa.requestId)).jobId).to.equal(a.id);await f.mock.fulfill(sa.requestId,20);expect((await f.engine.status(a.id,0)).word).to.equal(20n);await expect(f.market.drawCommittee(b.id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
 });
 it('actual MOCK subscription exhaustion never spends the marketplace budget or prevents filing',async()=>{
  const f=await loadFixture(fxt);const sub=await f.engine.subscriptionId();await f.mock.controls(true,false); // separate forced rejection already covered; create genuinely unfunded module via factory below
  const mock=await(await ethers.getContractFactory('LocalVrfCoordinatorMock')).deploy(),idSub=await mock.nextSubscription();await mock.createSubscription();
  const factory=await ethers.getContractFactory('SuperionJobMarketplaceV3');const market=await factory.deploy(await f.token.getAddress(),await f.staking.getAddress(),f.admin.address,f.admin.address,await f.safe.getAddress(),f.treasury.address,P,{coordinator:await mock.getAddress(),subscriptionId:idSub,keyHash:ethers.id('LOCAL_ONLY'),confirmations:3,callbackGasLimit:Number(CALLBACK_LIMIT),nativePayment:false});
  await mock.addConsumer(idSub,await market.drawEngine());await f.staking.grantRole(await f.staking.OPERATOR_ROLE(),await market.getAddress());for(const v of f.vs)await market.connect(v).registerVerifier();await f.token.connect(f.creator).approve(await market.getAddress(),ethers.MaxUint256);await f.token.connect(f.challenger).approve(await market.getAddress(),ethers.MaxUint256);
  await market.connect(f.creator).createJob(S('1000'),3600,'unfunded');await market.connect(f.provider).assignJob(1);await market.connect(f.provider).submitResult(1,'ok');await market.connect(f.challenger).challengeJob(1,ethers.id('unfunded'));
  const engine=await ethers.getContractAt('FrozenVrfDraw',await market.drawEngine());expect((await engine.status(1,0)).state).to.equal(4n);expect(await f.token.balanceOf(await market.getAddress())).to.equal(S('1100'));expect(await mock.credits(idSub)).to.equal(0n);expect(await engine.subscriptionId()).to.equal(idSub);expect(sub).to.be.greaterThan(0n);
 });
 it('available staking changes cannot change weights; inconsistent coverage from a trusted OPERATOR causes no substitution',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f);await result(f,id);const p=await prediction(f,id),a=await ethers.getSigner(p.selected[0]);await f.staking.connect(a).requestUnstake(S('9000'));await f.staking.connect(a).stake(S('1000'));const [_,weights]=await f.engine.population(id,0);expect(weights.every(w=>w===S('1000'))).to.equal(true);
  // TEST-ONLY impersonation of the existing market operator, NOT an unprivileged real attack.
  const address=await f.market.getAddress();await network.provider.send('hardhat_impersonateAccount',[address]);await network.provider.send('hardhat_setBalance',[address,'0x56BC75E2D63100000']);await f.staking.connect(await ethers.getSigner(address)).slash(a.address,S('100'));await network.provider.send('hardhat_stopImpersonatingAccount',[address]);
  expect((await f.market.verifiers(a.address)).bond).to.equal(S('1000'));expect(await f.staking.lockedStake(a.address)).to.equal(S('900'));await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect((await f.engine.status(id,0)).state).to.equal(2n);
 });
 // THREE-LIMITS FIX (2), ADAPTED: this case used to prove the old limit B3 (a drawn juror slashed elsewhere before drawCommittee
 // broke the jury -> Safe). Now the seat's penalty is held atomically with the result, so the jury forms as drawn; the deserved
 // penalty elsewhere is still fully applied (bond 1000 -> 900) and the frozen weight is still unchanged.
 it('normal penalty in a parallel mission changes live bond but NOT frozen weight; the drawn juror is STILL seated (fix 2, was: Safe)',async()=>{
  const f=await loadFixture(fxt);await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({...P,minVerifierStake:S('500'),maxPenalty:S('500')});const other=await completed(f);await fileChallenge(f,other);const c=await H.draw(f,other);const d=await f.market.disputes(other),rd=await f.market.rounds(other,d.round),abi=ethers.AbiCoder.defaultAbiCoder();
  for(let i=0;i<2;i++)await f.market.connect(await ethers.getSigner(c[i])).commitVote(other,ethers.keccak256(abi.encode(['bool','bytes32','address','uint256'],[true,ethers.id('nonrevealer-'+i),c[i],other])));await time.increaseTo(rd.commitDeadline+1n);for(let i=0;i<2;i++)await f.market.connect(await ethers.getSigner(c[i])).revealVote(other,true,ethers.id('nonrevealer-'+i));await time.increaseTo(rd.revealDeadline+1n);await f.market.resolveDispute(other);
  const {id}=await open(f);let word=0n;while(!(await prediction(f,id,word)).selected.includes(c[2]))word++;await result(f,id,word);await time.increaseTo((await f.market.effectiveProtectedDeadline(other))+1n);await f.market.finalizeDispute(other);
  expect((await f.market.verifiers(c[2])).bond).to.equal(S('900'));const [pool,w]=await f.engine.population(id,0);expect(w[pool.indexOf(c[2])]).to.equal(S('1000'));const planned=(await prediction(f,id,word)).selected;await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(planned);expect((await f.market.disputes(id)).phase).to.equal(2n);const info=await f.market.verifiers(c[2]);expect(info.bond).to.equal(S('900'));expect(info.reserved).to.equal((await f.market.disputes(id)).penalty);expect(info.reserved).to.be.at.most(info.bond);
 });
 it('official request tuple/tag, immutable subscription settings, no additional candidate locks and no escrow funding',async()=>{
  const f=await loadFixture(fxt),before=await Promise.all(f.vs.map(v=>f.staking.lockedStake(v.address))),{id}=await open(f),st=await f.engine.status(id,0);expect(await f.mock.requestKeyHash(st.requestId)).to.equal(await f.engine.keyHash());expect(await f.mock.requestConfirmations(st.requestId)).to.equal(3n);expect(await f.mock.gasLimits(st.requestId)).to.equal(CALLBACK_LIMIT);
  const tag=ethers.id('VRF ExtraArgsV1').slice(0,10),bytes=ethers.concat([tag,ethers.AbiCoder.defaultAbiCoder().encode(['bool'],[false])]);expect(await f.mock.requestExtraArgs(st.requestId)).to.equal(bytes);expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(S('1100'));expect(await ethers.provider.getBalance(await f.engine.getAddress())).to.equal(0n);
  for(let i=0;i<f.vs.length;i++){expect(await f.staking.lockedStake(f.vs[i].address)).to.equal(before[i]);expect((await f.market.verifiers(f.vs[i].address)).duties).to.equal(0n);}
 });
 it('authenticated callback at the exact protected cutoff is accepted, but does not revive selection one second late',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f),st=await f.engine.status(id,0),cutoff=await f.market.effectiveProtectedDeadline(id);await time.setNextBlockTimestamp(cutoff);await f.mock.fulfill(st.requestId,41);expect((await f.engine.status(id,0)).state).to.equal(2n);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'TooLate');await f.market.resolveStale(id);expect((await f.engine.status(id,0)).state).to.equal(5n);
 });
 it('an expired request stays expired through a later pause; neither callbacks nor new registrations revive it',async()=>{
  const f=await loadFixture(fxt),{id}=await open(f);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.pause();await time.increase(86400);await result(f,id);expect((await f.engine.status(id,0)).state).to.equal(5n);await f.market.unpause();await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'TooLate');
 });
 it('request rejection is caught once, does not lose escrow, and funding/reconfiguration of MOCK cannot create a retry',async()=>{
  const f=await loadFixture(fxt);await f.mock.controls(true,false);const {id}=await open(f),held=await snapshot(f,id);await f.mock.controls(false,false);await f.mock.fundSubscription(await f.engine.subscriptionId(),999);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');expect(await snapshot(f,id)).to.deep.equal(held);expect((await f.engine.status(id,0)).state).to.equal(4n);
 });
 it('maximum200 candidates / first jury13: snapshot and request fit an explicit16777216gas envelope',async()=>{
  const f=await loadFixture(maxFxt),id=await completed(f),before=await Promise.all(f.vs.map(v=>f.staking.lockedStake(v.address)));const tx=await f.market.connect(f.challenger).challengeJob(id,ethers.id("max-fixed-gas"),{gasLimit:16777216}),receipt=await tx.wait();expect(receipt.gasUsed).to.be.lessThan(16777216n);const population=await f.engine.population(id,0);expect(population[0].length).to.equal(200);for(let i=0;i<f.vs.length;i++)expect(await f.staking.lockedStake(f.vs[i].address)).to.equal(before[i]);
  const callback=await result(f,id),pred=await prediction(f,id),selection=await rawDraw(f,id);expect(Array.from(await f.market.committeeOf(id))).to.deep.equal(pred.selected);expect(pred.selected.length).to.equal(13);expect(callback.gasUsed).to.be.lessThan(CALLBACK_LIMIT*8n/10n);evidence.push({label:'maximum-200-first13',snapshotAndRequestGas:receipt.gasUsed,callbackTxGas:callback.gasUsed,selectionGas:selection.gasUsed,transactionEnvelope:16777216});
 });
 it('maximum200 population / appeal15:187 fixed disjoint candidates, bounded callback (selection + hold) and separate seating',async()=>{
  const f=await loadFixture(maxFxt),id=await completed(f);await fileChallenge(f,id);await result(f,id);await rawDraw(f,id);const c0=Array.from(await f.market.committeeOf(id));await H.vote(f,id,Array(13).fill(true));await f.market.resolveDispute(id);const receipt=await(await f.market.connect(f.creator).appeal(id,{gasLimit:16777216})).wait();expect(receipt.gasUsed).to.be.lessThan(16777216n);expect((await f.engine.population(id,1))[0].length).to.equal(187);
  const callback=await result(f,id),selection=await rawDraw(f,id),c1=Array.from(await f.market.committeeOf(id));expect(c1.length).to.equal(15);for(const a of c1)expect(c0).to.not.include(a);expect(callback.gasUsed).to.be.lessThan(CALLBACK_LIMIT*8n/10n);evidence.push({label:'maximum-200-appeal15',snapshotAndRequestGas:receipt.gasUsed,callbackTxGas:callback.gasUsed,selectionGas:selection.gasUsed,candidates:187});
 });

 it('malformed request return data from a WRONG-INTERFACE MOCK is terminal and cannot roll back an otherwise timely filing',async()=>{
  const f=await loadFixture(fxt);await f.mock.setMalformed(true);const {id}=await open(f);expect((await f.engine.status(id,0)).state).to.equal(4n);expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(S('1100'));await f.mock.setMalformed(false);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');await toSafe(f,id,true);expect((await f.market.jobs(id)).status).to.equal(5n);
 });

});
