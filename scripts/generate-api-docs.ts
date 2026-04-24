#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

/**
 * Generates `API.md` at the repo root from `deno doc --json` output across
 * all package entrypoints listed in `deno.json`.
 *
 * Output must be deterministic: no absolute paths, no timestamps, symbols
 * sorted alphabetically within each entrypoint, entrypoints rendered in
 * the order declared in deno.json.
 */

type JsDocTag = {
  kind: string;
  name?: string;
  doc?: string;
  type?: string;
};

type JsDoc = {
  doc?: string;
  tags?: JsDocTag[];
};

type TsType = {
  repr?: string;
  kind?: string;
  value?: unknown;
};

type Param = {
  kind: string;
  name?: string;
  optional?: boolean;
  tsType?: TsType;
};

type Property = {
  name: string;
  optional?: boolean;
  readonly?: boolean;
  tsType?: TsType;
};

type Method = {
  name: string;
  params?: Param[];
  returnType?: TsType;
};

type Declaration = {
  declarationKind: "export" | "private";
  jsDoc?: JsDoc;
  kind: string;
  // deno-lint-ignore no-explicit-any
  def: any;
};

type DocSymbol = {
  name: string;
  declarations: Declaration[];
};

type FileNode = {
  module_doc?: JsDoc;
  symbols: DocSymbol[];
};

type DocRoot = {
  version: number;
  nodes: Record<string, FileNode>;
};

function renderType(t: TsType | undefined): string {
  if (!t) return "unknown";

  // Composite shapes need to be walked before falling back to `repr`, because
  // deno doc leaves `repr` empty for unions/arrays/etc. and the bare `repr`
  // of a literal child strips the quotes/suffix we need.
  if (t.kind === "union" && Array.isArray(t.value)) {
    return (t.value as TsType[]).map(renderType).join(" | ");
  }
  if (t.kind === "intersection" && Array.isArray(t.value)) {
    return (t.value as TsType[]).map(renderType).join(" & ");
  }
  if (t.kind === "array" && t.value) {
    return `${renderType(t.value as TsType)}[]`;
  }
  if (t.kind === "tuple" && Array.isArray(t.value)) {
    return `[${(t.value as TsType[]).map(renderType).join(", ")}]`;
  }
  if (t.kind === "literal" && t.value && typeof t.value === "object") {
    const lit = t.value as { kind?: string; string?: string; number?: number; boolean?: boolean; bigInt?: string };
    if (lit.kind === "string" && typeof lit.string === "string") return JSON.stringify(lit.string);
    if (lit.kind === "number" && typeof lit.number === "number") return String(lit.number);
    if (lit.kind === "boolean" && typeof lit.boolean === "boolean") return String(lit.boolean);
    if (lit.kind === "bigInt" && typeof lit.bigInt === "string") return `${lit.bigInt}n`;
  }
  if (t.kind === "typeRef" && t.value && typeof t.value === "object") {
    const ref = t.value as { typeName?: string; typeParams?: TsType[] };
    const name = ref.typeName ?? t.repr ?? "unknown";
    if (ref.typeParams && ref.typeParams.length > 0) {
      return `${name}<${ref.typeParams.map(renderType).join(", ")}>`;
    }
    return name;
  }

  if (t.repr && t.repr !== "") return t.repr;
  return t.kind ?? "unknown";
}

function renderParam(p: Param): string {
  const name = p.name ?? "_";
  const opt = p.optional ? "?" : "";
  return `${name}${opt}: ${renderType(p.tsType)}`;
}

// deno-lint-ignore no-explicit-any
function renderFunctionSig(name: string, def: any): string {
  const params = (def.params ?? []).map(renderParam).join(", ");
  const ret = renderType(def.returnType);
  return `${name}(${params}): ${ret}`;
}

function tagsOfKind(jsDoc: JsDoc | undefined, kind: string): JsDocTag[] {
  return (jsDoc?.tags ?? []).filter((t) => t.kind === kind);
}

