import { createFileRoute } from "@tanstack/react-router";
import { Badge, Button, Panel, PageShell } from "@/components/st86/ui";
import { useSt86 } from "@/hooks/use-st86";
import { runToCompletion } from "@/lib/st86-store";

export const Route = createFileRoute("/report")({
  head: () => ({
    meta: [
      { title: "st86 — машиночитаемый отчёт прогона" },
      {
        name: "description",
        content: "JSON-отчёт стенда: код возврата, утверждения, метрики, хеш видеопотока и нарушения — то, что читает CI.",
      },
      { property: "og:title", content: "st86 — отчёт прогона" },
      { property: "og:description", content: "JSON-вердикт для CI: exit_code, asserts, metrics, violations." },
    ],
  }),
  component: ReportPage,
});

function ReportPage() {
  const s = useSt86();
  const report = s.report;

  const download = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `st86-${report.scenario}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageShell
      title="Отчёт"
      lead="Результат прогона — не лог для человека, а JSON для конвейера. Код возврата: 0 успех, 1 провал утверждения, 2 нарушение инварианта, 3 исчерпан лимит тактов, 4 внутренняя ошибка."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={runToCompletion}>
          Прогнать сценарий
        </Button>
        <Button onClick={download} disabled={!report}>
          Скачать JSON
        </Button>
        {report && (
          <Badge tone={report.exit_code === 0 ? "ok" : "fail"}>
            exit_code {report.exit_code} · {report.exit_meaning}
          </Badge>
        )}
      </div>

      <Panel title="report.json">
        {!report ? (
          <p className="text-sm text-muted-foreground">Отчёта пока нет.</p>
        ) : (
          <pre className="max-h-[600px] overflow-auto font-mono text-xs leading-5 text-foreground">
            {JSON.stringify(report, null, 2)}
          </pre>
        )}
      </Panel>
    </PageShell>
  );
}
