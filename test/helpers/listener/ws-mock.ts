type WsEventMap = {
  open: Record<string, never>;
  close: Record<string, never>;
  error: { data?: unknown };
  message: { data?: unknown };
};

type WsEventHandler = (event: WsEventMap[keyof WsEventMap]) => void;

export class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  url?: string;
  private readonly keepListeners: boolean;
  private listeners = new Map<keyof WsEventMap, Set<WsEventHandler>>();

  constructor({ keepListeners = false }: { keepListeners?: boolean } = {}) {
    this.keepListeners = keepListeners;
  }

  addEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    const bucket = this.listeners.get(type) ?? new Set<WsEventHandler>();
    bucket.add(listener as WsEventHandler);
    this.listeners.set(type, bucket);
  }

  removeEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    if (this.keepListeners) {
      return;
    }
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    bucket.delete(listener as WsEventHandler);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  emit<K extends keyof WsEventMap>(type: K, event: WsEventMap[K]) {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      handler(event);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }
}
