// Approved protections (LOCAL COPY ONLY, Hardhat 31337). The real mainnet Safe is never touched.
//  1. Important roles never go to a personal account (EOA): enforced by SuperionGovernanceTimelock (the only admin).
//  2. SafeLocalGuard on the LOCAL test SafeL2 1.4.1 (3 owners, threshold 2).
//  3. Staking OPERATOR_ROLE only for the official marketplace recorded in the timelock (change only via updateMarket, 48h).
const {expect}=require('chai');const {loadFixture}=require('@nomicfoundation/hardhat-network-helpers');
const H=require('../helpers/filing-shortage-fixture.cjs');const {ethers,P,time}=H;const {network}=require('hardhat');const fs=require('fs');
const LS=require('../helpers/local-safe.cjs');const {safeCall,prepareSafeTx,executeSafeTx,deployLocalSafe,installLocalGuard,types,REAL_MAINNET_SAFE}=LS;
const {governedDeploy,DELAY,assertNoPersonalRoles}=require('../helpers/governed-deploy.cjs');
const evidence={protection1:[],protection2:[],protection3:[]};
async function gov(){const g=await governedDeploy(ethers,P);g.TL=await g.timelock.getAddress();g.S=await g.safe.getAddress();return g;}
let saltN=0;
// Full real path: Safe 2-of-3 schedules, waits 48h, Safe 2-of-3 executes.
async function viaSafe(g,target,data){const salt=ethers.id('rg'+(saltN++)),args=[target,0,data,ethers.ZeroHash,salt];
 await safeCall(ethers,g.safe,g.TL,g.timelock.interface.encodeFunctionData('schedule',[...args,DELAY]),g.owners.slice(0,2),g.relayer);await time.increase(DELAY);
 return safeCall(ethers,g.safe,g.TL,g.timelock.interface.encodeFunctionData('execute',args),g.owners.slice(0,2),g.relayer);}
// Unit path for precise error checks: impersonate the LOCAL Safe address (proposer/executor) to schedule + execute after 48h.
async function asSafe(g){await network.provider.send('hardhat_impersonateAccount',[g.S]);await network.provider.send('hardhat_setBalance',[g.S,'0xDE0B6B3A7640000']);return ethers.getSigner(g.S);}
async function scheduleAndWait(g,target,data){const s=await asSafe(g),salt=ethers.id('u'+(saltN++));await g.timelock.connect(s).schedule(target,0,data,ethers.ZeroHash,salt,DELAY);await time.increase(DELAY);return ()=>g.timelock.connect(s).execute(target,0,data,ethers.ZeroHash,salt);}
const grant=(c,role,acct)=>c.interface.encodeFunctionData('grantRole',[role,acct]);
async function newGuardedSafe(g,{guard=true}={}){const owners=[];for(let i=0;i<3;i++){const w=ethers.Wallet.createRandom().connect(ethers.provider);await g.deployer.sendTransaction({to:w.address,value:ethers.parseEther('1')});owners.push(w);}
 owners.sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));const r=await deployLocalSafe(ethers,owners,g.deployer,{guard});return {...r,owners};}

