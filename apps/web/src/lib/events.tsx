import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

type Listener = (e: any) => void;
interface EventsCtx {
  status: string;
  subscribe: (fn: Listener) => () => void;
  connected: boolean;
}
const Ctx = createContext<EventsCtx>({ status: "Idle", subscribe: () => () => {}, connected: false });

export function EventsProvider({ children, initialStatus }: { children: ReactNode; initialStatus?: string }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(initialStatus ?? "Idle");
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: any;
    const connect = () => {
      es = new EventSource("/api/events", { withCredentials: true });
      es.onopen = () => {
        setConnected(true);
        // A reminder may have fired while this tab was disconnected.
        void qc.invalidateQueries({ queryKey: ["upcoming"] });
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
      es.onmessage = (m) => {
        let e: any;
        try {
          e = JSON.parse(m.data);
        } catch {
          return;
        }
        if (e.type === "status") setStatus(e.status);
        if (e.type === "refresh") {
          const map: Record<string, string[]> = {
            goals: ["goals"],
            ideas: ["ideas"],
            spaces: ["spaces"],
            upcoming: ["upcoming"],
            files: ["files"],
            agent: ["me"],
            docs: ["docs", "doc"],
          };
          for (const k of map[e.what] ?? []) qc.invalidateQueries({ queryKey: [k] });
        }
        if (e.type === "approval") qc.invalidateQueries({ queryKey: ["approvals"] });
        if (e.type === "activity") qc.invalidateQueries({ queryKey: ["activity"] });
        if (e.type === "notification") {
          qc.invalidateQueries({ queryKey: ["notifications"] });
          if (document.hidden && "Notification" in window && Notification.permission === "granted") {
            try {
              new Notification(e.notification.title, { body: e.notification.body });
            } catch {}
          }
        }
        if (e.type === "run") qc.invalidateQueries({ queryKey: ["me"] });
        listeners.current.forEach((fn) => fn(e));
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [qc]);

  return (
    <Ctx.Provider value={{ status, connected, subscribe: (fn) => (listeners.current.add(fn), () => listeners.current.delete(fn)) }}>{children}</Ctx.Provider>
  );
}

export const useEvents = () => useContext(Ctx);

export function useEvent(fn: Listener, deps: unknown[] = []) {
  const { subscribe } = useEvents();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribe(fn), deps);
}
