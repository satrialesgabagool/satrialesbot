"""Edge detection and Kelly criterion position sizing."""

from dataclasses import dataclass
import numpy as np
from config import Config


@dataclass
class Signal:
    window_id: str
    model_prob: float
    market_prob: float
    edge: float           # model_prob - market_prob (for chosen side)
    side: str             # "YES", "NO", or "ABSTAIN"
    confidence: float     # abs(edge)
    entry_price: float    # price paid per share
    fee_per_share: float
    total_cost: float     # entry_price + fee
    kelly_raw: float
    kelly_adjusted: float
    position_size: float  # dollar amount to risk
    shares: float         # number of shares to buy
    expected_value: float # EV per dollar wagered


def compute_fee(price: float, fee_rate: float) -> float:
    """Polymarket fee: fee_rate * price * (1 - price)."""
    return fee_rate * price * (1.0 - price)


def _make_abstain(window_id, model_prob, market_prob, edge=0.0,
                  entry_price=0.0, fee=0.0, cost=0.0, ev=0.0):
    return Signal(
        window_id=window_id, model_prob=model_prob, market_prob=market_prob,
        edge=edge, side="ABSTAIN", confidence=abs(edge), entry_price=entry_price,
        fee_per_share=fee, total_cost=cost, kelly_raw=0.0, kelly_adjusted=0.0,
        position_size=0.0, shares=0.0, expected_value=ev,
    )


def generate_signal(
    window_id: str,
    model_prob: float,
    market_prob: float,
    bankroll: float,
    config: Config,
) -> Signal:
    """
    Core signal generation with realistic constraints.

    Enforces:
    - Minimum bet size ($1 on Polymarket)
    - Maximum bet size (hard cap, scales with bankroll)
    - Kelly fraction sizing (conservative)
    - Cannot bet more than you have
    """
    model_prob = np.clip(model_prob, 0.01, 0.99)
    market_prob = np.clip(market_prob, 0.02, 0.98)

    # Can't trade if bankroll is too small for minimum bet
    if bankroll < config.min_bet_size:
        return _make_abstain(window_id, model_prob, market_prob)

    # YES side: buy YES at market_prob, win if outcome=1
    yes_price = market_prob
    yes_fee = compute_fee(yes_price, config.fee_rate)
    yes_cost = yes_price + yes_fee
    yes_ev = model_prob * (1.0 - yes_cost) - (1.0 - model_prob) * yes_cost
    yes_edge = model_prob - market_prob

    # NO side: buy NO at (1 - market_prob), win if outcome=0
    no_price = 1.0 - market_prob
    no_fee = compute_fee(no_price, config.fee_rate)
    no_cost = no_price + no_fee
    no_ev = (1.0 - model_prob) * (1.0 - no_cost) - model_prob * no_cost
    no_edge = (1.0 - model_prob) - no_price

    # Pick the better side
    if yes_ev > no_ev and yes_ev > 0:
        side = "YES"
        edge = yes_edge
        entry_price = yes_price
        fee = yes_fee
        cost = yes_cost
        ev = yes_ev
        win_prob = model_prob
    elif no_ev > 0:
        side = "NO"
        edge = no_edge
        entry_price = no_price
        fee = no_fee
        cost = no_cost
        ev = no_ev
        win_prob = 1.0 - model_prob
    else:
        return _make_abstain(window_id, model_prob, market_prob)

    # Check minimum edge threshold
    if abs(edge) < config.entry_threshold:
        return _make_abstain(window_id, model_prob, market_prob, edge,
                             entry_price, fee, cost, ev)

    # Kelly criterion for binary bet
    kelly_raw = win_prob - cost
    kelly_raw = max(kelly_raw, 0.0)

    kelly_adjusted = kelly_raw * config.kelly_fraction

    # Position sizing with realistic constraints
    position_dollars = kelly_adjusted * bankroll

    # Cap at max_position_fraction of bankroll
    position_dollars = min(position_dollars, config.max_position_fraction * bankroll)

    # Hard cap on max bet size (scales: $50 base, grows slowly)
    effective_max_bet = min(config.max_bet_size, bankroll * 0.5)
    position_dollars = min(position_dollars, effective_max_bet)

    # Micro-bankroll override: if Kelly says less than min_bet but we have
    # genuine edge (positive EV + above threshold), bet the minimum.
    # Without this, a $20 bankroll can never place a trade.
    if position_dollars < config.min_bet_size:
        if ev > 0 and abs(edge) >= config.entry_threshold and bankroll >= config.min_bet_size * 2:
            position_dollars = config.min_bet_size
        else:
            return _make_abstain(window_id, model_prob, market_prob, edge,
                                 entry_price, fee, cost, ev)

    # Cannot bet more than you have
    position_dollars = min(position_dollars, bankroll - 0.01)

    shares = position_dollars / cost if cost > 0 else 0.0

    return Signal(
        window_id=window_id,
        model_prob=model_prob,
        market_prob=market_prob,
        edge=edge,
        side=side,
        confidence=abs(edge),
        entry_price=entry_price,
        fee_per_share=fee,
        total_cost=cost,
        kelly_raw=kelly_raw,
        kelly_adjusted=kelly_adjusted,
        position_size=position_dollars,
        shares=shares,
        expected_value=ev,
    )
