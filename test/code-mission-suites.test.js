// LOCAL PROTOTYPE (Hardhat 31337). Approved (pt102u): code missions freeze a PUBLIC test-suite fingerprint and a HIDDEN
// checks fingerprint before work starts; hidden checks are revealed only from delivery on, and only with the exact bytes.
// Separate module: the marketplace bytecode is unchanged. The module does NOT run tests and does NOT move funds.
const {expect}=require('chai');const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S}=H;const {governedDeploy}=require('../helpers/governed-deploy.cjs');const fs=require('fs'),evidence=[];
const u=ethers.toUtf8Bytes,k=ethers.keccak256;
const PUBLIC=u('// public suite v1\ntest("add(2,3)==5");\ntest("add(-1,1)==0");\n');
const SALT=ethers.id('local-test-salt-not-a-secret');// demo salt: in real use a random 32-byte value, kept private until reveal
const HIDDEN=ethers.concat([SALT,u('// hidden checks (within the announced spec)\ntest("add(1e6,1e6)==2e6");\ntest("add handles 0");\n')]);
const PH=k(PUBLIC),HH=k(HIDDEN);
async function fx(){const f=await H.fixture();f.suites=await(await ethers.getContractFactory('CodeMissionSuites')).deploy(await f.market.getAddress());return f;}
async function openJob(f){const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S('1000'),3600,'ipfs://spec-v1 (cahier des charges)');return id;}
const reg=(f,id,who=f.creator,ph=PH,hh=HH)=>f.suites.connect(who).register(id,ph,hh,'ipfs://public-suite-v1');
async function deliver(f,id){await f.market.connect(f.provider).assignJob(id);await f.market.connect(f.provider).submitResult(id,'ipfs://result');}

