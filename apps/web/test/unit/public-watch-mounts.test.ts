import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import ts from "typescript";

// Source-wiring checks complement the production controller tests. They do not
// claim to mount React, execute Next.js rendering, or emulate a real browser.
function source(path: string): ts.SourceFile {
  const file = new URL(`../../${path}`, import.meta.url);
  return ts.createSourceFile(path, readFileSync(file, "utf8"), ts.ScriptTarget.Latest,
    true, ts.ScriptKind.TSX);
}

function descendants<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const pages = [
  ["app/p/[slug]/page.tsx", "result.origin", "claimBoardWatchTargets(result.watch, claimRows)"],
  ["app/p/[slug]/claims/[claim]/page.tsx", "result.origin", "publicViewWatchTargets(result.watch)"],
  ["app/now/page.tsx", "nowData.origin", "publicViewWatchTargets(nowData.watch)"],
  ["app/reviews/page.tsx", "result.origin", "publicViewWatchTargets(result.watch)"],
  ["app/p/[slug]/dead-ends/page.tsx", "result.origin", "publicViewWatchTargets(result.watch)"],
] as const;

for (const [path, origin, manifest] of pages) {
  test(`${path} mounts one live island from the resources actually rendered`, () => {
    const file = source(path);
    const client = file.statements.some((statement) => ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) && statement.expression.text === "use client");
    assert.equal(client, false, "scientific content must remain server rendered");
    const islands = descendants(file, ts.isJsxSelfClosingElement)
      .filter((element) => element.tagName.getText(file) === "PublicLedgerLive");
    assert.equal(islands.length, 1, "one poller per view, not one per scientific card");
    const island = islands[0];
    assert.ok(island);
    const attributes = new Map(island.attributes.properties.filter(ts.isJsxAttribute)
      .map((attribute) => [attribute.name.getText(file), attribute.initializer]));
    for (const [key, expected] of [["origin", origin], ["targets", manifest]] as const) {
      const value = attributes.get(key);
      assert.ok(value && ts.isJsxExpression(value));
      assert.equal(value.expression?.getText(file), expected);
    }
    const imports = descendants(file, ts.isImportDeclaration);
    assert.ok(imports.some((declaration) => ts.isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === "@/components/public-ledger-live"));
  });
}

test("router context churn cannot restart the watcher or reset its refresh budget", () => {
  const file = source("components/public-ledger-live.tsx");
  const effects = descendants(file, ts.isCallExpression)
    .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === "useEffect");
  const watchEffects = effects.filter((effect) => {
    const callback = effect.arguments[0];
    return callback !== undefined && descendants(callback, ts.isNewExpression)
      .some((node) => node.expression.getText(file) === "PublicLedgerWatch");
  });
  assert.equal(watchEffects.length, 1);
  const effect = watchEffects[0];
  assert.ok(effect);
  const dependencies = effect.arguments[1];
  assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
  assert.deepEqual(dependencies.elements.map((item) => item.getText(file)), ["origin", "manifest", "enabled"]);
  const callback = effect.arguments[0];
  assert.ok(callback);
  assert.ok(descendants(callback, ts.isCallExpression)
    .some((call) => call.expression.getText(file) === "refreshRouter.current.refresh"));
  assert.ok(effects.some((call) => call.arguments[1]?.getText(file) === "[router]" &&
    call.arguments[0]?.getText(file).includes("refreshRouter.current = router")));
});
