import { DEFAULT_WAIT_STATES, type WaitStates } from "./types";

export const MEM_SIZE = 1 << 20;
export const ADDR_MASK = 0xfffff;

/** Физический адрес 8086: ((segment << 4) + offset) & 0xFFFFF (wraparound, линии A20 нет). */
export function physAddr(segment: number, offset: number): number {
  return (((segment & 0xffff) << 4) + (offset & 0xffff)) & ADDR_MASK;
}

export interface RomViolation {
  addr: number;
  value: number;
}

export class Memory {
  readonly data: Uint8Array;
  /** битовая карта ROM: 1 бит на байт */
  readonly rom: Uint8Array;
  romViolations: RomViolation[] = [];
  waitStates: WaitStates;

  constructor(waitStates: WaitStates = DEFAULT_WAIT_STATES) {
    this.data = new Uint8Array(MEM_SIZE);
    this.rom = new Uint8Array(MEM_SIZE >> 3);
    this.waitStates = waitStates;
  }

  isRom(addr: number): boolean {
    const a = addr & ADDR_MASK;
    return (this.rom[a >> 3]! & (1 << (a & 7))) !== 0;
  }

  markRom(start: number, length: number): void {
    for (let i = 0; i < length; i++) {
      const a = (start + i) & ADDR_MASK;
      this.rom[a >> 3]! |= 1 << (a & 7);
    }
  }

  clearRom(): void {
    this.rom.fill(0);
    this.romViolations = [];
  }

  read8(addr: number): number {
    return this.data[addr & ADDR_MASK]!;
  }

  read16(addr: number): number {
    const a = addr & ADDR_MASK;
    const b = (addr + 1) & ADDR_MASK;
    return this.data[a]! | (this.data[b]! << 8);
  }

  write8(addr: number, value: number): void {
    const a = addr & ADDR_MASK;
    if (this.isRom(a)) {
      if (this.romViolations.length < 64) {
        this.romViolations.push({ addr: a, value: value & 0xff });
      }
      return;
    }
    this.data[a] = value & 0xff;
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, (value >> 8) & 0xff);
  }

  /** Такты ожидания для доступа к памяти по области. */
  accessWaitStates(addr: number): number {
    return this.isRom(addr) ? this.waitStates.rom : this.waitStates.ram;
  }

  load(bytes: Uint8Array, at: number): void {
    for (let i = 0; i < bytes.length; i++) {
      this.data[(at + i) & ADDR_MASK] = bytes[i]!;
    }
  }

  /** Хэш-независимый снимок для снапшотов. */
  snapshot(): Uint8Array {
    return this.data.slice();
  }

  restore(snap: Uint8Array): void {
    this.data.set(snap);
  }
}
