import type { WsEvent } from '@hydro/shared-types';

/**
 * Minimal pub/sub for WebSocket clients.
 *
 * Real-time progress for long-running analyses, model runs and Copilot tool
 * execution is delivered here. Clients subscribe by project so that a busy
 * deployment does not broadcast one team's model logs to another.
 */
export class EventBus {
  private clients = new Map<string, Set<{ send: (data: string) => void }>>();

  subscribe(projectId: string, socket: { send: (data: string) => void }): () => void {
    if (!this.clients.has(projectId)) this.clients.set(projectId, new Set());
    this.clients.get(projectId)!.add(socket);
    return () => {
      this.clients.get(projectId)?.delete(socket);
      if (this.clients.get(projectId)?.size === 0) this.clients.delete(projectId);
    };
  }

  publish(projectId: string, event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.clients.get(projectId) ?? []) {
      try {
        socket.send(payload);
      } catch {
        // A dead socket is dropped on its own close handler; nothing to do here.
      }
    }
  }

  broadcast(event: WsEvent): void {
    const payload = JSON.stringify(event);
    for (const set of this.clients.values()) {
      for (const socket of set) {
        try {
          socket.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }

  get connectionCount(): number {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }
}
