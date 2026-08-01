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
  bytes: number[] = [];
  reserved = 0;
  commandCount = 0;
  opcodeHistogram: Record<number, number> = {};
  idleCycles = 0;
  overflowFlagInjected = false;
  violations: VideoViolation[] = [];
  vsyncCount = 0;
  private stream: number[] = [];
  private decodeNeed = 0;
  private decodeOpcode = -1;
  lastDrainCycle = 0;

  reset(): void {
    this.bytes = [];
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
    return Math.max(0, FIFO_CAPACITY - this.bytes.length - this.reserved);
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
    if (this.bytes.length >= FIFO_CAPACITY) {
      this.violation(cycle, "переполнение FIFO (байт отброшен)");
      return;
    }
    this.bytes.push(byte & 0xff);
    this.stream.push(byte & 0xff);
  }

  violation(cycle: number, text: string): void {
    if (this.violations.length < 128) this.violations.push({ cycle, text });
  }

  /** Потребление одного байта потребителем RP2040; возвращает стоимость в тактах master. */
  consume(cycle: number): number {
    const byte = this.bytes.shift();
    if (byte === undefined) {
      return 0;
    }
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
    return this.bytes.length <= FIFO_LOW_WATERMARK;
  }
}
