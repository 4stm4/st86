/** Отладочная консоль UART и блочное устройство PIO (DMA нет). */

export class Uart {
  out = "";
  rxQueue: number[] = [];

  reset(): void {
    this.out = "";
    this.rxQueue = [];
  }

  writeData(byte: number): void {
    this.out += String.fromCharCode(byte & 0xff);
  }

  readData(): number {
    return this.rxQueue.shift() ?? 0;
  }

  status(): number {
    return 0x01 | (this.rxQueue.length > 0 ? 0x02 : 0);
  }
}

export const SECTOR_SIZE = 512;
/** Сектор ≈ 1 мс на 5 МГц — предсказуемо. */
export const SECTOR_CYCLES = 5000;

/**
 * Блочное устройство, PIO через rep insb/outsb.
 * Порты: 0xD0 LBA lo, 0xD1 LBA hi, 0xD2 команда (1=read, 2=write),
 * 0xD3 данные, 0xD4 статус (bit0 busy, bit1 data ready).
 */
export class Disk {
  image: Uint8Array;
  lba = 0;
  busy = false;
  buffer = new Uint8Array(SECTOR_SIZE);
  bufPos = 0;
  writeMode = false;
  reads = 0;
  writes = 0;

  constructor(sizeBytes = SECTOR_SIZE * 2880) {
    this.image = new Uint8Array(sizeBytes);
  }

  reset(): void {
    this.lba = 0;
    this.busy = false;
    this.bufPos = 0;
    this.writeMode = false;
    this.reads = 0;
    this.writes = 0;
    this.buffer.fill(0);
  }

  loadImage(bytes: Uint8Array): void {
    this.image = new Uint8Array(Math.max(bytes.length, SECTOR_SIZE));
    this.image.set(bytes);
  }

  startRead(): void {
    const off = this.lba * SECTOR_SIZE;
    this.buffer.set(this.image.subarray(off, off + SECTOR_SIZE));
    if (off + SECTOR_SIZE > this.image.length) this.buffer.fill(0, Math.max(0, this.image.length - off));
    this.bufPos = 0;
    this.writeMode = false;
    this.busy = true;
    this.reads += 1;
  }

  startWrite(): void {
    this.bufPos = 0;
    this.writeMode = true;
    this.busy = true;
    this.writes += 1;
  }

  complete(): void {
    if (this.writeMode) {
      const off = this.lba * SECTOR_SIZE;
      if (off + SECTOR_SIZE <= this.image.length) this.image.set(this.buffer, off);
    }
    this.busy = false;
  }

  readData(): number {
    if (this.busy || this.writeMode) return 0xff;
    const v = this.buffer[this.bufPos] ?? 0;
    this.bufPos = Math.min(this.bufPos + 1, SECTOR_SIZE);
    return v;
  }

  writeData(byte: number): void {
    if (this.bufPos < SECTOR_SIZE) this.buffer[this.bufPos++] = byte & 0xff;
  }

  status(): number {
    return (this.busy ? 0x01 : 0) | (!this.busy && !this.writeMode ? 0x02 : 0);
  }
}
