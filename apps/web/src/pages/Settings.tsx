import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, Loader2, Pencil, RefreshCw, Server, Trash2 } from "lucide-react";
import { api, del, patch, post } from "../lib/api";
import type { Me } from "../lib/types";
import { AgentAvatar, PRESETS } from "../components/Creature";
import { Button, Card, Input, PageHeader, Segmented, Textarea, Toggle, cx } from "../components/ui";
import { deviceVoiceAvailable, setVoiceEngine, voiceEngine, type VoiceEngine } from "../lib/speech";

function Section({ title, children, desc }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-5 p-5">
      <div className="font-semibold">{title}</div>
      {desc && <div className="mb-3 text-sm text-[var(--muted)]">{desc}</div>}
      <div className="mt-2">{children}</div>
    </Card>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3 last:border-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-xs text-[var(--muted)]">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function AgentSettings({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.agent.name ?? "");
  const [vibe, setVibe] = useState(me.agent.vibe ?? "");
  const save = async (body: any) => (await patch("/agent", body), qc.invalidateQueries({ queryKey: ["me"] }));
  return (
    <>
      <Section title="Your agent">
        <div className="mb-4 flex items-center gap-4">
          <AgentAvatar avatarUrl={me.agent.avatarUrl} size={72} />
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => save({ avatarUrl: `preset:${p.id}` })}
                className={cx("rounded-full ring-offset-2", me.agent.avatarUrl === `preset:${p.id}` && "ring-2 ring-[var(--ink)]")}
                aria-label={p.name}
              >
                <AgentAvatar avatarUrl={`preset:${p.id}`} size={40} />
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name && save({ name })} className="mt-1" />
          </label>
          <label className="text-sm">
            Vibe
            <Input value={vibe} onChange={(e) => setVibe(e.target.value)} onBlur={() => save({ vibe })} className="mt-1" />
          </label>
        </div>
      </Section>
      <Section title="Proactivity" desc="How often your agent messages you without being asked.">
        <Segmented
          value={me.agent.proactivity as any}
          onChange={(v) => save({ proactivity: v })}
          options={[
            { value: "off", label: "Off" },
            { value: "low", label: "Low" },
            { value: "normal", label: "Normal" },
            { value: "high", label: "High" },
          ]}
        />
      </Section>
    </>
  );
}

function authStyleOf(c: any): { auth: string; header: string } {
  const h = c?.config?.header as string | null | undefined;
  if (!h) return { auth: "none", header: "" };
  if (h === "Authorization: Bearer {token}") return { auth: "bearer", header: "" };
  if (h === "Authorization: Basic {token}") return { auth: "basic", header: "" };
  return { auth: "custom", header: h };
}

function CustomConnectorForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: any;
  submitLabel: string;
  onSubmit: (body: any) => Promise<void>;
  onCancel: () => void;
}) {
  const { data: vaultData } = useQuery({ queryKey: ["vault"], queryFn: () => api("/vault") });
  const logins: any[] = vaultData?.logins ?? [];
  const derived = authStyleOf(initial);
  const initialUsesVault =
    initial?.config?.credentialSource === "vault" || (!initial && logins.length > 0);
  const [name, setName] = useState(initial?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.config?.baseUrl ?? "");
  const [auth, setAuth] = useState(derived.auth);
  const [header, setHeader] = useState(derived.header);
  const [credMode, setCredMode] = useState<"vault" | "inline">(initialUsesVault ? "vault" : "inline");
  const [credentialId, setCredentialId] = useState(initial?.credentialId ? String(initial.credentialId) : "");
  const [username, setUsername] = useState(initial?.credentialUsername ?? "");
  const [token, setToken] = useState("");
  const [access, setAccess] = useState(initial?.access ?? "readwrite");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = !!initial;
  const selectCls = "h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--card)] px-2 text-sm";
  const effectiveVaultId = credentialId || (credMode === "vault" && logins.length === 1 ? String(logins[0].id) : "");
  return (
    <div className="ml-9 mt-3 space-y-2">
      <Input placeholder="Name, e.g. Windmill" aria-label="Connector name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        placeholder="Base URL, e.g. http://your-server.local:8000"
        aria-label="Base URL"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <select value={auth} onChange={(e) => setAuth(e.target.value)} className={selectCls} aria-label="Authentication">
        <option value="none">No authentication</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Username & password</option>
        <option value="custom">Custom header</option>
      </select>
      {auth === "custom" && (
        <Input
          placeholder="Header template, e.g. X-Api-Key: {token}"
          aria-label="Header template"
          value={header}
          onChange={(e) => setHeader(e.target.value)}
        />
      )}
      {auth !== "none" && (
        <div className="space-y-2 pt-1">
          <Segmented
            value={credMode}
            onChange={(v) => setCredMode(v)}
            options={[
              { value: "vault", label: "Use Vault login" },
              { value: "inline", label: "Enter secret" },
            ]}
          />
          {credMode === "vault" ? (
            logins.length > 0 ? (
              <select
                value={effectiveVaultId}
                onChange={(e) => setCredentialId(e.target.value)}
                className={selectCls}
                aria-label="Vault login"
              >
                <option value="">Select a Vault login…</option>
                {logins.map((l: any) => (
                  <option key={l.id} value={String(l.id)}>
                    {l.label} · {l.host}
                    {l.username ? ` (${l.username})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-[var(--muted)]">
                No logins in your Vault yet.{" "}
                <Link href="/settings/vault" className="underline">
                  Add one in Vault
                </Link>{" "}
                or switch to "Enter secret".
              </div>
            )
          ) : (
            <>
              {auth === "basic" && <Input placeholder="Username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />}
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={
                  auth === "basic"
                    ? editing
                      ? "New password (leave blank to keep the saved one)"
                      : "Password"
                    : editing
                      ? "New token (leave blank to keep the saved one)"
                      : "API token"
                }
                aria-label={auth === "basic" ? "Password" : "API token"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </>
          )}
        </div>
      )}
      <select value={access} onChange={(e) => setAccess(e.target.value)} className={selectCls} aria-label="Access">
        <option value="read">Read only</option>
        <option value="readwrite">Read and take actions (with approval)</option>
      </select>
      <p className="text-xs text-[var(--muted)]">
        Credentials live in the Vault and are injected only inside this connector's own base URL — your agent never sees them. HTTP addresses are
        allowed for your own network and tailnet; public services must use HTTPS.
      </p>
      {err && <div className="text-xs text-[#B4373C]">{err}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              const payload: Record<string, unknown> = {
                name,
                baseUrl,
                auth,
                header: auth === "custom" ? header : undefined,
                access,
              };
              if (auth !== "none") {
                if (credMode === "vault") {
                  if (!effectiveVaultId) throw new Error("Select a Vault login first.");
                  payload.credentialId = Number(effectiveVaultId);
                } else {
                  if (auth === "basic") payload.username = username;
                  if (token) payload.token = token;
                }
              }
              await onSubmit(payload);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />} {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConnectorsSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["connectors"], queryFn: () => api("/connectors") });
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [access, setAccess] = useState("read");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["connectors"] });
    qc.invalidateQueries({ queryKey: ["vault"] });
  };
  const connected = data?.connected ?? [];
  return (
    <Section title="Connectors" desc="Connect the apps you use. You choose what your agent can see and do.">
      {(data?.catalog ?? []).map((c: any) => {
        const conn = connected.find((x: any) => x.provider === c.id);
        return (
          <div key={c.id} className="border-b border-[var(--line)] py-3 last:border-0">
            <div className="flex items-center gap-3">
              <div className="text-xl">{c.emoji}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="text-xs text-[var(--muted)]">{c.description}</div>
              </div>
              {conn ? (
                <Button size="sm" variant="ghost" onClick={async () => (await del(`/connectors/${c.id}`), refresh())}>
                  Disconnect
                </Button>
              ) : (
                <Button size="sm" variant="soft" onClick={() => (setOpenId(openId === c.id ? null : c.id), setFields({}), setErr(""))}>
                  Connect
                </Button>
              )}
            </div>
            {conn && (
              <div className="ml-9 mt-2 flex flex-wrap items-center gap-3 text-xs">
                {c.supportsWrite && (
                  <Segmented
                    value={conn.access}
                    onChange={async (v) => (await patch(`/connectors/${c.id}`, { access: v }), refresh())}
                    options={[
                      { value: "read", label: "Read only" },
                      { value: "readwrite", label: "Read & act" },
                    ]}
                  />
                )}
                <Segmented
                  value={conn.approvalMode}
                  onChange={async (v) => (await patch(`/connectors/${c.id}`, { approvalMode: v }), refresh())}
                  options={[
                    { value: "some", label: "Ask for some actions" },
                    { value: "always", label: "Always ask" },
                  ]}
                />
              </div>
            )}
            {openId === c.id && !conn && (
              <div className="ml-9 mt-3 space-y-2">
                <p className="text-xs text-[var(--muted)]">{c.setupHelp}</p>
                {c.fields.map((f: any) => (
                  <Input
                    key={f.key}
                    type={f.secret ? "password" : "text"}
                    placeholder={f.placeholder ?? f.label}
                    aria-label={f.label}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                  />
                ))}
                {c.supportsWrite && (
                  <select
                    value={access}
                    onChange={(e) => setAccess(e.target.value)}
                    className="h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--card)] px-2 text-sm"
                  >
                    <option value="read">Read only</option>
                    <option value="readwrite">Read and take actions (with approval)</option>
                  </select>
                )}
                {err && <div className="text-xs text-[#B4373C]">{err}</div>}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setErr("");
                    try {
                      await post(`/connectors/${c.id}`, { fields, access });
                      setOpenId(null);
                      refresh();
                    } catch (e: any) {
                      setErr(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy && <Loader2 size={12} className="animate-spin" />} Save connection
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {connected
        .filter((c: any) => c.custom)
        .map((c: any) => (
          <div key={c.provider} className="border-b border-[var(--line)] py-3 last:border-0">
            <div className="flex items-center gap-3">
              <div className="text-xl">🧩</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.displayName}</div>
                <div className="text-xs text-[var(--muted)]">
                  Custom connector · {c.config?.baseUrl} ·{" "}
                  {c.config?.header === "Authorization: Basic {token}"
                    ? "Username & password"
                    : c.config?.header
                      ? `Auth: ${String(c.config.header).split(":")[0]} header`
                      : "No authentication"}
                  {c.credentialId
                    ? c.config?.credentialSource === "vault" && c.credentialLabel
                      ? ` · Vault: ${c.credentialLabel}`
                      : " · Key saved"
                    : ""}
                </div>
              </div>
              <Button size="sm" variant="soft" onClick={() => setEditing(editing === c.provider ? null : c.provider)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => (await del(`/connectors/${c.provider}`), refresh())}>
                Remove
              </Button>
            </div>
            <div className="ml-9 mt-2 flex flex-wrap items-center gap-3 text-xs">
              <Segmented
                value={c.access}
                onChange={async (v) => (await patch(`/connectors/${c.provider}`, { access: v }), refresh())}
                options={[
                  { value: "read", label: "Read only" },
                  { value: "readwrite", label: "Read & act" },
                ]}
              />
              <Segmented
                value={c.approvalMode}
                onChange={async (v) => (await patch(`/connectors/${c.provider}`, { approvalMode: v }), refresh())}
                options={[
                  { value: "some", label: "Ask for some actions" },
                  { value: "always", label: "Always ask" },
                ]}
              />
            </div>
            {editing === c.provider && (
              <CustomConnectorForm
                initial={c}
                submitLabel="Save changes"
                onCancel={() => setEditing(null)}
                onSubmit={async (body) => {
                  await patch(`/connectors/${c.provider}`, body);
                  setEditing(null);
                  refresh();
                }}
              />
            )}
          </div>
        ))}
      <div className="mt-4">
        {!adding ? (
          <Button size="sm" variant="soft" onClick={() => setAdding(true)}>
            Add a custom connector
          </Button>
        ) : (
          <CustomConnectorForm
            submitLabel="Add connector"
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              await post("/connectors/custom", body);
              setAdding(false);
              refresh();
            }}
          />
        )}
        <p className="mt-3 text-xs text-[var(--muted)]">
          For any service with an API that isn't listed above — including services on your own network or tailnet, like Windmill. You can also
          ask your agent to set one up for you.
        </p>
      </div>
    </Section>
  );
}

function PermissionsSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  const s = data?.settings;
  const save = async (body: any) => (await patch("/settings", body), qc.invalidateQueries({ queryKey: ["settings"] }));
  if (!s) return null;
  return (
    <>
      <Section title="Permissions" desc="When your agent should check with you first.">
        <Row
          label="Connectors"
          desc={s.connectorDefault === "some" ? "Asks before changes, and the first time a saved key is used" : "Asks before every connector action"}
        >
          <Segmented
            value={s.connectorDefault}
            onChange={(v) => save({ connectorDefault: v })}
            options={[
              { value: "some", label: "Ask for some" },
              { value: "always", label: "Always ask" },
            ]}
          />
        </Row>
        <Row
          label="Web access"
          desc={
            s.webDefault === "some"
              ? "Asks before forms, payments, and visiting sites you didn't mention or trust."
              : "Asks before visiting any website, plus everything above"
          }
        >
          <Segmented
            value={s.webDefault}
            onChange={(v) => save({ webDefault: v })}
            options={[
              { value: "some", label: "Ask for some" },
              { value: "always", label: "Always ask" },
            ]}
          />
        </Row>
      </Section>
      <Section title="Allowed websites">
        {(data.allowedSites ?? []).length === 0 && (
          <div className="text-sm text-[var(--muted)]">None yet. When you choose "Allow for this site", it shows up here.</div>
        )}
        {(data.allowedSites ?? []).map((w: any) => (
          <Row key={w.id} label={w.host}>
            <Button size="sm" variant="ghost" onClick={async () => (await del(`/settings/sites/${w.id}`), qc.invalidateQueries({ queryKey: ["settings"] }))}>
              Revoke
            </Button>
          </Row>
        ))}
      </Section>
      <Section title="Always allowed actions">
        {(data.grants ?? []).length === 0 && <div className="text-sm text-[var(--muted)]">None.</div>}
        {(data.grants ?? []).map((g: any) => (
          <Row key={g.id} label={`${g.toolName} · ${g.actionClass}`} desc={g.target ?? undefined}>
            <Button size="sm" variant="ghost" onClick={async () => (await del(`/settings/grants/${g.id}`), qc.invalidateQueries({ queryKey: ["settings"] }))}>
              Revoke
            </Button>
          </Row>
        ))}
      </Section>
    </>
  );
}

function VaultLoginForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: any;
  submitLabel: string;
  onSubmit: (body: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = !!initial;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3">
      <Input placeholder="Label, e.g. Windmill token" aria-label="Vault label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Input
        placeholder="Host or base URL, e.g. your-server.local or https://api.example.com"
        aria-label="Vault host or base URL"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <Input placeholder="Username (optional)" aria-label="Vault username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={editing ? "New password or token (leave blank to keep saved)" : "Password or API token"}
        aria-label="Vault password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <p className="text-xs text-[var(--muted)]">
        Encrypted at rest and write-only: passwords are never shown back here and are never visible to your agent.
      </p>
      {err && <div className="text-xs text-[#B4373C]">{err}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              const body: Record<string, unknown> = { label, host, username };
              if (password) body.password = password;
              await onSubmit(body);
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />} {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function VaultSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["vault"], queryFn: () => api("/vault") });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vault"] });
    qc.invalidateQueries({ queryKey: ["credentials"] });
    qc.invalidateQueries({ queryKey: ["connectors"] });
    qc.invalidateQueries({ queryKey: ["mcp-servers"] });
  };
  const logins: any[] = data?.logins ?? [];
  return (
    <Section
      title="Vault"
      desc="Owner-managed logins and API tokens. Secrets are AES-256-GCM encrypted, write-only, never returned in any API response, and fenced to their host."
    >
      {logins.length === 0 && !adding && <div className="text-sm text-[var(--muted)]">No logins saved yet.</div>}
      {logins.map((c: any) => (
        <div key={c.id} className="border-b border-[var(--line)] py-3 last:border-0">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span>{c.label}</span>
                <span className="rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] font-normal text-[var(--muted)]">Saved</span>
              </div>
              <div className="text-xs text-[var(--muted)]">
                {[c.host, c.username ? `user: ${c.username}` : null, c.usedBy?.length ? `used by: ${c.usedBy.map((u: any) => u.name).join(", ")}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="soft" onClick={() => setEditingId(editingId === c.id ? null : c.id)} aria-label={`Edit ${c.label}`}>
                <Pencil size={13} /> Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await del(`/vault/${c.id}`);
                  refresh();
                }}
                aria-label={`Delete ${c.label}`}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
          {editingId === c.id && (
            <VaultLoginForm
              initial={c}
              submitLabel="Save changes"
              onCancel={() => setEditingId(null)}
              onSubmit={async (body) => {
                await patch(`/vault/${c.id}`, body);
                setEditingId(null);
                refresh();
              }}
            />
          )}
        </div>
      ))}
      <div className="mt-4">
        {!adding ? (
          <Button size="sm" variant="soft" onClick={() => setAdding(true)}>
            Add login
          </Button>
        ) : (
          <VaultLoginForm
            submitLabel="Save to vault"
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              await post("/vault", body);
              setAdding(false);
              refresh();
            }}
          />
        )}
      </div>
    </Section>
  );
}

function McpServerForm({
  initial,
  logins,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: any;
  logins: any[];
  submitLabel: string;
  onSubmit: (body: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [transport, setTransport] = useState(initial?.transport ?? "http");
  const [authType, setAuthType] = useState(initial?.authType ?? "none");
  const [credentialId, setCredentialId] = useState(initial?.credentialId ? String(initial.credentialId) : "");
  const [authHeader, setAuthHeader] = useState(initial?.authHeader ?? "");
  const [allowlistText, setAllowlistText] = useState(Array.isArray(initial?.allowlist) ? initial.allowlist.join("\n") : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const selectCls = "h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--card)] px-2 text-sm";
  const effectiveCredId = credentialId || (authType !== "none" && logins.length === 1 ? String(logins[0].id) : "");

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3">
      <Input placeholder="Server name, e.g. windmill or composio" aria-label="MCP server name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        placeholder="Server URL, e.g. http://your-server.local:8000/api/mcp"
        aria-label="MCP server URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <select value={transport} onChange={(e) => setTransport(e.target.value)} className={selectCls} aria-label="Transport">
          <option value="http">HTTP (Streamable HTTP / JSON-RPC)</option>
        </select>
        <select value={authType} onChange={(e) => setAuthType(e.target.value)} className={selectCls} aria-label="MCP authentication">
          <option value="none">No authentication</option>
          <option value="bearer">Vault login (Bearer token)</option>
          <option value="custom">Vault login (Custom header)</option>
        </select>
      </div>
      {authType !== "none" && (
        logins.length > 0 ? (
          <select value={effectiveCredId} onChange={(e) => setCredentialId(e.target.value)} className={selectCls} aria-label="MCP Vault login">
            <option value="">Select a Vault login…</option>
            {logins.map((l: any) => (
              <option key={l.id} value={String(l.id)}>
                {l.label} · {l.host}
                {l.username ? ` (${l.username})` : ""}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-xs text-[var(--muted)]">
            Add a token in{" "}
            <Link href="/settings/vault" className="underline">
              Settings → Vault
            </Link>{" "}
            first.
          </div>
        )
      )}
      {authType === "custom" && (
        <Input
          placeholder="Header template, e.g. X-Api-Key: {token}"
          aria-label="MCP custom header"
          value={authHeader}
          onChange={(e) => setAuthHeader(e.target.value)}
        />
      )}
      <div>
        <Textarea
          rows={3}
          placeholder="Optional tool allowlist (one tool name per line or comma-separated; trailing * allowed). Leave blank for all tools."
          aria-label="Tool allowlist"
          value={allowlistText}
          onChange={(e) => setAllowlistText(e.target.value)}
        />
      </div>
      <div className="flex items-center justify-between py-1 text-sm">
        <span>Enabled</span>
        <Toggle checked={enabled} onChange={setEnabled} label="Enable MCP server" />
      </div>
      {err && <div className="text-xs text-[#B4373C]">{err}</div>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              const allowlist = allowlistText
                .split(/[\n,]+/)
                .map((s: string) => s.trim())
                .filter(Boolean);
              await onSubmit({
                name,
                transport,
                url,
                authType,
                credentialId: authType !== "none" ? (effectiveCredId ? Number(effectiveCredId) : null) : null,
                authHeader: authType === "custom" ? authHeader : null,
                allowlist: allowlist.length ? allowlist : null,
                enabled,
              });
            } catch (e: any) {
              setErr(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />} {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LiveStateBadge({ live }: { live: any }) {
  if (!live) return <span className="rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] text-[var(--muted)]">Pending</span>;
  if (live.status === "disabled") {
    return <span className="rounded-full bg-[var(--hover)] px-2 py-0.5 text-[11px] text-[var(--muted)]">Disabled</span>;
  }
  if (live.status === "connected") {
    const filtered = live.discoveredTools > live.offeredTools ? ` (of ${live.discoveredTools})` : "";
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        Connected · {live.offeredTools} {live.offeredTools === 1 ? "tool" : "tools"} offered{filtered}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[#B4373C]/15 px-2 py-0.5 text-[11px] font-medium text-[#B4373C]">
      Failed{live.error ? ` · ${live.error}` : ""}
    </span>
  );
}

function McpServersSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["mcp-servers"], queryFn: () => api("/mcp-servers") });
  const { data: vaultData } = useQuery({ queryKey: ["vault"], queryFn: () => api("/vault") });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mcp-servers"] });
    qc.invalidateQueries({ queryKey: ["vault"] });
  };
  const servers: any[] = data?.servers ?? [];
  const bootstrap: any[] = data?.bootstrapServers ?? [];
  const logins: any[] = vaultData?.logins ?? [];

  return (
    <Section
      title="MCP servers"
      desc="Connect external tool servers (Composio, Windmill, or any HTTP MCP server) using credentials from your Vault. Tools are routed through Amuse's sub-10 gateway menu."
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-[var(--muted)]">
          {data?.usingBootstrap
            ? "Currently running with environment bootstrap servers. Add servers here to take full UI control."
            : `${servers.length} UI-managed ${servers.length === 1 ? "server" : "servers"} active.`}
        </div>
        <Button
          size="sm"
          variant="soft"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await post("/mcp-servers/refresh", {});
              refresh();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> Refresh status
        </Button>
      </div>

      {data?.usingBootstrap && bootstrap.length > 0 && (
        <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--bg)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--muted)]">Bootstrap servers (from environment)</div>
          {bootstrap.map((s: any) => (
            <div key={s.name} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2 last:border-0">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <Server size={13} /> {s.name}
                  <LiveStateBadge live={s} />
                </div>
                <div className="truncate text-xs text-[var(--muted)]">
                  {s.transport.toUpperCase()} · {s.url}
                  {s.allowlist?.length ? ` · allowlist: ${s.allowlist.join(", ")}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {servers.length === 0 && !adding && !data?.usingBootstrap && (
        <div className="text-sm text-[var(--muted)]">No MCP servers configured.</div>
      )}

      {servers.map((s: any) => (
        <div key={s.id} className="border-b border-[var(--line)] py-3 last:border-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Server size={14} />
                <span>{s.name}</span>
                <LiveStateBadge live={s.live} />
              </div>
              <div className="mt-0.5 truncate text-xs text-[var(--muted)]">
                HTTP · {s.url} ·{" "}
                {s.authType === "none"
                  ? "No auth"
                  : s.authType === "bearer"
                    ? `Bearer (${s.credentialLabel ?? "missing vault login"})`
                    : `${String(s.authHeader ?? "Custom").split(":")[0]} (${s.credentialLabel ?? "missing vault login"})`}
              </div>
              {Array.isArray(s.allowlist) && s.allowlist.length > 0 && (
                <div className="mt-1 text-xs text-[var(--muted)]">Allowlist: {s.allowlist.join(", ")}</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Toggle
                checked={s.enabled}
                onChange={async (v) => {
                  await patch(`/mcp-servers/${s.id}`, { enabled: v });
                  refresh();
                }}
                label={`Toggle ${s.name}`}
              />
              <Button size="sm" variant="soft" onClick={() => setEditingId(editingId === s.id ? null : s.id)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await del(`/mcp-servers/${s.id}`);
                  refresh();
                }}
                aria-label={`Remove ${s.name}`}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
          {editingId === s.id && (
            <McpServerForm
              initial={s}
              logins={logins}
              submitLabel="Save changes"
              onCancel={() => setEditingId(null)}
              onSubmit={async (body) => {
                await patch(`/mcp-servers/${s.id}`, body);
                setEditingId(null);
                refresh();
              }}
            />
          )}
        </div>
      ))}

      <div className="mt-4">
        {!adding ? (
          <Button size="sm" variant="soft" onClick={() => setAdding(true)}>
            Add MCP server
          </Button>
        ) : (
          <McpServerForm
            logins={logins}
            submitLabel="Add server"
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              await post("/mcp-servers", body);
              setAdding(false);
              refresh();
            }}
          />
        )}
      </div>
    </Section>
  );
}

function UsageSettings() {
  const { data } = useQuery({ queryKey: ["usage"], queryFn: () => api("/usage") });
  if (!data) return null;
  const u = data.usage;
  return (
    <>
      <Section
        title="Today's usage"
        desc={
          u.limit
            ? `Resets ${new Date(u.resetsAt).toLocaleString()}`
            : "Units approximate model cost: about 1 per 1k input tokens. Set AMUSE_DAILY_LIMIT to cap a day's spend."
        }
      >
        {u.limit && (
          <div className="mb-2 h-3 overflow-hidden rounded-full bg-[var(--line)]">
            <div className="h-full bg-[var(--accent)]" style={{ width: `${u.percent}%` }} />
          </div>
        )}
        <div className="text-sm text-[var(--muted)]">{u.limit ? `${u.used} of ${u.limit} units used today` : `${u.used} units used today`}</div>
      </Section>
      {data.history?.length > 0 && (
        <Section title="Last 14 days">
          <div className="space-y-1 text-sm">
            {data.history.map((h: any) => (
              <div key={h.day} className="flex justify-between border-b border-[var(--line)] py-1.5">
                <span>{h.day}</span>
                <span className="text-[var(--muted)]">
                  {h.units} units · {Math.round((h.tokensIn + h.tokensOut) / 1000)}k tokens{h.images ? ` · ${h.images} images` : ""}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function DataSettings({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  const [confirm, setConfirm] = useState("");
  const s = data?.settings;
  if (!s) return null;
  const save = async (body: any) => (await patch("/settings", body), qc.invalidateQueries({ queryKey: ["settings"] }));
  return (
    <>
      <Section title="Data controls">
        <Row label="Notifications" desc="Proactive messages and reminders">
          <Toggle checked={s.notifications} onChange={(v) => save({ notifications: v })} label="Notifications" />
        </Row>
        <CallVoiceRow />
        <Row label="Natural voice">
          <select
            value={s.voice}
            onChange={(e) => save({ voice: e.target.value })}
            className="h-9 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 text-sm"
          >
            {["alloy", "nova", "shimmer", "echo", "onyx", "fable", "sage", "coral"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Row>
      </Section>
      <Section title="Reset" desc="Permanently deletes all information, chat history, files, spaces and active tasks. This can't be undone.">
        <div className="flex gap-2">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type RESET to confirm" />
          <Button
            variant="danger"
            disabled={confirm !== "RESET"}
            onClick={async () => {
              await post("/settings/reset", { confirm });
              location.href = "/";
            }}
          >
            Reset {me.agent.name ?? "agent"}
          </Button>
        </div>
      </Section>
    </>
  );
}

const TABS = [
  { id: "agent", label: "Agent" },
  { id: "connectors", label: "Connectors" },
  { id: "mcp", label: "MCP servers" },
  { id: "vault", label: "Vault", icon: <KeyRound size={14} /> },
  { id: "permissions", label: "Permissions" },
  { id: "usage", label: "Usage" },
  { id: "data", label: "Data" },
];

export function SettingsPage({ me }: { me: Me }) {
  const [, params] = useRoute("/settings/:tab");
  const tab = params?.tab ?? "agent";
  return (
    <div className="overflow-y-auto">
      <PageHeader title="Settings" />
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 pb-16 md:flex-row md:px-8">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/settings/${t.id}`}
              className={cx(
                "flex items-center justify-between whitespace-nowrap rounded-xl px-3 py-2 text-sm",
                tab === t.id || (t.id === "vault" && tab === "credentials") ? "bg-[var(--card)] font-medium" : "text-[var(--muted)] hover:bg-[var(--hover)]",
              )}
            >
              {t.label} <ChevronRight size={14} className="hidden md:block" />
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {tab === "agent" && <AgentSettings me={me} />}
          {tab === "connectors" && <ConnectorsSettings />}
          {tab === "mcp" && <McpServersSettings />}
          {(tab === "vault" || tab === "credentials") && <VaultSettings />}
          {tab === "permissions" && <PermissionsSettings />}
          {tab === "usage" && <UsageSettings />}
          {tab === "data" && <DataSettings me={me} />}
        </div>
      </div>
    </div>
  );
}

function CallVoiceRow() {
  const [engine, setEngine] = useState(voiceEngine());
  return (
    <Row
      label="Call voice"
      desc={
        engine === "device"
          ? "Your browser's built-in voice. Answers start instantly."
          : "Amuse's own natural voice. Sounds richer but takes a few seconds per reply."
      }
    >
      <select
        value={engine}
        onChange={(e) => (setVoiceEngine(e.target.value as VoiceEngine), setEngine(e.target.value as VoiceEngine))}
        className="h-9 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 text-sm"
        data-testid="call-voice-engine"
      >
        {deviceVoiceAvailable() && <option value="device">Instant</option>}
        <option value="natural">Natural (slower)</option>
      </select>
    </Row>
  );
}
