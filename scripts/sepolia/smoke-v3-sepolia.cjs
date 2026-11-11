// TEST DE FUMÉE V3 — Base Sepolia (ou fork local si DRY_RUN=1). Portefeuilles de test jetables (clés stockées en local, jamais affichées).
// Une mission de 100 SUPER testnet, contestée, tirage Chainlink VRF réel, jury de 3, votes, décision, clôture.
const fs = require("fs"), path = require("path");
const hre = require("hardhat"), { ethers, network } = hre;
const DRY = process.env.DRY_RUN === "1";
const DEP = path.join(__dirname, "../../deployments", DRY ? "v3-trois-limites.baseSepolia.DRYRUN.json" : "v3-trois-limites.baseSepolia.json");
const OUT = path.join(__dirname, "../../deployments", DRY ? "v3-trois-limites.baseSepolia.smoke.DRYRUN.json" : "v3-trois-limites.baseSepolia.smoke.json");
const WAL = path.join(__dirname, "../../deployments", ".smoke-wallets.baseSepolia.json");
const S = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COORD_ABI = ["event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium)",
  "function getSubscription(uint256) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)"];
async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!DRY && (network.name !== "baseSepolia" || chainId !== 84532n)) throw new Error("REFUS : Base Sepolia uniquement");
  const d = JSON.parse(fs.readFileSync(DEP)); const C = d.contracts;
  let [dep] = await ethers.getSigners();
  if (DRY) { await network.provider.request({ method: "hardhat_impersonateAccount", params: [d.deployer] }); dep = await ethers.getSigner(d.deployer); await network.provider.request({ method: "hardhat_setBalance", params: [d.deployer, "0xDE0B6B3A7640000"] }); }
  const st = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT)) : { startedAt: new Date().toISOString(), steps: [], txs: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(st, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const rec = async (key, txp) => { const r = await (await txp).wait(); if (r.status !== 1) throw new Error(key); st.txs[key] = { hash: r.hash, block: r.blockNumber, gasUsed: r.gasUsed.toString() }; save(); log(key, r.hash, "gas", r.gasUsed.toString()); return r; };
  let keys; if (fs.existsSync(WAL)) keys = JSON.parse(fs.readFileSync(WAL)); else { keys = {}; for (const n of ["provider", "challenger", "v1", "v2", "v3"]) keys[n] = ethers.Wallet.createRandom().privateKey; fs.writeFileSync(WAL, JSON.stringify(keys), { mode: 0o600 }); }
  const W = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, new ethers.Wallet(k, ethers.provider)]));
  st.wallets = Object.fromEntries(Object.entries(W).map(([n, w]) => [n, w.address])); st.creator = dep.address; save();
  const token = await ethers.getContractAt("contracts/v2/ISuperToken.sol:ISuperToken", d.superToken, dep);
  const staking = await ethers.getContractAt("SuperionStakingV2", C.stakingV3, dep);
  const market = await ethers.getContractAt("SuperionJobMarketplaceV3", C.marketplaceV3, dep);
  const engine = await ethers.getContractAt("FrozenVrfDraw", C.drawEngine, dep);
  const coord = new ethers.Contract(d.vrf.coordinator, COORD_ABI, ethers.provider);
  const ethBefore = await ethers.provider.getBalance(dep.address); st.deployerEthBefore = st.deployerEthBefore || ethers.formatEther(ethBefore);
  // lecture des paramètres
  const cur = await (await ethers.getContractAt("MissionTerms", C.missionTerms)).current();
  st.params = { feeBps: cur.feeBps.toString(), committeeSize: cur.committeeSize.toString(), challengePeriod: cur.challengePeriod.toString(), maxJobBudget: ethers.formatEther(await market.maxJobBudget()), verifierCount: (await market.verifierCount()).toString(),
    engineCoordinator: await engine.coordinator(), engineSub: (await engine.subscriptionId()).toString(), engineKeyHash: await engine.keyHash(), engineNative: await engine.nativePayment(), engineCallbackGas: (await engine.callbackGasLimit()).toString() };
  save(); log("params", JSON.stringify(st.params));
  if (!st.phase1) {
    for (const [n, w] of Object.entries(W)) { if ((await ethers.provider.getBalance(w.address)) < S("0.0005")) await rec("fund_eth_" + n, dep.sendTransaction({ to: w.address, value: S(process.env.WALLET_ETH || "0.0008") })); }
    const amt = { provider: 300, challenger: 200, v1: 1200, v2: 1200, v3: 1200 };
    for (const [n, w] of Object.entries(W)) if ((await token.balanceOf(w.address)) < S(amt[n])) await rec("fund_super_" + n, token.transfer(w.address, S(amt[n])));
    for (const n of ["v1", "v2", "v3"]) { const w = W[n];
      await rec("approve_staking_" + n, token.connect(w).approve(C.stakingV3, S(1000)));
      await rec("stake_" + n, staking.connect(w).stake(S(1000)));
      await rec("registerVerifier_" + n, market.connect(w).registerVerifier()); }
    await rec("approve_staking_provider", token.connect(W.provider).approve(C.stakingV3, S(200)));
    await rec("stake_provider", staking.connect(W.provider).stake(S(200)));
    await rec("approve_market_creator", token.approve(C.marketplaceV3, S(100)));
    const rJ = await rec("createJob", market.createJob(S(100), 3600, "ipfs://superion-smoke-test-sepolia-2026-11-10 (mission de TEST fictive)"));
    st.jobId = (market.interface.parseLog(rJ.logs.find((l) => l.address === C.marketplaceV3 && (() => { try { return market.interface.parseLog(l).name === "JobCreated"; } catch { return false; } })())).args.jobId).toString();
    await rec("assignJob", market.connect(W.provider).assignJob(st.jobId));
    await rec("submitResult", market.connect(W.provider).submitResult(st.jobId, "ipfs://superion-smoke-result (résultat de TEST)"));
    const [bond] = await market.disputeAmounts(S(100)); st.bond = ethers.formatEther(bond);
    await rec("approve_market_challenger", token.connect(W.challenger).approve(C.marketplaceV3, bond));
    const rC = await rec("challengeJob_vrfRequest", market.connect(W.challenger).challengeJob(st.jobId, ethers.id("smoke-seed")));
    st.challengeGasUsed = rC.gasUsed.toString();
    const s = await engine.status(st.jobId, 0); st.draw = { state: s.state.toString(), candidates: s.count.toString(), size: s.size.toString(), requestId: s.requestId.toString(), snapshotHash: s.snapshotHash };
    st.phase1 = true; save(); log("draw", JSON.stringify(st.draw));
    if (s.state !== 1n) throw new Error("La requête VRF n'est pas en attente (state " + s.state + ")");
  }
  if (DRY) { log("DRY_RUN : arrêt avant la réponse VRF (impossible sur un fork)"); return; }
  if (!st.fulfillment) {
    const t0 = Date.now(); let s;
    for (;;) { s = await engine.status(st.jobId, 0); if (s.state !== 1n) break; if (Date.now() - t0 > Number(process.env.VRF_WAIT_MIN || 50) * 60 * 1000) throw new Error("pas de réponse VRF après 50 min"); await sleep(10000); }
    const fromBlock = st.txs.challengeJob_vrfRequest.block;
    const latest = await ethers.provider.getBlockNumber(); let logs = []; // RPC public : eth_getLogs limité à 200 blocs
    for (let b = fromBlock; b <= latest && !logs.length; b += 200) logs = await coord.queryFilter(coord.filters.RandomWordsFulfilled(BigInt(st.draw.requestId)), b, Math.min(b + 199, latest));
    const L = logs[0]; const r = await ethers.provider.getTransactionReceipt(L.transactionHash); const tx = await ethers.provider.getTransaction(L.transactionHash);
    st.fulfillment = { state: s.state.toString(), word: s.word.toString(), txHash: L.transactionHash, block: L.blockNumber, gasUsedTotalTx: r.gasUsed.toString(), from: tx.from, gasPrice: tx.gasPrice?.toString(),
      paymentWei: L.args.payment.toString(), paymentEth: ethers.formatEther(L.args.payment), nativePayment: L.args.nativePayment, callbackSuccess: L.args.success, secondsAfterRequest: Math.round((Date.now() - t0) / 1000) };
    save(); log("fulfillment", JSON.stringify(st.fulfillment));
    if (s.state !== 2n) throw new Error("tirage non prêt après réponse : state " + s.state);
  }
  if (!st.committee) {
    await rec("drawCommittee", market.drawCommittee(st.jobId)); st.committee = await market.committeeOf(st.jobId); save(); log("committee", st.committee);
  }
  const byAddr = Object.fromEntries(Object.values(W).map((w) => [w.address, w]));
  { const f = path.join(__dirname, "../../deployments/.smoke-wallets-run1.json"); if (fs.existsSync(f)) for (const k of Object.values(JSON.parse(fs.readFileSync(f)))) { const w = new ethers.Wallet(k, ethers.provider); byAddr[w.address] = w; } }
  if (!st.committed) { for (const a of st.committee) { if (st.txs["commitVote_" + a.slice(0, 8)]) continue; const w = byAddr[a]; const salt = ethers.id("salt-" + a);
      await rec("commitVote_" + a.slice(0, 8), market.connect(w).commitVote(st.jobId, ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bool", "bytes32", "address", "uint256"], [true, salt, a, st.jobId])))); }
    st.committed = true; save(); }
  if (!st.revealed) { const rd = await market.rounds(st.jobId, 0); log("attente fin commit", rd.commitDeadline.toString());
    while (BigInt((await ethers.provider.getBlock("latest")).timestamp) <= rd.commitDeadline) await sleep(8000);
    for (const a of st.committee) await rec("revealVote_" + a.slice(0, 8), market.connect(byAddr[a]).revealVote(st.jobId, true, ethers.id("salt-" + a)));
    st.revealed = true; save(); }
  if (!st.decided) { await rec("resolveDispute", market.resolveDispute(st.jobId)); st.decided = true; save(); }
  if (!st.finalized) { const dd = await market.disputes(st.jobId); log("attente fin appel", dd.appealDeadline.toString());
    while (BigInt((await ethers.provider.getBlock("latest")).timestamp) <= dd.appealDeadline + 5n) await sleep(8000);
    await rec("finalizeDispute", market.finalizeDispute(st.jobId)); st.finalized = true; save(); }
  const j = await market.jobs(st.jobId); st.finalJobStatus = j.status.toString();
  const sub = await coord.getSubscription(BigInt(d.vrf.subscriptionId)); st.subscriptionAfter = { nativeBalance: ethers.formatEther(sub.nativeBalance), reqCount: sub.reqCount.toString(), owner: sub.subOwner };
  st.deployerEthAfter = ethers.formatEther(await ethers.provider.getBalance(dep.address)); st.finishedAt = new Date().toISOString(); save();
  log("FIN", JSON.stringify({ status: st.finalJobStatus, sub: st.subscriptionAfter }));
}
main().catch((e) => { console.error(e); process.exit(1); });
