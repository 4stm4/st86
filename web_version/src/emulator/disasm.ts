/** Дизассемблер для панели наблюдения (частичный, покрывает горячие опкоды). */
import { hex } from "./hash";

const REG16 = ["AX", "CX", "DX", "BX", "SP", "BP", "SI", "DI"];
const REG8 = ["AL", "CL", "DL", "BL", "AH", "CH", "DH", "BH"];
const SEG = ["ES", "CS", "SS", "DS"];
const ALU = ["ADD", "OR", "ADC", "SBB", "AND", "SUB", "XOR", "CMP"];
const JCC = [
  "JO", "JNO", "JB", "JAE", "JZ", "JNZ", "JBE", "JA",
  "JS", "JNS", "JP", "JNP", "JL", "JGE", "JLE", "JG",
];
const SHIFT = ["ROL", "ROR", "RCL", "RCR", "SHL", "SHR", "SAL", "SAR"];
const RM = [
  "BX+SI", "BX+DI", "BP+SI", "BP+DI", "SI", "DI", "BP", "BX",
];

export interface DisasmLine {
  addr: number;
  bytes: number[];
  text: string;
}

export function disassemble(read: (addr: number) => number, start: number, count: number): DisasmLine[] {
  let pc = start;
  const out: DisasmLine[] = [];
  for (let i = 0; i < count; i++) {
    const begin = pc;
    const bytes: number[] = [];
    const next = (): number => {
      const b = read(pc & 0xfffff);
      bytes.push(b);
      pc = (pc + 1) & 0xfffff;
      return b;
    };
    const text = decodeOne(next);
    out.push({ addr: begin, bytes, text });
  }
  return out;
}

function decodeOne(next: () => number): string {
  let prefix = "";
  let op = next();
  for (;;) {
    if (op === 0x26) prefix += "ES: ";
    else if (op === 0x2e) prefix += "CS: ";
    else if (op === 0x36) prefix += "SS: ";
    else if (op === 0x3e) prefix += "DS: ";
    else if (op === 0xf3) prefix += "REP ";
    else if (op === 0xf2) prefix += "REPNE ";
    else if (op === 0xf0) prefix += "LOCK ";
    else break;
    op = next();
  }
  return prefix + decodeBody(op, next);
}

function modrmText(next: () => number, w: boolean): { reg: string; rm: string; regNum: number } {
  const b = next();
  const mod = (b >> 6) & 3;
  const reg = (b >> 3) & 7;
  const rmi = b & 7;
  const regName = w ? REG16[reg]! : REG8[reg]!;
  if (mod === 3) return { reg: regName, rm: w ? REG16[rmi]! : REG8[rmi]!, regNum: reg };
  let base = RM[rmi]!;
  let disp = 0;
  if (mod === 0 && rmi === 6) {
    disp = next() | (next() << 8);
    return { reg: regName, rm: `[${hex(disp)}]`, regNum: reg };
  }
  if (mod === 1) disp = (next() << 24) >> 24;
  if (mod === 2) disp = next() | (next() << 8);
  const sign = disp < 0 ? "-" : "+";
  const dtxt = disp === 0 ? "" : `${sign}${hex(Math.abs(disp), 2)}`;
  return { reg: regName, rm: `[${base}${dtxt}]`, regNum: reg };
}

