// Общие типы модели st86. Чистый TypeScript, без DOM и без wall-clock.

export const CPU_HZ = 5_000_000;

/** Идентификаторы устройств — используются в детерминированном порядке событий. */
export enum DeviceId {
  Cpu = 0,
  Pit = 1,
  Pic = 2,
  Uart = 3,
  Disk = 4,
  Video = 5,
  TestPort = 6,
}

export enum EventKind {
  PitChannel = "pit_channel",
  VideoDrain = "video_drain",
  VideoVsync = "video_vsync",
  DiskDone = "disk_done",
  UartTx = "uart_tx",
}

export interface SimEvent {
  timestamp: number;
  deviceId: DeviceId;
  channelId: number;
  kind: EventKind;
}

export interface TraceEvent {
  timestamp: number;
  channel: "marker" | "irq" | "io" | "violation" | "video" | "cpu";
  text: string;
  data?: Record<string, number | string>;
}

/** Область карты памяти/портов с собственным числом тактов ожидания. */
export interface WaitStates {
  ram: number;
  rom: number;
  consoleBank: number;
  timerPic: number;
  videoFifo: number;
  /** минимальное число тактов между обращениями к ВИ53/ВН59 */
  recoveryCycles: number;
}

export const DEFAULT_WAIT_STATES: WaitStates = {
  ram: 0,
  rom: 0,
  consoleBank: 0,
  timerPic: 1,
  videoFifo: 0,
  recoveryCycles: 8,
};

export const MODEL_VERSION = "st86-web/0.1.0";

export type ExitCode = 0 | 1 | 2 | 3 | 4;

export const EXIT_MEANING: Record<number, string> = {
  0: "успех",
  1: "провал утверждения",
  2: "нарушение инварианта/дисциплины",
  3: "исчерпан cycle_limit",
  4: "внутренняя ошибка стенда",
};
