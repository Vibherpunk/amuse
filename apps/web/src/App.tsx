import { Route, Switch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./lib/api";
import { EventsProvider } from "./lib/events";
import type { Me } from "./lib/types";
import { AppShell } from "./components/AppShell";
import { PanelProvider } from "./components/AgentPanel";
import { ArtifactViewerProvider } from "./components/ArtifactViewer";
import { ChatView } from "./pages/ChatView";
import { GoalsPage } from "./pages/Goals";
import { IdeasPage } from "./pages/Ideas";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/Settings";
import { SpacesPage, SpaceView } from "./pages/Spaces";
import { FeedPage, LibraryPage, SearchPage } from "./pages/Discover";
import { DocsPage } from "./pages/Docs";

function SideChat({ me, id }: { me: Me; id: number }) {
  const { data } = useQuery({ queryKey: ["chats"], queryFn: () => api("/chats") });
  const chat = data?.chats?.find((c: any) => c.id === id);
  return <ChatView key={id} me={me} chatId={id} title={chat?.title ?? "Side chat"} />;
}

export default function App() {
  const {
    data: me,
    isLoading,
    error,
  } = useQuery<Me>({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: 2,
  });
  if (isLoading)
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[var(--bg)]">
        <div className="h-2 w-2 animate-ping rounded-full bg-[var(--muted)]" />
      </div>
    );
  if (error || !me)
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-2 bg-[var(--bg)] px-6 text-center text-[var(--ink)]">
        <div className="font-display text-2xl">Can't reach the Amuse server</div>
        <p className="max-w-sm text-sm text-[var(--muted)]">
          {error instanceof ApiError ? error.message : "Check that it's running (pnpm dev or docker compose up), then reload."}
        </p>
      </div>
    );
  if (!me.agent.hatchedAt) return <Onboarding me={me} />;
  return (
    <EventsProvider initialStatus={me.agent.status}>
      <ArtifactViewerProvider>
        <PanelProvider>
          <AppShell me={me}>
            <Switch>
              <Route path="/">
                <ChatView key="main" me={me} chatId={me.mainChatId} />
              </Route>
              <Route path="/chats/:id">{(p) => <SideChat me={me} id={Number(p.id)} />}</Route>
              <Route path="/search">
                <SearchPage />
              </Route>
              <Route path="/feed">
                <FeedPage />
              </Route>
              <Route path="/library">
                <LibraryPage />
              </Route>
              <Route path="/goals">
                <GoalsPage />
              </Route>
              <Route path="/ideas">
                <IdeasPage />
              </Route>
              <Route path="/spaces">
                <SpacesPage />
              </Route>
              <Route path="/spaces/:id">{(p) => <SpaceView key={p.id} id={Number(p.id)} />}</Route>
              <Route path="/docs">
                <DocsPage />
              </Route>
              <Route path="/docs/:id">{(p) => <DocsPage activeId={Number(p.id)} />}</Route>
              <Route path="/settings">
                <SettingsPage me={me} />
              </Route>
              <Route path="/settings/:tab">
                <SettingsPage me={me} />
              </Route>
              <Route>
                <ChatView me={me} chatId={me.mainChatId} />
              </Route>
            </Switch>
          </AppShell>
        </PanelProvider>
      </ArtifactViewerProvider>
    </EventsProvider>
  );
}
