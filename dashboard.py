"""
Satriales Trading Dashboard - Rich GUI with live statistics and charts.

Runs a Dash web app on http://localhost:8050 that displays:
- Real-time bankroll curve and PnL
- Win/loss heatmap and distribution
- Model performance comparison
- Trade log with filtering
- Market data visualization
- Live collector status

Usage:
    python dashboard.py                # Launch dashboard (auto-runs synthetic sim if no data)
    python dashboard.py --port 8080    # Custom port
"""

import argparse
import json
import os
import sys
import threading
import time
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
import dash
from dash import dcc, html, dash_table, callback_context
from dash.dependencies import Input, Output, State
import dash_bootstrap_components as dbc

from config import Config
from db import init_db, get_connection, get_all_trades, get_trade_summary, get_recent_windows, get_hourly_pnl, get_recent_logs, get_session_stats, DB_PATH

warnings.filterwarnings("ignore", category=RuntimeWarning)

# ============================================================
# Theme and Styling
# ============================================================

DARK_BG = "#0d1117"
CARD_BG = "#161b22"
BORDER = "#30363d"
TEXT_PRIMARY = "#e6edf3"
TEXT_SECONDARY = "#8b949e"
GREEN = "#3fb950"
RED = "#f85149"
BLUE = "#58a6ff"
YELLOW = "#d29922"
PURPLE = "#bc8cff"

PLOTLY_TEMPLATE = {
    "layout": {
        "paper_bgcolor": CARD_BG,
        "plot_bgcolor": CARD_BG,
        "font": {"color": TEXT_PRIMARY, "family": "JetBrains Mono, Consolas, monospace"},
        "xaxis": {"gridcolor": BORDER, "zerolinecolor": BORDER},
        "yaxis": {"gridcolor": BORDER, "zerolinecolor": BORDER},
        "margin": {"l": 50, "r": 20, "t": 40, "b": 40},
    }
}


def make_card(title, content_id, height="320px"):
    """Create a styled dashboard card."""
    return dbc.Card(
        [
            dbc.CardHeader(
                title,
                style={"backgroundColor": CARD_BG, "color": BLUE,
                       "borderBottom": f"1px solid {BORDER}",
                       "fontWeight": "600", "fontSize": "13px",
                       "textTransform": "uppercase", "letterSpacing": "1px"},
            ),
            dbc.CardBody(
                html.Div(id=content_id, style={"height": height}),
                style={"backgroundColor": CARD_BG, "padding": "8px"},
            ),
        ],
        style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER}",
               "borderRadius": "8px", "marginBottom": "12px"},
    )


def make_stat_card(label, value_id, color=TEXT_PRIMARY, col_width=2):
    """Create a small stat indicator card."""
    return dbc.Col(
        dbc.Card(
            dbc.CardBody([
                html.Div(label, style={"fontSize": "10px", "color": TEXT_SECONDARY,
                                       "textTransform": "uppercase", "letterSpacing": "1px",
                                       "whiteSpace": "nowrap"}),
                html.Div(id=value_id, style={"fontSize": "20px", "fontWeight": "700",
                                             "color": color, "marginTop": "4px",
                                             "fontFamily": "JetBrains Mono, Consolas, monospace",
                                             "whiteSpace": "nowrap"}),
            ], style={"padding": "10px 14px"}),
            style={"backgroundColor": CARD_BG, "border": f"1px solid {BORDER}",
                   "borderRadius": "8px"},
        ),
        width=col_width,
        style={"paddingLeft": "6px", "paddingRight": "6px"},
    )


# ============================================================
# Dashboard Layout
# ============================================================

