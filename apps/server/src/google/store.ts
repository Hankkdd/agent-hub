import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { GoogleError } from "./http";

export interface StoredAccount {
  email: string;
  refreshToken: string;
  scopes: string[];
  updatedAt: string;
}

export interface AccountStore {
  version: 1;
  accounts: Record<string, StoredAccount>;
}

function isAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<StoredAccount>;
  return typeof a.email === "string" && typeof a.refreshToken === "string" && typeof a.updatedAt === "string" &&
    Array.isArray(a.scopes) && a.scopes.every((scope: unknown) => typeof scope === "string");
}

export class GoogleStore {
  readonly dir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "google");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    this.file = path.join(this.dir, "accounts.json");
    const client = path.join(this.dir, "client.json");
    if (fs.existsSync(client)) fs.chmodSync(client, 0o600);
  }

  read(): AccountStore {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        value.version !== 1 || !value.accounts || typeof value.accounts !== "object" ||
        Array.isArray(value.accounts) || Object.keys(value.accounts).length > 1 ||
        Object.values(value.accounts).some((account) => !isAccount(account))
      ) {
        throw new Error();
      }
      fs.chmodSync(this.file, 0o600);
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: {} };
      throw new GoogleError("storage_error", "Could not read Google account storage");
    }
  }

  write(value: AccountStore): void {
    const temp = path.join(this.dir, `.accounts-${randomBytes(12).toString("hex")}`);
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
