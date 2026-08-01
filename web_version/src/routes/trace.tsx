import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge, Panel, PageShell } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import { MARKER_NAMES } from "@/emulator/machine";
import type { TraceEvent } from "@/emulator/types";

export const Route = createFileRoute("/trace")({
  head: () => ({
    meta: [
      { title: "st86 — трасса событий и маркеров" },
      {
        name: "description",
        content: "Поток событий стенда: прерывания, INTA, обращения к портам, маркеры тестового порта и нарушения дисциплины по тактам.",
      },
      { property: "og:title", content: "st86 — трасса событий" },
      { property: "og:description", content: "Единая ось времени: IRQ, INTA, ввод-вывод, маркеры и нарушения." },
    ],
  }),
  component: TracePage,
});

const CHANNELS: TraceEvent["channel"][] = ["marker", "irq", "io", "video", "violation", "cpu"];
const TONE: Record<string, string> = {
  marker: "text-primary",
  irq: "text-accent",
  io: "text-foreground",
  video: "text-ok",
  violation: "text-destructive",
  cpu: "text-muted-foreground",
};

function TracePage() {
  const s = useSt86();
  const [active, setActive] = useState<Set<string>>(new Set(CHANNELS));
  const [query, setQuery] = useState("");

  const events = s.machine?.trace ?? [];
  const filtered = useMemo(
    () =>
      events.filter(
        (e) => active.has(e.channel) && (query === "" || e.text.toLowerCase().includes(query.toLowerCase())),
      ),
    [events, active, query],
  );

  const toggle = (c: string) => {
    const next = new Set(active);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setActive(next);
  };

  return (
    <PageShell
      title="Трасса"
      lead="Всё пишется на одну ось MasterClock. Трасса — это то, по чему воспроизводится баг: такт, канал, событие."
    >
      <div className="flex flex-wrap items-center gap-2">
        {CHANNELS.map((c) => (
          <button
            key={c}
            onClick={() => toggle(c)}
            className={`border px-2 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
              active.has(c) ? "border-primary text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {c}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="фильтр по тексту"
          className="ml-auto w-56 border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring"
        />
      </div>

      <Panel title={`События (${filtered.length} из ${events.length})`}>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пусто. Запустите прогон на панели «Прогон».</p>
        ) : (
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full font-mono text-xs">
              <thead className="sticky top-0 bg-panel text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-4 font-normal">такт</th>
                  <th className="py-1 pr-4 font-normal">канал</th>
                  <th className="py-1 font-normal">событие</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(-2000).map((e, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="py-1 pr-4 text-muted-foreground">{e.timestamp.toLocaleString("ru-RU")}</td>
                    <td className={`py-1 pr-4 ${TONE[e.channel]}`}>{e.channel}</td>
                    <td className="py-1">
                      {e.text}
                      {e.data && (
                        <span className="ml-2 text-muted-foreground">
                          {Object.entries(e.data)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" ")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Маркеры тестового порта">
        {!s.machine || s.machine.markers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Маркеров нет.</p>
        ) : (
          <ul className="grid gap-1 md:grid-cols-2">
            {s.machine.markers.map((m, i) => (
              <li key={i} className="flex items-center gap-3 border border-border bg-card px-2 py-1 font-mono text-xs">
                <Badge tone="muted">{m.timestamp.toLocaleString("ru-RU")}</Badge>
                <span className="text-primary">{MARKER_NAMES[m.opcode] ?? `0x${m.opcode.toString(16)}`}</span>
                <span className="text-muted-foreground">arg={m.arg}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageShell>
  );
}