function decodeBody(op: number, next: () => number): string {
  if (op < 0x40 && (op & 7) < 6) {
    const name = ALU[(op >> 3) & 7]!;
    const form = op & 7;
    const w = (form & 1) === 1;
    if (form <= 1) {
      const m = modrmText(next, w);
      return `${name} ${m.rm}, ${m.reg}`;
    }
    if (form <= 3) {
      const m = modrmText(next, w);
      return `${name} ${m.reg}, ${m.rm}`;
    }
    const imm = w ? next() | (next() << 8) : next();
    return `${name} ${w ? "AX" : "AL"}, ${hex(imm, w ? 4 : 2)}h`;
  }
  if (op >= 0x40 && op <= 0x47) return `INC ${REG16[op & 7]}`;
  if (op >= 0x48 && op <= 0x4f) return `DEC ${REG16[op & 7]}`;
  if (op >= 0x50 && op <= 0x57) return `PUSH ${REG16[op & 7]}`;
  if (op >= 0x58 && op <= 0x5f) return `POP ${REG16[op & 7]}`;
  if (op >= 0x70 && op <= 0x7f) {
    const d = (next() << 24) >> 24;
    return `${JCC[op & 15]} ${d >= 0 ? "+" : ""}${d}`;
  }
  if (op >= 0xb0 && op <= 0xb7) return `MOV ${REG8[op & 7]}, ${hex(next(), 2)}h`;
  if (op >= 0xb8 && op <= 0xbf) return `MOV ${REG16[op & 7]}, ${hex(next() | (next() << 8))}h`;
  switch (op) {
    case 0x06:
    case 0x0e:
    case 0x16:
    case 0x1e:
      return `PUSH ${SEG[(op >> 3) & 3]}`;
    case 0x07:
    case 0x17:
    case 0x1f:
      return `POP ${SEG[(op >> 3) & 3]}`;
    case 0x80:
    case 0x81:
    case 0x82:
    case 0x83: {
      const w = (op & 1) === 1;
      const m = modrmText(next, w);
      const imm = op === 0x81 ? next() | (next() << 8) : next();
      return `${ALU[m.regNum]} ${m.rm}, ${hex(imm, 2)}h`;
    }
    case 0x84:
    case 0x85: {
      const m = modrmText(next, (op & 1) === 1);
      return `TEST ${m.rm}, ${m.reg}`;
    }
    case 0x88:
    case 0x89: {
      const m = modrmText(next, (op & 1) === 1);
      return `MOV ${m.rm}, ${m.reg}`;
    }
    case 0x8a:
    case 0x8b: {
      const m = modrmText(next, (op & 1) === 1);
      return `MOV ${m.reg}, ${m.rm}`;
    }
    case 0x8c: {
      const m = modrmText(next, true);
      return `MOV ${m.rm}, ${SEG[m.regNum & 3]}`;
    }
    case 0x8d: {
      const m = modrmText(next, true);
      return `LEA ${m.reg}, ${m.rm}`;
    }
    case 0x8e: {
      const m = modrmText(next, true);
      return `MOV ${SEG[m.regNum & 3]}, ${m.rm}`;
    }
    case 0x90:
      return "NOP";
    case 0x98:
      return "CBW";
    case 0x99:
      return "CWD";
    case 0x9c:
      return "PUSHF";
    case 0x9d:
      return "POPF";
    case 0xa4:
      return "MOVSB";
    case 0xa5:
      return "MOVSW";
    case 0xaa:
      return "STOSB";
    case 0xab:
      return "STOSW";
    case 0xac:
      return "LODSB";
    case 0xae:
      return "SCASB";
    case 0xc3:
      return "RET";
    case 0xc6:
    case 0xc7: {
      const w = (op & 1) === 1;
      const m = modrmText(next, w);
      const imm = w ? next() | (next() << 8) : next();
      return `MOV ${m.rm}, ${hex(imm, w ? 4 : 2)}h`;
    }
    case 0xcb:
      return "RETF";
    case 0xcc:
      return "INT 3";
    case 0xcd:
      return `INT ${hex(next(), 2)}h`;
    case 0xcf:
      return "IRET";
    case 0xd0:
    case 0xd1:
    case 0xd2:
    case 0xd3: {
      const m = modrmText(next, (op & 1) === 1);
      return `${SHIFT[m.regNum]} ${m.rm}, ${(op & 2) !== 0 ? "CL" : "1"}`;
    }
    case 0xe2: {
      const d = (next() << 24) >> 24;
      return `LOOP ${d >= 0 ? "+" : ""}${d}`;
    }
    case 0xe4:
      return `IN AL, ${hex(next(), 2)}h`;
    case 0xe5:
      return `IN AX, ${hex(next(), 2)}h`;
    case 0xe6:
      return `OUT ${hex(next(), 2)}h, AL`;
    case 0xe7:
      return `OUT ${hex(next(), 2)}h, AX`;
    case 0xe8: {
      const d = ((next() | (next() << 8)) << 16) >> 16;
      return `CALL ${d >= 0 ? "+" : ""}${d}`;
    }
    case 0xe9: {
      const d = ((next() | (next() << 8)) << 16) >> 16;
      return `JMP ${d >= 0 ? "+" : ""}${d}`;
    }
    case 0xea: {
      const off = next() | (next() << 8);
      const seg = next() | (next() << 8);
      return `JMP FAR ${hex(seg)}:${hex(off)}`;
    }
    case 0xeb: {
      const d = (next() << 24) >> 24;
      return `JMP SHORT ${d >= 0 ? "+" : ""}${d}`;
    }
    case 0xec:
      return "IN AL, DX";
    case 0xee:
      return "OUT DX, AL";
    case 0xf4:
      return "HLT";
    case 0xf8:
      return "CLC";
    case 0xf9:
      return "STC";
    case 0xfa:
      return "CLI";
    case 0xfb:
      return "STI";
    case 0xfc:
      return "CLD";
    case 0xfd:
      return "STD";
    case 0xf6:
    case 0xf7: {
      const w = (op & 1) === 1;
      const m = modrmText(next, w);
      const names = ["TEST", "TEST", "NOT", "NEG", "MUL", "IMUL", "DIV", "IDIV"];
      if (m.regNum <= 1) {
        const imm = w ? next() | (next() << 8) : next();
        return `TEST ${m.rm}, ${hex(imm, 2)}h`;
      }
      return `${names[m.regNum]} ${m.rm}`;
    }
    case 0xfe:
    case 0xff: {
      const m = modrmText(next, (op & 1) === 1);
      const names = ["INC", "DEC", "CALL", "CALL FAR", "JMP", "JMP FAR", "PUSH", "?"];
      return `${names[m.regNum]} ${m.rm}`;
    }
    default:
      return `DB ${hex(op, 2)}h`;
  }
}
