const CLAUDE_CODE_BETA = "claude-code-20250219";

function isClaudeCodeCaller(clientHeaders?: Record<string, string> | null): boolean {
  return Object.entries(clientHeaders || {}).some(([name, value]) => {
    switch (name.toLowerCase()) {
      case "x-app":
        return value.trim().toLowerCase() === "cli";
      case "user-agent":
        return /claude-(?:cli|code)/i.test(value);
      case "anthropic-beta":
        return value.split(",").some((token) => token.trim().toLowerCase() === CLAUDE_CODE_BETA);
      default:
        return false;
    }
  });
}

/** Keep ordinary API traffic from inheriting the registry's Claude Code identity. */
export function normalizeAnthropicApiIdentity(
  headers: Record<string, string>,
  clientHeaders?: Record<string, string> | null
): void {
  // Genuine Claude Code requests must retain their identity and billing eligibility.
  if (isClaudeCodeCaller(clientHeaders)) return;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "anthropic-beta") continue;
    headers[name] = value
      .split(",")
      .filter((token) => token.trim().toLowerCase() !== CLAUDE_CODE_BETA)
      .join(",");
  }
}
