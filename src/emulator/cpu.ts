/**
 * Ядро КР1810ВМ86 (8086), реальный режим.
 * EU — семантика инструкций, BIU — шина, очередь предвыборки 6 байт, T-состояния.
 */
import { physAddr } from "./memory";

export const FLAG_CF = 0x0001;
export const FLAG_PF = 0x0004;
export const FLAG_AF = 0x0010;
export const FLAG_ZF = 0x0040;
export const FLAG_SF = 0x0080;
export const FLAG_TF = 0x0100;
export const FLAG_IF = 0x0200;
export const FLAG_DF = 0x0400;
export const FLAG_OF = 0x0800;

export const REG_AX = 0,
  REG_CX = 1,
  REG_DX = 2,
  REG_BX = 3,
  REG_SP = 4,
  REG_BP = 5,
  REG_SI = 6,
  REG_DI = 7;
export const SEG_ES = 0,
  SEG_CS = 1,
  SEG_SS = 2,
  SEG_DS = 3;

export interface Bus {
  memRead8(addr: number): number;
  memRead16(addr: number): number;
  memWrite8(addr: number, value: number): void;
  memWrite16(addr: number, value: number): void;
  portIn8(port: number): number;
  portIn16(port: number): number;
  portOut8(port: number, value: number): void;
  portOut16(port: number, value: number): void;
  /** Добавить такты ожидания шины для доступа по адресу. */
  memWait(addr: number): number;
  ioWait(port: number): number;
  /** Сигнал HLT. */
  onHalt(): void;
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) c++;
  PARITY[i] = c % 2 === 0 ? 1 : 0;
}

export interface EffectiveAddress {
  isReg: boolean;
  reg: number;
  seg: number;
  off: number;
}

export class Cpu {
  regs = new Uint16Array(8);
  segs = new Uint16Array(4);
  ip = 0;
  flags = 0x0002;
  halted = false;
  /** тень STI/MOV SS: прерывания не принимаются после этих инструкций */
  intShadow = false;
  /** очередь предвыборки BIU (6 байт) */
  prefetch: number[] = [];
  prefetchAddr = 0;
  cycles = 0;
  instructions = 0;
  /** активна ли строковая инструкция с rep между итерациями */
  inRepIteration = false;

