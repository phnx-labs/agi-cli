
import WSWebSocket from 'ws';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}

export function subscribe(source: MonitorSource, onObs: (obs: Observation) => void): () => void {
  const url = source.wsUrl;
  if (!url) return () => {};

  let closed = false;
  let socket: WSWebSocket | null = null;

  const connect = () => {
    if (closed) return;
    socket = new WSWebSocket(url, { maxPayload: 8 * 1024 * 1024 });
    socket.onmessage = (ev) => onObs({ raw: String(ev.data), meta: { kind: 'frame' } });
    socket.onclose = () => {
      if (!closed) setTimeout(connect, 5_000);
    };
    socket.onerror = () => {
      try { socket?.close(); } catch {  }
    };
  };
  connect();

  return () => {
    closed = true;
    try { socket?.close(); } catch {  }
  };
}
