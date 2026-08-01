/**
 * Machine — единственный носитель состояния стенда.
 * Что не в этой структуре — того не существует. EventQueue входит в Machine.
 */
import { Cpu, FLAG_IF, SEG_CS, type Bus } from "./cpu";
import { EventQueue } from "./events";
import { Memory } from "./memory";
import { Pic } from "./devices/pic";
import { Pit, type PitChannel } from "./devices/pit";
import { Disk, SECTOR_CYCLES, Uart } from "./devices/io";
import { FIFO_LOW_WATERMARK, VideoFifo } from "./devices/video";
import {
  DEFAULT_WAIT_STATES,
  DeviceId,
  EventKind,
  MODEL_VERSION,
  type TraceEvent,
  type WaitStates,
} from "./types";

export const VSYNC_PERIOD = 83_333; // 60 Гц при 5 МГц
export const IRQ_TIMER = 0;
export const IRQ_VSYNC = 1;
export const IRQ_VIDEO_FIFO = 2;
export const IRQ_DISK = 3;

export const MARKER_NAMES: Record<number, string> = {
  0x01: "checkpoint",
  0x02: "sched_pick",
  0x03: "task_wake",
  0x04: "section_begin",
  0x05: "section_end",
};

export interface Marker {
  timestamp: number;
  opcode: number;
  arg: number;
}

export interface Violation {
  cycle: number;
  kind: string;
  text: string;
}

export interface Metrics {
  maxIrqBlocked: number;
  maxIrqBlockedAt: number;
  irqToWake: number[];
  irqToWakeMax: number;
  videoIdleCycles: number;
  intaCount: number;
}

export interface FaultInjection {
  kind: "fifo_overflow_flag";
  atCycle?: number;
}

export class Machine implements Bus {
  memory: Memory;
  cpu: Cpu;
  events = new EventQueue();
  pic = new Pic();
  pit = new Pit();
  uart = new Uart();
  disk = new Disk();
  video = new VideoFifo();
  waitStates: WaitStates;

  markers: Marker[] = [];
  trace: TraceEvent[] = [];
  traceLimit = 20_000;
  violations: Violation[] = [];

  /** защёлки тестового порта */
  private markerOpcode = 0;
  private markerArgLo = 0;
  private markerArgHi = 0;

  finished = false;
  exitCodeRequested: number | null = null;
  snapshotRequested = false;
  fault: FaultInjection | null = null;
  faultApplied = false;

  metrics: Metrics = {
    maxIrqBlocked: 0,
    maxIrqBlockedAt: 0,
    irqToWake: [],
    irqToWakeMax: 0,
    videoIdleCycles: 0,
    intaCount: 0,
  };

  private ifClearedAt: number | null = null;
  private lastIrqEdgeCycle = -1;
  private lastIrqLine = -1;
  readonly modelVersion = MODEL_VERSION;

  constructor(waitStates: WaitStates = DEFAULT_WAIT_STATES) {
    this.waitStates = { ...waitStates };
    this.memory = new Memory(this.waitStates);
    this.cpu = new Cpu(this);
  }

  get clock(): number {
    return this.cpu.cycles;
  }

  reset(): void {
    this.memory.clearRom();
    this.memory.data.fill(0);
    this.cpu.reset();
    this.events.clear();
    this.pic.reset();
    this.pit.reset();
    this.uart.reset();
    this.disk.reset();
    this.video.reset();
    this.markers = [];
    this.trace = [];
    this.violations = [];
    this.finished = false;
    this.exitCodeRequested = null;
    this.snapshotRequested = false;
    this.faultApplied = false;
    this.metrics = {
      maxIrqBlocked: 0,
      maxIrqBlockedAt: 0,
      irqToWake: [],
      irqToWakeMax: 0,
      videoIdleCycles: 0,
      intaCount: 0,
    };
    this.ifClearedAt = null;
    this.lastIrqEdgeCycle = -1;
    this.lastIrqLine = -1;
    this.events.schedule(VSYNC_PERIOD, DeviceId.Video, 1, EventKind.VideoVsync);
  }

