// LECTURE SEULE : relit sur Base Sepolia tous les détenteurs de rôles (événements RoleGranted/RoleRevoked + hasRole) des contrats déployés.
const fs = require("fs"); const { ethers } = require("ethers");
const p = new ethers.JsonRpcProvider("https://sepolia.base.org", 84532, { staticNetwork: true, batchMaxCount: 1 });
const _send = p.send.bind(p); p.send = async (m, a) => { await new Promise((r) => setTimeout(r, 120)); return _send(m, a); }; // limite 25 req/s du RPC public
const A = require("../../deployments/v3-trois-limites.baseSepolia.json"), B = require("../../certificates/deployments/certificats-v2.baseSepolia.json");
const ABI = ["event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)", "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)", "function hasRole(bytes32,address) view returns (bool)"];
const NAMES = Object.fromEntries(["PAUSER_ROLE", "ARBITER_ROLE", "OPERATOR_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE", "MINTER_ROLE"].map((r) => [ethers.id(r), r])); NAMES[ethers.ZeroHash] = "DEFAULT_ADMIN";
const LABEL = { [A.deployer]: "DÉPLOYEUR", [A.contracts.testnetSafe]: "Safe testnet", [A.contracts.governanceTimelock]: "Timelock 48h", [A.contracts.marketplaceV3]: "Marché V3" };
(async () => {
  const out = { readAt: new Date().toISOString(), block: await p.getBlockNumber(), holders: [] };
  for (const [name, addr, from] of [["marketplaceV3", A.contracts.marketplaceV3, A.blocks.deploy_marketplaceV3], ["stakingV3", A.contracts.stakingV3, A.blocks.deploy_stakingV3], ["governanceTimelock", A.contracts.governanceTimelock, A.blocks.deploy_governanceTimelock], ["certificateRegistry", B.address, B.blocks.deploy]]) {
    const c = new ethers.Contract(addr, ABI, p); const seen = new Map();
    const evs = []; const latest = Math.max(...Object.values(A.blocks), ...Object.values(B.blocks)) + 5; for (let b = from; b <= latest; b += 200) { await new Promise((r) => setTimeout(r, 300)); const to = Math.min(b + 199, latest); evs.push(...await c.queryFilter("RoleGranted", b, to), ...await c.queryFilter("RoleRevoked", b, to)); }
    for (const e of evs) seen.set(e.args.role + e.args.account, [e.args.role, e.args.account]);
    for (const [role, acct] of seen.values()) out.holders.push({ contract: name, role: NAMES[role] || role, account: acct, label: LABEL[acct] || "?", hasRole: await c.hasRole(role, acct) });
    for (const r of Object.keys(NAMES)) if (await c.hasRole(r, A.deployer)) out.holders.push({ contract: name, role: NAMES[r], account: A.deployer, label: "DÉPLOYEUR", hasRole: true, direct: true });
  }
  const safe = new ethers.Contract(A.contracts.testnetSafe, ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function nonce() view returns (uint256)", "function VERSION() view returns (string)"], p);
  out.safe = { address: A.contracts.testnetSafe, owners: await safe.getOwners(), threshold: (await safe.getThreshold()).toString(), nonce: (await safe.nonce()).toString(), version: await safe.VERSION(),
    guard: ethers.getAddress("0x" + (await p.getStorage(A.contracts.testnetSafe, "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8")).slice(26)) };
  const tl = new ethers.Contract(A.contracts.governanceTimelock, ["function getMinDelay() view returns (uint256)", "function safe() view returns (address)", "function officialMarket() view returns (address)"], p);
  out.timelock = { minDelaySeconds: (await tl.getMinDelay()).toString(), safe: await tl.safe(), officialMarket: await tl.officialMarket() };
  out.deployerHoldsAnyRole = out.holders.some((h) => h.account === A.deployer && h.hasRole);
  out.realMainnetSafeCodeOnSepolia = await p.getCode("0xB633ae886bbb0939E0cB7130be0D367CED9f87D4");
  fs.writeFileSync(__dirname + "/../../deployments/v3-roles-check.baseSepolia.json", JSON.stringify(out, null, 2));
  for (const h of out.holders) console.log(h.contract.padEnd(20), h.role.padEnd(15), h.label.padEnd(13), h.account, h.hasRole);
  console.log("Safe", JSON.stringify(out.safe)); console.log("Timelock", JSON.stringify(out.timelock)); console.log("deployerHoldsAnyRole", out.deployerHoldsAnyRole);
})();
