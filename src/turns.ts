// Per-turn bookkeeping shared by the plugin's hooks and its context engine.
//
// OpenClaw may run one logical turn as several attempts (transient provider
// errors, overflow compaction). Each retry re-fires before_prompt_build with a
// synthetic "Continue the current task..." prompt and fires agent_end once per
// attempt. This state keeps three things stable across those attempts, keyed by
// runId (which a retry keeps):
//
//   * the user's original words — bound on the first attempt and never replaced,
//     so retrieval and ingest always use them, even when the first retrieval
//     failed and the retry has to retrieve again;
//   * the turn's recall block — retrieved once, reused by retries;
//   * which session has a turn in flight — the context engine must not rewrite
//     that session's transcript until the turn ends.
//
// One instance lives at process level (see index.ts): a retried attempt can be
// served by a freshly registered plugin instance.

const MAX = 200;

type Turn = { sessionKey?: string; user: string; block?: string };

/** Insert while keeping the map bounded: runs that end in failure never call end(). */
function capped<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.set(k, v);
  while (m.size > MAX) m.delete(m.keys().next().value!);
}

export class TurnState {
  private turns = new Map<string, Turn>();
  /** sessionKey -> runId of a turn that has started and not ended. */
  private inFlight = new Map<string, string>();

  /**
   * An attempt of `runId` starts with `prompt`. Returns the user's original
   * words for this turn (the first attempt's prompt) and the recall block if
   * an earlier attempt already retrieved one.
   */
  begin(runId: string, sessionKey: string | undefined, prompt: string): { user: string; block?: string } {
    let t = this.turns.get(runId);
    if (!t) {
      t = { sessionKey, user: prompt };
      capped(this.turns, runId, t);
    }
    if (sessionKey) capped(this.inFlight, sessionKey, runId);
    return { user: t.user, block: t.block };
  }

  /** Cache a successfully retrieved block ("" = nothing new to inject) for the rest of the turn. */
  remember(runId: string, block: string): void {
    const t = this.turns.get(runId);
    if (t) t.block = block;
  }

  /** The turn's original user words, if it began. */
  userOf(runId: string): string | undefined {
    return this.turns.get(runId)?.user;
  }

  /** The turn really ended (an attempt that answered): release everything. */
  end(runId: string, sessionKey?: string): void {
    const t = this.turns.get(runId);
    this.turns.delete(runId);
    const key = sessionKey ?? t?.sessionKey;
    if (key && this.inFlight.get(key) === runId) this.inFlight.delete(key);
  }

  isInFlight(sessionKey: string): boolean {
    return this.inFlight.has(sessionKey);
  }

  /** Run id of the session's turn in flight, if any. */
  inFlightRun(sessionKey: string): string | undefined {
    return this.inFlight.get(sessionKey);
  }
}

/**
 * agent_end fires once per ATTEMPT, and a failed attempt that OpenClaw is about
 * to retry still reports success:true — only its last assistant message says
 * stopReason "error". Only an attempt that really answered ends the turn.
 */
export function attemptAnswered(event: { success?: boolean; messages?: unknown }): boolean {
  if (!event?.success) return false;
  const messages: any[] = Array.isArray(event.messages) ? event.messages : [];
  const stop = [...messages].reverse().find((m) => m?.role === "assistant")?.stopReason;
  return stop !== "error" && stop !== "aborted";
}
