/** КР1810ВН59А (≈ i8259A): контроллер прерываний, порты 0x20/0x21. */
export class Pic {
  irr = 0;
  imr = 0xff;
  isr = 0;
  vectorBase = 0x08;
  initStep = 0; // 0 = рабочий режим, 1..3 = ожидание ICW2..ICW4
  autoEoi = false;
  lastAccessCycle = -1e9;
  /** такт последнего фронта на каждом входе — для метрики IRQ→пробуждение */
  irqEdgeCycle: number[] = new Array(8).fill(-1);

  reset(): void {
    this.irr = 0;
    this.imr = 0xff;
    this.isr = 0;
    this.vectorBase = 0x08;
    this.initStep = 0;
    this.autoEoi = false;
    this.lastAccessCycle = -1e9;
    this.irqEdgeCycle = new Array(8).fill(-1);
  }

  raise(line: number, cycle: number): boolean {
    const bit = 1 << line;
    const isEdge = (this.irr & bit) === 0;
    this.irr |= bit;
    if (isEdge) this.irqEdgeCycle[line] = cycle;
    return isEdge;
  }

  lower(line: number): void {
    this.irr &= ~(1 << line) & 0xff;
  }

  /** Номер линии, готовой к обслуживанию, или -1. */
  pending(): number {
    const ready = this.irr & ~this.imr & 0xff;
    if (ready === 0) return -1;
    for (let i = 0; i < 8; i++) {
      const bit = 1 << i;
      if (this.isr & bit) return -1; // приоритет занят обслуживанием
      if (ready & bit) return i;
    }
    return -1;
  }

  /** Последовательность INTA: снимает IRR, поднимает ISR, отдаёт вектор. */
  acknowledge(line: number): number {
    const bit = 1 << line;
    this.irr &= ~bit & 0xff;
    if (!this.autoEoi) this.isr |= bit;
    return (this.vectorBase + line) & 0xff;
  }

  write(port: number, value: number): void {
    if (port === 0x20) {
      if (value & 0x10) {
        // ICW1
        this.initStep = 1;
        this.imr = 0;
        this.isr = 0;
        return;
      }
      if (value === 0x20) {
        // неспецифический EOI — снимаем старший приоритет
        for (let i = 0; i < 8; i++) {
          const bit = 1 << i;
          if (this.isr & bit) {
            this.isr &= ~bit & 0xff;
            break;
          }
        }
        return;
      }
      if ((value & 0xf8) === 0x60) {
        this.isr &= ~(1 << (value & 7)) & 0xff;
      }
      return;
    }
    // порт 0x21
    if (this.initStep === 1) {
      this.vectorBase = value & 0xf8;
      this.initStep = 2;
      return;
    }
    if (this.initStep === 2) {
      this.initStep = 3;
      return;
    }
    if (this.initStep === 3) {
      this.autoEoi = (value & 0x02) !== 0;
      this.initStep = 0;
      return;
    }
    this.imr = value & 0xff;
  }

  read(port: number): number {
    return port === 0x20 ? this.irr : this.imr;
  }
}
