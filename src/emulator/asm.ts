/** Мини-ассемблер: ровно те формы, что нужны для встроенных самотестов стенда. */

export const R_AX = 0, R_CX = 1, R_DX = 2, R_BX = 3, R_SP = 4, R_BP = 5, R_SI = 6, R_DI = 7;
export const S_ES = 0, S_CS = 1, S_SS = 2, S_DS = 3;

export class Asm {
  bytes: number[] = [];
  private labels = new Map<string, number>();
  private fixups: { at: number; label: string; kind: "rel8" | "abs16" }[] = [];
  readonly origin: number;

  constructor(origin = 0x0100) {
    this.origin = origin;
  }

  private db(...v: number[]): this {
    for (const b of v) this.bytes.push(b & 0xff);
    return this;
  }
  private dw(v: number): this {
    return this.db(v & 0xff, (v >> 8) & 0xff);
  }
  get pc(): number {
    return this.origin + this.bytes.length;
  }
  label(name: string): this {
    this.labels.set(name, this.pc);
    return this;
  }
  addrOf(name: string): number {
    const a = this.labels.get(name);
    if (a === undefined) throw new Error(`метка не найдена: ${name}`);
    return a;
  }

  cli() { return this.db(0xfa); }
  sti() { return this.db(0xfb); }
  cld() { return this.db(0xfc); }
  hlt() { return this.db(0xf4); }
  nop() { return this.db(0x90); }
  iret() { return this.db(0xcf); }
  pushAx() { return this.db(0x50); }
  popAx() { return this.db(0x58); }

  movR16(reg: number, imm: number) { return this.db(0xb8 + reg).dw(imm); }
  movR8(reg: number, imm: number) { return this.db(0xb0 + reg).db(imm); }
  movSregAx(sreg: number) { return this.db(0x8e, 0xc0 | (sreg << 3)); }
  movAlMem(addr: number) { return this.db(0xa0).dw(addr); }
  movMemByteImm(addr: number, imm: number) { return this.db(0xc6, 0x06).dw(addr).db(imm); }
  movMemWordImm(addr: number, imm: number) { return this.db(0xc7, 0x06).dw(addr).dw(imm); }
  incMemByte(addr: number) { return this.db(0xfe, 0x06).dw(addr); }
  cmpMemByteImm(addr: number, imm: number) { return this.db(0x80, 0x3e).dw(addr).db(imm); }
  outImm(port: number) { return this.db(0xe6).db(port); }
  inImm(port: number) { return this.db(0xe4).db(port); }

  /** OUT port, imm8 — через AL. */
  outByte(port: number, value: number) {
    return this.movR8(0, value).outImm(port);
  }

  jmpShort(label: string) {
    this.db(0xeb);
    this.fixups.push({ at: this.bytes.length, label, kind: "rel8" });
    return this.db(0);
  }
  jb(label: string) {
    this.db(0x72);
    this.fixups.push({ at: this.bytes.length, label, kind: "rel8" });
    return this.db(0);
  }
  jne(label: string) {
    this.db(0x75);
    this.fixups.push({ at: this.bytes.length, label, kind: "rel8" });
    return this.db(0);
  }
  /** MOV word [addr], offset метки */
  movMemWordLabel(addr: number, label: string) {
    this.db(0xc7, 0x06).dw(addr);
    this.fixups.push({ at: this.bytes.length, label, kind: "abs16" });
    return this.dw(0);
  }

  /** Публикация маркера тестового порта (0xF0–0xF3). */
  marker(opcode: number, arg = 0) {
    this.outByte(0xf0, opcode);
    this.outByte(0xf1, arg & 0xff);
    this.outByte(0xf2, (arg >> 8) & 0xff);
    this.outByte(0xf3, 0);
    return this;
  }

  /** Завершение теста с кодом. */
  finish(code = 0) {
    this.outByte(0xf1, code & 0xff);
    this.outByte(0xf2, (code >> 8) & 0xff);
    this.outByte(0xf4, 0x01);
    return this;
  }

  uart(text: string) {
    for (const ch of text) this.outByte(0xe2, ch.charCodeAt(0));
    return this;
  }

  /** Видео: сначала резервируем, потом пишем. */
  videoCommand(opcode: number, payload: number[]) {
    this.outByte(0xe1, payload.length + 1);
    this.outByte(0xe0, opcode);
    for (const b of payload) this.outByte(0xe0, b);
    return this;
  }

  build(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) throw new Error(`метка не найдена: ${f.label}`);
      if (f.kind === "rel8") {
        const rel = target - (this.origin + f.at + 1);
        this.bytes[f.at] = rel & 0xff;
      } else {
        this.bytes[f.at] = target & 0xff;
        this.bytes[f.at + 1] = (target >> 8) & 0xff;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}
