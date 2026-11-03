# SuperionJobMarketplaceV3 — Changelog (vs V2.1 mainnet `0x5F0297A5…02C1`)

Status: **testnet only**. Deployed and verified on Base Sepolia (see the end of this file). Nothing on Base mainnet was touched.
V2 sources (`contracts/v2/`) are logically unchanged (comment-only translations in this repository). **V2.1 is out of scope of this audit**; mainnet V2.1 addresses below are public on-chain context only. V3 = `contracts/v3/SuperionJobMarketplaceV3.sol` (it reuses `v2/ISuperToken.sol` and works with the existing `SuperionStakingV2`).
Randomness: **future blockhash only, on every network. No Chainlink VRF in V3**, on testnet or mainnet.

## The 8 fixes, in plain English

1. **Committee draw.** V2.1 picked a random start in the verifier list and took the next 3 entries. If you registered 3 addresses one after another, you could win 2 seats ~25 % of the time with 3/12 of the identities. V3 makes `k` separate draws without replacement. Each draw is weighted by the verifier's bonded stake. The creator, the worker (provider) and the challenger are excluded. Verifiers can lock more than the minimum with `registerVerifierWithStake(amount)`.
2. **No prediction, no re-roll.** In V2.1 the challenger knew their seed and `blockhash(commitBlock+1)`, so they knew the committee before revealing. They could skip the reveal, call `expireUnrevealedChallenge` (which set `challengeDeadline = now`) and re-challenge in the same block with a new seed. **Test `V2.1 reproduction` confirms this on V2.1.** V3 changes:
   - Entropy = `keccak(blockhash(challengeBlock+1), salt, jobId, round)`. That block does not exist yet when the challenge is locked. Then **anyone** calls `drawCommittee`, and the result is the same no matter who calls or when.
   - The seed is not revealed any more. `revealCommittee` and `expireUnrevealedChallenge` are removed. **Only one challenge per job.**
   - If nobody draws within 256 blocks, the blockhash expires. The draw then moves to a new future block (`EntropyRetargeted`). That new block is just as unpredictable.
3. **No dispute without a full committee.** `challengeJob` reverts with `NotEnoughVerifiers` if fewer than `committeeSize` eligible verifiers exist (parties excluded). `committeeSize >= 3` is enforced. If verifiers leave between the challenge and the draw: the challenge is cancelled, the bond is returned in full, and the job goes back to `Completed`. The worker can then be paid right away. **The client never gets a free refund.**
4. **Arbiter timing.** `ARBITER_ROLE` is now meant for a **dedicated arbiter** (constructor argument; governance grants and revokes it). The arbitration window may be up to 60 days. The mainnet proposal uses 14 days, which is longer than the ~8-day Governor + Timelock path, so even the Timelock could act in time. If there is no majority and no arbiter decision in time, `resolveStale` does a **neutral 50/50 split** of the budget (no fee). Bonds come back minus vote fees, and non-revealers are slashed. (V2.1 gave a full refund to the client.) In the appeal round, a stale result keeps the round-0 decision.
5. **Verifier pay.** Every verifier who reveals gets the **same per-vote fee, whatever they voted**. The challenger's bond pays these fees; the bond is always at least `committeeSize × fee`. If the challenger wins, the provider's slash pays the fees back to them. The deciding majority also gets a coherence reward: what is left of the losing bond, or `slashVerifierBps` of the slash. **Treasury share:** `treasuryShareBps` of each fee goes to `treasury`, with a hard cap at `MAX_TREASURY_SHARE_BPS = 50 %` of the fee. Only governance can change it (`setParams`) or change the treasury address (`setTreasury`). The rest of the fee is split between burn and stakers, as before. Event `TreasuryPaid`.
6. **Amounts scale with value.** The bond, the penalty and the vote fee are each `bps × budget`, clamped between a min and a max (`disputeAmounts(budget)` view). The appeal bond = bond × `appealBondMultBps`.
7. **Minority is not slashed + appeal (implemented, not deferred).** A verifier who reveals a minority vote is **paid the fee and not slashed**. Only non-reveal is penalised. After the round-0 majority, an `appealWindow` opens. The losing side can appeal **once** with a larger bond: the creator or challenger if the work was judged valid, the provider if it was judged invalid. A **larger committee** (`appealCommitteeSize`, odd, > `committeeSize`) is drawn, with no overlap with round 0 and the parties excluded. If the appeal **overturns** the decision, every round-0 majority voter is penalised and the appellant gets the rest of their appeal bond back. If it is upheld, the rest of the appeal bond goes to the appeal majority. With no appeal, `finalizeDispute` settles after the window. An appeal is refused if there are not enough eligible, non-overlapping verifiers.
8. **Bribery bound.** `createJob` requires `budget <= totalVerifierBond × maxJobStakeBps / BPS` (`maxJobBudget()`). So with zero verifiers, no job can be created at all.

