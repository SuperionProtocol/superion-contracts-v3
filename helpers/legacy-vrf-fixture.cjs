// EXPLICIT LEGACY TEST ADAPTER: supplies a deterministic MOCK result before old draw calls.
// This is NOT production behavior and proves no VRF cryptographic verification.
const {ethers,network}=require('hardhat');
async function legacyFactory(){
 if(network.name!=='hardhat'||(await ethers.provider.getNetwork()).chainId!==31337n)throw Error('LOCAL ONLY');
 const factory=await ethers.getContractFactory('SuperionJobMarketplaceV3');
 return {deploy:async(...args)=>{
  const mock=await(await ethers.getContractFactory('LocalVrfCoordinatorMock')).deploy();const sub=await mock.nextSubscription();await mock.createSubscription();await mock.fundSubscription(sub,10000);
  const config={coordinator:await mock.getAddress(),subscriptionId:sub,keyHash:ethers.id('LOCAL_ONLY_NOT_A_NETWORK_KEYHASH'),confirmations:3,callbackGasLimit:Number(require('./vrf-config.cjs').BASE_SEPOLIA_PLANNED.callbackGasLimit),nativePayment:false};
  const market=await factory.deploy(...args,config);await mock.addConsumer(sub,await market.drawEngine());return market;
 }};
}
async function oracle(market){return ethers.getContractAt('FrozenVrfDraw',await market.drawEngine());}
async function fulfillMock(market,id,word=42n){
 const engine=await oracle(market),d=await market.disputes(id),s=await engine.status(id,d.round);
 if(s.state===1n){const mock=await ethers.getContractAt('LocalVrfCoordinatorMock',await engine.coordinator());await mock.fulfill(s.requestId,word);}
}
async function legacyDraw(market,id,...args){await fulfillMock(market,id);return market.drawCommittee(id,...args);}
module.exports={legacyFactory,legacyDraw,fulfillMock,oracle};