  /** Загрузка сырого образа: cs:ip = seg:off. */
  loadImage(bytes: Uint8Array, segment = 0x0000, offset = 0x0100, romBytes = 0): void {
    const base = ((segment << 4) + offset) & 0xfffff;
    this.memory.load(bytes, base);
    if (romBytes > 0) this.memory.markRom(base, romBytes);
    this.cpu.segs[SEG_CS] = segment;
    this.cpu.ip = offset;
    this.cpu.flushPrefetch();
  }

  // ---------- Bus ----------
  memRead8(addr: number): number {
    return this.memory.read8(addr);
  }
  memRead16(addr: number): number {
    return this.memory.read16(addr);
  }
  memWrite8(addr: number, value: number): void {
    const wasRom = this.memory.isRom(addr);
    this.memory.write8(addr, value);
    if (wasRom) this.violation("rom_write", `запись 0x${value.toString(16)} в ROM по 0x${addr.toString(16)}`);
  }
  memWrite16(addr: number, value: number): void {
    this.memWrite8(addr, value & 0xff);
    this.memWrite8(addr + 1, (value >> 8) & 0xff);
  }
  memWait(addr: number): number {
    return this.memory.accessWaitStates(addr);
  }
  ioWait(port: number): number {
    if (port >= 0x20 && port <= 0x21) return this.waitStates.timerPic;
    if (port >= 0x40 && port <= 0x43) return this.waitStates.timerPic;
    if (port >= 0xe0 && port <= 0xe6) return this.waitStates.consoleBank;
    return 0;
  }
  onHalt(): void {
    this.pushTrace("cpu", "HLT — ЦП остановлен до прерывания");
  }

  private checkRecovery(device: "pit" | "pic"): void {
    const target = device === "pit" ? this.pit : this.pic;
    const delta = this.clock - target.lastAccessCycle;
    if (delta < this.waitStates.recoveryCycles) {
      this.violation(
        "recovery_time",
        `нарушено время восстановления ${device === "pit" ? "ВИ53" : "ВН59"}: ${delta} тактов < ${this.waitStates.recoveryCycles}`,
      );
    }
    target.lastAccessCycle = this.clock;
  }

  portIn8(port: number): number {
    if (port === 0x20 || port === 0x21) {
      this.checkRecovery("pic");
      return this.pic.read(port);
    }
    if (port >= 0x40 && port <= 0x43) {
      this.checkRecovery("pit");
      return this.pit.read(port, this.clock);
    }
    switch (port) {
      case 0xe2:
        return this.uart.readData();
      case 0xe3:
        return this.uart.status();
      case 0xe4:
        return this.video.free & 0xff;
      case 0xe5:
        return (this.video.free >> 8) & 0xff;
      case 0xe6:
        return (this.video.belowWatermark() ? 0x01 : 0) | (this.video.overflowFlagInjected ? 0x80 : 0);
      case 0xd3:
        return this.disk.readData();
      case 0xd4:
        return this.disk.status();
      case 0xf5:
        return 0xc1; // присутствие стенда
      default:
        return 0xff;
    }
  }

  portIn16(port: number): number {
    if (port === 0xe4) return this.video.free & 0xffff;
    return this.portIn8(port) | (this.portIn8(port + 1) << 8);
  }