  private segOverride = -1;
  private repPrefix = 0; // 0 нет, 0xF2 repne, 0xF3 rep/repe
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.segs.fill(0);
    this.segs[SEG_CS] = 0xffff;
    this.ip = 0x0000;
    this.flags = 0x0002;
    this.halted = false;
    this.intShadow = false;
    this.prefetch = [];
    this.cycles = 0;
    this.instructions = 0;
    this.inRepIteration = false;
  }

  // ---- регистры ----
  getReg8(i: number): number {
    const r = this.regs[i & 3]!;
    return i < 4 ? r & 0xff : (r >> 8) & 0xff;
  }
  setReg8(i: number, v: number): void {
    const idx = i & 3;
    const cur = this.regs[idx]!;
    this.regs[idx] = i < 4 ? (cur & 0xff00) | (v & 0xff) : (cur & 0x00ff) | ((v & 0xff) << 8);
  }
  getFlag(mask: number): boolean {
    return (this.flags & mask) !== 0;
  }
  setFlag(mask: number, on: boolean): void {
    if (on) this.flags |= mask;
    else this.flags &= ~mask;
  }

  // ---- BIU: предвыборка ----
  private fetch8(): number {
    const addr = physAddr(this.segs[SEG_CS]!, this.ip);
    this.ip = (this.ip + 1) & 0xffff;
    this.cycles += this.bus.memWait(addr);
    if (this.prefetch.length > 0 && this.prefetchAddr === addr) {
      this.prefetchAddr = (addr + 1) & 0xfffff;
      return this.prefetch.shift()!;
    }
    this.prefetch = [];
    this.prefetchAddr = (addr + 1) & 0xfffff;
    return this.bus.memRead8(addr);
  }
  private fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }
  /** Наполнение очереди предвыборки во время «свободных» тактов шины. */
  fillPrefetch(): void {
    while (this.prefetch.length < 6) {
      const addr = (physAddr(this.segs[SEG_CS]!, this.ip) + this.prefetch.length) & 0xfffff;
      if (this.prefetch.length === 0) this.prefetchAddr = addr;
      this.prefetch.push(this.bus.memRead8(addr));
    }
  }
  flushPrefetch(): void {
    this.prefetch = [];
  }

  // ---- адресация ----
  private defaultSeg(base: number): number {
    return base === REG_BP || base === -2 ? SEG_SS : SEG_DS;
  }

  private modrm(): { mod: number; reg: number; rm: number; ea: EffectiveAddress } {
    const b = this.fetch8();
    const mod = (b >> 6) & 3;
    const reg = (b >> 3) & 7;
    const rm = b & 7;
    if (mod === 3) {
      return { mod, reg, rm, ea: { isReg: true, reg: rm, seg: 0, off: 0 } };
    }
    let off = 0;
    let seg = SEG_DS;
    switch (rm) {
      case 0:
        off = this.regs[REG_BX]! + this.regs[REG_SI]!;
        break;
      case 1:
        off = this.regs[REG_BX]! + this.regs[REG_DI]!;
        break;
      case 2:
        off = this.regs[REG_BP]! + this.regs[REG_SI]!;
        seg = SEG_SS;
        break;
      case 3:
        off = this.regs[REG_BP]! + this.regs[REG_DI]!;
        seg = SEG_SS;
        break;
      case 4:
        off = this.regs[REG_SI]!;
        break;
      case 5:
        off = this.regs[REG_DI]!;
        break;
      case 6:
        if (mod === 0) {
          off = this.fetch16();
        } else {
          off = this.regs[REG_BP]!;
          seg = SEG_SS;
        }
        break;
      case 7:
        off = this.regs[REG_BX]!;
        break;
    }
    if (mod === 1) off += (this.fetch8() << 24) >> 24;
    else if (mod === 2) off += this.fetch16();
    if (this.segOverride >= 0) seg = this.segOverride;
    return { mod, reg, rm, ea: { isReg: false, reg: 0, seg, off: off & 0xffff } };
  }

  private readEa8(ea: EffectiveAddress): number {
    if (ea.isReg) return this.getReg8(ea.reg);
    const a = physAddr(this.segs[ea.seg]!, ea.off);
    this.cycles += this.bus.memWait(a);
    return this.bus.memRead8(a);
  }
  private readEa16(ea: EffectiveAddress): number {
    if (ea.isReg) return this.regs[ea.reg]!;
    const a = physAddr(this.segs[ea.seg]!, ea.off);
    this.cycles += this.bus.memWait(a);
    return this.bus.memRead16(a);
  }
  private writeEa8(ea: EffectiveAddress, v: number): void {
    if (ea.isReg) return this.setReg8(ea.reg, v);
    const a = physAddr(this.segs[ea.seg]!, ea.off);
    this.cycles += this.bus.memWait(a);
    this.bus.memWrite8(a, v);
  }
  private writeEa16(ea: EffectiveAddress, v: number): void {
    if (ea.isReg) {
      this.regs[ea.reg] = v & 0xffff;
      return;
    }
    const a = physAddr(this.segs[ea.seg]!, ea.off);
    this.cycles += this.bus.memWait(a);
    this.bus.memWrite16(a, v);
  }

  // ---- стек ----
  push16(v: number): void {
    this.regs[REG_SP] = (this.regs[REG_SP]! - 2) & 0xffff;
    const a = physAddr(this.segs[SEG_SS]!, this.regs[REG_SP]!);
    this.cycles += this.bus.memWait(a);
    this.bus.memWrite16(a, v);
  }
  pop16(): number {
    const a = physAddr(this.segs[SEG_SS]!, this.regs[REG_SP]!);
    this.cycles += this.bus.memWait(a);
    const v = this.bus.memRead16(a);
    this.regs[REG_SP] = (this.regs[REG_SP]! + 2) & 0xffff;
    return v;
  }

  // ---- флаги ----
  private setLogicFlags(res: number, w: boolean): void {
    const mask = w ? 0xffff : 0xff;
    const r = res & mask;
    this.setFlag(FLAG_CF, false);
    this.setFlag(FLAG_OF, false);
    this.setFlag(FLAG_ZF, r === 0);
    this.setFlag(FLAG_SF, (r & (w ? 0x8000 : 0x80)) !== 0);
    this.setFlag(FLAG_PF, PARITY[r & 0xff] === 1);
    this.setFlag(FLAG_AF, false);
  }
  private setAddFlags(a: number, b: number, res: number, w: boolean, carryIn = 0): void {
    const mask = w ? 0xffff : 0xff;
    const sign = w ? 0x8000 : 0x80;
    const r = res & mask;
    this.setFlag(FLAG_CF, res > mask);
    this.setFlag(FLAG_ZF, r === 0);
    this.setFlag(FLAG_SF, (r & sign) !== 0);
    this.setFlag(FLAG_PF, PARITY[r & 0xff] === 1);
    this.setFlag(FLAG_AF, ((a ^ b ^ r) & 0x10) !== 0);
    this.setFlag(FLAG_OF, ((~(a ^ b) & (a ^ r)) & sign) !== 0);
    void carryIn;
  }
  private setSubFlags(a: number, b: number, res: number, w: boolean): void {
    const mask = w ? 0xffff : 0xff;
    const sign = w ? 0x8000 : 0x80;
    const r = res & mask;
    this.setFlag(FLAG_CF, (res & ~mask) !== 0 || res < 0);
    this.setFlag(FLAG_ZF, r === 0);
    this.setFlag(FLAG_SF, (r & sign) !== 0);
    this.setFlag(FLAG_PF, PARITY[r & 0xff] === 1);
    this.setFlag(FLAG_AF, ((a ^ b ^ r) & 0x10) !== 0);
    this.setFlag(FLAG_OF, (((a ^ b) & (a ^ r)) & sign) !== 0);
  }

  private alu(op: number, a: number, b: number, w: boolean): number {
    const mask = w ? 0xffff : 0xff;
    let res = 0;
    switch (op) {
      case 0: // ADD
        res = a + b;
        this.setAddFlags(a, b, res, w);
        break;
      case 1: // OR
        res = a | b;
        this.setLogicFlags(res, w);
        break;
      case 2: {
        // ADC
        const c = this.getFlag(FLAG_CF) ? 1 : 0;
        res = a + b + c;
        this.setAddFlags(a, b, res, w);
        break;
      }
      case 3: {
        // SBB
        const c = this.getFlag(FLAG_CF) ? 1 : 0;
        res = a - b - c;
        this.setSubFlags(a, b + c, res, w);
        break;
      }
      case 4: // AND
        res = a & b;
        this.setLogicFlags(res, w);
        break;
      case 5: // SUB
        res = a - b;
        this.setSubFlags(a, b, res, w);
        break;
      case 6: // XOR
        res = a ^ b;
        this.setLogicFlags(res, w);
        break;
      case 7: // CMP
        res = a - b;
        this.setSubFlags(a, b, res, w);
        return a;
    }
    return res & mask;
  }

  // ---- прерывания ----
  interrupt(vector: number): void {
    this.push16(this.flags);
    this.setFlag(FLAG_IF, false);
    this.setFlag(FLAG_TF, false);
    this.push16(this.segs[SEG_CS]!);
    this.push16(this.ip);
    const base = vector * 4;
    this.ip = this.bus.memRead16(base);
    this.segs[SEG_CS] = this.bus.memRead16(base + 2);
    this.halted = false;
    this.flushPrefetch();
    this.cycles += 51;
  }

  /** Архитектурная точка приёма INTR: между инструкциями и между итерациями rep. */
  canAcceptInterrupt(): boolean {
    return this.getFlag(FLAG_IF) && !this.intShadow;
  }

  private jumpIf(cond: boolean): void {
    const disp = (this.fetch8() << 24) >> 24;
    if (cond) {
      this.ip = (this.ip + disp) & 0xffff;
      this.flushPrefetch();
      this.cycles += 12;
    } else {
      this.cycles += 4;
    }
  }

  /** Выполнить одну инструкцию, вернуть число потраченных тактов. */
  step(): number {
    const start = this.cycles;
    this.intShadow = false;
    if (this.halted) {
      this.cycles += 2;
      return this.cycles - start;
    }
    this.segOverride = -1;
    this.repPrefix = 0;

    let op = this.fetch8();
    // префиксы
    for (;;) {
      if (op === 0x26) this.segOverride = SEG_ES;
      else if (op === 0x2e) this.segOverride = SEG_CS;
      else if (op === 0x36) this.segOverride = SEG_SS;
      else if (op === 0x3e) this.segOverride = SEG_DS;
      else if (op === 0xf2 || op === 0xf3) this.repPrefix = op;
      else if (op === 0xf0) {
        /* LOCK */
      } else break;
      op = this.fetch8();
    }

    this.execute(op);
    this.instructions += 1;
    return this.cycles - start;
  }

  private execute(op: number): void {
    const c = this;
    // группа ALU: 00-3F по шаблону
    if (op < 0x40 && (op & 7) < 6 && (op & 0x07) !== 6 && (op & 0x07) !== 7) {
      const aluOp = (op >> 3) & 7;
      const form = op & 7;
      const w = (form & 1) === 1;
      if (form === 0 || form === 1) {
        const { reg, ea } = this.modrm();
        const dst = w ? this.readEa16(ea) : this.readEa8(ea);
        const src = w ? this.regs[reg]! : this.getReg8(reg);
        const res = this.alu(aluOp, dst, src, w);
        if (aluOp !== 7) (w ? this.writeEa16 : this.writeEa8).call(this, ea, res);
        this.cycles += ea.isReg ? 3 : 16;
        return;
      }
      if (form === 2 || form === 3) {
        const { reg, ea } = this.modrm();
        const src = w ? this.readEa16(ea) : this.readEa8(ea);
        const dst = w ? this.regs[reg]! : this.getReg8(reg);
        const res = this.alu(aluOp, dst, src, w);
        if (aluOp !== 7) {
          if (w) this.regs[reg] = res;
          else this.setReg8(reg, res);
        }
        this.cycles += ea.isReg ? 3 : 9;
        return;
      }
      // form 4/5: acc, imm
      const src = w ? this.fetch16() : this.fetch8();
      const dst = w ? this.regs[REG_AX]! : this.getReg8(0);
      const res = this.alu(aluOp, dst, src, w);
      if (aluOp !== 7) {
        if (w) this.regs[REG_AX] = res;
        else this.setReg8(0, res);
      }
      this.cycles += 4;
      return;
    }

    switch (op) {
      // сегментные push/pop
      case 0x06:
      case 0x0e:
      case 0x16:
      case 0x1e:
        this.push16(this.segs[(op >> 3) & 3]!);
        this.cycles += 10;
        return;
      case 0x07:
      case 0x17:
      case 0x1f:
        this.segs[(op >> 3) & 3] = this.pop16();
        this.cycles += 8;
        return;
      case 0x27: // DAA
      case 0x2f: // DAS
      case 0x37: // AAA
      case 0x3f: {
        // AAS
        this.decimalAdjust(op);
        this.cycles += 4;
        return;
      }
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47: {
        const r = op & 7;
        const a = this.regs[r]!;
        const res = (a + 1) & 0xffff;
        const cf = this.getFlag(FLAG_CF);
        this.setAddFlags(a, 1, a + 1, true);
        this.setFlag(FLAG_CF, cf);
        this.regs[r] = res;
        this.cycles += 3;
        return;
      }
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f: {
        const r = op & 7;
        const a = this.regs[r]!;
        const cf = this.getFlag(FLAG_CF);
        this.setSubFlags(a, 1, a - 1, true);
        this.setFlag(FLAG_CF, cf);
        this.regs[r] = (a - 1) & 0xffff;
        this.cycles += 3;
        return;
      }
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
        this.push16(this.regs[op & 7]!);
        this.cycles += 11;
        return;
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        this.regs[op & 7] = this.pop16();
        this.cycles += 8;
        return;

      // условные переходы 0x70-0x7F
      case 0x70:
        return this.jumpIf(this.getFlag(FLAG_OF));
      case 0x71:
        return this.jumpIf(!this.getFlag(FLAG_OF));
      case 0x72:
        return this.jumpIf(this.getFlag(FLAG_CF));
      case 0x73:
        return this.jumpIf(!this.getFlag(FLAG_CF));
      case 0x74:
        return this.jumpIf(this.getFlag(FLAG_ZF));
      case 0x75:
        return this.jumpIf(!this.getFlag(FLAG_ZF));
      case 0x76:
        return this.jumpIf(this.getFlag(FLAG_CF) || this.getFlag(FLAG_ZF));
      case 0x77:
        return this.jumpIf(!this.getFlag(FLAG_CF) && !this.getFlag(FLAG_ZF));
      case 0x78:
        return this.jumpIf(this.getFlag(FLAG_SF));
      case 0x79:
        return this.jumpIf(!this.getFlag(FLAG_SF));
      case 0x7a:
        return this.jumpIf(this.getFlag(FLAG_PF));
      case 0x7b:
        return this.jumpIf(!this.getFlag(FLAG_PF));
      case 0x7c:
        return this.jumpIf(this.getFlag(FLAG_SF) !== this.getFlag(FLAG_OF));
      case 0x7d:
        return this.jumpIf(this.getFlag(FLAG_SF) === this.getFlag(FLAG_OF));
      case 0x7e:
        return this.jumpIf(this.getFlag(FLAG_ZF) || this.getFlag(FLAG_SF) !== this.getFlag(FLAG_OF));
      case 0x7f:
        return this.jumpIf(!this.getFlag(FLAG_ZF) && this.getFlag(FLAG_SF) === this.getFlag(FLAG_OF));

      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83: {
        const w = (op & 1) === 1;
        const { reg, ea } = this.modrm();
        let imm: number;
        if (op === 0x81) imm = this.fetch16();
        else if (op === 0x83) imm = ((this.fetch8() << 24) >> 24) & 0xffff;
        else imm = this.fetch8();
        const dst = w ? this.readEa16(ea) : this.readEa8(ea);
        const res = this.alu(reg, dst, imm, w);
        if (reg !== 7) (w ? this.writeEa16 : this.writeEa8).call(this, ea, res);
        this.cycles += ea.isReg ? 4 : 17;
        return;
      }
      case 0x84:
      case 0x85: {
        const w = (op & 1) === 1;
        const { reg, ea } = this.modrm();
        const a = w ? this.readEa16(ea) : this.readEa8(ea);
        const b = w ? this.regs[reg]! : this.getReg8(reg);
        this.setLogicFlags(a & b, w);
        this.cycles += ea.isReg ? 3 : 9;
        return;
      }
      case 0x86:
      case 0x87: {
        const w = (op & 1) === 1;
        const { reg, ea } = this.modrm();
        if (w) {
          const a = this.readEa16(ea);
          const b = this.regs[reg]!;
          this.writeEa16(ea, b);
          this.regs[reg] = a;
        } else {
          const a = this.readEa8(ea);
          const b = this.getReg8(reg);
          this.writeEa8(ea, b);
          this.setReg8(reg, a);
        }
        this.cycles += ea.isReg ? 4 : 17;
        return;
      }
      case 0x88:
      case 0x89: {
        const w = (op & 1) === 1;
        const { reg, ea } = this.modrm();
        if (w) this.writeEa16(ea, this.regs[reg]!);
        else this.writeEa8(ea, this.getReg8(reg));
        this.cycles += ea.isReg ? 2 : 9;
        return;
      }
      case 0x8a:
      case 0x8b: {
        const w = (op & 1) === 1;
        const { reg, ea } = this.modrm();
        if (w) this.regs[reg] = this.readEa16(ea);
        else this.setReg8(reg, this.readEa8(ea));
        this.cycles += ea.isReg ? 2 : 8;
        return;
      }
      case 0x8c: {
        const { reg, ea } = this.modrm();
        this.writeEa16(ea, this.segs[reg & 3]!);
        this.cycles += ea.isReg ? 2 : 9;
        return;
      }
      case 0x8d: {
        const { reg, ea } = this.modrm();
        this.regs[reg] = ea.off;
        this.cycles += 2;
        return;
      }
      case 0x8e: {
        const { reg, ea } = this.modrm();
        this.segs[reg & 3] = this.readEa16(ea);
        if ((reg & 3) === SEG_SS) this.intShadow = true;
        this.cycles += ea.isReg ? 2 : 8;
        return;
      }
      case 0x8f: {
        const { ea } = this.modrm();
        this.writeEa16(ea, this.pop16());
        this.cycles += 17;
        return;
      }
      case 0x90:
        this.cycles += 3;
        return; // NOP
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97: {
        const r = op & 7;
        const t = this.regs[REG_AX]!;
        this.regs[REG_AX] = this.regs[r]!;
        this.regs[r] = t;
        this.cycles += 3;
        return;
      }
      case 0x98: {
        const al = this.getReg8(0);
        this.regs[REG_AX] = (al & 0x80 ? 0xff00 | al : al) & 0xffff;
        this.cycles += 2;
        return;
      }
      case 0x99:
        this.regs[REG_DX] = this.regs[REG_AX]! & 0x8000 ? 0xffff : 0x0000;
        this.cycles += 5;
        return;
      case 0x9a: {
        const off = this.fetch16();
        const seg = this.fetch16();
        this.push16(this.segs[SEG_CS]!);
        this.push16(this.ip);
        this.segs[SEG_CS] = seg;
        this.ip = off;
        this.flushPrefetch();
        this.cycles += 28;
        return;
      }
      case 0x9b:
        this.cycles += 4;
        return; // WAIT
      case 0x9c:
        this.push16(this.flags | 0xf002);
        this.cycles += 10;
        return;
      case 0x9d:
        this.flags = (this.pop16() & 0x0fd5) | 0x0002;
        this.cycles += 8;
        return;
      case 0x9e:
        this.flags = (this.flags & 0xff00) | (this.getReg8(4) & 0xd5) | 0x02;
        this.cycles += 4;
        return;
      case 0x9f:
        this.setReg8(4, this.flags & 0xff);
        this.cycles += 4;
        return;
      case 0xa0: {
        const off = this.fetch16();
        const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
        this.setReg8(0, this.busRead8(seg, off));
        this.cycles += 10;
        return;
      }
      case 0xa1: {
        const off = this.fetch16();
        const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
        this.regs[REG_AX] = this.busRead16(seg, off);
        this.cycles += 10;
        return;
      }
      case 0xa2: {
        const off = this.fetch16();
        const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
        this.busWrite8(seg, off, this.getReg8(0));
        this.cycles += 10;
        return;
      }
      case 0xa3: {
        const off = this.fetch16();
        const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
        this.busWrite16(seg, off, this.regs[REG_AX]!);
        this.cycles += 10;
        return;
      }
      case 0xa4:
      case 0xa5:
      case 0xa6:
      case 0xa7:
      case 0xaa:
      case 0xab:
      case 0xac:
      case 0xad:
      case 0xae:
      case 0xaf:
        return this.stringOp(op);
      case 0xa8:
      case 0xa9: {
        const w = (op & 1) === 1;
        const imm = w ? this.fetch16() : this.fetch8();
        const acc = w ? this.regs[REG_AX]! : this.getReg8(0);
        this.setLogicFlags(acc & imm, w);
        this.cycles += 4;
        return;
      }
      case 0xb0:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb5:
      case 0xb6:
      case 0xb7:
        this.setReg8(op & 7, this.fetch8());
        this.cycles += 4;
        return;
      case 0xb8:
      case 0xb9:
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
      case 0xbf:
        this.regs[op & 7] = this.fetch16();
        this.cycles += 4;
        return;
      case 0xc2: {
        const n = this.fetch16();
        this.ip = this.pop16();
        this.regs[REG_SP] = (this.regs[REG_SP]! + n) & 0xffff;
        this.flushPrefetch();
        this.cycles += 20;
        return;
      }
      case 0xc3:
        this.ip = this.pop16();
        this.flushPrefetch();
        this.cycles += 16;
        return;
      case 0xc4:
      case 0xc5: {
        const { reg, ea } = this.modrm();
        const off = this.readEa16(ea);
        const seg = this.busRead16(ea.seg, (ea.off + 2) & 0xffff);
        this.regs[reg] = off;
        this.segs[op === 0xc4 ? SEG_ES : SEG_DS] = seg;
        this.cycles += 16;
        return;
      }
      case 0xc6:
      case 0xc7: {
        const w = (op & 1) === 1;
        const { ea } = this.modrm();
        const imm = w ? this.fetch16() : this.fetch8();
        if (w) this.writeEa16(ea, imm);
        else this.writeEa8(ea, imm);
        this.cycles += ea.isReg ? 4 : 10;
        return;
      }
      case 0xca: {
        const n = this.fetch16();
        this.ip = this.pop16();
        this.segs[SEG_CS] = this.pop16();
        this.regs[REG_SP] = (this.regs[REG_SP]! + n) & 0xffff;
        this.flushPrefetch();
        this.cycles += 25;
        return;
      }
      case 0xcb:
        this.ip = this.pop16();
        this.segs[SEG_CS] = this.pop16();
        this.flushPrefetch();
        this.cycles += 26;
        return;
      case 0xcc:
        this.interrupt(3);
        return;
      case 0xcd:
        this.interrupt(this.fetch8());
        return;
      case 0xce:
        if (this.getFlag(FLAG_OF)) this.interrupt(4);
        else this.cycles += 4;
        return;
      case 0xcf: {
        this.ip = this.pop16();
        this.segs[SEG_CS] = this.pop16();
        this.flags = (this.pop16() & 0x0fd5) | 0x0002;
        this.flushPrefetch();
        this.cycles += 32;
        return;
      }
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3:
        return this.shiftGroup(op);
      case 0xd4:
        this.fetch8();
        this.aam();
        this.cycles += 83;
        return;
      case 0xd5:
        this.fetch8();
        this.aad();
        this.cycles += 60;
        return;
      case 0xd7: {
        const seg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
        this.setReg8(0, this.busRead8(seg, (this.regs[REG_BX]! + this.getReg8(0)) & 0xffff));
        this.cycles += 11;
        return;
      }
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const disp = (this.fetch8() << 24) >> 24;
        this.regs[REG_CX] = (this.regs[REG_CX]! - 1) & 0xffff;
        const cx = this.regs[REG_CX]!;
        const z = this.getFlag(FLAG_ZF);
        const take = op === 0xe2 ? cx !== 0 : op === 0xe1 ? cx !== 0 && z : cx !== 0 && !z;
        if (take) {
          this.ip = (this.ip + disp) & 0xffff;
          this.flushPrefetch();
          this.cycles += 17;
        } else this.cycles += 5;
        return;
      }
      case 0xe3: {
        const disp = (this.fetch8() << 24) >> 24;
        if (this.regs[REG_CX] === 0) {
          this.ip = (this.ip + disp) & 0xffff;
          this.flushPrefetch();
          this.cycles += 18;
        } else this.cycles += 6;
        return;
      }
      case 0xe4:
      case 0xe5:
      case 0xe6:
      case 0xe7: {
        const port = this.fetch8();
        this.doIo(op, port);
        return;
      }
      case 0xec:
      case 0xed:
      case 0xee:
      case 0xef: {
        const port = this.regs[REG_DX]!;
        this.doIo(op, port);
        return;
      }
      case 0xe8: {
        const disp = (this.fetch16() << 16) >> 16;
        this.push16(this.ip);
        this.ip = (this.ip + disp) & 0xffff;
        this.flushPrefetch();
        this.cycles += 19;
        return;
      }
      case 0xe9: {
        const disp = (this.fetch16() << 16) >> 16;
        this.ip = (this.ip + disp) & 0xffff;
        this.flushPrefetch();
        this.cycles += 15;
        return;
      }
      case 0xea: {
        const off = this.fetch16();
        const seg = this.fetch16();
        this.ip = off;
        this.segs[SEG_CS] = seg;
        this.flushPrefetch();
        this.cycles += 15;
        return;
      }
      case 0xeb: {
        const disp = (this.fetch8() << 24) >> 24;
        this.ip = (this.ip + disp) & 0xffff;
        this.flushPrefetch();
        this.cycles += 15;
        return;
      }
      case 0xf4:
        this.halted = true;
        this.bus.onHalt();
        this.cycles += 2;
        return;
      case 0xf5:
        this.setFlag(FLAG_CF, !this.getFlag(FLAG_CF));
        this.cycles += 2;
        return;
      case 0xf6:
      case 0xf7:
        return this.group3(op);
      case 0xf8:
        this.setFlag(FLAG_CF, false);
        this.cycles += 2;
        return;
      case 0xf9:
        this.setFlag(FLAG_CF, true);
        this.cycles += 2;
        return;
      case 0xfa:
        this.setFlag(FLAG_IF, false);
        this.cycles += 2;
        return;
      case 0xfb:
        this.setFlag(FLAG_IF, true);
        this.intShadow = true; // тень STI
        this.cycles += 2;
        return;
      case 0xfc:
        this.setFlag(FLAG_DF, false);
        this.cycles += 2;
        return;
      case 0xfd:
        this.setFlag(FLAG_DF, true);
        this.cycles += 2;
        return;
      case 0xfe:
      case 0xff:
        return this.group45(op);
      default:
        // неизвестный опкод — на 8086 неопределённое поведение; считаем NOP с диагностикой
        this.cycles += 4;
        void c;
        return;
    }
  }

  private busRead8(seg: number, off: number): number {
    const a = physAddr(this.segs[seg]!, off);
    this.cycles += this.bus.memWait(a);
    return this.bus.memRead8(a);
  }
  private busRead16(seg: number, off: number): number {
    const a = physAddr(this.segs[seg]!, off);
    this.cycles += this.bus.memWait(a);
    return this.bus.memRead16(a);
  }
  private busWrite8(seg: number, off: number, v: number): void {
    const a = physAddr(this.segs[seg]!, off);
    this.cycles += this.bus.memWait(a);
    this.bus.memWrite8(a, v);
  }
  private busWrite16(seg: number, off: number, v: number): void {
    const a = physAddr(this.segs[seg]!, off);
    this.cycles += this.bus.memWait(a);
    this.bus.memWrite16(a, v);
  }

  private doIo(op: number, port: number): void {
    const w = (op & 1) === 1;
    const isOut = (op & 2) !== 0;
    this.cycles += this.bus.ioWait(port);
    if (isOut) {
      if (w) this.bus.portOut16(port, this.regs[REG_AX]!);
      else this.bus.portOut8(port, this.getReg8(0));
      this.cycles += 10;
    } else {
      if (w) this.regs[REG_AX] = this.bus.portIn16(port);
      else this.setReg8(0, this.bus.portIn8(port));
      this.cycles += 10;
    }
  }

  private stringOp(op: number): void {
    const w = (op & 1) === 1;
    const delta = (this.getFlag(FLAG_DF) ? -1 : 1) * (w ? 2 : 1);
    const srcSeg = this.segOverride >= 0 ? this.segOverride : SEG_DS;
    const rep = this.repPrefix;

    const once = (): void => {
      const si = this.regs[REG_SI]!;
      const di = this.regs[REG_DI]!;
      switch (op) {
        case 0xa4:
        case 0xa5: {
          // MOVS
          const v = w ? this.busRead16(srcSeg, si) : this.busRead8(srcSeg, si);
          if (w) this.busWrite16(SEG_ES, di, v);
          else this.busWrite8(SEG_ES, di, v);
          this.regs[REG_SI] = (si + delta) & 0xffff;
          this.regs[REG_DI] = (di + delta) & 0xffff;
          this.cycles += 18;
          break;
        }
        case 0xa6:
        case 0xa7: {
          // CMPS
          const a = w ? this.busRead16(srcSeg, si) : this.busRead8(srcSeg, si);
          const b = w ? this.busRead16(SEG_ES, di) : this.busRead8(SEG_ES, di);
          this.setSubFlags(a, b, a - b, w);
          this.regs[REG_SI] = (si + delta) & 0xffff;
          this.regs[REG_DI] = (di + delta) & 0xffff;
          this.cycles += 22;
          break;
        }
        case 0xaa:
        case 0xab: {
          // STOS
          const v = w ? this.regs[REG_AX]! : this.getReg8(0);
          if (w) this.busWrite16(SEG_ES, di, v);
          else this.busWrite8(SEG_ES, di, v);
          this.regs[REG_DI] = (di + delta) & 0xffff;
          this.cycles += 11;
          break;
        }
        case 0xac:
        case 0xad: {
          // LODS
          const v = w ? this.busRead16(srcSeg, si) : this.busRead8(srcSeg, si);
          if (w) this.regs[REG_AX] = v;
          else this.setReg8(0, v);
          this.regs[REG_SI] = (si + delta) & 0xffff;
          this.cycles += 12;
          break;
        }
        case 0xae:
        case 0xaf: {
          // SCAS
          const acc = w ? this.regs[REG_AX]! : this.getReg8(0);
          const b = w ? this.busRead16(SEG_ES, di) : this.busRead8(SEG_ES, di);
          this.setSubFlags(acc, b, acc - b, w);
          this.regs[REG_DI] = (di + delta) & 0xffff;
          this.cycles += 15;
          break;
        }
      }
    };

    if (rep === 0) {
      once();
      return;
    }
    // Прерываемая rep: одна итерация за step(), IP откатывается на префикс.
    if (this.regs[REG_CX] === 0) {
      this.inRepIteration = false;
      this.cycles += 2;
      return;
    }
    once();
    this.regs[REG_CX] = (this.regs[REG_CX]! - 1) & 0xffff;
    const isCompare = op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf;
    let cont = this.regs[REG_CX] !== 0;
    if (isCompare) {
      const z = this.getFlag(FLAG_ZF);
      cont = cont && (rep === 0xf3 ? z : !z);
    }
    if (cont) {
      // вернуться к префиксу: длина префикса(ов) + опкод
      let back = 2;
      if (this.segOverride >= 0) back += 1;
      this.ip = (this.ip - back) & 0xffff;
      this.inRepIteration = true;
    } else {
      this.inRepIteration = false;
    }
  }

  private shiftGroup(op: number): void {
    const w = (op & 1) === 1;
    const useCl = (op & 2) !== 0;
    const { reg, ea } = this.modrm();
    let count = useCl ? this.getReg8(1) & 0xff : 1;
    let v = w ? this.readEa16(ea) : this.readEa8(ea);
    const mask = w ? 0xffff : 0xff;
    const sign = w ? 0x8000 : 0x80;
    const bits = w ? 16 : 8;
    this.cycles += (ea.isReg ? 2 : 15) + (useCl ? 4 * count : 0);
    if (count === 0) return;
    if (count > 32) count = 32;
    for (let i = 0; i < count; i++) {
      switch (reg) {
        case 0: {
          // ROL
          const c = (v & sign) !== 0 ? 1 : 0;
          v = ((v << 1) | c) & mask;
          this.setFlag(FLAG_CF, c === 1);
          break;
        }
        case 1: {
          // ROR
          const c = v & 1;
          v = ((v >> 1) | (c ? sign : 0)) & mask;
          this.setFlag(FLAG_CF, c === 1);
          break;
        }
        case 2: {
          // RCL
          const c = this.getFlag(FLAG_CF) ? 1 : 0;
          const nc = (v & sign) !== 0 ? 1 : 0;
          v = ((v << 1) | c) & mask;
          this.setFlag(FLAG_CF, nc === 1);
          break;
        }
        case 3: {
          // RCR
          const c = this.getFlag(FLAG_CF) ? 1 : 0;
          const nc = v & 1;
          v = ((v >> 1) | (c ? sign : 0)) & mask;
          this.setFlag(FLAG_CF, nc === 1);
          break;
        }
        case 4:
        case 6: {
          // SHL/SAL
          this.setFlag(FLAG_CF, (v & sign) !== 0);
          v = (v << 1) & mask;
          break;
        }
        case 5: {
          // SHR
          this.setFlag(FLAG_CF, (v & 1) !== 0);
          v = (v >>> 1) & mask;
          break;
        }
        case 7: {
          // SAR
          this.setFlag(FLAG_CF, (v & 1) !== 0);
          v = ((v >> 1) | (v & sign)) & mask;
          break;
        }
      }
    }
    if (reg >= 4) {
      this.setFlag(FLAG_ZF, v === 0);
      this.setFlag(FLAG_SF, (v & sign) !== 0);
      this.setFlag(FLAG_PF, PARITY[v & 0xff] === 1);
    }
    this.setFlag(FLAG_OF, count === 1 ? ((v & sign) !== 0) !== this.getFlag(FLAG_CF) : this.getFlag(FLAG_OF));
    void bits;
    if (w) this.writeEa16(ea, v);
    else this.writeEa8(ea, v);
  }

  private group3(op: number): void {
    const w = (op & 1) === 1;
    const { reg, ea } = this.modrm();
    switch (reg) {
      case 0:
      case 1: {
        const imm = w ? this.fetch16() : this.fetch8();
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        this.setLogicFlags(v & imm, w);
        this.cycles += 5;
        return;
      }
      case 2: {
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        const r = ~v & (w ? 0xffff : 0xff);
        if (w) this.writeEa16(ea, r);
        else this.writeEa8(ea, r);
        this.cycles += 3;
        return;
      }
      case 3: {
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        const r = -v;
        this.setSubFlags(0, v, r, w);
        this.setFlag(FLAG_CF, v !== 0);
        if (w) this.writeEa16(ea, r & 0xffff);
        else this.writeEa8(ea, r & 0xff);
        this.cycles += 3;
        return;
      }
      case 4: {
        // MUL
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        if (w) {
          const res = this.regs[REG_AX]! * v;
          this.regs[REG_AX] = res & 0xffff;
          this.regs[REG_DX] = (res >>> 16) & 0xffff;
          const hi = this.regs[REG_DX] !== 0;
          this.setFlag(FLAG_CF, hi);
          this.setFlag(FLAG_OF, hi);
          this.cycles += 124;
        } else {
          const res = this.getReg8(0) * v;
          this.regs[REG_AX] = res & 0xffff;
          const hi = (res & 0xff00) !== 0;
          this.setFlag(FLAG_CF, hi);
          this.setFlag(FLAG_OF, hi);
          this.cycles += 70;
        }
        return;
      }
      case 5: {
        // IMUL
        const raw = w ? this.readEa16(ea) : this.readEa8(ea);
        if (w) {
          const a = (this.regs[REG_AX]! << 16) >> 16;
          const b = (raw << 16) >> 16;
          const res = a * b;
          this.regs[REG_AX] = res & 0xffff;
          this.regs[REG_DX] = (res >> 16) & 0xffff;
          const ok = res >= -32768 && res <= 32767;
          this.setFlag(FLAG_CF, !ok);
          this.setFlag(FLAG_OF, !ok);
          this.cycles += 128;
        } else {
          const a = (this.getReg8(0) << 24) >> 24;
          const b = (raw << 24) >> 24;
          const res = a * b;
          this.regs[REG_AX] = res & 0xffff;
          const ok = res >= -128 && res <= 127;
          this.setFlag(FLAG_CF, !ok);
          this.setFlag(FLAG_OF, !ok);
          this.cycles += 80;
        }
        return;
      }
      case 6: {
        // DIV
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        if (v === 0) return this.interrupt(0);
        if (w) {
          const num = (this.regs[REG_DX]! << 16 >>> 0) + this.regs[REG_AX]!;
          const q = Math.floor(num / v);
          if (q > 0xffff) return this.interrupt(0);
          this.regs[REG_AX] = q & 0xffff;
          this.regs[REG_DX] = num % v;
          this.cycles += 162;
        } else {
          const num = this.regs[REG_AX]!;
          const q = Math.floor(num / v);
          if (q > 0xff) return this.interrupt(0);
          this.setReg8(0, q);
          this.setReg8(4, num % v);
          this.cycles += 90;
        }
        return;
      }
      case 7: {
        // IDIV
        const raw = w ? this.readEa16(ea) : this.readEa8(ea);
        const v = w ? (raw << 16) >> 16 : (raw << 24) >> 24;
        if (v === 0) return this.interrupt(0);
        if (w) {
          const num = ((this.regs[REG_DX]! << 16) | this.regs[REG_AX]!) | 0;
          const q = Math.trunc(num / v);
          if (q > 32767 || q < -32768) return this.interrupt(0);
          this.regs[REG_AX] = q & 0xffff;
          this.regs[REG_DX] = (num % v) & 0xffff;
          this.cycles += 184;
        } else {
          const num = (this.regs[REG_AX]! << 16) >> 16;
          const q = Math.trunc(num / v);
          if (q > 127 || q < -128) return this.interrupt(0);
          this.setReg8(0, q & 0xff);
          this.setReg8(4, (num % v) & 0xff);
          this.cycles += 112;
        }
        return;
      }
    }
  }

  private group45(op: number): void {
    const w = (op & 1) === 1;
    const { reg, ea } = this.modrm();
    switch (reg) {
      case 0: {
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        const cf = this.getFlag(FLAG_CF);
        this.setAddFlags(v, 1, v + 1, w);
        this.setFlag(FLAG_CF, cf);
        if (w) this.writeEa16(ea, v + 1);
        else this.writeEa8(ea, v + 1);
        this.cycles += 3;
        return;
      }
      case 1: {
        const v = w ? this.readEa16(ea) : this.readEa8(ea);
        const cf = this.getFlag(FLAG_CF);
        this.setSubFlags(v, 1, v - 1, w);
        this.setFlag(FLAG_CF, cf);
        if (w) this.writeEa16(ea, v - 1);
        else this.writeEa8(ea, v - 1);
        this.cycles += 3;
        return;
      }
      case 2: {
        // CALL near
        const off = this.readEa16(ea);
        this.push16(this.ip);
        this.ip = off;
        this.flushPrefetch();
        this.cycles += 21;
        return;
      }
      case 3: {
        // CALL far
        const off = this.readEa16(ea);
        const seg = this.busRead16(ea.seg, (ea.off + 2) & 0xffff);
        this.push16(this.segs[SEG_CS]!);
        this.push16(this.ip);
        this.ip = off;
        this.segs[SEG_CS] = seg;
        this.flushPrefetch();
        this.cycles += 37;
        return;
      }
      case 4: {
        this.ip = this.readEa16(ea);
        this.flushPrefetch();
        this.cycles += 18;
        return;
      }
      case 5: {
        const off = this.readEa16(ea);
        const seg = this.busRead16(ea.seg, (ea.off + 2) & 0xffff);
        this.ip = off;
        this.segs[SEG_CS] = seg;
        this.flushPrefetch();
        this.cycles += 24;
        return;
      }
      case 6: {
        this.push16(this.readEa16(ea));
        this.cycles += 16;
        return;
      }
    }
  }

  private decimalAdjust(op: number): void {
    let al = this.getReg8(0);
    const af = this.getFlag(FLAG_AF);
    const cf = this.getFlag(FLAG_CF);
    if (op === 0x27) {
      if ((al & 0x0f) > 9 || af) {
        al += 6;
        this.setFlag(FLAG_AF, true);
      } else this.setFlag(FLAG_AF, false);
      if (al > 0x9f || cf) {
        al += 0x60;
        this.setFlag(FLAG_CF, true);
      } else this.setFlag(FLAG_CF, false);
      this.setReg8(0, al);
    } else if (op === 0x2f) {
      if ((al & 0x0f) > 9 || af) {
        al -= 6;
        this.setFlag(FLAG_AF, true);
      } else this.setFlag(FLAG_AF, false);
      if (al > 0x9f || cf) {
        al -= 0x60;
        this.setFlag(FLAG_CF, true);
      } else this.setFlag(FLAG_CF, false);
      this.setReg8(0, al);
    } else if (op === 0x37) {
      if ((al & 0x0f) > 9 || af) {
        this.setReg8(0, (al + 6) & 0x0f);
        this.setReg8(4, (this.getReg8(4) + 1) & 0xff);
        this.setFlag(FLAG_AF, true);
        this.setFlag(FLAG_CF, true);
      } else {
        this.setReg8(0, al & 0x0f);
        this.setFlag(FLAG_AF, false);
        this.setFlag(FLAG_CF, false);
      }
    } else {
      if ((al & 0x0f) > 9 || af) {
        this.setReg8(0, (al - 6) & 0x0f);
        this.setReg8(4, (this.getReg8(4) - 1) & 0xff);
        this.setFlag(FLAG_AF, true);
        this.setFlag(FLAG_CF, true);
      } else {
        this.setReg8(0, al & 0x0f);
        this.setFlag(FLAG_AF, false);
        this.setFlag(FLAG_CF, false);
      }
    }
    const r = this.getReg8(0);
    this.setFlag(FLAG_ZF, r === 0);
    this.setFlag(FLAG_SF, (r & 0x80) !== 0);
    this.setFlag(FLAG_PF, PARITY[r] === 1);
  }

  private aam(): void {
    const al = this.getReg8(0);
    this.setReg8(4, Math.floor(al / 10));
    this.setReg8(0, al % 10);
    this.setLogicFlags(this.getReg8(0), false);
  }
  private aad(): void {
    const al = this.getReg8(0);
    const ah = this.getReg8(4);
    this.setReg8(0, (al + ah * 10) & 0xff);
    this.setReg8(4, 0);
    this.setLogicFlags(this.getReg8(0), false);
  }

  snapshot(): Record<string, unknown> {
    return {
      regs: Array.from(this.regs),
      segs: Array.from(this.segs),
      ip: this.ip,
      flags: this.flags,
      halted: this.halted,
      intShadow: this.intShadow,
      cycles: this.cycles,
      instructions: this.instructions,
      prefetch: [...this.prefetch],
      prefetchAddr: this.prefetchAddr,
      inRepIteration: this.inRepIteration,
    };
  }

  restore(s: Record<string, unknown>): void {
    this.regs.set(s["regs"] as number[]);
    this.segs.set(s["segs"] as number[]);
    this.ip = s["ip"] as number;
    this.flags = s["flags"] as number;
    this.halted = s["halted"] as boolean;
    this.intShadow = s["intShadow"] as boolean;
    this.cycles = s["cycles"] as number;
    this.instructions = s["instructions"] as number;
    this.prefetch = [...(s["prefetch"] as number[])];
    this.prefetchAddr = s["prefetchAddr"] as number;
    this.inRepIteration = s["inRepIteration"] as boolean;
  }
}
