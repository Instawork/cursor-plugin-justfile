export interface InsertPromptResult {
  ok: true;
  text: string;
  line: number;
}

export interface InsertPromptError {
  ok: false;
  reason: string;
}

export type InsertPromptOutcome = InsertPromptResult | InsertPromptError;

const PROMPT_LINE = /^%% @prompt (.+?) -> (\S+)$/;
const HEADER = /^(flowchart|graph)\b/i;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

function parseMemberList(left: string): string[] {
  return left
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Default relative path for a new prompt binding. */
export function defaultPromptPath(nodeId: string): string {
  const slug = nodeId
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safe = slug.length > 0 ? slug : "step";
  return `steps/${safe}.md`;
}

/** Three-node starter workflow with matching %% @prompt directives. */
export function starterWorkflow(): string {
  return [
    "%% @prompt Triage -> steps/Triage.md",
    "%% @prompt Confirm -> steps/Confirm.md",
    "%% @prompt Done -> steps/Done.md",
    "flowchart TD",
    "Triage[Triage] --> Confirm[Confirm]",
    "Confirm --> Done[Done]",
    "",
  ].join("\n");
}

/**
 * Insert `%% @prompt nodeId -> relativePath` after the last existing prompt
 * directive, else immediately before the flowchart/graph header, else at the top.
 * Rejects duplicate nodeId (including as a member of a multi-id directive).
 */
export function insertPromptDirective(
  source: string,
  nodeId: string,
  relativePath: string,
): InsertPromptOutcome {
  const trimmedId = nodeId.trim();
  const trimmedPath = relativePath.trim();
  if (!trimmedId || !trimmedPath) {
    return { ok: false, reason: "nodeId and relativePath are required" };
  }
  if (/\s/.test(trimmedId) || /\s/.test(trimmedPath)) {
    return { ok: false, reason: "nodeId and relativePath must not contain whitespace" };
  }
  if (!NODE_ID.test(trimmedId)) {
    return { ok: false, reason: `invalid nodeId: ${trimmedId}` };
  }

  const lines = source.split(/\r?\n/);
  let lastPromptIndex = -1;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("%% @prompt")) {
      const match = PROMPT_LINE.exec(line);
      if (match) {
        const members = parseMemberList(match[1]);
        if (members.includes(trimmedId)) {
          return { ok: false, reason: `duplicate prompt binding for ${trimmedId}` };
        }
      }
      lastPromptIndex = i;
    }
    if (headerIndex < 0 && HEADER.test(line.trim())) {
      headerIndex = i;
    }
  }

  const directive = `%% @prompt ${trimmedId} -> ${trimmedPath}`;
  let insertAt: number;
  if (lastPromptIndex >= 0) {
    insertAt = lastPromptIndex + 1;
  } else if (headerIndex >= 0) {
    insertAt = headerIndex;
  } else if (source.trim().length === 0) {
    lines.length = 0;
    lines.push(directive, "flowchart TD");
    return {
      ok: true,
      text: lines.join("\n") + (source.endsWith("\n") || source.length === 0 ? "\n" : ""),
      line: 1,
    };
  } else {
    insertAt = 0;
  }

  lines.splice(insertAt, 0, directive);
  const text = lines.join("\n");
  return { ok: true, text, line: insertAt + 1 };
}

/** Insert many prompt directives. Rejects if any nodeId is already bound. */
export function insertPromptDirectives(
  source: string,
  bindings: { nodeId: string; relativePath: string }[],
): InsertPromptOutcome {
  let text = source;
  let line = 0;
  for (const binding of bindings) {
    const outcome = insertPromptDirective(text, binding.nodeId, binding.relativePath);
    if (!outcome.ok) {
      return outcome;
    }
    text = outcome.text;
    line = outcome.line;
  }
  return { ok: true, text, line };
}
