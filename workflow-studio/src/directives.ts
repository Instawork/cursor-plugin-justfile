export interface PromptBinding {
  nodeId: string;
  memberNodeIds: string[];
  relativePath: string;
  line: number;
}

export interface DirectiveParseResult {
  bindings: PromptBinding[];
  errors: string[];
}

const DIRECTIVE = /^%% @prompt (.+?) -> (\S+)$/;
const NODE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parsePromptDirectives(source: string): DirectiveParseResult {
  const bindings: PromptBinding[] = [];
  const errors: string[] = [];
  const claimed = new Set<string>();

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.startsWith("%% @prompt")) {
      continue;
    }
    const match = DIRECTIVE.exec(line);
    if (!match) {
      errors.push(`Line ${index + 1}: expected %% @prompt NodeId[, NodeId...] -> relative/path.md`);
      continue;
    }
    const relativePath = match[2];
    const members = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (members.length === 0) {
      errors.push(`Line ${index + 1}: expected at least one node id before ->`);
      continue;
    }

    const invalid = members.filter((id) => !NODE_ID.test(id));
    if (invalid.length > 0) {
      errors.push(
        `Line ${index + 1}: invalid node id(s): ${invalid.join(", ")}`,
      );
      continue;
    }

    const duplicatesInLine = members.filter((id, i) => members.indexOf(id) !== i);
    if (duplicatesInLine.length > 0) {
      errors.push(
        `Line ${index + 1}: duplicate node id(s) in list: ${[...new Set(duplicatesInLine)].join(", ")}`,
      );
      continue;
    }

    const alreadyClaimed = members.filter((id) => claimed.has(id));
    if (alreadyClaimed.length > 0) {
      errors.push(
        `Line ${index + 1}: duplicate prompt binding for ${alreadyClaimed.join(", ")}`,
      );
      continue;
    }

    for (const id of members) {
      claimed.add(id);
    }

    bindings.push({
      nodeId: members[0],
      memberNodeIds: members,
      relativePath,
      line: index + 1,
    });
  }

  return { bindings, errors };
}

export function findBindingForNode(
  bindings: PromptBinding[],
  nodeId: string,
): PromptBinding | undefined {
  return bindings.find(
    (binding) =>
      binding.nodeId === nodeId || binding.memberNodeIds.includes(nodeId),
  );
}
