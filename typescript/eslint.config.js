import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The src/ layers, lowest first, above src/generated/. A module imports at runtime only from its
// own layer and the layers below it; `import type` may name any layer. The entry points and
// client.ts at the src/ root sit above every layer, and version.ts, a constant, below them all.
const LAYERS = ["core", "config", "http", "datasets", "search"];

const layerRules = LAYERS.map((dir, rank) => ({
  files: [`src/${dir}/**/*.ts`],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              ...LAYERS.slice(rank + 1).map((above) => `../${above}/*`),
              "../client.ts",
              "../index*.ts",
              "../arrow.ts",
              "../wire.ts",
            ],
            allowTypeImports: true,
            message: `src/${dir} imports at runtime only from lower layers; use \`import type\` for a type.`,
          },
        ],
      },
    ],
  },
}));

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
  ...layerRules,
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
