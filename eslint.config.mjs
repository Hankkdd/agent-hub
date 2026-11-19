// Lint enforces the AGENTS.md rules that a machine can check. It holds no style rules: tsc already
// runs strict, and each rule here exists because breaking it is a bug, not a matter of taste.
//
// Flat config does not merge one rule's options across config objects (the last match wins), so
// each file group below sets the complete value of every rule it uses, built from the pieces here.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const SDKS = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

const shellString = {
  importNames: ["exec", "execSync"],
  message:
    "exec and execSync run a shell string. Pass the command and its arguments to execFile, execFileSync or spawn " +
    "instead; agent-supplied commands are untrusted (AGENTS.md, Rules).",
};
const noShellString = ["child_process", "node:child_process"].map((name) => ({ name, ...shellString }));

const noSdk = SDKS.map((name) => ({
  name,
  message:
    "SDKs appear only in apps/server/src/agents/. Add what you need to AgentAdapter (agents/types.ts) or export a " +
    "type from the adapter, and use that here (AGENTS.md, Rules).",
}));

const shellTrue = {
  selector: "Property[key.name='shell'][value.value=true]",
  message: "shell: true turns arguments back into a shell string. Pass them as an argv array (AGENTS.md, Rules).",
};

const emojiMessage = "No emoji in code or output (AGENTS.md, Style).";
const noEmoji = ["Literal[value=/\\p{Emoji_Presentation}/u]", "TemplateElement[value.raw=/\\p{Emoji_Presentation}/u]", "JSXText[value=/\\p{Emoji_Presentation}/u]"].map(
  (selector) => ({ selector, message: emojiMessage }),
);

const apiClientOnly = ["fetch", "EventSource", "WebSocket"].map((name) => ({
  name,
  message: "apps/web/src/lib/client.ts is the only API client. Add a method there and call it (AGENTS.md, Layout).",
}));

const insecureContext = [
  {
    object: "crypto",
    property: "randomUUID",
    message:
      "The UI is plain http on a tailnet, not a secure context, so crypto.randomUUID is undefined there. " +
      "Use a counter (see lib/images.ts) or crypto.getRandomValues (AGENTS.md, Rules).",
  },
  {
    object: "navigator",
    property: "clipboard",
    message:
      "navigator.clipboard is undefined outside a secure context, and the UI is plain http. Use copyText from " +
      "lib/copy.ts, which falls back (AGENTS.md, Rules).",
  },
];

// React's own hook rules: rules-of-hooks, exhaustive-deps and the React Compiler checks (setState in an
// effect, refs read during render, impure calls during render). All are errors, including the ones the
// plugin ships as warnings, because a warning nobody has to fix is a rule nobody follows.
// Existing violations are recorded in eslint-suppressions.json: new code must pass, and when a
// suppressed one is fixed, `pnpm lint --prune-suppressions` removes it from the file.
const reactHooksRules = Object.fromEntries(Object.keys(reactHooks.configs.recommended.rules).map((rule) => [rule, "error"]));

const imports = (...paths) => ["error", { paths: paths.flat() }];
const syntax = (...selectors) => ["error", ...selectors.flat()];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "apps/server/drizzle/**", "data/**", ".claude/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  // Server source outside the adapters.
  {
    files: ["apps/server/src/**/*.ts"],
    rules: {
      "no-restricted-imports": imports(noShellString, noSdk),
      "no-restricted-syntax": syntax(shellTrue, noEmoji),
    },
  },
  // The adapters are where the SDKs live.
  {
    files: ["apps/server/src/agents/**/*.ts"],
    rules: {
      "no-restricted-imports": imports(noShellString),
      "no-restricted-syntax": syntax(shellTrue, noEmoji),
    },
  },
  // Tests and operator scripts may drive an SDK directly (adapter tests, login scripts), and tests use
  // emoji as UTF-16 surrogate-pair data. They still never build shell strings.
  {
    files: ["apps/server/test/**/*.ts", "apps/server/scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": imports(noShellString),
      "no-restricted-syntax": syntax(shellTrue),
    },
  },
  {
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooksRules,
      "no-restricted-imports": imports(noSdk),
      "no-restricted-syntax": syntax(noEmoji),
      "no-restricted-globals": ["error", ...apiClientOnly],
      "no-restricted-properties": ["error", ...insecureContext],
    },
  },
  // Web tests use emoji as surrogate-pair data and stub fetch to test the client.
  {
    files: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    rules: { "no-restricted-syntax": "off", "no-restricted-globals": "off" },
  },
  {
    files: ["apps/web/src/lib/client.ts"],
    rules: { "no-restricted-globals": "off" },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-imports": imports(noSdk),
      "no-restricted-syntax": syntax(noEmoji),
    },
  },
);
