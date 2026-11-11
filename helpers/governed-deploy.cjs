// LOCAL-ONLY governed wiring (Hardhat 31337). NOT a deployment script: refuses any other network.
// Protection 1 (approved): role recipients are checked by SuperionGovernanceTimelock and the final wiring is asserted
// (assertNoPersonalRoles). Protection 2 (approved): the LOCAL Safe has SafeLocalGuard installed. Never the real Safe.
// Admin = SuperionGovernanceTimelock (>=48h, proposer+executor = local official SafeL2 2-of-3, timelock self-admin).
// ARBITER_ROLE = Safe directly (arbitration not delayed).
// Marketplace PAUSER_ROLE = Safe ONLY, directly (pause AND unpause immediate, 2 distinct Safe signatures). Approved by the user.
// No EOA / AI / assistant key holds any PAUSER_ROLE. The timelock is NOT a pauser.
// Token: admin moved to the timelock; deployer renounces DEFAULT_ADMIN, MINTER (no mint function exists) and PAUSER.
//        Token PAUSER_ROLE left UNASSIGNED = separate pending decision (a token pause freezes ALL transfers of everyone).
const {legacyFactory}=require('./legacy-vrf-fixture.cjs');const {deployLocalSafe,assertLocal}=require('./local-safe.cjs');
const DELAY=48n*3600n;
async function governedDeploy(ethers,params){
 await assertLocal(ethers);
 const all=await ethers.getSigners(),[deployer,creator,provider,challenger,treasury,relayer,outsider]=all,vs=all.slice(7,17),owners=all.slice(17,20);
 const {safe,guard}=await deployLocalSafe(ethers,owners,deployer);const S=await safe.getAddress();
 // The marketplace needs the timelock address (admin) and the timelock needs the official marketplace (sole staking
 // operator): the marketplace CREATE address is precomputed from the deployer nonce and ASSERTED after deployment.
 // Order after the timelock: token(+1), staking(+2), VRF mock(+3), createSubscription(+4), fundSubscription(+5), market(+6).
 const n0=await ethers.provider.getTransactionCount(deployer.address),predictedMarket=ethers.getCreateAddress({from:deployer.address,nonce:n0+6});
 const timelock=await(await ethers.getContractFactory('SuperionGovernanceTimelock')).deploy(DELAY,[S],[S],ethers.ZeroAddress,predictedMarket);const TL=await timelock.getAddress();
 const token=await(await ethers.getContractFactory('SuperionToken')).deploy(deployer.address);
 const staking=await(await ethers.getContractFactory('SuperionStakingV2')).deploy(await token.getAddress(),deployer.address,60);
 const market=await(await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),TL,S,S,treasury.address,params);
 if(await market.getAddress()!==predictedMarket||await timelock.officialMarket()!==predictedMarket)throw new Error('official marketplace address mismatch: wiring aborted');
 await staking.grantRole(await staking.OPERATOR_ROLE(),await market.getAddress());
 await staking.grantRole(ethers.ZeroHash,TL);await staking.renounceRole(ethers.ZeroHash,deployer.address);
 await token.grantRole(ethers.ZeroHash,TL);
 for(const r of [await token.PAUSER_ROLE(),await token.MINTER_ROLE(),ethers.ZeroHash])await token.renounceRole(r,deployer.address);
 const out={deployer,creator,provider,challenger,treasury,relayer,outsider,vs,owners,safe,guard,timelock,token,staking,market,terms:await ethers.getContractAt('MissionTerms',await market.terms())};
 await assertNoPersonalRoles(ethers,out);
 return out;
}
// Protection 1, deployment side: after wiring, every role holder of every AccessControl contract must be allowed by
// the timelock rule (admin -> timelock; operator -> a contract; other roles -> the Safe). The deployer keeps NOTHING.
async function roleHolders(ethers,contract){
 const holders=new Map();const logs=await ethers.provider.getLogs({address:await contract.getAddress(),fromBlock:0});
 for(const l of logs){let p;try{p=contract.interface.parseLog(l);}catch{continue;}if(!p||(p.name!=='RoleGranted'&&p.name!=='RoleRevoked'))continue;
  const k=p.args.role+'|'+p.args.account;holders.set(k,{role:p.args.role,account:p.args.account});}
 const out=[];for(const h of holders.values())if(await contract.hasRole(h.role,h.account))out.push(h);return out;
}
async function assertNoPersonalRoles(ethers,g){
 const report=[];
 for(const [name,c] of [['market',g.market],['staking',g.staking],['token',g.token],['timelock',g.timelock]]){
  for(const h of await roleHolders(ethers,c)){
   const ok=await g.timelock.isAllowedRoleRecipient(h.role,h.account),code=await ethers.provider.getCode(h.account);
   if(h.role===await g.staking.OPERATOR_ROLE()&&h.account!==await g.timelock.officialMarket())throw new Error(`OPERATOR held by a non-official contract: ${name} ${h.account}`);
   if(!ok||code==='0x'||h.account===g.deployer.address)throw new Error(`PERSONAL/UNALLOWED ROLE after deploy: ${name} ${h.role} -> ${h.account}`);
   report.push({contract:name,role:h.role,account:h.account});
  }
 }
 return report;
}
module.exports={governedDeploy,DELAY,assertNoPersonalRoles,roleHolders};
