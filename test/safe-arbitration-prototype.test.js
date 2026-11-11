const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {expect}=require('chai');
const {ethers,network}=require('hardhat');
const {loadFixture,time,mine}=require('@nomicfoundation/hardhat-network-helpers');
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require('../scripts/v3/config.cjs');
const {artifacts:safeArtifacts,deployLocalSafe,prepareSafeTx,executeSafeTx,safeCall}=require('../helpers/local-safe.cjs');
const S=ethers.parseEther;
const Phase={Draw:1n,Voting:2n,Decided:3n,Done:4n,Arbitration:5n};
const status={Disputed:4n,Finalized:5n,Refunded:6n};
const salt=label=>ethers.id('local-safe-test-'+label);
async function fixture(){
 const signers=await ethers.getSigners();
 const [admin,creator,provider,challenger,treasury,relayer,outsider]=signers;
 const vs=signers.slice(7,17),owners=signers.slice(17,20);
 const localSafe=await deployLocalSafe(ethers,owners,admin),safe=localSafe.safe;
 const token=await(await ethers.getContractFactory('SuperionToken')).deploy(admin.address);
 const staking=await(await ethers.getContractFactory('SuperionStakingV2')).deploy(await token.getAddress(),admin.address,60);
 const market=await(await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),admin.address,admin.address,await safe.getAddress(),treasury.address,P);
 await staking.grantRole(await staking.OPERATOR_ROLE(),await market.getAddress());
 for(const a of [creator,provider,challenger,...vs]){
  await token.transfer(a.address,S('100000'));await token.connect(a).approve(await staking.getAddress(),ethers.MaxUint256);await token.connect(a).approve(await market.getAddress(),ethers.MaxUint256);
 }
 await staking.connect(provider).stake(S('20000'));
 for(const a of vs){await staking.connect(a).stake(S('10000'));await market.connect(a).registerVerifier();}
 return {admin,creator,provider,challenger,treasury,relayer,outsider,vs,owners,...localSafe,token,staking,market};
}
async function completed(f,budget='1000'){
 const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S(budget),3600,'local-job');await f.market.connect(f.provider).assignJob(id);await f.market.connect(f.provider).submitResult(id,'local-result');return id;
}
async function challenged(f){const id=await completed(f);await f.market.connect(f.challenger).challengeJob(id,salt('challenge-'+id));return id;}
async function draw(f,id){await mine();await legacyDraw(f.market,id);return Array.from(await f.market.committeeOf(id));}
async function vote(f,id,answers){
 const d=await f.market.disputes(id),c=await f.market.committeeOf(id);const r=await f.market.rounds(id,d.round);
 for(let i=0;i<c.length;i++)if(answers[i]!==null){
  const h=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bool','bytes32','address','uint256'],[answers[i],salt('vote-'+i),c[i],id]));
  await f.market.connect(await ethers.getSigner(c[i])).commitVote(id,h);
 }
 await time.increaseTo(r.commitDeadline+1n);
 for(let i=0;i<c.length;i++)if(answers[i]!==null)await f.market.connect(await ethers.getSigner(c[i])).revealVote(id,answers[i],salt('vote-'+i));
 return Array.from(c);
}
async function request(f,id){return f.market.connect(f.outsider).resolveStale(id);}
async function arbitrate(f,id,result,owners=f.owners.slice(0,2)){
 return safeCall(ethers,f.safe,await f.market.getAddress(),f.market.interface.encodeFunctionData('arbitrate',[id,result]),owners,f.relayer);
}
async function prepareDecision(f,id,result,owners=f.owners.slice(0,2),options={}){
 return prepareSafeTx(ethers,f.safe,await f.market.getAddress(),f.market.interface.encodeFunctionData('arbitrate',[id,result]),owners,options);
}
async function noMajority(f){
 const id=await challenged(f);await draw(f,id);const c=await vote(f,id,[true,false,null]);
 await time.increaseTo((await f.market.rounds(id,0)).revealDeadline+1n);return {id,c};
}
async function appealCase(f,original=true,mode='draw',round0Answers=null){
 const id=await challenged(f);const c0=await draw(f,id);const answers=round0Answers??[original,original,!original];await vote(f,id,answers);
 if(answers.includes(null))await time.increaseTo((await f.market.rounds(id,0)).revealDeadline+1n);
 await f.market.resolveDispute(id);
 const appellant=original?f.creator:f.provider;
 // PAUSE/JURY FIX: in 'draw' mode the fresh jurors leave BEFORE the appeal freeze (they can no longer leave after it).
 if(mode!=='voting'){const remaining=f.vs.filter(v=>!c0.includes(v.address));for(const v of remaining)await f.market.connect(v).exitVerifier();}
 await f.market.connect(appellant).appeal(id);
 let c1=[];
 if(mode==='voting'){
  c1=await draw(f,id);await vote(f,id,[true,true,false,false,null]);await time.increaseTo((await f.market.rounds(id,1)).revealDeadline+1n);
 }else{
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);
 }
 return {id,c0,c1,appellant};
}
async function snapshot(f,id){
 const j=await f.market.jobs(id),d=await f.market.disputes(id);
 return {jobStatus:j.status,budget:j.budget,locked:j.lockedStake,bond:d.bond,appealBond:d.appealBond,
  escrow:await f.token.balanceOf(await f.market.getAddress()),provider:await f.token.balanceOf(f.provider.address),creator:await f.token.balanceOf(f.creator.address),challenger:await f.token.balanceOf(f.challenger.address),treasury:await f.token.balanceOf(f.treasury.address),supply:await f.token.totalSupply(),providerLocked:await f.staking.lockedStake(f.provider.address)};
}
async function solvent(f){
 const backing=await f.token.balanceOf(await f.staking.getAddress());
 const obligations=await f.staking.totalSupply()+await f.staking.totalUnbonding()+await f.staking.totalRewardsOwed()+await f.staking.queuedRewards();
 expect(backing).to.be.at.least(obligations);
}
async function terminal(f,id,c=[]){
 const j=await f.market.jobs(id),d=await f.market.disputes(id);
 expect(d.phase).to.equal(Phase.Done);expect(j.budget).to.equal(0n);expect(j.lockedStake).to.equal(0n);expect(d.bond).to.equal(0n);expect(d.appealBond).to.equal(0n);
 expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(0n);expect(await f.staking.lockedStake(f.provider.address)).to.equal(0n);
 for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(0n);
 await solvent(f);
}
async function noPartyExit(f,id){
 for(const who of [f.creator,f.provider,f.challenger])for(const method of ['finalizeJob','finalizeDispute','cancelJob','reclaimExpired'])
  await expect(f.market.connect(who)[method](id)).to.be.reverted;
 const full=await f.staking.balanceOf(f.provider.address);
 await expect(f.staking.connect(f.provider).requestUnstake(full)).to.be.revertedWithCustomError(f.staking,'InsufficientUnlocked');
}

