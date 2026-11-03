# Superion JobMarketplace V3 — audit snapshot

> **Status: NOT AUDITED. Testnet only (Base Sepolia). Not deployed on Base mainnet.**
> Do not use these contracts with real funds.

Superion is a verified-work marketplace on Base. A client (creator) posts a job paid in SUPER, a
staked provider delivers it, and anyone can challenge the result during a challenge period. A
challenged job goes to a committee of staked verifiers drawn at random (stake-weighted, without
replacement, parties excluded) who vote with commit/reveal. One appeal round with a larger, disjoint
committee is possible. A dedicated arbiter role can decide when there is no majority; otherwise the
dispute times out into a neutral 50/50 split.

V3 (`SuperionJobMarketplaceV3`) replaces the V2.1 dispute logic with 8 fixes (committee draw,
unpredictable entropy and no re-roll, full-committee requirement, arbiter timing, equal verifier
pay, value-scaled amounts, appeal round, bribery bound). See
[`contracts/v3/CHANGELOG_V3.md`](contracts/v3/CHANGELOG_V3.md) for the full list, breaking changes,
Slither triage and remaining risks.

## Audit scope

| File | Lines | Notes |
|---|---:|---|
| `contracts/v3/SuperionJobMarketplaceV3.sol` | 805 | Main contract under review |
| `contracts/v2/SuperionStakingV2.sol` | 206 | Staking contract used by the V3 stack (Sepolia instance `0xD60A…2713` is a fresh deployment of this exact source) |
| `contracts/v2/ISuperToken.sol` | 9 | Token interface imported by V3 and staking |
| `contracts/SuperionToken.sol` | 26 | SUPER ERC-20 token (fixed supply, burnable, pausable) |
| **Total** | **1,046** | |

External dependency: OpenZeppelin Contracts **5.6.1** (pinned in `package.json` / `package-lock.json`).

### Out of scope (included only so the test suite compiles and runs)

| File | Lines | Why it is here |
|---|---:|---|
| `contracts/v2/SuperionJobMarketplaceV2.sol` | 585 | V2.1 marketplace, used by one test that reproduces the V2.1 re-draw issue fixed in V3 |
| `contracts/v2/SuperionTimelock.sol` | 11 | Deployed by that same V2.1 reproduction test |
| `contracts/v2/SuperionGovernor.sol` | 99 | Deployed by that same V2.1 reproduction test |
| `scripts/`, `test/`, `mechanism/` | — | Test helpers, parameters, design notes and simulation |

Also out of scope: front-end, off-chain keepers, deployment scripts, the Base sequencer, and
governance operations (Timelock/Governor/Safe) beyond how V3 uses its roles.

## Compiler

- solc **0.8.24**, `viaIR: true`, `evmVersion: cancun`
- `SuperionJobMarketplaceV3.sol`: optimizer **enabled, runs = 1** (to stay under EIP-170; deployed size 23,714 bytes)
- `SuperionStakingV2.sol` and other V2 files: optimizer enabled, runs = 200
- `SuperionToken.sol`: optimizer **disabled**, `evmVersion: paris`, no viaIR (original verified settings)

All settings are in [`hardhat.config.cjs`](hardhat.config.cjs), which is local-only (no networks, keys or env vars).

## Install and test

Requires Node.js 18+ (tested with Node 22).

```bash
npm ci
npx hardhat test
```

Expected: **21 passing**. That is 21 tests in this repository (20 V3 tests + 1 V2.1 reproduction test), all in `test/v3.test.js`; the full internal project suite (incl. V1/V2 and faucet tests) has 53 passing tests.
Each settlement test checks that the marketplace holds 0 tokens afterwards.

Test parameters come from `scripts/v3/config.cjs` (`MARKETPLACE_V3_PARAMS_TESTNET`, short windows
in seconds/minutes; `MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL`, windows in days and amounts tuned
from the simulation).

## Deployment (Base Sepolia, chain id 84532 — testnet only)

| Contract | Address |
|---|---|
| SuperionJobMarketplaceV3 | `0x220Df97AA2faA3255BbF4F3D043b92B2B269E7CA` |
| SuperionStakingV2 (V3 stack instance) | `0xD60AD2FD5AD8DA6ED1Dbe262e025f26487C82713` |
| SUPER token | `0xf5a6F83CE27692A247C3B2d1b7e0a3C3234300b4` |
| Timelock (admin + treasury) | `0x50072Fdc8b05972Bfa5BB73472208172470e84a0` |

Bytecode check (eth_getCode on `https://sepolia.base.org`, immutables masked): the runtime bytecode compiled from this repository
for `SuperionJobMarketplaceV3` (23,714 bytes) and `SuperionStakingV2` (11,723 bytes) matches the deployed code byte for byte,
including the CBOR metadata hash, so the in-scope sources here are exactly the deployed sources.
`SuperionStakingV2` is fully verified on Blockscout (base-sepolia.blockscout.com); the marketplace is not verified on Blockscout.

Deployment record with constructor parameters: [`deployments/v3.baseSepolia.json`](deployments/v3.baseSepolia.json).
V3 is **not** deployed on Base mainnet.

### Note on `SuperionStakingV2.sol` comments

To keep this file byte-identical to the deployed and verified source (same metadata hash), its few French
comments are left untouched. English meaning:
- Header: "Staking SUPER -> non-transferable stSUPER (votes + rewards + collateral). V2.1: reward-eligibility delay (anti flash-sniping, M-05)."
- `rewardEligibilityDelay` / `rewardEligibleAt`: delay after a stake before the account accrues new rewards (anti-snipe, M-05).
- In `stake`: first accrue already-eligible rewards (re-stake), then apply the anti-snipe delay.
- In `earned`: no accrual during the delay. Residual: silent waiting after the delay can still capture deposits made during the delay (slowed by the 7-day unbonding).
- In `_updateReward`: discard reward-per-token growth during the delay (if the account interacts).

V2.1 (`contracts/v2/SuperionJobMarketplaceV2.sol`, Governor, Timelock) is out of scope; mainnet V2.1 addresses mentioned in the changelog are public context only.

## Design notes

- [`mechanism/SUPERION_MECHANISM_NOTE_EN.md`](mechanism/SUPERION_MECHANISM_NOTE_EN.md) (also as PDF): mechanism design note.
- [`mechanism/sim/`](mechanism/sim/): dispute game simulation (`dispute_sim_v3.py` → `out/results_v3.md`). Simulated data only; no real usage data exists.

## Known limitations

- **Testnet-short windows** on the Sepolia deployment (challenge 180 s, commit/reveal 150 s, appeal 120 s, arbitration 1 h). Mainnet values are only a proposal.
- **Arbiter = deployer on Sepolia** (also PAUSER). On mainnet the arbiter is meant to be a dedicated multisig.
- **Randomness = future blockhash**, no VRF. The Base sequencer could bias it; a 256-block retarget path exists.
- Sybils are priced only by stake; bribery is bounded (job cap, penalties, appeal), not prevented.
- `_eligible` iterates up to 200 verifiers (~1M gas at the maximum).
- **Existing review coverage:** no external audit or review so far. Internal only: the Hardhat test suite above and a Slither run on V3, triaged in `CHANGELOG_V3.md` (High 2, Medium 11, Low 19, Info 1; the two Highs are by design / false positive).

## License

MIT — see [LICENSE](LICENSE), matching the SPDX headers in all Solidity files.
