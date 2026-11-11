// DÉPLOIEMENT V3 « trois limites » — BASE SEPOLIA (84532) UNIQUEMENT. Aucun mainnet. Le vrai Safe mainnet n'est jamais touché.
// DRY_RUN=1 : même script sur un fork local de Base Sepolia (réseau hardhat), rien n'est envoyé.
// Gouvernance testnet : Safe SafeL2 1.4.1 (2-sur-3, mêmes 3 propriétaires que le Safe mainnet) avec SafeLocalGuard installé à la création,
// + SuperionGovernanceTimelock 48 h (proposer/executor = ce Safe). Le déployeur ne garde AUCUN rôle.
const fs = require("fs"), path = require("path");
const hre = require("hardhat"), { ethers, network } = hre;
const { MARKETPLACE_V3_PARAMS_TESTNET: P } = require("../v3/config.cjs");
const DRY = process.env.DRY_RUN === "1";
const REAL_MAINNET_SAFE = "0xB633ae886bbb0939E0cB7130be0D367CED9f87D4";
const SAFE_OWNERS = ["0x4EF06c58694A4DDaa6d1aa3F8F2F18856070993b", "0xCbbe3094345D4aB47dD6e23bcD893927566B6938", "0xE60322A5543C2bAD26115053B586d9679F4A939f"];
const SAFE = { singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", handler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" };
const VRF = { coordinator: "0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE", keyHash: "0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71", confirmations: 3, callbackGasLimit: 2500000, nativePayment: true };
const SUPER = "0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4"; // SUPER testnet Base Sepolia existant
const FUND_NATIVE = ethers.parseEther(process.env.VRF_FUND || "0.003");
const DELAY = 48n * 3600n;
const COORD_ABI = ["function createSubscription() returns (uint256)", "function fundSubscriptionWithNative(uint256) payable", "function addConsumer(uint256,address)",
  "function requestSubscriptionOwnerTransfer(uint256,address)", "function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)",
  "event SubscriptionCreated(uint256 indexed subId, address owner)"];
