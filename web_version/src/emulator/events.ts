import { DeviceId, EventKind, type SimEvent } from "./types";

/**
 * Приоритетная очередь событий. Порядок строго детерминирован:
 * (timestamp, deviceId, channelId) — без какой-либо зависимости от порядка вставки.
 */
export class EventQueue {
  private items: SimEvent[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  has(kind: EventKind): boolean {
    return this.items.some((e) => e.kind === kind);
  }

  list(): SimEvent[] {
    return [...this.items].sort(cmp);
  }

  /** Отменяет все события устройства/канала (перепрограммирование таймера и т.п.). */
  cancel(deviceId: DeviceId, channelId?: number): void {
    this.items = this.items.filter(
      (e) => e.deviceId !== deviceId || (channelId !== undefined && e.channelId !== channelId),
    );
  }

  schedule(timestamp: number, deviceId: DeviceId, channelId: number, kind: EventKind): void {
    this.items.push({ timestamp, deviceId, channelId, kind });
  }

  /** Ближайший timestamp или Infinity. */
  nextTimestamp(): number {
    let min = Infinity;
    for (const e of this.items) if (e.timestamp < min) min = e.timestamp;
    return min;
  }

  /** Все события со временем <= now, в каноническом порядке. */
  takeDue(now: number): SimEvent[] {
    if (this.items.length === 0) return [];
    const due: SimEvent[] = [];
    const rest: SimEvent[] = [];
    for (const e of this.items) (e.timestamp <= now ? due : rest).push(e);
    if (due.length === 0) return [];
    this.items = rest;
    due.sort(cmp);
    return due;
  }

  serialize(): SimEvent[] {
    return this.list();
  }

  restore(events: SimEvent[]): void {
    this.items = events.map((e) => ({ ...e }));
  }
}

export function cmp(a: SimEvent, b: SimEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.deviceId !== b.deviceId) return a.deviceId - b.deviceId;
  if (a.channelId !== b.channelId) return a.channelId - b.channelId;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

export { DeviceId, EventKind };
