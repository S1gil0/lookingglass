/** Commands whose bare form opens a setting selector in the interactive TUI. */
export type ActiveSelectorCommandName = "model" | "agentmodel" | "reasoning" | "agentreasoning";

export interface ActiveSelectorCommand {
  readonly name: ActiveSelectorCommandName;
}

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
}

export interface SelectorPresentationSlot {
  readonly wait: Promise<void>;
  readonly release: () => void;
}

/** Preserve picker presentation order while catalog requests load concurrently. */
export class SelectorPresentationQueue {
  private tail = Promise.resolve();

  reserve(): SelectorPresentationSlot {
    const wait = this.tail;
    let released = false;
    let resolveSlot!: () => void;
    this.tail = new Promise<void>((resolve) => {
      resolveSlot = resolve;
    });
    return {
      wait,
      release: (): void => {
        if (released) return;
        released = true;
        // A request can finish (or be cancelled) before its predecessor has
        // reached the presentation point. Resolve this reservation only after
        // that predecessor, so an early later release cannot skip the FIFO
        // presentation order. The rejection branch keeps a malformed queue
        // tail from stranding every reservation behind it.
        void wait.then(resolveSlot, resolveSlot);
      },
    };
  }
}

/**
 * Recognize only the bare selector commands eligible for an active-turn
 * preflight. Explicit arguments must continue through the normal queue path.
 */
export function detectActiveSelectorCommand(input: string): ActiveSelectorCommand | null {
  const match = /^\/(model|agentmodel|reasoning|agentreasoning)\s*$/iu.exec(input.trim());
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase() as ActiveSelectorCommandName };
}

/** Expand a captured picker value into the explicit command applied at dequeue. */
export function expandActiveSelectorCommand(command: ActiveSelectorCommand, value: string): string {
  const selected = value.trim();
  if (!selected) throw new Error("A selector value is required");
  return `/${command.name} ${selected}`;
}

/**
 * Resolve a model selector value by preferring a complete provider:id key,
 * then an exact id from the current provider. The latter may itself contain
 * colons (for example, an OpenRouter model id ending in :free).
 */
export function findModelChoice<T extends ModelChoice>(
  models: readonly T[],
  choice: string,
  bareProvider: string,
): T | undefined {
  const selected = choice.trim();
  return models.find((model) => `${model.provider}:${model.id}` === selected)
    ?? models.find((model) => model.provider === bareProvider && model.id === selected);
}