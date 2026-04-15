type WSMessage = string | Buffer;

export interface ReconnectingWSOptions {
  url: string;
  onMessage: (data: WSMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private opts: Required<ReconnectingWSOptions>;
  private retries = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ReconnectingWSOptions) {
    this.opts = {
      maxRetries: 10,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
      onOpen: () => {},
      onClose: () => {},
      onError: () => {},
      ...opts,
    };
  }

  connect(): void {
    if (this.closed) return;

    this.ws = new WebSocket(this.opts.url);

    this.ws.onopen = () => {
      this.retries = 0;
      this.opts.onOpen!();
    };

    this.ws.onmessage = (event) => {
      this.opts.onMessage(typeof event.data === "string" ? event.data : (event.data as Buffer));
    };

    this.ws.onclose = () => {
      this.opts.onClose!();
      if (!this.closed) this.scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      this.opts.onError!(new Error(`WebSocket error: ${this.opts.url}`));
    };
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.retries >= this.opts.maxRetries) {
      this.opts.onError!(new Error(`Max reconnect retries (${this.opts.maxRetries}) exceeded`));
      return;
    }

    const backoff = Math.min(
      this.opts.initialBackoffMs * Math.pow(2, this.retries),
      this.opts.maxBackoffMs,
    );
    this.retries++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff);
  }
}