def create_layout():
    return dbc.Container(
        fluid=True,
        style={"backgroundColor": DARK_BG, "minHeight": "100vh", "padding": "16px",
               "fontFamily": "JetBrains Mono, Consolas, monospace"},
        children=[
            # Header
            dbc.Row(
                dbc.Col(
                    html.Div([
                        html.H2("SATRIALES", style={"color": TEXT_PRIMARY, "marginBottom": "0",
                                                     "fontWeight": "800", "letterSpacing": "3px"}),
                        html.Span("POLYMARKET BTC 5-MIN TRADING TERMINAL",
                                  style={"color": TEXT_SECONDARY, "fontSize": "12px",
                                         "letterSpacing": "2px"}),
                    ], style={"display": "flex", "alignItems": "baseline", "gap": "16px"}),
                ),
                style={"marginBottom": "16px", "borderBottom": f"1px solid {BORDER}",
                       "paddingBottom": "12px"},
            ),

            # Top stats row - 3 cards per row for wider display
            dbc.Row(
                [
                    make_stat_card("Bankroll", "stat-bankroll", GREEN, col_width=2),
                    make_stat_card("Total PnL", "stat-pnl", GREEN, col_width=2),
                    make_stat_card("Win Rate", "stat-winrate", BLUE, col_width=2),
                    make_stat_card("Trades", "stat-trades", TEXT_PRIMARY, col_width=2),
                    make_stat_card("Sharpe", "stat-sharpe", PURPLE, col_width=2),
                    make_stat_card("Max DD", "stat-drawdown", RED, col_width=2),
                ],
                style={"marginBottom": "12px"},
            ),

            # Main charts row
            dbc.Row([
                dbc.Col([
                    make_card("Bankroll Curve", "chart-bankroll", "300px"),
                ], width=8),
                dbc.Col([
                    make_card("PnL Distribution", "chart-pnl-dist", "300px"),
                ], width=4),
            ]),

            # Second charts row
            dbc.Row([
                dbc.Col([
                    make_card("Win Rate by Hour", "chart-hourly", "280px"),
                ], width=4),
                dbc.Col([
                    make_card("Edge vs Outcome", "chart-edge", "280px"),
                ], width=4),
                dbc.Col([
                    make_card("Cumulative PnL", "chart-cumulative", "280px"),
                ], width=4),
            ]),

            # Trade log and model stats
            dbc.Row([
                dbc.Col([
                    make_card("Recent Trades", "trade-log", "350px"),
                ], width=8),
                dbc.Col([
                    make_card("Model Performance", "model-stats", "350px"),
                ], width=4),
            ]),

            # System log
            dbc.Row([
                dbc.Col([
                    make_card("System Log", "system-log", "200px"),
                ], width=12),
            ]),

            # Auto-refresh
            dcc.Interval(id="refresh-interval", interval=3000, n_intervals=0),

            # Hidden data store
            dcc.Store(id="data-store"),
        ],
    )


# ============================================================
# Data Loading
# ============================================================

def load_dashboard_data():
    """Load all data from SQLite for dashboard display."""
    try:
        conn = get_connection()
        trades = get_all_trades(conn)
        summary = get_trade_summary(conn)
        hourly = get_hourly_pnl(conn)
        logs = get_recent_logs(conn, limit=50)
        session = get_session_stats(conn)
        conn.close()
        return {
            "trades": trades,
            "summary": summary,
            "hourly": hourly,
            "logs": logs,
            "session": session,
        }
    except Exception as e:
        return {"trades": [], "summary": {}, "hourly": [], "logs": [], "session": None, "error": str(e)}


# ============================================================
# Chart Builders
# ============================================================

