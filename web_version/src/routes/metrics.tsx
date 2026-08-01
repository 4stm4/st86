import { createFileRoute } from "@tanstack/react-router";
import { Panel, PageShell, Stat } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import { histogram } from "@/emulator/scenario";
import { CPU_HZ } from "@/emulator/types";

export const Route = createFileRoute("/metrics")({
  head: () => ({
    meta: [
      { title: "st86 — метрики латентности и гистограммы" },
      {
        name: "description",
        content: "max_irq_blocked, irq_to_wake_max, простой видеоконвейера и гистограмма задержек «прерывание → пробуждение задачи» в тактах.",
      },
      { property: "og:title", content: "st86 — метрики латентности" },
      { property: "og:description", content: "Худшая ограниченная задержка вместо средней пропускной способности." },
    ],
  }),
  component: MetricsPage,
});

const toUs = (cycles: number) => ((cycles / CPU_HZ) * 1e6).toFixed(1);

function MetricsPage() {
  const s = useSt86();
  const m = s.machine;
  const values = m?.metrics.irqToWake ?? [];
  const buckets = histogram(values);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const opcodes = Object.entries(m?.video.opcodeHistogram ?? {});
  const maxOp = Math.max(1, ...opcodes.map(([, v]) => v));

  return (
    <PageShell
      title="Метрики"
      lead="Стенд меряет то, что ломает интерактивность: худшую задержку реакции на прерывание и время, пока прерывания были закрыты. Всё — в тактах; микросекунды показаны справочно для 5 МГц."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="max_irq_blocked"
          value={`${m?.metrics.maxIrqBlocked ?? 0} т`}
          tone={(m?.metrics.maxIrqBlocked ?? 0) > 5000 ? "fail" : "ok"}
        />
        <Stat label="irq_to_wake_max" value={`${m?.metrics.irqToWakeMax ?? 0} т`} />
        <Stat label="простой видео" value={`${m?.metrics.videoIdleCycles ?? 0} т`} />
        <Stat label="циклов INTA" value={m?.metrics.intaCount ?? 0} />
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        max_irq_blocked ≈ {toUs(m?.metrics.maxIrqBlocked ?? 0)} мкс · irq_to_wake_max ≈{" "}
        {toUs(m?.metrics.irqToWakeMax ?? 0)} мкс при 5 МГц · пик закрытия прерываний на такте{" "}
        {(m?.metrics.maxIrqBlockedAt ?? 0).toLocaleString("ru-RU")}
      </p>

      <Panel title={`Гистограмма «IRQ → пробуждение», выборок: ${values.length}`}>
        {buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground">Нет данных: прогон не выполнялся или прерывания не приходили.</p>
        ) : (
          <div className="space-y-1">
            {buckets.map((b, i) => (
              <div key={i} className="flex items-center gap-3 font-mono text-xs">
                <span className="w-32 text-right text-muted-foreground">
                  {b.from}–{b.to} т
                </span>
                <span
                  className="h-4 bg-primary/70"
                  style={{ width: `${(b.count / maxCount) * 70}%`, minWidth: b.count ? "2px" : 0 }}
                />
                <span className="text-muted-foreground">{b.count}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Профиль видео-команд (L0)">
        {opcodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Команд в видео-FIFO не было.</p>
        ) : (
          <div className="space-y-1">
            {opcodes.map(([op, count]) => (
              <div key={op} className="flex items-center gap-3 font-mono text-xs">
                <span className="w-24 text-right text-accent">0x{Number(op).toString(16).padStart(2, "0")}</span>
                <span className="h-4 bg-accent/70" style={{ width: `${(count / maxOp) * 70}%` }} />
                <span className="text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Хеш видеопотока:{" "}
          <span className="font-mono text-foreground">{m ? m.video.streamHash() : "—"}</span>
        </p>
      </Panel>
    </PageShell>
  );
}
