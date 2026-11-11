// LOCAL PROTOTYPE (Hardhat 31337). Safe = official SafeL2 1.4.1 bytecode, 3 local signers, threshold 2. Oracle = MOCK.
// User-approved policy (pt82u): the Safe 2-of-3 pauses AND unpauses the marketplace IMMEDIATELY (not via the 48h timelock).
// No EOA / AI / assistant key holds pause power. An assistant may only ALERT (read events/state); nothing here gives it power.
const {expect}=require('chai');const {ethers}=require('hardhat');const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const {safeCall,prepareSafeTx,executeSafeTx}=require('../helpers/local-safe.cjs');const {governedDeploy,DELAY}=require('../helpers/governed-deploy.cjs');
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require('../scripts/v3/config.cjs');const S=ethers.parseEther;const fs=require('fs'),evidence=[];
async function gov(){
 const g=await governedDeploy(ethers,P),st=await g.staking.getAddress(),mk=await g.market.getAddress();g.assistant=g.outsider;// stand-in address for "an AI/assistant key"
 for(const a of [g.creator,g.provider,g.challenger,...g.vs]){await g.token.transfer(a.address,S('100000'));await g.token.connect(a).approve(st,ethers.MaxUint256);await g.token.connect(a).approve(mk,ethers.MaxUint256);}
 await g.staking.connect(g.provider).stake(S('5000'));for(const v of g.vs){await g.staking.connect(v).stake(S('1000'));await g.market.connect(v).registerVerifier();}return g;
}
const M=g=>g.market.getAddress();const enc=(g,f,a=[])=>g.market.interface.encodeFunctionData(f,a);
const safePause=(g,owners=g.owners.slice(0,2))=>M(g).then(m=>safeCall(ethers,g.safe,m,enc(g,'pause'),owners,g.relayer));
const safeUnpause=(g,owners=g.owners.slice(1,3))=>M(g).then(m=>safeCall(ethers,g.safe,m,enc(g,'unpause'),owners,g.relayer));
async function job(g){const id=await g.market.nextJobId();await g.market.connect(g.creator).createJob(S('1000'),3600,'pause');await g.market.connect(g.provider).assignJob(id);await g.market.connect(g.provider).submitResult(id,'r');return id;}
async function remaining(g,id){return (await g.market.effectiveProtectedDeadline(id))-BigInt(await time.latest());}
async function impersonate(a){await ethers.provider.send('hardhat_impersonateAccount',[a]);await ethers.provider.send('hardhat_setBalance',[a,'0xDE0B6B3A7640000']);return ethers.getSigner(a);}

