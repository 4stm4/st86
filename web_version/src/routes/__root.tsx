import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

const NAV = [
  { to: "/", label: "Прогон" },
  { to: "/machine", label: "Машина" },
  { to: "/trace", label: "Трасса" },
  { to: "/metrics", label: "Метрики" },
  { to: "/report", label: "Отчёт" },
  { to: "/bench", label: "Бенчмарк" },
] as const;

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-mono text-7xl font-bold text-primary">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Страница не найдена</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Такого маршрута в стенде нет.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center bg-primary px-4 py-2 font-mono text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            К панели прогона
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-mono text-xl font-semibold tracking-tight text-destructive">
          Внутренняя ошибка стенда
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center bg-primary px-4 py-2 font-mono text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            Повторить
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center border border-border bg-card px-4 py-2 font-mono text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            На главную
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "st86 — панель прогона стенда «Челябинск-1»" },
      {
        name: "description",
        content:
          "Загрузите образ и сценарий, прогоните машину КР1810ВМ86 в браузере и получите машиночитаемый вердикт с кодом возврата.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:title", content: "st86 — панель прогона стенда «Челябинск-1»" },
      { name: "twitter:title", content: "st86 — панель прогона стенда «Челябинск-1»" },
      { property: "og:description", content: "Загрузите образ и сценарий, прогоните машину КР1810ВМ86 в браузере и получите машиночитаемый вердикт с кодом возврата." },
      { name: "twitter:description", content: "Загрузите образ и сценарий, прогоните машину КР1810ВМ86 в браузере и получите машиночитаемый вердикт с кодом возврата." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/baf0a655-4e47-4e78-a591-10471ab3e679/id-preview-5b01e012--7c90cbd7-ef61-42cb-8111-6a05f6d38505.lovable.app-1785569132121.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/baf0a655-4e47-4e78-a591-10471ab3e679/id-preview-5b01e012--7c90cbd7-ef61-42cb-8111-6a05f6d38505.lovable.app-1785569132121.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-20 border-b border-border bg-panel/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link to="/" className="font-mono text-sm font-bold tracking-[0.25em] text-primary">
              ST86
            </Link>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              стенд машины «Челябинск-1» · КР1810ВМ86 · 5 МГц
            </span>
            <nav className="ml-auto flex flex-wrap gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.to === "/" }}
                  activeProps={{ className: "bg-secondary text-primary" }}
                  className="px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        <footer className="mt-16 border-t border-border px-4 py-6">
          <div className="mx-auto max-w-[1400px] font-mono text-[11px] text-muted-foreground">
            модель st86-web/0.1.0 · детерминированное однопоточное ядро · wall-clock только в бенчмарке
          </div>
        </footer>
      </div>
    </QueryClientProvider>
  );
}
