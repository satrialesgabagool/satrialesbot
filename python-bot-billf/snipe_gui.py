"""
Satriales Snipe Trader — Desktop GUI.

A single-window tkinter dashboard that runs the SnipeHunter in a background
thread and shows live trading state with charts and tables.

Launched by START_TRADER.bat.
Run directly:
    python snipe_gui.py [--hours N] [--assets btc,eth] [--bankroll 20]

Layout:
  +----------------------------------------------------------------+
  |  HEADER: bankroll, PnL, WR, uptime, peak, drawdown            |
  +----------------------------------------------------------------+
  |  ACTIVE MARKETS         |  BANKROLL CURVE                     |
  |  (live poly + spot)     |  (matplotlib line chart)            |
  +----------------------------------------------------------------+
  |  PENDING SNIPES         |  PNL BY STAGE / CONVICTION          |
  |  (entry vs now)         |  (matplotlib bar chart)             |
  +----------------------------------------------------------------+
  |  STATS TABLES           |  RECENT TRADES (event log)          |
  +----------------------------------------------------------------+
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import threading
import time
import tkinter as tk
from datetime import datetime
from tkinter import ttk
from typing import Dict, List, Optional

import matplotlib

matplotlib.use("TkAgg")
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg

# --- bot internals ---
from live_trader import ASSETS, TIMEFRAMES, PolymarketFeed
from snipe_trader import SnipeConfig, SnipeHunter


# ============================================================
# Theme
# ============================================================

THEME = {
    "bg":        "#0f1419",
    "bg_alt":    "#1a2029",
    "bg_card":   "#161b22",
    "fg":        "#e6edf3",
    "fg_mute":   "#8b949e",
    "accent":    "#58a6ff",
    "green":     "#3fb950",
    "green_dim": "#238636",
    "red":       "#f85149",
    "red_dim":   "#da3633",
    "yellow":    "#d29922",
    "border":    "#30363d",
    "grid":      "#21262d",
    "font":      ("Segoe UI", 10),
    "font_mono": ("Consolas", 10),
    "font_big":  ("Segoe UI Semibold", 22),
    "font_h":    ("Segoe UI Semibold", 11),
    "font_small":("Segoe UI", 9),
}


def _apply_theme(root: tk.Tk):
    style = ttk.Style(root)
    style.theme_use("clam")
    t = THEME

    root.configure(bg=t["bg"])
    style.configure(".", background=t["bg"], foreground=t["fg"], font=t["font"])
    style.configure("TFrame", background=t["bg"])
    style.configure("Card.TFrame", background=t["bg_card"], relief="flat")
    style.configure("TLabel", background=t["bg"], foreground=t["fg"])
    style.configure("Card.TLabel", background=t["bg_card"], foreground=t["fg"])
    style.configure("CardH.TLabel", background=t["bg_card"], foreground=t["fg_mute"],
                    font=t["font_h"])
    style.configure("Muted.TLabel", background=t["bg"], foreground=t["fg_mute"])
    style.configure("Big.TLabel", background=t["bg_card"], foreground=t["fg"],
                    font=t["font_big"])
    style.configure("BigGreen.TLabel", background=t["bg_card"], foreground=t["green"],
                    font=t["font_big"])
    style.configure("BigRed.TLabel", background=t["bg_card"], foreground=t["red"],
                    font=t["font_big"])
    style.configure("Green.TLabel", background=t["bg_card"], foreground=t["green"])
    style.configure("Red.TLabel", background=t["bg_card"], foreground=t["red"])

    # Treeview (tables)
    style.configure("Treeview",
                    background=t["bg_card"], fieldbackground=t["bg_card"],
                    foreground=t["fg"], borderwidth=0, rowheight=22,
                    font=t["font_mono"])
    style.configure("Treeview.Heading",
                    background=t["bg_alt"], foreground=t["fg_mute"],
                    font=t["font_h"], borderwidth=0)
    style.map("Treeview",
              background=[("selected", t["bg_alt"])],
              foreground=[("selected", t["fg"])])

    # Buttons
    style.configure("TButton", background=t["bg_alt"], foreground=t["fg"],
                    borderwidth=0, focusthickness=0, padding=(12, 6))
    style.map("TButton",
              background=[("active", t["accent"]), ("pressed", t["accent"])],
              foreground=[("active", t["bg"])])


def _format_money(x: Optional[float], signed: bool = False) -> str:
    if x is None:
        return "--"
    sign = "+" if signed and x >= 0 else ("-" if x < 0 else "")
    return f"{sign}${abs(x):,.2f}"


def _format_pct(x: Optional[float], signed: bool = False, decimals: int = 2) -> str:
    if x is None:
        return "--"
    sign = "+" if signed and x >= 0 else ("-" if x < 0 else "")
    return f"{sign}{abs(x):.{decimals}f}%"


def _format_duration(secs: float) -> str:
    if secs < 0:
        return f"+{int(-secs)}s after"
    if secs < 60:
        return f"{int(secs)}s"
    m, s = divmod(int(secs), 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


# ============================================================
# App
# ============================================================

class SnipeGUI:
    REFRESH_MS = 2000  # 2-second refresh

    def __init__(self, hunter: SnipeHunter, config: SnipeConfig, db_path: str):
        self.hunter = hunter
        self.config = config
        self.db_path = db_path
        self.feed = hunter.feed

        self.root = tk.Tk()
        self.root.title("Satriales Snipe Trader v3")
        self.root.geometry("1400x900")
        self.root.minsize(1200, 760)
        _apply_theme(self.root)

        self.start_time = time.time()
        self._last_event_count = 0

        # Async cache of window-open spot prices. Populated by a background
        # worker so the UI thread never blocks on Binance calls.
        self._spot_open_cache: Dict[tuple, float] = {}
        self._spot_fetch_lock = threading.Lock()
        self._spot_fetch_inflight: set = set()

        self._build_layout()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Start hunter in a daemon thread
        self.hunter_thread = threading.Thread(
            target=self._run_hunter, daemon=True, name="SnipeHunter"
        )
        self.hunter_thread.start()

        # First refresh + schedule
        self.root.after(500, self._refresh)

    # --------------------------------------------------------
    # Layout construction
    # --------------------------------------------------------

    def _build_layout(self):
        root = self.root
        t = THEME

        # 4-row layout: header, row1 (markets + bankroll), row2 (pending + bar), row3 (stats + log)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=2)
        root.rowconfigure(2, weight=2)
        root.rowconfigure(3, weight=3)

        # --- Header ---
        self._build_header(root)

        # --- Row 1 ---
        row1 = ttk.Frame(root, padding=(8, 4))
        row1.grid(row=1, column=0, sticky="nsew")
        row1.columnconfigure(0, weight=2)
        row1.columnconfigure(1, weight=3)
        row1.rowconfigure(0, weight=1)
        self._build_markets_card(row1)
        self._build_bankroll_chart(row1)

        # --- Row 2 ---
        row2 = ttk.Frame(root, padding=(8, 4))
        row2.grid(row=2, column=0, sticky="nsew")
        row2.columnconfigure(0, weight=2)
        row2.columnconfigure(1, weight=3)
        row2.rowconfigure(0, weight=1)
        self._build_pending_card(row2)
        self._build_breakdown_chart(row2)

        # --- Row 3 ---
        row3 = ttk.Frame(root, padding=(8, 4))
        row3.grid(row=3, column=0, sticky="nsew")
        row3.columnconfigure(0, weight=2)
        row3.columnconfigure(1, weight=3)
        row3.rowconfigure(0, weight=1)
        self._build_stats_card(row3)
        self._build_log_card(row3)

    def _card(self, parent, title: str) -> ttk.Frame:
        t = THEME
        outer = ttk.Frame(parent, style="Card.TFrame", padding=(12, 10))
        outer.columnconfigure(0, weight=1)
        head = ttk.Label(outer, text=title.upper(), style="CardH.TLabel")
        head.grid(row=0, column=0, sticky="w", pady=(0, 8))
        return outer

    def _build_header(self, root):
        t = THEME
        header = ttk.Frame(root, style="Card.TFrame", padding=(18, 12))
        header.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 4))
        for c in range(8):
            header.columnconfigure(c, weight=1)

        # Title row
        title = ttk.Label(header, text="Satriales Snipe Trader v3",
                          style="CardH.TLabel",
                          font=("Segoe UI Semibold", 13))
        title.grid(row=0, column=0, columnspan=2, sticky="w")
        self.status_label = ttk.Label(header, text="● RUNNING",
                                      style="Green.TLabel",
                                      font=("Segoe UI Semibold", 10))
        self.status_label.grid(row=0, column=7, sticky="e")

        # Metric row — 6 big cells
        def _mk_metric(col: int, title: str):
            lbl_t = ttk.Label(header, text=title, style="CardH.TLabel",
                              font=("Segoe UI", 9))
            lbl_t.grid(row=1, column=col, sticky="w", pady=(10, 0))
            lbl_v = ttk.Label(header, text="—", style="Big.TLabel")
            lbl_v.grid(row=2, column=col, sticky="w", pady=(0, 0))
            return lbl_v

        self.m_bankroll = _mk_metric(0, "BANKROLL")
        self.m_pnl = _mk_metric(1, "TOTAL P&L")
        self.m_roi = _mk_metric(2, "ROI")
        self.m_wr = _mk_metric(3, "WIN RATE")
        self.m_peak = _mk_metric(4, "PEAK")
        self.m_dd = _mk_metric(5, "DRAWDOWN")
        self.m_trades = _mk_metric(6, "SNIPES")
        self.m_uptime = _mk_metric(7, "UPTIME")

        # Button row
        btn_frame = ttk.Frame(header, style="Card.TFrame")
        btn_frame.grid(row=3, column=0, columnspan=8, sticky="e", pady=(10, 0))
        self.pause_btn = ttk.Button(btn_frame, text="Pause new snipes",
                                    command=self._toggle_pause)
        self.pause_btn.pack(side="right", padx=(8, 0))

    def _build_markets_card(self, parent):
        card = self._card(parent, "Active Markets")
        card.grid(row=0, column=0, sticky="nsew", padx=(4, 4))

        cols = ("market", "spot", "yes", "no", "move", "stage", "ttl")
        tv = ttk.Treeview(card, columns=cols, show="headings", height=6)
        tv.heading("market", text="Market")
        tv.heading("spot",   text="Spot")
        tv.heading("yes",    text="Poly YES")
        tv.heading("no",     text="Poly NO")
        tv.heading("move",   text="Move %")
        tv.heading("stage",  text="Stage")
        tv.heading("ttl",    text="To Close")
        widths = {"market": 100, "spot": 110, "yes": 90, "no": 90,
                  "move": 90, "stage": 100, "ttl": 90}
        for c in cols:
            tv.column(c, width=widths[c], anchor="e" if c != "market" else "w")
        tv.grid(row=1, column=0, sticky="nsew")
        card.rowconfigure(1, weight=1)
        tv.tag_configure("up",   foreground=THEME["green"])
        tv.tag_configure("down", foreground=THEME["red"])
        self.markets_tv = tv

    def _build_bankroll_chart(self, parent):
        card = self._card(parent, "Bankroll Curve")
        card.grid(row=0, column=1, sticky="nsew", padx=(4, 4))
        card.rowconfigure(1, weight=1)

        fig = Figure(figsize=(6, 2.6), dpi=100, facecolor=THEME["bg_card"])
        ax = fig.add_subplot(111)
        self.bankroll_fig = fig
        self.bankroll_ax = ax
        self._style_axes(ax)

        canvas = FigureCanvasTkAgg(fig, master=card)
        canvas.get_tk_widget().grid(row=1, column=0, sticky="nsew")
        self.bankroll_canvas = canvas

    def _build_pending_card(self, parent):
        card = self._card(parent, "Pending Snipes (current bets)")
        card.grid(row=0, column=0, sticky="nsew", padx=(4, 4))

        cols = ("stage", "market", "side", "entry", "now", "unrealized", "ttr")
        tv = ttk.Treeview(card, columns=cols, show="headings", height=6)
        tv.heading("stage",      text="Stage")
        tv.heading("market",     text="Market")
        tv.heading("side",       text="Side")
        tv.heading("entry",      text="Entry")
        tv.heading("now",        text="Poly Now")
        tv.heading("unrealized", text="Unrealized")
        tv.heading("ttr",        text="To Resolve")
        for c, w in (("stage", 100), ("market", 100), ("side", 60),
                     ("entry", 90), ("now", 90), ("unrealized", 110),
                     ("ttr", 100)):
            tv.column(c, width=w, anchor="e" if c not in ("stage", "market", "side") else "w")
        tv.grid(row=1, column=0, sticky="nsew")
        card.rowconfigure(1, weight=1)
        tv.tag_configure("winning", foreground=THEME["green"])
        tv.tag_configure("losing",  foreground=THEME["red"])
        self.pending_tv = tv

    def _build_breakdown_chart(self, parent):
        card = self._card(parent, "P&L by Stage & Conviction")
        card.grid(row=0, column=1, sticky="nsew", padx=(4, 4))
        card.rowconfigure(1, weight=1)

        fig = Figure(figsize=(6, 2.6), dpi=100, facecolor=THEME["bg_card"])
        ax = fig.add_subplot(111)
        self.breakdown_fig = fig
        self.breakdown_ax = ax
        self._style_axes(ax)

        canvas = FigureCanvasTkAgg(fig, master=card)
        canvas.get_tk_widget().grid(row=1, column=0, sticky="nsew")
        self.breakdown_canvas = canvas

    def _build_stats_card(self, parent):
        card = self._card(parent, "Statistics")
        card.grid(row=0, column=0, sticky="nsew", padx=(4, 4))
        card.rowconfigure(1, weight=1)

        cols = ("bucket", "category", "trades", "wr", "pnl")
        tv = ttk.Treeview(card, columns=cols, show="headings", height=12)
        tv.heading("bucket",   text="Bucket")
        tv.heading("category", text="Category")
        tv.heading("trades",   text="Trades")
        tv.heading("wr",       text="WR")
        tv.heading("pnl",      text="P&L")
        for c, w, a in (("bucket", 100, "w"), ("category", 110, "w"),
                        ("trades", 80, "e"), ("wr", 70, "e"), ("pnl", 90, "e")):
            tv.column(c, width=w, anchor=a)
        tv.grid(row=1, column=0, sticky="nsew")
        tv.tag_configure("pos", foreground=THEME["green"])
        tv.tag_configure("neg", foreground=THEME["red"])
        tv.tag_configure("mute", foreground=THEME["fg_mute"])
        self.stats_tv = tv

    def _build_log_card(self, parent):
        card = self._card(parent, "Recent Trades")
        card.grid(row=0, column=1, sticky="nsew", padx=(4, 4))
        card.rowconfigure(1, weight=1)

        frame = ttk.Frame(card, style="Card.TFrame")
        frame.grid(row=1, column=0, sticky="nsew")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

        self.log_text = tk.Text(frame, bg=THEME["bg_card"], fg=THEME["fg"],
                                font=THEME["font_mono"], wrap="none", bd=0,
                                highlightthickness=0, insertbackground=THEME["fg"],
                                state="disabled")
        sb = ttk.Scrollbar(frame, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=sb.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        sb.grid(row=0, column=1, sticky="ns")
        # Tags for color
        self.log_text.tag_configure("win",  foreground=THEME["green"])
        self.log_text.tag_configure("loss", foreground=THEME["red"])
        self.log_text.tag_configure("fire", foreground=THEME["yellow"])
        self.log_text.tag_configure("mute", foreground=THEME["fg_mute"])

    # --------------------------------------------------------
    # Chart styling
    # --------------------------------------------------------

    def _style_axes(self, ax):
        ax.set_facecolor(THEME["bg_card"])
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("bottom", "left"):
            ax.spines[side].set_color(THEME["border"])
        ax.tick_params(colors=THEME["fg_mute"], labelsize=8)
        ax.yaxis.label.set_color(THEME["fg_mute"])
        ax.xaxis.label.set_color(THEME["fg_mute"])
        ax.grid(True, color=THEME["grid"], alpha=0.6, linewidth=0.5)
        ax.title.set_color(THEME["fg"])

    # --------------------------------------------------------
    # Hunter thread
    # --------------------------------------------------------

    def _run_hunter(self):
        # Shorter drain so user doesn't wait 15 min on close
        self.hunter.drain_timeout_s = 20
        try:
            self.hunter.run(max_hours=None)
        except Exception as e:
            print(f"Hunter thread crashed: {e}", file=sys.stderr)

    def _toggle_pause(self):
        self.hunter.paused = not self.hunter.paused
        if self.hunter.paused:
            self.pause_btn.config(text="Resume")
            self.status_label.config(text="● PAUSED", style="Red.TLabel")
        else:
            self.pause_btn.config(text="Pause new snipes")
            self.status_label.config(text="● RUNNING", style="Green.TLabel")

    def _on_close(self):
        self.hunter.should_stop = True
        # Give up to 1 second for graceful stop, then destroy.
        # The hunter thread is a daemon so it'll die with the process anyway.
        self.root.after(1200, self.root.destroy)

    # --------------------------------------------------------
    # Refresh loop
    # --------------------------------------------------------

    def _refresh(self):
        try:
            self._refresh_header()
            self._refresh_markets()
            self._refresh_pending()
            self._refresh_bankroll_chart()
            self._refresh_breakdown_chart()
            self._refresh_stats_table()
            self._refresh_log()
        except Exception as e:
            # Never let a refresh error kill the UI loop
            print(f"Refresh error: {e}", file=sys.stderr)
        finally:
            self.root.after(self.REFRESH_MS, self._refresh)

    def _refresh_header(self):
        h = self.hunter
        t = THEME

        bank = h.bankroll
        peak = h.peak_bankroll
        pnl = h.total_pnl
        roi = (pnl / self.config.initial_bankroll * 100) if self.config.initial_bankroll else 0
        wr = (h.total_wins / h.total_snipes * 100) if h.total_snipes else None
        dd = ((peak - bank) / peak * 100) if peak else 0
        uptime = _format_duration(time.time() - self.start_time)

        self.m_bankroll.config(text=_format_money(bank))
        self.m_bankroll.config(style="BigGreen.TLabel" if bank >= self.config.initial_bankroll
                                     else "BigRed.TLabel")

        self.m_pnl.config(text=_format_money(pnl, signed=True))
        self.m_pnl.config(style="BigGreen.TLabel" if pnl >= 0 else "BigRed.TLabel")

        self.m_roi.config(text=_format_pct(roi, signed=True))
        self.m_roi.config(style="BigGreen.TLabel" if roi >= 0 else "BigRed.TLabel")

        self.m_wr.config(text=f"{wr:.1f}%" if wr is not None else "—")
        self.m_wr.config(style="BigGreen.TLabel" if (wr or 0) >= 55 else
                              ("BigRed.TLabel" if (wr or 100) < 45 else "Big.TLabel"))

        self.m_peak.config(text=_format_money(peak))
        self.m_dd.config(text=_format_pct(dd))
        self.m_dd.config(style="BigRed.TLabel" if dd > 15 else "Big.TLabel")

        self.m_trades.config(text=f"{h.total_snipes} ({h.total_wins}W/{h.total_snipes - h.total_wins}L)")
        self.m_uptime.config(text=uptime)

    def _refresh_markets(self):
        tv = self.markets_tv
        # clear
        for i in tv.get_children():
            tv.delete(i)

        now = int(time.time())
        for asset in self.hunter.assets:
            spot = self.feed._last_price.get(asset, 0.0)
            for tf in self.hunter.timeframes:
                dur = TIMEFRAMES[tf]["duration"]
                active_epoch = self.feed.get_window_epoch(tf, now)
                end = active_epoch + dur
                ttl = end - now

                # Market data from cache
                cache_entry = self.feed._market_cache.get((asset, tf, active_epoch))
                data = cache_entry[1] if cache_entry else None

                yes_p = f"{data['up_price']:.3f}" if data else "—"
                no_p  = f"{data['down_price']:.3f}" if data else "—"

                # Spot move since window open. We read from an async cache
                # populated by a background thread — NEVER do a network call
                # from the UI thread. Cache miss shows "--" for one refresh.
                move_pct = None
                key = (asset, tf, active_epoch)
                open_px = self._spot_open_cache.get(key)
                if open_px is None:
                    self._async_fetch_open(key)
                elif open_px > 0 and spot > 0:
                    move_pct = (spot - open_px) / open_px * 100

                # Determine stage string
                stage = self.hunter.detect_stage(ttl) or "—"

                tags = ()
                move_str = "—"
                if move_pct is not None:
                    move_str = _format_pct(move_pct, signed=True, decimals=3)
                    tags = ("up",) if move_pct > 0 else (("down",) if move_pct < 0 else ())

                ttl_str = _format_duration(ttl)
                tv.insert("", "end", values=(
                    f"{ASSETS[asset]['short']}-{tf}",
                    f"${spot:,.2f}" if spot else "—",
                    yes_p, no_p, move_str, stage, ttl_str,
                ), tags=tags)

    def _refresh_pending(self):
        tv = self.pending_tv
        for i in tv.get_children():
            tv.delete(i)

        now = time.time()
        for p in list(self.hunter.pending):
            dur = TIMEFRAMES[p.timeframe]["duration"]
            ttr = (p.epoch + dur + self.config.resolution_deadline_s) - now

            # Current poly price of the side we bought
            cache_entry = self.feed._market_cache.get((p.asset, p.timeframe, p.epoch))
            data = cache_entry[1] if cache_entry else None
            if data:
                now_price = data["up_price"] if p.side == "YES" else data["down_price"]
            else:
                now_price = None

            # Mark-to-market unrealized PnL (vs total committed cost)
            committed = p.shares * p.total_cost
            unreal = None
            if now_price is not None:
                # If this token is currently trading at X, and we hold p.shares,
                # value is shares * X. Subtract committed to get paper PnL.
                unreal = p.shares * now_price - committed

            # Stage from window_id
            stage = "—"
            if p.window_id.startswith("snipe-v3-"):
                rest = p.window_id[len("snipe-v3-"):]
                for s in ("pre_close", "at_close", "post_close"):
                    if rest.startswith(s + "-"):
                        stage = s
                        break

            tags = ()
            if unreal is not None:
                tags = ("winning",) if unreal > 0 else (("losing",) if unreal < 0 else ())

            tv.insert("", "end", values=(
                stage,
                f"{ASSETS[p.asset]['short']}-{p.timeframe}",
                p.side,
                f"{p.entry_price:.3f}",
                f"{now_price:.3f}" if now_price is not None else "—",
                _format_money(unreal, signed=True) if unreal is not None else "—",
                _format_duration(ttr),
            ), tags=tags)

    def _refresh_bankroll_chart(self):
        ax = self.bankroll_ax
        ax.clear()
        self._style_axes(ax)

        # Pull (timestamp, bankroll_after) for resolved trades + pre-insert
        rows = self._query_bankroll_series()
        if rows:
            xs_times, ys = zip(*rows)
            xs = [(t - self.start_time) / 60.0 for t in xs_times]  # minutes since start
            # Prepend origin point so the line starts at initial bankroll at t=0
            xs = [0] + list(xs)
            ys = [self.config.initial_bankroll] + list(ys)
            ax.plot(xs, ys, color=THEME["green"], linewidth=2.0)
            ax.fill_between(xs, self.config.initial_bankroll, ys,
                            where=[y >= self.config.initial_bankroll for y in ys],
                            color=THEME["green"], alpha=0.15)
            ax.fill_between(xs, self.config.initial_bankroll, ys,
                            where=[y < self.config.initial_bankroll for y in ys],
                            color=THEME["red"], alpha=0.15)
            ax.axhline(self.config.initial_bankroll, color=THEME["fg_mute"],
                       linestyle="--", linewidth=0.8, alpha=0.5)
            ax.set_xlabel("Minutes since start")
            ax.set_ylabel("Bankroll $")
        else:
            ax.text(0.5, 0.5, "Waiting for first resolved trade…",
                    ha="center", va="center", color=THEME["fg_mute"],
                    transform=ax.transAxes, fontsize=11)
            ax.set_xticks([])
            ax.set_yticks([])

        self.bankroll_fig.tight_layout()
        self.bankroll_canvas.draw_idle()

    def _async_fetch_open(self, key: tuple):
        """Kick off a background thread to fetch window-open spot price."""
        with self._spot_fetch_lock:
            if key in self._spot_fetch_inflight:
                return
            self._spot_fetch_inflight.add(key)

        def worker():
            asset, tf, epoch = key
            try:
                px = self.hunter.get_spot_at_epoch(asset, epoch)
            except Exception:
                px = 0.0
            self._spot_open_cache[key] = px
            with self._spot_fetch_lock:
                self._spot_fetch_inflight.discard(key)

        threading.Thread(target=worker, daemon=True, name=f"fetchopen-{key}").start()

    def _query_bankroll_series(self) -> List[tuple]:
        try:
            conn = sqlite3.connect(self.db_path, timeout=5)
            cur = conn.cursor()
            cur.execute("""
                SELECT timestamp, bankroll_after FROM live_trades
                WHERE outcome IS NOT NULL AND bankroll_after IS NOT NULL
                ORDER BY timestamp ASC
            """)
            rows = cur.fetchall()
            conn.close()
            return rows
        except Exception:
            return []

    def _refresh_breakdown_chart(self):
        ax = self.breakdown_ax
        ax.clear()
        self._style_axes(ax)

        stages = ("pre_close", "at_close", "post_close")
        convs = ("weak", "medium", "strong")
        stage_pnl = [self.hunter.stage_stats[s]["pnl"] for s in stages]
        stage_trades = [self.hunter.stage_stats[s]["trades"] for s in stages]
        conv_pnl = [self.hunter.conviction_stats[c]["pnl"] for c in convs]
        conv_trades = [self.hunter.conviction_stats[c]["trades"] for c in convs]

        if sum(stage_trades) + sum(conv_trades) == 0:
            ax.text(0.5, 0.5, "No resolved snipes yet…",
                    ha="center", va="center", color=THEME["fg_mute"],
                    transform=ax.transAxes, fontsize=11)
            ax.set_xticks([]); ax.set_yticks([])
            self.breakdown_fig.tight_layout()
            self.breakdown_canvas.draw_idle()
            return

        # Side-by-side bars
        labels = list(stages) + list(convs)
        values = stage_pnl + conv_pnl
        trades = stage_trades + conv_trades
        colors = [THEME["green"] if v >= 0 else THEME["red"] for v in values]
        positions = list(range(len(labels)))

        bars = ax.bar(positions, values, color=colors, edgecolor="none",
                      width=0.7)
        ax.axhline(0, color=THEME["border"], linewidth=0.8)
        ax.set_xticks(positions)
        ax.set_xticklabels([f"{l}\n({t}t)" for l, t in zip(labels, trades)],
                           fontsize=8, color=THEME["fg_mute"])
        ax.set_ylabel("P&L $")
        # Add value labels above bars
        for b, v in zip(bars, values):
            if v == 0:
                continue
            ax.text(b.get_x() + b.get_width() / 2,
                    v + (0.02 * max(abs(min(values)), abs(max(values)), 0.1)),
                    f"${v:+.2f}", ha="center",
                    va="bottom" if v >= 0 else "top",
                    color=THEME["fg"], fontsize=8)
        # Separator between stage and conviction groups
        ax.axvline(2.5, color=THEME["border"], linewidth=0.6, alpha=0.5)

        self.breakdown_fig.tight_layout()
        self.breakdown_canvas.draw_idle()

    def _refresh_stats_table(self):
        tv = self.stats_tv
        for i in tv.get_children():
            tv.delete(i)

        # Stage
        for s in ("pre_close", "at_close", "post_close"):
            d = self.hunter.stage_stats.get(s, {"trades": 0, "wins": 0, "pnl": 0.0})
            self._insert_stat_row(tv, "Stage", s, d)

        # Conviction
        for c in ("weak", "medium", "strong"):
            d = self.hunter.conviction_stats.get(c, {"trades": 0, "wins": 0, "pnl": 0.0})
            self._insert_stat_row(tv, "Conviction", c, d)

        # Market
        for k in sorted(self.hunter.market_stats.keys()):
            d = self.hunter.market_stats[k]
            self._insert_stat_row(tv, "Market", k, d)

    def _insert_stat_row(self, tv, bucket: str, cat: str, d: dict):
        t = int(d.get("trades", 0) or 0)
        w = int(d.get("wins", 0) or 0)
        p = float(d.get("pnl", 0.0) or 0.0)
        if t == 0:
            tag = "mute"
            wr_s = "—"
            pnl_s = "—"
        else:
            wr_s = f"{w/t*100:.1f}%"
            pnl_s = _format_money(p, signed=True)
            tag = "pos" if p >= 0 else "neg"
        tv.insert("", "end", values=(bucket, cat, t, wr_s, pnl_s), tags=(tag,))

    def _refresh_log(self):
        # Append only NEW events since last refresh
        evs = list(self.hunter.events)
        if len(evs) == self._last_event_count:
            return
        new = evs[self._last_event_count:]
        self._last_event_count = len(evs)

        self.log_text.config(state="normal")
        for ev in new:
            ts = datetime.fromtimestamp(ev["ts"]).strftime("%H:%M:%S")
            if ev["kind"] == "FIRE":
                move_s = (f"spot {ev['move_pct']*100:+.2f}%"
                          if ev.get("move_pct") is not None else "")
                line = (f"[{ts}] FIRE  {ev['market']:<8} {ev['stage']:<10} "
                        f"{ev['side']:<3} @{ev['price']:.3f} ${ev['size']:.2f} "
                        f"({ev['conviction']}, {move_s})\n")
                tag = "fire"
            elif ev["kind"] == "WIN":
                line = (f"[{ts}] WIN   {ev['market']:<8} {ev['stage']:<10} "
                        f"{ev['side']:<3} @{ev['price']:.3f}  "
                        f"PnL +${ev['pnl']:.2f}  bank ${ev['bankroll']:.2f}\n")
                tag = "win"
            elif ev["kind"] == "LOSS":
                line = (f"[{ts}] LOSS  {ev['market']:<8} {ev['stage']:<10} "
                        f"{ev['side']:<3} @{ev['price']:.3f}  "
                        f"PnL ${ev['pnl']:+.2f}  bank ${ev['bankroll']:.2f}\n")
                tag = "loss"
            else:
                line = f"[{ts}] {ev['kind']} {ev}\n"
                tag = "mute"
            self.log_text.insert("end", line, tag)
        self.log_text.see("end")
        self.log_text.config(state="disabled")

    # --------------------------------------------------------
    # Entry
    # --------------------------------------------------------

    def run(self):
        self.root.mainloop()


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Satriales Snipe Trader GUI")
    parser.add_argument("--hours", type=float, default=None,
                        help="Ignored in GUI mode (runs until window closed)")
    parser.add_argument("--assets", type=str, default="btc,eth")
    parser.add_argument("--timeframes", type=str, default="5m,15m")
    parser.add_argument("--no-15m", action="store_true")
    parser.add_argument("--bankroll", type=float, default=20.0)
    parser.add_argument("--db", type=str, default="snipe.db")
    parser.add_argument("--poll", type=int, default=5)
    args = parser.parse_args()

    assets = [a.strip().lower() for a in args.assets.split(",") if a.strip()]
    unknown = [a for a in assets if a not in ASSETS]
    if unknown:
        sys.exit(f"Unknown asset(s): {unknown}")

    timeframes = [t.strip().lower() for t in args.timeframes.split(",") if t.strip()]
    if args.no_15m and "15m" in timeframes:
        timeframes.remove("15m")
    unknown_tf = [t for t in timeframes if t not in TIMEFRAMES]
    if unknown_tf:
        sys.exit(f"Unknown timeframe(s): {unknown_tf}")

    config = SnipeConfig(initial_bankroll=args.bankroll, poll_interval=args.poll)
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.db)
    hunter = SnipeHunter(config, db_path, assets, timeframes)

    gui = SnipeGUI(hunter, config, db_path)
    gui.run()


if __name__ == "__main__":
    main()
