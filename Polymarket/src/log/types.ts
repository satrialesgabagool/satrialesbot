export type LogColor = "green" | "yellow" | "red" | "cyan" | "dim" | "reset";

export type LogEntryType =
  | "slot_start"
  | "slot_end"
  | "orderbook_snapshot"
  | "btc_ticker"
  | "market_price"
  | "order_placed"
  | "order_filled"
  | "order_expired"
  | "order_failed"
  | "order_canceled"
  | "signal"
  | "resolution"
  | "info"
  | "error";

export interface LogEntry {
  type: LogEntryType;
  timestamp: number;
  data: Record<string, unknown>;
}
