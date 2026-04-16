"""Performance metrics computation and display."""

from dataclasses import dataclass, field
import numpy as np
import os


@dataclass
class BacktestReport:
    strategy_name: str = ""
    total_trades: int = 0
    total_abstentions: int = 0
    win_rate: float = 0.0
    total_pnl: float = 0.0
    total_fees_paid: float = 0.0
    sharpe_ratio: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    profit_factor: float = 0.0
    avg_edge_when_trading: float = 0.0
    avg_pnl_per_trade: float = 0.0
    avg_bet_size: float = 0.0
    final_bankroll: float = 0.0
    bankroll_curve: list = field(default_factory=list)
    pnl_by_fold: list = field(default_factory=list)
    num_folds: int = 0
    model_params: dict = field(default_factory=dict)
    yes_trades: int = 0
    no_trades: int = 0
    busted: bool = False                # did bankroll hit zero?
    days_simulated: float = 0.0
    pnl_per_day: float = 0.0
    trades_per_day: float = 0.0
    roi_pct: float = 0.0               # total return on initial bankroll


def compute_report(folds: list, trades: list, config) -> BacktestReport:
    """Compute all performance metrics from backtest results."""
    report = BacktestReport()
    report.num_folds = len(folds)
    report.total_trades = len(trades)
    report.total_abstentions = sum(f.abstentions for f in folds)

    if not trades:
        report.final_bankroll = config.initial_bankroll
        return report

    # Win rate
    wins = sum(1 for t in trades if t.pnl > 0)
    report.win_rate = wins / len(trades)

    # PnL
    report.total_pnl = sum(t.pnl for t in trades)
    report.total_fees_paid = sum(t.fee_paid for t in trades)
    report.avg_pnl_per_trade = report.total_pnl / len(trades)

    # Side breakdown
    report.yes_trades = sum(1 for t in trades if t.side == "YES")
    report.no_trades = sum(1 for t in trades if t.side == "NO")

    # Average edge
    report.avg_edge_when_trading = float(np.mean([abs(t.edge) for t in trades]))

    # Bankroll curve
    report.bankroll_curve = [config.initial_bankroll] + [t.bankroll_after for t in trades]
    report.final_bankroll = trades[-1].bankroll_after

    # Max drawdown
    curve = np.array(report.bankroll_curve)
    peak = np.maximum.accumulate(curve)
    drawdown = peak - curve
    report.max_drawdown = float(np.max(drawdown))
    report.max_drawdown_pct = float(np.max(drawdown / (peak + 1e-10)))

    # Sharpe ratio
    returns = []
    for t in trades:
        cost = t.total_cost_per_share * t.shares
        if cost > 0:
            returns.append(t.pnl / cost)
    if len(returns) >= 2:
        mean_ret = np.mean(returns)
        std_ret = np.std(returns)
        if std_ret > 1e-10:
            report.sharpe_ratio = float(mean_ret / std_ret * np.sqrt(min(len(returns), 288 * 365)))
        else:
            report.sharpe_ratio = 0.0
    else:
        report.sharpe_ratio = 0.0

    # Profit factor
    gross_profit = sum(t.pnl for t in trades if t.pnl > 0)
    gross_loss = abs(sum(t.pnl for t in trades if t.pnl < 0))
    report.profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf") if gross_profit > 0 else 0.0

    # PnL by fold
    report.pnl_by_fold = [f.fold_pnl for f in folds]

    # Average bet size
    bet_sizes = [t.total_cost_per_share * t.shares for t in trades if t.shares > 0]
    report.avg_bet_size = float(np.mean(bet_sizes)) if bet_sizes else 0.0

    # Busted?
    report.busted = report.final_bankroll < getattr(config, 'min_bankroll', 0.5)

    # Daily projections (288 windows = 1 day)
    windows_per_day = getattr(config, 'windows_per_day', 288)
    total_windows = report.total_trades + report.total_abstentions
    if total_windows > 0:
        report.days_simulated = total_windows / windows_per_day
        report.pnl_per_day = report.total_pnl / report.days_simulated if report.days_simulated > 0 else 0
        report.trades_per_day = report.total_trades / report.days_simulated if report.days_simulated > 0 else 0
    report.roi_pct = (report.total_pnl / config.initial_bankroll) * 100

    return report


def print_report(report: BacktestReport) -> None:
    """Pretty-print a single strategy's results."""
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel

    console = Console()

    table = Table(title=f"Strategy: {report.strategy_name}", show_header=True,
                  header_style="bold cyan")
    table.add_column("Metric", style="bold")
    table.add_column("Value", justify="right")

    # Bankroll section
    table.add_row("Initial Bankroll", f"${20.0:,.2f}")
    table.add_row("Final Bankroll", f"${report.final_bankroll:,.2f}")
    bust_str = "[bold red]YES - BUSTED[/bold red]" if report.busted else "[bold green]NO[/bold green]"
    table.add_row("Busted?", bust_str)
    table.add_row("ROI", f"{report.roi_pct:+.1f}%")
    table.add_row("", "")

    # Trading activity
    table.add_row("Total Trades", str(report.total_trades))
    table.add_row("Abstentions", str(report.total_abstentions))
    table.add_row("YES / NO Trades", f"{report.yes_trades} / {report.no_trades}")
    table.add_row("Avg Bet Size", f"${report.avg_bet_size:,.2f}")
    table.add_row("", "")

    # Performance
    table.add_row("Win Rate", f"{report.win_rate:.1%}")
    table.add_row("Total PnL", f"${report.total_pnl:,.2f}")
    table.add_row("Fees Paid", f"${report.total_fees_paid:,.2f}")
    table.add_row("Avg PnL/Trade", f"${report.avg_pnl_per_trade:,.4f}")
    table.add_row("Avg Edge", f"{report.avg_edge_when_trading:.4f}")
    table.add_row("Sharpe Ratio", f"{report.sharpe_ratio:.3f}")
    table.add_row("Max Drawdown", f"${report.max_drawdown:,.2f}")
    table.add_row("Max Drawdown %", f"{report.max_drawdown_pct:.1%}")
    table.add_row("Profit Factor", f"{report.profit_factor:.2f}")
    table.add_row("", "")

    # Daily projections
    table.add_row("Days Simulated", f"{report.days_simulated:.1f}")
    table.add_row("Trades / Day", f"{report.trades_per_day:.0f}")
    table.add_row("PnL / Day", f"${report.pnl_per_day:,.2f}")
    target_days = (100.0 / report.pnl_per_day) if report.pnl_per_day > 0 else float('inf')
    if target_days < 1000:
        table.add_row("Days to $100/day", f"~{target_days:.0f} days")
    else:
        table.add_row("Days to $100/day", "[red]Not viable[/red]")
    table.add_row("Walk-Forward Folds", str(report.num_folds))

    console.print(table)


