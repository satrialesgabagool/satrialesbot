"""
Kalshi BTC Snipe Trader — the v3 Polymarket snipe bot ported to Kalshi.

Thesis (adapted from the Polymarket version):
  Kalshi BTC markets (KXBTCD "greater than" and KXBTC "between X and Y")
  have 188+ strikes per event with $100 granularity. In the final minutes
  before settlement, many strikes have stale asks relative to BTC spot.

Example: spot $75,015, strike T74999 YES ask $0.73. If spot holds above
$74,999 until close, YES settles at $1 — a 37% return over a few minutes.
The "edge" comes from the market under-pricing short-horizon persistence
of an already-achieved price level.

Differences from Polymarket v3:
  - No fixed 5m/15m window cadence. Kalshi events close at specific
    strike_date timestamps (typically 1am + 5pm EDT daily + a 17:00 close).
  - Multiple strikes per event — bot hits a ladder, not a single YES/NO.
  - Stage detection uses minutes-to-close of the event, not window epoch.
  - Conviction scaled by DISTANCE-from-strike (not spot-move magnitude).

Usage:
    python kalshi_snipe_trader.py                  # paper, unlimited, production Kalshi (read-only)
    python kalshi_snipe_trader.py --hours 8        # run 8 hours
    python kalshi_snipe_trader.py --bankroll 50    # start at $50
    python kalshi_snipe_trader.py --demo           # use Kalshi demo env (for testing auth)
    python kalshi_snipe_trader.py --live           # REAL orders (requires KALSHI_KEY_ID + KALSHI_PRIVATE_KEY)

SAFETY: `--live` is guarded by explicit flag AND credentials presence. The
default path is paper, same as Polymarket v3. Even with --live, a dry-run
wall prints each intended order and requires confirmation on first run.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set, Tuple

from db import init_db, get_db, save_live_trade, resolve_trade, log_event
from kalshi_feed import (
    KalshiFeed, KalshiOrderClient, KalshiCredentials,
    parse_dollars, parse_count,
)
from signals import compute_fee

# Force UTF-8 on Windows consoles that default to cp1252. Without this,
# any em-dash or box-drawing char in a Kalshi event title crashes the
# handler. Reconfiguring stdout is a no-op on already-utf8 systems.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            os.path.join(os.path.dirname(__file__), "kalshi_snipe_trader.log"),
            encoding="utf-8",
        ),
    ],
)
log = logging.getLogger("kalshi_snipe")


# ============================================================
# Config
# ============================================================

@dataclass
class KalshiSnipeConfig:
    # --- Strike-distance thresholds (absolute $ from spot) ---
    # These map to 'weak/medium/strong' conviction: farther from spot =
    # stronger conviction that intrinsic value holds.
    dist_weak: float = 50.0       # $50 minimum distance to fire (noise floor)
    dist_medium: float = 150.0    # $150+ = medium
    dist_strong: float = 300.0    # $300+ = strong

    # --- Minimum time-to-close to bother with (seconds) ---
    # Below this, order may not fill. Above it, too much volatility.
    min_time_to_close_s: int = 10       # need 10s+ to place an IOC
    max_time_to_close_s: int = 600      # ignore events >10 min out (low edge)
    # stage boundaries (prime = stalest, wide = most uncertain)
    prime_time_to_close_s: int = 120    # final 2 min = prime
    late_time_to_close_s: int = 300     # final 5 min = late

    # --- Winner price gates (YES ask or 1-YES_bid) ---
    # These are intentionally tight — if the book is giving us the winner
    # at close to $1.00 there's little edge; if it's below $0.50 the
    # market is saying "actually no, you're wrong". We want the sweet
    # spot where the book is stale but hasn't given up.
    gate_max: float = 0.95      # don't pay more than $0.95 (min 5% edge required)
    gate_min: float = 0.55      # require the book to still think we win

    # --- Sizing (fractions of bankroll unless flat) ---
    size_weak_flat: float = 1.0
    size_medium_pct: float = 0.05
    size_strong_pct: float = 0.15
    size_cap_pct: float = 0.25

    # --- Bankroll / risk ---
    initial_bankroll: float = 20.0
    min_bankroll: float = 0.50
    min_bet: float = 1.0
    fee_rate: float = 0.072  # approximate — Kalshi actual fees are similar shape

    # --- Kelly sizing (confidence-based risk) ---
    use_kelly: bool = True
    kelly_fraction: float = 0.50
    kelly_min_samples: int = 5
    kelly_prior_alpha: float = 2.0
    kelly_prior_beta: float = 2.0
    kelly_min_p: float = 0.55
    kelly_max_p: float = 0.98

    # --- Loop cadence ---
    poll_interval: int = 5             # seconds between event scans
    # Per-event market scan: only pull fresh data this often even if
    # the main loop runs faster.
    event_refresh_s: int = 3

    # --- Resolution deadline ---
    resolution_deadline_s: int = 900   # 15 min after close


# ============================================================
# PendingKalshiTrade — mirrors PendingTrade but Kalshi-native
# ============================================================

@dataclass
class PendingKalshiTrade:
    window_id: str                 # "kalshi-snipe-{event}-{market}"
    event_ticker: str
    market_ticker: str
    side: str                      # "YES" | "NO"
    entry_price: float             # what we paid (YES ask or NO ask)
    fee: float                     # total fee paid
    shares: float                  # contracts owned
    total_cost: float              # per-contract cost incl. fee
    stage: str                     # "prime" | "late" | "wide"
    conviction: str                # "weak" | "medium" | "strong"
    strike: float
    spot_at_entry: float
    strike_type: str               # "greater" | "between" | "less"
    close_ts: float                # event strike_date as epoch

    # Live-order tracking (None in paper mode)
    kalshi_order_id: Optional[str] = None
    order_status: str = "paper"    # "paper" | "submitted" | "filled" | "rejected" | "canceled"


# ============================================================
# Hunter
# ============================================================

class KalshiSnipeHunter:

    def __init__(
        self,
        config: KalshiSnipeConfig,
        db_path: str,
        feed: KalshiFeed,
        order_client: Optional[KalshiOrderClient] = None,
        live: bool = False,
    ):
        self.config = config
        self.db_path = db_path
        self.feed = feed
        self.order_client = order_client
        self.live = live and order_client is not None

        self.bankroll = config.initial_bankroll
        self.peak_bankroll = config.initial_bankroll

        # Dedup per (event, market, stage) — each combo fires at most once
        self.fired: Set[Tuple[str, str, str]] = set()

        self.pending: List[PendingKalshiTrade] = []

        self.should_stop = False
        self.paused = False
        self.drain_timeout_s = 900

        self.events: List[dict] = []
        self._events_cap = 200

        # Stats
        self.total_snipes = 0
        self.total_wins = 0
        self.total_pnl = 0.0
        self.total_fees = 0.0
        self.bust_count = 0

        self.stage_stats: Dict[str, Dict[str, float]] = {
            s: {"trades": 0, "wins": 0, "pnl": 0.0}
            for s in ("prime", "late", "wide")
        }
        self.conviction_stats: Dict[str, Dict[str, float]] = {
            c: {"trades": 0, "wins": 0, "pnl": 0.0}
            for c in ("weak", "medium", "strong")
        }
        self.bucket_stats: Dict[Tuple[str, str], Dict[str, float]] = {
            (s, c): {"trades": 0, "wins": 0, "pnl": 0.0}
            for s in ("prime", "late", "wide")
            for c in ("weak", "medium", "strong")
        }
        self.market_stats: Dict[str, Dict[str, float]] = {}

        # Ensure schema exists (cheap no-op if it does) before replay.
        # Without this, a fresh DB triggers 'no such table' on first run.
        try:
            init_db(self.db_path)
        except Exception as e:
            log.warning(f"init_db failed ({e}); replay will be skipped")

        # Replay persisted Kalshi trades (distinct from Polymarket v3 rows)
        try:
            self._load_persisted_state()
        except Exception as e:
            log.warning(f"Could not load persisted state (fresh start): {e}")

    # ----------------------------------------------------------
    # Persistence
    # ----------------------------------------------------------

    def _load_persisted_state(self):
        import sqlite3
        conn = sqlite3.connect(self.db_path, timeout=5)
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT window_id, model_name, side, pnl
                FROM live_trades
                WHERE outcome IS NOT NULL
                  AND window_id LIKE 'kalshi-snipe-%'
                ORDER BY COALESCE(resolved_at, timestamp) ASC
            """)
            rows = cur.fetchall()
        finally:
            conn.close()

        if not rows:
            return

        for window_id, model_name, side, pnl in rows:
            pnl = float(pnl or 0.0)
            self.bankroll += pnl
            self.total_pnl += pnl
            self.total_snipes += 1
            if pnl > 0:
                self.total_wins += 1

            stage = self._parse_stage(model_name)
            conviction = self._parse_conviction(model_name)

            if stage and stage in self.stage_stats:
                st = self.stage_stats[stage]
                st["trades"] += 1
                if pnl > 0:
                    st["wins"] += 1
                st["pnl"] += pnl
            if conviction and conviction in self.conviction_stats:
                cv = self.conviction_stats[conviction]
                cv["trades"] += 1
                if pnl > 0:
                    cv["wins"] += 1
                cv["pnl"] += pnl
            if stage and conviction:
                bk = self.bucket_stats.get((stage, conviction))
                if bk:
                    bk["trades"] += 1
                    if pnl > 0:
                        bk["wins"] += 1
                    bk["pnl"] += pnl

            self.peak_bankroll = max(self.peak_bankroll, self.bankroll)

        log.info(
            f"Loaded persisted state: bankroll=${self.bankroll:.2f}, "
            f"peak=${self.peak_bankroll:.2f}, "
            f"{self.total_wins}W/{self.total_snipes - self.total_wins}L, "
            f"pnl=${self.total_pnl:+.2f}"
        )

    @staticmethod
    def _parse_stage(model_name: Optional[str]) -> Optional[str]:
        """model_name format: 'kalshi_<stage>_<conviction>'"""
        if not model_name or not model_name.startswith("kalshi_"):
            return None
        parts = model_name.split("_")
        if len(parts) >= 3:
            s = parts[1]
            if s in ("prime", "late", "wide"):
                return s
        return None

    @staticmethod
    def _parse_conviction(model_name: Optional[str]) -> Optional[str]:
        if not model_name or not model_name.startswith("kalshi_"):
            return None
        parts = model_name.split("_")
        if len(parts) >= 3:
            c = parts[2]
            if c in ("weak", "medium", "strong"):
                return c
        return None

    # ----------------------------------------------------------
    # Kelly sizing — identical math to snipe_trader.py
    # ----------------------------------------------------------

    def _bucket_probability(
        self, stage: str, conviction: str
    ) -> Tuple[float, int]:
        cfg = self.config
        a0, b0 = cfg.kelly_prior_alpha, cfg.kelly_prior_beta

        bk = self.bucket_stats.get((stage, conviction), {"trades": 0, "wins": 0})
        n = int(bk["trades"])
        w = int(bk["wins"])

        if n < cfg.kelly_min_samples:
            parent = self.stage_stats.get(stage, {"trades": 0, "wins": 0})
            n_parent = int(parent["trades"])
            w_parent = int(parent["wins"])
            n_eff = n + 0.5 * n_parent
            w_eff = w + 0.5 * w_parent
            p = (w_eff + a0) / (n_eff + a0 + b0)
            return (min(max(p, 0.0), cfg.kelly_max_p), n)

        p = (w + a0) / (n + a0 + b0)
        return (min(max(p, 0.0), cfg.kelly_max_p), n)

    def _kelly_fraction(self, p: float, q: float) -> float:
        if q <= 0 or q >= 1.0:
            return 0.0
        if p <= q:
            return 0.0
        return (p - q) / (1.0 - q)

    def _compute_bet_size(
        self, stage: str, conviction: str, winner_price: float
    ) -> Tuple[float, str, dict]:
        cfg = self.config

        if conviction == "strong":
            conv_size = self.bankroll * cfg.size_strong_pct
        elif conviction == "medium":
            conv_size = self.bankroll * cfg.size_medium_pct
        else:
            conv_size = cfg.size_weak_flat

        cap = self.bankroll * cfg.size_cap_pct

        if not cfg.use_kelly:
            size = max(min(conv_size, cap, self.bankroll - 0.01), cfg.min_bet)
            return (size, "conviction", {"p": None, "q": winner_price})

        p, n = self._bucket_probability(stage, conviction)
        q = winner_price
        kelly_f = self._kelly_fraction(p, q)

        info = {
            "p": round(p, 4), "q": round(q, 4),
            "kelly_f": round(kelly_f, 4), "n": n,
            "fraction": cfg.kelly_fraction,
        }

        if p < cfg.kelly_min_p or kelly_f <= 0.0 or n == 0:
            size = max(min(conv_size, cap, self.bankroll - 0.01), cfg.min_bet)
            return (size, "conviction", info)

        kelly_pct = cfg.kelly_fraction * kelly_f
        kelly_size = kelly_pct * self.bankroll

        size = max(kelly_size, conv_size)
        size = min(size, cap, self.bankroll - 0.01)
        size = max(size, cfg.min_bet)
        info["kelly_pct"] = round(kelly_pct, 4)
        info["final_size"] = round(size, 2)
        return (size, "kelly", info)

    # ----------------------------------------------------------
    # Stage classifier
    # ----------------------------------------------------------

    def _stage_for(self, secs_to_close: float) -> Optional[str]:
        cfg = self.config
        if secs_to_close < cfg.min_time_to_close_s:
            return None
        if secs_to_close > cfg.max_time_to_close_s:
            return None
        if secs_to_close <= cfg.prime_time_to_close_s:
            return "prime"       # final 2 min = stalest, tightest edge needed
        if secs_to_close <= cfg.late_time_to_close_s:
            return "late"        # 2-5 min = medium
        return "wide"            # 5-10 min = wide (needs big distance to fire)

    # ----------------------------------------------------------
    # Intrinsic value calc — is this strike currently satisfied?
    # ----------------------------------------------------------

    def _intrinsic(
        self, market: dict, spot: float
    ) -> Tuple[Optional[int], str, Optional[float]]:
        """
        Return (intrinsic, strike_type, strike).
        intrinsic: 1 if YES currently satisfied, 0 if NO currently satisfied,
                   None if cannot determine (e.g. scalar/functional markets).
        """
        stype = self.feed.get_strike_type(market)
        strike = self.feed.get_strike_price(market)
        if strike is None:
            return (None, stype, None)

        if stype == "greater":
            return (1 if spot > strike else 0, stype, strike)
        if stype == "less":
            return (1 if spot < strike else 0, stype, strike)
        if stype == "between":
            floor = market.get("floor_strike")
            cap = market.get("cap_strike")
            if floor is not None and cap is not None:
                return (1 if float(floor) <= spot <= float(cap) else 0, stype, strike)
            # Fallback: assume ±$50 window (Kalshi BTC brackets)
            return (1 if abs(spot - strike) <= 50 else 0, stype, strike)
        return (None, stype, strike)

    # ----------------------------------------------------------
    # Scan: find all snipe opportunities in live events
    # ----------------------------------------------------------

    def scan_all(self):
        try:
            events = self.feed.get_live_btc_events()
        except Exception as e:
            log.warning(f"get_live_btc_events error: {e}")
            return

        spot = self.feed.get_price("btc")
        if spot <= 0:
            return

        now = time.time()
        for ev in events:
            try:
                self._scan_event(ev, spot, now)
            except Exception as e:
                log.warning(f"_scan_event({ev.get('event_ticker')}) error: {e}")

    def _scan_event(self, event: dict, spot: float, now: float):
        event_ticker = event.get("event_ticker", "")
        strike_iso = event.get("strike_date")
        if not strike_iso:
            return
        try:
            from datetime import datetime
            close_ts = datetime.fromisoformat(
                strike_iso.replace("Z", "+00:00")
            ).timestamp()
        except Exception:
            return

        secs_to_close = close_ts - now
        stage = self._stage_for(secs_to_close)
        if stage is None:
            return

        markets = event.get("markets") or []
        for m in markets:
            try:
                self._try_fire_market(event_ticker, m, spot, close_ts, stage, secs_to_close)
            except Exception as e:
                log.warning(f"_try_fire_market error: {e}")

    def _try_fire_market(
        self,
        event_ticker: str,
        market: dict,
        spot: float,
        close_ts: float,
        stage: str,
        secs_to_close: float,
    ):
        cfg = self.config
        ticker = market.get("ticker", "")
        if not ticker:
            return
        status = (market.get("status") or "").lower()
        if status not in ("active", "open"):
            return

        if self.bankroll < cfg.min_bet:
            return

        # Dedup key — per event+market+stage; each only fires once.
        key = (event_ticker, ticker, stage)
        if key in self.fired:
            return

        intrinsic, stype, strike = self._intrinsic(market, spot)
        if intrinsic is None or strike is None:
            return

        # Skip markets right at the strike boundary (high variance)
        distance = abs(spot - strike)
        if distance < cfg.dist_weak:
            return

        # Winner side: YES if intrinsic==1, NO if intrinsic==0.
        # Price we'd pay: YES ask for YES, (1 - YES bid) for NO (Kalshi
        # quotes all in YES-price terms; NO = 1 - YES).
        yes_bid = parse_dollars(market.get("yes_bid_dollars"))
        yes_ask = parse_dollars(market.get("yes_ask_dollars"))
        if yes_ask <= 0 or yes_bid <= 0:
            return

        if intrinsic == 1:
            side = "YES"
            winner_price = yes_ask
        else:
            side = "NO"
            winner_price = 1.0 - yes_bid  # price to buy NO = 1 - yes_bid

        # Gate by winner price — need non-trivial edge but not too stale-illiquid
        if winner_price <= 0 or winner_price > cfg.gate_max:
            return
        if winner_price < cfg.gate_min:
            return

        # Require some book depth
        bid_size = parse_count(market.get("yes_bid_size_fp"))
        ask_size = parse_count(market.get("yes_ask_size_fp"))
        if side == "YES" and ask_size < 1:
            return
        if side == "NO" and bid_size < 1:
            return

        # Conviction by distance
        if distance >= cfg.dist_strong:
            conviction = "strong"
        elif distance >= cfg.dist_medium:
            conviction = "medium"
        else:
            conviction = "weak"

        # Sizing
        size, sizing_mode, sizing_info = self._compute_bet_size(
            stage, conviction, winner_price
        )
        if size < cfg.min_bet:
            return

        # Fee + shares
        fee_per = compute_fee(winner_price, cfg.fee_rate)
        cost_per = winner_price + fee_per
        shares = size / cost_per
        cost_dollars = shares * cost_per
        if cost_dollars > self.bankroll:
            return

        # Commit (paper by default)
        order_id = None
        order_status = "paper"
        if self.live and self.order_client:
            # Live path: IOC limit buy at the ask we saw
            try:
                coid = f"snipe-{int(time.time()*1000)}-{ticker[-8:]}"
                price_to_place = yes_ask if side == "YES" else (1.0 - yes_bid)
                kalshi_side = "yes" if side == "YES" else "no"
                order = self.order_client.place_limit_buy(
                    ticker=ticker,
                    side=kalshi_side,
                    count=max(1, int(shares)),
                    price_dollars=price_to_place,
                    client_order_id=coid,
                    time_in_force="immediate_or_cancel",
                )
                if order:
                    order_id = order.get("order_id")
                    order_status = order.get("status", "submitted")
                    fill = parse_count(order.get("fill_count_fp"))
                    if fill <= 0:
                        log.info(f"  LIVE IOC unfilled for {ticker}, skipping")
                        return
                    shares = fill
                    cost_dollars = shares * cost_per
                else:
                    log.warning(f"  LIVE order failed for {ticker}, skipping")
                    return
            except Exception as e:
                log.warning(f"  LIVE order error for {ticker}: {e}")
                return

        self.bankroll -= cost_dollars
        self.total_fees += fee_per * shares
        self.total_snipes += 1

        market_key = f"kalshi-btc-{event_ticker}"
        self.market_stats.setdefault(market_key, {"trades": 0, "wins": 0, "pnl": 0.0})

        window_id = f"kalshi-snipe-{event_ticker}-{ticker}"
        model_name = f"kalshi_{stage}_{conviction}"

        pending = PendingKalshiTrade(
            window_id=window_id,
            event_ticker=event_ticker,
            market_ticker=ticker,
            side=side,
            entry_price=winner_price,
            fee=fee_per * shares,
            shares=shares,
            total_cost=cost_per,
            stage=stage,
            conviction=conviction,
            strike=strike,
            spot_at_entry=spot,
            strike_type=stype,
            close_ts=close_ts,
            kalshi_order_id=order_id,
            order_status=order_status,
        )
        self.pending.append(pending)
        self.fired.add(key)

        sizing_tag = (
            f"kelly p={sizing_info['p']:.2f} q={sizing_info['q']:.2f} "
            f"f={sizing_info.get('kelly_f', 0):.2f} n={sizing_info.get('n', 0)}"
            if sizing_mode == "kelly" else f"conviction {conviction}"
        )
        mode_tag = "LIVE" if order_status != "paper" else "PAPER"
        log.info(
            f"  [{stage.upper()} {event_ticker} {ticker}] {mode_tag} BOUGHT {side} "
            f"@ {winner_price:.3f} | ${cost_dollars:.2f} "
            f"(strike=${strike:,.0f}, spot=${spot:,.0f}, dist=${distance:,.0f}) "
            f"({sizing_tag}, close in {secs_to_close:.0f}s) | "
            f"bank(committed)=${self.bankroll:.2f}"
        )

        self._push_event({
            "ts": time.time(), "kind": "FIRE", "stage": stage,
            "market": market_key, "ticker": ticker, "side": side,
            "price": winner_price, "size": cost_dollars,
            "conviction": conviction, "strike": strike, "spot": spot,
            "distance": distance, "secs_to_close": secs_to_close,
            "sizing_mode": sizing_mode, "sizing_info": sizing_info,
            "order_id": order_id, "order_status": order_status,
            "pnl": 0.0, "bankroll": self.bankroll,
        })

        with get_db(self.db_path) as conn:
            save_live_trade(
                conn, window_id, side, model_name,
                1.0, winner_price, 1.0 - winner_price, winner_price,
                fee_per * shares, shares, self.bankroll,
            )

    # ----------------------------------------------------------
    # Non-blocking resolution
    # ----------------------------------------------------------

    def resolve_pending(self):
        if not self.pending:
            return
        now = time.time()
        remaining: List[PendingKalshiTrade] = []
        for p in self.pending:
            # Only poll after close
            if now < p.close_ts - 2:
                remaining.append(p)
                continue

            outcome = self.feed.check_result(p.market_ticker)
            if outcome == -1:
                if now > p.close_ts + self.config.resolution_deadline_s:
                    loss = -p.shares * p.total_cost
                    self.total_pnl += loss
                    log.warning(
                        f"  DROPPED {p.market_ticker} - no resolution in "
                        f"{self.config.resolution_deadline_s}s"
                    )
                    with get_db(self.db_path) as conn:
                        resolve_trade(conn, p.window_id, -1, loss, self.bankroll)
                        log_event(conn, f"DROPPED: {p.window_id}")
                    continue
                remaining.append(p)
                continue

            self.settle_trade(p, outcome)

        self.pending = remaining

    def settle_trade(self, p: PendingKalshiTrade, outcome: int):
        won = ((p.side == "YES" and outcome == 1) or
               (p.side == "NO" and outcome == 0))
        payout = p.shares * 1.0 if won else 0.0
        committed_cost = p.shares * p.total_cost
        pnl = payout - committed_cost
        self.bankroll += payout
        self.peak_bankroll = max(self.peak_bankroll, self.bankroll)

        self.total_pnl += pnl
        if won:
            self.total_wins += 1

        st = self.stage_stats.get(p.stage)
        if st:
            st["trades"] += 1
            if won:
                st["wins"] += 1
            st["pnl"] += pnl
        cv = self.conviction_stats.get(p.conviction)
        if cv:
            cv["trades"] += 1
            if won:
                cv["wins"] += 1
            cv["pnl"] += pnl
        bk = self.bucket_stats.get((p.stage, p.conviction))
        if bk:
            bk["trades"] += 1
            if won:
                bk["wins"] += 1
            bk["pnl"] += pnl
        mk = f"kalshi-btc-{p.event_ticker}"
        m = self.market_stats.setdefault(mk, {"trades": 0, "wins": 0, "pnl": 0.0})
        m["trades"] += 1
        if won:
            m["wins"] += 1
        m["pnl"] += pnl

        wr = (self.total_wins / self.total_snipes * 100) if self.total_snipes else 0
        tag = "WIN " if won else "LOSS"
        log.info(
            f"  [{p.stage.upper()} {p.market_ticker}] {tag} {p.side} @ "
            f"{p.entry_price:.3f} | PnL ${pnl:+.2f} | Bank ${self.bankroll:.2f} | "
            f"WR {wr:.1f}% [{self.total_wins}W/{self.total_snipes - self.total_wins}L]"
        )
        self._push_event({
            "ts": time.time(), "kind": "WIN" if won else "LOSS",
            "stage": p.stage, "market": mk, "ticker": p.market_ticker,
            "side": p.side, "price": p.entry_price,
            "size": p.shares * p.total_cost, "conviction": p.conviction,
            "strike": p.strike, "spot": p.spot_at_entry,
            "pnl": pnl, "bankroll": self.bankroll,
        })

        with get_db(self.db_path) as conn:
            resolve_trade(conn, p.window_id, outcome, pnl, self.bankroll)

    # ----------------------------------------------------------
    # Event ring buffer
    # ----------------------------------------------------------

    def _push_event(self, ev: dict):
        self.events.append(ev)
        if len(self.events) > self._events_cap:
            self.events = self.events[-self._events_cap:]

    # ----------------------------------------------------------
    # Main loop
    # ----------------------------------------------------------

    def run(self, max_hours: Optional[float] = None):
        init_db(self.db_path)

        btc = self.feed.get_price("btc")
        with get_db(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO session_stats
                (session_start, last_update, bankroll, peak_bankroll, config_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    time.time(), time.time(), self.bankroll, self.bankroll,
                    json.dumps({
                        "mode": "kalshi_snipe_v1",
                        "live": self.live,
                        "demo": self.feed.is_demo,
                        "btc_start": btc,
                    }),
                ),
            )
            log_event(
                conn,
                f"Kalshi snipe trader started: "
                f"live={self.live}, demo={self.feed.is_demo}, bankroll=${self.bankroll:.2f}"
            )

        start_time = time.time()
        last_summary_ts = start_time

        log.info("")
        log.info("=" * 70)
        log.info("  SATRIALES KALSHI BTC SNIPE TRADER")
        log.info(f"  Mode: {'LIVE' if self.live else 'PAPER'}"
                 f"{' (demo)' if self.feed.is_demo else ' (production market data)'}")
        log.info("=" * 70)
        log.info(f"  Bankroll:       ${self.bankroll:.2f}")
        log.info(f"  BTC spot:       ${btc:,.2f}")
        log.info(f"  Stage windows:  prime<={self.config.prime_time_to_close_s}s, "
                 f"late<={self.config.late_time_to_close_s}s, "
                 f"wide<={self.config.max_time_to_close_s}s")
        log.info(f"  Distance gates: weak>=${self.config.dist_weak:.0f}, "
                 f"medium>=${self.config.dist_medium:.0f}, "
                 f"strong>=${self.config.dist_strong:.0f}")
        log.info(f"  Price gates:    {self.config.gate_min:.2f}..{self.config.gate_max:.2f}")
        log.info(f"  Kelly:          {'ON' if self.config.use_kelly else 'OFF'} "
                 f"(half-Kelly, min_p={self.config.kelly_min_p:.2f})")
        log.info(f"  Max hours:      {max_hours or 'unlimited'}")
        log.info("=" * 70)

        try:
            while True:
                if self.should_stop:
                    log.info("Stop signal received; exiting")
                    break
                if max_hours and (time.time() - start_time) / 3600 > max_hours:
                    log.info(f"Time limit reached ({max_hours}h)")
                    break

                if self.bankroll < self.config.min_bankroll and not self.pending:
                    self.bust_count += 1
                    log.warning(f"BUST #{self.bust_count}! Bank: ${self.bankroll:.2f}")
                    with get_db(self.db_path) as conn:
                        log_event(conn, f"BUST #{self.bust_count}")
                    self.bankroll = self.config.initial_bankroll
                    self.peak_bankroll = self.config.initial_bankroll

                if not self.paused:
                    self.scan_all()
                self.resolve_pending()

                # GC old fired keys (events >2h past are irrelevant)
                # Kalshi events close at concrete timestamps, so key (event, market, stage)
                # persists until we GC. Use fired_ts tracking via indirect lookup.
                # For simplicity: clear anything for events we no longer see in the
                # live list, as long as no pending trade depends on it.
                live_events = {e.get("event_ticker") for e in self.feed.get_live_btc_events()}
                pending_events = {p.event_ticker for p in self.pending}
                self.fired = {
                    k for k in self.fired
                    if k[0] in live_events or k[0] in pending_events
                }

                # Flush session stats
                with get_db(self.db_path) as conn:
                    dd_pct = (
                        (self.peak_bankroll - self.bankroll) / self.peak_bankroll
                        if self.peak_bankroll > 0 else 0
                    )
                    conn.execute(
                        """
                        UPDATE session_stats SET
                            last_update = ?, trades_executed = ?, trades_won = ?,
                            total_pnl = ?, total_fees = ?,
                            bankroll = ?, peak_bankroll = ?, max_drawdown_pct = ?
                        WHERE id = (SELECT MAX(id) FROM session_stats)
                        """,
                        (
                            time.time(), self.total_snipes, self.total_wins,
                            self.total_pnl, self.total_fees,
                            self.bankroll, self.peak_bankroll, dd_pct,
                        ),
                    )

                if time.time() - last_summary_ts > 300:
                    self._print_summary(start_time)
                    last_summary_ts = time.time()

                time.sleep(self.config.poll_interval)

        except KeyboardInterrupt:
            log.info("\nStopped by user")

        drain_deadline = time.time() + self.drain_timeout_s
        log.info(f"\nDraining {len(self.pending)} pending snipes "
                 f"(up to {self.drain_timeout_s}s)...")
        while self.pending and time.time() < drain_deadline and not self.should_stop:
            self.resolve_pending()
            time.sleep(3)

        self._print_summary(start_time)

    def _print_summary(self, start_time: float):
        elapsed_h = (time.time() - start_time) / 3600
        pending_ct = len(self.pending)
        resolved = self.total_snipes - pending_ct
        losses = max(0, resolved - self.total_wins)
        wr = (self.total_wins / resolved * 100) if resolved else 0.0
        roi = ((self.bankroll - self.config.initial_bankroll) /
               self.config.initial_bankroll * 100) if self.config.initial_bankroll else 0
        log.info("")
        log.info("=" * 70)
        log.info(f"  SUMMARY - {elapsed_h:.2f}h elapsed")
        log.info(f"  Bankroll:      ${self.bankroll:.2f} "
                 f"(peak ${self.peak_bankroll:.2f}, ROI {roi:+.1f}%)")
        log.info(f"  Snipes placed: {self.total_snipes}  "
                 f"(resolved {resolved}, pending {pending_ct})")
        log.info(f"  Resolved W/L:  {self.total_wins}/{losses}  "
                 f"WR: {wr:.1f}%" +
                 ("  [N/A - nothing settled yet]" if not resolved else ""))
        log.info(f"  PnL:           ${self.total_pnl:+.2f}  "
                 f"(fees ${self.total_fees:.2f})")
        for stage, s in self.stage_stats.items():
            if s["trades"]:
                w_rate = s["wins"] / s["trades"] * 100
                log.info(f"    {stage:6}  {s['trades']:3d} trades  "
                         f"{w_rate:5.1f}% WR  ${s['pnl']:+.2f} PnL")
        log.info("=" * 70)