def build_bankroll_chart(trades):
    """Build the main bankroll curve chart."""
    fig = go.Figure()

    if not trades:
        fig.add_annotation(text="No trades yet - run collector.py first",
                           xref="paper", yref="paper", x=0.5, y=0.5,
                           showarrow=False, font=dict(color=TEXT_SECONDARY, size=14))
        fig.update_layout(**PLOTLY_TEMPLATE["layout"])
        return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})

    bankrolls = [t.get("bankroll_after", 1000) for t in trades if t.get("bankroll_after")]
    if not bankrolls:
        return html.Div("No bankroll data", style={"color": TEXT_SECONDARY})

    x = list(range(len(bankrolls)))
    initial = bankrolls[0] if bankrolls else 1000

    fig.add_trace(go.Scatter(
        x=x, y=bankrolls, mode="lines",
        line=dict(color=BLUE, width=2),
        fill="tozeroy", fillcolor="rgba(88,166,255,0.08)",
        name="Bankroll",
    ))

    # Add peak line
    peaks = np.maximum.accumulate(bankrolls)
    fig.add_trace(go.Scatter(
        x=x, y=peaks.tolist(), mode="lines",
        line=dict(color=GREEN, width=1, dash="dot"),
        name="Peak",
    ))

    fig.update_layout(
        **PLOTLY_TEMPLATE["layout"],
        showlegend=True,
        legend=dict(x=0.02, y=0.98, bgcolor="rgba(0,0,0,0)"),
        yaxis_title="$",
    )
    return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})


def build_pnl_distribution(trades):
    """Build PnL distribution histogram."""
    fig = go.Figure()

    pnls = [t.get("pnl", 0) for t in trades if t.get("pnl") is not None]
    if not pnls:
        fig.add_annotation(text="No resolved trades",
                           xref="paper", yref="paper", x=0.5, y=0.5,
                           showarrow=False, font=dict(color=TEXT_SECONDARY, size=14))
        fig.update_layout(**PLOTLY_TEMPLATE["layout"])
        return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})

    colors = [GREEN if p >= 0 else RED for p in pnls]

    fig.add_trace(go.Histogram(
        x=pnls, nbinsx=40,
        marker=dict(color=BLUE, line=dict(color=BORDER, width=0.5)),
        name="PnL",
    ))

    fig.update_layout(
        **PLOTLY_TEMPLATE["layout"],
        showlegend=False,
        xaxis_title="PnL ($)",
        yaxis_title="Count",
    )
    return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})


def build_hourly_chart(hourly_data):
    """Build hourly PnL bar chart."""
    fig = go.Figure()

    if not hourly_data:
        fig.add_annotation(text="No hourly data",
                           xref="paper", yref="paper", x=0.5, y=0.5,
                           showarrow=False, font=dict(color=TEXT_SECONDARY, size=14))
        fig.update_layout(**PLOTLY_TEMPLATE["layout"])
        return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})

    hours = list(range(len(hourly_data)))
    pnls = [h.get("pnl", 0) for h in hourly_data]
    colors = [GREEN if p >= 0 else RED for p in pnls]
    win_rates = [h["wins"] / h["trades"] * 100 if h.get("trades", 0) > 0 else 0 for h in hourly_data]

    fig.add_trace(go.Bar(
        x=hours, y=pnls,
        marker=dict(color=colors, opacity=0.8),
        name="PnL",
    ))

    fig.update_layout(
        **PLOTLY_TEMPLATE["layout"],
        showlegend=False,
        xaxis_title="Period",
        yaxis_title="PnL ($)",
    )
    return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})


def build_edge_chart(trades):
    """Build edge vs outcome scatter plot."""
    fig = go.Figure()

    resolved = [t for t in trades if t.get("pnl") is not None and t.get("edge")]
    if not resolved:
        fig.add_annotation(text="No data",
                           xref="paper", yref="paper", x=0.5, y=0.5,
                           showarrow=False, font=dict(color=TEXT_SECONDARY, size=14))
        fig.update_layout(**PLOTLY_TEMPLATE["layout"])
        return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})

    edges = [abs(t["edge"]) for t in resolved]
    pnls = [t["pnl"] for t in resolved]
    colors = [GREEN if p > 0 else RED for p in pnls]

    fig.add_trace(go.Scatter(
        x=edges, y=pnls, mode="markers",
        marker=dict(color=colors, size=5, opacity=0.6),
        name="Trades",
    ))

    fig.update_layout(
        **PLOTLY_TEMPLATE["layout"],
        showlegend=False,
        xaxis_title="Edge (abs)",
        yaxis_title="PnL ($)",
    )
    return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})


