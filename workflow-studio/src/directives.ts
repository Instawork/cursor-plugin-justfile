export interface PromptBinding {
  nodeId: string;
  relativePath: string;
  line: number;
}

export interface DirectiveParseResult {
  bindings: PromptBinding[];
  errors: string[];
}

const DIRECTIVE = /^%% @prompt (\S+) -> (\S+)$/;

export function parsePromptDirectives(source: string): DirectiveParseResult {
  const bindings: PromptBinding[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.startsWith("%% @prompt")) {
      continue;
    }
    const match = DIRECTIVE.exec(line);
    if (!match) {
      errors.push(`Line ${index + 1}: expected %% @prompt NodeId -> relative/path.md`);
      continue;
    }
    const nodeId = match[1];
    const relativePath = match[2];
    if (seen.has(nodeId)) {
      errors.push(`Line ${index + 1}: duplicate prompt binding for ${nodeId}`);
      continue;
    }
    seen.add(nodeId);
    bindings.push({ nodeId, relativePath, line: index + 1 });
  }

  return { bindings, errors };
}
