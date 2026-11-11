// VRF 2.5 "real-ready" preparation tests. LOCAL ONLY. The coordinator used here is the AUTHORED
// LocalVrfCoordinatorMock: it does NOT verify any VRF proof. No subscription, no LINK, no network.
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const hre=require('hardhat');const {ethers,network}=hre;const fs=require('fs');const path=require('path');
const H=require('../helpers/filing-shortage-fixture.cjs');const {oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const V=require('../helpers/vrf-config.cjs');const evidence={};
async function fxt(){const f=await H.fixture();f.engine=await oracle(f.market);f.mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await f.engine.coordinator());return f;}
async function deployEngine(cfg){return (await ethers.getContractFactory('FrozenVrfDraw')).deploy(cfg);}
async function localCfg(f){return V.localSimulatedConfig(hre,await f.mock.getAddress(),await f.engine.subscriptionId());}

describe('VRF 2.5 real-ready preparation (LOCAL SIMULATED coordinator, NO proof verification, NOT CONNECTED to Chainlink)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/vrf-real-ready-evidence.json',JSON.stringify({warning:'LOCAL SIMULATION ONLY. No subscription, no LINK, no deployment, no public RPC. Mock has NO VRF proof verification.',...evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('runs only on the in-process Hardhat chain; no configured network has an RPC URL',async()=>{
  expect(network.name).to.equal('hardhat');expect((await ethers.provider.getNetwork()).chainId).to.equal(31337n);
  for(const [name,n] of Object.entries(hre.config.networks)){if(name==='localhost')continue;expect(n.url,name).to.equal(undefined);}
  expect(Object.keys(hre.userConfig.networks||{})).to.deep.equal(['hardhat']);
  const src=fs.readFileSync(path.join(__dirname,'../helpers/vrf-config.cjs'),'utf8');for(const bad of ['JsonRpcProvider','http://','https://rpc','wss://','fetch(','privateKey','PRIVATE_KEY','mnemonic'])expect(src.includes(bad),bad).to.equal(false);
 });

 it('planned Base Sepolia config is documented but NOT CONNECTED: no subscriptionId, refuses to build, and has no code on the local chain',async()=>{
  const p=V.BASE_SEPOLIA_PLANNED;expect(p.subscriptionId).to.equal(null);expect(p.status).to.match(/PAS ENCORE BRANCHÉ/);expect(p.chainId).to.equal(84532n);
  expect(ethers.getAddress(p.coordinator)).to.equal('0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE');expect(p.keyHash).to.equal('0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71');expect(p.nativePayment).to.equal(false);
  expect(()=>V.plannedBaseSepoliaConfig()).to.throw(V.NOT_CONNECTED);expect(()=>V.plannedBaseSepoliaConfig(null)).to.throw(V.NOT_CONNECTED);expect(()=>V.plannedBaseSepoliaConfig(0n)).to.throw(/subscriptionId manquant/);
  // A FICTIONAL id only proves the struct shape; the engine refuses it here because the official address has no code on 31337.
  const fictional=V.plannedBaseSepoliaConfig(123456789n);expect(await ethers.provider.getCode(p.coordinator)).to.equal('0x');
  const F=await ethers.getContractFactory('FrozenVrfDraw');await expect(F.deploy(fictional)).to.be.revertedWithCustomError(F,'InvalidConfig');
  evidence.planned={...p,localCode:'0x',deployOnLocalChain:'reverted InvalidConfig (no code at coordinator)'};
 });

 it('switching path is CONFIG ONLY: the same engine bytecode accepts any coordinator address with code; fail-fast on zero keyHash/subscription and out-of-range limits',async()=>{
  const f=await loadFixture(fxt),base=await localCfg(f),F=await ethers.getContractFactory('FrozenVrfDraw');
  const a=await deployEngine(base),other=await(await ethers.getContractFactory('LocalVrfCoordinatorMock')).deploy(),b=await deployEngine({...base,coordinator:await other.getAddress(),subscriptionId:77n,keyHash:ethers.id('OTHER_LOCAL_KEYHASH'),confirmations:10,callbackGasLimit:300000,nativePayment:true});
  expect(await ethers.provider.getCode(await a.getAddress())).to.not.equal(await ethers.provider.getCode(await b.getAddress())); // immutables differ
expect((await ethers.provider.getCode(await a.getAddress())).length).to.equal((await ethers.provider.getCode(await b.getAddress())).length);
  expect(await b.coordinator()).to.equal(await other.getAddress());expect(await b.subscriptionId()).to.equal(77n);expect(await b.confirmations()).to.equal(10n);expect(await b.callbackGasLimit()).to.equal(300000n);expect(await b.nativePayment()).to.equal(true);
  for(const bad of [{keyHash:ethers.ZeroHash},{subscriptionId:0n},{coordinator:ethers.Wallet.createRandom().address},{callbackGasLimit:99999},{callbackGasLimit:2500001},{confirmations:201}])await expect(F.deploy({...base,...bad})).to.be.revertedWithCustomError(F,'InvalidConfig');
  for(const bad of [{keyHash:ethers.ZeroHash},{subscriptionId:0n},{coordinator:ethers.ZeroAddress},{callbackGasLimit:99999},{confirmations:201},{nativePayment:'false'}])expect(()=>V.validateEngineConfig({...base,...bad})).to.throw();
 });

 it('engine uses the OFFICIAL VRF 2.5 ABI: request selector/struct from official interface, callback selector from official VRFConsumerBaseV2Plus',async()=>{
  const ifc=(await hre.artifacts.readArtifact('IVRFCoordinatorV2Plus')).abi,official=new ethers.Interface(ifc);
  const req=official.getFunction('requestRandomWords');expect(req.format('sighash')).to.equal('requestRandomWords((bytes32,uint256,uint16,uint32,uint32,bytes))');
  const mockI=(await ethers.getContractFactory('LocalVrfCoordinatorMock')).interface;expect(mockI.getFunction('requestRandomWords').selector).to.equal(req.selector);
  const eng=(await ethers.getContractFactory('FrozenVrfDraw')).interface;const cb=eng.getFunction('rawFulfillRandomWords');
  const src=fs.readFileSync(path.join(__dirname,'../.chainlink-deps/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol'),'utf8');
  expect(src).to.include('function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external');
  expect(cb.selector).to.equal(ethers.id('rawFulfillRandomWords(uint256,uint256[])').slice(0,10));expect(cb.selector).to.equal('0x1fe543e3');
  evidence.selectors={requestRandomWords:req.selector,rawFulfillRandomWords:cb.selector};
 });

 it('freeze then EXACTLY ONE request: snapshot is emitted before the request in the same tx, args match config and VRFV2PlusClient ExtraArgsV1 encoding',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f),before=await f.mock.nextRequest();await H.fileChallenge(f,id);
  expect(await f.mock.nextRequest()).to.equal(before+1n);const s=await f.engine.status(id,0);expect(s.state).to.equal(1n);expect(s.requestId).to.equal(before);
  const [pool]=await f.engine.population(id,0);expect(pool.length).to.equal(Number(s.count));
  expect(await f.mock.requestKeyHash(s.requestId)).to.equal(await f.engine.keyHash());expect(await f.mock.requestConfirmations(s.requestId)).to.equal(await f.engine.confirmations());expect(await f.mock.gasLimits(s.requestId)).to.equal(await f.engine.callbackGasLimit());
  const tag=ethers.id('VRF ExtraArgsV1').slice(0,10);expect(await f.mock.requestExtraArgs(s.requestId)).to.equal(ethers.concat([tag,ethers.AbiCoder.defaultAbiCoder().encode(['bool'],[false])]));
  // logs of the opening tx: Snapshot strictly before Requested
  const logs=(await ethers.provider.getLogs({address:await f.engine.getAddress(),fromBlock:0})).map(l=>({l,p:f.engine.interface.parseLog(l)})).filter(x=>x.p);
  const snap=logs.find(x=>x.p.name==='Snapshot'),reqd=logs.find(x=>x.p.name==='Requested');expect(snap&&reqd).to.be.ok;expect(snap.l.transactionHash).to.equal(reqd.l.transactionHash);expect(snap.l.index).to.be.lessThan(reqd.l.index);
  // no retry path: drawing before the result never sends a second request
  await expect(f.market.drawCommittee(id)).to.be.reverted;expect(await f.mock.nextRequest()).to.equal(before+1n);
  evidence.singleRequest={requestId:s.requestId,snapshotHash:s.snapshotHash,count:s.count,size:s.size};
 });

 it('SIMULATED fulfill (mock, no proof) is what makes the draw possible; committee comes from the frozen population; replay ignored; no new request',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f);await H.fileChallenge(f,id);const s=await f.engine.status(id,0),[pool]=await f.engine.population(id,0),next=await f.mock.nextRequest();
  await expect(f.engine.rawFulfillRandomWords(s.requestId,[1n])).to.be.revertedWithCustomError(f.engine,'OnlyCoordinator');
  await f.mock.fulfill(s.requestId,987654321n);const r=await f.engine.status(id,0);expect(r.state).to.equal(2n);expect(r.word).to.equal(987654321n);
  await f.mock.fulfill(s.requestId,5n);expect((await f.engine.status(id,0)).word).to.equal(987654321n);
  await f.market.drawCommittee(id);const c=Array.from(await f.market.committeeOf(id));expect(c.length).to.equal(Number(s.size));for(const a of c)expect(pool).to.include(a);expect(new Set(c).size).to.equal(c.length);
  expect((await f.engine.status(id,0)).state).to.equal(3n);expect(await f.mock.nextRequest()).to.equal(next);
  evidence.simulatedFulfill={requestId:s.requestId,word:987654321n,committee:c};
 });

 it('callback gas (selection + selected hold, PAUSE/SATURATION FIX) measured locally stays well under the planned callbackGasLimit (2500000)',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f);await H.fileChallenge(f,id);const s=await f.engine.status(id,0),coord=await f.mock.getAddress();
  await network.provider.send('hardhat_impersonateAccount',[coord]);await network.provider.send('hardhat_setBalance',[coord,'0xDE0B6B3A7640000']);const as=await ethers.getSigner(coord);
  const rc=await (await f.engine.connect(as).rawFulfillRandomWords(s.requestId,[42n])).wait();await network.provider.send('hardhat_stopImpersonatingAccount',[coord]);
  const callback=rc.gasUsed-21000n;expect((await f.engine.status(id,0)).state).to.equal(2n);expect(callback).to.be.lessThan(BigInt(V.BASE_SEPOLIA_PLANNED.callbackGasLimit)/2n);
  evidence.callbackGas={txGasUsed:rc.gasUsed,approxCallbackGas:callback,plannedLimit:V.BASE_SEPOLIA_PLANNED.callbackGasLimit};
 });

 it('engine address is predictable (first CREATE of the market) so addConsumer can be prepared before the first dispute',async()=>{
  const f=await loadFixture(fxt);expect(V.predictEngineAddress(ethers,await f.market.getAddress())).to.equal(await f.market.drawEngine());
  evidence.consumerAddress='drawEngine = getCreateAddress(market, nonce 1); must be addConsumer-ed by the subscription owner (future Safe decision)';
 });

 it('coordinator refuses the request (simulates: consumer not added / invalid subscription) -> Failed, never retried, stays for the Safe path',async()=>{
  const f=await loadFixture(fxt),id=await H.completed(f);
  await f.mock.controls(true,false);const before=await f.mock.nextRequest();await H.fileChallenge(f,id);expect((await f.engine.status(id,0)).state).to.equal(4n);
  await f.mock.controls(false,false);await expect(f.market.drawCommittee(id)).to.be.reverted;expect(await f.mock.nextRequest()).to.equal(before);
 });

 it('local simulated config builder refuses anything but Hardhat 31337 (guard is explicit)',async()=>{
  const fake={network:{name:'baseSepolia'},ethers:{provider:{getNetwork:async()=>({chainId:84532n})},id:ethers.id}};
  let err;try{await V.localSimulatedConfig(fake,ethers.Wallet.createRandom().address,1n);}catch(e){err=e;}expect(String(err)).to.match(/LOCAL ONLY/);
 });
});
