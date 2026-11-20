// Runs as GIT_EDITOR / GIT_SEQUENCE_EDITOR, under VS Code's own runtime (ELECTRON_RUN_AS_NODE=1),
// so a rebase or commit that would open an editor never hangs waiting for one.
//   node editor.js <queue.json> <file git wants edited>
// queue.json holds an array of texts. Each call takes the first one and writes it over the file.
// A null entry, or an empty queue, leaves the file alone, which keeps git's default message.
import { readFileSync, writeFileSync } from 'fs';

const [queuePath, target] = process.argv.slice(2);
try {
  const queue: (string | null)[] = queuePath ? JSON.parse(readFileSync(queuePath, 'utf8')) : [];
  if (queue.length && target) {
    const next = queue.shift();
    writeFileSync(queuePath, JSON.stringify(queue));
    if (typeof next === 'string') writeFileSync(target, next.endsWith('\n') ? next : next + '\n');
  }
} catch (e) {
  // A broken queue must not block git: keep its default text
  process.stderr.write(`darkmark editor: ${(e as Error).message}\n`);
}