describe('PROTECTION 1 — important roles never go to a personal account (EOA); control in the 48h timelock (LOCAL ONLY)',function(){
 after(()=>{fs.mkdirSync('logs',{recursive:true});fs.writeFileSync('logs/roles-guard-evidence.json',JSON.stringify({warning:'LOCAL COPY ONLY (Hardhat 31337). Real mainnet Safe '+REAL_MAINNET_SAFE+' never touched. Not an audit. VRF simulated.',...evidence},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');});

 it('after local deployment the deployer keeps NO role anywhere; every role holder is the timelock, the Safe, or (operator) the OFFICIAL marketplace',async()=>{
  const g=await loadFixture(gov),report=await assertNoPersonalRoles(ethers,g);
  const roles={market:[ethers.ZeroHash,await g.market.PAUSER_ROLE(),await g.market.ARBITER_ROLE()],staking:[ethers.ZeroHash,await g.staking.OPERATOR_ROLE()],token:[ethers.ZeroHash,await g.token.PAUSER_ROLE(),await g.token.MINTER_ROLE()],
   timelock:[ethers.ZeroHash,await g.timelock.PROPOSER_ROLE(),await g.timelock.EXECUTOR_ROLE(),await g.timelock.CANCELLER_ROLE()]};
  for(const [n,list] of Object.entries(roles))for(const r of list){expect(await g[n].hasRole(r,g.deployer.address),n+r).to.equal(false);for(const o of g.owners)expect(await g[n].hasRole(r,o.address)).to.equal(false);}
  const allowed=new Set([g.TL,g.S,await g.market.getAddress()]);for(const h of report)expect(allowed.has(h.account),JSON.stringify(h)).to.equal(true);
  expect(await g.token.hasRole(await g.token.PAUSER_ROLE(),g.S)).to.equal(false); // nobody has the token pause (approved)
  expect(await g.timelock.safe()).to.equal(g.S);evidence.protection1.push({case:'deploy-end-state',holders:report});
 });

 it('EXAMPLE: after the full 48h, giving PAUSER_ROLE of the marketplace to a personal account FAILS (real Safe 2-of-3 path and precise error)',async()=>{
  const g=await loadFixture(gov),R=await g.market.PAUSER_ROLE(),M=await g.market.getAddress(),d=grant(g.market,R,g.outsider.address);
  await expect(viaSafe(g,M,d)).to.be.revertedWith('GS013');expect(await g.market.hasRole(R,g.outsider.address)).to.equal(false);
  const exec=await scheduleAndWait(g,M,d);await expect(exec()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed').withArgs(R,g.outsider.address);
  evidence.protection1.push({case:'pauser-to-eoa-after-48h',result:'REFUSED RoleRecipientNotAllowed',account:g.outsider.address});
 });

 it('every important role on every contract is refused for an EOA, also for a Safe OWNER key and the deployer, after 48h',async()=>{
  const g=await loadFixture(gov),T=g.TL;const cases=[];
  const targets=[[g.market,[ethers.ZeroHash,await g.market.PAUSER_ROLE(),await g.market.ARBITER_ROLE()]],[g.staking,[ethers.ZeroHash,await g.staking.OPERATOR_ROLE()]],
   [g.token,[ethers.ZeroHash,await g.token.PAUSER_ROLE(),await g.token.MINTER_ROLE()]],[g.timelock,[ethers.ZeroHash,await g.timelock.PROPOSER_ROLE(),await g.timelock.EXECUTOR_ROLE(),await g.timelock.CANCELLER_ROLE()]]];
  for(const [c,roles] of targets)for(const r of roles)for(const who of [g.outsider,g.owners[0],g.deployer]){
   const exec=await scheduleAndWait(g,await c.getAddress(),grant(c,r,who.address));await expect(exec()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');expect(await c.hasRole(r,who.address)).to.equal(false);cases.push(r);}
  expect(cases.length).to.equal(36);void T;evidence.protection1.push({case:'all-roles-all-contracts-eoa',refused:cases.length});
 });

 it('allowed: PAUSER/ARBITER -> the official Safe; admin -> only the timelock (admin to the Safe refused: it would skip the 48h); a one-person CONTRACT gets no important role',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress(),R=await g.market.PAUSER_ROLE();
  await (await scheduleAndWait(g,M,grant(g.market,await g.market.ARBITER_ROLE(),g.S)))();
  await expect((await scheduleAndWait(g,M,grant(g.market,ethers.ZeroHash,g.S)))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.outsider)).deploy();
  await expect((await scheduleAndWait(g,M,grant(g.market,R,await fw.getAddress())))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  expect(await g.timelock.isAllowedRoleRecipient(R,g.S)).to.equal(true);expect(await g.timelock.isAllowedRoleRecipient(ethers.ZeroHash,g.TL)).to.equal(true);expect(await g.timelock.isAllowedRoleRecipient(ethers.id('ANY_FUTURE_ROLE'),g.outsider.address)).to.equal(false);
 });

 it('staking OPERATOR_ROLE (protection 3): never an EOA, and never an arbitrary contract either — only the official marketplace',async()=>{
  const g=await loadFixture(gov),SA=await g.staking.getAddress(),R=await g.staking.OPERATOR_ROLE();
  await expect((await scheduleAndWait(g,SA,grant(g.staking,R,g.outsider.address)))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.outsider)).deploy();await expect((await scheduleAndWait(g,SA,grant(g.staking,R,await fw.getAddress())))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed').withArgs(R,await fw.getAddress());
  expect(await g.staking.hasRole(R,await fw.getAddress())).to.equal(false);expect(await g.staking.hasRole(R,await g.market.getAddress())).to.equal(true);
  evidence.protection1.push({case:'operator',eoa:'refused',oneOwnerContract:'REFUSED after 48h (protection 3)'});
 });

 it('no bypass: batch with a hidden EOA grant is refused as a whole; Safe/EOA cannot grant directly; nobody can call updateSafe directly',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress(),s=await asSafe(g),R=await g.market.PAUSER_ROLE();
  const tg=[M,M],vals=[0,0],ds=[g.market.interface.encodeFunctionData('setTreasury',[g.treasury.address]),grant(g.market,R,g.outsider.address)],salt=ethers.id('batch');
  await g.timelock.connect(s).scheduleBatch(tg,vals,ds,ethers.ZeroHash,salt,DELAY);await time.increase(DELAY);
  await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  await expect(g.market.connect(s).grantRole(R,g.outsider.address)).to.be.revertedWithCustomError(g.market,'AccessControlUnauthorizedAccount');
  for(const who of [s,g.outsider,g.deployer])await expect(g.timelock.connect(who).updateSafe(g.outsider.address)).to.be.revertedWithCustomError(g.timelock,'TimelockUnauthorizedCaller');
  for(const c of [g.market,g.staking,g.token,g.terms])expect(c.interface.fragments.filter(f=>f.type==='function'&&/multicall|delegate.*call|execute/i.test(f.name)).map(f=>f.name)).to.deep.equal([]);
 });

 it('official Safe change ONLY through the 48h timelock: EOA or unguarded Safe refused; a new guarded 2-of-3 Safe accepted and roles moved in the same batch',async()=>{
  const g=await loadFixture(gov),TL=g.TL,M=await g.market.getAddress(),R=await g.market.PAUSER_ROLE();
  const execEoa=await scheduleAndWait(g,TL,g.timelock.interface.encodeFunctionData('updateSafe',[g.outsider.address]));await expect(execEoa()).to.be.revertedWithCustomError(g.timelock,'InvalidGovernanceSafe').withArgs(g.outsider.address);
  const bare=await newGuardedSafe(g,{guard:false});const execBare=await scheduleAndWait(g,TL,g.timelock.interface.encodeFunctionData('updateSafe',[await bare.safe.getAddress()]));await expect(execBare()).to.be.revertedWithCustomError(g.timelock,'InvalidGovernanceSafe');
  expect(await g.timelock.safe()).to.equal(g.S);
  const n=await newGuardedSafe(g),N=await n.safe.getAddress();const s=await asSafe(g);
  const tg=[TL,M,TL,TL,TL],ds=[g.timelock.interface.encodeFunctionData('updateSafe',[N]),grant(g.market,R,N),grant(g.timelock,await g.timelock.PROPOSER_ROLE(),N),grant(g.timelock,await g.timelock.EXECUTOR_ROLE(),N),grant(g.timelock,await g.timelock.CANCELLER_ROLE(),N)],vals=tg.map(()=>0),salt=ethers.id('move');
  await g.timelock.connect(s).scheduleBatch(tg,vals,ds,ethers.ZeroHash,salt,DELAY);await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.be.reverted;
  await time.increase(DELAY);await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.emit(g.timelock,'SafeUpdated').withArgs(g.S,N);
  expect(await g.timelock.safe()).to.equal(N);expect(await g.market.hasRole(R,N)).to.equal(true);
  await safeCall(ethers,n.safe,M,g.market.interface.encodeFunctionData('pause'),n.owners.slice(0,2),g.relayer);expect(await g.market.paused()).to.equal(true);
  // the OLD Safe is no longer an allowed recipient
  expect(await g.timelock.isAllowedRoleRecipient(R,g.S)).to.equal(false);
  evidence.protection1.push({case:'safe-change',eoa:'refused',unguardedSafe:'refused',newGuardedSafe:'accepted after 48h, roles moved in the same batch'});
 });

 it('timelock construction refuses: zero official marketplace, EOA proposer, unguarded Safe, extra admin, proposer != executor, delay < 48h',async()=>{
  const g=await loadFixture(gov),F=await ethers.getContractFactory('SuperionGovernanceTimelock'),M0=await g.market.getAddress();await expect(F.deploy(DELAY,[g.S],[g.S],ethers.ZeroAddress,ethers.ZeroAddress)).to.be.revertedWithCustomError(F,'InvalidOfficialMarket');const bare=await newGuardedSafe(g,{guard:false}),B=await bare.safe.getAddress();
  await expect(F.deploy(DELAY,[g.outsider.address],[g.outsider.address],ethers.ZeroAddress,M0)).to.be.revertedWithCustomError(F,'InvalidGovernanceSafe');
  await expect(F.deploy(DELAY,[B],[B],ethers.ZeroAddress,M0)).to.be.revertedWithCustomError(F,'InvalidGovernanceSafe');
  await expect(F.deploy(DELAY,[g.S],[g.S],g.outsider.address,M0)).to.be.revertedWithCustomError(F,'InvalidRoleSetup');
  await expect(F.deploy(DELAY,[g.S],[ethers.ZeroAddress],ethers.ZeroAddress,M0)).to.be.revertedWithCustomError(F,'InvalidRoleSetup');
  await expect(F.deploy(DELAY-1n,[g.S],[g.S],ethers.ZeroAddress,M0)).to.be.revertedWithCustomError(F,'DelayBelowFloor');
  expect(await g.timelock.guardCodehash()).to.equal(ethers.keccak256(await ethers.provider.getCode(await g.guard.getAddress())));
 });
});

describe('PROTECTION 3 — staking OPERATOR_ROLE only for the OFFICIAL marketplace; marketplace change only via the 48h timelock (LOCAL ONLY)',function(){
 const {legacyFactory}=require('../helpers/legacy-vrf-fixture.cjs');const S$=ethers.parseEther;
 const newMarket=async(g,staking)=>(await legacyFactory()).deploy(await g.token.getAddress(),staking||await g.staking.getAddress(),g.TL,g.S,g.S,g.treasury.address,P);
 const upd=(g,a)=>g.timelock.interface.encodeFunctionData('updateMarket',[a]);
 it('EXAMPLE (Alice 5 000 SUPER): a one-person contract asks for OPERATOR_ROLE through the FULL real path (Safe 2-of-3, 48h) -> REFUSED; Alice keeps 5 000 and can leave; the marketplace stays the only operator',async()=>{
  const g=await loadFixture(gov),alice=g.vs[8],SA=await g.staking.getAddress(),R=await g.staking.OPERATOR_ROLE(),M=await g.market.getAddress();
  await g.token.transfer(alice.address,S$('5000'));await g.token.connect(alice).approve(SA,S$('5000'));await g.staking.connect(alice).stake(S$('5000'));
  const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.outsider)).deploy(),FW=await fw.getAddress(),d=grant(g.staking,R,FW);
  await expect(viaSafe(g,SA,d)).to.be.revertedWith('GS013'); // the Safe tx itself fails at execute: the timelock refuses
  const exec=await scheduleAndWait(g,SA,d);await expect(exec()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed').withArgs(R,FW);
  expect(await g.staking.hasRole(R,FW)).to.equal(false);
  await expect(fw.connect(g.outsider).exec(SA,g.staking.interface.encodeFunctionData('slash',[alice.address,S$('5000')]))).to.be.revertedWithCustomError(g.staking,'AccessControlUnauthorizedAccount');
  expect(await g.staking.balanceOf(alice.address)).to.equal(S$('5000'));expect(await g.staking.lockedStake(alice.address)).to.equal(0n);
  await g.staking.connect(alice).requestUnstake(S$('5000'));
  const ops=[];for(const e of await g.staking.queryFilter(g.staking.filters.RoleGranted(R)))if(await g.staking.hasRole(R,e.args.account))ops.push(e.args.account);
  expect(ops).to.deep.equal([M]);expect(await g.timelock.officialMarket()).to.equal(M);
  for(const a of [g.S,g.TL,g.outsider.address,FW])expect(await g.timelock.isAllowedRoleRecipient(R,a)).to.equal(false);expect(await g.timelock.isAllowedRoleRecipient(R,M)).to.equal(true);
  evidence.protection3=evidence.protection3||[];evidence.protection3.push({case:'alice-5000-one-person-contract',grantAfter48h:'REFUSED RoleRecipientNotAllowed',aliceStakeAfter:'5000 SUPER',aliceCanUnstake:true,operators:ops});
 });
 it('no bypass: hidden operator grant inside a batch refused as a whole; Safe/timelock/old-style grants refused; nobody can call updateMarket directly',async()=>{
  const g=await loadFixture(gov),SA=await g.staking.getAddress(),R=await g.staking.OPERATOR_ROLE(),M=await g.market.getAddress(),s=await asSafe(g);
  const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.outsider)).deploy();
  const tg=[M,SA],ds=[g.market.interface.encodeFunctionData('setTreasury',[g.treasury.address]),grant(g.staking,R,await fw.getAddress())],vals=[0,0],salt=ethers.id('b3');
  await g.timelock.connect(s).scheduleBatch(tg,vals,ds,ethers.ZeroHash,salt,DELAY);await time.increase(DELAY);
  await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  for(const a of [g.S,g.TL])await expect((await scheduleAndWait(g,SA,grant(g.staking,R,a)))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  for(const who of [s,g.outsider,g.deployer,g.owners[0]]){await expect(g.timelock.connect(who).updateMarket(await fw.getAddress())).to.be.revertedWithCustomError(g.timelock,'TimelockUnauthorizedCaller');await expect(g.staking.connect(who).grantRole(R,await fw.getAddress())).to.be.revertedWithCustomError(g.staking,'AccessControlUnauthorizedAccount');}
  expect(await g.timelock.officialMarket()).to.equal(M);
 });
 it('official marketplace change ONLY through the 48h timelock: EOA, one-person contract, wrong staking, same address refused; a real new marketplace accepted, then operator granted in the same batch; the OLD one can no longer receive the role',async()=>{
  const g=await loadFixture(gov),TL=g.TL,SA=await g.staking.getAddress(),R=await g.staking.OPERATOR_ROLE(),M=await g.market.getAddress(),s=await asSafe(g);
  const fw=await(await ethers.getContractFactory('TestOperatorForwarder',g.outsider)).deploy();
  const otherStaking=await(await ethers.getContractFactory('SuperionStakingV2')).deploy(await g.token.getAddress(),g.deployer.address,60),wrong=await newMarket(g,await otherStaking.getAddress());
  for(const bad of [g.outsider.address,await fw.getAddress(),await wrong.getAddress(),M,ethers.ZeroAddress])await expect((await scheduleAndWait(g,TL,upd(g,bad)))()).to.be.revertedWithCustomError(g.timelock,'InvalidOfficialMarket').withArgs(bad);
  const n=await newMarket(g),N=await n.getAddress();
  // grant BEFORE updateMarket in a batch -> refused (order matters, the rule is checked at execution)
  let tg=[SA,TL],ds=[grant(g.staking,R,N),upd(g,N)],vals=[0,0],salt=ethers.id('m-bad');await g.timelock.connect(s).scheduleBatch(tg,vals,ds,ethers.ZeroHash,salt,DELAY);await time.increase(DELAY);
  await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  tg=[TL,SA];ds=[upd(g,N),grant(g.staking,R,N)];salt=ethers.id('m-ok');await g.timelock.connect(s).scheduleBatch(tg,vals,ds,ethers.ZeroHash,salt,DELAY);
  await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.be.reverted; // before 48h
  await time.increase(DELAY);await expect(g.timelock.connect(s).executeBatch(tg,vals,ds,ethers.ZeroHash,salt)).to.emit(g.timelock,'OfficialMarketUpdated').withArgs(M,N);
  expect(await g.timelock.officialMarket()).to.equal(N);expect(await g.staking.hasRole(R,N)).to.equal(true);
  // one official marketplace at a time: the old one cannot (re)receive the role; it keeps its current role only until revoked (to settle open jobs)
  expect(await g.timelock.isAllowedRoleRecipient(R,M)).to.equal(false);expect(await g.staking.hasRole(R,M)).to.equal(true);
  await expect((await scheduleAndWait(g,SA,g.staking.interface.encodeFunctionData('revokeRole',[R,M])))()).to.not.be.reverted;
  expect(await g.staking.hasRole(R,M)).to.equal(false);
  await expect((await scheduleAndWait(g,SA,grant(g.staking,R,M)))()).to.be.revertedWithCustomError(g.timelock,'RoleRecipientNotAllowed');
  evidence.protection3=evidence.protection3||[];evidence.protection3.push({case:'market-change',refused:['EOA','one-person contract','marketplace on another staking','same address','zero'],accepted:'new real marketplace after 48h, operator granted in the same batch',oldMarket:'can no longer receive the role; revoked by a separate 48h operation'});
 });
 it('LIMIT (documented): a contract that LIES in its views (fake marketplace) passes updateMarket IF Safe 2-of-3 approves and nobody reacts during the public 48h',async()=>{
  const g=await loadFixture(gov),R=await g.staking.OPERATOR_ROLE(),SA=await g.staking.getAddress();
  const fake=await(await ethers.getContractFactory('TestFakeMarket',g.outsider)).deploy(SA,await g.token.getAddress(),g.TL),F=await fake.getAddress();
  await (await scheduleAndWait(g,g.TL,g.timelock.interface.encodeFunctionData('updateMarket',[F])))();expect(await g.timelock.officialMarket()).to.equal(F);
  evidence.protection3=evidence.protection3||[];evidence.protection3.push({case:'limit-fake-market',result:'accepted only after Safe 2-of-3 + public 48h (OfficialMarketUpdated event visible); checks are sanity checks, not a proof of code'});
 });
});

describe('PROTECTION 2 — SafeLocalGuard on the LOCAL test Safe only (SafeL2 1.4.1, 3 owners, threshold 2)',function(){
 async function rawSafeTx(g,{to,data,operation=0,signers}){const message={to,value:0n,data,operation,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:ethers.ZeroAddress,refundReceiver:ethers.ZeroAddress,nonce:await g.safe.nonce()};
  const domain={chainId:31337n,verifyingContract:g.S};const pieces=[];for(const o of signers)pieces.push({a:o.address,s:await o.signTypedData(domain,types,message)});pieces.sort((x,y)=>x.a.toLowerCase().localeCompare(y.a.toLowerCase()));
  return g.safe.connect(g.relayer).execTransaction(message.to,0,message.data,operation,0,0,0,ethers.ZeroAddress,ethers.ZeroAddress,ethers.concat(pieces.map(p=>p.s)),{gasLimit:6000000});}
 const self=(g,fn,args)=>safeCall(ethers,g.safe,g.S,g.safe.interface.encodeFunctionData(fn,args),g.owners.slice(0,2),g.relayer);

 it('installed on the LOCAL Safe via the official setGuard (ERC165 0xe6d7a83a); refuses to touch the real mainnet Safe address',async()=>{
  const g=await loadFixture(gov);expect(await g.guard.supportsInterface('0xe6d7a83a')).to.equal(true);
  expect(await ethers.provider.getStorage(g.S,ethers.id('guard_manager.guard.address'))).to.equal(ethers.zeroPadValue(await g.guard.getAddress(),32));
  expect(await g.safe.VERSION()).to.equal('1.4.1');expect(await g.safe.getThreshold()).to.equal(2n);expect((await g.safe.getOwners()).length).to.equal(3);
  const fake={getAddress:async()=>REAL_MAINNET_SAFE};let err;try{await installLocalGuard(ethers,fake,g.owners,g.relayer);}catch(e){err=e;}expect(String(err)).to.match(/never install anything on the real mainnet Safe/);
  expect(await ethers.provider.getCode(REAL_MAINNET_SAFE)).to.equal('0x'); // local chain: the real Safe does not even exist here
  expect(network.name).to.equal('hardhat');
 });

 it('EXAMPLE: threshold to 1 REFUSED (and to 0); threshold 3 allowed',async()=>{
  const g=await loadFixture(gov);
  await expect(self(g,'changeThreshold',[1])).to.be.revertedWithCustomError(g.guard,'ThresholdTooLow').withArgs(1n);
  await expect(self(g,'changeThreshold',[0])).to.be.revertedWithCustomError(g.guard,'ThresholdTooLow').withArgs(0n);
  expect(await g.safe.getThreshold()).to.equal(2n);await self(g,'changeThreshold',[3]);expect(await g.safe.getThreshold()).to.equal(3n);
  evidence.protection2.push({case:'threshold-to-1',result:'REFUSED ThresholdTooLow(1)'});
 });

 it('owners: add with threshold 1 refused; add with 2 ok; remove down to 2 owners ok; removing to 1 owner (or threshold 1) refused; swap ok',async()=>{
  const g=await loadFixture(gov),SENT='0x0000000000000000000000000000000000000001',w=ethers.Wallet.createRandom();
  await expect(self(g,'addOwnerWithThreshold',[w.address,1])).to.be.revertedWithCustomError(g.guard,'ThresholdTooLow');
  await self(g,'addOwnerWithThreshold',[w.address,2]);expect((await g.safe.getOwners()).length).to.equal(4);
  const prevOf=async(o)=>{const os=await g.safe.getOwners();const i=os.indexOf(o);return i===0?SENT:os[i-1];};
  await self(g,'removeOwner',[await prevOf(w.address),w.address,2]);
  const o2=g.owners[2].address;await expect(self(g,'removeOwner',[await prevOf(o2),o2,1])).to.be.revertedWithCustomError(g.guard,'ThresholdTooLow');
  await self(g,'removeOwner',[await prevOf(o2),o2,2]);expect((await g.safe.getOwners()).length).to.equal(2);
  const o1=g.owners[1].address;await expect(self(g,'removeOwner',[await prevOf(o1),o1,2])).to.be.revertedWithCustomError(g.guard,'TooFewOwners').withArgs(1n);
  const w2=ethers.Wallet.createRandom();await self(g,'swapOwner',[await prevOf(o1),o1,w2.address]);expect(await g.safe.getOwners()).to.include(w2.address);expect(await g.safe.getThreshold()).to.equal(2n);
 });

 it('modules: enableModule refused; guard removal (setGuard 0) and replacement refused',async()=>{
  const g=await loadFixture(gov);await expect(self(g,'enableModule',[g.outsider.address])).to.be.revertedWithCustomError(g.guard,'ModulesBlocked');
  await expect(self(g,'setGuard',[ethers.ZeroAddress])).to.be.revertedWithCustomError(g.guard,'GuardIsPermanent');
  const other=await(await ethers.getContractFactory('SafeLocalGuard')).deploy();await expect(self(g,'setGuard',[await other.getAddress()])).to.be.revertedWithCustomError(g.guard,'GuardIsPermanent');
  expect(await ethers.provider.getStorage(g.S,ethers.id('guard_manager.guard.address'))).to.equal(ethers.zeroPadValue(await g.guard.getAddress(),32));
 });

 it('PAUSE/JURY/GUARD FIX: setFallbackHandler (0xf08a0323) refused even with 2 of 3 signatures; handler slot unchanged; unguarded Safe CAN change it',async()=>{
  const g=await loadFixture(gov),SLOT=ethers.id('fallback_manager.handler.address');expect(g.safe.interface.getFunction('setFallbackHandler').selector).to.equal('0xf08a0323');expect(ethers.id('setFallbackHandler(address)').slice(0,10)).to.equal('0xf08a0323');
  const before=await ethers.provider.getStorage(g.S,SLOT);
  await expect(self(g,'setFallbackHandler',[g.outsider.address])).to.be.revertedWithCustomError(g.guard,'FallbackHandlerBlocked');
  await expect(self(g,'setFallbackHandler',[ethers.ZeroAddress])).to.be.revertedWithCustomError(g.guard,'FallbackHandlerBlocked');
  await expect(rawSafeTx(g,{to:g.S,data:g.safe.interface.encodeFunctionData('setFallbackHandler',[g.outsider.address]),signers:g.owners})).to.be.revertedWithCustomError(g.guard,'FallbackHandlerBlocked'); // 3 of 3 too
  expect(await ethers.provider.getStorage(g.S,SLOT)).to.equal(before);
  // the other rules still hold after the refusals
  await expect(self(g,'changeThreshold',[1])).to.be.revertedWithCustomError(g.guard,'ThresholdTooLow');await expect(self(g,'enableModule',[g.outsider.address])).to.be.revertedWithCustomError(g.guard,'ModulesBlocked');
  await self(g,'changeThreshold',[3]);expect(await g.safe.getThreshold()).to.equal(3n);
  const bare=await newGuardedSafe(g,{guard:false}),B=await bare.safe.getAddress();await safeCall(ethers,bare.safe,B,bare.safe.interface.encodeFunctionData('setFallbackHandler',[g.outsider.address]),bare.owners.slice(0,2),g.relayer);
  expect(await ethers.provider.getStorage(B,SLOT)).to.equal(ethers.zeroPadValue(g.outsider.address,32));
  evidence.protection2.push({case:'setFallbackHandler',selector:'0xf08a0323',guarded:'REFUSED FallbackHandlerBlocked (2-of-3 and 3-of-3)',unguardedReproduction:'possible without guard'});
 });

 it('DELEGATECALL refused (it could rewrite the Safe storage); after-execution catch-all refuses a Safe without this guard / with a module',async()=>{
  const g=await loadFixture(gov);await expect(rawSafeTx(g,{to:await g.market.getAddress(),data:'0x',operation:1,signers:g.owners.slice(0,2)})).to.be.revertedWithCustomError(g.guard,'DelegateCallBlocked');
  // catch-all: called by an UNGUARDED local Safe it refuses (guard slot is not this guard)
  const bare=await newGuardedSafe(g,{guard:false}),B=await bare.safe.getAddress();await network.provider.send('hardhat_impersonateAccount',[B]);await network.provider.send('hardhat_setBalance',[B,'0xDE0B6B3A7640000']);
  await expect(g.guard.connect(await ethers.getSigner(B)).checkAfterExecution(ethers.ZeroHash,true)).to.be.revertedWithCustomError(g.guard,'GuardRemoved');
  await network.provider.send('hardhat_impersonateAccount',[g.S]);await network.provider.send('hardhat_setBalance',[g.S,'0xDE0B6B3A7640000']);
  await g.guard.connect(await ethers.getSigner(g.S)).checkAfterExecution(ethers.ZeroHash,true); // passes on the guarded Safe
 });

 it('normal Safe work still passes the guard: immediate pause/unpause (2 sigs), timelock scheduling, 1 signature still refused (GS020)',async()=>{
  const g=await loadFixture(gov),M=await g.market.getAddress();
  await safeCall(ethers,g.safe,M,g.market.interface.encodeFunctionData('pause'),g.owners.slice(0,2),g.relayer);expect(await g.market.paused()).to.equal(true);
  await safeCall(ethers,g.safe,M,g.market.interface.encodeFunctionData('unpause'),g.owners.slice(1,3),g.relayer);expect(await g.market.paused()).to.equal(false);
  const p=await prepareSafeTx(ethers,g.safe,M,g.market.interface.encodeFunctionData('pause'),[g.owners[0]]);await expect(executeSafeTx(g.safe,g.relayer,p)).to.be.revertedWith('GS020');
  await viaSafe(g,await g.market.getAddress(),g.market.interface.encodeFunctionData('setTreasury',[g.treasury.address]));
 });

 it('REPRODUCTION without the guard (earlier risk): an unguarded local Safe CAN drop to threshold 1 and enable a module',async()=>{
  const g=await loadFixture(gov),bare=await newGuardedSafe(g,{guard:false}),B=await bare.safe.getAddress();
  await safeCall(ethers,bare.safe,B,bare.safe.interface.encodeFunctionData('changeThreshold',[1]),bare.owners.slice(0,2),g.relayer);expect(await bare.safe.getThreshold()).to.equal(1n);
  await safeCall(ethers,bare.safe,B,bare.safe.interface.encodeFunctionData('enableModule',[g.outsider.address]),bare.owners.slice(0,1),g.relayer);expect(await bare.safe.isModuleEnabled(g.outsider.address)).to.equal(true);
  evidence.protection2.push({case:'unguarded-reproduction',thresholdTo1:'possible without guard',enableModule:'possible without guard'});
 });
});