  portOut8(port: number, value: number): void {
    const v = value & 0xff;
    if (port === 0x20 || port === 0x21) {
      this.checkRecovery("pic");
      this.pic.write(port, v);
      this.pushTrace("io", `ВН59 порт 0x${port.toString(16)} <= 0x${v.toString(16)}`);
      return;
    }
    if (port >= 0x40 && port <= 0x43) {
      this.checkRecovery("pit");
      const ch = this.pit.write(port, v, this.clock);
      if (ch !== null) this.rescheduleTimer(ch);
      return;
    }
    switch (port) {
      case 0xe0:
        this.video.write(v, this.clock);
        this.ensureVideoDrain();
        return;
      case 0xe1:
        this.video.reserve(v, this.clock);
        return;
      case 0xe2:
        this.uart.writeData(v);
        return;
      case 0xd0:
        this.disk.lba = (this.disk.lba & 0xff00) | v;
        return;
      case 0xd1:
        this.disk.lba = (this.disk.lba & 0x00ff) | (v << 8);
        return;
      case 0xd2:
        if (v === 1) this.disk.startRead();
        else if (v === 2) this.disk.startWrite();
        this.events.cancel(DeviceId.Disk);
        this.events.schedule(this.clock + SECTOR_CYCLES, DeviceId.Disk, 0, EventKind.DiskDone);
        return;
      case 0xd3:
        this.disk.writeData(v);
        return;
      case 0xf0:
        this.markerOpcode = v;
        return;
      case 0xf1:
        this.markerArgLo = v;
        return;
      case 0xf2:
        this.markerArgHi = v;
        return;
      case 0xf3:
        this.commitMarker();
        return;
      case 0xf4: {
        const arg = this.markerArgLo | (this.markerArgHi << 8);
        if (v === 0x01) {
          this.finished = true;
          this.exitCodeRequested = arg;
          this.pushTrace("marker", `завершение теста, код ${arg}`);
        } else if (v === 0x02) {
          this.snapshotRequested = true;
        }
        return;
      }
      default:
        return;
    }
  }

  portOut16(port: number, value: number): void {
    this.portOut8(port, value & 0xff);
    this.portOut8(port + 1, (value >> 8) & 0xff);
  }

  private commitMarker(): void {
    const arg = this.markerArgLo | (this.markerArgHi << 8);
    const m: Marker = { timestamp: this.clock, opcode: this.markerOpcode, arg };
    this.markers.push(m);
    const name = MARKER_NAMES[m.opcode] ?? `user_0x${m.opcode.toString(16)}`;
    this.pushTrace("marker", `${name} arg=${arg}`, { opcode: m.opcode, arg });
    if (m.opcode === 0x03 && this.lastIrqEdgeCycle >= 0) {
      const latency = this.clock - this.lastIrqEdgeCycle;
      this.metrics.irqToWake.push(latency);
      if (latency > this.metrics.irqToWakeMax) this.metrics.irqToWakeMax = latency;
      this.lastIrqEdgeCycle = -1;
    }
  }

  violation(kind: string, text: string): void {
    if (this.violations.length < 256) this.violations.push({ cycle: this.clock, kind, text });
    this.pushTrace("violation", `${kind}: ${text}`);
  }

  pushTrace(channel: TraceEvent["channel"], text: string, data?: Record<string, number | string>): void {
    if (this.trace.length >= this.traceLimit) return;
    this.trace.push({ timestamp: this.clock, channel, text, ...(data ? { data } : {}) });
  }

  // ---------- события ----------
  private rescheduleTimer(channel: number): void {
    this.events.cancel(DeviceId.Pit, channel);
    const ch = this.pit.channels[channel]!;
    const period = this.pit.periodCycles(ch);
    this.events.schedule(this.clock + period, DeviceId.Pit, channel, EventKind.PitChannel);
  }

  private ensureVideoDrain(): void {
    if (this.events.list().some((e) => e.kind === EventKind.VideoDrain)) return;
    this.events.schedule(this.clock + 4, DeviceId.Video, 0, EventKind.VideoDrain);
  }

