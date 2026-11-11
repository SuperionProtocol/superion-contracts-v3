# Superion JobMarketplace V3 — Base Sepolia testnet release

> **Status: NOT AUDITED. Base Sepolia TESTNET only (chain id 84532). No mainnet deployment of V3.**
> Do not use these contracts with real funds.
> The Base mainnet V2.1 contracts are **not** to be used for pilots; pilots run only on this Base Sepolia V3 stack
> until an audited mainnet deployment exists.

Superion is a verified-work marketplace on Base. A client (creator) posts a job paid in SUPER, a staked provider
delivers it, and anyone can challenge the result during a challenge period. A challenged job goes to a committee of
staked verifiers drawn at random (Chainlink VRF v2.5 on Base Sepolia, stake-weighted, without replacement, parties
excluded) who vote with commit/reveal. One appeal round with a larger, disjoint committee is possible. The arbiter role
is held by a 2-of-3 Safe; parameter, role and admin changes go through a 48-hour timelock.

This repository also contains the `CertificateRegistry` v2 contract (on-chain registry of document hashes for
vocational certificates and internship attestations), deployed on Base Sepolia with **fictional demo documents only**.

The previous snapshot of this repository (3 November 2026, earlier V3 design with blockhash randomness) is kept
unchanged under the tag [`audit-v3-snapshot-1`](https://github.com/SuperionProtocol/superion-contracts-v3/tree/audit-v3-snapshot-1).
See [`CHANGELOG.md`](CHANGELOG.md) for what changed since then.

## Base Sepolia deployment (10 November 2026)

| Contract | Source | Address |
|---|---|---|
| SuperionJobMarketplaceV3 | `contracts/v3/SuperionJobMarketplaceV3.sol` | [`0xdb2DE04836dC3773f86b351DFa62FE681982310D`](https://sepolia.basescan.org/address/0xdb2DE04836dC3773f86b351DFa62FE681982310D#code) |
| SuperionStakingV2 (V3 stack instance) | `contracts/v2/SuperionStakingV2.sol` | [`0x167Eb56De6409e26980C84Cd943ca8f9C8fE755E`](https://sepolia.basescan.org/address/0x167Eb56De6409e26980C84Cd943ca8f9C8fE755E#code) |
| FrozenVrfDraw (created by the market) | `contracts/vrf/FrozenVrfDraw.sol` | [`0xE9e24fD4A8F055C500Bf8582C6c393eCBEAeF738`](https://sepolia.basescan.org/address/0xE9e24fD4A8F055C500Bf8582C6c393eCBEAeF738#code) |
| MissionTerms (created by the market) | `contracts/terms/MissionTerms.sol` | [`0x61adD5e62AD52604Cf432dB9Cabc41c12ad4fCb8`](https://sepolia.basescan.org/address/0x61adD5e62AD52604Cf432dB9Cabc41c12ad4fCb8#code) |
| SuperionGovernanceTimelock (48 h) | `contracts/governance/SuperionGovernanceTimelock.sol` | [`0xCBbF2d82A30f74C447916312d7aD4E79cCA94b56`](https://sepolia.basescan.org/address/0xCBbF2d82A30f74C447916312d7aD4E79cCA94b56#code) |
| Safe guard (testnet Safe) | `contracts/governance/SafeLocalGuard.sol` | [`0x8B0Be82fB1F3b7405524AB3be6a8955ea78FED12`](https://sepolia.basescan.org/address/0x8B0Be82fB1F3b7405524AB3be6a8955ea78FED12#code) |
| Safe guard setup helper | `contracts/deploy/SafeGuardSetupHelper.sol` | [`0x016C99e331Ae37705F15a1812871946Eac8f86Bd`](https://sepolia.basescan.org/address/0x016C99e331Ae37705F15a1812871946Eac8f86Bd#code) |
| CertificateRegistry v2 | `certificates/contracts/CertificateRegistry.sol` | [`0xf6565b423aa574722D77e0b64E14413a96a5EFBd`](https://sepolia.basescan.org/address/0xf6565b423aa574722D77e0b64E14413a96a5EFBd#code) |
| Testnet Safe 2-of-3 (SafeL2 1.4.1) | official Safe contracts | [`0xFEAdc7024F99C9ef9fE7580Ed2543d57C26a4Cb6`](https://sepolia.basescan.org/address/0xFEAdc7024F99C9ef9fE7580Ed2543d57C26a4Cb6) |
| SUPER token (testnet) | `contracts/SuperionToken.sol` | [`0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4`](https://sepolia.basescan.org/address/0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4) |
| Chainlink VRF v2.5 coordinator (Base Sepolia) | Chainlink | [`0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE`](https://sepolia.basescan.org/address/0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE) |

Roles after deployment (read on-chain, `deployments/v3-roles-check.baseSepolia.json`): market admin = timelock;
market `PAUSER_ROLE` and `ARBITER_ROLE` = testnet Safe; staking admin = timelock, staking operator = market;
timelock proposer/executor/canceller = testnet Safe; registry admin = testnet Safe. The deployer account holds no role.
The testnet Safe is a separate contract from any mainnet Safe.

Deployment records: [`deployments/v3-trois-limites.baseSepolia.json`](deployments/v3-trois-limites.baseSepolia.json)
(constructor arguments, transactions, VRF configuration) and
[`certificates/deployments/certificats-v2.baseSepolia.json`](certificates/deployments/certificats-v2.baseSepolia.json).
Constructor arguments for explorer verification are in `deployments/verify-args/`.

### Bytecode check

The runtime bytecode compiled from this repository (clean `npm ci`, solc 0.8.24) was compared with `eth_getCode` on
`https://sepolia.base.org` for all eight contracts in the table above (market, staking, FrozenVrfDraw, MissionTerms,
timelock, guard, helper, CertificateRegistry). With only immutable references masked, every one matches byte for byte,
including the CBOR metadata hash, so the sources here are exactly the deployed sources.

### End-to-end smoke test (11 November 2026)

One full dispute was run on the deployed stack with throwaway test wallets (record:
[`deployments/v3-trois-limites.baseSepolia.smoke.json`](deployments/v3-trois-limites.baseSepolia.smoke.json)):

| Step | Transaction |
|---|---|
| Create job (100 test SUPER) | [`0x5fd0bfe8…`](https://sepolia.basescan.org/tx/0x5fd0bfe83f1530877f403e8fe54199a25decc3f0c4cd1871644726901f176c0f) |
| Challenge + VRF request (6 candidates, 3 seats) | [`0xeecf2024…`](https://sepolia.basescan.org/tx/0xeecf2024adb82cadf9d50dda80cd1a1e29713a8810555957797c2ed3c95ad48b) |
| Chainlink VRF fulfillment (~10 s after the request) | [`0x0de25427…`](https://sepolia.basescan.org/tx/0x0de2542717a873c608d0d93596a3e71acffe2b4c4c118c2042218671b5609c11) |
| Committee draw | [`0x926794fb…`](https://sepolia.basescan.org/tx/0x926794fb20280f54986558537ae23cd2e7850f07a1b6479023874460a60c2d7b) |
| Resolve dispute | [`0x9586cf76…`](https://sepolia.basescan.org/tx/0x9586cf76956746cb367ce1d0dcd95adb6e62161df579fa3e33da18101e5edc48) |
| Finalize dispute | [`0x00ea5e1a…`](https://sepolia.basescan.org/tx/0x00ea5e1acceae434d49dcc9b547edddafffdd8a967d6ac636888dd5c785a8f99) |

An earlier attempt on 10 November (`deployments/smoke-run1-2026-11-10.json`) requested randomness but was not
fulfilled within the draw window while the VRF subscription held a very small native balance; it is kept for completeness.

## Repository layout

| Path | Content |
|---|---|
| `contracts/v3/` | `SuperionJobMarketplaceV3` (main contract) |
| `contracts/v2/` | `SuperionStakingV2` (used by the V3 stack), `ISuperToken`; V2.1 marketplace/governor/timelock (only used by tests) |
| `contracts/vrf/` | `FrozenVrfDraw`: freezes the candidate list, makes one Chainlink VRF v2.5 request, draws the committee |
| `contracts/terms/` | `MissionTerms`: versioned parameters, each job bound to the version in force at creation |
| `contracts/governance/` | 48 h governance timelock with role restrictions; Safe guard |
| `contracts/deploy/` | Helper used to install the guard at Safe setup |
| `contracts/code/` | `CodeMissionSuites`: frozen test-suite commitments for code missions (does not run tests) |
| `contracts/test/` | Test-only contracts (local VRF coordinator mock without proof verification, fixtures) |
| `.chainlink-deps/` | 4 unmodified source files from `@chainlink/contracts` 1.5.0 (MIT), hashes in `vendor/CHAINLINK-PACKAGE-LOCK.json` |
| `certificates/` | `CertificateRegistry` v2: separate Hardhat project, tests, fictional example PDFs, deployment record |
| `test/`, `helpers/`, `reference/` | Test suite and local fixtures |
| `scripts/sepolia/` | Base Sepolia deployment, smoke-test and role-reading scripts (testnet only) |
| `deployments/` | Deployment and smoke-test records |
| `mechanism/` | Mechanism design note and dispute simulation (simulated data only) |

## Compiler

- solc **0.8.24**, `viaIR: true`, `evmVersion: cancun`
- Optimizer **runs = 1** for the market, FrozenVrfDraw, MissionTerms, timelock, guard and CodeMissionSuites
  (market runtime size 23,543 bytes, under the EIP-170 limit of 24,576); runs = 200 for other files
- `SuperionToken.sol`: optimizer disabled, `evmVersion: paris`, no viaIR (original verified settings)
- `CertificateRegistry.sol`: runs = 200, viaIR, cancun (`certificates/hardhat.config.cjs`)

`hardhat.config.cjs` is local-only (no networks, keys or environment variables). `hardhat.sepolia.cjs` is the
testnet deployment config; it reads `PRIVATE_KEY` and `ETHERSCAN_API_KEY` from the environment only.

## Install and test

Requires Node.js 18+ (tested with Node 24) and Python 3 (to fetch pinned test dependencies with hash checks).

```bash
npm ci
npm run prepare-deps     # Safe 1.4.1 artifacts + Chainlink 1.5.0 sources from npm, SRI/SHA-256 verified
npx hardhat test         # expected: 342 passing

cd certificates
npm ci
npx hardhat test         # expected: 30 passing
```

Total: **372 passing, 0 failing** (342 V3 stack + 30 CertificateRegistry), from a clean install on 11 November 2026.
Some test files are labelled `RISK` / reproduction: they pass when they reproduce a documented, still-open design
question (see `CHANGELOG.md`), not because the risk is absent. The VRF used in tests is a local mock with **no**
cryptographic proof verification; only the Base Sepolia deployment uses the real Chainlink coordinator.

## Known limitations

- **Not audited.** Internal tests only.
- **Testnet-short windows** (challenge 180 s, commit/reveal 150 s, appeal 120 s, arbitration 1 h). Mainnet values are only a proposal.
- The Chainlink VRF subscription is still owned by the deployer account; a transfer to the testnet Safe has been
  requested and awaits acceptance by the Safe.
- The 48 h timelock delays and publishes governance changes; it does not prevent a bad proposal from being executed.
- The committee draw skips at most 40 busy verifiers; if almost all verifiers are busy, the dispute goes to Safe arbitration.
- Market runtime size margin under EIP-170 is about 1 KB.

## License

MIT — see [LICENSE](LICENSE). Files under `.chainlink-deps/` keep their upstream MIT license.
