// TEST ONLY. Actual published SafeL2 1.4.1 bytecode; no mock and no real wallet.
const path = require('path');
const base = path.join(__dirname, '../.safe-deps/safe-contracts/build/artifacts/contracts');
const artifact = (p) => require(path.join(base, p));
const artifacts = {
  safe: artifact('SafeL2.sol/SafeL2.json'),
  factory: artifact('proxies/SafeProxyFactory.sol/SafeProxyFactory.json'),
  handler: artifact('handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json')
};
const types = { SafeTx: [
  {name:'to',type:'address'}, {name:'value',type:'uint256'}, {name:'data',type:'bytes'},
  {name:'operation',type:'uint8'}, {name:'safeTxGas',type:'uint256'}, {name:'baseGas',type:'uint256'},
  {name:'gasPrice',type:'uint256'}, {name:'gasToken',type:'address'}, {name:'refundReceiver',type:'address'},
  {name:'nonce',type:'uint256'}
] };
async function assertLocal(ethers) {
  const {network} = require('hardhat');
  if (network.name !== 'hardhat' || (await ethers.provider.getNetwork()).chainId !== 31337n)
    throw new Error('TEST HARNESS REFUSES any network except in-process hardhat 31337');
}
// The REAL mainnet Safe must never be touched by this repository. Hard refusal, even though it cannot exist on 31337.
const REAL_MAINNET_SAFE = '0xB633ae886bbb0939E0cB7130be0D367CED9f87D4';
// Installs the LOCAL TEST guard (contracts/governance/SafeLocalGuard.sol) on a LOCAL Safe: 2 owner signatures.
async function installLocalGuard(ethers, safe, owners, relayer) {
  await assertLocal(ethers);
  const addr = await safe.getAddress();
  if (addr.toLowerCase() === REAL_MAINNET_SAFE.toLowerCase()) throw new Error('REFUSED: never install anything on the real mainnet Safe');
  const guard = await (await ethers.getContractFactory('SafeLocalGuard', relayer)).deploy(); await guard.waitForDeployment();
  await safeCall(ethers, safe, addr, safe.interface.encodeFunctionData('setGuard', [await guard.getAddress()]), owners.slice(0, 2), relayer);
  return guard;
}
async function deployLocalSafe(ethers, owners, deployer, options = {}) {
  await assertLocal(ethers);
  if (owners.length !== 3 || new Set(owners.map(o=>o.address.toLowerCase())).size !== 3)
    throw new Error('Three distinct LOCAL signer addresses required');
  const deploy = async(a) => {
    if (Object.keys(a.linkReferences || {}).length) throw new Error('Unexpected linked artifact');
    const c=await new ethers.ContractFactory(a.abi,a.bytecode,deployer).deploy();
    await c.waitForDeployment(); return c;
  };
  const singleton=await deploy(artifacts.safe), factory=await deploy(artifacts.factory), handler=await deploy(artifacts.handler);
  const init=singleton.interface.encodeFunctionData('setup',[
    owners.map(o=>o.address),2,ethers.ZeroAddress,'0x',await handler.getAddress(),ethers.ZeroAddress,0,ethers.ZeroAddress
  ]);
  const receipt=await(await factory.createProxyWithNonce(await singleton.getAddress(),init,0)).wait();
  const event=receipt.logs.map(l=>{try{return factory.interface.parseLog(l);}catch{return null;}}).find(l=>l?.name==='ProxyCreation');
  if(!event)throw new Error('ProxyCreation missing');
  const safe=new ethers.Contract(event.args.proxy,artifacts.safe.abi,deployer);
  // LOCAL protection 2 (approved): guard installed by default on every LOCAL test Safe; {guard:false} only for
  // reproducing the earlier risks on an unguarded Safe.
  const guard = options.guard === false ? null : await installLocalGuard(ethers, safe, owners, deployer);
  return {safe,singleton,factory,handler,owners,guard};
}
async function prepareSafeTx(ethers,safe,to,data,owners,options={}) {
  await assertLocal(ethers);
  const message={to,value:0n,data,operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,
    gasToken:ethers.ZeroAddress,refundReceiver:ethers.ZeroAddress,nonce:options.nonce??await safe.nonce()};
  const domain={chainId:options.chainId??31337n,verifyingContract:options.verifyingContract??await safe.getAddress()};
  const pieces=[];
  for(const owner of owners)pieces.push({address:owner.address,signature:await owner.signTypedData(domain,types,message)});
  pieces.sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const hash=ethers.TypedDataEncoder.hash(domain,types,message);
  const signatures=ethers.concat(pieces.map(p=>p.signature));
  return {message,signatures,hash,signerAddresses:pieces.map(p=>p.address)};
}
function executeSafeTx(safe,relayer,prepared) {
  const m=prepared.message;
  return safe.connect(relayer).execTransaction(m.to,m.value,m.data,m.operation,m.safeTxGas,m.baseGas,m.gasPrice,
    m.gasToken,m.refundReceiver,prepared.signatures,{gasLimit:6000000});
}
async function safeCall(ethers,safe,to,data,owners,relayer) {
  const prepared=await prepareSafeTx(ethers,safe,to,data,owners);
  const receipt=await(await executeSafeTx(safe,relayer,prepared)).wait();return {prepared,receipt};
}
module.exports={artifacts,types,assertLocal,deployLocalSafe,installLocalGuard,prepareSafeTx,executeSafeTx,safeCall,REAL_MAINNET_SAFE};
