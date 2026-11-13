import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The src/ layers, lowest first, above src/generated/. A module imports at runtime only from its
// own layer and the layers below it. `import type` may name any layer. The root files
// (client.ts, index.ts, index.node.ts, types.ts, errors.ts, wire.ts and arrow.ts) sit above
// every layer, and version.ts, a constant, below them all. Each pattern is a regex on the
// specifier, a run of `../` segments followed by a higher layer directory or a root file, so a
// nested module is checked as well. `./arrow.ts` inside src/datasets/ is a sibling of the root
// arrow.ts and stays allowed.
const LAYERS = ["core", "config", "http", "datasets", "search"];
const ROOT_FILES = ["client", "index", "index\\.node", "types", "errors", "wire", "arrow"];

const layerRules = LAYERS.map((dir, rank) => {
  const above = LAYERS.slice(rank + 1).map((layer) => `${layer}/`);
  const targets = [...above, ...ROOT_FILES.map((file) => `${file}\\.ts$`)].join("|");
  return {
    files: [`src/${dir}/**/*.ts`],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(\\.\\./)+(${targets})`,
              allowTypeImports: true,
              message: `src/${dir} imports at runtime only from lower layers; use \`import type\` for a type.`,
            },
          ],
        },
      ],
    },
  };
});

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
    // The layer rule reads static imports, so a dynamic import() would pass it unseen. No source
    // module needs one. apache-arrow loads through a static import in src/datasets/arrow.ts,
    // reached only from the separate arrow entry point.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Layers are checked on static imports only; use a static import.",
        },
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