describe('Emergency pause held ONLY by the Safe 2-of-3, immediate (LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/safe-pause-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; VRF simulated; official SafeL2 1.4.1 bytecode with local keys',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});
 it('wiring: marketplace PAUSER_ROLE was granted exactly once, to the Safe; no EOA/assistant/timelock/module holds it; token has no EOA role and no pauser',async()=>{
  const g=await loadFixture(gov),R=await g.market.PAUSER_ROLE(),S_=await g.safe.getAddress(),TL=await g.timelock.getAddress();
  const grants=(await g.market.queryFilter(g.market.filters.RoleGranted(R))).map(e=>e.args.account);expect(grants).to.deep.equal([S_]);
  for(const s of await ethers.getSigners())expect(await g.market.hasRole(R,s.address)).to.equal(false);
  for(const a of [TL,await g.terms.getAddress(),await g.staking.getAddress(),await g.market.getAddress(),await g.token.getAddress()])expect(await g.market.hasRole(R,a)).to.equal(false);
  expect(await g.market.hasRole(R,S_)).to.equal(true);expect(await g.market.hasRole(ethers.ZeroHash,S_)).to.equal(false);
  const tokenGrants=await g.token.queryFilter(g.token.filters.RoleGranted());const holders=[];
  for(const e of tokenGrants)if(await g.token.hasRole(e.args.role,e.args.account))holders.push([e.args.role,e.args.account]);
  expect(holders).to.deep.equal([[ethers.ZeroHash,TL]]);// only the timelock (admin) holds a token role; token pauser = nobody (pending decision)
  for(const s of await ethers.getSigners())for(const c of [g.market,g.staking,g.timelock,g.token])expect(await c.hasRole(ethers.ZeroHash,s.address)).to.equal(false);
  evidence.push({case:'wiring',marketPauserGrants:grants,tokenRoleHolders:holders});
 });
 it('pause: one signature fails (GS020); owner+assistant fails (GS026); two distinct Safe owners pause IMMEDIATELY; replay fails',async()=>{
  const g=await loadFixture(gov),m=await M(g),d=enc(g,'pause');
  await expect(executeSafeTx(g.safe,g.relayer,await prepareSafeTx(ethers,g.safe,m,d,g.owners.slice(0,1)))).to.be.revertedWith('GS020');
  await expect(executeSafeTx(g.safe,g.relayer,await prepareSafeTx(ethers,g.safe,m,d,[g.owners[0],g.assistant]))).to.be.revertedWith('GS026');
  await expect(executeSafeTx(g.safe,g.relayer,await prepareSafeTx(ethers,g.safe,m,d,[g.assistant,g.deployer]))).to.be.revertedWith('GS026');
  expect(await g.market.paused()).to.equal(false);
  const prep=await prepareSafeTx(ethers,g.safe,m,d,[g.owners[0],g.owners[2]]);const t0=BigInt(await time.latest());
  const rc=await(await executeSafeTx(g.safe,g.relayer,prep)).wait();expect(await g.market.paused()).to.equal(true);
  const t1=BigInt((await ethers.provider.getBlock(rc.blockNumber)).timestamp);expect(t1-t0).to.be.at.most(1n);// no 48h delay
  const ev=rc.logs.map(l=>{try{return g.market.interface.parseLog(l);}catch{return null;}}).find(x=>x?.name==='Paused');expect(ev.args.account).to.equal(await g.safe.getAddress());
  await expect(executeSafeTx(g.safe,g.relayer,prep)).to.be.reverted;
  evidence.push({case:'pause-immediate',secondsAfterPreviousBlock:t1-t0,pausedBy:ev.args.account});
 });
 it('unpause: one signature fails; two distinct owners unpause IMMEDIATELY (no timelock)',async()=>{
  const g=await loadFixture(gov),m=await M(g),d=enc(g,'unpause');await safePause(g);
  await expect(executeSafeTx(g.safe,g.relayer,await prepareSafeTx(ethers,g.safe,m,d,g.owners.slice(2,3)))).to.be.revertedWith('GS020');
  expect(await g.market.paused()).to.equal(true);const t0=BigInt(await time.latest());
  await safeUnpause(g);expect(await g.market.paused()).to.equal(false);expect(BigInt(await time.latest())-t0).to.be.at.most(1n);
 });
 it('unauthorized direct callers are rejected: deployer, each Safe owner EOA, assistant, timelock, staking',async()=>{
  const g=await loadFixture(gov),R=await g.market.PAUSER_ROLE();
  const callers=[g.deployer,...g.owners,g.assistant,await impersonate(await g.timelock.getAddress()),await impersonate(await g.staking.getAddress())];
  for(const c of callers)await expect(g.market.connect(c).pause()).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount').withArgs(c.address,R);
  await safePause(g);
  for(const c of callers)await expect(g.market.connect(c).unpause()).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount').withArgs(c.address,R);
  expect(await g.market.paused()).to.equal(true);
 });
 it('no bypass: timelock cannot pause/unpause itself; Safe cannot grant PAUSER directly; EOA cannot grant or schedule; a grant needs the full 48h path',async()=>{
  const g=await loadFixture(gov),m=await M(g),TL=await g.timelock.getAddress(),R=await g.market.PAUSER_ROLE();
  const sched=(data,salt)=>safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('schedule',[m,0,data,ethers.ZeroHash,salt,DELAY]),g.owners.slice(0,2),g.relayer);
  const exec=(data,salt)=>safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData('execute',[m,0,data,ethers.ZeroHash,salt]),g.owners.slice(0,2),g.relayer);
  await sched(enc(g,'pause'),ethers.id('tp'));await time.increase(DELAY);await expect(exec(enc(g,'pause'),ethers.id('tp'))).to.be.reverted;expect(await g.market.paused()).to.equal(false);
  await expect(safeCall(ethers,g.safe,m,enc(g,'grantRole',[R,g.assistant.address]),g.owners.slice(0,2),g.relayer)).to.be.revertedWith('GS013');
  await expect(g.market.connect(g.owners[0]).grantRole(R,g.assistant.address)).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount');
  await expect(g.timelock.connect(g.assistant).schedule(m,0,enc(g,'grantRole',[R,g.assistant.address]),ethers.ZeroHash,ethers.id('x'),DELAY)).to.be.revertedWithCustomError(g.timelock,'AccessControlUnauthorizedAccount');
  const grant=enc(g,'grantRole',[R,g.assistant.address]);await sched(grant,ethers.id('g'));await expect(exec(grant,ethers.id('g'))).to.be.reverted;
  await time.increase(DELAY-5n);await expect(exec(grant,ethers.id('g'))).to.be.reverted;expect(await g.market.hasRole(R,g.assistant.address)).to.equal(false);
  // ROLES-GUARD STEP (approved protection 1): after the full 48h the grant to an EOA is now REFUSED by the timelock.
  await time.increase(5n);await expect(exec(grant,ethers.id('g'))).to.be.revertedWith('GS013');expect(await g.market.hasRole(R,g.assistant.address)).to.equal(false);
  evidence.push({case:'pauser-to-eoa-refused',note:'after the public 48h delay, the timelock REFUSES to give PAUSER_ROLE to an EOA (approved protection 1)'});
 });
 it('pause mid-mission (challenge window) preserves the protected deadline; guarded actions blocked; immediate unpause resumes',async()=>{
  const g=await loadFixture(gov),id=await job(g),before=await remaining(g,id),d0=await g.market.effectiveProtectedDeadline(id);
  await safePause(g);const r=await remaining(g,id);const p0=BigInt(await time.latest());await time.increase(5000);
  expect(await remaining(g,id)).to.equal(r);
  await expect(g.market.connect(g.creator).createJob(S('10'),3600,'x')).to.be.revertedWithCustomError(g.market,'EnforcedPause');
  await expect(g.market.connect(g.challenger).challengeJob(id,ethers.id('c'))).to.be.revertedWithCustomError(g.market,'EnforcedPause');
  await safeUnpause(g);const span=BigInt(await time.latest())-p0;
  expect(await g.market.effectiveProtectedDeadline(id)).to.equal(d0+span);expect(await remaining(g,id)).to.equal(r);expect(before-r).to.be.at.most(2n);
  await g.market.connect(g.challenger).challengeJob(id,ethers.id('c'));
  evidence.push({case:'mission-pause',remainingBefore:before,remainingDuringAndAfter:r,pausedSeconds:span});
 });
 it('pause during a dispute (draw window) preserves its deadline; Safe arbitration still settles with 2 signatures after unpause',async()=>{
  const g=await loadFixture(gov),id=await job(g);for(const v of g.vs)await g.market.connect(v).exitVerifier();// no jury possible -> protected draw window -> Safe
  await g.market.connect(g.challenger).challengeJob(id,ethers.id('c'));
  const d0=await g.market.effectiveProtectedDeadline(id);await safePause(g);const r=await remaining(g,id),p0=BigInt(await time.latest());
  await time.increase(10000);expect(await remaining(g,id)).to.equal(r);
  await expect(g.market.resolveStale(id)).to.be.reverted;// deadline not reached in active time
  await safeUnpause(g);const span=BigInt(await time.latest())-p0;expect(await g.market.effectiveProtectedDeadline(id)).to.equal(d0+span);
  await time.increaseTo((await g.market.effectiveProtectedDeadline(id))+1n);await g.market.resolveStale(id);
  const data=enc(g,'arbitrate',[id,true]),m=await M(g);
  await expect(executeSafeTx(g.safe,g.relayer,await prepareSafeTx(ethers,g.safe,m,data,g.owners.slice(0,1)))).to.be.revertedWith('GS020');
  await safeCall(ethers,g.safe,m,data,g.owners.slice(0,2),g.relayer);expect((await g.market.jobs(id)).status).to.equal(5n);
  expect(await g.token.balanceOf(m)).to.equal(0n);
 });
 it('48h timelock still governs parameters while the Safe keeps immediate pause (both paths independent)',async()=>{
  const g=await loadFixture(gov),TL=await g.timelock.getAddress(),T=await g.terms.getAddress(),data=g.terms.interface.encodeFunctionData('setParams',[{...P,committeeSize:5,appealCommitteeSize:7}]);
  const call=f=>safeCall(ethers,g.safe,TL,g.timelock.interface.encodeFunctionData(f,f==='schedule'?[T,0,data,ethers.ZeroHash,ethers.id('s'),DELAY]:[T,0,data,ethers.ZeroHash,ethers.id('s')]),g.owners.slice(0,2),g.relayer);
  await call('schedule');await safePause(g);await expect(call('execute')).to.be.reverted;await time.increase(DELAY);await call('execute');
  expect(await g.terms.versionCount()).to.equal(2n);expect(await g.market.paused()).to.equal(true);await safeUnpause(g);expect(await g.market.paused()).to.equal(false);
 });
});
