// LOCAL PROTOTYPE (Hardhat 31337). Approved change (pt99u): new default split for NEW missions
// (5 % fee on 1000 SUPER = treasury 25 + stakers 15 + burn 10) and treasury ADDRESS frozen at job creation.
// address(0) remains allowed: the treasury share then goes to stakers. VRF oracle simulated. Not an audit.
const {expect}=require('chai');const {loadFixture,time}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,S}=H;const fs=require('fs'),evidence=[];
const OLD={...P,feeBps:250,burnShareBps:4000,treasuryShareBps:1000};// previous default (2.5 %: 10 burn / 2.5 treasury / 12.5 stakers)
async function fx(){const f=await H.fixture();f.terms=await ethers.getContractAt('MissionTerms',await f.market.terms());return f;}
async function balances(f){return {provider:await f.token.balanceOf(f.provider.address),treasury:await f.token.balanceOf(f.treasury.address),outsider:await f.token.balanceOf(f.outsider.address),
 creator:await f.token.balanceOf(f.creator.address),rewards:await f.staking.totalRewardsOwed()+await f.staking.queuedRewards(),supply:await f.token.totalSupply()};}
async function finalize(f,id){const b=await balances(f),dl=(await f.market.effectiveProtectedDeadline(id))+1n;if(BigInt(await time.latest())<dl)await time.increaseTo(dl);await f.market.finalizeJob(id);const a=await balances(f);
 return {provider:a.provider-b.provider,treasury:a.treasury-b.treasury,outsider:a.outsider-b.outsider,stakers:a.rewards-b.rewards,burned:b.supply-a.supply};}
const fmt=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='bigint'?ethers.formatEther(v):v]));

