/**
 * Интерпретатор видеопотока RP2040 → рендер на OffscreenCanvas / Canvas2D.
 * Потребляет тот же байтовый поток, что и VideoFifo.
 */

const SCREEN_W = 320;
const SCREEN_H = 240;

const PALETTE: string[] = [
  "#000000", "#0000aa", "#00aa00", "#00aaaa",
  "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa",
  "#555555", "#5555ff", "#55ff55", "#55ffff",
  "#ff5555", "#ff55ff", "#ffff55", "#ffffff",
];

export class VideoRenderer {
  private curX = 0;
  private curY = 0;
  private fg = "#ffffff";
  private bg = "#000000";
  private decodeOpcode = -1;
  private decodeNeed = 0;
  private payload: number[] = [];
  private dirty = false;

  readonly width = SCREEN_W;
  readonly height = SCREEN_H;

  renderStream(stream: Uint8Array, ctx: CanvasRenderingContext2D): void {
    this.reset();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    for (let i = 0; i < stream.length; i++) {
      this.feedByte(stream[i]!, ctx);
    }
  }

  reset(): void {
    this.curX = 0;
    this.curY = 0;
    this.fg = "#ffffff";
    this.bg = "#000000";
    this.decodeOpcode = -1;
    this.decodeNeed = 0;
    this.payload = [];
    this.dirty = false;
  }

  private feedByte(byte: number, ctx: CanvasRenderingContext2D): void {
    if (this.decodeNeed > 0) {
      this.payload.push(byte);
      this.decodeNeed--;
      if (this.decodeNeed === 0) {
        this.execCommand(this.decodeOpcode, this.payload, ctx);
        this.payload = [];
      }
      return;
    }

    this.decodeOpcode = byte;
    const payloadLen = PAYLOAD_MAP[byte];
    if (payloadLen === undefined) return;
    if (payloadLen === 0) {
      this.execCommand(byte, [], ctx);
      return;
    }
    this.decodeNeed = payloadLen;
  }

  private execCommand(op: number, p: number[], ctx: CanvasRenderingContext2D): void {
    switch (op) {
      case 0x01: break; // NOP
      case 0x02: { // CLEAR
        const colorIdx = p[0]! & 0x0f;
        ctx.fillStyle = PALETTE[colorIdx]!;
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        this.bg = PALETTE[colorIdx]!;
        this.dirty = true;
        break;
      }
      case 0x03: { // SET_COLOR: fg, bg
        this.fg = PALETTE[p[0]! & 0x0f]!;
        this.bg = PALETTE[p[1]! & 0x0f]!;
        break;
      }
      case 0x04: { // MOVE_TO: x16, y16
        this.curX = p[0]! | (p[1]! << 8);
        this.curY = p[2]! | (p[3]! << 8);
        break;
      }
      case 0x05: { // LINE_TO: x16, y16
        const x = p[0]! | (p[1]! << 8);
        const y = p[2]! | (p[3]! << 8);
        ctx.strokeStyle = this.fg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.curX, this.curY);
        ctx.lineTo(x, y);
        ctx.stroke();
        this.curX = x;
        this.curY = y;
        this.dirty = true;
        break;
      }
      case 0x06: { // RECT: x16, y16, w16, h16
        const x = p[0]! | (p[1]! << 8);
        const y = p[2]! | (p[3]! << 8);
        const w = p[4]! | (p[5]! << 8);
        const h = p[6]! | (p[7]! << 8);
        ctx.fillStyle = this.fg;
        ctx.fillRect(x, y, w, h);
        this.dirty = true;
        break;
      }
      case 0x07: { // TEXT: x8, y8, char
        const x = p[0]!;
        const y = p[1]!;
        const ch = String.fromCharCode(p[2]! & 0x7f);
        ctx.fillStyle = this.fg;
        ctx.font = "8px monospace";
        ctx.textBaseline = "top";
        ctx.fillText(ch, x * 8, y * 8);
        this.dirty = true;
        break;
      }
      case 0x08: // FLUSH
        this.dirty = false;
        break;
      case 0x09: break; // CAPS_QUERY
      case 0xff: break; // ESCAPE_RESYNC
    }
  }
}

const PAYLOAD_MAP: Record<number, number> = {
  0x01: 0, 0x02: 1, 0x03: 2, 0x04: 4,
  0x05: 4, 0x06: 8, 0x07: 3, 0x08: 0,
  0x09: 0, 0xff: 0,
};
