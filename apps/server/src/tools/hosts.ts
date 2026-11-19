import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import type { Host, SshLogEntry } from "@agent-hub/shared";
import { schema, type Db } from "../db/index";
import { DEFAULT_TIMEOUT_S, expandHome, formatResult, sshExec, type SshResult } from "./ssh";
import { copy, localSize, parseLocator, type Locator } from "./copy";

const { hosts, sshLog } = schema;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class HostError extends Error {}

/** The device registry and the one place an ssh command is run and logged. */
export class Hosts {
  readonly knownHostsFile: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    /** Agent Hub's own key: the default for a new device. */
    private readonly defaultKeyPath = "~/.ssh/id_ed25519",
  ) {
    this.knownHostsFile = path.join(dataDir, "ssh", "known_hosts");
  }

  list(): Host[] {
    return this.db.select().from(hosts).orderBy(hosts.name).all().map(toHost);
  }

  get(name: string): Host | null {
    const row = this.db.select().from(hosts).where(eq(hosts.name, name)).get();
    return row ? toHost(row) : null;
  }

  upsert(name: string, input: Partial<Host>): Host {
    if (!NAME.test(name)) throw new HostError("name: lowercase letters, digits, - and _, up to 32 characters");
    const prev = this.get(name);
    const h: Host = {
      name,
      address: (input.address ?? prev?.address ?? "").trim(),
      user: (input.user ?? prev?.user ?? "").trim(),
      port: Number(input.port ?? prev?.port ?? 22),
      keyPath: (input.keyPath || prev?.keyPath || this.defaultKeyPath).trim(),
      note: (input.note ?? prev?.note ?? "").trim(),
      prod: input.prod ?? prev?.prod ?? false,
      shell: input.shell ?? prev?.shell ?? "posix",
    };
    if (h.shell !== "posix" && h.shell !== "powershell") throw new HostError("shell must be posix or powershell");
    if (!h.address) throw new HostError("address is required");
    if (!h.user) throw new HostError("user is required");
    if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) throw new HostError("port must be 1-65535");
    if (!fs.existsSync(expandHome(h.keyPath))) throw new HostError(`no key file at ${h.keyPath}`);
    if (prev) this.db.update(hosts).set(h).where(eq(hosts.name, name)).run();
    else this.db.insert(hosts).values({ ...h, createdAt: new Date().toISOString() }).run();
    return h;
  }

  remove(name: string): void {
    this.db.delete(hosts).where(eq(hosts.name, name)).run();
  }

  /** Run a command and record it. The single path for agents and the UI's connection test alike. */
  async exec(name: string, command: string, opts: { taskId?: string | null; timeoutS?: number; signal?: AbortSignal } = {}): Promise<{ result: SshResult; text: string }> {
    const host = this.get(name);
    if (!host) throw new HostError(`no host named "${name}". Registered: ${this.list().map((h) => h.name).join(", ") || "(none)"}`);
    const startedAt = new Date().toISOString();
    const timeoutS = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
    const result = await sshExec(host, command, { knownHostsFile: this.knownHostsFile, timeoutS, signal: opts.signal });
    const text = formatResult(result, timeoutS);
    this.db
      .insert(sshLog)
      .values({ id: randomUUID(), taskId: opts.taskId ?? null, host: name, command, exitCode: result.exitCode, output: text.slice(0, 20_000), startedAt, durationMs: result.durationMs })
      .run();
    return { result, text };
  }

  /**
   * Copy between devices and the task's directory (see tools/copy.ts for what a locator may name).
   * Logged against every device involved, like an ssh_exec.
   */
  async copyFile(source: string, destination: string, opts: { cwd: string; taskId?: string | null; timeoutS?: number; signal?: AbortSignal }): Promise<{ ok: boolean; text: string }> {
    const all = this.list();
    const src = parseLocator(source, all, opts.cwd);
    const dst = parseLocator(destination, all, opts.cwd);
    if (src.kind === "local" && dst.kind === "local") throw new HostError("both ends are in the task's directory; use a shell command to move files there");
    const timeoutS = opts.timeoutS ?? 600;
    const startedAt = new Date().toISOString();
    const r = await copy(src, dst, { knownHostsFile: this.knownHostsFile, timeoutS, signal: opts.signal });
    const show = (l: Locator, raw: string) => (l.kind === "host" ? raw : `${raw} (task directory)`);
    const arrived = r.ok && dst.kind === "local" ? `, ${formatBytes(localSize(dst.path))} in the task directory` : "";
    const text = r.ok
      ? `copied ${show(src, source)} -> ${show(dst, destination)} in ${(r.durationMs / 1000).toFixed(1)}s${arrived}${r.output ? `\n${r.output}` : ""}`
      : `copy failed${r.timedOut ? ` (timed out after ${timeoutS}s)` : ""}: ${r.output}` +
        // scp does not create missing parent directories; say so rather than leave the agent to guess.
        (/no such file or directory/i.test(r.output) && dst.kind === "host"
          ? "\nIf the source exists, the destination's parent directory probably does not: create it first with ssh_exec (mkdir -p on Linux or macOS, New-Item -ItemType Directory -Force on Windows), then copy again."
          : "");
    for (const l of [src, dst]) {
      if (l.kind !== "host") continue;
      this.db
        .insert(sshLog)
        .values({ id: randomUUID(), taskId: opts.taskId ?? null, host: l.host.name, command: `copy_file ${source} -> ${destination}`, exitCode: r.ok ? 0 : 1, output: text.slice(0, 20_000), startedAt, durationMs: r.durationMs })
        .run();
    }
    return { ok: r.ok, text };
  }

  log(name: string, limit = 50): SshLogEntry[] {
    return this.db.select().from(sshLog).where(eq(sshLog.host, name)).orderBy(desc(sshLog.startedAt)).limit(limit).all();
  }
}

function toHost(r: typeof hosts.$inferSelect): Host {
  return { name: r.name, address: r.address, user: r.user, port: r.port, keyPath: r.keyPath, note: r.note, prod: r.prod, shell: r.shell as Host["shell"] };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
