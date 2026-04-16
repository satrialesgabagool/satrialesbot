"""
Kalshi API client for the Satriales BTC snipe bot.

Two responsibilities:
  1. KalshiFeed — read-only market data (events, markets, order books).
     Mirrors PolymarketFeed's API so snipe_trader code can switch over
     with minimal changes.
  2. KalshiCredentials + signing — optional, only needed when we switch
     from paper to real order placement. Private key is RSA, signing is
     RSA-PSS per Kalshi's auth spec. Matches the TypeScript implementation
     in src/kalshi/KalshiAuth.ts.

No external deps beyond `requests` (and `cryptography` for signing when
credentials are provided). If `cryptography` isn't installed, the feed
still works for read-only market data — signing is lazily initialized.

BTC market structure on Kalshi (verified 2026-04-15):
  - KXBTCD  series: strike-based "BTC > $X at close". Daily close 5pm EDT.
    High liquidity ($734k OI, $601k 24h vol as of survey). Strikes every
    $500. Settles against CME-referenced price.
  - KXBTC   series: range brackets "BTC between $X and $Y". Same 5pm EDT
    daily close. Thinner ($147k OI).
  - No sub-daily BTC markets on Kalshi at time of survey.

This means the snipe thesis shifts from 5-min post-close to the final
30-60 minutes before the daily settlement. The bot watches spot vs.
strike price — when spot has clearly cleared (or missed) a strike and
Kalshi's YES is still asking below $0.95, that's the snipe.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests

log = logging.getLogger("kalshi_feed")


# ============================================================
# Constants
# ============================================================

PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2"
DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2"

# Series tickers we care about. Empirically verified (2026-04-15) that
# KXBTCD + KXBTC are the only active BTC series. Scan these for live events.
BTC_SERIES = ["KXBTCD", "KXBTC"]


# ============================================================
# Credentials (lazy — only needed for authenticated endpoints)
# ============================================================

@dataclass
class KalshiCredentials:
    """Kalshi API credentials. See https://trading-api.readme.io/reference/"""
    key_id: str
    private_key_pem: str  # RSA private key, PEM-encoded

    @classmethod
    def from_env(cls) -> Optional["KalshiCredentials"]:
        """
        Load from environment:
          KALSHI_KEY_ID        — your key ID (UUID)
          KALSHI_PRIVATE_KEY   — private key PEM (with newlines as \\n)
          KALSHI_PRIVATE_KEY_PATH — or a path to a PEM file
        """
        key_id = os.environ.get("KALSHI_KEY_ID")
        if not key_id:
            return None
        pem = os.environ.get("KALSHI_PRIVATE_KEY")
        if pem:
            # Allow \n-escaped form
            pem = pem.replace("\\n", "\n")
        else:
            path = os.environ.get("KALSHI_PRIVATE_KEY_PATH")
            if path and os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    pem = f.read()
        if not pem:
            return None
        return cls(key_id=key_id, private_key_pem=pem)


def _sign_request(creds: KalshiCredentials, method: str, api_path: str) -> Dict[str, str]:
    """
    Produce Kalshi auth headers for a given request.

    Kalshi spec: sign "<timestamp_ms><METHOD><api_path>" with RSA-PSS/SHA256.
    api_path starts with "/trade-api/v2".
    """
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError as e:
        raise RuntimeError(
            "cryptography package required for Kalshi auth — "
            "install with `pip install cryptography`"
        ) from e

    ts_ms = str(int(time.time() * 1000))
    message = (ts_ms + method.upper() + api_path).encode("utf-8")

    priv = serialization.load_pem_private_key(
        creds.private_key_pem.encode("utf-8"), password=None
    )
    sig = priv.sign(
        message,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
        hashes.SHA256(),
    )
    sig_b64 = base64.b64encode(sig).decode("ascii")

    return {
        "KALSHI-ACCESS-KEY": creds.key_id,
        "KALSHI-ACCESS-TIMESTAMP": ts_ms,
        "KALSHI-ACCESS-SIGNATURE": sig_b64,
    }