const safeArt = (p) => require(path.join(__dirname, "../../.safe-deps/safe-contracts/build/artifacts/contracts", p));

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!DRY && (network.name !== "baseSepolia" || chainId !== 84532n)) throw new Error("REFUS : Base Sepolia 84532 uniquement");
  if (DRY && !["hardhat","localhost"].includes(network.name)) throw new Error("DRY_RUN = fork local seulement");
  let [dep] = await ethers.getSigners();
  if (DRY) { // fork : on se fait passer pour le déployeur (impersonation locale, aucune clé)
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [SAFE_OWNERS[2]] });
    dep = await ethers.getSigner(SAFE_OWNERS[2]);
  }
  if (dep.address !== SAFE_OWNERS[2]) throw new Error("déployeur inattendu");
  const out = { version: "3.1-trois-limites", network: "baseSepolia", chainId: 84532, dryRun: DRY, deployedAt: new Date().toISOString(), deployer: dep.address,
    superToken: SUPER, contracts: {}, txs: {}, blocks: {}, constructorArgs: {}, vrf: { ...VRF }, params: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.toString()])) };
  const bal0 = await ethers.provider.getBalance(dep.address); out.deployerEthBefore = ethers.formatEther(bal0);
  const log = (...a) => console.log(...a);
  const rec = async (key, txp) => { const tx = await txp; const r = await tx.wait(); if (r.status !== 1) throw new Error(key + " failed"); out.txs[key] = r.hash; out.blocks[key] = r.blockNumber; log(key, r.hash, "gas", r.gasUsed.toString()); return r; };
  const deploy = async (key, name, args) => {
    const F = await ethers.getContractFactory(name, dep); const c = await F.deploy(...args); const r = await c.deploymentTransaction().wait();
    out.contracts[key] = await c.getAddress(); out.txs["deploy_" + key] = r.hash; out.blocks["deploy_" + key] = r.blockNumber; out.constructorArgs[key] = args;
    log(name, "@", out.contracts[key], r.hash, "gas", r.gasUsed.toString()); return c;
  };
  // 1. garde + helper, puis Safe 2-sur-3 avec garde installée dans setup()
  const guard = await deploy("safeGuard", "SafeLocalGuard", []);
  const helper = await deploy("safeGuardSetupHelper", "SafeGuardSetupHelper", []);
  const singleton = new ethers.Contract(SAFE.singleton, safeArt("SafeL2.sol/SafeL2.json").abi, dep);
  const factory = new ethers.Contract(SAFE.factory, safeArt("proxies/SafeProxyFactory.sol/SafeProxyFactory.json").abi, dep);
  const initData = singleton.interface.encodeFunctionData("setup", [SAFE_OWNERS, 2, await helper.getAddress(),
    helper.interface.encodeFunctionData("enableGuard", [await guard.getAddress()]), SAFE.handler, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const saltNonce = BigInt(ethers.id("superion-testnet-safe-v3-trois-limites-2026-11-10"));
  const rS = await rec("safe_createProxyWithNonce", factory.createProxyWithNonce(SAFE.singleton, initData, saltNonce));
  const ev = rS.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "ProxyCreation");
  const safeAddr = ev.args.proxy; out.contracts.testnetSafe = safeAddr;
  if (safeAddr.toLowerCase() === REAL_MAINNET_SAFE.toLowerCase()) throw new Error("adresse = vrai Safe mainnet : refus");
  const safe = new ethers.Contract(safeAddr, singleton.interface, dep);
  const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
  const g = ethers.getAddress("0x" + (await ethers.provider.getStorage(safeAddr, GUARD_SLOT)).slice(26));
  if (g !== await guard.getAddress() || (await safe.getThreshold()) !== 2n || (await safe.getOwners()).length !== 3) throw new Error("Safe testnet mal configuré");
  out.safeSetup = { owners: await safe.getOwners(), threshold: 2, guard: g, saltNonce: saltNonce.toString() };
  // 2. abonnement Chainlink VRF 2.5 (paiement en ETH testnet natif)
  const coord = new ethers.Contract(VRF.coordinator, COORD_ABI, dep);
  const rSub = await rec("vrf_createSubscription", coord.createSubscription());
  const subEv = rSub.logs.map((l) => { try { return coord.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "SubscriptionCreated");
  const subId = subEv.args.subId; out.vrf.subscriptionId = subId.toString();
  await rec("vrf_fundSubscriptionWithNative", coord.fundSubscriptionWithNative(subId, { value: FUND_NATIVE })); out.vrf.fundedNative = ethers.formatEther(FUND_NATIVE);
  // 3. staking, timelock (marché prévu = nonce suivant), marché
  const staking = await deploy("stakingV3", "SuperionStakingV2", [SUPER, dep.address, 60]);
  const nNow = await ethers.provider.getTransactionCount(dep.address, "pending");
  const predictedMarket = ethers.getCreateAddress({ from: dep.address, nonce: nNow + 1 });
  const timelock = await deploy("governanceTimelock", "SuperionGovernanceTimelock", [DELAY, [safeAddr], [safeAddr], ethers.ZeroAddress, predictedMarket]);
  const TL = await timelock.getAddress();
  const vrfCfg = { coordinator: VRF.coordinator, subscriptionId: subId, keyHash: VRF.keyHash, confirmations: VRF.confirmations, callbackGasLimit: VRF.callbackGasLimit, nativePayment: VRF.nativePayment };
  const market = await deploy("marketplaceV3", "SuperionJobMarketplaceV3", [SUPER, await staking.getAddress(), TL, safeAddr, safeAddr, TL, P, vrfCfg]);
  const M = await market.getAddress();
  if (M !== predictedMarket || (await timelock.officialMarket()) !== M) throw new Error("adresse du marché ≠ prévue : arrêt");
  out.contracts.drawEngine = await market.drawEngine(); out.contracts.missionTerms = await market.terms();
  out.constructorArgs.drawEngine = [vrfCfg]; out.constructorArgs.missionTerms = [P];
  // 4. câblage + transfert des rôles
  await rec("vrf_addConsumer_engine", coord.addConsumer(subId, out.contracts.drawEngine));
  const OP = await staking.OPERATOR_ROLE(), ADMIN = ethers.ZeroHash;
  await rec("staking_grant_OPERATOR_market", staking.grantRole(OP, M));
  await rec("staking_grant_ADMIN_timelock", staking.grantRole(ADMIN, TL));
  await rec("staking_renounce_ADMIN_deployer", staking.renounceRole(ADMIN, dep.address));
  await rec("vrf_requestSubscriptionOwnerTransfer_safe", coord.requestSubscriptionOwnerTransfer(subId, safeAddr));
  // 5. vérification des rôles
  const roles = [];
  const chk = async (cname, c, rname, role, acct, label) => roles.push({ contract: cname, role: rname, account: acct, label, has: await c.hasRole(role, acct) });
  const MP = await market.PAUSER_ROLE(), MA = await market.ARBITER_ROLE();
  const TP = await timelock.PROPOSER_ROLE(), TE = await timelock.EXECUTOR_ROLE(), TC = await timelock.CANCELLER_ROLE();
  for (const [lab, a] of [["deployer", dep.address], ["testnetSafe", safeAddr], ["timelock", TL], ["market", M]]) {
    await chk("market", market, "DEFAULT_ADMIN", ADMIN, a, lab); await chk("market", market, "PAUSER", MP, a, lab); await chk("market", market, "ARBITER", MA, a, lab);
    await chk("staking", staking, "DEFAULT_ADMIN", ADMIN, a, lab); await chk("staking", staking, "OPERATOR", OP, a, lab);
    await chk("timelock", timelock, "DEFAULT_ADMIN", ADMIN, a, lab); await chk("timelock", timelock, "PROPOSER", TP, a, lab);
    await chk("timelock", timelock, "EXECUTOR", TE, a, lab); await chk("timelock", timelock, "CANCELLER", TC, a, lab);
  }
  out.roles = roles;
  const depRoles = roles.filter((r) => r.label === "deployer" && r.has);
  if (depRoles.length) throw new Error("le déployeur détient encore un rôle : " + JSON.stringify(depRoles));
  const sub = await coord.getSubscription(subId);
  out.vrf.subscriptionState = { nativeBalance: ethers.formatEther(sub.nativeBalance), owner: sub.subOwner, consumers: sub.consumers, pendingOwner: safeAddr };
  out.timelockState = { minDelay: (await timelock.getMinDelay()).toString(), safe: await timelock.safe(), officialMarket: await timelock.officialMarket(), guardCodehash: await timelock.guardCodehash() };
  const bal1 = await ethers.provider.getBalance(dep.address); out.deployerEthAfter = ethers.formatEther(bal1); out.ethSpentInclVrfFunding = ethers.formatEther(bal0 - bal1);
  const file = path.join(__dirname, "../../deployments", DRY ? "v3-trois-limites.baseSepolia.DRYRUN.json" : "v3-trois-limites.baseSepolia.json");
  fs.writeFileSync(file, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log("OK — deployer roles: none. Écrit", file); log(JSON.stringify(out.contracts, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
