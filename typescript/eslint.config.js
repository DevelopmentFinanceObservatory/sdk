import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/generated/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // noUncheckedIndexedAccess types regex captures and in-range indexes as possibly
      // undefined; a non-null assertion states the invariant where it holds.
      "@typescript-eslint/no-non-null-assertion": "off",
      // An aborted signal's reason is the caller's value, passed on untouched.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
    },
  },
  {
    // node:test's test() and describe() return promises the runner awaits.
    files: ["test/**"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
