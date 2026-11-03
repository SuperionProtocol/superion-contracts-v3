# Simulation results (SIMULATED - not real usage data)
Committee k=3, honest accuracy a=0.9, P(work valid | disputed) q=0.5 unless stated. Units: SUPER.

## Honesty margin = E[honest] - E[best lazy strategy], current V2.1 mainnet
| V \ c | 1 | 10 | 50 | 200 | 1000 |
|---|---|---|---|---|---|
| 10 | +29.8 | +20.8 | -19.2 | -169.2 | -969.2 |
| 100 | +32.8 | +23.8 | -16.2 | -166.2 | -966.2 |
| 1000 | +23.2 | +14.2 | -25.8 | -175.8 | -975.8 |
| 10000 | -84.8 | -93.8 | -133.8 | -283.8 | -1083.8 |
| 100000 | -1164.8 | -1173.8 | -1213.8 | -1363.8 | -2163.8 |

## Honesty margin = E[honest] - E[best lazy strategy], proposal (not deployed)
| V \ c | 1 | 10 | 50 | 200 | 1000 |
|---|---|---|---|---|---|
| 10 | +0.7 | -8.3 | -48.3 | -198.3 | -998.3 |
| 100 | +0.7 | -8.3 | -48.3 | -198.3 | -998.3 |
| 1000 | +2.6 | -6.4 | -46.4 | -196.4 | -996.4 |
| 10000 | +35.0 | +26.0 | -14.0 | -164.0 | -964.0 |
| 100000 | +359.0 | +350.0 | +310.0 | +160.0 | -640.0 |

## Honest verifier: expected minority penalty per dispute vs accuracy (current rules, P=100)
| accuracy a | P(in minority) | expected loss |
|---|---|---|
| 0.95 | 0.048 | 4.8 |
| 0.9 | 0.090 | 9.0 |
| 0.8 | 0.160 | 16.0 |
| 0.7 | 0.210 | 21.0 |
| 0.6 | 0.240 | 24.0 |

## 'Always vote valid' vs honest by base rate q (current rules, V=1000, c=10)
| q | honest | lazy_valid |
|---|---|---|
| 0.2 | 35.0 | -61.3 |
| 0.5 | 18.5 | -35.3 |
| 0.8 | 2.0 | -9.3 |
| 0.95 | -6.3 | 3.7 |

## Bribery: provider with invalid work buys 2 of 3 votes (c=10)
| V | min bribe/verifier (current) | attacker gain | profitable? | stake-at-risk per majority verifier needed with appeal (proposal) |
|---|---|---|---|---|
| 10 | 0.0 | 20 | yes | 12 |
| 100 | 0.0 | 200 | yes | 125 |
| 1000 | 33.5 | 2000 | yes | 1250 |
| 10000 | 616.7 | 20000 | yes | 12500 |
| 100000 | 6448.7 | 200000 | yes | 125000 |

## Sybil: P(attacker holds >=2 of 3 seats), 20 honest verifiers
| attacker IDs | stake locked | share | contiguous block (code today) | scattered | independent draw (proposal) | P after 3 rerolls (contiguous) |
|---|---|---|---|---|---|---|
| 1 | 1000 | 5% | 0.000 | 0.000 | 0.000 | 0.000 |
| 2 | 2000 | 9% | 0.086 | 0.000 | 0.013 | 0.301 |
| 3 | 3000 | 13% | 0.134 | 0.043 | 0.035 | 0.439 |
| 5 | 5000 | 20% | 0.199 | 0.083 | 0.093 | 0.587 |
| 10 | 10000 | 33% | 0.332 | 0.302 | 0.252 | 0.800 |
| 20 | 20000 | 50% | 0.502 | 0.498 | 0.498 | 0.938 |
