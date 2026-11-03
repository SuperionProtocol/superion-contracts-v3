"""Superion dispute-game simulation (SIMULATED - not real usage data; mainnet has 0 jobs / 0 verifiers).

Mechanics mirror superion-deploy/contracts/v2/SuperionJobMarketplaceV2.sol (V2.1, deployed at
0x5F02...02C1 on Base). Values are in SUPER; no SUPER price is assumed, so "review cost" c is the
SUPER-equivalent of a reviewer's time. Run: python3 dispute_sim.py  (deterministic, seed=42).
"""
import itertools, json, os, random
import numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.join(os.path.dirname(__file__), "out"); os.makedirs(OUT, exist_ok=True)
K = 3
# On-chain params read from params() on 2026-11-02 (Base mainnet)
CURRENT = dict(name="current V2.1 mainnet", B=lambda V: 25.0, P=lambda V: 100.0, s=1.0, sv=0.20, sc=0.10,
               minority_penalty=True, vote_fee=lambda V: 0.0)
# PROPOSAL (not in code): bond & penalty scale with job value; flat per-vote fee paid by the losing side;
# minority voters who revealed are NOT slashed (only non-reveal is), they just earn nothing.
# PROPOSAL (not in code): symmetric verifier pay = flat per-vote fee paid by the losing side whatever the
# outcome (no 20%-of-slash bonus, so no bias toward 'invalid'); bond scales with V; revealed minority voters
# are NOT slashed (only non-reveal is); bribery handled by an appeal round (see bribery()).
PROPOSAL = dict(name="proposal (not deployed)", B=lambda V: max(25.0, 0.10 * V), P=lambda V: max(100.0, 0.05 * V),
                s=1.0, sv=0.0, sc=0.10, minority_penalty=False, vote_fee=lambda V: max(10.0, 0.03 * V))
APPEAL_OVERTURN_P = 0.8  # PROPOSAL: prob. a wrong majority is overturned on appeal (assumption)

def payoff(m, V, c, a_self, a_oth, q, strat):
    """Expected payoff of one committee member; the other K-1 are honest with accuracy a_oth.
    q = P(work is actually valid | disputed). strat in honest|lazy_valid|lazy_invalid|no_reveal."""
    B, P, fee = m["B"](V), m["P"](V), m["vote_fee"](V)
    ev = 0.0
    for truth_valid, pt in ((True, q), (False, 1 - q)):
        if strat == "honest":
            mine = [(truth_valid, a_self), (not truth_valid, 1 - a_self)]; cost = c
        elif strat == "lazy_valid": mine = [(True, 1.0)]; cost = 0
        elif strat == "lazy_invalid": mine = [(False, 1.0)]; cost = 0
        else: mine = [(None, 1.0)]; cost = 0
        for my_vote, pm in mine:
            for others in itertools.product([0, 1], repeat=K - 1):  # 1 = correct signal
                po = np.prod([a_oth if o else 1 - a_oth for o in others])
                votes = [truth_valid if o else (not truth_valid) for o in others]
                allv = votes + ([my_vote] if my_vote is not None else [])
                nv = sum(1 for v in allv if v); ni = len(allv) - nv
                maj = K // 2 + 1
                if nv >= maj: outcome = True
                elif ni >= maj: outcome = False
                else:  # no majority -> resolveStale: non-revealers penalised, no rewards
                    ev += pt * pm * po * (-P if my_vote is None else 0) - pt * pm * po * cost; continue
                winners = nv if outcome else ni
                pool = B if outcome else m["sv"] * m["s"] * V
                # PROPOSAL fee is taken from the same losing-side funds; modelled as extra pool
                pool += fee * winners
                if my_vote is not None and my_vote == outcome: gain = pool / winners
                elif my_vote is None or m["minority_penalty"]: gain = -P
                else: gain = 0.0
                ev += pt * pm * po * (gain - cost)
    return ev