  /** Фаза 2+3 event-order policy: состояния устройств, затем публикация IRQ. */
  private processEvents(): void {
    const due = this.events.takeDue(this.clock);
    if (due.length === 0) return;
    const irqToRaise: number[] = [];
    for (const e of due) {
      switch (e.kind) {
        case EventKind.PitChannel: {
          const ch = this.pit.channels[e.channelId]!;
          if (e.channelId === 0) irqToRaise.push(IRQ_TIMER);
          const period = this.pit.periodCycles(ch);
          if (ch.running) {
            this.events.schedule(e.timestamp + period, DeviceId.Pit, e.channelId, EventKind.PitChannel);
          }
          break;
        }
        case EventKind.VideoVsync: {
          this.video.vsyncCount += 1;
          irqToRaise.push(IRQ_VSYNC);
          this.events.schedule(e.timestamp + VSYNC_PERIOD, DeviceId.Video, 1, EventKind.VideoVsync);
          break;
        }
        case EventKind.VideoDrain: {
          const wasAbove = !this.video.belowWatermark();
          const cost = this.video.consume(e.timestamp);
          if (cost === 0) {
            this.metrics.videoIdleCycles += 64;
            this.video.idleCycles += 64;
            if (this.video.bytes.length > 0 || this.video.reserved > 0) {
              this.events.schedule(e.timestamp + 64, DeviceId.Video, 0, EventKind.VideoDrain);
            }
          } else {
            this.events.schedule(e.timestamp + cost, DeviceId.Video, 0, EventKind.VideoDrain);
          }
          if (wasAbove && this.video.belowWatermark()) irqToRaise.push(IRQ_VIDEO_FIFO);
          break;
        }
        case EventKind.DiskDone: {
          this.disk.complete();
          irqToRaise.push(IRQ_DISK);
          break;
        }
        case EventKind.UartTx:
          break;
      }
    }
    // фаза 3: публикация IRQ на входы ВН59
    for (const line of irqToRaise) {
      const edge = this.pic.raise(line, this.clock);
      if (edge) {
        this.lastIrqEdgeCycle = this.clock;
        this.lastIrqLine = line;
        this.pushTrace("irq", `IRQ${line} — фронт на входе ВН59`, { line });
      }
    }
  }

  /** Фаза 4: проверка INTR в архитектурно допустимой точке + последовательность INTA. */
  private serviceInterrupts(): void {
    if (!this.cpu.canAcceptInterrupt()) return;
    const line = this.pic.pending();
    if (line < 0) return;
    const vector = this.pic.acknowledge(line);
    this.metrics.intaCount += 1;
    this.cpu.cycles += 2 * 4; // два цикла INTA
    this.pushTrace("irq", `INTA: IRQ${line} → вектор 0x${vector.toString(16)}`, { line, vector });
    this.cpu.interrupt(vector);
  }

  private trackIfWindow(): void {
    const ifOn = (this.cpu.flags & FLAG_IF) !== 0;
    if (!ifOn) {
      if (this.ifClearedAt === null) this.ifClearedAt = this.clock;
    } else if (this.ifClearedAt !== null) {
      const span = this.clock - this.ifClearedAt;
      if (span > this.metrics.maxIrqBlocked) {
        this.metrics.maxIrqBlocked = span;
        this.metrics.maxIrqBlockedAt = this.ifClearedAt;
      }
      this.ifClearedAt = null;
    }
  }

  private applyFault(): void {
    if (!this.fault || this.faultApplied) return;
    if (this.fault.atCycle !== undefined && this.clock >= this.fault.atCycle) {
      this.video.overflowFlagInjected = true;
      this.faultApplied = true;
      this.pushTrace("violation", "инъекция неисправности: флаг переполнения FIFO");
    }
  }

  /** Один шаг: фазы 1–5 в фиксированном порядке. */
  step(): void {
    this.processEvents(); // фазы 2 и 3
    this.serviceInterrupts(); // фаза 4
    this.applyFault();
    this.cpu.step(); // фаза 5 / фаза 1 следующего шага
    this.trackIfWindow();
    if (this.cpu.halted && this.events.nextTimestamp() !== Infinity) {
      // ЦП стоит — двигаем часы к ближайшему событию, детерминированно
      const next = this.events.nextTimestamp();
      if (next > this.clock) this.cpu.cycles = next;
    }
  }

  /** Прогон до предела тактов или до завершения теста. */
  run(cycleLimit: number, maxSteps = Infinity): "finished" | "limit" | "steps" {
    let steps = 0;
    while (!this.finished) {
      if (this.clock >= cycleLimit) return "limit";
      if (steps >= maxSteps) return "steps";
      this.step();
      steps += 1;
    }
    return "finished";
  }

