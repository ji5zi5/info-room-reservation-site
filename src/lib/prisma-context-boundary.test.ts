import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type PrismaBypassKind = "model" | "raw" | "transaction";

type PrismaBypass = {
  readonly file: string;
  readonly kind: PrismaBypassKind;
  readonly line: number;
  readonly snippet: string;
};

type PrismaImportBindings = {
  readonly namespaces: ReadonlySet<string>;
  readonly named: ReadonlySet<string>;
};

type PrismaCallRoot = {
  readonly member: string | undefined;
};

function findPrismaBypasses(file: string, source: string): readonly PrismaBypass[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const bindings = prismaImportBindings(sourceFile);
  const findings: PrismaBypass[] = [];

  const report = (node: ts.Node, kind: PrismaBypassKind): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: file.replaceAll("\\", "/"),
      kind,
      line: position.line + 1,
      snippet: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180)
    });
  };

  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = prismaCallRoot(node.expression, bindings);
      if (root?.member === "$transaction") {
        report(node, "transaction");
      } else if (root?.member === "$queryRaw" || root?.member === "$executeRaw") {
        report(node, "raw");
      } else if (root?.member !== undefined && !root.member.startsWith("$")) {
        report(node, "model");
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const root = prismaCallRoot(node.tag, bindings);
      if (
        (root?.member === "$queryRaw" || root?.member === "$executeRaw") &&
        !isApprovedReadinessProbe(file, node, root.member)
      ) {
        report(node, "raw");
      }
    }

    ts.forEachChild(node, inspect);
  };

  inspect(sourceFile);
  return findings;
}

function productionSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated" && entry.name !== "__tests__") {
        files.push(...productionSourceFiles(path));
      }
    } else if (entry.isFile() && isProductionSourceFile(path)) {
      files.push(path);
    }
  }
  return files;
}

function prismaImportBindings(sourceFile: ts.SourceFile): PrismaImportBindings {
  const named = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!isPrismaClientModule(statement.moduleSpecifier.text) || statement.importClause === undefined) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === "prisma") {
        named.add(element.name.text);
      }
    }
  }

  return { named, namespaces };
}

function isPrismaClientModule(moduleSpecifier: string): boolean {
  return moduleSpecifier === "./db" || moduleSpecifier.endsWith("/db");
}

function prismaCallRoot(
  expression: ts.Expression,
  bindings: PrismaImportBindings
): PrismaCallRoot | undefined {
  const members: string[] = [];
  let current = expression;

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    members.unshift(accessMemberName(current));
    current = current.expression;
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }
  if (bindings.named.has(current.text)) {
    return { member: members.at(0) };
  }
  if (bindings.namespaces.has(current.text) && members.at(0) === "prisma") {
    return { member: members.at(1) };
  }
  return undefined;
}

function accessMemberName(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string {
  if (ts.isPropertyAccessExpression(access)) {
    return access.name.text;
  }
  return ts.isStringLiteral(access.argumentExpression) ? access.argumentExpression.text : "[computed]";
}

function isProductionSourceFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    (filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
    !filename.endsWith(".d.ts") &&
    !filename.includes(".test.") &&
    !filename.includes(".spec.") &&
    !filename.includes("-test-") &&
    !normalized.includes("/generated/")
  );
}

function isApprovedReadinessProbe(
  file: string,
  node: ts.TaggedTemplateExpression,
  member: "$executeRaw" | "$queryRaw"
): boolean {
  // This read-only, substitution-free readiness probe establishes connectivity without actor data.
  return (
    file.replaceAll("\\", "/") === "src/lib/prisma-readiness.ts" &&
    member === "$queryRaw" &&
    ts.isNoSubstitutionTemplateLiteral(node.template) &&
    node.template.text.trim().replace(/\s+/g, " ") === "SELECT 1"
  );
}

describe("Prisma context boundary", () => {
  it("detects formatted global Prisma model, transaction, and raw calls while allowing contextual clients", () => {
    const findings = findPrismaBypasses(
      "src/lib/synthetic.ts",
      [
        'import { prisma as primary } from "./db";',
        "async function use(transaction: { readonly user: { readonly findMany: () => Promise<void> } }) {",
        "  await primary",
        "    .user",
        "    .findMany();",
        "  await primary",
        "    .$transaction(async () => undefined);",
        "  await primary",
        "    .$queryRaw`SELECT 1`;",
        "  await transaction.user.findMany();",
        "  await withDatabaseContext({ client: primary });",
        "}"
      ].join("\n")
    );

    expect(findings.map((finding) => finding.kind)).toEqual(["model", "transaction", "raw"]);
    expect(
      findings.every(
        (finding) =>
          finding.file === "src/lib/synthetic.ts" && finding.line > 0 && finding.snippet.length > 0
      )
    ).toBe(true);
  });

  it("has no production Prisma calls outside the context boundary", () => {
    const sourceRoot = resolve(process.cwd(), "src");
    const findings = productionSourceFiles(sourceRoot).flatMap((file) =>
      findPrismaBypasses(relative(process.cwd(), file), readFileSync(file, "utf8"))
    );

    expect(findings).toEqual([]);
  });
});
