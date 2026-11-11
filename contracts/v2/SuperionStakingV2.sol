// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./ISuperToken.sol";

/**
 * @title SuperionStakingV2 (stSUPER) — V2.1
 * @notice Staking SUPER → stSUPER non transférable (votes + rewards + collatéral).
 *         V2.1 : délai d'éligibilité aux récompenses (anti sniping flash, M-05).
 *         V2.2 (LOCAL PROTOTYPE) : reliquat d'arrondi par compte reporté au lieu d'être perdu.
 *         Chaque compte garde la fraction (< 1 wei) de SES PROPRES récompenses et la touche dès qu'elle
 *         atteint 1 wei. Qui a droit à quoi ne change pas.
 *         V2.3 (LOCAL PROTOTYPE, décision approuvée) : la part écartée d'un compte qui agit pendant son délai
 *         d'éligibilité, et la sur-réserve d'arrondi (plafond), rejoignent la file d'attente existante
 *         (queuedRewards) et sont distribuées au prochain dépôt. Elles ne sont jamais rendues au compte qui a agi.
 */
contract SuperionStakingV2 is ERC20, ERC20Votes, AccessControl, ReentrancyGuard {
    using SafeERC20 for ISuperToken;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant UNBONDING_PERIOD = 7 days;
    uint256 private constant PRECISION = 1e18;

    ISuperToken public immutable superToken;
    /// @notice Délai après un stake avant d'être éligible aux nouvelles récompenses (anti-snipe, M-05).
    uint256 public immutable rewardEligibilityDelay;

    struct Unbonding {
        uint256 amount;
        uint256 start;
    }
    mapping(address => Unbonding) public unbonding;
    uint256 public totalUnbonding;

    mapping(address => uint256) public lockedStake;

    uint256 public rewardPerTokenStored;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    uint256 public queuedRewards;
    uint256 public totalRewardsOwed;

    /// @notice Timestamp à partir duquel le compte accrète les rewards (anti-snipe M-05).
    mapping(address => uint256) public rewardEligibleAt;

    /// @notice Fraction de wei déjà acquise par le compte, à l'échelle PRECISION (toujours < PRECISION).
    mapping(address => uint256) public rewardRemainder;
    /// @notice Cumul historique (échelle PRECISION) de la croissance écartée pendant le délai d'éligibilité.
    uint256 public cooldownForfeitedScaled;
    /// @notice Fraction (< 1 wei, échelle PRECISION) en attente de retour vers queuedRewards.
    uint256 public requeueRemainderScaled;

    event RewardsRequeued(uint256 amount);

    event Staked(address indexed user, uint256 amount);
    event UnstakeRequested(address indexed user, uint256 amount, uint256 availableAt);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsDeposited(address indexed from, uint256 amount, uint256 distributed);
    event RewardClaimed(address indexed user, uint256 amount);
    event StakeLocked(address indexed user, uint256 amount);
    event StakeUnlocked(address indexed user, uint256 amount);
    event Slashed(address indexed user, uint256 amount, address indexed operator);

    error NonTransferable();
    error ZeroAmount();
    error InsufficientUnlocked();
    error InsufficientLocked();
    error NothingToUnstake();
    error UnbondingNotFinished();
    error RewardsNotEligible();
    error InvalidDelay();

    constructor(address _superToken, address admin, uint256 _rewardEligibilityDelay)
        ERC20("Staked Superion", "stSUPER")
        EIP712("Staked Superion", "1")
    {
        if (_rewardEligibilityDelay < 30 seconds || _rewardEligibilityDelay > 7 days) revert InvalidDelay();
        superToken = ISuperToken(_superToken);
        rewardEligibilityDelay = _rewardEligibilityDelay;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        superToken.safeTransferFrom(msg.sender, address(this), amount);
        if (delegates(msg.sender) == address(0)) _delegate(msg.sender, msg.sender);
        // Accrète d'abord les rewards déjà éligibles (re-stake), puis impose le délai anti-snipe.
        _updateReward(msg.sender);
        rewardEligibleAt[msg.sender] = block.timestamp + rewardEligibilityDelay;
        _mint(msg.sender, amount);
        emit Staked(msg.sender, amount);
    }

    function availableStake(address user) public view returns (uint256) {
        uint256 bal = balanceOf(user);
        uint256 locked = lockedStake[user];
        return bal > locked ? bal - locked : 0;
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (availableStake(msg.sender) < amount) revert InsufficientUnlocked();
        _burn(msg.sender, amount);
        Unbonding storage u = unbonding[msg.sender];
        u.amount += amount;
        u.start = block.timestamp;
        totalUnbonding += amount;
        emit UnstakeRequested(msg.sender, amount, block.timestamp + UNBONDING_PERIOD);
    }

    function completeUnstake() external nonReentrant {
        Unbonding storage u = unbonding[msg.sender];
        uint256 amount = u.amount;
        if (amount == 0) revert NothingToUnstake();
        if (block.timestamp < u.start + UNBONDING_PERIOD) revert UnbondingNotFinished();
        u.amount = 0;
        totalUnbonding -= amount;
        superToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function earned(address account) public view returns (uint256) {
        // Pendant le délai : pas d'accrétion (anti-snipe). Résidu : attente silencieuse post-délai
        // peut encore capturer les dépôts survenus pendant le délai (freiné par unbonding 7j).
        if (block.timestamp < rewardEligibleAt[account]) {
            return rewards[account];
        }
        return rewards[account] + _pendingScaled(account) / PRECISION;
    }

    function _pendingScaled(address account) internal view returns (uint256) {
        return rewardRemainder[account]
            + balanceOf(account) * (rewardPerTokenStored - userRewardPerTokenPaid[account]);
    }

    function depositRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        superToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 distributed = _distribute(amount + queuedRewards);
        emit RewardsDeposited(msg.sender, amount, distributed);
    }

    function _distribute(uint256 pool) internal returns (uint256 distributed) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            queuedRewards = pool;
            return 0;
        }
        uint256 increment = (pool * PRECISION) / supply;
        // RPT already represents fractional claims on these tokens. Reserve the
        // ceiling, not the floor: recycling its fractional part through queuedRewards
        // would distribute the same backing again on the next deposit. Account-level
        // fractions are carried per account (rewardRemainder), so sum of payouts <= reserve.
        distributed = Math.mulDiv(increment, supply, PRECISION, Math.Rounding.Ceil);
        rewardPerTokenStored += increment;
        queuedRewards = pool - distributed;
        totalRewardsOwed += distributed;
        // Ceiling over-reservation (< 1 wei per deposit) is owed to nobody: requeue it once it sums to whole wei.
        _requeue(distributed * PRECISION - increment * supply);
    }

    /// @dev Moves whole wei that no account can ever claim from the reserve back to the existing queue.
    ///      Safe: the reserve is >= sum of exact entitlements; only amounts removed from every entitlement
    ///      (forfeited growth, ceiling surplus) are released, floored, with the fraction carried.
    function _requeue(uint256 scaled) internal {
        uint256 total = requeueRemainderScaled + scaled;
        uint256 whole = total / PRECISION;
        requeueRemainderScaled = total % PRECISION;
        if (whole > 0) {
            totalRewardsOwed -= whole;
            queuedRewards += whole;
            emit RewardsRequeued(whole);
        }
    }

    function claimRewards() external nonReentrant returns (uint256 reward) {
        _updateReward(msg.sender);
        if (block.timestamp < rewardEligibleAt[msg.sender]) revert RewardsNotEligible();
        reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            totalRewardsOwed -= reward;
            superToken.safeTransfer(msg.sender, reward);
            emit RewardClaimed(msg.sender, reward);
        }
    }

    function _updateReward(address account) internal {
        if (account == address(0)) return;
        if (block.timestamp < rewardEligibleAt[account]) {
            // Écarte la croissance RPT pendant le délai (si le compte interagit) : anti-snipe inchangé.
            // Décision approuvée : la part écartée rejoint la file d'attente pour le prochain dépôt.
            uint256 forfeited = balanceOf(account) * (rewardPerTokenStored - userRewardPerTokenPaid[account]);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
            if (forfeited > 0) {
                cooldownForfeitedScaled += forfeited;
                _requeue(forfeited);
            }
            return;
        }
        uint256 pending = _pendingScaled(account);
        rewards[account] += pending / PRECISION;
        rewardRemainder[account] = pending % PRECISION;
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }

    function lock(address user, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        if (availableStake(user) < amount) revert InsufficientUnlocked();
        lockedStake[user] += amount;
        emit StakeLocked(user, amount);
    }

    function unlock(address user, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        if (lockedStake[user] < amount) revert InsufficientLocked();
        lockedStake[user] -= amount;
        emit StakeUnlocked(user, amount);
    }

    function slash(address user, uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) return;
        if (lockedStake[user] < amount) revert InsufficientLocked();
        lockedStake[user] -= amount;
        _burn(user, amount);
        superToken.safeTransfer(msg.sender, amount);
        emit Slashed(user, amount, msg.sender);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        _updateReward(from);
        _updateReward(to);
        super._update(from, to, value);
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }
}
