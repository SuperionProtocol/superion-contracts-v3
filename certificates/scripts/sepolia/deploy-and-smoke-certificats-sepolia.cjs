// DÉPLOIEMENT + TEST DE FUMÉE du registre de certificats v2 — BASE SEPOLIA (84532) UNIQUEMENT. Documents FICTIFS uniquement.
// Admin final = Safe testnet 2-sur-3 (créé avec la pile V3). 3 émetteurs DÉMO (portefeuilles jetables) approuvés AVANT la remise de l'admin.
// DRY_RUN=1 : fork local (réseau forkdry), rien n'est envoyé.
const fs = require("fs"), path = require("path");
const hre = require("hardhat"), { ethers, network } = hre;
const DRY = process.env.DRY_RUN === "1";
const REAL_MAINNET_SAFE = "0xB633ae886bbb0939E0cB7130be0D367CED9f87D4";
const A = path.join(__dirname, "../../../deployments/") + (DRY ? "v3-trois-limites.baseSepolia.DRYRUN.json" : "v3-trois-limites.baseSepolia.json");
const OUT = path.join(__dirname, "../../deployments", DRY ? "certificats-v2.baseSepolia.DRYRUN.json" : "certificats-v2.baseSepolia.json");
const WAL = path.join(__dirname, "../../deployments", ".demo-issuers.baseSepolia.json");
const ISSUERS = [
  { key: "ecole", name: "DEMO TESTNET - École professionnelle Exemple de Lausanne (FICTIVE)", kind: 0, file: "exemple-cfc-informaticien.pdf", docType: 0 },
  { key: "entreprise", name: "DEMO TESTNET - Atelier Démo Sàrl, Genève (FICTIVE)", kind: 1, file: "exemple-attestation-stage.pdf", docType: 2 },
  { key: "employeur", name: "DEMO TESTNET - Exemple Transports SA, Fribourg (FICTIF)", kind: 2, file: "exemple-certificat-travail.pdf", docType: 3 },
];
const FALSE_PDF = "exemple-cfc-informaticien-FALSIFIE.pdf";
async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (!DRY && (network.name !== "baseSepolia" || chainId !== 84532n)) throw new Error("REFUS : Base Sepolia 84532 uniquement");
  if (DRY && network.name !== "forkdry") throw new Error("DRY_RUN = fork local seulement");
  const a = JSON.parse(fs.readFileSync(A)); const SAFE = a.contracts.testnetSafe;
  if (!SAFE || SAFE.toLowerCase() === REAL_MAINNET_SAFE.toLowerCase()) throw new Error("Safe testnet invalide");
  let [dep] = await ethers.getSigners();
  if (DRY) { await network.provider.request({ method: "hardhat_impersonateAccount", params: [a.deployer] }); dep = await ethers.getSigner(a.deployer);
    await network.provider.request({ method: "hardhat_setBalance", params: [a.deployer, "0xDE0B6B3A7640000"] }); }
  const log = (...x) => console.log(...x);
  const out = { contract: "CertificateRegistry v2", network: "baseSepolia", chainId: 84532, dryRun: DRY, deployedAt: new Date().toISOString(), deployer: dep.address, admin: SAFE,
    note: "TESTNET, documents FICTIFS uniquement. Admin = Safe testnet 2-sur-3 (mêmes 3 propriétaires que le Safe mainnet ; ce n'est PAS le Safe mainnet).", txs: {}, blocks: {}, issuers: [], smoke: {} };
  const bal0 = await ethers.provider.getBalance(dep.address); out.deployerEthBefore = ethers.formatEther(bal0);
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const rec = async (k, txp) => { const r = await (await txp).wait(); if (r.status !== 1) throw new Error(k); out.txs[k] = r.hash; out.blocks[k] = r.blockNumber; log(k, r.hash, "gas", r.gasUsed.toString()); save(); return r; };
  const F = await ethers.getContractFactory("CertificateRegistry", dep);
  const reg = await F.deploy(dep.address); const r0 = await reg.deploymentTransaction().wait();
  out.address = await reg.getAddress(); out.txs.deploy = r0.hash; out.blocks.deploy = r0.blockNumber; out.constructorArgs = [dep.address]; log("CertificateRegistry @", out.address, r0.hash); save();
  let keys; if (fs.existsSync(WAL)) keys = JSON.parse(fs.readFileSync(WAL)); else { keys = Object.fromEntries(ISSUERS.map((i) => [i.key, ethers.Wallet.createRandom().privateKey])); fs.writeFileSync(WAL, JSON.stringify(keys), { mode: 0o600 }); }
  const W = Object.fromEntries(Object.entries(keys).map(([k, pk]) => [k, new ethers.Wallet(pk, ethers.provider)]));
  for (const i of ISSUERS) { await rec("approveIssuer_" + i.key, reg.approveIssuer(W[i.key].address, i.name, i.kind)); out.issuers.push({ key: i.key, address: W[i.key].address, name: i.name, kind: i.kind }); }
  const ADMIN = ethers.ZeroHash;
  await rec("grant_ADMIN_safe", reg.grantRole(ADMIN, SAFE));
  await rec("renounce_ADMIN_deployer", reg.renounceRole(ADMIN, dep.address));
  out.roles = { deployerIsAdmin: await reg.hasRole(ADMIN, dep.address), safeIsAdmin: await reg.hasRole(ADMIN, SAFE), adminCount: (await reg.adminCount()).toString() };
  if (out.roles.deployerIsAdmin || !out.roles.safeIsAdmin || out.roles.adminCount !== "1") throw new Error("rôles incorrects " + JSON.stringify(out.roles)); save();
  // test de fumée
  const ex = path.join(__dirname, "../../examples");
  for (const i of ISSUERS) { const w = W[i.key];
    if ((await ethers.provider.getBalance(w.address)) < ethers.parseEther("0.0001")) await rec("fund_eth_" + i.key, dep.sendTransaction({ to: w.address, value: ethers.parseEther(DRY ? "0.01" : "0.0003") }));
    const h = ethers.keccak256(fs.readFileSync(path.join(ex, i.file)));
    await rec("issue_" + i.key, reg.connect(w).issue(h, i.docType)); out.smoke[i.file] = { keccak256: h }; }
  const hf = ethers.keccak256(fs.readFileSync(path.join(ex, FALSE_PDF)));
  for (const f of [...ISSUERS.map((i) => i.file), FALSE_PDF]) {
    const h = ethers.keccak256(fs.readFileSync(path.join(ex, f))); const v = await reg.verify(h);
    out.smoke[f] = { keccak256: h, found: v.length, results: v.map((x) => ({ issuer: x.issuer, issuerName: x.issuerName, issuerActive: x.issuerActive, docType: x.docType.toString(), issuedAt: x.issuedAt.toString(), revoked: x.revoked, issuedWhileDistrusted: x.issuedWhileDistrusted })) };
    const genuine = v.length === 1 && !v[0].revoked && v[0].issuerActive && !v[0].issuedWhileDistrusted;
    out.smoke[f].verdict = f === FALSE_PDF ? (v.length === 0 ? "INCONNU (rouge) — attendu" : "ERREUR") : (genuine ? "AUTHENTIQUE (vert) — attendu" : "ERREUR");
    log(f, out.smoke[f].verdict); }
  if (Object.values(out.smoke).some((s) => s.verdict === "ERREUR")) throw new Error("smoke KO");
  out.smoke.falsifiedVsGenuineSameHash = hf === out.smoke[ISSUERS[0].file].keccak256;
  const bal1 = await ethers.provider.getBalance(dep.address); out.deployerEthAfter = ethers.formatEther(bal1); out.ethSpent = ethers.formatEther(bal0 - bal1); save();
  log("OK — écrit", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
