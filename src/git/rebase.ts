// Interactive rebase plan: the todo list for GIT_SEQUENCE_EDITOR and the queue of messages for
// GIT_EDITOR, in the order git opens the editor. Pure.
import type { RebaseAction } from './protocol';

export interface Step { hash: string; action: RebaseAction; message?: string }

const ACTIONS = new Set<string>(['pick', 'reword', 'squash', 'fixup', 'drop']);

/**
 * git opens the editor once per reword, and once at the end of each pick-chain that contains a
 * squash (fixup alone never opens it). null keeps git's default text.
 */
export function rebasePlan(steps: Step[]): { todo: string; messages: (string | null)[] } {
  const todo = steps.map((s) => {
    if (!ACTIONS.has(s.action) || !/^[0-9a-f]{4,64}$/i.test(s.hash)) throw new Error('Invalid rebase step');
    return `${s.action} ${s.hash}`;
  }).join('\n') + '\n';

  const kept = steps.filter((s) => s.action !== 'drop');
  if (kept[0] && (kept[0].action === 'squash' || kept[0].action === 'fixup')) {
    throw new Error('The first commit kept can’t be squash or fixup.');
  }
  const messages: (string | null)[] = [];
  let chain: string | null | undefined; // undefined = this chain has no squash yet
  kept.forEach((s, i) => {
    if (s.action === 'reword') messages.push(s.message?.trim() || null);
    if (s.action === 'squash') chain = s.message?.trim() || chain || null;
    const next = kept[i + 1];
    if (!next || (next.action !== 'squash' && next.action !== 'fixup')) {
      if (chain !== undefined) messages.push(chain);
      chain = undefined;
    }
  });
  return { todo, messages };
}
