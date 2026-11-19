import { ensureImage as ensureCodexImage, imageTag as codexImageTag } from "../agents/codex-docker";
import { ensureImage, type ImageSpec } from "./images";

/** Only simple mise tool names and versions: no backends, options, paths or shell syntax. */
export function validateToolchain(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("toolchain must be an object of mise tool names to versions");
  }
  // A strict end assertion also rejects trailing newlines, which JavaScript's $ permits.
  for (const [name, version] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(name)) throw new Error(`Invalid toolchain tool name: ${JSON.stringify(name)}`);
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}(?![\s\S])/.test(version)) {
      throw new Error(`Invalid toolchain version for ${name}: expected letters, digits, dots, underscores, plus or hyphen`);
    }
  }
}

export function toolchainSpec(toolchain: Record<string, string>, baseTag = codexImageTag()): ImageSpec {
  validateToolchain(toolchain);
  const tools = Object.keys(toolchain).sort().map((name) => `${name}@${toolchain[name]}`).join(" ");
  return { name: "agent-hub-codex-toolchain", dockerfile: "toolchain.Dockerfile", buildArgs: { CODEX_IMAGE: baseTag, TOOLS: tools } };
}

export async function ensureToolchainImage(toolchain: Record<string, string>, onBuild?: () => void): Promise<{ tag: string; built: boolean }> {
  const spec = toolchainSpec(toolchain);
  await ensureCodexImage(undefined, onBuild);
  return ensureImage(spec, onBuild);
}
