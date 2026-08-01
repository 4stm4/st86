import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Panel, PageShell } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import { reset, stepMany, stepOnce } from "@/lib/st86-store";
import { disassemble } from "@/emulator/disasm";
import {
  FLAG_AF,
  FLAG_CF,
  FLAG_DF,
  FLAG_IF,
  FLAG_OF,
  FLAG_PF,
  FLAG_SF,
  FLAG_TF,
  FLAG_ZF,
} from "@/emulator/cpu";

export const Route = createFileRoute("/machine")({
  head: () => ({
    meta: [
      { title: "st86 — состояние машины: регистры, память, дизассемблер" },
      {
        name: "description",
        content: "Регистры КР1810ВМ86, флаги, очередь предвыборки, дамп памяти по 20-битному адресу и дизассемблер вокруг CS:IP.",
      },
      { property: "og:title", content: "st86 — состояние машины" },
      { property: "og:description", content: "Регистры, флаги, очередь предвыборки, дамп памяти и дизассемблер 8086." },
    ],
  }),
  component: MachinePage,
});

const R = ["AX", "CX", "DX", "BX", "SP", "BP", "SI", "DI"];
const S = ["ES", "CS", "SS", "DS"];
const FLAGS: [string, number][] = [
  ["OF", FLAG_OF],
  ["DF", FLAG_DF],
  ["IF", FLAG_IF],
  ["TF", FLAG_TF],
  ["SF", FLAG_SF],
  ["ZF", FLAG_ZF],
  ["AF", FLAG_AF],
  ["PF", FLAG_PF],
  ["CF", FLAG_CF],
];

const h4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");
const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
const h5 = (v: number) => v.toString(16).toUpperCase().padStart(5, "0");

function MachinePage() {
  const s = useSt86();
  const [dumpAddr, setDumpAddr] = useState("0x05000");
  const m = s.machine;

  if (!m) {
    return (
      <PageShell title="Состояние машины" lead="Машина ещё не собрана — инициализируйте её.">
        <Button variant="primary" onClick={reset}>
          Инициализировать машину
        </Button>
      </PageShell>
    );
  }

  const cs = m.cpu.segs[1]!;
  const pc = ((cs << 4) + m.cpu.ip) & 0xfffff;
  const lines = disassemble((a) => m.memory.read8(a), pc, 14);
  const base = (Number(dumpAddr) || 0) & 0xffff0;
  const rows = Array.from({ length: 16 }, (_, r) => base + r * 16);

  return (
    <PageShell
      title="Состояние машины"
      lead="Прямое наблюдение за моделью: регистры и флаги ЦП, очередь предвыборки BIU, физическая память (20 бит, с заворотом) и дизассемблер вокруг CS:IP."
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={stepOnce}>Шаг</Button>
        <Button onClick={() => stepMany(100)}>+100</Button>
        <Button onClick={() => stepMany(10_000)}>+10 000</Button>
        <Button onClick={reset}>Сброс</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Регистры" className="lg:col-span-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
            {R.map((name, i) => (
              <div key={name} className="flex justify-between border-b border-border/50 py-1">
                <span className="text-muted-foreground">{name}</span>
                <span className="text-foreground">{h4(m.cpu.regs[i]!)}</span>
              </div>
            ))}
            {S.map((name, i) => (
              <div key={name} className="flex justify-between border-b border-border/50 py-1">
                <span className="text-accent">{name}</span>
                <span className="text-foreground">{h4(m.cpu.segs[i]!)}</span>
              </div>
            ))}
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-accent">IP</span>
              <span className="text-foreground">{h4(m.cpu.ip)}</span>
            </div>
            <div className="flex justify-between border-b border-border/50 py-1">
              <span className="text-muted-foreground">FLAGS</span>
              <span className="text-foreground">{h4(m.cpu.flags)}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {FLAGS.map(([name, mask]) => (
              <span
                key={name}
                className={`border px-1.5 py-0.5 font-mono text-[10px] ${
                  m.cpu.flags & mask ? "border-primary/60 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {name}
              </span>
            ))}
          </div>
          <dl className="mt-3 space-y-1 font-mono text-[11px] text-muted-foreground">
            <div className="flex justify-between">
              <dt>HALT</dt>
              <dd className={m.cpu.halted ? "text-warn" : ""}>{m.cpu.halted ? "да" : "нет"}</dd>
            </div>
            <div className="flex justify-between">
              <dt>тень прерываний</dt>
              <dd>{m.cpu.intShadow ? "да" : "нет"}</dd>
            </div>
            <div className="flex justify-between">
              <dt>очередь предвыборки</dt>
              <dd className="text-foreground">
                {m.cpu.prefetch.length ? m.cpu.prefetch.map(h2).join(" ") : "пусто"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>MasterClock</dt>
              <dd className="text-foreground">{m.clock.toLocaleString("ru-RU")}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title={`Дизассемблер · CS:IP = ${h4(cs)}:${h4(m.cpu.ip)}`} className="lg:col-span-2">
          <pre className="overflow-auto font-mono text-xs leading-6">
            {lines.map((l, i) => (
              <div key={l.addr} className={i === 0 ? "bg-secondary text-primary" : "text-foreground"}>
                <span className="text-muted-foreground">{h5(l.addr)}  </span>
                <span className="text-muted-foreground">{l.bytes.map(h2).join(" ").padEnd(18, " ")}</span>
                {l.text}
              </div>
            ))}
          </pre>
        </Panel>
      </div>

      <Panel
        title="Дамп памяти"
        right={
          <input
            value={dumpAddr}
            onChange={(e) => setDumpAddr(e.target.value)}
            className="w-32 border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
          />
        }
      >
        <pre className="overflow-auto font-mono text-xs leading-6">
          {rows.map((addr) => {
            const bytes = Array.from({ length: 16 }, (_, i) => m.memory.read8(addr + i));
            const ascii = bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
            return (
              <div key={addr}>
                <span className="text-primary">{h5(addr)}  </span>
                <span className="text-foreground">{bytes.map(h2).join(" ")}</span>
                <span className="text-muted-foreground">  {ascii}</span>
              </div>
            );
          })}
        </pre>
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel title="ВН59А — прерывания">
          <dl className="space-y-1 font-mono text-xs">
            {[
              ["IRR", h2(m.pic.irr)],
              ["IMR", h2(m.pic.imr)],
              ["ISR", h2(m.pic.isr)],
              ["база векторов", h2(m.pic.vectorBase)],
              ["INTA всего", String(m.metrics.intaCount)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/50 py-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="ВИ53 — таймер">
          <dl className="space-y-1 font-mono text-xs">
            {m.pit.channels.map((c, i) => (
              <div key={i} className="flex justify-between border-b border-border/50 py-1">
                <dt className="text-muted-foreground">канал {i}</dt>
                <dd>
                  режим {c.mode} · делитель {c.count || 65536} · {c.running ? "идёт" : "стоп"}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="Видео-FIFO">
          <dl className="space-y-1 font-mono text-xs">
            {[
              ["занято", `${m.video.bytes.length} Б`],
              ["зарезервировано", `${m.video.reserved} Б`],
              ["команд", String(m.video.commandCount)],
              ["простой", `${m.video.idleCycles} тактов`],
              ["vsync", String(m.video.vsyncCount)],
              ["нарушений", String(m.video.violations.length)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/50 py-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={k === "нарушений" && m.video.violations.length ? "text-destructive" : ""}>{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </PageShell>
  );
}