def build_cumulative_chart(trades):
    """Build cumulative PnL over time."""
    fig = go.Figure()

    pnls = [t.get("pnl", 0) for t in trades if t.get("pnl") is not None]
    if not pnls:
        fig.add_annotation(text="No data",
                           xref="paper", yref="paper", x=0.5, y=0.5,
                           showarrow=False, font=dict(color=TEXT_SECONDARY, size=14))
        fig.update_layout(**PLOTLY_TEMPLATE["layout"])
        return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})

    cum_pnl = np.cumsum(pnls).tolist()
    x = list(range(len(cum_pnl)))

    fig.add_trace(go.Scatter(
        x=x, y=cum_pnl, mode="lines",
        line=dict(color=GREEN if cum_pnl[-1] >= 0 else RED, width=2),
        fill="tozeroy",
        fillcolor=f"rgba(63,185,80,0.08)" if cum_pnl[-1] >= 0 else "rgba(248,81,73,0.08)",
    ))

    fig.add_hline(y=0, line_dash="dash", line_color=TEXT_SECONDARY, opacity=0.5)

    fig.update_layout(
        **PLOTLY_TEMPLATE["layout"],
        showlegend=False,
        xaxis_title="Trade #",
        yaxis_title="Cumulative PnL ($)",
    )
    return dcc.Graph(figure=fig, style={"height": "100%"}, config={"displayModeBar": False})


def build_trade_log(trades):
    """Build the trade log table."""
    if not trades:
        return html.Div("No trades recorded", style={"color": TEXT_SECONDARY, "padding": "20px"})

    recent = trades[-100:][::-1]  # last 100, newest first

    rows = []
    for t in recent:
        pnl = t.get("pnl")
        pnl_str = f"${pnl:+.2f}" if pnl is not None else "pending..."
        pnl_color = GREEN if (pnl and pnl > 0) else RED if (pnl and pnl < 0) else YELLOW

        ts = t.get("timestamp", 0)
        time_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "?"

        rows.append(html.Tr([
            html.Td(time_str, style={"color": TEXT_SECONDARY, "fontSize": "11px"}),
            html.Td(t.get("side", "?"),
                     style={"color": GREEN if t.get("side") == "YES" else RED,
                            "fontWeight": "600"}),
            html.Td(f"{t.get('model_prob', 0):.3f}", style={"color": TEXT_PRIMARY}),
            html.Td(f"{t.get('market_prob', 0):.3f}", style={"color": TEXT_PRIMARY}),
            html.Td(f"{t.get('edge', 0):+.3f}", style={"color": BLUE}),
            html.Td(pnl_str, style={"color": pnl_color, "fontWeight": "600"}),
            html.Td(f"${t.get('bankroll_after', 0):,.0f}", style={"color": TEXT_SECONDARY}),
        ], style={"borderBottom": f"1px solid {BORDER}"}))

    return html.Div(
        html.Table([
            html.Thead(html.Tr([
                html.Th(h, style={"color": TEXT_SECONDARY, "fontSize": "10px",
                                  "textTransform": "uppercase", "padding": "4px 8px",
                                  "borderBottom": f"2px solid {BORDER}"})
                for h in ["Time", "Side", "Model P", "Mkt P", "Edge", "PnL", "Bankroll"]
            ])),
            html.Tbody(rows),
        ], style={"width": "100%", "borderCollapse": "collapse", "fontSize": "12px"}),
        style={"overflowY": "auto", "height": "100%"},
    )


