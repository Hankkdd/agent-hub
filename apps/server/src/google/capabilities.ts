/** Add future capabilities here, each with its explicitly consented scopes. */
export const CAPABILITIES = {
  "drive.read": { scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
} satisfies Record<string, { scopes: readonly string[] }>;
export type GoogleCapability = keyof typeof CAPABILITIES;
export const BASE_SCOPES = ["openid", "email"];
export function isCapability(value: unknown): value is GoogleCapability {
  return typeof value === "string" && Object.hasOwn(CAPABILITIES, value);
}
export function capabilities(scopes: string[]): GoogleCapability[] {
  return (Object.keys(CAPABILITIES) as GoogleCapability[]).filter((key) => CAPABILITIES[key].scopes.every((scope) => scopes.includes(scope)));
}
