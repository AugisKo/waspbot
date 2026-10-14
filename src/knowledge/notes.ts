// The owner's own notes: every .md or .txt file in the notes folder (NOTES_DIR, default data/notes) is read and handed
// to the model with each decision, after the wasp's strategy. Use it for rules of thumb, research, things to avoid.
// Capped (NOTES_MAX_CHARS, default 4000) so a long file cannot blow the token budget. The code chooser never reads it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export class OwnerNotes {
  private cache = "";
  private sig = "";

  constructor(private o: { dir: string; maxChars: number }) {}

  /** The notes as one block of text ("" when there are none). Re-read only when a file changed. */
  text(): string {
    if (!existsSync(this.o.dir)) return "";
    let files: string[];
    try {
      files = readdirSync(this.o.dir)
        .filter((f) => /\.(md|txt)$/i.test(f) && !f.startsWith("."))
        .sort();
    } catch {
      return this.cache;
    }
    const sig = files.map((f) => `${f}:${statSync(join(this.o.dir, f)).mtimeMs}`).join("|");
    if (sig === this.sig) return this.cache;
    this.sig = sig;
    const parts: string[] = [];
    for (const f of files) {
      try {
        parts.push(`## ${f}\n${readFileSync(join(this.o.dir, f), "utf8").trim()}`);
      } catch {
        /* unreadable file: skip */
      }
    }
    const all = parts.join("\n\n");
    this.cache = all.length > this.o.maxChars ? `${all.slice(0, this.o.maxChars)}\n[notes truncated at ${this.o.maxChars} characters]` : all;
    return this.cache;
  }
}