# ============================================================
# Kalshi Feed — BTC snipe-focused read layer
# ============================================================

def parse_dollars(s: Any) -> float:
    """Parse FixedPointDollars string ('0.5600') to float. Safe on None/bad input."""
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def parse_count(s: Any) -> float:
    """Parse FixedPointCount string to float."""
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


class KalshiFeed:
    """
    Read-only Kalshi market feed plus Binance spot for BTC.

    Cache policy mirrors PolymarketFeed: 3-second TTL on per-event market
    data so the hunter can poll aggressively without hammering the API.
    """

    BINANCE_US = "https://api.binance.us/api/v3"

    def __init__(
        self,
        demo: bool = False,
        credentials: Optional[KalshiCredentials] = None,
        timeout: float = 10.0,
    ):
        self.base_url = DEMO_BASE if demo else PROD_BASE
        self.creds = credentials
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Satriales-KalshiFeed/1.0"

        # Caches
        self._last_price: Dict[str, float] = {}
        # Event ticker -> (fetched_at, event dict with nested markets)
        self._event_cache: Dict[str, Tuple[float, Optional[dict]]] = {}
        self._event_cache_ttl = 3.0
        # Series -> (fetched_at, list of live events)
        self._series_cache: Dict[str, Tuple[float, List[dict]]] = {}
        self._series_cache_ttl = 30.0  # event set changes slowly

    # -------- HTTP helpers --------

    @property
    def is_demo(self) -> bool:
        return self.base_url == DEMO_BASE

    @property
    def is_authenticated(self) -> bool:
        return self.creds is not None

    def _request(
        self, method: str, path: str, body: Any = None, require_auth: bool = False
    ) -> Optional[dict]:
        if require_auth and not self.creds:
            raise RuntimeError("Kalshi credentials required for this endpoint")
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.creds:
            api_path = f"/trade-api/v2{path.split('?', 1)[0]}"
            headers.update(_sign_request(self.creds, method, api_path))
        try:
            kwargs = {"headers": headers, "timeout": self.timeout}
            if body is not None:
                kwargs["data"] = json.dumps(body)
            resp = self.session.request(method, url, **kwargs)
        except requests.RequestException as e:
            log.warning(f"Kalshi {method} {path}: network error {e}")
            return None
        if not resp.ok:
            # 404 is fine for series probes; log higher-level codes only
            if resp.status_code >= 500:
                log.warning(f"Kalshi {method} {path}: {resp.status_code} {resp.text[:120]}")
            return None
        try:
            return resp.json()
        except ValueError:
            return None

    # -------- Public market data --------

    def get_live_btc_events(self, force: bool = False) -> List[dict]:
        """
        Return the current OPEN BTC events, with nested markets. Aggregates
        KXBTCD + KXBTC. Cached for 30s.
        """
        out: List[dict] = []
        now = time.time()
        for series in BTC_SERIES:
            cached = self._series_cache.get(series)
            if not force and cached and (now - cached[0]) < self._series_cache_ttl:
                out.extend(cached[1])
                continue
            data = self._request(
                "GET",
                f"/events?series_ticker={series}&status=open&with_nested_markets=true&limit=50",
            )
            events = (data or {}).get("events", []) or []
            self._series_cache[series] = (now, events)
            out.extend(events)
        return out

    def get_event(self, event_ticker: str) -> Optional[dict]:
        """Fetch one event with nested markets. Cached 3s."""
        now = time.time()
        cached = self._event_cache.get(event_ticker)
        if cached and (now - cached[0]) < self._event_cache_ttl:
            return cached[1]
        data = self._request(
            "GET",
            f"/events/{event_ticker}?with_nested_markets=true",
        )
        ev = (data or {}).get("event") if data else None
        self._event_cache[event_ticker] = (now, ev)
        return ev

    def get_market(self, ticker: str) -> Optional[dict]:
        """Fetch a single market (no cache — callers cache at event level)."""
        data = self._request("GET", f"/markets/{ticker}")
        return (data or {}).get("market") if data else None

    def get_orderbook(self, ticker: str, depth: int = 5) -> Optional[dict]:
        """
        Get YES/NO order book. Kalshi requires auth for this — silently
        returns None if we're unauthenticated.
        """
        if not self.creds:
            return None
        data = self._request(
            "GET", f"/markets/{ticker}/orderbook?depth={depth}", require_auth=True
        )
        return (data or {}).get("orderbook") if data else None

    # -------- BTC-specific helpers --------

    def pick_primary_event(self, events: List[dict]) -> Optional[dict]:
        """
        Choose the "primary" BTC event for sniping — the open event with the
        nearest strike_date. Prefer KXBTCD over KXBTC when both resolve at
        the same time (KXBTCD has much deeper liquidity).
        """
        scored: List[Tuple[float, int, dict]] = []
        now = time.time()
        for ev in events:
            strike_iso = ev.get("strike_date")
            if not strike_iso:
                continue
            try:
                from datetime import datetime
                t = datetime.fromisoformat(strike_iso.replace("Z", "+00:00")).timestamp()
            except Exception:
                continue
            dt = t - now
            if dt < 0:
                continue  # expired
            # Prefer KXBTCD: if ties on strike, KXBTCD wins via priority 0
            priority = 0 if ev.get("series_ticker") == "KXBTCD" else 1
            scored.append((dt, priority, ev))
        if not scored:
            return None
        # Sort by (time_to_strike, priority) — closest strike first, KXBTCD ties
        scored.sort(key=lambda x: (x[0], x[1]))
        return scored[0][2]

    def get_primary_event(self) -> Optional[dict]:
        """Convenience: live BTC events → pick primary."""
        events = self.get_live_btc_events()
        return self.pick_primary_event(events)

    def get_strike_price(self, market: dict) -> Optional[float]:
        """
        Extract the strike price for a KXBTCD market ticker.
        Format: KXBTCD-26APR1717-T58999.99 → 58999.99 (greater-than)
                KXBTC-26APR1717-B61750     → 61750  (between bucket center)
        """
        ticker = market.get("ticker", "")
        try:
            last = ticker.rsplit("-", 1)[-1]
            prefix = last[0]
            num = last[1:]
            strike = float(num)
            return strike
        except (ValueError, IndexError):
            # Fall back to explicit floor/cap
            floor = market.get("floor_strike")
            cap = market.get("cap_strike")
            if floor is not None and cap is not None:
                return (float(floor) + float(cap)) / 2.0
            return floor if floor is not None else cap

    def get_strike_type(self, market: dict) -> str:
        """
        Return 'greater' | 'less' | 'between' | 'other'.
        Uses explicit strike_type if present; falls back to ticker prefix.
        """
        st = market.get("strike_type")
        if st:
            return st
        ticker = market.get("ticker", "")
        last = ticker.rsplit("-", 1)[-1]
        if not last:
            return "other"
        p = last[0]
        if p == "T":
            return "greater"
        if p == "B":
            return "between"
        if p == "L":
            return "less"
        return "other"

    # -------- Binance spot (reused from PolymarketFeed pattern) --------

    def get_price(self, asset: str = "btc") -> float:
        """BTC spot from Binance US. Caches last good value on failure."""
        symbol = "BTCUSDT" if asset == "btc" else "ETHUSDT"
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/ticker/price",
                params={"symbol": symbol},
                timeout=8,
            )
            if r.ok:
                price = float(r.json()["price"])
                self._last_price[asset] = price
                return price
        except Exception:
            pass
        return self._last_price.get(asset, 0.0)

    def get_spot_at_epoch(self, asset: str, epoch_ts: int) -> float:
        """Binance 1-min kline OPEN at epoch_ts. Used for window-move calc."""
        symbol = "BTCUSDT" if asset == "btc" else "ETHUSDT"
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/klines",
                params={
                    "symbol": symbol,
                    "interval": "1m",
                    "startTime": epoch_ts * 1000,
                    "limit": 1,
                },
                timeout=8,
            )
            if r.ok:
                data = r.json()
                if data:
                    return float(data[0][1])
        except Exception:
            pass
        return 0.0

    # -------- Market resolution check --------

    def check_result(self, market_ticker: str) -> int:
        """
        Return 1 (YES won), 0 (NO won), -1 (not yet resolved / unknown).
        Reads `result` + `status` from /markets/{ticker}.
        """
        m = self.get_market(market_ticker)
        if not m:
            return -1
        status = (m.get("status") or "").lower()
        if status not in ("settled", "finalized", "determined"):
            return -1
        result = (m.get("result") or "").lower()
        if result == "yes":
            return 1
        if result == "no":
            return 0
        return -1


