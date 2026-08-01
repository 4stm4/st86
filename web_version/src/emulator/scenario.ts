/**
 * Формат сценария v1 (JSON) и раннер утверждений.
 * Коды возврата: 0 успех, 1 провал утверждения, 2 нарушение инварианта,
 * 3 исчерпан cycle_limit, 4 внутренняя ошибка стенда.
 */
import { Machine } from "./machine";
import { CHECKPOINTS, getDemoImage } from "./demo";
import { sha256 } from "./hash";
import { DEFAULT_WAIT_STATES, EXIT_MEANING, MODEL_VERSION, type ExitCode, type WaitStates } from "./types";

export type Assertion =
  | { kind: "checkpoint_order"; values: string[] }
  | { kind: "metric"; name: "max_irq_blocked" | "irq_to_wake_max" | "video_idle_cycles"; max_cycles: number; irq?: number }
  | { kind: "mem"; addr: string; equals_hex: string }
  | { kind: "uart_contains"; text: string }
  | { kind: "video_stream_hash"; equals: string }
  | { kind: "no_violations" };

export interface Scenario {
  version: 1;
  name: string;
  image: string; // id встроенного образа или "custom"
  cycle_limit: number;
  config?: { wait_states?: Partial<WaitStates> };
  checkpoints?: Record<string, number>;
  asserts: Assertion[];
  fault?: { kind: "fifo_overflow_flag"; at_cycle?: number };
}

export interface AssertResult {
  index: number;
  kind: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  model_version: string;
  scenario: string;
  config_hash: string;
  exit_code: ExitCode;
  exit_meaning: string;
  cycles: number;
  instructions: number;
  asserts: AssertResult[];
  metrics: {
    max_irq_blocked: number;
    irq_to_wake_max: number;
    irq_to_wake_count: number;
    video_idle_cycles: number;
    inta_count: number;
  };
  video: {
    command_count: number;
    opcode_histogram: Record<string, number>;
    stream_hash: string;
    vsync_count: number;
  };
  uart: string;
  markers: { timestamp: number; opcode: number; arg: number }[];
  violations: { cycle: number; kind: string; text: string }[];
}

export const DEFAULT_SCENARIO: Scenario = {
  version: 1,
  name: "boot-basic",
  image: "boot",
  cycle_limit: 5_000_000,
  config: { wait_states: DEFAULT_WAIT_STATES },
  checkpoints: CHECKPOINTS,
  asserts: [
    { kind: "checkpoint_order", values: ["boot", "vfs_ready", "done"] },
    { kind: "metric", name: "max_irq_blocked", max_cycles: 5000 },
    { kind: "metric", name: "irq_to_wake_max", irq: 0, max_cycles: 4000 },
    { kind: "mem", addr: "0x05010", equals_hex: "DEADBEEF" },
    { kind: "uart_contains", text: "OK" },
    { kind: "no_violations" },
  ],
};

export function configHash(scenario: Scenario): string {
  const ws = { ...DEFAULT_WAIT_STATES, ...(scenario.config?.wait_states ?? {}) };
  return `sha256:${sha256(new TextEncoder().encode(JSON.stringify(ws))).slice(0, 16)}`;
}

export interface RunOptions {
  /** пользовательский образ вместо встроенного */
  image?: { bytes: Uint8Array; segment: number; offset: number };
  diskImage?: Uint8Array;
}

export function prepareMachine(scenario: Scenario, opts: RunOptions = {}): Machine {
  const ws: WaitStates = { ...DEFAULT_WAIT_STATES, ...(scenario.config?.wait_states ?? {}) };
  const m = new Machine(ws);
  m.reset();
  if (opts.diskImage) m.disk.loadImage(opts.diskImage);
  const img = opts.image ?? getDemoImage(scenario.image);
  m.loadImage(img.bytes, img.segment, img.offset);
  if (scenario.fault) m.fault = { kind: scenario.fault.kind, ...(scenario.fault.at_cycle !== undefined ? { atCycle: scenario.fault.at_cycle } : {}) };
  return m;
}

