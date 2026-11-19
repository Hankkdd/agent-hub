import fs from "node:fs/promises";
import path from "node:path";
import { PrototypeError } from "./protocol";

export interface Ledger { attempts: number; initialRunner?: string; completed: number; result?: unknown; version?: number; cliArguments?: string[]; modelChoice?: string; continuation?: "REQUESTS_2_AND_3_REPLACEMENT_CONTAINER" }
export async function readLedger(state: string): Promise<Ledger> {
  try {
    const stat = await fs.lstat(path.join(state, "ledger.json"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error();
    const ledger = JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8")) as Ledger;
    if (!Number.isInteger(ledger.attempts) || ledger.attempts < 0 || ledger.attempts > 3 ||
        !Number.isInteger(ledger.completed) || ledger.completed < 0 || ledger.completed > ledger.attempts) throw new Error();
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { attempts: 0, completed: 0 };
    throw new PrototypeError("INVALID_LEDGER");
  }
}
export async function writeLedger(state: string, ledger: Ledger) {
  const pending = await fs.open(path.join(state, "ledger.next"), "wx", 0o600);
  try { await pending.writeFile(JSON.stringify(ledger)); await pending.sync(); }
  finally { await pending.close(); }
  await fs.rename(path.join(state, "ledger.next"), path.join(state, "ledger.json"));
  const directory = await fs.open(state, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
