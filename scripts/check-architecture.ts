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
const coreFeatures = new Set([
  "api",
  "application",
  "authority",
  "conversation",
  "durable",
  "threads",
  "turns",
  "work",
]);
const optionalFeatures = new Set([
  "agents",
  "composition",
  "definitions",
  "execution",
  "github",
  "kubernetes",
  "sandbox",
  "skills",
]);
async function filesIn(directory: string): Promise<string[]> {
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
function featureOf(path: string): string | undefined {
  const parts = relative(resolve(root, "src"), path).split(sep);
  if (parts[0] === ".." || parts.length < 2) {
    return undefined;
  }
  return parts[0];
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
const paths = [
  ...(await filesIn(resolve(root, "src"))),
  ...(await filesIn(resolve(root, "scripts"))),
  ...(await filesIn(resolve(root, "test"))),
];
for (const path of paths) {
  const file = program.getSourceFile(path);
  if (!file) {
    throw new Error(`TypeScript configuration does not include ${path}`);
  }
  const owner = featureOf(path);
  const unit = path.endsWith(".test.ts") && owner !== undefined;
  const mockedModules = new Set<string>();
  const collectMocks = (node: ts.Node): void => {
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
  };
  collectMocks(file);
  const visit = (node: ts.Node): void => {
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
      owner !== "application" &&
      owner !== "composition" &&
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
      coreFeatures.has(owner) &&
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      const provider = featureOf(
        resolve(dirname(path), node.moduleSpecifier.text),
      );
      if (provider && optionalFeatures.has(provider)) {
        report(
          file,
          node,
          `Core feature "${owner}" cannot re-export optional feature "${provider}".`,
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
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const target = specifier.startsWith(".")
        ? resolve(dirname(path), specifier)
        : undefined;
      const targetOwner = target ? featureOf(target) : undefined;
      if (
        owner &&
        coreFeatures.has(owner) &&
        targetOwner &&
        optionalFeatures.has(targetOwner)
      ) {
        report(
          file,
          node,
          `Core feature "${owner}" cannot import optional feature "${targetOwner}"; compose it at the application boundary.`,
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
  };
  visit(file);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${paths.length} TypeScript files).`);
}
