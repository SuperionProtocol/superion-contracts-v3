# Changelog

All dates are 2026. Everything below is **Base Sepolia testnet only and not audited**. V3 is not deployed on Base mainnet.

## v3-trois-limites-sepolia-2026-11-10 — Base Sepolia release

Deployed on Base Sepolia on 10 November; end-to-end dispute with Chainlink VRF fulfillment run on 11 November.
Addresses, bytecode check and smoke-test transactions: see [README](README.md).

### Randomness and committee draw
- New `FrozenVrfDraw` engine (created by the market): at challenge time the eligible candidate list is frozen and
  snapshotted, and exactly one Chainlink VRF v2.5 request is made (native payment, `callbackGasLimit` 2,500,000,
  3 confirmations). The committee is drawn from the frozen list once the random word arrives; replays are ignored and
  there is no re-request. A failed or missing fulfillment leaves the dispute to Safe arbitration.
- This replaces the future-blockhash entropy of the `audit-v3-snapshot-1` version.
- The draw can skip up to 40 verifiers that are already busy (previously 10) before falling back to Safe arbitration.
- Unselected candidates can release themselves (`releaseCandidate`) once the draw result is public and then exit;
  selected jurors stay locked until their round settles.
- A selected juror who was slashed in another dispute in the meantime is still seated; the slash is still paid.

### Mission terms and collateral
- New `MissionTerms` module (created by the market): append-only parameter versions; every job is bound to the
  version in force at creation, and disputes and appeals use that version. `setParams` / `setFees` moved there,
  still restricted to the market admin.
- Per-seat collateral reservation inside the verifier's locked registration stake, sized to the frozen maximum
  penalty of the dispute; released at the settlement of each round. The penalty is reserved only for drawn jurors,
  in the same transaction as the VRF result.
- Treasury address is frozen per job at creation. Default fee split for new jobs: 5 % fee = 2.5 % treasury,
  1.5 % stakers, 1 % burned. Existing jobs keep their frozen rates.

### Pause
- The market pause is an emergency freeze held by the testnet Safe (2-of-3), effective immediately. While paused,
  new activity, challenges, appeals, cancellations, `resolveDispute` and Safe arbitration are refused; all protected
  windows, including voting windows, are frozen and resume afterwards. Only `finalizeJob` / `finalizeDispute` whose
  window had already ended before the pause can still pay out.

### Governance
- New `SuperionGovernanceTimelock` (OpenZeppelin `TimelockController` with a 48 h floor). Admin roles of the market
  and staking go to the timelock only; other roles to the official Safe only; the staking operator role can only be
  the official market (`updateMarket`, 48 h). The deployer renounces all roles.
- New `SafeLocalGuard` installed on the testnet Safe: refuses threshold < 2, fewer than 2 owners, modules,
  removing or replacing the guard, fallback-handler changes and DELEGATECALL.

### Staking (`SuperionStakingV2`, new instance for the V3 stack)
- Rounding remainders are tracked per account.
- Rewards withheld during the eligibility delay are re-queued to the next reward deposit.

### Code missions
- New `CodeMissionSuites` module: frozen commitments to test suites for code missions; hidden checks that are never
  revealed do not count against the provider (`hiddenChecksStatus`). The contract does not run tests.

### Certificate registry
- `CertificateRegistry` v2 added under `certificates/` (separate Hardhat project) and deployed on Base Sepolia,
  admin = testnet Safe, three demo issuers with fictional documents.

### Tests
- 342 passing in the V3 stack suite (23 files) + 30 passing in `certificates/` = **372 passing, 0 failing**
  from a clean `npm ci` on 11 November. The V2.1 unit tests of the internal project are not included in this
  repository; the V2.1 re-draw reproduction test is.

### Repository
- `hardhat.sepolia.cjs` (testnet deployment config, keys from environment variables only), `scripts/sepolia/`,
  `deployments/` records and `deployments/verify-args/` added.
- `deployments/v3.baseSepolia.json` (earlier V3 deployment from the snapshot) is kept for history; that deployment is superseded.
- `contracts/v3/CHANGELOG_V3.md` describes the snapshot design and is unchanged.

## audit-v3-snapshot-1 — 3 November

First public snapshot (commit `5036bd8`): `SuperionJobMarketplaceV3` with blockhash-based committee draw,
21 tests. Kept unchanged under the tag `audit-v3-snapshot-1`.
