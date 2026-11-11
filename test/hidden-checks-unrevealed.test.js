// LOCAL PROTOTYPE (Hardhat 31337). Approved rule (pt103u): in a dispute, hidden checks that were NOT revealed do NOT count
// against the provider. Implemented only as a READ-ONLY status in CodeMissionSuites (marketplace bytecode unchanged).
// No automatic payment, no automatic penalty on the creator; pass/fail and disputes stay off-chain / verifiers / Safe.
const {expect}=require('chai');const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,S}=H;const fs=require('fs'),evidence=[];
const u=ethers.toUtf8Bytes,k=ethers.keccak256;
const PUBLIC=u('// public suite v1\ntest("add(2,3)==5");\n');const HIDDEN=ethers.concat([ethers.id('local-demo-salt'),u('// hidden\ntest("add(1e6,1e6)==2e6");\n')]);
async function fx(){const f=await H.fixture();f.suites=await(await ethers.getContractFactory('CodeMissionSuites')).deploy(await f.market.getAddress());return f;}
async function openJob(f){const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S('1000'),3600,'ipfs://spec');return id;}
const reg=(f,id)=>f.suites.connect(f.creator).register(id,k(PUBLIC),k(HIDDEN),'ipfs://public');
async function deliver(f,id){await f.market.connect(f.provider).assignJob(id);await f.market.connect(f.provider).submitResult(id,'ipfs://result');}
const st=async(f,id)=>{const r=await f.suites.hiddenChecksStatus(id);return {registered:r.registered,revealed:r.revealed,countAgainstProvider:r.countAgainstProvider,revealedAt:r.revealedAt};};

describe('Approved rule: unrevealed hidden checks do NOT count against the provider (read-only status, LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/hidden-checks-unrevealed-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; nothing deployed; read-only guidance, no automatic payment or penalty',cases:evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});
 it('the new function is read-only; the module still has exactly two write functions',async()=>{
  const f=await loadFixture(fx),fr=f.suites.interface.getFunction('hiddenChecksStatus');expect(fr.stateMutability).to.equal('view');
  expect(fr.outputs.map(o=>o.name)).to.deep.equal(['registered','revealed','countAgainstProvider','revealedAt']);
  expect(f.suites.interface.fragments.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).map(x=>x.name).sort()).to.deep.equal(['register','revealHidden']);
 });
 it('nothing registered (normal mission, unknown job): hidden checks do not count',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);const none={registered:false,revealed:false,countAgainstProvider:false,revealedAt:0n};
  expect(await st(f,id)).to.deep.equal(none);expect(await st(f,999n)).to.deep.equal(none);
  await deliver(f,id);await H.keep(f,[]);await H.fileChallenge(f,id);expect(await st(f,id)).to.deep.equal(none);
  evidence.push({case:'not-registered',status:none});
 });
 it('registered but NOT revealed: false at every stage (open, assigned, delivered, disputed); failed reveals change nothing',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await reg(f,id);const no={registered:true,revealed:false,countAgainstProvider:false,revealedAt:0n};
  expect(await st(f,id)).to.deep.equal(no);await f.market.connect(f.provider).assignJob(id);expect(await st(f,id)).to.deep.equal(no);
  await expect(f.suites.revealHidden(id,HIDDEN)).to.be.revertedWithCustomError(f.suites,'NotDelivered');expect(await st(f,id)).to.deep.equal(no);
  await f.market.connect(f.provider).submitResult(id,'ipfs://result');expect(await st(f,id)).to.deep.equal(no);
  const bad=ethers.getBytes(HIDDEN);bad[40]^=1;await expect(f.suites.revealHidden(id,bad)).to.be.revertedWithCustomError(f.suites,'HashMismatch');expect(await st(f,id)).to.deep.equal(no);
  await H.keep(f,[]);await H.fileChallenge(f,id);expect((await f.market.jobs(id)).status).to.equal(4n);expect(await st(f,id)).to.deep.equal(no);
  evidence.push({case:'registered-not-revealed',stages:['open','assigned','early reveal refused','delivered','tampered reveal refused','disputed'],countAgainstProvider:false});
 });
 it('after a VALID reveal (exact bytes, after delivery): the hidden checks may count (pass/fail still decided off-chain)',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await reg(f,id);await deliver(f,id);await H.keep(f,[]);await H.fileChallenge(f,id);
  const rc=await(await f.suites.connect(f.creator).revealHidden(id,HIDDEN)).wait(),t=BigInt((await ethers.provider.getBlock(rc.blockNumber)).timestamp);
  expect(await st(f,id)).to.deep.equal({registered:true,revealed:true,countAgainstProvider:true,revealedAt:t});
  evidence.push({case:'revealed-during-dispute',countAgainstProvider:true,revealedAt:t});
 });
 it('no automatic payment and no automatic creator penalty: an unrevealed code mission and a normal mission settle identically under the existing Safe path',async()=>{
  const f=await loadFixture(fx),code=await openJob(f),plain=await openJob(f);await reg(f,code);await deliver(f,code);await deliver(f,plain);await H.keep(f,[]);
  await H.fileChallenge(f,code);await H.fileChallenge(f,plain);await time.increaseTo((await f.market.effectiveProtectedDeadline(plain))+1n);await f.market.resolveStale(code);await f.market.resolveStale(plain);
  const who=[f.provider,f.creator,f.challenger,f.treasury];const bal=()=>Promise.all(who.map(w=>f.token.balanceOf(w.address)));
  const deltas=[];for(const id of [code,plain]){const b=await bal();expect((await f.market.jobs(id)).status).to.equal(4n);await H.arbitrate(f,id,false);const a=await bal();deltas.push(a.map((x,i)=>x-b[i]));}
  expect(deltas[0]).to.deep.equal(deltas[1]);expect((await st(f,code)).countAgainstProvider).to.equal(false);
  evidence.push({case:'same-settlement',note:'module status is guidance only; Safe decided false on both; identical balances deltas (provider, creator, challenger, treasury)',deltas:deltas[0]});
 });
});
