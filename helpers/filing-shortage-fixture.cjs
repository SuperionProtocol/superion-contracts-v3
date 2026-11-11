const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('./legacy-vrf-fixture.cjs');
// LOCAL TEST DATA ONLY. Uses the exact official Safe bytecode via local-safe.cjs.
const {ethers}=require('hardhat');
const {time,mine}=require('@nomicfoundation/hardhat-network-helpers');
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require('../scripts/v3/config.cjs');
const {deployLocalSafe,prepareSafeTx,executeSafeTx,safeCall}=require('./local-safe.cjs');
const S=ethers.parseEther;
async function fixture(){
 const all=await ethers.getSigners(),[admin,creator,provider,challenger,treasury,relayer,outsider]=all;
 const vs=all.slice(7,17),owners=all.slice(17,20),local=await deployLocalSafe(ethers,owners,admin);
 const token=await(await ethers.getContractFactory('SuperionToken')).deploy(admin.address);
 const staking=await(await ethers.getContractFactory('SuperionStakingV2')).deploy(await token.getAddress(),admin.address,60);
 const market=await(await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),admin.address,admin.address,await local.safe.getAddress(),treasury.address,P);
 await staking.grantRole(await staking.OPERATOR_ROLE(),await market.getAddress());
 for(const a of [creator,provider,challenger,...vs]){
  await token.transfer(a.address,S('100000'));await token.connect(a).approve(await staking.getAddress(),ethers.MaxUint256);await token.connect(a).approve(await market.getAddress(),ethers.MaxUint256);
 }
 await staking.connect(provider).stake(S('20000'));
 for(const a of vs){await staking.connect(a).stake(S('10000'));await market.connect(a).registerVerifier();}
 return {admin,creator,provider,challenger,treasury,relayer,outsider,vs,owners,...local,token,staking,market};
}
async function completed(f){
 const id=await f.market.nextJobId();await f.market.connect(f.creator).createJob(S('1000'),3600,'local-shortage');
 await f.market.connect(f.provider).assignJob(id);await f.market.connect(f.provider).submitResult(id,'local-result');return id;
}
async function keep(f,addresses){
 const wanted=new Set(addresses.map(a=>(a.address||a).toLowerCase()));
 for(const v of f.vs)if(!wanted.has(v.address.toLowerCase())&&(await f.market.verifiers(v.address)).indexPlus1!==0n)await f.market.connect(v).exitVerifier();
}
async function fileChallenge(f,id,who=f.challenger){return f.market.connect(who).challengeJob(id,ethers.id('timely-filing-'+id));}
async function draw(f,id){await mine(1);await legacyDraw(f.market,id);return Array.from(await f.market.committeeOf(id));}
async function vote(f,id,answers){
 const c=await f.market.committeeOf(id),d=await f.market.disputes(id),r=await f.market.rounds(id,d.round);
 for(let i=0;i<c.length;i++){
  const salt=ethers.id('shortage-vote-'+i),hash=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bool','bytes32','address','uint256'],[answers[i],salt,c[i],id]));
  await f.market.connect(await ethers.getSigner(c[i])).commitVote(id,hash);
 }
 await time.increaseTo(r.commitDeadline+1n);
 for(let i=0;i<c.length;i++)await f.market.connect(await ethers.getSigner(c[i])).revealVote(id,answers[i],ethers.id('shortage-vote-'+i));
}
async function firstVerdict(f,original=true){
 const id=await completed(f);await fileChallenge(f,id);const c0=await draw(f,id);await vote(f,id,[original,original,!original]);await f.market.resolveDispute(id);return {id,c0,original,appellant:original?f.creator:f.provider};
}
async function prepareAppeal(f,original=true,freshCount=0){
 const s=await firstVerdict(f,original),fresh=f.vs.filter(v=>!s.c0.includes(v.address));
 await keep(f,[...s.c0,...fresh.slice(0,freshCount)]);return {...s,fresh};
}
async function fileAppeal(f,s){return f.market.connect(s.appellant).appeal(s.id);}
async function prepared(f,id,result,owners=f.owners.slice(0,2)){
 return prepareSafeTx(ethers,f.safe,await f.market.getAddress(),f.market.interface.encodeFunctionData('arbitrate',[id,result]),owners);
}
async function arbitrate(f,id,result){return safeCall(ethers,f.safe,await f.market.getAddress(),f.market.interface.encodeFunctionData('arbitrate',[id,result]),f.owners.slice(0,2),f.relayer);}
async function snapshot(f,id){
 const j=await f.market.jobs(id),d=await f.market.disputes(id);
 return {status:j.status,budget:j.budget,providerJobLock:j.lockedStake,bond:d.bond,appealBond:d.appealBond,round:d.round,
  escrow:await f.token.balanceOf(await f.market.getAddress()),creator:await f.token.balanceOf(f.creator.address),provider:await f.token.balanceOf(f.provider.address),challenger:await f.token.balanceOf(f.challenger.address),treasury:await f.token.balanceOf(f.treasury.address),supply:await f.token.totalSupply(),providerStake:await f.staking.balanceOf(f.provider.address),providerStakingLock:await f.staking.lockedStake(f.provider.address)};
}
async function eligibleArbitration(f,id){await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);return f.market.connect(f.outsider).resolveStale(id);}
module.exports={ethers,P,S,fixture,completed,keep,fileChallenge,draw,vote,firstVerdict,prepareAppeal,fileAppeal,prepared,arbitrate,snapshot,eligibleArbitration,executeSafeTx,time,mine};
