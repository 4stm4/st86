import { describe, expect, it } from "vitest";
import { Machine } from "../machine";
import { physAddr } from "../memory";
import { EventQueue } from "../events";
import { DeviceId, EventKind } from "../types";
import { DEFAULT_SCENARIO, prepareMachine, runScenario, evaluate } from "../scenario";
import { getDemoImage } from "../demo";

describe("M1: память и адресация", () => {
  it("wraparound_20bit: FFFF:0010 → 0x00000", () => {
    expect(physAddr(0xffff, 0x0010)).toBe(0x00000);
    expect(physAddr(0x1000, 0x0000)).toBe(0x10000);
    expect(physAddr(0xffff, 0x000f)).toBe(0xfffff);
  });

  it("ROM защищён от записи и нарушение фиксируется", () => {
    const m = new Machine();
    m.reset();
    m.memory.markRom(0x8000, 16);
    m.memWrite8(0x8000, 0x42);
    expect(m.memory.read8(0x8000)).toBe(0);
    expect(m.violations.some((v) => v.kind === "rom_write")).toBe(true);
  });
});

describe("M2: порядок событий", () => {
  it("при равных timestamp порядок — (deviceId, channelId), не порядок вставки", () => {
    const q = new EventQueue();
    q.schedule(100, DeviceId.Video, 1, EventKind.VideoVsync);
    q.schedule(100, DeviceId.Pit, 2, EventKind.PitChannel);
    q.schedule(100, DeviceId.Pit, 0, EventKind.PitChannel);
    const due = q.takeDue(100);
    expect(due.map((e) => [e.deviceId, e.channelId])).toEqual([
      [DeviceId.Pit, 0],
      [DeviceId.Pit, 2],
      [DeviceId.Video, 1],
    ]);
  });

  it("ВИ53 — чистая функция от (t_now − t_load)", () => {
    const m = new Machine();
    m.reset();
    m.pit.write(0x43, 0x36, 0);
    m.pit.write(0x40, 0x10, 0);
    m.pit.write(0x40, 0x00, 0); // count = 16 → период 64 такта
    expect(m.pit.currentCount(0, 0)).toBe(16);
    expect(m.pit.currentCount(0, 64)).toBe(16);
    expect(m.pit.currentCount(0, 32)).toBe(8);
  });

  it("IRQ проходит через ВН59 и INTA, а не напрямую", () => {
    const m = new Machine();
    m.reset();
    m.pic.write(0x21, 0xfe);
    m.pic.raise(0, 0);
    expect(m.pic.pending()).toBe(0);
    const vector = m.pic.acknowledge(0);
    expect(vector).toBe(0x08);
    expect(m.pic.isr & 1).toBe(1);
  });
});

describe("M4/M5: прогон сценария", () => {
  const { machine, report } = runScenario(DEFAULT_SCENARIO);

  it("тест завершается по тестовому порту, код возврата 0", () => {
    expect(machine.finished).toBe(true);
    expect(report.exit_code).toBe(0);
  });

  it("чекпоинты в порядке boot → vfs_ready → done", () => {
    expect(report.asserts[0]!.ok).toBe(true);
  });

  it("UART содержит OK, память содержит DEADBEEF", () => {
    expect(report.uart).toContain("OK");
    expect(report.asserts[3]!.ok).toBe(true);
  });

  it("метрики латентности собраны", () => {
    expect(report.metrics.inta_count).toBeGreaterThanOrEqual(3);
    expect(report.metrics.irq_to_wake_count).toBeGreaterThanOrEqual(3);
    expect(report.metrics.irq_to_wake_max).toBeGreaterThan(0);
  });

  it("видеопоток разобран, хэш стабилен", () => {
    expect(report.video.command_count).toBeGreaterThanOrEqual(4);
    expect(report.video.stream_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const second = runScenario(DEFAULT_SCENARIO).report;
    expect(second.video.stream_hash).toBe(report.video.stream_hash);
  });

  it("детерминизм: повторный прогон даёт те же такты и те же маркеры", () => {
    const again = runScenario(DEFAULT_SCENARIO).report;
    expect(again.cycles).toBe(report.cycles);
    expect(again.markers).toEqual(report.markers);
  });
});

describe("M5: снапшот-roundtrip", () => {
  it("run(A→C) ≡ snapshot+restore(B)", () => {
    const direct = prepareMachine(DEFAULT_SCENARIO);
    direct.run(DEFAULT_SCENARIO.cycle_limit, 4000);
    const viaSnapshot = prepareMachine(DEFAULT_SCENARIO);
    viaSnapshot.run(DEFAULT_SCENARIO.cycle_limit, 2000);
    const snap = viaSnapshot.snapshot();
    const restored = prepareMachine(DEFAULT_SCENARIO);
    restored.restore(snap);
    restored.run(DEFAULT_SCENARIO.cycle_limit, 2000);

    expect(restored.clock).toBe(direct.clock);
    expect(Array.from(restored.cpu.regs)).toEqual(Array.from(direct.cpu.regs));
    expect(restored.cpu.ip).toBe(direct.cpu.ip);
    expect(restored.markers).toEqual(direct.markers);
    expect(restored.events.serialize()).toEqual(direct.events.serialize());
    expect(Buffer.from(restored.memory.data)).toEqual(Buffer.from(direct.memory.data));
  });
});

describe("Стенд строже железа", () => {
  it("запись в FIFO без резервирования — громкая диагностика и код возврата 2", () => {
    const scenario = { ...DEFAULT_SCENARIO, name: "fifo-violation", image: "fifo-violation" };
    const { report } = runScenario(scenario);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.exit_code).toBe(2);
  });

  it("нарушение времени восстановления ВИ53 детектируется", () => {
    const m = new Machine();
    m.reset();
    m.portOut8(0x43, 0x36);
    m.portOut8(0x40, 0x10); // без задержки между обращениями
    expect(m.violations.some((v) => v.kind === "recovery_time")).toBe(true);
  });
});

describe("Отчёт", () => {
  it("содержит версию модели, хэш конфигурации и расшифровку кода возврата", () => {
    const m = prepareMachine(DEFAULT_SCENARIO);
    const outcome = m.run(1000);
    const report = evaluate(m, DEFAULT_SCENARIO, outcome);
    expect(report.model_version).toBeTruthy();
    expect(report.config_hash).toMatch(/^sha256:/);
    expect(report.exit_code).toBe(3);
    expect(report.exit_meaning).toContain("cycle_limit");
  });

  it("встроенные образы собираются", () => {
    expect(getDemoImage("boot").bytes.length).toBeGreaterThan(0x200);
    expect(getDemoImage("bench").bytes.length).toBeGreaterThan(10);
  });
});