# ============================================================
# CLI entry
# ============================================================

def build_hunter(args) -> KalshiSnipeHunter:
    config = KalshiSnipeConfig(initial_bankroll=args.bankroll)

    creds = None
    order_client = None

    if args.live:
        creds = KalshiCredentials.from_env()
        if not creds:
            log.error(
                "--live requested but credentials missing. Set "
                "KALSHI_KEY_ID and either KALSHI_PRIVATE_KEY or "
                "KALSHI_PRIVATE_KEY_PATH."
            )
            sys.exit(2)
        feed = KalshiFeed(demo=args.demo, credentials=creds)
        order_client = KalshiOrderClient(feed)
        # Safety: verify balance + ping before trading
        try:
            bal = order_client.get_balance_dollars()
            log.info(f"  Kalshi live balance: ${bal:,.2f} "
                     f"(env={feed.environment if hasattr(feed,'environment') else 'prod'})")
            if bal < config.initial_bankroll:
                log.warning(
                    f"  Bankroll config says ${config.initial_bankroll:.2f} "
                    f"but Kalshi balance is ${bal:.2f} - using Kalshi balance."
                )
                config.initial_bankroll = bal
        except Exception as e:
            log.error(f"  Could not verify Kalshi auth/balance: {e}")
            sys.exit(3)
    else:
        feed = KalshiFeed(demo=args.demo)

    db_path = args.db
    return KalshiSnipeHunter(
        config=config, db_path=db_path, feed=feed,
        order_client=order_client, live=args.live,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Kalshi BTC Snipe Trader (paper by default, --live to trade real money)"
    )
    parser.add_argument("--hours", type=float, default=None,
                        help="Max run duration (default: unlimited)")
    parser.add_argument("--bankroll", type=float, default=20.0,
                        help="Starting bankroll in dollars")
    parser.add_argument("--db", default=os.path.join(
                        os.path.dirname(__file__), "kalshi_snipe.db"),
                        help="SQLite path for trades/events")
    parser.add_argument("--demo", action="store_true",
                        help="Use Kalshi DEMO environment (authenticated, sandboxed)")
    parser.add_argument("--live", action="store_true",
                        help="PLACE REAL ORDERS (requires KALSHI_KEY_ID + PEM)")
    args = parser.parse_args()

    if args.live:
        print(
            "\n" + "!"*70 +
            "\n  LIVE MODE - real orders will be placed on Kalshi. "
            f"Environment: {'DEMO' if args.demo else 'PRODUCTION'}"
            "\n  Press Ctrl+C within 5 seconds to abort.\n" + "!"*70
        )
        time.sleep(5)

    hunter = build_hunter(args)
    hunter.run(max_hours=args.hours)


if __name__ == "__main__":
    main()
