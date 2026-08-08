import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "src-tauri/gen"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // The two classic hook rules stay errors, as they always were.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // The React Compiler rule set, adopted deliberately (2026-08-08) rather
      // than inherited. eslint-plugin-react-hooks 7 switched these on in its
      // `recommended` preset, and the preset arrived here as a side effect of
      // the eslint 10 upgrade taken to clear a `brace-expansion` advisory. They
      // were pinned off at the time so a security upgrade could not quietly
      // change lint policy; this is the policy decision made on its own merits.
      //
      // They are listed by name, at `warn`, rather than spread from the preset,
      // for two reasons. The preset sets most of them to `error`, and these
      // describe what the React Compiler would need in order to memoize a
      // component: real advice, but not the same kind of claim as "you called a
      // hook conditionally". And naming them means a future plugin release
      // cannot add a rule to this codebase without someone deciding to.
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/void-use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/unsupported-syntax": "warn",
      "react-hooks/config": "warn",
      "react-hooks/gating": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // shadcn co-locates variant constants with components by convention.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