function renderFunction(name: string, decl: Declaration): string {
  const lines: string[] = [];
  lines.push(`### \`${renderFunctionSig(name, decl.def)}\``);
  lines.push("");

  if (decl.jsDoc?.doc) {
    lines.push(decl.jsDoc.doc.trim());
    lines.push("");
  }

  const paramTags = tagsOfKind(decl.jsDoc, "param");
  if (paramTags.length > 0) {
    lines.push("**Parameters**");
    lines.push("");
    for (const tag of paramTags) {
      const pname = tag.name ?? "";
      const pdoc = (tag.doc ?? "").trim();
      lines.push(`- \`${pname}\`${pdoc ? ` — ${pdoc}` : ""}`);
    }
    lines.push("");
  }

  const returnTags = [
    ...tagsOfKind(decl.jsDoc, "return"),
    ...tagsOfKind(decl.jsDoc, "returns"),
  ];
  if (returnTags.length > 0 && returnTags[0].doc) {
    lines.push(`**Returns** — ${returnTags[0].doc.trim()}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderTypeAlias(name: string, decl: Declaration): string {
  const lines: string[] = [];
  lines.push(`### \`${name}\``);
  lines.push("");
  if (decl.jsDoc?.doc) {
    lines.push(decl.jsDoc.doc.trim());
    lines.push("");
  }
  lines.push("```ts");
  lines.push(`type ${name} = ${renderType(decl.def.tsType)};`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function renderInterface(name: string, decl: Declaration): string {
  const lines: string[] = [];
  lines.push(`### \`${name}\``);
  lines.push("");
  if (decl.jsDoc?.doc) {
    lines.push(decl.jsDoc.doc.trim());
    lines.push("");
  }
  lines.push("```ts");
  lines.push(`interface ${name} {`);
  const props: Property[] = decl.def.properties ?? [];
  for (const p of props) {
    const opt = p.optional ? "?" : "";
    const ro = p.readonly ? "readonly " : "";
    lines.push(`  ${ro}${p.name}${opt}: ${renderType(p.tsType)};`);
  }
  const methods: Method[] = decl.def.methods ?? [];
  for (const m of methods) {
    const params = (m.params ?? []).map(renderParam).join(", ");
    lines.push(`  ${m.name}(${params}): ${renderType(m.returnType)};`);
  }
  lines.push("}");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function renderVariable(name: string, decl: Declaration): string {
  const lines: string[] = [];
  lines.push(`### \`${name}\``);
  lines.push("");
  if (decl.jsDoc?.doc) {
    lines.push(decl.jsDoc.doc.trim());
    lines.push("");
  }
  const kind = decl.def.kind ?? "const";
  lines.push("```ts");
  lines.push(`${kind} ${name}: ${renderType(decl.def.tsType)};`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function renderSymbol(sym: DocSymbol): string {
  const exportedDecls = sym.declarations.filter(
    (d) => d.declarationKind === "export",
  );
  if (exportedDecls.length === 0) return "";

  const parts: string[] = [];
  for (const decl of exportedDecls) {
    switch (decl.kind) {
      case "function":
        parts.push(renderFunction(sym.name, decl));
        break;
      case "typeAlias":
        parts.push(renderTypeAlias(sym.name, decl));
        break;
      case "interface":
        parts.push(renderInterface(sym.name, decl));
        break;
      case "variable":
        parts.push(renderVariable(sym.name, decl));
        break;
      default:
        parts.push(
          `### \`${sym.name}\`\n\n_(${decl.kind} — see source)_\n`,
        );
    }
  }
  return parts.join("\n");
}

async function runDenoDoc(file: string): Promise<DocRoot> {
  const cmd = new Deno.Command("deno", {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    throw new Error(`deno doc ${file} failed with exit code ${code}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}

async function main(): Promise<void> {
  const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as {
    name: string;
    exports: Record<string, string>;
  };
  const pkgName = denoJson.name;

  const sections: string[] = [];
  sections.push(`# \`${pkgName}\` API Reference`);
  sections.push("");
  sections.push(
    `_Generated from source by \`scripts/generate-api-docs.ts\` — do not edit by hand. Browsable version on [JSR](https://jsr.io/${pkgName}/doc/all_symbols)._`,
  );
  sections.push("");

  for (const [exportPath, file] of Object.entries(denoJson.exports)) {
    const entryName = `${pkgName}${exportPath.slice(1)}`;
    const root = await runDenoDoc(file);
    const fileNode = Object.values(root.nodes)[0];
    if (!fileNode) continue;

    sections.push(`## \`${entryName}\``);
    sections.push("");
    if (fileNode.module_doc?.doc) {
      sections.push(fileNode.module_doc.doc.trim());
      sections.push("");
    }

    const exported = (fileNode.symbols ?? [])
      .filter((s) =>
        s.declarations.some((d) => d.declarationKind === "export")
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const sym of exported) {
      const rendered = renderSymbol(sym);
      if (rendered.trim()) sections.push(rendered);
    }
  }

  const out = sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  await Deno.writeTextFile("API.md", out);
  console.error(`Wrote API.md (${out.length} bytes)`);
}

await main();
