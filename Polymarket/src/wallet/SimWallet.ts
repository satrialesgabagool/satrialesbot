/**
 * Simulated wallet for paper trading.
 * Tracks USDC balance and share positions with reservations.
 */
export class SimWallet {
  private balance: number;
  private reservedBalance: number = 0;
  private shares: Map<string, number> = new Map();
  private reservedShares: Map<string, number> = new Map();

  constructor(initialBalanceUsdc: number) {
    this.balance = initialBalanceUsdc;
  }

  /** Available USDC (total minus reserved). */
  get availableBalance(): number {
    return this.balance - this.reservedBalance;
  }

  /** Total USDC balance. */
  get totalBalance(): number {
    return this.balance;
  }

  /** Reserve USDC for a pending buy order. */
  reserveBalance(amount: number): boolean {
    if (amount > this.availableBalance) return false;
    this.reservedBalance += amount;
    return true;
  }

  /** Release a reservation (order canceled). */
  releaseBalance(amount: number): void {
    this.reservedBalance = Math.max(0, this.reservedBalance - amount);
  }

  /** Debit USDC (buy order filled). Also releases the reservation. */
  debit(amount: number): void {
    this.balance -= amount;
    this.reservedBalance = Math.max(0, this.reservedBalance - amount);
  }

  /** Credit USDC (sell order filled). */
  credit(amount: number): void {
    this.balance += amount;
  }

  /** Get shares held for a token. */
  getShares(tokenId: string): number {
    return this.shares.get(tokenId) ?? 0;
  }

  /** Available shares (total minus reserved for sells). */
  getAvailableShares(tokenId: string): number {
    const total = this.shares.get(tokenId) ?? 0;
    const reserved = this.reservedShares.get(tokenId) ?? 0;
    return total - reserved;
  }

  /** Add shares (buy filled). */
  addShares(tokenId: string, amount: number): void {
    const current = this.shares.get(tokenId) ?? 0;
    this.shares.set(tokenId, current + amount);
  }

  /** Reserve shares for a pending sell order. */
  reserveShares(tokenId: string, amount: number): boolean {
    if (amount > this.getAvailableShares(tokenId)) return false;
    const current = this.reservedShares.get(tokenId) ?? 0;
    this.reservedShares.set(tokenId, current + amount);
    return true;
  }

  /** Release share reservation (sell order canceled). */
  releaseShares(tokenId: string, amount: number): void {
    const current = this.reservedShares.get(tokenId) ?? 0;
    this.reservedShares.set(tokenId, Math.max(0, current - amount));
  }

  /** Remove shares (sell filled). Also releases the reservation. */
  removeShares(tokenId: string, amount: number): void {
    const current = this.shares.get(tokenId) ?? 0;
    this.shares.set(tokenId, Math.max(0, current - amount));
    this.releaseShares(tokenId, amount);
  }

  /** Resolve shares at market close. Winning side pays $1/share. */
  resolveShares(tokenId: string, won: boolean): number {
    const amount = this.shares.get(tokenId) ?? 0;
    if (amount === 0) return 0;

    this.shares.set(tokenId, 0);
    this.reservedShares.set(tokenId, 0);

    if (won) {
      this.balance += amount; // $1.00 per share
      return amount;
    }
    return 0;
  }

  /** Get a summary for logging. */
  summary(): { balance: number; available: number; positions: Record<string, number> } {
    const positions: Record<string, number> = {};
    for (const [tokenId, amount] of this.shares) {
      if (amount > 0) positions[tokenId] = amount;
    }
    return {
      balance: this.balance,
      available: this.availableBalance,
      positions,
    };
  }
}
