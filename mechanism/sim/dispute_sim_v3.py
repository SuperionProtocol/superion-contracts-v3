"""V3 rules re-simulation (SIMULATED - not real usage data). Mirrors contracts/v3/SuperionJobMarketplaceV3.sol
with MARKETPLACE_V3_PARAMS_TESTNET amounts (k=3, appeal k=5, provider stake 100 %).
Run: python3 dispute_sim_v3.py -> out/results_v3.md"""
import itertools, os
from math import comb
OUT = os.path.join(os.path.dirname(__file__), "out"); os.makedirs(OUT, exist_ok=True)
K, KA = 3, 5
clamp = lambda x, lo, hi: max(lo, min(hi, x))
def amounts(V, pen_cap=1000.0):
    fee = clamp(0.03 * V, 10, 5000); pen = clamp(0.05 * V, 100, pen_cap); bond = max(clamp(0.10 * V, 25, 1e5), K * fee)
    return bond, pen, fee
SV = 0.10  # slashVerifierBps share of (slash - fees) to deciding majority

def p_major(a, n):  # prob. a majority of n independent voters with accuracy a is correct
    return sum(comb(n, i) * a**i * (1 - a)**(n - i) for i in range(n // 2 + 1, n + 1))

def payoff(V, c, strat, a=0.9, q=0.5, appeal=True, pen_cap=1000.0):
    B, P, fee = amounts(V, pen_cap)
    p_over = p_major(a, KA) if appeal else 0.0  # appeal committee overturns a wrong round-0 majority
    ev = 0.0
    for truth, pt in ((True, q), (False, 1 - q)):
        if strat == "honest": mine = [(truth, a), (not truth, 1 - a)]; cost = c
        elif strat == "lazy_valid": mine = [(True, 1.0)]; cost = 0
        elif strat == "lazy_invalid": mine = [(False, 1.0)]; cost = 0
        elif strat == "coin": mine = [(True, .5), (False, .5)]; cost = 0
        else: mine = [(None, 1.0)]; cost = 0
        for my, pm in mine:
            for others in itertools.product([0, 1], repeat=K - 1):
                po = 1.0
                for o in others: po *= a if o else 1 - a
                votes = [truth if o else (not truth) for o in others] + ([my] if my is not None else [])
                nv = sum(votes); ni = len(votes) - nv; maj = K // 2 + 1
                w = pt * pm * po
                if my is None: ev += w * (-P); continue
                g = fee - cost
                if nv >= maj or ni >= maj:
                    out = nv >= maj; winners = nv if out else ni
                    coh = (B - K * fee) / winners if out else SV * max(0, V - K * fee) / winners
                    if my == out:
                        wrong = out != truth
                        # wrong majority: overturned on appeal w.p. p_over -> lose coherence, pay penalty
                        g += (1 - p_over) * coh - p_over * P if wrong else coh
                else:
                    pass  # no majority impossible with 3 revealers
                ev += w * g
    return ev

def margin(V, c, **kw):
    h = payoff(V, c, "honest", **kw)
    return h - max(payoff(V, c, s, **kw) for s in ("lazy_valid", "lazy_invalid", "coin", "no_reveal"))

def main():
    global amounts, SV
    Vs = [10, 100, 1000, 10000, 100000]; cs = [1, 10, 50, 200, 1000]
    L = ["# V3 rules - simulation results (SIMULATED, not real data)\n\n",
         "k=3, appeal k=5, honest accuracy a=0.9, q=P(valid|disputed)=0.5, amounts = V3 testnet params (bond 10 %, fee 3 %, penalty 5 % capped 1000). Units SUPER.\n"]
    for title, kw in (("V3 with appeal", {}), ("V3 without appeal (ablation)", {"appeal": False}),
                      ("V3, q=0.8 (most disputes unfounded)", {"q": 0.8}), ("V3, accuracy a=0.7", {"a": 0.7})):
        L.append(f"\n## Honesty margin, {title}\n| V \\ c | " + " | ".join(map(str, cs)) + " |\n|" + "---|" * (len(cs) + 1) + "\n")
        for V in Vs:
            L.append(f"| {V} | " + " | ".join(f"{margin(V, c, **kw):+.1f}" for c in cs) + " |\n")
    L.append("\n## Break-even review cost c* (honest dominant iff c < c*), a=0.9 q=0.5\n| V | c* | c*/V |\n|---|---|---|\n")
    for V in Vs:
        lo, hi = 0.0, 10 * V + 1000
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if margin(V, mid) > 0 else (lo, mid)
        L.append(f"| {V} | {lo:.1f} | {lo/V:.2%} |\n")
    # bribery: provider with invalid work must corrupt round-0 majority (2 of 3) AND the appeal majority (3 of 5),
    # else the bribed round-0 voters are slashed. Min bribe per verifier >= its honest EV + expected penalty.
    L.append("\n## Bribery (truth = invalid), cost of buying 2 of 3 + 3 of 5 votes vs attacker gain (V + unslashed stake)\n")
    L.append("| V | per-verifier min bribe | total (5 verifiers) | gain 2V | profitable? |\n|---|---|---|---|---|\n")
    for V in Vs:
        B, P, fee = amounts(V)
        per = max(0.0, payoff(V, 10, "honest", q=0.0) - fee)  # they still get fee when voting 'valid'; lose coherence
        tot = 5 * per
        L.append(f"| {V} | {per:.1f} | {tot:.1f} | {2*V} | {'yes' if 2*V > tot else 'no'} |\n")
    L.append("\nWith the V3 cap (job <= 50 % of total verifier stake) a briber must control or pay >=5 distinct stake-weighted seats; the table shows the *payment* bound is still low because verifier EV is small - the real deterrent is stake at risk (penalty capped at maxPenalty) and the cap on V. See CHANGELOG_V3 risks.\n")
    # recommended (tuned) amounts = MARKETPLACE_V3_PARAMS_MAINNET_PROPOSAL ratios, floors at testnet scale
    amounts = lambda V, pen_cap=10000.0: (max(clamp(0.20 * V, 25, 1e6), K * clamp(0.03 * V, 10, 5000)),
                                          clamp(0.50 * V, 1000, pen_cap), clamp(0.03 * V, 10, 5000))
    SV = 0.30
    for title, kw in (("RECOMMENDED (bond 20 %, overturn/non-reveal penalty 50 % floor 1000 cap 10000, majority share 30 %)", {}),
                      ("RECOMMENDED, a=0.7", {"a": 0.7}), ("RECOMMENDED, q=0.8", {"q": 0.8})):
        L.append(f"\n## Honesty margin, {title}\n| V \\ c | " + " | ".join(map(str, cs)) + " |\n|" + "---|" * (len(cs) + 1) + "\n")
        for V in Vs:
            L.append(f"| {V} | " + " | ".join(f"{margin(V, c, **kw):+.1f}" for c in cs) + " |\n")
    open(os.path.join(OUT, "results_v3.md"), "w").writelines(L)
    print("".join(L))

if __name__ == "__main__":
    main()
