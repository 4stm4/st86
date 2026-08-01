/** Клиентское хранилище состояния стенда: одна Machine + подписки для React. */
import { Machine } from "@/emulator/machine";
import { DEMO_IMAGES, getDemoImage } from "@/emulator/demo";
import {
  DEFAULT_SCENARIO,
  evaluate,
  prepareMachine,
  type Report,
  type Scenario,
} from "@/emulator/scenario";

export type RunState = "idle" | "running" | "paused" | "finished";

interface State {
  scenario: Scenario;
  scenarioText: string;
  imageId: string;
  customImage: { bytes: Uint8Array; segment: number; offset: number; name: string } | null;
  machine: Machine | null;
  report: Report | null;
  runState: RunState;
  outcome: "finished" | "limit" | "steps" | null;
  clock: number;
  instructions: number;
  stepsPerChunk: number;
  benchResult: { cyclesPerSecond: number; instructionsPerSecond: number; wallMs: number } | null;
  error: string | null;
}

let state: State = {
  scenario: DEFAULT_SCENARIO,
  scenarioText: JSON.stringify(DEFAULT_SCENARIO, null, 2),
  imageId: DEFAULT_SCENARIO.image,
  customImage: null,
  machine: null,
  report: null,
  runState: "idle",
  outcome: null,
  clock: 0,
  instructions: 0,
  stepsPerChunk: 200_000,
  benchResult: null,
  error: null,
};

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): State {
  return state;
}

export function getServerState(): State {
  return state;
}

function imageOption() {
  if (state.customImage) {
    return {
      bytes: state.customImage.bytes,
      segment: state.customImage.segment,
      offset: state.customImage.offset,
    };
  }
  const img = getDemoImage(state.imageId);
  return { bytes: img.bytes, segment: img.segment, offset: img.offset };
}

export function loadScenarioText(text: string): void {
  emit({ scenarioText: text });
  try {
    const parsed = JSON.parse(text) as Scenario;
    if (parsed.version !== 1) throw new Error("поддерживается только version = 1");
    emit({ scenario: parsed, imageId: state.customImage ? state.imageId : parsed.image, error: null });
  } catch (e) {
    emit({ error: `сценарий: ${(e as Error).message}` });
  }
}

export function selectImage(id: string): void {
  emit({ imageId: id, customImage: null });
  reset();
}

export function setCustomImage(name: string, bytes: Uint8Array, segment = 0x0000, offset = 0x0100): void {
  emit({ customImage: { name, bytes, segment, offset } });
  reset();
}

export function reset(): void {
  stop();
  const scenario = { ...state.scenario, image: state.imageId };
  const machine = prepareMachine(scenario, { image: imageOption() });
  emit({
    machine,
    report: null,
    runState: "idle",
    outcome: null,
    clock: 0,
    instructions: 0,
  });
}

function ensureMachine(): Machine {
  if (!state.machine) reset();
  return state.machine!;
}

export function stepOnce(): void {
  const m = ensureMachine();
  if (m.finished) return;
  m.step();
  emit({ clock: m.clock, instructions: m.cpu.instructions, runState: "paused" });
}

export function stepMany(n: number): void {
  const m = ensureMachine();
  for (let i = 0; i < n && !m.finished; i++) m.step();
  emit({ clock: m.clock, instructions: m.cpu.instructions, runState: m.finished ? "finished" : "paused" });
  if (m.finished) finalize("finished");
}

function finalize(outcome: "finished" | "limit" | "steps"): void {
  const m = state.machine;
  if (!m) return;
  const report = evaluate(m, { ...state.scenario, image: state.imageId }, outcome);
  emit({ report, outcome, runState: "finished" });
}

export function run(): void {
  const m = ensureMachine();
  if (m.finished) return;
  emit({ runState: "running" });
  const limit = state.scenario.cycle_limit;
  const tick = (): void => {
    if (state.runState !== "running" || !state.machine) return;
    const machine = state.machine;
    const outcome = machine.run(limit, state.stepsPerChunk);
    emit({ clock: machine.clock, instructions: machine.cpu.instructions });
    if (outcome === "finished") return finalize("finished");
    if (outcome === "limit") return finalize("limit");
    timer = setTimeout(tick, 0);
  };
  timer = setTimeout(tick, 0);
}

export function pause(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (state.runState === "running") emit({ runState: "paused" });
}

export function stop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Полный прогон синхронно (кнопка «прогнать сценарий»). */
export function runToCompletion(): void {
  stop();
  const scenario = { ...state.scenario, image: state.imageId };
  const machine = prepareMachine(scenario, { image: imageOption() });
  const outcome = machine.run(scenario.cycle_limit);
  const report = evaluate(machine, scenario, outcome);
  emit({
    machine,
    report,
    outcome,
    runState: "finished",
    clock: machine.clock,
    instructions: machine.cpu.instructions,
  });
}

/** Бенчмарк: wall-clock допускается только здесь, снаружи модели. */
export function runBenchmark(wallMs = 1500): void {
  const img = getDemoImage("bench");
  const machine = new Machine();
  machine.reset();
  machine.loadImage(img.bytes, img.segment, img.offset);
  const t0 = performance.now();
  let elapsed = 0;
  while (elapsed < wallMs) {
    machine.run(Number.MAX_SAFE_INTEGER, 200_000);
    elapsed = performance.now() - t0;
  }
  emit({
    benchResult: {
      cyclesPerSecond: Math.round((machine.clock / elapsed) * 1000),
      instructionsPerSecond: Math.round((machine.cpu.instructions / elapsed) * 1000),
      wallMs: Math.round(elapsed),
    },
  });
}

export function sendUartByte(byte: number): void {
  const m = state.machine;
  if (!m) return;
  m.uart.rxQueue.push(byte & 0xff);
}

export function sendUartText(text: string): void {
  const m = state.machine;
  if (!m) return;
  for (let i = 0; i < text.length; i++) {
    m.uart.rxQueue.push(text.charCodeAt(i) & 0xff);
  }
}

export { DEMO_IMAGES };
