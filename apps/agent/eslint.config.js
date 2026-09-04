// Flat ESLint config (ESLint 9+). Kept intentionally small - this package has
// no shared root eslint config to extend from, so this is self-contained.
// NOTE: package versions (eslint ^9.18.0, typescript-eslint ^8.19.1) were
// chosen as plausible recent-stable versions without live registry access;
// please verify/pin during `pnpm install` (see apps/agent/README.md).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      // Never build a shell/PowerShell command by string concatenation with
      // untrusted input - this is a repo-wide hard requirement for this
      // package (see docs/architecture.md sec 10-11), enforced by review and
      // by this package only ever importing `spawn` from `node:child_process`
      // (never `exec`/`execSync`, which run through a shell). Not encoded as
      // an eslint rule: a purely syntactic selector for ".exec(...)" can't
      // distinguish `child_process.exec` from an ordinary `RegExp.exec`
      // call without type information, so it would false-positive on the
      // latter (used harmlessly in config.ts/index.ts for CLI arg parsing).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