  // ---------- снапшоты ----------
  snapshot(): MachineSnapshot {
    return {
      modelVersion: this.modelVersion,
      cpu: this.cpu.snapshot(),
      memory: this.memory.snapshot(),
      events: this.events.serialize(),
      pic: {
        irr: this.pic.irr,
        imr: this.pic.imr,
        isr: this.pic.isr,
        vectorBase: this.pic.vectorBase,
        initStep: this.pic.initStep,
        autoEoi: this.pic.autoEoi,
        lastAccessCycle: this.pic.lastAccessCycle,
        irqEdgeCycle: [...this.pic.irqEdgeCycle],
      },
      pit: JSON.parse(JSON.stringify(this.pit.channels)),
      pitLastAccess: this.pit.lastAccessCycle,
      uartOut: this.uart.out,
      videoBytes: [...this.video.bytes],
      videoStream: Array.from(this.video.streamBytes()),
      videoStats: {
        commandCount: this.video.commandCount,
        opcodeHistogram: { ...this.video.opcodeHistogram },
        idleCycles: this.video.idleCycles,
        reserved: this.video.reserved,
        vsyncCount: this.video.vsyncCount,
      },
      markers: this.markers.map((m) => ({ ...m })),
      metrics: { ...this.metrics, irqToWake: [...this.metrics.irqToWake] },
      violations: this.violations.map((v) => ({ ...v })),
      finished: this.finished,
      exitCodeRequested: this.exitCodeRequested,
      ifClearedAt: this.ifClearedAt,
      lastIrqEdgeCycle: this.lastIrqEdgeCycle,
      lastIrqLine: this.lastIrqLine,
    };
  }

  restore(s: MachineSnapshot): void {
    this.cpu.restore(s.cpu);
    this.memory.restore(s.memory);
    this.events.restore(s.events);
    Object.assign(this.pic, s.pic);
    this.pic.irqEdgeCycle = [...s.pic.irqEdgeCycle];
    this.pit.channels = JSON.parse(JSON.stringify(s.pit));
    this.pit.lastAccessCycle = s.pitLastAccess;
    this.uart.out = s.uartOut;
    this.video.bytes = [...s.videoBytes];
    this.video.reset();
    this.video.bytes = [...s.videoBytes];
      (this.video as unknown as { stream: number[] }).stream = [...s.videoStream];
    this.video.commandCount = s.videoStats.commandCount;
    this.video.opcodeHistogram = { ...s.videoStats.opcodeHistogram };
    this.video.idleCycles = s.videoStats.idleCycles;
    this.video.reserved = s.videoStats.reserved;
    this.video.vsyncCount = s.videoStats.vsyncCount;
    this.markers = s.markers.map((m) => ({ ...m }));
    this.metrics = { ...s.metrics, irqToWake: [...s.metrics.irqToWake] };
    this.violations = s.violations.map((v) => ({ ...v }));
    this.finished = s.finished;
    this.exitCodeRequested = s.exitCodeRequested;
    this.ifClearedAt = s.ifClearedAt;
    this.lastIrqEdgeCycle = s.lastIrqEdgeCycle;
    this.lastIrqLine = s.lastIrqLine;
  }
}

export interface PicState {
  irr: number;
  imr: number;
  isr: number;
  vectorBase: number;
  initStep: number;
  autoEoi: boolean;
  lastAccessCycle: number;
  irqEdgeCycle: number[];
}

export interface MachineSnapshot {
  modelVersion: string;
  cpu: Record<string, unknown>;
  memory: Uint8Array;
  events: ReturnType<EventQueue["serialize"]>;
  pic: PicState;
  pit: PitChannel[];
  pitLastAccess: number;
  uartOut: string;
  videoBytes: number[];
  videoStream: number[];
  videoStats: {
    commandCount: number;
    opcodeHistogram: Record<number, number>;
    idleCycles: number;
    reserved: number;
    vsyncCount: number;
  };
  markers: Marker[];
  metrics: Metrics;
  violations: Violation[];
  finished: boolean;
  exitCodeRequested: number | null;
  ifClearedAt: number | null;
  lastIrqEdgeCycle: number;
  lastIrqLine: number;
}

export { FIFO_LOW_WATERMARK };