def print_comparison_table(reports: list) -> None:
    """Print side-by-side comparison of all strategies."""
    from tabulate import tabulate

    rows = []
    for r in reports:
        bust_marker = " BUST" if r.busted else ""
        rows.append([
            r.strategy_name,
            r.total_trades,
            f"{r.win_rate:.1%}",
            f"${r.total_pnl:,.2f}",
            f"${r.avg_bet_size:,.2f}",
            f"{r.sharpe_ratio:.3f}",
            f"{r.max_drawdown_pct:.1%}",
            f"{r.profit_factor:.2f}",
            f"${r.final_bankroll:,.2f}{bust_marker}",
            f"${r.pnl_per_day:,.2f}",
            f"{r.roi_pct:+.0f}%",
        ])

    headers = ["Strategy", "Trades", "Win%", "PnL", "AvgBet", "Sharpe",
               "MaxDD%", "PF", "Final $", "$/Day", "ROI"]
    print("\n" + tabulate(rows, headers=headers, tablefmt="grid"))


def plot_results(report: BacktestReport, save_path: str = None) -> None:
    """Generate bankroll curve and PnL distribution charts."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle(f"Strategy: {report.strategy_name}", fontsize=14, fontweight="bold")

    # 1. Bankroll curve
    ax = axes[0, 0]
    curve = report.bankroll_curve
    ax.plot(curve, linewidth=1, color="steelblue")
    ax.axhline(y=curve[0], color="gray", linestyle="--", alpha=0.5)
    ax.fill_between(range(len(curve)), curve[0], curve,
                    where=[c >= curve[0] for c in curve], alpha=0.15, color="green")
    ax.fill_between(range(len(curve)), curve[0], curve,
                    where=[c < curve[0] for c in curve], alpha=0.15, color="red")
    ax.set_title("Bankroll Curve")
    ax.set_xlabel("Trade #")
    ax.set_ylabel("Bankroll ($)")
    ax.grid(True, alpha=0.3)

    # 2. Drawdown
    ax = axes[0, 1]
    curve_arr = np.array(curve)
    peak = np.maximum.accumulate(curve_arr)
    dd = (peak - curve_arr) / (peak + 1e-10) * 100
    ax.fill_between(range(len(dd)), 0, dd, color="red", alpha=0.3)
    ax.set_title("Drawdown (%)")
    ax.set_xlabel("Trade #")
    ax.set_ylabel("Drawdown %")
    ax.grid(True, alpha=0.3)

    # 3. PnL by fold
    ax = axes[1, 0]
    if report.pnl_by_fold:
        colors = ["green" if p >= 0 else "red" for p in report.pnl_by_fold]
        ax.bar(range(len(report.pnl_by_fold)), report.pnl_by_fold, color=colors, alpha=0.7)
        ax.axhline(y=0, color="gray", linestyle="-", alpha=0.5)
    ax.set_title("PnL by Walk-Forward Fold")
    ax.set_xlabel("Fold #")
    ax.set_ylabel("PnL ($)")
    ax.grid(True, alpha=0.3)

    # 4. Summary text
    ax = axes[1, 1]
    ax.axis("off")
    bust_label = "BUSTED" if report.busted else "Alive"
    summary = (
        f"Start: $20.00 → Final: ${report.final_bankroll:,.2f}\n"
        f"Status: {bust_label} | ROI: {report.roi_pct:+.1f}%\n"
        f"Win Rate: {report.win_rate:.1%}\n"
        f"Total PnL: ${report.total_pnl:,.2f}\n"
        f"Avg Bet: ${report.avg_bet_size:,.2f}\n"
        f"Sharpe: {report.sharpe_ratio:.3f} | PF: {report.profit_factor:.2f}\n"
        f"Max DD: {report.max_drawdown_pct:.1%}\n"
        f"PnL/Day: ${report.pnl_per_day:,.2f}\n"
        f"Trades: {report.total_trades} ({report.trades_per_day:.0f}/day)"
    )
    ax.text(0.1, 0.5, summary, transform=ax.transAxes, fontsize=12,
            verticalalignment="center", fontfamily="monospace",
            bbox=dict(boxstyle="round", facecolor="wheat", alpha=0.5))
    ax.set_title("Summary")

    plt.tight_layout()

    if save_path:
        os.makedirs(os.path.dirname(save_path) if os.path.dirname(save_path) else ".", exist_ok=True)
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        print(f"\nChart saved to: {save_path}")

    plt.close(fig)