# ============================================================
# Authenticated order placement (real exec — OFF by default)
# ============================================================

class KalshiOrderClient:
    """
    Thin wrapper around KalshiFeed for order placement + portfolio.
    Requires credentials. For safety, defaults to demo environment.

    NOT CALLED BY THE SNIPE BOT BY DEFAULT. The bot runs in paper mode
    until the operator explicitly wires this in. See kalshi_snipe_trader.py
    `--live` flag.
    """

    def __init__(self, feed: KalshiFeed):
        if not feed.is_authenticated:
            raise RuntimeError("KalshiOrderClient requires authenticated KalshiFeed")
        self.feed = feed

    def place_limit_buy(
        self,
        ticker: str,
        side: str,              # "yes" | "no"
        count: int,
        price_dollars: float,   # e.g. 0.95
        client_order_id: Optional[str] = None,
        time_in_force: str = "immediate_or_cancel",
    ) -> Optional[dict]:
        """
        Place a LIMIT BUY order. Matches the createOrder contract from the
        TypeScript KalshiClient.

        IOC by default so a miss doesn't leave a resting order we forgot about.
        """
        body = {
            "ticker": ticker,
            "side": side,
            "action": "buy",
            "count": int(count),
            "time_in_force": time_in_force,
        }
        price_str = f"{price_dollars:.4f}"
        if side == "yes":
            body["yes_price_dollars"] = price_str
        else:
            body["no_price_dollars"] = price_str
        if client_order_id:
            body["client_order_id"] = client_order_id
        data = self.feed._request(
            "POST", "/portfolio/orders", body=body, require_auth=True
        )
        return (data or {}).get("order") if data else None

    def cancel(self, order_id: str) -> bool:
        try:
            self.feed._request(
                "DELETE",
                f"/portfolio/orders/{order_id}",
                require_auth=True,
            )
            return True
        except Exception as e:
            log.warning(f"cancel({order_id}) failed: {e}")
            return False

    def get_balance_dollars(self) -> float:
        data = self.feed._request("GET", "/portfolio/balance", require_auth=True)
        if not data:
            return 0.0
        cents = data.get("balance", 0) or 0
        return float(cents) / 100.0

    def get_positions(self) -> List[dict]:
        data = self.feed._request("GET", "/portfolio/positions", require_auth=True)
        if not data:
            return []
        return data.get("market_positions", []) or []


# ============================================================
# Smoke test
# ============================================================

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    print("Testing KalshiFeed (read-only, no auth)...")
    feed = KalshiFeed(demo=False)
    print(f"  BTC spot (Binance US): ${feed.get_price('btc'):,.2f}")

    events = feed.get_live_btc_events()
    print(f"  Live BTC events: {len(events)}")
    primary = feed.pick_primary_event(events)
    if primary:
        print(f"  Primary: {primary['event_ticker']} — {primary.get('title', '')}")
        print(f"    strike_date: {primary.get('strike_date')}")
        mkts = primary.get("markets") or []
        print(f"    {len(mkts)} markets")
        for m in mkts[:5]:
            strike = feed.get_strike_price(m)
            stype = feed.get_strike_type(m)
            yb = parse_dollars(m.get("yes_bid_dollars"))
            ya = parse_dollars(m.get("yes_ask_dollars"))
            print(f"    {m['ticker']:42}  strike=${strike:,.2f} [{stype}]  yes={yb:.2f}/{ya:.2f}")
