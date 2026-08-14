import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    // Negative-contract fixtures are intentionally malformed App Router trees.
    // They are inputs to the contract validator, never compiled or shipped.
    ignores: ["test/fixtures/**", ".next/**", "node_modules/**"],
  },
];