export function evaluate(machine: Machine, scenario: Scenario, outcome: "finished" | "limit" | "steps"): Report {
  const cps = scenario.checkpoints ?? CHECKPOINTS;
  const results: AssertResult[] = [];

  scenario.asserts.forEach((a, index) => {
    switch (a.kind) {
      case "checkpoint_order": {
        const expected = a.values.map((v) => cps[v] ?? -1);
        const seen = machine.markers.filter((m) => m.opcode === 0x01).map((m) => m.arg);
        let pos = 0;
        for (const s of seen) if (pos < expected.length && s === expected[pos]) pos += 1;
        const ok = pos === expected.length;
        results.push({
          index,
          kind: a.kind,
          ok,
          detail: ok
            ? `порядок соблюдён: ${a.values.join(" → ")}`
            : `дошли до «${a.values[pos] ?? "?"}»; наблюдённые чекпоинты: [${seen.join(", ")}]`,
        });
        break;
      }
      case "metric": {
        const value =
          a.name === "max_irq_blocked"
            ? machine.metrics.maxIrqBlocked
            : a.name === "irq_to_wake_max"
              ? machine.metrics.irqToWakeMax
              : machine.metrics.videoIdleCycles;
        const ok = value <= a.max_cycles;
        results.push({
          index,
          kind: `${a.kind}:${a.name}`,
          ok,
          detail: `${value} тактов при пороге ${a.max_cycles}`,
        });
        break;
      }
      case "mem": {
        const addr = Number(a.addr);
        const want = a.equals_hex.replace(/\s/g, "").toUpperCase();
        let got = "";
        for (let i = 0; i < want.length / 2; i++) {
          got += machine.memory.read8(addr + i).toString(16).toUpperCase().padStart(2, "0");
        }
        const ok = got === want;
        results.push({
          index,
          kind: a.kind,
          ok,
          detail: ok ? `${a.addr} = ${got}` : `${a.addr}: ожидали ${want}, получили ${got}`,
        });
        break;
      }
      case "uart_contains": {
        const ok = machine.uart.out.includes(a.text);
        results.push({
          index,
          kind: a.kind,
          ok,
          detail: ok ? `найдено «${a.text}»` : `в выводе UART нет «${a.text}» (вывод: ${JSON.stringify(machine.uart.out.slice(0, 120))})`,
        });
        break;
      }
      case "video_stream_hash": {
        const got = machine.video.streamHash();
        const ok = got === a.equals;
        let detail = ok ? got : `ожидали ${a.equals}, получили ${got}`;
        if (!ok) {
          detail += `; команд: ${machine.video.commandCount}`;
        }
        results.push({ index, kind: a.kind, ok, detail });
        break;
      }
      case "no_violations": {
        const all = [...machine.violations, ...machine.video.violations.map((v) => ({ cycle: v.cycle, kind: "video", text: v.text }))];
        const ok = all.length === 0;
        results.push({
          index,
          kind: a.kind,
          ok,
          detail: ok ? "нарушений не зафиксировано" : `нарушений: ${all.length}; первое — ${all[0]!.text} (такт ${all[0]!.cycle})`,
        });
        break;
      }
    }
  });

  const hasViolation = machine.violations.length > 0 || machine.video.violations.length > 0;
  const failed = results.some((r) => !r.ok);
  let exit: ExitCode = 0;
  if (outcome === "limit") exit = 3;
  else if (hasViolation) exit = 2;
  else if (failed) exit = 1;
  else if (machine.exitCodeRequested && machine.exitCodeRequested !== 0) exit = 1;

  return {
    model_version: MODEL_VERSION,
    scenario: scenario.name,
    config_hash: configHash(scenario),
    exit_code: exit,
    exit_meaning: EXIT_MEANING[exit]!,
    cycles: machine.clock,
    instructions: machine.cpu.instructions,
    asserts: results,
    metrics: {
      max_irq_blocked: machine.metrics.maxIrqBlocked,
      irq_to_wake_max: machine.metrics.irqToWakeMax,
      irq_to_wake_count: machine.metrics.irqToWake.length,
      video_idle_cycles: machine.metrics.videoIdleCycles,
      inta_count: machine.metrics.intaCount,
    },
    video: {
      command_count: machine.video.commandCount,
      opcode_histogram: Object.fromEntries(
        Object.entries(machine.video.opcodeHistogram).map(([k, v]) => [`0x${Number(k).toString(16).padStart(2, "0")}`, v]),
      ),
      stream_hash: machine.video.streamHash(),
      vsync_count: machine.video.vsyncCount,
    },
    uart: machine.uart.out,
    markers: machine.markers.map((m) => ({ ...m })),
    violations: [
      ...machine.violations,
      ...machine.video.violations.map((v) => ({ cycle: v.cycle, kind: "video", text: v.text })),
    ],
  };
}

/** Полный синхронный прогон сценария (используется в тестах и в бенчмарке). */
export function runScenario(scenario: Scenario, opts: RunOptions = {}): { machine: Machine; report: Report } {
  const machine = prepareMachine(scenario, opts);
  const outcome = machine.run(scenario.cycle_limit);
  return { machine, report: evaluate(machine, scenario, outcome) };
}

/** Гистограмма латентности «IRQ → пробуждение задачи». */
export function histogram(values: number[], buckets = 12): { from: number; to: number; count: number }[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const step = Math.ceil(span / buckets);
  const out: { from: number; to: number; count: number }[] = [];
  for (let i = 0; i < buckets; i++) {
    const from = min + i * step;
    const to = from + step;
    const count = values.filter((v) => v >= from && (i === buckets - 1 ? v <= to : v < to)).length;
    out.push({ from, to, count });
  }
  return out;
}