describe('Actual SafeL2 1.4.1 + APPROVED arbitral reversal exemption (LOCAL ONLY, not production ready)',function(){
 it('uses only chain31337; unmodified published Safe runtime, initialized 2/3, no modules, LOCAL guard installed, sole arbiter',async function(){
  const f=await loadFixture(fixture);expect(network.name).to.equal('hardhat');expect((await ethers.provider.getNetwork()).chainId).to.equal(31337n);
  expect(await ethers.provider.getCode(await f.singleton.getAddress())).to.equal(safeArtifacts.safe.deployedBytecode);
  expect(await f.safe.VERSION()).to.equal('1.4.1');expect(await f.safe.getThreshold()).to.equal(2n);expect(new Set(await f.safe.getOwners())).to.deep.equal(new Set(f.owners.map(o=>o.address)));
  const [modules,next]=await f.safe.getModulesPaginated('0x0000000000000000000000000000000000000001',50);expect(modules.length).to.equal(0);expect(next).to.equal('0x0000000000000000000000000000000000000001');
  expect(await ethers.provider.getStorage(await f.safe.getAddress(),ethers.id('guard_manager.guard.address'))).to.equal(ethers.zeroPadValue(await f.guard.getAddress(),32)); // ROLES-GUARD STEP: LOCAL guard
  const handlerSlot=await ethers.provider.getStorage(await f.safe.getAddress(),ethers.id('fallback_manager.handler.address'));
  expect(ethers.getAddress('0x'+handlerSlot.slice(-40))).to.equal(await f.handler.getAddress());
  const role=await f.market.ARBITER_ROLE();expect(await f.market.hasRole(role,await f.safe.getAddress())).to.equal(true);
  for(const a of await ethers.getSigners())expect(await f.market.hasRole(role,a.address)).to.equal(false);
 });
 for(const n of [0,1])it(`${n} Safe signature(s) fail, funds/state/nonce unchanged`,async function(){
  const f=await loadFixture(fixture),{id}=await noMajority(f),before=await snapshot(f,id),nonce=await f.safe.nonce();
  const p=await prepareDecision(f,id,true,f.owners.slice(0,n));await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS020');
  expect(await snapshot(f,id)).to.deep.equal(before);expect(await f.safe.nonce()).to.equal(nonce);
 });
 it('duplicating one signer is not two approvals; an outsider signature also fails',async function(){
  const f=await loadFixture(fixture),{id}=await noMajority(f);
  for(const owners of [[f.owners[0],f.owners[0]],[f.owners[0],f.outsider]]){
   const p=await prepareDecision(f,id,true,owners);await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS026');
  }
  expect((await f.market.jobs(id)).status).to.equal(status.Disputed);
 });
 for(const pair of [[0,1],[0,2],[1,2]])it(`distinct local owners ${pair.join('+')} approve actual Safe execution`,async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f),p=await prepareDecision(f,id,true,pair.map(i=>f.owners[i]));
  const m=p.message;expect(await f.safe.getTransactionHash(m.to,m.value,m.data,m.operation,m.safeTxGas,m.baseGas,m.gasPrice,m.gasToken,m.refundReceiver,m.nonce)).to.equal(p.hash);
  await expect(executeSafeTx(f.safe,f.relayer,p)).to.emit(f.safe,'ExecutionSuccess').withArgs(p.hash,0n);
  expect((await f.market.jobs(id)).status).to.equal(status.Finalized);await terminal(f,id,c);
 });
 it('owners and unauthorized EOA cannot call the marketplace directly',async function(){
  const f=await loadFixture(fixture),{id}=await noMajority(f);
  for(const a of [...f.owners,f.admin,f.creator,f.provider,f.challenger,f.outsider])
   await expect(f.market.connect(a).arbitrate(id,true)).to.be.revertedWithCustomError(f.market,'AccessControlUnauthorizedAccount');
 });
 it('replay and fresh duplicate settlement cannot pay twice or decrement duties twice',async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f),p=await prepareDecision(f,id,false);
  await(await executeSafeTx(f.safe,f.relayer,p)).wait();const before=await snapshot(f,id),nonce=await f.safe.nonce();
  await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS026');
  await expect(arbitrate(f,id,false)).to.be.revertedWith('GS013');
  await expect(f.market.resolveStale(id)).to.be.revertedWithCustomError(f.market,'InvalidState');
  expect(await snapshot(f,id)).to.deep.equal(before);expect(await f.safe.nonce()).to.equal(nonce);await terminal(f,id,c);
 });
 it('EIP712 chain domain and verdict calldata are bound to the signatures',async function(){
  const f=await loadFixture(fixture),{id}=await noMajority(f);
  const wrong=await prepareDecision(f,id,true,f.owners.slice(0,2),{chainId:8453n});await expect(executeSafeTx(f.safe,f.relayer,wrong)).to.be.revertedWith('GS026');
  const p=await prepareDecision(f,id,true);p.message.data=f.market.interface.encodeFunctionData('arbitrate',[id,false]);await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS026');
 });
 it('zero/one signature never causes a timeout exit, even after ten simulated years',async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f),before=await snapshot(f,id);
  await time.increase(10*365*86400);await expect(request(f,id)).to.emit(f.market,'ArbitrationRequested').withArgs(id,0);
  expect(await snapshot(f,id)).to.deep.equal(before);await noPartyExit(f,id);for(const a of c)expect((await f.market.verifiers(a)).duties).to.equal(1n);
  for(const n of [0,1]){const p=await prepareDecision(f,id,false,f.owners.slice(0,n));await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS020');}
  await arbitrate(f,id,false);await terminal(f,id,c);
 });
 for(const valid of [true,false])it(`first-round missing jury: no cancellation; late Safe verdict ${valid} uses existing binary economics`,async function(){
  // PAUSE/JURY FIX: frozen candidates can no longer exit after filing, so the jurors leave BEFORE filing (draw fails at freeze).
  const f=await loadFixture(fixture),id=await completed(f);for(const v of f.vs)await f.market.connect(v).exitVerifier();
  await f.market.connect(f.challenger).challengeJob(id,salt('challenge-'+id));const d=await f.market.disputes(id);expect((await (await oracle(f.market)).status(id,0)).state).to.equal(4n);
  await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,'NotEnoughVerifiers');
  const before=await snapshot(f,id);expect(before.escrow).to.equal(S('1000')+d.bond);expect((await f.market.disputes(id)).phase).to.equal(Phase.Draw);
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await request(f,id);expect(await snapshot(f,id)).to.deep.equal(before);
  await time.increase(20*365*86400);await noPartyExit(f,id);const supply=await f.token.totalSupply();await arbitrate(f,id,valid);
  expect((await f.market.jobs(id)).status).to.equal(valid?status.Finalized:status.Refunded);
  if(valid){
   expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(S('950')+d.bond);
   expect((await f.token.balanceOf(f.treasury.address))-before.treasury).to.equal(S('25'));expect(supply-await f.token.totalSupply()).to.equal(S('10'));
   expect(await f.staking.totalRewardsOwed()+await f.staking.queuedRewards()).to.equal(S('15'));
  }else{
   expect((await f.token.balanceOf(f.creator.address))-before.creator).to.equal(S('1000'));
   expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(d.bond+S('100'));expect(supply-await f.token.totalSupply()).to.equal(S('900'));
   expect(await f.token.balanceOf(f.treasury.address)).to.equal(before.treasury);
  }
  await terminal(f,id);
 });
 for(const valid of [true,false])it(`first-round no majority: late Safe verdict ${valid}, exact fees/slashes/duties and no residual escrow`,async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f),before=await snapshot(f,id);
  const juryBefore=await Promise.all(c.map(a=>f.token.balanceOf(a)));const d=await f.market.disputes(id);
  await request(f,id);expect(await snapshot(f,id)).to.deep.equal(before);await time.increase(50*365*86400);await arbitrate(f,id,valid);
  const [bond,pen,fee]=await f.market.disputeAmounts(S('1000'));
  expect((await f.market.verifiers(c[2])).bond).to.equal(S('1000')-pen);
  const balances=await Promise.all(c.map(a=>f.token.balanceOf(a)));
  if(valid){
   expect(balances[0]-juryBefore[0]).to.equal(fee+bond-2n*fee);expect(balances[1]-juryBefore[1]).to.equal(fee);
   expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(S('950'));
   expect(before.supply-await f.token.totalSupply()).to.equal(pen+S('10'));
  }else{
   const rest=S('1000')-2n*fee,cShare=rest*d.slashChallengerBps/10000n,vShare=rest*d.slashVerifierBps/10000n;
   expect(balances[0]-juryBefore[0]).to.equal(fee);expect(balances[1]-juryBefore[1]).to.equal(fee+vShare);
   expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(bond+cShare);
   expect(before.supply-await f.token.totalSupply()).to.equal(pen+rest-cShare-vShare);
  }
  await terminal(f,id,c);
 });
 for(const mode of ['draw','voting'])for(const original of [true,false])it(`appeal ${mode}, original ${original}: hold indefinitely, then Safe may uphold; no appeal-default payout`,async function(){
  const f=await loadFixture(fixture),{id,c0,c1}=await appealCase(f,original,mode),before=await snapshot(f,id);
  const d=await f.market.disputes(id),juryBefore=await Promise.all([...c0,...c1].map(a=>f.token.balanceOf(a)));
  await request(f,id);expect(await snapshot(f,id)).to.deep.equal(before);expect((await f.market.disputes(id)).round).to.equal(1n);
  await time.increase(5*365*86400);await noPartyExit(f,id);
  for(const a of [...c0,...c1])expect((await f.market.verifiers(a)).duties).to.equal(1n);
  await arbitrate(f,id,original);await terminal(f,id,[...c0,...c1]);
  for(const a of c0)expect((await f.market.verifiers(a)).bond).to.equal(S('1000'));
  expect((await f.market.jobs(id)).status).to.equal(original?status.Finalized:status.Refunded);
  const fee=d.voteFee,bondLeft=d.bond-3n*fee,appealLeft=d.appealBond-BigInt(c1.length?4:0)*fee;
  for(let i=0;i<c0.length;i++)expect((await f.token.balanceOf(c0[i]))-juryBefore[i]).to.equal(fee);
  const slashRest=S('1000')-3n*fee,cShare=slashRest*d.slashChallengerBps/10000n;
  const vShare=c1.length?slashRest*d.slashVerifierBps/10000n:0n;
  let expectedBurn=(mode==='voting'?d.penalty:appealLeft);
  if(original){
   expectedBurn+=S('10');expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(S('950')+(c1.length?0n:bondLeft));
   expect((await f.token.balanceOf(f.treasury.address))-before.treasury).to.equal(S('25'));
  }else{
   expectedBurn+=slashRest-cShare-vShare;expect((await f.token.balanceOf(f.creator.address))-before.creator).to.equal(S('1000'));
   expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(d.bond+cShare);
  }
  expect(before.supply-await f.token.totalSupply()).to.equal(expectedBurn);
  for(let i=0;i<c1.length;i++){
   const matching=original?i<2:(i===2||i===3);
   const expected=i===4?0n:fee+(matching?appealLeft/2n+(original?bondLeft/2n:vShare/2n):0n);
   expect((await f.token.balanceOf(c1[i]))-juryBefore[c0.length+i]).to.equal(expected);
  }
 });
 for(const mode of ['draw','voting'])for(const original of [true,false])it(`APPROVED: Safe reverses appeal ${mode}, original ${original}; former majority exempt, complete binary settlement`,async function(){
  const f=await loadFixture(fixture),{id,c0,c1,appellant}=await appealCase(f,original,mode);await request(f,id);
  const before=await snapshot(f,id),nonce=await f.safe.nonce(),d=await f.market.disputes(id),result=!original;
  const juryBefore=await Promise.all([...c0,...c1].map(a=>f.token.balanceOf(a))),providerStakeBefore=await f.staking.balanceOf(f.provider.address);
  await time.increase(5*365*86400);await noPartyExit(f,id);expect(await snapshot(f,id)).to.deep.equal(before);
  const insufficient=await prepareDecision(f,id,result,[f.owners[0]]);
  await expect(executeSafeTx(f.safe,f.relayer,insufficient)).to.be.revertedWith('GS020');
  expect(await snapshot(f,id)).to.deep.equal(before);expect(await f.safe.nonce()).to.equal(nonce);
  const {prepared,receipt}=await arbitrate(f,id,result);
  const event=receipt.logs.map(l=>{try{return f.market.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='DisputeResolved');
  expect(event.args.jobId).to.equal(id);expect(event.args.providerValid).to.equal(result);expect(event.args.byArbiter).to.equal(true);
  expect((await f.market.disputes(id)).outcomeValid).to.equal(original); // saved ROUND-0 result, not final appeal outcome
  expect((await f.market.disputes(id)).round).to.equal(1n);await terminal(f,id,[...c0,...c1]);
  expect((await f.market.jobs(id)).status).to.equal(result?status.Finalized:status.Refunded);
  for(const a of c0)expect((await f.market.verifiers(a)).bond).to.equal(S('1000'));
  const fee=d.voteFee,bondLeft=d.bond-3n*fee,appealFees=BigInt(c1.length?4:0)*fee,appealRefund=d.appealBond-appealFees;
  for(let i=0;i<c0.length;i++)expect((await f.token.balanceOf(c0[i]))-juryBefore[i]).to.equal(fee);
  const rest=S('1000')-3n*fee,cShare=rest*d.slashChallengerBps/10000n,vShare=c1.length?rest*d.slashVerifierBps/10000n:0n;
  let burned=mode==='voting'?d.penalty:0n;
  if(result){
   expect(appellant.address).to.equal(f.provider.address);
   expect((await f.token.balanceOf(f.provider.address))-before.provider).to.equal(S('950')+appealRefund+(c1.length?0n:bondLeft));
   expect(await f.staking.balanceOf(f.provider.address)).to.equal(providerStakeBefore);
   expect(await f.token.balanceOf(f.creator.address)).to.equal(before.creator);expect(await f.token.balanceOf(f.challenger.address)).to.equal(before.challenger);
   expect((await f.token.balanceOf(f.treasury.address))-before.treasury).to.equal(S('25'));burned+=S('10');
  }else{
   expect(appellant.address).to.equal(f.creator.address);
   expect((await f.token.balanceOf(f.creator.address))-before.creator).to.equal(S('1000')+appealRefund);
   expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(d.bond+cShare);
   expect(await f.staking.balanceOf(f.provider.address)).to.equal(providerStakeBefore-S('1000'));
   expect(await f.token.balanceOf(f.provider.address)).to.equal(before.provider);expect(await f.token.balanceOf(f.treasury.address)).to.equal(before.treasury);
   burned+=rest-cShare-vShare;
  }
  expect(before.supply-await f.token.totalSupply()).to.equal(burned);
  for(let i=0;i<c1.length;i++){
   const matching=result?i<2:(i===2||i===3);
   const expected=i===4?0n:fee+(matching?(result?bondLeft/2n:vShare/2n):0n);
   expect((await f.token.balanceOf(c1[i]))-juryBefore[c0.length+i]).to.equal(expected);
   expect((await f.market.verifiers(c1[i])).bond).to.equal(S('1000')-(i===4?d.penalty:0n));
  }
  const settled=await snapshot(f,id),settledNonce=await f.safe.nonce();
  await expect(executeSafeTx(f.safe,f.relayer,prepared)).to.be.revertedWith('GS026');
  await expect(arbitrate(f,id,result)).to.be.revertedWith('GS013');
  expect(await snapshot(f,id)).to.deep.equal(settled);expect(await f.safe.nonce()).to.equal(settledNonce);
  for(const a of [...c0,...c1]){
   const bond=(await f.market.verifiers(a)).bond;expect(await f.staking.lockedStake(a)).to.equal(bond);
   await f.market.connect(await ethers.getSigner(a)).exitVerifier();expect(await f.staking.lockedStake(a)).to.equal(0n);expect((await f.market.verifiers(a)).bond).to.equal(0n);
  }
  await solvent(f);
 });
 for(const original of [true,false])it(`APPROVED exemption is NOT amnesty: round-0 non-revealer and appeal non-revealer still penalized, original ${original}`,async function(){
  const f=await loadFixture(fixture),{id,c0,c1}=await appealCase(f,original,'voting',[original,original,null]);
  const d=await f.market.disputes(id),before=await snapshot(f,id),beforeFees=await Promise.all(c0.map(a=>f.token.balanceOf(a)));
  await arbitrate(f,id,!original);await terminal(f,id,[...c0,...c1]);
  for(let i=0;i<c0.length;i++){
   expect((await f.market.verifiers(c0[i])).bond).to.equal(S('1000')-(i===2?d.penalty:0n));
   expect((await f.token.balanceOf(c0[i]))-beforeFees[i]).to.equal(i===2?0n:d.voteFee);
  }
  expect((await f.market.verifiers(c1[4])).bond).to.equal(S('1000')-d.penalty);
  if(!original)expect(before.supply-await f.token.totalSupply()).to.equal(2n*d.penalty+S('10'));
  else{
   const rest=S('1000')-2n*d.voteFee,cs=rest*d.slashChallengerBps/10000n,vs=rest*d.slashVerifierBps/10000n;
   expect((await f.token.balanceOf(f.challenger.address))-before.challenger).to.equal(d.bond+cs);
   expect(before.supply-await f.token.totalSupply()).to.equal(2n*d.penalty+rest-cs-vs);
  }
 });
 it('Safe can atomically escalate an expired appeal Draw and reverse, without a separate keeper transaction',async function(){
  const f=await loadFixture(fixture),{id,c0}=await appealCase(f,false,'draw');expect((await f.market.disputes(id)).phase).to.equal(Phase.Draw);
  const one=await prepareDecision(f,id,true,[f.owners[0]]);await expect(executeSafeTx(f.safe,f.relayer,one)).to.be.revertedWith('GS020');
  expect((await f.market.disputes(id)).phase).to.equal(Phase.Draw);
  const {receipt}=await arbitrate(f,id,true);const events=receipt.logs.map(l=>{try{return f.market.interface.parseLog(l);}catch{return null;}});
  expect(events.filter(e=>e?.name==='ArbitrationRequested').length).to.equal(1);expect(events.filter(e=>e?.name==='DisputeResolved').length).to.equal(1);
  for(const a of c0)expect((await f.market.verifiers(a)).bond).to.equal(S('1000'));await terminal(f,id,c0);
 });
 it('Safe cannot decide Open/Completed/Decided jobs, or a Draw before its fixed deadline',async function(){
  const f=await loadFixture(fixture);await f.market.connect(f.creator).createJob(S('1000'),3600,'open');
  await expect(arbitrate(f,1,true)).to.be.revertedWith('GS013');await f.market.connect(f.provider).assignJob(1);await f.market.connect(f.provider).submitResult(1,'result');
  await expect(arbitrate(f,1,true)).to.be.revertedWith('GS013');await f.market.connect(f.challenger).challengeJob(1,salt('guards'));
  await expect(arbitrate(f,1,true)).to.be.revertedWith('GS013');await expect(request(f,1)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await draw(f,1);await vote(f,1,[true,true,true]);await f.market.resolveDispute(1);await expect(arbitrate(f,1,false)).to.be.revertedWith('GS013');
 });
 it('neither Safe nor permissionless escalation can override a valid current jury majority',async function(){
  const f=await loadFixture(fixture),id=await challenged(f);await draw(f,id);await vote(f,id,[false,false,true]);
  await time.increaseTo((await f.market.rounds(id,0)).revealDeadline+1n);
  await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'HasMajority');await expect(arbitrate(f,id,true)).to.be.revertedWith('GS013');
  await f.market.resolveDispute(id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.finalizeDispute(id);
  expect((await f.market.jobs(id)).status).to.equal(status.Refunded);await terminal(f,id,await f.market.committeeOfRound(id,0));
 });
 for(const original of [false,true])it(`ordinary appeal-jury reversal ${original} -> ${!original} retains original-majority penalties; current jury majority protected`,async function(){
  const f=await loadFixture(fixture),id=await challenged(f),c0=await draw(f,id);await vote(f,id,[original,original,!original]);await f.market.resolveDispute(id);
  await f.market.connect(original?f.creator:f.provider).appeal(id);const c1=await draw(f,id),result=!original;
  await vote(f,id,[result,result,result,!result,!result]);await time.increaseTo((await f.market.rounds(id,1)).revealDeadline+1n);
  await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'HasMajority');await expect(arbitrate(f,id,original)).to.be.revertedWith('GS013');
  await f.market.resolveDispute(id);const d=await f.market.disputes(id);
  for(const a of c0.slice(0,2))expect((await f.market.verifiers(a)).bond).to.equal(S('1000')-d.penalty);
  expect((await f.market.verifiers(c0[2])).bond).to.equal(S('1000'));await terminal(f,id,[...c0,...c1]);
 });
 it('Voting cannot escalate at its inclusive reveal deadline, but may immediately afterward',async function(){
  const f=await loadFixture(fixture),id=await challenged(f);await draw(f,id);const r=await f.market.rounds(id,0);
  await time.setNextBlockTimestamp(r.revealDeadline);await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  await expect(request(f,id)).to.emit(f.market,'ArbitrationRequested');expect((await f.market.disputes(id)).phase).to.equal(Phase.Arbitration);
 });
 it('Draw uses active time: multiple pauses freeze remaining time and parameter changes/missing callback cannot extend its snapshot',async function(){
  const f=await loadFixture(fixture);await f.market.pause();await time.increase(123);await f.market.unpause();const id=await challenged(f);
  const start=await f.market.effectiveProtectedDeadline(id);let paused=0n;
  for(const duration of [100,1000]){
   await f.market.pause();const t=BigInt(await time.latest()),remaining=(await f.market.effectiveProtectedDeadline(id))-t;
   await time.increase(duration);expect((await f.market.effectiveProtectedDeadline(id))-BigInt(await time.latest())).to.equal(remaining);
   await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'TooEarly');await expect(arbitrate(f,id,true)).to.be.revertedWith('GS013');
   await f.market.unpause();paused+=BigInt(await time.latest())-t;
  }
  expect(await f.market.effectiveProtectedDeadline(id)).to.equal(start+paused);await (await require('hardhat').ethers.getContractAt('MissionTerms',await f.market.terms())).setParams({...P,arbitrationWindow:86400});
  expect(await f.market.effectiveProtectedDeadline(id)).to.equal(start+paused);await mine(300);await expect(f.market.drawCommittee(id)).to.be.revertedWithCustomError(f.market,'TooEarly');
  expect(await f.market.effectiveProtectedDeadline(id)).to.equal(start+paused);await time.increaseTo(start+paused+1n);
  await expect(legacyDraw(f.market,id)).to.be.revertedWithCustomError(f.market,'TooLate');await request(f,id);await arbitrate(f,id,true);await terminal(f,id);
 });
 it('Draw can form a full committee at the exact inclusive boundary',async function(){
  const f=await loadFixture(fixture),id=await challenged(f);await mine(2);await fulfillMock(f.market,id);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));
  await expect(legacyDraw(f.market,id)).to.emit(f.market,'CommitteeSelected');expect((await f.market.disputes(id)).phase).to.equal(Phase.Voting);
  await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'TooEarly');
 });
 it('Draw escalation is forbidden at the exact boundary and allowed one second later',async function(){
  const f=await loadFixture(fixture),id=await challenged(f);await fulfillMock(f.market,id);await time.setNextBlockTimestamp(await f.market.effectiveProtectedDeadline(id));
  await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'TooEarly');await expect(request(f,id)).to.emit(f.market,'ArbitrationRequested');
 });
 it('a Draw expired before pause stays expired (escalation possible); PAUSE/SATURATION FIX: the Safe decision itself waits for unpause, then settles',async function(){
  const f=await loadFixture(fixture),id=await challenged(f);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.pause();await time.increase(10000);
  await request(f,id);const before=await snapshot(f,id);await expect(arbitrate(f,id,false)).to.be.revertedWith('GS013');expect(await snapshot(f,id)).to.deep.equal(before);
  await f.market.unpause();await arbitrate(f,id,false);await terminal(f,id);
 });
 it('PAUSE/SATURATION FIX (N4): voting deadlines are frozen during pause (no escalation on paused time); after resume no-majority escrow waits for Safe',async function(){
  const f=await loadFixture(fixture),id=await challenged(f),c=await draw(f,id),before=await snapshot(f,id),r=await f.market.rounds(id,0);
  await f.market.pause();await time.increaseTo(r.revealDeadline+1n);await expect(request(f,id)).to.be.revertedWithCustomError(f.market,'TooEarly');expect(await snapshot(f,id)).to.deep.equal(before);
  await f.market.unpause();await time.increase(P.voteCommitWindow+P.voteRevealWindow+1);await request(f,id);expect(await snapshot(f,id)).to.deep.equal(before);await arbitrate(f,id,true);await terminal(f,id,c);
 });
 it('jurors exiting during indefinite hold cannot unlock their outstanding duty bond',async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f);await request(f,id);
  for(const a of c){
   const v=await ethers.getSigner(a);await expect(f.market.connect(v).exitVerifier()).to.be.revertedWithCustomError(f.market,'StakeReserved');expect((await f.market.verifiers(a)).duties).to.equal(1n);expect((await f.market.verifiers(a)).indexPlus1).to.not.equal(0n);expect(await f.staking.lockedStake(a)).to.equal(S('1000'));
   await expect(f.staking.connect(v).requestUnstake(S('10000'))).to.be.revertedWithCustomError(f.staking,'InsufficientUnlocked');
  }
  await arbitrate(f,id,true);await terminal(f,id,c);for(const a of c)await f.market.connect(await ethers.getSigner(a)).exitVerifier();
  for(const a of c)expect(await f.staking.lockedStake(a)).to.equal(0n);
 });
 it('settling one of two concurrent disputes never spends the other escrow or releases its duty/provider lock',async function(){
  const f=await loadFixture(fixture);for(const v of f.vs.slice(3))await f.market.connect(v).exitVerifier();
  const id1=await challenged(f),c1=await draw(f,id1),id2=await challenged(f),c2=await draw(f,id2);
  expect(new Set(c1)).to.deep.equal(new Set(c2));await time.increaseTo((await f.market.rounds(id2,0)).revealDeadline+1n);
  for(const a of c1)expect((await f.market.verifiers(a)).duties).to.equal(2n);
  await arbitrate(f,id1,true);const j2=await f.market.jobs(id2),d2=await f.market.disputes(id2);
  expect(await f.token.balanceOf(await f.market.getAddress())).to.equal(j2.budget+d2.bond);
  expect(await f.staking.lockedStake(f.provider.address)).to.equal(j2.lockedStake);
  for(const a of c1)expect((await f.market.verifiers(a)).duties).to.equal(1n);
  await expect(arbitrate(f,id1,true)).to.be.revertedWith('GS013');await solvent(f);
  await request(f,id2);await arbitrate(f,id2,true);await terminal(f,id2,c2);
 });
 it('DOCUMENTED TRUST LIMIT: admin can grant another arbiter; role alone does not enforce multisig forever',async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f);await f.market.grantRole(await f.market.ARBITER_ROLE(),f.outsider.address);
  await f.market.connect(f.outsider).arbitrate(id,true);await terminal(f,id,c);
 });
 it('FIXED by the LOCAL Safe guard (approved protection 2): two owners can NO LONGER lower the threshold to 1; one signature still cannot arbitrate',async function(){
  const f=await loadFixture(fixture),{id,c}=await noMajority(f);await expect(safeCall(ethers,f.safe,await f.safe.getAddress(),f.safe.interface.encodeFunctionData('changeThreshold',[1]),f.owners.slice(0,2),f.relayer)).to.be.revertedWithCustomError(f.guard,'ThresholdTooLow').withArgs(1n);
  expect(await f.safe.getThreshold()).to.equal(2n);const p=await prepareSafeTx(ethers,f.safe,await f.market.getAddress(),f.market.interface.encodeFunctionData('arbitrate',[id,true]),[f.owners[2]]);await expect(executeSafeTx(f.safe,f.relayer,p)).to.be.revertedWith('GS020');
  await arbitrate(f,id,true,f.owners.slice(1,3));await terminal(f,id,c);
 });
});
