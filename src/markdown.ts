import cliMarkdown from "cli-markdown";

const MIN_SANE_WIDTH = 40;
const FALLBACK_WIDTH = 100;
const FALLBACK_HEIGHT = 40;

/**
 * Renders markdown text to ANSI-styled terminal output.
 * Falls back to raw text if rendering fails for any reason
 * (e.g. malformed partial markdown mid-stream).
 *
 * cli-markdown determines wrap width via the `terminal-size` package, which
 * only trusts `process.stdout.columns`/`.rows` when *both* are truthy — if
 * either is 0/undefined (some CI environments, unusual terminal setups,
 * certain multiplexer edge cases), it falls through to other detection
 * methods (/dev/tty, tput, resize) that can be unreliable or return
 * degenerate values, producing output where nearly every word ends up on
 * its own line. We defend against that by temporarily forcing sane
 * dimensions for the duration of the render call, then restoring the real
 * values afterward.
 */
export function renderMarkdown(text: string): string {
  if (!text.trim()) return text;

  const realColumns = process.stdout.columns;
  const realRows = process.stdout.rows;
  const needsOverride = !realColumns || !realRows || realColumns < MIN_SANE_WIDTH;
  if (needsOverride) {
    (process.stdout as any).columns = FALLBACK_WIDTH;
    (process.stdout as any).rows = FALLBACK_HEIGHT;
  }

  try {
    const rendered = cliMarkdown(text);
    // cli-markdown adds a leading/trailing blank line; trim just the outer edges
    return rendered.replace(/^\n+/, "").replace(/\n+$/, "\n");
  } catch {
    return text;
  } finally {
    if (needsOverride) {
      (process.stdout as any).columns = realColumns;
      (process.stdout as any).rows = realRows;
    }
  }
}
