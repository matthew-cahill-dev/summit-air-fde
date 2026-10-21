// Zod schema → the JSON schema shape Vapi accepts for a function tool's parameters.
// Vapi rejects non-string enums (HTTP 400 "each value in enum must be a string"), so a
// literal like z.literal(true) is emitted as a plain {"type":"boolean"}. The server's
// Zod schema still enforces the literal; the tool description tells the model the rule.
// Keep this file free of path aliases: it is also compiled for the sync script.
import { z } from "zod";

export type JsonSchemaNode = {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  const?: unknown;
  [key: string]: unknown;
};

const jsonType = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

function toVapiNode(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = { ...node };
  delete out.$schema;
  const literals = out.enum ?? ("const" in out ? [out.const] : undefined);
  if (literals && literals.some((v) => typeof v !== "string")) {
    out.type ??= jsonType(literals[0]);
    delete out.enum;
    delete out.const;
  } else if ("const" in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, toVapiNode(v)]));
  }
  if (out.items) out.items = toVapiNode(out.items);
  return out;
}

export function vapiParameters(schema: z.ZodType): JsonSchemaNode {
  return toVapiNode(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchemaNode);
}

/** Any enum/const value Vapi would reject, as "path: value" strings. */
export function nonStringEnumPaths(node: JsonSchemaNode, path = "parameters"): string[] {
  const bad = [...(node.enum ?? []), ...("const" in node ? [node.const] : [])]
    .filter((v) => typeof v !== "string")
    .map((v) => `${path}: ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(node.properties ?? {})) bad.push(...nonStringEnumPaths(v, `${path}.${k}`));
  if (node.items) bad.push(...nonStringEnumPaths(node.items, `${path}[]`));
  return bad;
}