def build_model_stats(trades, summary):
    """Build model performance statistics panel."""
    if not trades or not summary:
        return html.Div("No model data", style={"color": TEXT_SECONDARY, "padding": "20px"})

    total = summary.get("total_trades", 0)
    wins = summary.get("wins", 0)
    losses = summary.get("losses", 0)
    avg_edge = summary.get("avg_edge", 0)
    total_fees = summary.get("total_fees", 0)

    # Model calibration: compare model_prob to actual outcomes
    resolved = [t for t in trades if t.get("pnl") is not None]
    if resolved:
        model_probs = [t.get("model_prob", 0.5) for t in resolved]
        outcomes = [1 if t.get("pnl", 0) > 0 else 0 for t in resolved]
        brier = np.mean([(p - o) ** 2 for p, o in zip(model_probs, outcomes)])
    else:
        brier = 0

    # Side breakdown
    yes_trades = [t for t in resolved if t.get("side") == "YES"]
    no_trades = [t for t in resolved if t.get("side") == "NO"]
    yes_wr = sum(1 for t in yes_trades if t.get("pnl", 0) > 0) / len(yes_trades) * 100 if yes_trades else 0
    no_wr = sum(1 for t in no_trades if t.get("pnl", 0) > 0) / len(no_trades) * 100 if no_trades else 0

    stats = [
        ("Total Resolved", f"{len(resolved)}"),
        ("Wins / Losses", f"{wins} / {losses}"),
        ("YES Win Rate", f"{yes_wr:.1f}%"),
        ("NO Win Rate", f"{no_wr:.1f}%"),
        ("Avg Edge", f"{avg_edge:.4f}"),
        ("Brier Score", f"{brier:.4f}"),
        ("Total Fees", f"${total_fees:,.2f}"),
        ("Profit Factor", f"{sum(t['pnl'] for t in resolved if t.get('pnl', 0) > 0) / max(abs(sum(t['pnl'] for t in resolved if t.get('pnl', 0) < 0)), 0.01):,.2f}"),
    ]

    return html.Div([
        html.Div([
            html.Div([
                html.Span(label, style={"color": TEXT_SECONDARY, "fontSize": "11px"}),
                html.Span(value, style={"color": TEXT_PRIMARY, "fontSize": "14px",
                                        "fontWeight": "600", "float": "right"}),
            ], style={"padding": "6px 0", "borderBottom": f"1px solid {BORDER}"})
            for label, value in stats
        ]),
    ], style={"padding": "8px"})


def build_system_log(logs):
    """Build system log display."""
    if not logs:
        return html.Div("No log entries", style={"color": TEXT_SECONDARY, "padding": "20px"})

    entries = []
    for log_entry in logs[-30:]:
        ts = log_entry.get("timestamp", 0)
        time_str = datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "?"
        level = log_entry.get("level", "INFO")
        msg = log_entry.get("message", "")
        level_color = GREEN if level == "INFO" else YELLOW if level == "WARNING" else RED

        entries.append(html.Div(
            [
                html.Span(f"[{time_str}] ", style={"color": TEXT_SECONDARY}),
                html.Span(f"[{level}] ", style={"color": level_color, "fontWeight": "600"}),
                html.Span(msg, style={"color": TEXT_PRIMARY}),
            ],
            style={"fontSize": "11px", "lineHeight": "1.6", "fontFamily": "monospace"},
        ))

    return html.Div(entries, style={"overflowY": "auto", "height": "100%", "padding": "4px"})


# ============================================================
# App Creation
# ============================================================