Windows: `scripts/v3/config.cjs` holds `MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL`: challenge 3 d, vote commit 3 d, reveal 2 d, appeal 3 d, arbitration 14 d, committee 5, appeal committee 9. Treasury share is 0 until the pilots. The amounts (bond 20 %, penalty 50 % floor 1 000 cap 10 000, majority share 30 %) are tuned from the simulation. The testnet set keeps windows short (minutes).

## Breaking changes (interfaces / events)
- Constructor: new last-but-one argument `treasury`. The `Params` struct is new: removed `seedRevealDelay`, `seedRevealWindow`, `verifierPenalty`, `challengeBond`; added `treasuryShareBps`, `appealWindow`, `appealCommitteeSize`, `bondBps`, `penaltyBps`, `voteFeeBps`, `appealBondMultBps`, `maxJobStakeBps`, `minBond/maxBond`, `minPenalty/maxPenalty`, `minVoteFee/maxVoteFee`.
- Removed: `revealCommittee(jobId, seed)`, `expireUnrevealedChallenge(jobId)`, event `ChallengeExpired`. Added: `drawCommittee`, `appeal`, `finalizeDispute`, `registerVerifierWithStake`, `setTreasury`, views `disputeAmounts`, `maxJobBudget`, `committeeOfRound`, `rounds`, `memberRound`, `totalVerifierBond`.
- `challengeJob(jobId, bytes32)` keeps its signature. The bytes32 is now just a salt (no reveal). It reverts on a second challenge, with `NotEnoughVerifiers`, and while paused.
- `resolveDispute` on round 0 no longer pays out. It records the decision (`DisputeDecided`) and opens the appeal window. Payment happens in `finalizeDispute` or after the appeal.
- `JobChallenged` keeps its fields, but the last one is now the entropy block (it was the seed reveal deadline). New events: `EntropyRetargeted`, `ChallengeCancelled`, `DisputeDecided`, `Appealed`, `VerifierFeePaid`, `JobSplit`, `TreasuryPaid`, `TreasuryUpdated`.
- New `Status.Split = 8`, added at the end so the existing numbers stay the same. The `Job` struct has an extra field at the end, `treasuryShareBps`, and the `Dispute` layout is new.
- `assignJob` refuses the creator as the provider. `committeeOf(jobId)` returns the current round's committee.
- Compiled with optimizer `runs: 1` (viaIR) to stay under EIP-170 (23 714 bytes). In this repository it is a per-file override in `hardhat.config.cjs`; every other file uses the compiler settings listed in the README.

## Tests — `npx hardhat test`
21 tests in this repository (20 V3 tests + 1 V2.1 reproduction test), all in `test/v3.test.js`; the full internal project suite (incl. V1/V2 and faucet tests) has 53 passing tests. The tests cover: param bounds and governance-only setters, scaling of amounts, job cap, happy path with the treasury/burn/stakers split, cancel/reclaim/pause regressions, empty-committee free-refund attack, verifiers leaving after a challenge, committee properties (distinct, parties excluded, future block), re-roll attack (one challenge, no expire path, retarget), Sybil consecutive registration (60 draws), stake weighting, equal fees with minority not slashed, non-reveal slash with the full invalid-outcome flows, appeal overturn (majority slashed) and appeal upheld, appeal access/deadline/not-enough-verifiers, arbiter only inside its window, the 50/50 stale split, the bribery cap, plus a **V2.1 re-draw reproduction**. Every settlement test checks that the marketplace holds 0 tokens afterwards.

## Slither (0.x, V3 only)
High 2, Medium 11 (2 detectors), Low 19, Info 1. Triage:
- `weak-prng` (High): by design. It is the blockhash entropy; see the risks below. Modulo bias is negligible (256-bit value vs stake totals).
- `uninitialized-state _committees` (High): false positive (written via a `storage` pointer `push`).
- `reentrancy-no-eth` (Medium): every state-changing entry point is `nonReentrant`, and the only external calls go to the immutable SUPER token and Superion's staking contract. CEI was applied to `_register` and `assignJob`.
- `divide-before-multiply` (Medium): intended bps rounding. The dust goes to stakers or is burned.
- Low/Info (timestamps, calls in loops bounded by `MAX_VERIFIERS = 200` / `MAX_COMMITTEE = 15`, missing zero-check on `treasury`, where 0 means the treasury part goes to stakers): accepted.

