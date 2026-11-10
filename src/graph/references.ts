import ts from "typescript";
import { resolve } from "node:path";

export interface SourceReference {
  specifier?: string;
  syntax: "import" | "export" | "require" | "require-resolve" | "dynamic-import" | "import-type" | "import-equals" | "glob" | "shadowed-require";
  phase: "runtime" | "type";
  line: number;
  column: number;
}

export function parseReferences(path: string, text: string): { references: SourceReference[]; errors: { line: number; column: number }[] } {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => resolve(name) === resolve(path) ? source : undefined;
  const program = ts.createProgram([path], options, host);
  const errors = program.getSyntacticDiagnostics(source).map((diagnostic) => {
    const point = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return { line: point.line + 1, column: point.character + 1 };
  });
  const references: SourceReference[] = [];
  const shadowed = (identifier: ts.Identifier): boolean => !!program.getTypeChecker().getSymbolAtLocation(identifier)?.declarations?.some((declaration) =>
    !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient));
  const literal = (node: ts.Node | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const add = (node: ts.Node, specifier: string | undefined, syntax: SourceReference["syntax"], typeOnly = false): void => {
    const point = source.getLineAndCharacterOfPosition(node.getStart(source));
    references.push({ ...(specifier === undefined ? {} : { specifier }), syntax,
      phase: typeOnly || source.isDeclarationFile ? "type" : "runtime", line: point.line + 1, column: point.character + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const onlyTypes = clause?.isTypeOnly || (!!clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier, literal(node.moduleSpecifier), "import", !!onlyTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier, literal(node.moduleSpecifier), "export", !!onlyTypes);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference, literal(node.moduleReference.expression), "import-equals", node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : undefined, "import-type", true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, literal(node.arguments[0]), "dynamic-import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const local = shadowed(node.expression);
        add(node, local ? undefined : literal(node.arguments[0]), local ? "shadowed-require" : "require");
      }
      else if (ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression;
        if (ts.isIdentifier(target.expression) && target.expression.text === "require" && target.name.text === "resolve") {
          const local = shadowed(target.expression);
          add(node, local ? undefined : literal(node.arguments[0]), local ? "shadowed-require" : "require-resolve");
        }
        else if (["glob", "globEager"].includes(target.name.text) && ts.isMetaProperty(target.expression) && target.expression.keywordToken === ts.SyntaxKind.ImportKeyword) add(node, undefined, "glob");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references, errors };
}