describe('Code missions: frozen public + hidden test-suite fingerprints (separate module, LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/code-mission-suites-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; nothing deployed; the module does NOT run tests; VRF simulated',cases:evidence},null,2)+'\n');});
 it('module surface: immutable market link, no admin/owner/pause/setter; only register + revealHidden write; holds no tokens',async()=>{
  const f=await loadFixture(fx);await expect((await ethers.getContractFactory('CodeMissionSuites')).deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.suites,'ZeroAddress');
  expect(await f.suites.market()).to.equal(await f.market.getAddress());
  const writes=f.suites.interface.fragments.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).map(x=>x.name).sort();expect(writes).to.deep.equal(['register','revealHidden']);
  expect(await f.token.balanceOf(await f.suites.getAddress())).to.equal(0n);
  evidence.push({case:'surface',writeFunctions:writes,admin:'none',fundsHeld:'0'});
 });
 it('creator registers both fingerprints while the job is Open; values are frozen and verifiable by anyone',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);expect(await f.suites.isCodeMission(id)).to.equal(false);
  await expect(reg(f,id)).to.emit(f.suites,'SuitesRegistered').withArgs(id,f.creator.address,PH,HH,'ipfs://public-suite-v1');
  const s=await f.suites.suitesOf(id);expect([s.publicSuiteHash,s.hiddenSuiteHash,s.revealedAt]).to.deep.equal([PH,HH,0n]);expect(s.registeredAt).to.be.greaterThan(0n);
  expect(await f.suites.isCodeMission(id)).to.equal(true);expect(await f.suites.matchesPublic(id,PUBLIC)).to.equal(true);
  expect(await f.suites.connect(f.outsider).matchesPublic(id,u('// public suite v1 (edited)'))).to.equal(false);
  evidence.push({case:'register',jobId:id.toString(),publicSuiteHash:PH,hiddenSuiteHash:HH,publicURI:'ipfs://public-suite-v1'});
 });
 it('nobody can change the fingerprints afterwards: second registration refused for creator; others refused; zero hashes refused',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);
  await expect(reg(f,id,f.creator,ethers.ZeroHash,HH)).to.be.revertedWithCustomError(f.suites,'ZeroHash');await expect(reg(f,id,f.creator,PH,ethers.ZeroHash)).to.be.revertedWithCustomError(f.suites,'ZeroHash');
  for(const w of [f.provider,f.outsider,f.admin])await expect(reg(f,id,w)).to.be.revertedWithCustomError(f.suites,'NotCreator');
  const S_=await f.safe.getAddress();await ethers.provider.send('hardhat_impersonateAccount',[S_]);await ethers.provider.send('hardhat_setBalance',[S_,'0xDE0B6B3A7640000']);
  await expect(reg(f,id,await ethers.getSigner(S_))).to.be.revertedWithCustomError(f.suites,'NotCreator');
  await reg(f,id);const other=k(u('another suite'));
  await expect(reg(f,id,f.creator,other,other)).to.be.revertedWithCustomError(f.suites,'AlreadyRegistered');
  await expect(reg(f,id,f.provider,other,other)).to.be.revertedWithCustomError(f.suites,'AlreadyRegistered');
  await expect(f.suites.connect(f.creator).register(999n,PH,HH,'')).to.be.revertedWithCustomError(f.suites,'NotCreator');// unknown job
  await deliver(f,id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.finalizeJob(id);
  const s=await f.suites.suitesOf(id);expect([s.publicSuiteHash,s.hiddenSuiteHash]).to.deep.equal([PH,HH]);// unchanged through the whole lifecycle
 });
 it('registration is only possible BEFORE work starts: after assignment it is refused (NotOpen) and the job stays a normal mission',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await f.market.connect(f.provider).assignJob(id);
  await expect(reg(f,id)).to.be.revertedWithCustomError(f.suites,'NotOpen');expect(await f.suites.isCodeMission(id)).to.equal(false);
  evidence.push({case:'late-registration',result:'NotOpen; creator cannot add tests after a provider accepted'});
 });
 it('hidden reveal BEFORE delivery fails (Open and Assigned); unregistered job fails',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await reg(f,id);
  await expect(f.suites.connect(f.creator).revealHidden(id,HIDDEN)).to.be.revertedWithCustomError(f.suites,'NotDelivered');
  await f.market.connect(f.provider).assignJob(id);await expect(f.suites.connect(f.creator).revealHidden(id,HIDDEN)).to.be.revertedWithCustomError(f.suites,'NotDelivered');
  const plain=await openJob(f);await expect(f.suites.revealHidden(plain,HIDDEN)).to.be.revertedWithCustomError(f.suites,'NotRegistered');
  expect((await f.suites.suitesOf(id)).revealedAt).to.equal(0n);
  evidence.push({case:'early-reveal',open:'NotDelivered',assigned:'NotDelivered'});
 });
 it('after delivery: modified content rejected (HashMismatch); exact bytes accepted from ANYONE; event carries the suite; one reveal only',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await reg(f,id);await deliver(f,id);
  const tampered=ethers.getBytes(HIDDEN);tampered[tampered.length-2]^=1;
  for(const bad of [tampered,ethers.concat([HIDDEN,'0x00']),PUBLIC,ethers.dataSlice(HIDDEN,32)])await expect(f.suites.connect(f.outsider).revealHidden(id,bad)).to.be.revertedWithCustomError(f.suites,'HashMismatch');
  const rc=await(await f.suites.connect(f.outsider).revealHidden(id,HIDDEN)).wait();
  const ev=rc.logs.map(l=>{try{return f.suites.interface.parseLog(l);}catch{return null;}}).find(x=>x?.name==='HiddenSuiteRevealed');
  expect(ev.args.hiddenSuite).to.equal(ethers.hexlify(HIDDEN));expect(k(ev.args.hiddenSuite)).to.equal(HH);expect(ev.args.revealer).to.equal(f.outsider.address);
  expect((await f.suites.suitesOf(id)).revealedAt).to.be.greaterThan(0n);expect(await f.suites.matchesHidden(id,HIDDEN)).to.equal(true);expect(await f.suites.matchesHidden(id,tampered)).to.equal(false);
  await expect(f.suites.revealHidden(id,HIDDEN)).to.be.revertedWithCustomError(f.suites,'AlreadyRevealed');
  evidence.push({case:'reveal',tamperedVariantsRejected:4,acceptedFrom:'any address (here: outsider)',revealGas:rc.gasUsed.toString(),revealedBytes:ethers.getBytes(HIDDEN).length});
 });
 it('reveal also works later (during a dispute / after payment); the module never blocks or triggers payment',async()=>{
  const f=await loadFixture(fx),a=await openJob(f),b=await openJob(f);await reg(f,a);await reg(f,b,f.creator,PH,HH);
  await deliver(f,a);await deliver(f,b);
  await time.increaseTo((await f.market.effectiveProtectedDeadline(a))+1n);const p0=await f.token.balanceOf(f.provider.address);await f.market.finalizeJob(a);// paid with NO reveal: existing rules decide
  expect((await f.token.balanceOf(f.provider.address))-p0).to.equal(S('950'));await f.suites.revealHidden(a,HIDDEN);
  evidence.push({case:'no-automation',finalizedWithoutReveal:true,providerPaid:'950',note:'pass/fail is an off-chain proof; disagreement uses the existing challenge/verifiers/Safe path'});
 });
 it('reveal during an open dispute is possible (jurors/Safe can use the revealed checks off-chain)',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await reg(f,id);await deliver(f,id);await H.keep(f,[]);await H.fileChallenge(f,id);
  expect((await f.market.jobs(id)).status).to.equal(4n);await f.suites.connect(f.challenger).revealHidden(id,HIDDEN);expect(await f.suites.matchesHidden(id,HIDDEN)).to.equal(true);
 });
 it('non-code missions are unchanged: no registration, normal 1000 SUPER payout 950 / 25 / 15 / 10',async()=>{
  const f=await loadFixture(fx),id=await openJob(f);await deliver(f,id);const t0=await f.token.balanceOf(f.treasury.address),p0=await f.token.balanceOf(f.provider.address),sup=await f.token.totalSupply();
  await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.finalizeJob(id);
  expect((await f.token.balanceOf(f.provider.address))-p0).to.equal(S('950'));expect((await f.token.balanceOf(f.treasury.address))-t0).to.equal(S('25'));expect(sup-await f.token.totalSupply()).to.equal(S('10'));
  expect(await f.suites.isCodeMission(id)).to.equal(false);
 });
 it('governed wiring: the timelock/Safe admin has NO power over the module (no role, no setter)',async()=>{
  const g=await governedDeploy(ethers,P),m=await(await ethers.getContractFactory('CodeMissionSuites')).deploy(await g.market.getAddress());
  expect(m.interface.fragments.some(x=>x.type==='function'&&/role|admin|owner|pause|set/i.test(x.name))).to.equal(false);
  for(const s of [g.deployer,g.owners[0]])await expect(m.connect(s).register(1n,PH,HH,'')).to.be.revertedWithCustomError(m,'NotCreator');
 });
});