## Simulation (`mechanism/sim/dispute_sim_v3.py` → `out/results_v3.md`, SIMULATED)
- With the **testnet amounts** (bond 10 %, penalty 5 %), honest review is the best strategy only when the review cost is tiny (c ≈ 7 SUPER, or < 0.4 % of V for big jobs). **Not dominant.**
- **Without the appeal round, honesty is never dominant.** Because the fee is now the same for every vote, the incentive to be accurate comes from the appeal slash.
- With the **recommended amounts** (now in the mainnet proposal), honest review is dominant for every V tested when c ≤ 50 SUPER (a = 0.9, q = 0.5), and up to c = 200 for V ≥ 10 000. It is **not** dominant when the review cost is ≥ 200 for small jobs, when accuracy is low (a = 0.7) on very large jobs, or when q = 0.8 and c ≥ 50 on small jobs.
- Bribery: a provider must buy 2/3 of round 0 **and** 3/5 of the appeal, or the bribed voters get slashed. The minimum bribe based on payments alone is still below the attacker's gain at every V. Only the stake at risk and the job cap limit it. **Not solved, only bounded.**

## Remaining risks
- **Sequencer trust:** the Base sequencer could bias `blockhash(challengeBlock+1)` (by ordering or withholding transactions). VRF would remove this; it is not used.
- If every honest party stays offline for 256 blocks (~8.5 min), someone who dislikes the committee can wait for a retarget. The UI or a keeper should call `drawCommittee` right after the challenge.
- Stake-weighted draws without replacement: splitting stake across several addresses still lets one person hold several seats. Sybils are only priced by stake. A whale with a large share of the stake can capture committees.
- Bribery of both rounds is bounded only by `maxPenalty ≤ minVerifierStake` and `maxJobStakeBps`. Collusion of 5 verifiers remains possible on large jobs.
- The 50/50 stale split can be gamed by non-reveal collusion, at the cost of the non-reveal penalty.
- No third round. The arbiter is a trusted role.
- Gas: `_eligible` reads up to 200 verifiers (≈ 1 M gas at 200) on challenge, appeal and draw.
- Not audited. The simulation is a model, not real data.

## Base Sepolia deployment (testnet)
- MarketplaceV3: `0x220Df97AA2faA3255BbF4F3D043b92B2B269E7CA` (verified)
- Staking for the V3 stack (new StakingV2 instance): `0xD60AD2FD5AD8DA6ED1Dbe262e025f26487C82713` (verified)
- Admin = Sepolia Timelock `0x50072Fdc…84a0`; treasury = Timelock; PAUSER + ARBITER = deployer (testnet only); the deployer renounced staking admin.
- Script: `scripts/v3/deploy-v3-sepolia.cjs` (refuses any chain other than 84532). Record: `deployments/v3.baseSepolia.json`.

## What a mainnet upgrade would require (NOT done)
V2.1 is not upgradeable (no proxy). So the upgrade = deploy a new contract + rewire the roles.
1. An external audit of V3, then a Sepolia pilot with the `MAINNET_PROPOSAL` params.
2. Deploy `SuperionJobMarketplaceV3` on Base with admin = mainnet Timelock `0x1E2d…1151`, pauser = Safe `0xB633…87D4`, a **dedicated arbiter** (e.g. a separate multisig) and a treasury address. The deploy is a normal transaction from any funded account; no Safe signature is needed.
3. Choose one option:
   - **(a) Reuse mainnet StakingV2 `0x92D9…7528`.** This needs `grantRole(OPERATOR_ROLE, V3)` on staking, executed by the Timelock. Today the Timelock's PROPOSER is the Governor: a proposal, then 1 day voting delay, 5 days voting, 2 days timelock (≈ 8 days). If the Safe holds PROPOSER, it is 2-of-3 Safe signatures to `schedule`, then 48 h, then `execute`.
   - **(b) Deploy a fresh staking for V3** (as on Sepolia). No governance call on the old contracts, but stakers must migrate.
4. Optional, through the same path: pause V2.1 (the Safe is PAUSER, 2/3 signatures, no timelock) and later revoke V2.1's OPERATOR_ROLE (Timelock). V2.1 has 0 jobs, so there are no funds to migrate.
5. After the pilots, set `treasuryShareBps` with `setParams` (Timelock, ≤ 50 % of the fee).

## Pilot scope

*Decision of 2 November 2026.* For pilots, Superion accepts **only jobs that are quick and objective to verify**:

- **Eligible jobs:** code delivered with automated tests the verifiers can run; data annotation / labelling with a clear acceptance checklist; other tasks with a short, objective acceptance grid.
- **Required acceptance checklist:** written into the job spec **before work starts** (the checklist template is an internal document, not part of this repository).
- **Target review time:** a design goal — a job should be reviewable in under ~30 minutes. This is a target, not a measured figure.
- **Excluded for now:** subjective or creative work (design, copywriting, marketing…), long reports.

*Why:* the mechanism simulations (`mechanism/sim`, v3 results) indicate that on small jobs the per-vote fee does not cover a long subjective review, so honest review is not rational there. The V3 contract exists on Base Sepolia only (not audited, not on mainnet).
