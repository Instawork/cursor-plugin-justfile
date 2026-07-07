/** Granular usage rows counted as agent "turns" in panels and day totals. */
export const BILLABLE_TURN_EVENTS = new Set(["agentTurn", "cloudRun"]);

export function isBillableTurnEvent(event: unknown): boolean {
  return BILLABLE_TURN_EVENTS.has(String(event ?? ""));
}