def create_app():
    app = dash.Dash(
        __name__,
        external_stylesheets=[dbc.themes.DARKLY],
        title="Satriales Trading Terminal",
        update_title=None,
    )

    app.layout = create_layout()

    @app.callback(
        [
            Output("stat-bankroll", "children"),
            Output("stat-pnl", "children"),
            Output("stat-winrate", "children"),
            Output("stat-trades", "children"),
            Output("stat-sharpe", "children"),
            Output("stat-drawdown", "children"),
            Output("chart-bankroll", "children"),
            Output("chart-pnl-dist", "children"),
            Output("chart-hourly", "children"),
            Output("chart-edge", "children"),
            Output("chart-cumulative", "children"),
            Output("trade-log", "children"),
            Output("model-stats", "children"),
            Output("system-log", "children"),
        ],
        [Input("refresh-interval", "n_intervals")],
    )
    def update_dashboard(n):
        data = load_dashboard_data()
        trades = data.get("trades", [])
        summary = data.get("summary", {})
        hourly = data.get("hourly", [])
        logs = data.get("logs", [])
        session = data.get("session")

        # Compute stats
        bankroll = session.get("bankroll", 1000) if session else 1000
        total_pnl = summary.get("total_pnl", 0) or 0
        total_trades = summary.get("total_trades", 0) or 0
        wins = summary.get("wins", 0) or 0
        win_rate = wins / total_trades * 100 if total_trades > 0 else 0

        # Sharpe from trades
        resolved = [t for t in trades if t.get("pnl") is not None and t.get("pnl") != 0]
        if len(resolved) >= 5:
            returns = [t["pnl"] / max(abs(t.get("entry_price", 0.5) * t.get("shares", 1)), 0.01) for t in resolved]
            sharpe = np.mean(returns) / (np.std(returns) + 1e-10) * np.sqrt(min(len(returns), 288 * 365))
        else:
            sharpe = 0

        # Max drawdown
        bankrolls = [t.get("bankroll_after", 1000) for t in trades if t.get("bankroll_after")]
        if bankrolls:
            peaks = np.maximum.accumulate(bankrolls)
            dd = (peaks - bankrolls) / (peaks + 1e-10)
            max_dd = float(np.max(dd)) * 100
        else:
            max_dd = 0

        pnl_color = GREEN if total_pnl >= 0 else RED

        def fmt_money(v, signed=True):
            av = abs(v)
            s = "+" if v > 0 and signed else "-" if v < 0 else ""
            if av >= 1_000_000:
                return f"{s}${av/1_000_000:.1f}M"
            elif av >= 1_000:
                return f"{s}${av/1_000:.1f}K"
            else:
                return f"{s}${av:.0f}" if av > 0 else "$0"

        return [
            fmt_money(bankroll, signed=False),
            html.Span(fmt_money(total_pnl), style={"color": pnl_color}),
            f"{win_rate:.1f}%",
            str(total_trades),
            f"{sharpe:.2f}",
            html.Span(f"{max_dd:.1f}%", style={"color": RED if max_dd > 20 else YELLOW if max_dd > 10 else GREEN}),
            build_bankroll_chart(trades),
            build_pnl_distribution(trades),
            build_hourly_chart(hourly),
            build_edge_chart(trades),
            build_cumulative_chart(trades),
            build_trade_log(trades),
            build_model_stats(trades, summary),
            build_system_log(logs),
        ]

    return app


# ============================================================
# Background Simulation Runner
# ============================================================

def run_background_simulation():
    """Run synthetic simulation in background thread to populate dashboard."""
    time.sleep(2)  # Let dashboard start first

    from collector import run_synthetic_simulation
    config = Config(synthetic_num_windows=5000)
    try:
        run_synthetic_simulation(config)
    except Exception as e:
        print(f"Background simulation error: {e}")


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Satriales Trading Dashboard")
    parser.add_argument("--port", type=int, default=8050, help="Dashboard port (default: 8050)")
    parser.add_argument("--no-sim", action="store_true",
                        help="Don't auto-run simulation (use existing data)")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    args = parser.parse_args()

    init_db()

    # Check if we have existing data
    conn = get_connection()
    trade_count = conn.execute("SELECT COUNT(*) FROM live_trades").fetchone()[0]
    conn.close()

    if trade_count == 0 and not args.no_sim:
        print("No existing trade data found. Running synthetic simulation in background...")
        sim_thread = threading.Thread(target=run_background_simulation, daemon=True)
        sim_thread.start()
    else:
        print(f"Found {trade_count} existing trades in database.")

    app = create_app()

    print(f"\n{'='*60}")
    print(f"  SATRIALES TRADING TERMINAL")
    print(f"  Open http://localhost:{args.port} in your browser")
    print(f"{'='*60}\n")

    app.run(host="0.0.0.0", port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
