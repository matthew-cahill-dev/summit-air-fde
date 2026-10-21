// Readable diffs between desired config and what Vapi currently has.
// Keep this file free of path aliases: it is compiled for scripts/sync-vapi.ts.

export type Change = { path: string; before: unknown; after: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Changes needed to make `current` match `desired`, comparing only what
 * `desired` specifies (Vapi adds ids, timestamps and defaults we don't manage).
 */
export function diffSubset(current: unknown, desired: unknown, path = ""): Change[] {
  if (isObj(desired)) {
    if (!isObj(current)) return [{ path: path || "(root)", before: current, after: desired }];
    return Object.keys(desired).flatMap((k) => diffSubset(current[k], desired[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length) return [{ path, before: current, after: desired }];
    const inner = desired.flatMap((d, i) => diffSubset(current[i], d, `${path}[${i}]`));
    return inner;
  }
  return Object.is(current, desired) ? [] : [{ path, before: current, after: desired }];
}

/** Minimal unified line diff (LCS), with `context` unchanged lines around each change. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i++] });
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      ops.push({ op: "+", line: b[j++] });
    } else {
      ops.push({ op: "-", line: a[i++] });
    }
  }
  const keep = ops.map((o, idx) => o.op !== " " || ops.slice(Math.max(0, idx - context), idx + context + 1).some((n) => n.op !== " "));
  const out: string[] = [];
  ops.forEach((o, idx) => {
    if (keep[idx]) out.push(`${o.op} ${o.line}`);
    else if (idx === 0 || keep[idx - 1]) out.push("  ..."); // one marker per skipped run
  });
  return out.join("\n");
}

function show(v: unknown): string {
  if (v === undefined) return "(unset)";
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

export function formatChanges(changes: Change[], indent = "    "): string {
  return changes
    .map((c) => {
      if (typeof c.before === "string" && typeof c.after === "string" && (c.before.includes("\n") || c.after.includes("\n"))) {
        return `${indent}~ ${c.path}:\n${lineDiff(c.before, c.after)
          .split("\n")
          .map((l) => `${indent}    ${l}`)
          .join("\n")}`;
      }
      return `${indent}~ ${c.path}: ${show(c.before)} -> ${show(c.after)}`;
    })
    .join("\n");
}