def honesty_margin(m, V, c, a=0.9, q=0.5):
    h = payoff(m, V, c, a, a, q, "honest")
    best_alt = max(payoff(m, V, c, a, a, q, s) for s in ("lazy_valid", "lazy_invalid", "no_reveal"))
    return h - best_alt

def bribery(m, V, c, a=0.9):
    """Provider with INVALID work bribes 2 of 3 to vote 'valid'. Minimum bribe per verifier =
    honest payoff (truth invalid) - payoff when voting valid with the other bribed member."""
    h = payoff(m, V, c, a, a, 0.0, "honest")
    B, fee = m["B"](V), m["vote_fee"](V)
    bribed_gain = (B + 2 * fee) / 2  # they win, split challenger bond (+fee)
    per = max(0.0, h - bribed_gain)
    cost = 2 * per
    gain = V + m["s"] * V  # payout V + provider stake not slashed
    return per, cost, gain

def committee_contiguous(n, start):
    return [(start + i) % n for i in range(K)]

def sybil_capture(n_honest, m_att, layout, trials=20000, rng=None):
    n = n_honest + m_att
    if layout == "contiguous_block":  # attacker registers back-to-back (list order = registration order)
        att = set(range(m_att))
    else:
        att = set(rng.sample(range(n), m_att))
    hit = 0
    for _ in range(trials):
        com = committee_contiguous(n, rng.randrange(n))
        hit += sum(1 for x in com if x in att) >= 2
    return hit / trials

def sybil_independent(n_honest, m_att, trials=20000, rng=None):
    n = n_honest + m_att; hit = 0
    for _ in range(trials):
        com = rng.sample(range(n), K); hit += sum(1 for x in com if x < m_att) >= 2
    return hit / trials

