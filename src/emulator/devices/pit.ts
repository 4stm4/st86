/**
 * КР580ВИ53 (≈ i8253): таймер, порты 0x40–0x43.
 * Устройство «ленивое»: текущее значение счётчика — чистая функция (t_now − t_load) mod period.
 */

export const PIT_DIVISOR = 4; // такт ВИ53 = такт ЦП / 4

export interface PitChannel {
  count: number; // начальное значение (0 = 65536)
  latched: number | null;
  mode: number;
  rw: number; // 1 = lo, 2 = hi, 3 = lo/hi
  writeState: 0 | 1; // для rw=3
  readState: 0 | 1;
  loadCycle: number;
  running: boolean;
  pendingLow: number;
}

export function newChannel(): PitChannel {
  return {
    count: 0,
    latched: null,
    mode: 3,
    rw: 3,
    writeState: 0,
    readState: 0,
    loadCycle: 0,
    running: false,
    pendingLow: 0,
  };
}

export class Pit {
  channels: PitChannel[] = [newChannel(), newChannel(), newChannel()];
  lastAccessCycle = -1e9;

  reset(): void {
    this.channels = [newChannel(), newChannel(), newChannel()];
    this.lastAccessCycle = -1e9;
  }

  periodCycles(ch: PitChannel): number {
    const n = ch.count === 0 ? 65536 : ch.count;
    return n * PIT_DIVISOR;
  }

  /** Чистая функция текущего значения счётчика. */
  currentCount(index: number, now: number): number {
    const ch = this.channels[index]!;
    if (!ch.running) return ch.count & 0xffff;
    const period = this.periodCycles(ch);
    const elapsed = (now - ch.loadCycle) % period;
    const remaining = period - elapsed;
    return Math.floor(remaining / PIT_DIVISOR) & 0xffff;
  }

  /** true, если канал был перепрограммирован и нужно переставить событие. */
  write(port: number, value: number, now: number): number | null {
    const v = value & 0xff;
    if (port === 0x43) {
      const index = (v >> 6) & 3;
      if (index === 3) return null; // read-back не поддерживается
      const ch = this.channels[index]!;
      const rw = (v >> 4) & 3;
      if (rw === 0) {
        ch.latched = this.currentCount(index, now);
        ch.readState = 0;
        return null;
      }
      ch.rw = rw;
      ch.mode = (v >> 1) & 7;
      ch.writeState = 0;
      ch.readState = 0;
      ch.running = false;
      return null;
    }
    const index = port - 0x40;
    const ch = this.channels[index]!;
    if (ch.rw === 1) {
      ch.count = v;
    } else if (ch.rw === 2) {
      ch.count = v << 8;
    } else {
      if (ch.writeState === 0) {
        ch.pendingLow = v;
        ch.writeState = 1;
        return null;
      }
      ch.count = (v << 8) | ch.pendingLow;
      ch.writeState = 0;
    }
    ch.loadCycle = now;
    ch.running = true;
    return index;
  }

  read(port: number, now: number): number {
    const index = port - 0x40;
    if (index < 0 || index > 2) return 0xff;
    const ch = this.channels[index]!;
    const value = ch.latched ?? this.currentCount(index, now);
    if (ch.rw === 1) {
      ch.latched = null;
      return value & 0xff;
    }
    if (ch.rw === 2) {
      ch.latched = null;
      return (value >> 8) & 0xff;
    }
    if (ch.readState === 0) {
      ch.readState = 1;
      return value & 0xff;
    }
    ch.readState = 0;
    ch.latched = null;
    return (value >> 8) & 0xff;
  }
}
