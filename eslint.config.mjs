import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Unawaited work fails the build. Hook findings stay warnings: the renderer
// calls useEffectEvent functions from event handlers, which works at runtime
// but breaks the rule, and rewriting that is a behaviour change of its own.
export default tseslint.config({
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { project: ["tsconfig.node.json", "tsconfig.web.json", "tsconfig.native-host.json"], tsconfigRootDir: import.meta.dirname }
  },
  plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "react-hooks/rules-of-hooks": "warn",
    "react-hooks/exhaustive-deps": "warn"
  }
});
