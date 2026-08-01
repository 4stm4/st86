import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Panel, Stat } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import {
  DEMO_IMAGES,
  loadScenarioText,
  pause,
  reset,
  run,
  runToCompletion,
  selectImage,
  sendUartByte,
  sendUartText,
  setCustomImage,
  stepMany,
  stepOnce,
} from "@/lib/st86-store";
import { EXIT_MEANING } from "@/emulator/types";
import { VideoRenderer } from "@/emulator/video-renderer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "st86 — панель прогона стенда «Челябинск-1»" },
      {
        name: "description",
        content:
          "Загрузите образ и сценарий, прогоните машину КР1810ВМ86 в браузере и получите машиночитаемый вердикт с кодом возврата.",
      },
      { property: "og:title", content: "st86 — панель прогона стенда «Челябинск-1»" },
      {
        property: "og:description",
        content: "Загрузите образ и сценарий, прогоните машину КР1810ВМ86 в браузере и получите машиночитаемый вердикт с кодом возврата.",
      },
    ],
  }),
  component: RunPanel,
});

function RunPanel() {
  const s = useSt86();
  const [fileName, setFileName] = useState<string | null>(null);

  const onFile = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    setCustomImage(file.name, buf);
    setFileName(file.name);
  };

  const report = s.report;
  const passed = report?.asserts.filter((a) => a.ok).length ?? 0;
  const total = report?.asserts.length ?? s.scenario.asserts.length;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <div className="relative overflow-hidden border border-border bg-panel px-6 py-8">
        <div className="scan-grid pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
            автоматический критерий «работает / не работает»
          </p>
          <h1 className="mt-3 max-w-3xl font-mono text-3xl leading-tight text-foreground">
            Стенд «Челябинск-1»: модель платы, прогон сценариев, утверждения, метрики латентности
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
            Не эмулятор ради эмуляции. Одна ось времени (такты ЦП), ленивые устройства, IRQ только через ВН59 и
            полноценный INTA. Главная измеряемая величина — ограниченная худшая задержка, а не средняя пропускная
            способность.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Panel
            title="Управление прогоном"
            right={
              <Badge tone={s.runState === "running" ? "warn" : s.runState === "finished" ? "ok" : "muted"}>
                {s.runState === "idle"
                  ? "готов"
                  : s.runState === "running"
                    ? "выполняется"
                    : s.runState === "paused"
                      ? "пауза"
                      : "завершён"}
              </Badge>
            }
          >
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={runToCompletion}>
                Прогнать сценарий
              </Button>
              <Button onClick={run} disabled={s.runState === "running"}>
                Старт
              </Button>
              <Button onClick={pause} disabled={s.runState !== "running"}>
                Пауза
              </Button>
              <Button onClick={stepOnce}>Шаг</Button>
              <Button onClick={() => stepMany(1000)}>+1000 шагов</Button>
              <Button onClick={reset}>Сброс</Button>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-4">
              <Stat label="MasterClock" value={s.clock.toLocaleString("ru-RU")} />
              <Stat label="Инструкций" value={s.instructions.toLocaleString("ru-RU")} />
              <Stat
                label="Утверждений"
                value={report ? `${passed}/${total}` : `— / ${total}`}
                tone={report ? (passed === total ? "ok" : "fail") : "default"}
              />
              <Stat
                label="Код возврата"
                value={report ? `${report.exit_code}` : "—"}
                tone={report ? (report.exit_code === 0 ? "ok" : "fail") : "default"}
              />
            </div>
            {report && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                {EXIT_MEANING[report.exit_code]} · модель {report.model_version} · конфиг {report.config_hash}
              </p>
            )}
          </Panel>

          <Panel title="Утверждения сценария">
            {!report ? (
              <p className="text-sm text-muted-foreground">
                Прогон ещё не выполнялся. Нажмите «Прогнать сценарий» — вердикт появится здесь.
              </p>
            ) : (
              <ul className="space-y-2">
                {report.asserts.map((a) => (
                  <li key={a.index} className="flex flex-wrap items-center gap-3 border border-border bg-card px-3 py-2">
                    <Badge tone={a.ok ? "ok" : "fail"}>{a.ok ? "pass" : "fail"}</Badge>
                    <span className="font-mono text-xs text-foreground">{a.kind}</span>
                    <span className="font-mono text-xs text-muted-foreground">{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {report && report.violations.length > 0 && (
              <div className="mt-4 border border-destructive/40 bg-destructive/10 p-3">
                <p className="font-mono text-xs uppercase tracking-wider text-destructive">
                  Нарушения дисциплины ({report.violations.length}) — стенд строже железа
                </p>
                <ul className="mt-2 space-y-1">
                  {report.violations.slice(0, 8).map((v, i) => (
                    <li key={i} className="font-mono text-xs text-foreground">
                      такт {v.cycle}: [{v.kind}] {v.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <Panel title="Сценарий (JSON, формат v1)">
            <textarea
              value={s.scenarioText}
              onChange={(e) => loadScenarioText(e.target.value)}
              spellCheck={false}
              rows={18}
              className="w-full resize-y border border-input bg-background p-3 font-mono text-xs text-foreground outline-none focus:border-ring"
            />
            {s.error && <p className="mt-2 font-mono text-xs text-destructive">{s.error}</p>}
            <p className="mt-2 text-xs text-muted-foreground">
              Пороги латентности задаются в тактах, а не в микросекундах: частота не протекает в утверждения.
            </p>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Образ">
            <div className="space-y-2">
              {DEMO_IMAGES.map((img) => (
                <button
                  key={img.id}
                  onClick={() => {
                    selectImage(img.id);
                    setFileName(null);
                  }}
                  className={`block w-full border px-3 py-2 text-left transition-colors ${
                    s.imageId === img.id && !s.customImage
                      ? "border-primary bg-secondary"
                      : "border-border bg-card hover:bg-secondary"
                  }`}
                >
                  <div className="font-mono text-xs text-foreground">{img.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{img.description}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {img.bytes.length} Б · загрузка в {img.segment.toString(16).padStart(4, "0")}:
                    {img.offset.toString(16).padStart(4, "0")}
                  </div>
                </button>
              ))}
            </div>
            <label className="mt-3 block border border-dashed border-border bg-card px-3 py-3 text-center text-xs text-muted-foreground hover:border-primary">
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              {fileName ? (
                <span className="font-mono text-foreground">{fileName}</span>
              ) : (
                "Загрузить свой сырой образ (.bin) → CS:IP = 0000:0100"
              )}
            </label>
          </Panel>

          <Panel title="Карта портов «Челябинск-1»">
            <dl className="space-y-1 font-mono text-[11px]">
              {[
                ["0x20 / 0x21", "ВН59А — контроллер прерываний"],
                ["0x40–0x43", "ВИ53 — таймер"],
                ["0xD0–0xD4", "блочное устройство, PIO (DMA нет)"],
                ["0xE0 / 0xE1", "видео-FIFO: данные / резервирование"],
                ["0xE2 / 0xE3", "UART: данные / статус"],
                ["0xE4 / 0xE5", "FIFO_FREE (read-only, 16 бит)"],
                ["0xE6", "флаги платы"],
                ["0xF0–0xF6", "тестовый порт (semihosting)"],
              ].map(([port, what]) => (
                <div key={port} className="flex justify-between gap-3 border-b border-border/60 py-1">
                  <dt className="text-primary">{port}</dt>
                  <dd className="text-right text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="UART-терминал">
            <UartTerminal machine={s.machine} />
          </Panel>

          <Panel title="Видеовыход RP2040">
            <VideoCanvas machine={s.machine} />
          </Panel>

          <Panel title="Дальше">
            <div className="flex flex-col gap-2">
              <Link to="/machine" className="font-mono text-xs text-accent hover:underline">
                → регистры, память, дизассемблер
              </Link>
              <Link to="/trace" className="font-mono text-xs text-accent hover:underline">
                → поток событий и маркеров
              </Link>
              <Link to="/metrics" className="font-mono text-xs text-accent hover:underline">
                → гистограммы латентности
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}

function UartTerminal({ machine }: { machine: import("@/emulator/machine").Machine | null }) {
  const outRef = useRef<HTMLPreElement>(null);
  const [inputVal, setInputVal] = useState("");
  const uartOut = machine?.uart.out ?? "";

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [uartOut]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!machine) return;
      if (e.key === "Enter") {
        sendUartText(inputVal + "\r");
        setInputVal("");
        e.preventDefault();
      }
    },
    [machine, inputVal],
  );

  const onSendChar = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!machine) return;
      if (e.key.length === 1) {
        sendUartByte(e.key.charCodeAt(0));
      } else if (e.key === "Enter") {
        sendUartByte(0x0d);
      } else if (e.key === "Backspace") {
        sendUartByte(0x08);
      }
    },
    [machine],
  );

  return (
    <div>
      <pre
        ref={outRef}
        className="max-h-48 min-h-[6rem] overflow-auto whitespace-pre-wrap break-all border border-border bg-background p-2 font-mono text-xs text-ok"
      >
        {uartOut || "— пусто —"}
      </pre>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ввод → Enter (строка в rxQueue)"
          disabled={!machine}
          className="flex-1 border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring disabled:opacity-40"
        />
        <Button
          onClick={() => {
            if (inputVal) {
              sendUartText(inputVal + "\r");
              setInputVal("");
            }
          }}
          disabled={!machine || !inputVal}
        >
          Send
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Каждый символ попадает в uart.rxQueue — прошивка читает через IN 0xE2
      </p>
    </div>
  );
}

const videoRenderer = new VideoRenderer();

function VideoCanvas({ machine }: { machine: import("@/emulator/machine").Machine | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState("");

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !machine) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const stream = machine.video.streamBytes();
    if (stream.length === 0) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, videoRenderer.width, videoRenderer.height);
      setInfo("поток пуст");
      return;
    }
    videoRenderer.renderStream(stream, ctx);
    setInfo(`${machine.video.commandCount} команд · поток ${stream.length} Б · отрисовано`);
  }, [machine]);

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={videoRenderer.width}
        height={videoRenderer.height}
        className="w-full border border-border bg-black"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={render}>Обновить</Button>
        <span className="font-mono text-[10px] text-muted-foreground">
          {machine ? info || "нажмите «Обновить»" : "нет машины"}
        </span>
      </div>
    </div>
  );
}
