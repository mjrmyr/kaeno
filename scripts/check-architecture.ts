import { readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = process.cwd();
const configuration = ts.readConfigFile(
  resolve(root, "tsconfig.json"),
  ts.sys.readFile,
);
const options = ts.parseJsonConfigFileContent(
  configuration.config,
  ts.sys,
  root,
);
const program = ts.createProgram(options.fileNames, options.options);
const checker = program.getTypeChecker();
const errors: string[] = [];
// Layers come from the path: src/<layer>/<feature>/... Core never depends on extensions or the host;
// extensions may use core and each other; only the host composes concrete features.
const layers = new Set(["core", "extensions", "host"]);
async function filesIn(directory: string): Promise<string[]> {
  // The browser package has its own TypeScript configuration and checks.
  if (directory === resolve(root, "src/ui")) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return filesIn(path);
      }
      return extname(path) === ".ts" ? [path] : [];
    }),
  );
  return groups.flat();
}
function layerOf(path: string): string | undefined {
  const [layer] = relative(resolve(root, "src"), path).split(sep);
  return layer === undefined || layer === ".." ? undefined : layer;
}
function featureOf(path: string): string | undefined {
  const parts = relative(resolve(root, "src"), path).split(sep);
  if (parts[0] === ".." || parts.length < 3) {
    return undefined;
  }
  return `${parts[0]}/${parts[1]}`;
}
function nameOf(feature: string): string {
  return feature.slice(feature.indexOf("/") + 1);
}
function report(file: ts.SourceFile, node: ts.Node, message: string): void {
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  errors.push(
    `${relative(root, file.fileName)}:${position.line + 1}:${position.character + 1} ${message}`,
  );
}
function hasModifier(node: ts.Node, modifier: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((candidate) => candidate.kind === modifier) ??
      false)
  );
}
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  return (
    !clause.name &&
    !!clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}
