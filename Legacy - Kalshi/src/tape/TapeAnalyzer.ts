/**
 * Analyzer for the Kalshi tape archive (kalshi_tape.db).
 *
 * TypeScript port of kalshi_tape_analyzer.py. For every fill in a settled
 * market, compute the taker-side realized PnL assuming they held to
 * settlement, then bucket by (time-to-close, price, size, strike_type) to
 * see where winning order flow clusters.
 *
 * Honest caveats:
 *   - This is "if taker held to settlement" PnL. A taker who exited early
 *     gets a different real outcome. We can't distinguish without auth.
 *   - At aggregate, systematic patterns should still show through.
 *   - Numbers scale with sample size — 4h is still small.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface BucketRow {
  bucket: string;
  n: number;
  contracts: number;
  wr: number;          // 0..1
  avg_pnl_per_share: number;
  total_pnl: number;
}

const PNL_EXPR = `
  CASE
    WHEN t.taker_side='yes' AND m.result='yes' THEN 1.0 - t.yes_price
    WHEN t.taker_side='yes' AND m.result='no'  THEN -t.yes_price
    WHEN t.taker_side='no'  AND m.result='no'  THEN 1.0 - t.no_price
    WHEN t.taker_side='no'  AND m.result='yes' THEN -t.no_price
  END
`;

// julianday() diff * 86400 = seconds between the two ISO8601 timestamps
const SECS_EXPR = `(julianday(m.close_time) - julianday(t.created_time)) * 86400.0`;

const TAKER_PAID_EXPR =
  `CASE WHEN t.taker_side='yes' THEN t.yes_price ELSE t.no_price END`;

function pad(s: string, len: number, right = false): string {
  if (s.length >= len) return s;
  const fill = " ".repeat(len - s.length);
  return right ? fill + s : s + fill;
}

function fmtMoney(n: number, signed = true, width = 8): string {
  const s = `${signed && n >= 0 ? "+" : ""}${n.toFixed(4)}`;
  return pad(s, width, true);
}

function fmtCommaInt(n: number): string {
  return Math.round(n).toLocaleString();
}

export class TapeAnalyzer {
  readonly db: Database;
  private out: (s: string) => void;

  constructor(dbPath: string, opts?: { log?: (s: string) => void }) {
    if (!existsSync(dbPath)) {
      throw new Error(`TapeAnalyzer: db not found at ${dbPath}`);
    }
    this.db = new Database(dbPath, { readonly: true });
    this.out = opts?.log ?? ((s) => console.log(s));
  }

  close(): void {
    this.db.close();
  }

  // ─── Summary counts ─────────────────────────────────────────────────

  counts(): { trades: number; markets: number } {
    const tr = this.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM trades").get();
    const mk = this.db.query<{ c: number }, []>(
      "SELECT COUNT(*) c FROM markets WHERE tape_collected_at IS NOT NULL",
    ).get();
    return { trades: tr?.c ?? 0, markets: mk?.c ?? 0 };
  }

  // ─── Overall row ────────────────────────────────────────────────────

  printOverall(): void {
    const r = this.db.query<{
      n: number; contracts: number; avg_pnl_per_share: number | null;
      total_pnl: number | null; wr: number | null;
    }, []>(`
      SELECT
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
    `).get();
    if (!r || !r.n) {
      this.out("(no data)");
      return;
    }
    this.out("=".repeat(70));
    this.out("OVERALL TAKER STATS (assume held to settlement)");
    this.out("=".repeat(70));
    this.out(`  fills:           ${fmtCommaInt(r.n)}`);
    this.out(`  contracts:       ${fmtCommaInt(r.contracts ?? 0)}`);
    this.out(`  taker WR:        ${((r.wr ?? 0) * 100).toFixed(2)}%`);
    this.out(`  avg PnL/share:   $${(r.avg_pnl_per_share ?? 0) >= 0 ? "+" : ""}${(r.avg_pnl_per_share ?? 0).toFixed(4)}`);
    this.out(`  total PnL:       $${(r.total_pnl ?? 0) >= 0 ? "+" : ""}${(r.total_pnl ?? 0).toFixed(2)}`);
    this.out("");
  }

  // ─── Bucket printer ─────────────────────────────────────────────────

  private printBucket(title: string, rows: BucketRow[]): void {
    this.out(`--- ${title} ---`);
    const header = `  ${pad("bucket", 22)} ${pad("fills", 8, true)} ${pad("contracts", 11, true)} ${pad("wr%", 7, true)} ${pad("pnl/sh", 9, true)} ${pad("pnl/ct", 9, true)} ${pad("total", 12, true)}`;
    this.out(header);
    this.out("  " + "-".repeat(header.length - 2));
    for (const r of rows) {
      const ct = r.contracts ?? 0;
      const wr = (r.wr ?? 0) * 100;
      const pps = r.avg_pnl_per_share ?? 0;
      const ppc = ct ? r.total_pnl / ct : 0;
      const tp = r.total_pnl ?? 0;
      this.out(
        `  ${pad(r.bucket, 22)} ${pad(fmtCommaInt(r.n), 8, true)} ${pad(fmtCommaInt(ct), 11, true)} ` +
        `${pad(wr.toFixed(2) + "%", 7, true)} ` +
        `$${fmtMoney(pps, true, 8)} $${fmtMoney(ppc, true, 8)} ` +
        `$${pad((tp >= 0 ? "+" : "") + tp.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","), 11, true)}`,
      );
    }
    this.out("");
  }

  // ─── By time-to-close ───────────────────────────────────────────────

  printByTime(): void {
    const rows = this.db.query<BucketRow & { mins: number }, []>(`
      SELECT
        CASE
          WHEN ${SECS_EXPR} < 30   THEN '0   <= t < 30s'
          WHEN ${SECS_EXPR} < 60   THEN '30  <= t < 60s'
          WHEN ${SECS_EXPR} < 120  THEN '60  <= t < 120s'
          WHEN ${SECS_EXPR} < 300  THEN '120 <= t < 5m'
          WHEN ${SECS_EXPR} < 600  THEN '5m  <= t < 10m'
          WHEN ${SECS_EXPR} < 1800 THEN '10m <= t < 30m'
          ELSE '30m+'
        END AS bucket,
        MIN(${SECS_EXPR}) mins,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY bucket
      ORDER BY mins
    `).all();
    this.printBucket(
      "BY TIME-TO-CLOSE (where in the life of the market did they buy?)",
      rows,
    );
  }

  // ─── By price ───────────────────────────────────────────────────────

  printByPrice(): void {
    const rows = this.db.query<BucketRow & { p: number }, []>(`
      SELECT
        CASE
          WHEN ${TAKER_PAID_EXPR} < 0.05 THEN '[0.00, 0.05)'
          WHEN ${TAKER_PAID_EXPR} < 0.15 THEN '[0.05, 0.15)'
          WHEN ${TAKER_PAID_EXPR} < 0.30 THEN '[0.15, 0.30)'
          WHEN ${TAKER_PAID_EXPR} < 0.50 THEN '[0.30, 0.50)'
          WHEN ${TAKER_PAID_EXPR} < 0.70 THEN '[0.50, 0.70)'
          WHEN ${TAKER_PAID_EXPR} < 0.85 THEN '[0.70, 0.85)'
          WHEN ${TAKER_PAID_EXPR} < 0.95 THEN '[0.85, 0.95)'
          ELSE                                '[0.95, 1.00]'
        END AS bucket,
        MIN(${TAKER_PAID_EXPR}) p,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY bucket
      ORDER BY p
    `).all();
    this.printBucket(
      "BY TAKER-PAID PRICE (did they pay cheap or expensive?)",
      rows,
    );
  }

  // ─── By fill size ───────────────────────────────────────────────────

  printBySize(): void {
    const rows = this.db.query<BucketRow & { s: number }, []>(`
      SELECT
        CASE
          WHEN t.count_fp <  10   THEN '[1, 10)'
          WHEN t.count_fp <  50   THEN '[10, 50)'
          WHEN t.count_fp <  200  THEN '[50, 200)'
          WHEN t.count_fp <  1000 THEN '[200, 1000)'
          ELSE                         '[1000+]'
        END AS bucket,
        MIN(t.count_fp) s,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY bucket
      ORDER BY s
    `).all();
    this.printBucket(
      "BY FILL SIZE (do big takers win more than small?)",
      rows,
    );
  }

  // ─── By strike type ─────────────────────────────────────────────────

  printByStrikeType(): void {
    const rows = this.db.query<BucketRow, []>(`
      SELECT
        COALESCE(m.strike_type, 'unknown') AS bucket,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY bucket ORDER BY bucket
    `).all();
    this.printBucket("BY STRIKE TYPE (greater vs between)", rows);
  }

  // ─── Taker side × result sanity check ──────────────────────────────

  printTakerSideByResult(): void {
    const rows = this.db.query<BucketRow, []>(`
      SELECT
        t.taker_side || ' -> ' || m.result AS bucket,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY bucket ORDER BY bucket
    `).all();
    this.printBucket(
      "TAKER SIDE x MARKET RESULT (sanity check + directional split)",
      rows,
    );
  }

  // ─── Time × price cross-tab ─────────────────────────────────────────

  printTimeXPrice(): void {
    const rows = this.db.query<{
      t_bucket: string; p_bucket: string; n: number;
      contracts: number | null; avg_pnl_per_share: number | null;
      total_pnl: number | null; wr: number | null;
    }, []>(`
      SELECT
        CASE
          WHEN ${SECS_EXPR} < 60   THEN '01_<60s'
          WHEN ${SECS_EXPR} < 300  THEN '02_<5m'
          WHEN ${SECS_EXPR} < 1800 THEN '03_<30m'
          ELSE                           '04_30m+'
        END AS t_bucket,
        CASE
          WHEN ${TAKER_PAID_EXPR} < 0.30 THEN 'A_<0.30'
          WHEN ${TAKER_PAID_EXPR} < 0.70 THEN 'B_0.30-0.70'
          WHEN ${TAKER_PAID_EXPR} < 0.95 THEN 'C_0.70-0.95'
          ELSE                                'D_>=0.95'
        END AS p_bucket,
        COUNT(*) n,
        SUM(t.count_fp) contracts,
        AVG(${PNL_EXPR}) avg_pnl_per_share,
        SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
        SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
      GROUP BY t_bucket, p_bucket
      ORDER BY t_bucket, p_bucket
    `).all();
    this.out("--- TIME x PRICE CROSS-TAB (where does edge live?) ---");
    this.out(
      `  ${pad("t_bucket", 10)} ${pad("p_bucket", 14)} ${pad("fills", 7, true)} ` +
      `${pad("contracts", 10, true)} ${pad("wr%", 7, true)} ${pad("pnl/sh", 9, true)} ` +
      `${pad("total", 12, true)}`,
    );
    this.out("  " + "-".repeat(76));
    for (const r of rows) {
      const wr = (r.wr ?? 0) * 100;
      this.out(
        `  ${pad(r.t_bucket, 10)} ${pad(r.p_bucket, 14)} ${pad(fmtCommaInt(r.n), 7, true)} ` +
        `${pad(fmtCommaInt(r.contracts ?? 0), 10, true)} ${pad(wr.toFixed(2) + "%", 7, true)} ` +
        `$${fmtMoney(r.avg_pnl_per_share ?? 0, true, 8)} ` +
        `$${pad(((r.total_pnl ?? 0) >= 0 ? "+" : "") + (r.total_pnl ?? 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","), 11, true)}`,
      );
    }
    this.out("");
  }

  // ─── Bot vs tape comparison ─────────────────────────────────────────

  printBotCompare(botDbPath: string): void {
    if (!existsSync(botDbPath)) {
      this.out(`(${botDbPath} not found — skipping bot comparison)`);
      return;
    }
    const botDb = new Database(botDbPath, { readonly: true });
    this.out("=".repeat(70));
    this.out("BOT vs TAPE — does our sniping beat the crowd?");
    this.out("=".repeat(70));

    const botRows = botDb.query<{
      model_name: string; n: number; wins: number;
      total_pnl: number | null; avg_pnl_per_share: number | null;
    }, []>(`
      SELECT model_name,
             COUNT(*) n,
             SUM(CASE WHEN (side='YES' AND outcome=1) OR (side='NO' AND outcome=0) THEN 1 ELSE 0 END) wins,
             SUM(pnl) total_pnl,
             AVG(pnl/shares) avg_pnl_per_share
      FROM live_trades WHERE window_id LIKE 'kalshi-snipe-%' AND outcome IS NOT NULL
      GROUP BY model_name ORDER BY model_name
    `).all();

    this.out("  Bot's resolved kalshi-snipe trades:");
    this.out(`  ${pad("bucket", 25)} ${pad("n", 4, true)} ${pad("wr%", 7, true)} ${pad("pnl/sh", 9, true)} ${pad("total", 8, true)}`);
    this.out("  " + "-".repeat(55));
    let totalN = 0, totalW = 0, totalPnl = 0;
    for (const r of botRows) {
      const wr = r.n ? (r.wins / r.n) * 100 : 0;
      const pps = r.avg_pnl_per_share ?? 0;
      this.out(
        `  ${pad(r.model_name, 25)} ${pad(String(r.n), 4, true)} ` +
        `${pad(wr.toFixed(1) + "%", 7, true)} ` +
        `$${fmtMoney(pps, true, 8)} ` +
        `$${pad(((r.total_pnl ?? 0) >= 0 ? "+" : "") + (r.total_pnl ?? 0).toFixed(2), 7, true)}`,
      );
      totalN += r.n; totalW += r.wins; totalPnl += r.total_pnl ?? 0;
    }
    if (totalN) {
      this.out(
        `  ${pad("TOTAL", 25)} ${pad(String(totalN), 4, true)} ` +
        `${pad((totalW / totalN * 100).toFixed(1) + "%", 7, true)} ` +
        `$${fmtMoney(totalPnl / totalN, true, 8)} ` +
        `$${pad((totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2), 7, true)}`,
      );
    } else {
      this.out("  (no resolved bot trades yet)");
    }

    // Same windows on the full tape
    const stages: Array<[string, number, number]> = [
      ["prime (<=120s)", 0, 120],
      ["late  (120-300s)", 120, 300],
      ["wide  (300-600s)", 300, 600],
    ];
    this.out("\n  Same time-to-close windows on the FULL tape (all takers):");
    this.out(
      `  ${pad("bucket", 25)} ${pad("fills", 7, true)} ${pad("wr%", 7, true)} ` +
      `${pad("pnl/sh", 9, true)} ${pad("total", 10, true)}`,
    );
    this.out("  " + "-".repeat(63));
    for (const [name, lo, hi] of stages) {
      const r = this.db.query<{
        n: number; contracts: number | null;
        avg_pnl_per_share: number | null; total_pnl: number | null;
        wr: number | null;
      }, [number, number]>(`
        SELECT
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG(${PNL_EXPR}) avg_pnl_per_share,
          SUM(t.count_fp * (${PNL_EXPR})) total_pnl,
          SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
          AND ${SECS_EXPR} BETWEEN ? AND ?
      `).get(lo, hi);
      const wr = (r?.wr ?? 0) * 100;
      const pps = r?.avg_pnl_per_share ?? 0;
      const tp = r?.total_pnl ?? 0;
      this.out(
        `  ${pad(name, 25)} ${pad(fmtCommaInt(r?.n ?? 0), 7, true)} ` +
        `${pad(wr.toFixed(2) + "%", 7, true)} ` +
        `$${fmtMoney(pps, true, 8)} ` +
        `$${pad((tp >= 0 ? "+" : "") + tp.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","), 9, true)}`,
      );
    }

    // Bot's typical price band
    const zone = this.db.query<{
      n: number; avg_pnl_per_share: number | null; wr: number | null;
    }, []>(`
      SELECT COUNT(*) n, AVG(${PNL_EXPR}) avg_pnl_per_share,
             SUM(CASE WHEN (${PNL_EXPR}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
      FROM trades t JOIN markets m ON t.ticker = m.ticker
      WHERE m.tape_collected_at IS NOT NULL
        AND ${TAKER_PAID_EXPR} BETWEEN 0.55 AND 0.95
        AND ${SECS_EXPR} BETWEEN 0 AND 600
    `).get();
    this.out("\n  Tape baseline in bot's entry zone (price 0.55-0.95, time 0-600s):");
    this.out(
      `    fills=${fmtCommaInt(zone?.n ?? 0)}  wr=${((zone?.wr ?? 0) * 100).toFixed(2)}%  ` +
      `avg_pnl/share=$${(zone?.avg_pnl_per_share ?? 0) >= 0 ? "+" : ""}${(zone?.avg_pnl_per_share ?? 0).toFixed(4)}`,
    );
    this.out("");
    botDb.close();
  }

  // ─── Convenience: full report ──────────────────────────────────────

  printFullReport(opts?: { botDbPath?: string }): void {
    const c = this.counts();
    if (!c.trades || !c.markets) {
      this.out(`No data in tape DB. Run TapeCollector first.`);
      return;
    }
    this.out(`Archive: ${c.trades.toLocaleString()} trades across ${c.markets} settled markets\n`);
    this.printOverall();
    this.printTakerSideByResult();
    this.printByTime();
    this.printByPrice();
    this.printBySize();
    this.printByStrikeType();
    this.printTimeXPrice();
    if (opts?.botDbPath) {
      this.printBotCompare(opts.botDbPath);
    }
  }
}
