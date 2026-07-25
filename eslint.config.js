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
      // The two classic hook rules, named explicitly rather than spread from
      // the plugin's `recommended`. As of eslint-plugin-react-hooks 7 that
      // preset also switches on the React Compiler rule set (purity,
      // immutability, set-state-in-effect and friends), which flags a lot of
      // deliberate existing code. Taking those on is a lint-policy decision to
      // make on its own merits, not a side effect of the eslint 10 security
      // upgrade that brought the plugin with it. This keeps enforcement
      // exactly what it was under react-hooks 5.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
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