def main():
    rng = random.Random(42)
    res = {}
    Vs = [10, 100, 1_000, 10_000, 100_000]; cs = [1, 10, 50, 200, 1000]
    lines = ["# Simulation results (SIMULATED - not real usage data)\n",
             "Committee k=3, honest accuracy a=0.9, P(work valid | disputed) q=0.5 unless stated. Units: SUPER.\n"]
    for m in (CURRENT, PROPOSAL):
        lines.append(f"\n## Honesty margin = E[honest] - E[best lazy strategy], {m['name']}\n")
        lines.append("| V \\ c | " + " | ".join(map(str, cs)) + " |\n|" + "---|" * (len(cs) + 1) + "\n")
        grid = []
        for V in Vs:
            row = [honesty_margin(m, V, c) for c in cs]; grid.append(row)
            lines.append(f"| {V} | " + " | ".join(f"{x:+.1f}" for x in row) + " |\n")
        res[m["name"]] = grid
    # subjective disagreement: honest verifier's prob of being slashed as minority
    lines.append("\n## Honest verifier: expected minority penalty per dispute vs accuracy (current rules, P=100)\n")
    lines.append("| accuracy a | P(in minority) | expected loss |\n|---|---|---|\n")
    for a in (0.95, 0.9, 0.8, 0.7, 0.6):
        pmin = a * (1 - a) ** 2 + (1 - a) * a ** 2  # I am outvoted by 2 others
        lines.append(f"| {a} | {pmin:.3f} | {100*pmin:.1f} |\n")
    # lazy vs q
    lines.append("\n## 'Always vote valid' vs honest by base rate q (current rules, V=1000, c=10)\n| q | honest | lazy_valid |\n|---|---|---|\n")
    for q in (0.2, 0.5, 0.8, 0.95):
        lines.append(f"| {q} | {payoff(CURRENT,1000,10,.9,.9,q,'honest'):.1f} | {payoff(CURRENT,1000,10,.9,.9,q,'lazy_valid'):.1f} |\n")
    # bribery
    lines.append("\n## Bribery: provider with invalid work buys 2 of 3 votes (c=10)\n| V | min bribe/verifier (current) | attacker gain | profitable? | stake-at-risk per majority verifier needed with appeal (proposal) |\n|---|---|---|---|---|\n")
    bV = [10, 100, 1000, 10000, 100000]; bc, bp, bg = [], [], []
    for V in bV:
        per, cost, gain = bribery(CURRENT, V, 10); per2, _, _ = bribery(PROPOSAL, V, 10)
        bc.append(cost); bp.append(2 * per2); bg.append(gain)
        need = gain / (2 * APPEAL_OVERTURN_P)  # 2 bribed x r x S >= gain
        bp[-1] = 2 * (per2 + APPEAL_OVERTURN_P * min(need, 1000.0))  # with today's 1000 SUPER stake cap
        lines.append(f"| {V} | {per:.1f} | {gain:.0f} | {'yes' if gain > cost else 'no'} | {need:.0f} |\n")
    # sybil
    lines.append("\n## Sybil: P(attacker holds >=2 of 3 seats), 20 honest verifiers\n| attacker IDs | stake locked | share | contiguous block (code today) | scattered | independent draw (proposal) | P after 3 rerolls (contiguous) |\n|---|---|---|---|---|---|---|\n")
    ms = [1, 2, 3, 5, 10, 20]; sc_, ss_, si_ = [], [], []
    for mm in ms:
        a1 = sybil_capture(20, mm, "contiguous_block", rng=rng); a2 = sybil_capture(20, mm, "scattered", rng=rng)
        a3 = sybil_independent(20, mm, rng=rng); sc_.append(a1); ss_.append(a2); si_.append(a3)
        lines.append(f"| {mm} | {mm*1000} | {mm/(20+mm):.0%} | {a1:.3f} | {a2:.3f} | {a3:.3f} | {1-(1-a1)**4:.3f} |\n")
    open(os.path.join(OUT, "results.md"), "w").writelines(lines)
    # charts
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
    for i, m in enumerate((CURRENT, PROPOSAL)):
        g = np.array(res[m["name"]]); im = ax[i].imshow(np.sign(g) * np.log10(1 + abs(g)), cmap="RdYlGn", vmin=-4, vmax=4)
        ax[i].set_xticks(range(len(cs)), cs); ax[i].set_yticks(range(len(Vs)), Vs)
        ax[i].set_xlabel("review cost c (SUPER)"); ax[i].set_ylabel("job value V (SUPER)")
        ax[i].set_title(m["name"], fontsize=9)
        for y in range(len(Vs)):
            for x in range(len(cs)): ax[i].text(x, y, f"{g[y,x]:+.0f}", ha="center", va="center", fontsize=7)
    fig.suptitle("SIMULATED: honesty margin (green = honest review is best response)", fontsize=10)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, "honesty_margin.png"), dpi=130); plt.close(fig)
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
    ax[0].loglog(bV, bg, "k-o", label="attacker gain (payout + unslashed stake)")
    ax[0].loglog(bV, np.maximum(bc, 1e-1), "r-s", label="bribe cost, current")
    ax[0].loglog(bV, np.maximum(bp, 1e-1), "g-^", label="bribe cost, appeal + 1000 stake at risk")
    ax[0].set_xlabel("job value V"); ax[0].legend(fontsize=7); ax[0].set_title("SIMULATED bribery (2 of 3)", fontsize=9)
    sh = [mm / (20 + mm) for mm in ms]
    ax[1].plot(sh, sc_, "r-o", label="contiguous block (code)"); ax[1].plot(sh, ss_, "y-o", label="scattered")
    ax[1].plot(sh, si_, "g-o", label="independent draw"); ax[1].set_xlabel("attacker share of verifier set")
    ax[1].set_ylabel("P(capture majority)"); ax[1].legend(fontsize=7); ax[1].set_title("SIMULATED Sybil capture", fontsize=9)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, "attacks.png"), dpi=130); plt.close(fig)
    print("".join(lines))

if __name__ == "__main__":
    main()
