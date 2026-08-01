/**
 * Видеоплата на RP2040. Кадрового буфера в адресном пространстве 8086 нет —
 * только поток команд через FIFO на портах в/в. Уровень L0: валидатор протокола,
 * хэш командного потока, счётчики, простой потребителя.
 */
import { sha256 } from "../hash";

export const FIFO_CAPACITY = 512;
export const FIFO_LOW_WATERMARK = 128; // «нижняя отметка заполнения», не «пусто»
export const RP2040_NUM = 1; // t_rp2040 = t_master * num / den
export const RP2040_DEN = 1;

/** Таблица длин полезной нагрузки команд (опкод самоограничен: опкод + длина). */
export const VIDEO_COMMANDS: Record<number, { name: string; payload: number; cost: number }> = {
  0x01: { name: "NOP", payload: 0, cost: 4 },
  0x02: { name: "CLEAR", payload: 1, cost: 2000 },
  0x03: { name: "SET_COLOR", payload: 2, cost: 8 },
  0x04: { name: "MOVE_TO", payload: 4, cost: 12 },
  0x05: { name: "LINE_TO", payload: 4, cost: 200 },
  0x06: { name: "RECT", payload: 8, cost: 600 },
  0x07: { name: "TEXT", payload: 3, cost: 300 },
  0x08: { name: "FLUSH", payload: 0, cost: 40 },
  0x09: { name: "CAPS_QUERY", payload: 0, cost: 20 },
  0xff: { name: "ESCAPE_RESYNC", payload: 0, cost: 4 },
};

export interface VideoViolation {
  cycle: number;
  text: string;
}

export class VideoFifo {
  private _buf = new Uint8Array(FIFO_CAPACITY);
  private _head = 0;
  private _count = 0;
  reserved = 0;
  commandCount = 0;
  opcodeHistogram: Record<number, number> = {};
  idleCycles = 0;
  overflowFlagInjected = false;
  violations: VideoViolation[] = [];
  vsyncCount = 0;
  private stream: number[] = [];
  decodeNeed = 0;
  decodeOpcode = -1;
  lastDrainCycle = 0;

  get bytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this._count; i++) out.push(this._buf[(this._head + i) % FIFO_CAPACITY]!);
    return out;
  }
  set bytes(arr: number[]) {
    this._head = 0;
    this._count = Math.min(arr.length, FIFO_CAPACITY);
    for (let i = 0; i < this._count; i++) this._buf[i] = arr[i]!;
  }

  reset(): void {
    this._head = 0;
    this._count = 0;
    this.reserved = 0;
    this.commandCount = 0;
    this.opcodeHistogram = {};
    this.idleCycles = 0;
    this.overflowFlagInjected = false;
    this.violations = [];
    this.vsyncCount = 0;
    this.stream = [];
    this.decodeNeed = 0;
    this.decodeOpcode = -1;
    this.lastDrainCycle = 0;
  }

  get free(): number {
    return Math.max(0, FIFO_CAPACITY - this._count - this.reserved);
  }

  /** Дисциплина «сначала резервируй, потом пиши»: запись в 0xE1. */
  reserve(count: number, cycle: number): void {
    if (count > this.free) {
      this.violation(cycle, `резервирование ${count} Б при свободных ${this.free} Б`);
      return;
    }
    this.reserved += count;
  }

  write(byte: number, cycle: number): void {
    if (this.reserved <= 0) {
      this.violation(cycle, `запись байта 0x${byte.toString(16)} без резервирования`);
    } else {
      this.reserved -= 1;
    }
    if (this._count >= FIFO_CAPACITY) {
      this.violation(cycle, "переполнение FIFO (байт отброшен)");
      return;
    }
    const b = byte & 0xff;
    this._buf[(this._head + this._count) % FIFO_CAPACITY] = b;
    this._count++;
    this.stream.push(b);
  }

  violation(cycle: number, text: string): void {
    if (this.violations.length < 128) this.violations.push({ cycle, text });
  }

  /** Потребление одного байта потребителем RP2040; возвращает стоимость в тактах master. */
  consume(cycle: number): number {
    if (this._count === 0) {
      return 0;
    }
    const byte = this._buf[this._head]!;
    this._head = (this._head + 1) % FIFO_CAPACITY;
    this._count--;
    if (this.decodeNeed > 0) {
      this.decodeNeed -= 1;
      if (this.decodeNeed === 0) {
        this.commandCount += 1;
        const cmd = VIDEO_COMMANDS[this.decodeOpcode];
        return Math.round(((cmd?.cost ?? 8) * RP2040_DEN) / RP2040_NUM);
      }
      return 4;
    }
    const cmd = VIDEO_COMMANDS[byte];
    if (!cmd) {
      this.violation(cycle, `неизвестный опкод 0x${byte.toString(16)} — нужна ESCAPE-ресинхронизация`);
      return 4;
    }
    this.opcodeHistogram[byte] = (this.opcodeHistogram[byte] ?? 0) + 1;
    this.decodeOpcode = byte;
    if (cmd.payload === 0) {
      this.commandCount += 1;
      return Math.round((cmd.cost * RP2040_DEN) / RP2040_NUM);
    }
    this.decodeNeed = cmd.payload;
    return 4;
  }

  streamHash(): string {
    return `sha256:${sha256(Uint8Array.from(this.stream))}`;
  }

  streamBytes(): Uint8Array {
    return Uint8Array.from(this.stream);
  }

  belowWatermark(): boolean {
    return this._count <= FIFO_LOW_WATERMARK;
  }
}
