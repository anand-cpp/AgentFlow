import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Node.js runtime globals. Declared explicitly so the ruleset stays
        // dependency-free instead of pulling in the `globals` package.
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        queueMicrotask: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        structuredClone: "readonly",
        performance: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        // Web-platform globals used by the imported open-sse executors.
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    ignores: ["node_modules/**", ".next/**", "dist/**", "build/**", "out/**", "coverage/**", "open-sse/**",
      // Plugin fixtures are payloads, not host modules. They are CommonJS or
      // ESM plugin sources evaluated inside the loader's vm sandbox, so the
      // host toolchain must not lint or typecheck them as part of this
      // package -- `module.exports` is correct there and an error here.
      "test/plugins/fixtures/**"],
  },
];
