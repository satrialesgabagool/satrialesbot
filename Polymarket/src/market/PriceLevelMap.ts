import { OrderedMap } from "@js-sdsl/ordered-map";

export type PriceLevelOrder = "asc" | "desc";

/**
 * A sorted map of price -> size using a Red-Black Tree.
 * - "asc" for asks (lowest price first)
 * - "desc" for bids (highest price first)
 */
export class PriceLevelMap {
  private map: OrderedMap<number, number>;
  private order: PriceLevelOrder;

  constructor(order: PriceLevelOrder) {
    this.order = order;
    const cmp = order === "asc" ? (a: number, b: number) => a - b : (a: number, b: number) => b - a;
    this.map = new OrderedMap<number, number>([], cmp);
  }

  /** Set the size at a price level. Removes if size is 0. */
  set(price: number, size: number): void {
    if (size <= 0) {
      this.map.eraseElementByKey(price);
    } else {
      this.map.setElement(price, size);
    }
  }

  /** Get the size at a price level. Returns 0 if not present. */
  get(price: number): number {
    const it = this.map.find(price);
    if (it.equals(this.map.end())) return 0;
    return it.pointer[1];
  }

  /** Remove a price level. */
  delete(price: number): void {
    this.map.eraseElementByKey(price);
  }

  /** Get the best (first) price level, or null if empty. */
  best(): { price: number; size: number } | null {
    if (this.map.size() === 0) return null;
    const it = this.map.begin();
    const [price, size] = it.pointer;
    return { price, size };
  }

  /** Get the top N levels. */
  topLevels(n: number): Array<{ price: number; size: number }> {
    const levels: Array<{ price: number; size: number }> = [];
    let count = 0;
    for (const [price, size] of this.map) {
      if (count >= n) break;
      levels.push({ price, size });
      count++;
    }
    return levels;
  }

  /** Total size across all levels. */
  totalSize(): number {
    let total = 0;
    for (const [, size] of this.map) {
      total += size;
    }
    return total;
  }

  /** Total size up to a given price (inclusive). For asks: up to price. For bids: down to price. */
  sizeUpTo(targetPrice: number): number {
    let total = 0;
    for (const [price, size] of this.map) {
      if (this.order === "asc" && price > targetPrice) break;
      if (this.order === "desc" && price < targetPrice) break;
      total += size;
    }
    return total;
  }

  /** Number of price levels. */
  get size(): number {
    return this.map.size();
  }

  /** Clear all levels. */
  clear(): void {
    this.map.clear();
  }

  /** Iterate all levels in sorted order. */
  *[Symbol.iterator](): IterableIterator<[number, number]> {
    for (const entry of this.map) {
      yield entry;
    }
  }
}
