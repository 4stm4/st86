/** Встроенные образы-самотесты стенда (сырой бинарь, CS=0000, IP=0100). */
import { Asm, R_SP } from "./asm";

export const CHECKPOINTS: Record<string, number> = { boot: 1, vfs_ready: 2, done: 3 };

export interface DemoImage {
  id: string;
  name: string;
  description: string;
  bytes: Uint8Array;
  segment: number;
  offset: number;
}

/** Полный прогон: маркеры, UART, видео-поток, диск, таймерные прерывания. */
function buildBootImage(): Uint8Array {
  const a = new Asm(0x0100);
  a.cli();
  a.movR16(0, 0x0000);
  a.movSregAx(2); // SS
  a.movSregAx(3); // DS
  a.movSregAx(0); // ES
  a.movR16(R_SP, 0xfffe);
  a.cld();

  // вектор 0x08 (IRQ0) → обработчик
  a.movMemWordLabel(0x0020, "irq0");
  a.movMemWordImm(0x0022, 0x0000);

  a.marker(0x01, CHECKPOINTS["boot"]!);
  a.uart("OK\r\n");

  // видеопоток: CLEAR, SET_COLOR, TEXT, FLUSH
  a.videoCommand(0x02, [0x0f]);
  a.videoCommand(0x03, [0x1f, 0x00]);
  a.videoCommand(0x07, [0x00, 0x00, 0x41]);
  a.videoCommand(0x08, []);

  // блочное устройство: чтение сектора 0 (PIO, DMA нет)
  a.outByte(0xd0, 0x00);
  a.outByte(0xd1, 0x00);
  a.outByte(0xd2, 0x01);

  a.marker(0x01, CHECKPOINTS["vfs_ready"]!);

  // ВИ53 канал 0: режим 3, счёт 1000 → период 4000 тактов ЦП
  a.outByte(0x43, 0x36);
  a.outByte(0x40, 0xe8);
  a.outByte(0x40, 0x03);
  // ВН59: размаскировать IRQ0
  a.outByte(0x21, 0xfe);

  // контрольные данные: DE AD BE EF по физическому 0x05010
  a.movMemWordImm(0x5010, 0xadde);
  a.movMemWordImm(0x5012, 0xefbe);
  a.movMemByteImm(0x5000, 0x00);

  a.sti();
  a.label("wait");
  a.cmpMemByteImm(0x5000, 0x03);
  a.jb("wait");

  a.marker(0x01, CHECKPOINTS["done"]!);
  a.finish(0);
  a.hlt();

  // обработчик IRQ0 по фиксированному смещению 0x0300
  while (a.pc < 0x0300) a.nop();
  a.label("irq0");
  a.pushAx();
  a.marker(0x03, 0x0001); // задача 1 проснулась
  a.incMemByte(0x5000);
  a.outByte(0x20, 0x20); // EOI
  a.popAx();
  a.iret();

  return a.build();
}

/** Короткий образ без прерываний — для бенчмарка тактов/с. */
function buildBenchImage(): Uint8Array {
  const a = new Asm(0x0100);
  a.cli();
  a.movR16(0, 0x0000);
  a.movSregAx(2);
  a.movSregAx(3);
  a.movR16(R_SP, 0xfffe);
  a.movMemByteImm(0x6000, 0x00);
  a.label("loop");
  a.incMemByte(0x6000);
  a.cmpMemByteImm(0x6000, 0xff);
  a.jne("loop");
  a.movMemByteImm(0x6000, 0x00);
  a.jmpShort("loop");
  return a.build();
}

/** Нарушение дисциплины FIFO: запись без резервирования — стенд обязан кричать. */
function buildFifoViolationImage(): Uint8Array {
  const a = new Asm(0x0100);
  a.cli();
  a.movR16(0, 0x0000);
  a.movSregAx(2);
  a.movSregAx(3);
  a.movR16(R_SP, 0xfffe);
  a.marker(0x01, CHECKPOINTS["boot"]!);
  a.outByte(0xe0, 0x02); // запись байта без резервирования
  a.outByte(0xe0, 0x0f);
  a.marker(0x01, CHECKPOINTS["done"]!);
  a.finish(0);
  a.hlt();
  return a.build();
}

export const DEMO_IMAGES: DemoImage[] = [
  {
    id: "boot",
    name: "boot — базовый прогон",
    description:
      "Маркеры boot/vfs_ready/done, UART «OK», поток видеокоманд, чтение сектора, три таймерных прерывания с маркерами пробуждения.",
    bytes: buildBootImage(),
    segment: 0x0000,
    offset: 0x0100,
  },
  {
    id: "bench",
    name: "bench — бесконечный цикл",
    description: "Плотный цикл без прерываний: измерение эмулируемых тактов в секунду.",
    bytes: buildBenchImage(),
    segment: 0x0000,
    offset: 0x0100,
  },
  {
    id: "fifo-violation",
    name: "fifo-violation — нарушение дисциплины",
    description: "Запись в видео-FIFO без резервирования: проверка громкой диагностики стенда.",
    bytes: buildFifoViolationImage(),
    segment: 0x0000,
    offset: 0x0100,
  },
];

export function getDemoImage(id: string): DemoImage {
  return DEMO_IMAGES.find((i) => i.id === id) ?? DEMO_IMAGES[0]!;
}
