"""
Deeper probe of Kalshi BTC market cadence + near-the-money strikes.
Goal: confirm whether the snipe thesis works here.

Prints:
  - All open BTC events sorted by strike time
  - For each event: the 10 strikes nearest to current spot, with
    yes bid/ask and a mark-to-intrinsic diff (how stale is the book)
  - Highlights any strikes where spot has clearly cleared the strike
    but YES ask is still < $0.95 — those are live snipes
"""

from datetime import datetime, timezone
from kalshi_feed import KalshiFeed, parse_dollars, parse_count


def fmt_time(iso_str):
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        delta_min = int((dt - now).total_seconds() / 60)
        return f"{dt.strftime('%m-%d %H:%MZ')} ({delta_min:+d}m)"
    except Exception:
        return iso_str or "?"


def main():
    feed = KalshiFeed(demo=False)
    spot = feed.get_price("btc")
    print(f"\n=== KALSHI BTC PROBE ===")
    print(f"Binance BTC spot: ${spot:,.2f}\n")

    events = feed.get_live_btc_events()
    # Sort by strike_date
    def event_strike_ts(ev):
        try:
            return datetime.fromisoformat(
                ev["strike_date"].replace("Z", "+00:00")
            ).timestamp()
        except Exception:
            return 1e18

    events.sort(key=event_strike_ts)

    print(f"Found {len(events)} live BTC events:\n")
    for ev in events:
        title = ev.get("title", "")[:60]
        strike_iso = ev.get("strike_date", "")
        ticker = ev.get("event_ticker", "")
        series = ev.get("series_ticker", "")
        mkts = ev.get("markets") or []
        total_oi = sum(parse_count(m.get("open_interest_fp")) for m in mkts)
        total_vol = sum(parse_count(m.get("volume_24h_fp")) for m in mkts)
        print(
            f"  [{series:8}] {ticker:22} | "
            f"close={fmt_time(strike_iso):25} | "
            f"{len(mkts):3d} strikes | "
            f"OI=${total_oi:>8,.0f} | vol24h=${total_vol:>8,.0f}"
        )
        print(f"           {title}")

    # Pick the two nearest events and look at strikes around spot
    for ev in events[:2]:
        ticker = ev.get("event_ticker", "")
        mkts = ev.get("markets") or []
        if not mkts:
            continue

        print(f"\n--- {ticker}: strikes near spot ${spot:,.0f} ---")
        # Sort markets by strike distance from spot
        scored = []
        for m in mkts:
            strike = feed.get_strike_price(m)
            if strike is None:
                continue
            scored.append((abs(strike - spot), strike, m))
        scored.sort()

        print(f"  {'TICKER':44} {'STRIKE':>10} {'TYPE':>8}  "
              f"{'YES_BID':>8} {'YES_ASK':>8} {'OI':>6}  INTRINSIC  SNIPE?")
        for _, strike, m in scored[:20]:
            ticker_m = m.get("ticker", "")
            stype = feed.get_strike_type(m)
            yb = parse_dollars(m.get("yes_bid_dollars"))
            ya = parse_dollars(m.get("yes_ask_dollars"))
            oi = parse_count(m.get("open_interest_fp"))

            # Intrinsic value: 1 if spot already satisfies the strike, 0 if not.
            # For 'greater' strike T$X: intrinsic=1 if spot > X.
            # For 'between' strike B$center (±$250 typical): intrinsic=1 if |spot-center|<250.
            intrinsic = None
            if stype == "greater":
                intrinsic = 1.0 if spot > strike else 0.0
            elif stype == "less":
                intrinsic = 1.0 if spot < strike else 0.0
            elif stype == "between":
                # Without explicit floor/cap, assume $500 width centered on ticker number
                floor = m.get("floor_strike")
                cap = m.get("cap_strike")
                if floor is not None and cap is not None:
                    intrinsic = 1.0 if float(floor) <= spot <= float(cap) else 0.0
                else:
                    intrinsic = 1.0 if abs(spot - strike) < 250 else 0.0

            # Snipe flag: intrinsic=1 but ask below $0.95
            snipe_flag = ""
            if intrinsic is not None:
                if intrinsic == 1.0 and ya <= 0.95 and ya > 0.0:
                    snipe_flag = f"YES+{(1.0 - ya)*100:.0f}%"
                elif intrinsic == 0.0 and (1.0 - yb) <= 0.95 and yb > 0.0:
                    # Symmetric: NO is the winner, and NO ask = 1-yes_bid
                    snipe_flag = f"NO +{yb*100:.0f}%"

            intrinsic_str = f"{intrinsic:.0f}" if intrinsic is not None else "?"
            print(
                f"  {ticker_m:44} {strike:>10,.0f} {stype:>8}  "
                f"{yb:>8.3f} {ya:>8.3f} {oi:>6.0f}  "
                f"{intrinsic_str:>9}  {snipe_flag}"
            )

    print()


if __name__ == "__main__":
    main()
