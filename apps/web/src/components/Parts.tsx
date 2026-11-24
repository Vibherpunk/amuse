import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarPlus,
  ExternalLink,
  FileText,
  Globe,
  Hand,
  KeyRound,
  Loader2,
  Monitor,
  Square,
  Target,
  Sparkles,
  Plug,
  Play,
} from "lucide-react";
import { api, post, timeUntil } from "../lib/api";
import { useEvent } from "../lib/events";
import { Button, Card, Input } from "./ui";
import { useArtifactViewer } from "./ArtifactViewer";

export function ToolChips({ parts, running }: { parts: any[]; running: boolean }) {
  const tools = parts.filter((p) => p.type === "tool");
  if (!tools.length) return null;
  const uniq = Array.from(new Map(tools.map((t) => [t.skill, t])).values());
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {uniq.map((t, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--card)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
        >
          {running && i === uniq.length - 1 ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
          {t.skill}
        </span>
      ))}
    </div>
  );
}

function Sources({ p }: { p: any }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {p.items.slice(0, 5).map((s: any, i: number) => {
        let host = s.url;
        try {
          host = new URL(s.url).hostname.replace(/^www\./, "");
        } catch {}
        return (
          <a
            key={i}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            title={s.title}
            className="inline-flex max-w-[200px] items-center gap-1 truncate rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
          >
            <Globe size={10} /> <span className="truncate">{host}</span>
          </a>
        );
      })}
    </div>
  );
}

function ArtifactCard({ p }: { p: any }) {
  const { open } = useArtifactViewer();
  const icon = p.kind === "pdf" ? "📄" : p.kind === "html" ? "🧩" : "📝";
  return (
    <button
      onClick={() => open(p.artifactId)}
      className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-3 text-left hover:bg-[var(--hover)]"
      data-testid="artifact-card"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-xl">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{p.title}</div>
        <div className="text-xs text-[var(--muted)]">
          {p.kind === "pdf" ? "PDF document" : p.kind === "html" ? "Interactive page" : "Document"} · Tap to open
        </div>
      </div>
      <ExternalLink size={14} className="text-[var(--muted)]" />
    </button>
  );
}

function ImagePart({ p }: { p: any }) {
  const { open } = useArtifactViewer();
  return (
    <img
      onClick={() => open(p.artifactId)}
      src={`/api/artifacts/${p.artifactId}/raw`}
      alt={p.title}
      className="max-h-80 cursor-zoom-in rounded-2xl border border-[var(--line)]"
      data-testid="image-part"
    />
  );
}

function AudioPart({ p }: { p: any }) {
  return (
    <Card className="w-full max-w-sm p-3" data-testid="audio-part">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">🎧 {p.title}</div>
      <audio controls src={`/api/artifacts/${p.artifactId}/raw`} className="w-full" />
    </Card>
  );
}

function PodcastPart({ p }: { p: any }) {
  const { open } = useArtifactViewer();
  return (
    <button
      onClick={() => open(p.artifactId)}
      className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-3 text-left hover:bg-[var(--hover)]"
      data-testid="audio-part"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-xl">🎧</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{p.title}</div>
        <div className="text-xs text-[var(--muted)]">Podcast · ~{Math.max(1, Math.round((p.seconds ?? 60) / 60))} min · Tap to listen</div>
      </div>
    </button>
  );
}

function GoalPart({ p }: { p: any }) {
  return (
    <Link
      href={`/goals?focus=${p.goalId}`}
      className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]"
    >
      <Target size={14} className="text-[var(--accent)]" /> Goal added: {p.title}
    </Link>
  );
}

function ScheduledPart({ p }: { p: any }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm">
      <CalendarClock size={14} className="text-[var(--accent)]" /> {p.title} · {timeUntil(p.nextRunAt)}
      {p.every ? ` · repeats` : ""}
    </div>
  );
}

const calStamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function CalendarEventPart({ p }: { p: any }) {
  const start = new Date(p.start);
  const end = new Date(p.end);
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(p.title)}&dates=${calStamp(p.start)}/${calStamp(p.end)}${p.details ? `&details=${encodeURIComponent(p.details)}` : ""}${p.location ? `&location=${encodeURIComponent(p.location)}` : ""}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(p.title)}&startdt=${encodeURIComponent(p.start)}&enddt=${encodeURIComponent(p.end)}${p.details ? `&body=${encodeURIComponent(p.details)}` : ""}${p.location ? `&location=${encodeURIComponent(p.location)}` : ""}`;
  const esc = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/([,;])/g, "\\$1")
      .replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Amuse//EN",
    "BEGIN:VEVENT",
    `UID:${calStamp(p.start)}-${Math.abs([...p.title].reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 7))}@amuse`,
    `DTSTAMP:${calStamp(new Date().toISOString())}`,
    `DTSTART:${calStamp(p.start)}`,
    `DTEND:${calStamp(p.end)}`,
    `SUMMARY:${esc(p.title)}`,
    ...(p.location ? [`LOCATION:${esc(p.location)}`] : []),
    ...(p.details ? [`DESCRIPTION:${esc(p.details)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const when = `${start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const link = "inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1.5 text-xs hover:bg-[var(--hover)]";
  return (
    <Card className="w-full max-w-sm p-4" data-testid="calendar-event-card">
      <div className="flex items-center gap-2 font-medium">
        <CalendarPlus size={15} className="text-[var(--accent)]" /> {p.title}
      </div>
      <div className="mt-1 text-xs text-[var(--muted)]">
        {when}
        {p.location ? ` · ${p.location}` : ""}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className={link} href={google} target="_blank" rel="noreferrer" data-testid="add-google">
          Add to Google Calendar
        </a>
        <a className={link} href={outlook} target="_blank" rel="noreferrer" data-testid="add-outlook">
          Add to Outlook
        </a>
        <a
          className={link}
          href={`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`}
          download={`${p.title.replace(/[^\w -]/g, "").slice(0, 40) || "event"}.ics`}
          data-testid="add-ics"
        >
          Download .ics
        </a>
      </div>
    </Card>
  );
}

function SpacePart({ p }: { p: any }) {
  return (
    <Link
      href={`/spaces/${p.spaceId}`}
      className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-3 hover:bg-[var(--hover)]"
      data-testid="space-part"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-xl">{p.emoji}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{p.title}</div>
        <div className="text-xs text-[var(--muted)]">New space · Open it</div>
      </div>
    </Link>
  );
}

export function BrowserPart({ p }: { p: any }) {
  const [session, setSession] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const [typing, setTyping] = useState("");
  useEffect(() => {
    api(`/browser/${p.sessionId}`).then((r) => setSession(r.session));
  }, [p.sessionId]);
  useEvent(
    (e) => {
      if (e.type === "browser" && e.session.id === p.sessionId) setSession((s: any) => ({ ...s, ...e.session }));
    },
    [p.sessionId],
  );
  const ctl = (body: any) => post(`/browser/${p.sessionId}/control`, body);
  const live = session && (session.status === "active" || session.status === "user_control");
  return (
    <Card className="w-full max-w-lg overflow-hidden" data-testid="browser-part">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-sm">
        <Monitor size={14} />
        <span className="truncate font-medium">{session?.title || p.goal}</span>
        <span className="ml-auto text-xs text-[var(--muted)]">
          {session?.status === "user_control" ? "You're in control" : live ? "Live" : (session?.status ?? "…")}
        </span>
      </div>
      {session?.screenshot && (
        <div className="relative">
          <img
            src={session.screenshot}
            alt="browser"
            className={`w-full ${session.status === "user_control" ? "cursor-crosshair" : "cursor-pointer"}`}
            onClick={(e) => {
              if (session.status !== "user_control") return setExpanded(!expanded);
              const r = (e.target as HTMLImageElement).getBoundingClientRect();
              ctl({ kind: "click", x: Math.round(((e.clientX - r.left) / r.width) * 1280), y: Math.round(((e.clientY - r.top) / r.height) * 800) });
            }}
          />
          <div className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-2 py-0.5 text-[10px] text-white">{session.url}</div>
        </div>
      )}
      {live && (
        <div className="flex flex-wrap items-center gap-2 p-2">
          {session.status === "user_control" ? (
            <>
              <Input value={typing} onChange={(e) => setTyping(e.target.value)} placeholder="Type into the page…" className="h-8 flex-1" />
              <Button size="sm" variant="soft" onClick={() => (ctl({ kind: "type", text: typing }), setTyping(""))}>
                Type
              </Button>
              <Button size="sm" variant="soft" onClick={() => ctl({ kind: "key", key: "Enter" })}>
                Enter
              </Button>
              <Button size="sm" onClick={() => ctl({ kind: "release" })}>
                <Play size={12} /> Hand back
              </Button>
            </>
          ) : (
            <Button size="sm" variant="soft" onClick={() => ctl({ kind: "take" })} data-testid="take-control">
              <Hand size={12} /> Take control
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => ctl({ kind: "stop" })} data-testid="stop-browser">
            <Square size={12} /> Stop the task
          </Button>
        </div>
      )}
      {expanded && session?.log?.length > 0 && (
        <div className="max-h-40 overflow-auto border-t border-[var(--line)] p-2 font-mono text-[11px] text-[var(--muted)]">
          {session.log.map((l: any, i: number) => (
            <div key={i}>
              {l.action} {l.detail}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ConnectCard({ p, chatId }: { p: any; chatId: number }) {
  const { data } = useQuery({ queryKey: ["connectors"], queryFn: () => api("/connectors") });
  const item = data?.catalog?.find((c: any) => c.id === p.provider);
  const already = data?.connected?.some((c: any) => c.provider === p.provider);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [access, setAccess] = useState("read");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!item) return null;
  if (already || done)
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-[var(--hover)] px-3 py-1.5 text-sm">
        <Plug size={14} /> {item.name.split(" (")[0]} connected
      </div>
    );
  return (
    <Card className="w-full max-w-sm p-4" data-testid="connect-card">
      <div className="mb-1 flex items-center gap-2 font-medium">
        {item.emoji} Connect {item.name.split(" (")[0]}
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">{item.setupHelp}</p>
      <div className="space-y-2">
        {item.fields.map((f: any) => (
          <Input
            key={f.key}
            type={f.secret ? "password" : "text"}
            placeholder={f.placeholder ?? f.label}
            aria-label={f.label}
            value={fields[f.key] ?? ""}
            onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
          />
        ))}
        {item.supportsWrite && (
          <select
            value={access}
            onChange={(e) => setAccess(e.target.value)}
            className="h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--card)] px-2 text-sm"
          >
            <option value="read">Read only</option>
            <option value="readwrite">Read and take actions (with approval)</option>
          </select>
        )}
      </div>
      {err && <div className="mt-2 text-xs text-[#B4373C]">{err}</div>}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || item.fields.some((f: any) => !f.optional && !String(fields[f.key] ?? "").trim())}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              await post(`/connectors/${item.id}`, { fields, access, chatId, continue: true });
              setDone(true);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : null} Connect
        </Button>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <KeyRound size={11} /> Stored securely. Your agent never sees it.
        </span>
      </div>
    </Card>
  );
}

function CredentialCard({ p, chatId }: { p: any; chatId: number }) {
  const [secret, setSecret] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  let destination = String(p.host ?? "");
  try {
    if (p.baseUrl) destination = new URL(p.baseUrl).hostname;
  } catch {
    destination = "";
  }
  const [username, setUsername] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (done)
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-[var(--hover)] px-3 py-1.5 text-sm">
        <KeyRound size={14} /> Saved to your secure store
      </div>
    );
  return (
    <Card className="w-full max-w-sm p-4" data-testid="credential-card">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <KeyRound size={16} /> {p.label}
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">{p.instructions}</p>
      <p className="mb-2 break-all text-sm">
        Will only be sent to <strong>{destination || "an unknown site. Don't save it"}</strong>
      </p>
      <label className="mb-3 flex gap-2 text-xs">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I expected this to go to {destination}
      </label>
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-500">
          {error}
        </p>
      )}
      {(p.auth === "basic" || (p.host && !p.baseUrl)) && (
        <Input placeholder={p.auth === "basic" ? "Username" : "Username (optional)"} value={username} onChange={(e) => setUsername(e.target.value)} className="mb-2" />
      )}
      <Input type="password" placeholder={p.auth === "basic" ? "Password" : "Paste it here"} value={secret} onChange={(e) => setSecret(e.target.value)} />
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!secret || !destination || !confirmed || busy || (p.auth === "basic" && !username.trim())}
          onClick={async () => {
            setBusy(true);
            try {
              await post("/credentials", {
                label: p.label,
                host: p.host,
                confirmedHost: destination,
                username: username || null,
                secret,
                baseUrl: p.baseUrl,
                header: p.header,
                auth: p.auth ?? null,
                chatId,
              });
              setDone(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save securely
        </Button>
        <span className="text-[11px] text-[var(--muted)]">Encrypted. Never shown to the AI.</span>
      </div>
    </Card>
  );
}

function LimitPart({ p }: { p: any }) {
  return (
    <Link href="/settings/usage" className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm">
      <FileText size={14} /> Daily limit resets {timeUntil(p.resetsAt)} · See usage
    </Link>
  );
}

const TIP_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
/** Phone-sized illustration under a tip, framed like a device screenshot. */
function TipImage({ p }: { p: any }) {
  const [big, setBig] = useState(false);
  const src = `${TIP_BASE}/${String(p.src).replace(/^\//, "")}`;
  return (
    <>
      <button
        onClick={() => setBig(true)}
        className="rounded-[22px] bg-gradient-to-b from-[#dbe9ff] to-[#9fc2ff] p-[7px] shadow-lg"
        data-testid="tip-image"
        aria-label={p.title}
      >
        <img src={src} alt={p.title} className="block w-[150px] rounded-[16px]" loading="lazy" />
      </button>
      {big && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={() => setBig(false)}>
          <img src={src} alt={p.title} className="max-h-[85vh] rounded-[24px] shadow-2xl" />
        </div>
      )}
    </>
  );
}

export function RichParts({ parts, chatId }: { parts: any[]; chatId: number }) {
  const rich = parts.filter((p) => p.type !== "tool");
  if (!rich.length) return null;
  return (
    <div className="mt-2 flex flex-col items-start gap-2">
      {rich.map((p, i) => {
        switch (p.type) {
          case "sources":
            return <Sources key={i} p={p} />;
          case "artifact":
            return <ArtifactCard key={i} p={p} />;
          case "image":
            return <ImagePart key={i} p={p} />;
          case "audio":
            return <AudioPart key={i} p={p} />;
          case "podcast":
            return <PodcastPart key={i} p={p} />;
          case "goal":
            return <GoalPart key={i} p={p} />;
          case "scheduled":
            return <ScheduledPart key={i} p={p} />;
          case "calendar_event":
            return <CalendarEventPart key={i} p={p} />;
          case "space":
            return <SpacePart key={i} p={p} />;
          case "browser":
            return <BrowserPart key={i} p={p} />;
          case "connect_card":
            return <ConnectCard key={i} p={p} chatId={chatId} />;
          case "credential_card":
            return <CredentialCard key={i} p={p} chatId={chatId} />;
          case "limit":
            return <LimitPart key={i} p={p} />;
          case "tip_image":
            return <TipImage key={i} p={p} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
