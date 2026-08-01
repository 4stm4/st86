import { createFileRoute } from "@tanstack/react-router";
import { Panel, PageShell, Stat, Button } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import { runBenchmark } from "@/lib/st86-store";
import { CPU_HZ } from "@/emulator/types";

export const Route = createFileRoute("/bench")({
  head: () => ({
    meta: [
      { title: "st86 — бенчмарк скорости модели" },
      {
        name: "description",
        content: "Сколько тактов КР1810ВМ86 модель прогоняет за секунду реального времени в браузере и во сколько раз это быстрее железа.",
      },
      { property: "og:title", content: "st86 — бенчмарк модели" },
      { property: "og:description", content: "Тактов в секунду, инструкций в секунду, коэффициент к реальным 5 МГц." },
    ],
  }),
  component: BenchPage,
});

function BenchPage() {
  const s = useSt86();
  const b = s.benchResult;
  const ratio = b ? b.cyclesPerSecond / CPU_HZ : 0;

  return (
    <PageShell
      title="Бенчмарк"
      lead="Единственное место, где стенд смотрит на настенные часы. Внутри модели времени существует только MasterClock, поэтому скорость хоста не влияет на результат прогона — только на то, как долго его ждать."
    >
      <Button variant="primary" onClick={() => runBenchmark(1500)}>
        Прогнать 1,5 с образа «bench»
      </Button>

      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label="тактов/с" value={b ? b.cyclesPerSecond.toLocaleString("ru-RU") : "—"} />
        <Stat label="инструкций/с" value={b ? b.instructionsPerSecond.toLocaleString("ru-RU") : "—"} />
        <Stat
          label="к реальным 5 МГц"
          value={b ? `×${ratio.toFixed(2)}` : "—"}
          tone={b ? (ratio >= 1 ? "ok" : "warn") : "default"}
        />
      </div>

      <Panel title="Как читать">
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>×1 и выше означает, что модель идёт не медленнее настоящей платы «Челябинск-1».</li>
          <li>Результат зависит от машины и браузера и не входит в вердикт сценария.</li>
          <li>Прогон детерминирован: те же образ и сценарий дают тот же MasterClock и тот же хеш видеопотока.</li>
        </ul>
      </Panel>
    </PageShell>
  );
}