// WORK protocol names are owned by core/work/tools.ts; read them statically so the list is never copied.
const workToolsFile = resolve(root, "src/core/work/tools.ts");
const workToolNames = new Set<string>();
for (const statement of program.getSourceFile(workToolsFile)?.statements ??
  []) {
  if (
    ts.isVariableStatement(statement) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) {
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        workToolNames.add(declaration.initializer.text);
      }
    }
  }
}
const workDirectory = resolve(root, "src/core/work") + sep;
// Core never reads files or definition formats: recovery must work with every source deleted.
const coreForbiddenModules = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "yaml",
]);
function isForbiddenDynamicImport(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteral(node.arguments[0]) &&
    coreForbiddenModules.has(node.arguments[0].text)
  );
}
const paths = [
  ...(await filesIn(resolve(root, "src"))),
  ...(await filesIn(resolve(root, "scripts"))),
  ...(await filesIn(resolve(root, "test"))),
];
function sourceFileFor(path: string): ts.SourceFile {
  const file = program.getSourceFile(path);
  if (!file) {
    throw new Error(`TypeScript configuration does not include ${path}`);
  }
  return file;
}
for (const path of paths) {
  const file = sourceFileFor(path);
  const owner = featureOf(path);
  const layer = layerOf(path);
  if (layer !== undefined && !layers.has(layer)) {
    report(
      file,
      file,
      `Place "src/${layer}" under src/core, src/extensions or src/host.`,
    );
  }
  const unit = path.endsWith(".test.ts") && owner !== undefined;
  const mockedModules = new Set<string>();
  function collectMocks(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "vi" &&
      node.expression.name.text === "mock" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      mockedModules.add(node.arguments[0].text);
    }
    ts.forEachChild(node, collectMocks);
  }
  collectMocks(file);
  function visit(node: ts.Node): void {
    if (
      ts.isConditionalExpression(node) &&
      (ts.isConditionalExpression(node.whenTrue) ||
        ts.isConditionalExpression(node.whenFalse))
    ) {
      report(
        file,
        node,
        "Replace nested ternaries with a named operation and if/switch.",
      );
    }
    if (
      layer !== undefined &&
      !path.endsWith(".test.ts") &&
      !path.startsWith(workDirectory) &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      workToolNames.has(node.text)
    ) {
      report(
        file,
        node,
        `Use the WORK name constants from core instead of the literal "${node.text}".`,
      );
    }
    if (path.endsWith(".test.ts")) {
      let member: ts.Symbol | undefined;
      if (ts.isPropertyAccessExpression(node)) {
        member = checker.getSymbolAtLocation(node.name);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        member = checker
          .getTypeAtLocation(node.expression)
          .getProperty(node.argumentExpression.text);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "spyOn" &&
        node.arguments[0] &&
        node.arguments[1] &&
        ts.isStringLiteral(node.arguments[1])
      ) {
        member = checker
          .getTypeAtLocation(node.arguments[0])
          .getProperty(node.arguments[1].text);
      }
      if (
        member?.declarations?.some(
          (declaration) =>
            hasModifier(declaration, ts.SyntaxKind.PrivateKeyword) ||
            hasModifier(declaration, ts.SyntaxKind.ProtectedKeyword),
        )
      ) {
        report(
          file,
          node,
          "Test behavior through public APIs, not private implementation members.",
        );
      }
    }
    if (
      owner &&
      owner !== "core/application" &&
      layer !== "host" &&
      !path.endsWith(".test.ts") &&
      ts.isNewExpression(node)
    ) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const provider = target?.declarations
        ?.map((declaration) => featureOf(declaration.getSourceFile().fileName))
        .find((candidate) => candidate && candidate !== owner);
      if (provider) {
        report(
          file,
          node,
          "Application composition constructs other features; inject their consumer-owned capabilities.",
        );
      }
    }
    if (
      owner &&
      layer === "core" &&
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      const provider = featureOf(
        resolve(dirname(path), node.moduleSpecifier.text),
      );
      if (provider && !provider.startsWith("core/")) {
        report(
          file,
          node,
          `Core feature "${nameOf(owner)}" cannot re-export "${provider}".`,
        );
      }
    }
    if (ts.isExportDeclaration(node) && !node.exportClause) {
      report(
        file,
        node,
        "List public exports explicitly; export * is forbidden.",
      );
    }
    if (
      ts.isAsExpression(node) &&
      !(
        ts.isTypeReferenceNode(node.type) &&
        node.type.typeName.getText(file) === "const"
      )
    ) {
      report(file, node, "Narrow unknown values instead of casting them.");
    }
    if (ts.isTypeAssertionExpression(node)) {
      report(
        file,
        node,
        "Type assertions are forbidden; validate at the boundary.",
      );
    }
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length > 1
    ) {
      report(file, node, "Use one variable declaration per statement.");
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text.length === 1 &&
      !["_", "z"].includes(node.name.text)
    ) {
      report(file, node, "Use descriptive domain binding names.");
    }
    if (
      ts.isFunctionDeclaration(node) &&
      hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
      !node.type
    ) {
      report(file, node, "Exported functions require an explicit return type.");
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
      (ts.isClassDeclaration(node.parent) ||
        ts.isClassExpression(node.parent)) &&
      !hasModifier(node, ts.SyntaxKind.PrivateKeyword) &&
      !hasModifier(node, ts.SyntaxKind.ProtectedKeyword) &&
      !node.type
    ) {
      report(
        file,
        node,
        "Public class methods require an explicit return type.",
      );
    }
    if (
      layer === "core" &&
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          coreForbiddenModules.has(node.moduleSpecifier.text)
        : isForbiddenDynamicImport(node))
    ) {
      report(
        file,
        node,
        "Core cannot read files or definition formats; load them in an extension or the host.",
      );
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const target = specifier.startsWith(".")
        ? resolve(dirname(path), specifier)
        : undefined;
      const targetOwner = target ? featureOf(target) : undefined;
      const targetLayer = target ? layerOf(target) : undefined;
      if (layer === "core" && targetLayer && targetLayer !== "core") {
        report(
          file,
          node,
          `Core feature "${nameOf(owner ?? "core/")}" cannot import "${targetOwner ?? targetLayer}"; compose it in src/host.`,
        );
      }
      if (layer === "extensions" && targetLayer === "host") {
        report(
          file,
          node,
          `Extension "${nameOf(owner ?? "extensions/")}" cannot import the host; the host composes extensions.`,
        );
      }
      if (
        (layer === "extensions" || layer === "host") &&
        targetLayer === "core" &&
        target !== resolve(root, "src/core/application/index.ts")
      ) {
        report(
          file,
          node,
          "Import core only through src/core/application/index.ts.",
        );
      }
      if (
        targetOwner &&
        targetOwner !== owner &&
        !target?.endsWith(`${sep}index.ts`)
      ) {
        report(
          file,
          node,
          "Import another feature only through its index.ts API.",
        );
      }
      if (
        unit &&
        targetOwner &&
        !isTypeOnlyImport(node) &&
        !mockedModules.has(specifier) &&
        (targetOwner !== owner || !target?.endsWith(`${sep}index.ts`))
      ) {
        report(
          file,
          node,
          "Unit tests exercise their feature's public index.ts and mock other feature boundaries.",
        );
      }
      if (unit && /\/test\/integration\//.test(target ?? "")) {
        report(file, node, "Unit tests cannot depend on integration fixtures.");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${paths.length} TypeScript files).`);
}
