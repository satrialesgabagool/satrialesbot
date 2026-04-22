import type { SignalEvent, SignalSource, SignalKind, LiquidationPayload } from "../types";
import { ReconnectingWebSocket } from "../../net/ReconnectingWebSocket";

/**
 * Binance Futures liquidation stream — real-time WebSocket, no auth.
 *
 * Emits every forced liquidation on BTCUSDT perpetual futures.
 * Large liquidation cascades are the #1 predictor of 5-minute BTC
 * direction — a $5M+ long liquidation cluster almost always means
 * the next 5-minute candle is red.
 *
 * The SignalSnapshot.bias uses net long/short liquidation volume
 * over a 5-minute rolling window as a contrarian signal.
 */

const LIQUIDATION_WS = "wss://fstream.binance.com/ws/btcusdt@forceOrder";

interface BinanceLiquidation {
  e: "forceOrder";
  o: {
    s: string;   // Symbol (BTCUSDT)
    S: string;   // Side (SELL = long liq, BUY = short liq)
    q: string;   // Quantity
    p: string;   // Price
    ap: string;  // Average price
    T: number;   // Trade time
  };
}

export class LiquidationSource implements SignalSource {
  readonly name = "binance-liquidations";
  readonly kinds: SignalKind[] = ["liquidation"];

  emit?: (event: SignalEvent) => void;

  private ws: ReconnectingWebSocket | null = null;

  async start(): Promise<void> {
    this.ws = new ReconnectingWebSocket({
      url: LIQUIDATION_WS,
      onMessage: (data) => {
        try {
          const msg: BinanceLiquidation = JSON.parse(
            typeof data === "string" ? data : data.toString(),
          );
          if (msg.e !== "forceOrder") return;
          if (msg.o.s !== "BTCUSDT") return;

          const qty = parseFloat(msg.o.q);
          const price = parseFloat(msg.o.ap) || parseFloat(msg.o.p);
          const amountUsd = qty * price;

          // Binance liquidation sides: SELL = long position liquidated,
          // BUY = short position liquidated
          const side: "long" | "short" = msg.o.S === "SELL" ? "long" : "short";

          const payload: LiquidationPayload = {
            symbol: "BTCUSDT",
            side,
            amountUsd,
            exchange: "binance",
            timestamp: msg.o.T,
          };

          this.emit?.({
            kind: "liquidation",
            payload,
            timestamp: msg.o.T,
            receivedAt: Date.now(),
            source: this.name,
          });
        } catch {}
      },
      onError: (err) => {
        console.error(`[${this.name}] WebSocket error:`, err.message);
      },
    });

    this.ws.connect();
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }
}