describe('Approved fee split 25/15/10 + treasury address frozen per mission (LOCAL PROTOTYPE)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/fee-split-frozen-treasury-evidence.json',JSON.stringify({warning:'LOCAL Hardhat 31337 only; nothing deployed; VRF simulated; amounts in SUPER',cases:evidence},null,2)+'\n');});
 it('(a) default rules: 1000 SUPER mission paid to provider -> fee 50 = treasury 25 + stakers 15 + burn 10; provider 950',async()=>{
  const f=await loadFixture(fx),c=await f.terms.current();expect([c.feeBps,c.burnShareBps,c.treasuryShareBps]).to.deep.equal([500n,2000n,5000n]);
  const id=await H.completed(f),j=await f.market.jobs(id);expect([j.feeBps,j.burnShareBps,j.treasuryShareBps,j.treasury]).to.deep.equal([500n,2000n,5000n,f.treasury.address]);
  const r=await finalize(f,id);expect(r).to.deep.equal({provider:S('950'),treasury:S('25'),outsider:0n,stakers:S('15'),burned:S('10')});
  evidence.push({case:'(a) new split, 1000 SUPER',...fmt(r)});
 });
 it('old missions keep their frozen OLD rates (975 / 2.5 / 12.5 / 10) while new missions use 25 / 15 / 10',async()=>{
  const f=await loadFixture(fx);await f.terms.setParams(OLD);const old=await H.completed(f);await f.terms.setParams(P);const fresh=await H.completed(f);
  expect((await f.market.jobs(old)).feeBps).to.equal(250n);expect((await f.market.jobs(fresh)).feeBps).to.equal(500n);
  const ro=await finalize(f,old),rn=await finalize(f,fresh);
  expect(ro).to.deep.equal({provider:S('975'),treasury:S('2.5'),outsider:0n,stakers:S('12.5'),burned:S('10')});
  expect(rn).to.deep.equal({provider:S('950'),treasury:S('25'),outsider:0n,stakers:S('15'),burned:S('10')});
  evidence.push({case:'old mission keeps old frozen rates',old:fmt(ro),new:fmt(rn)});
 });
 it('(b) creator wins (Safe arbitration false): no fee is taken -> treasury 0, no TreasuryPaid; actual existing amounts recorded',async()=>{
  const f=await loadFixture(fx),id=await H.completed(f);await H.keep(f,[]);await H.fileChallenge(f,id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);
  const b=await balances(f),ch0=await f.token.balanceOf(f.challenger.address),pst0=await f.staking.balanceOf(f.provider.address),blk=await ethers.provider.getBlockNumber();
  await H.arbitrate(f,id,false);const a=await balances(f);
  expect(a.treasury).to.equal(b.treasury);expect((await f.market.queryFilter(f.market.filters.TreasuryPaid(),blk+1)).length).to.equal(0);
  const r={creator:a.creator-b.creator,challenger:(await f.token.balanceOf(f.challenger.address))-ch0,treasury:a.treasury-b.treasury,stakersRewards:a.rewards-b.rewards,burned:b.supply-a.supply,providerStakeSlashed:pst0-await f.staking.balanceOf(f.provider.address)};
  expect(r.creator).to.equal(S('1000'));// budget refunded in full; existing guarantee-slash rules unchanged
  evidence.push({case:'(b) creator wins: actual behaviour',...fmt(r),note:'fee split not applied: treasury receives 0'});
 });
 it('(c) treasury address is FROZEN at creation: a global change during a long mission pays the OLD frozen address, not the new one',async()=>{
  const f=await loadFixture(fx),id=await H.completed(f);expect((await f.market.jobs(id)).treasury).to.equal(f.treasury.address);
  await f.market.setTreasury(f.outsider.address);expect(await f.market.treasury()).to.equal(f.outsider.address);expect((await f.market.jobs(id)).treasury).to.equal(f.treasury.address);
  await H.keep(f,[]);await H.fileChallenge(f,id);await time.increaseTo((await f.market.effectiveProtectedDeadline(id))+1n);await f.market.resolveStale(id);await time.increase(30*86400);
  const b=await balances(f),blk=await ethers.provider.getBlockNumber();await H.arbitrate(f,id,true);const a=await balances(f);
  expect(a.treasury-b.treasury).to.equal(S('25'));expect(a.outsider).to.equal(b.outsider);
  const ev=await f.market.queryFilter(f.market.filters.TreasuryPaid(),blk+1);expect(ev.length).to.equal(1);expect(ev[0].args.treasury).to.equal(f.treasury.address);expect(ev[0].args.amount).to.equal(S('25'));
  for(const v of f.vs.slice(0,5))await f.market.connect(v).registerVerifierWithStake(S('1000'));
  const fresh=await H.completed(f);expect((await f.market.jobs(fresh)).treasury).to.equal(f.outsider.address);const rn=await finalize(f,fresh);expect(rn.outsider).to.equal(S('25'));expect(rn.treasury).to.equal(0n);
  evidence.push({case:'(c) frozen address',oldMissionPaidTo:'creation-time treasury',oldMissionAmount:'25',newTreasuryFromOldMission:'0',newMissionPaidTo:'new treasury',newMissionAmount:'25',heldDays:30});
 });
 it('(d) address(0) remains accepted; a mission created with zero sends 25 to stakers (40 total); an existing mission keeps its non-zero frozen address',async()=>{
  const f=await loadFixture(fx),before=await H.completed(f);await f.market.setTreasury(ethers.ZeroAddress);const z=await H.completed(f);
  expect((await f.market.jobs(z)).treasury).to.equal(ethers.ZeroAddress);expect((await f.market.jobs(before)).treasury).to.equal(f.treasury.address);
  const rz=await finalize(f,z);expect(rz).to.deep.equal({provider:S('950'),treasury:0n,outsider:0n,stakers:S('40'),burned:S('10')});
  const rb=await finalize(f,before);expect(rb.treasury).to.equal(S('25'));expect(rb.stakers).to.equal(S('15'));
  evidence.push({case:'(d) zero treasury',zeroMission:fmt(rz),earlierMission:fmt(rb)});
 });
 it('ABI/getter: jobs(id) exposes the frozen treasury; setTreasury keeps its access rule (admin only) and event',async()=>{
  const f=await loadFixture(fx);await expect(f.market.connect(f.outsider).setTreasury(f.outsider.address)).to.be.revertedWithCustomError(f.market,'AccessControlUnauthorizedAccount');
  await expect(f.market.setTreasury(f.outsider.address)).to.emit(f.market,'TreasuryUpdated').withArgs(f.outsider.address);
  const rc=await(await f.market.connect(f.creator).createJob(S('1000'),3600,'gas')).wait();evidence.push({case:'createJob gas',gas:rc.gasUsed.toString(),previousBaseline:'247281'});
 });
});
