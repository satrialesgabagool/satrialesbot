/**
 * Kalshi fee structure.
 *
 * Kalshi charges a fee on WINNING trades only, assessed as a fraction of
 * NET WINNINGS (payout − stake), not gross payout.
 *
 * Example:
 *   Buy 100 YES contracts at $0.42. Market resolves YES (win).
 *   Gross payout      = 100 × $1.00 = $100.00
 *   Stake             = 100 × $0.42 = $42.00
 *   Net winnings      = $100.00 − $42.00 = $58.00
 *   Fee (7%)          = $58.00 × 0.07 = $4.06
 *   Net P&L           = Net winnings − Fee = $58.00 − $4.06 = $53.94
 *   Realized proceeds = Stake returned ($42) + Net P&L ($53.94) = $95.94
 *
 * Losing trades pay no fee: P&L = −stake.
 */

export const KALSHI_FEE_RATE = 0.07;

/**
 * Fee charged on a closed position. Only winning trades pay a fee, and only
 * on the winnings (not on the stake the trader already had skin in).
 */
export function kalshiFee(
  contracts: number,
  entryPrice: number,
  won: boolean,
  feeRate: number = KALSHI_FEE_RATE,
): number {
  if (!won) return 0;
  const netWinningsPerContract = Math.max(0, 1.0 - entryPrice);
  const fee = contracts * netWinningsPerContract * feeRate;
  return Math.round(fee * 100) / 100;
}

/**
 * Net P&L after Kalshi fees for a single binary-outcome position.
 *
 *   won:   grossPayout − stake − fee
 *   lost:  −stake (no fee charged)
 */
export function kalshiNetPnl(
  contracts: number,
  entryPrice: number,
  won: boolean,
  feeRate: number = KALSHI_FEE_RATE,
): number {
  const stake = contracts * entryPrice;
  if (!won) return Math.round(-stake * 100) / 100;
  const grossPayout = contracts * 1.0;
  const fee = kalshiFee(contracts, entryPrice, true, feeRate);
  return Math.round((grossPayout - stake - fee) * 100) / 100;
}
