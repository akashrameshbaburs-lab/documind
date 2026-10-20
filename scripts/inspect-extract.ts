/**
 * Ad-hoc verification utility for the extraction + chunking stages.
 * Run: npx ts-node scripts/inspect-extract.ts
 * Prints page count and a short preview of the text extracted per page.
 */
import fs from "node:fs";
import path from "node:path";
import { extractDocument, kindFromExt } from "../src/ingest/extract";
import { chunkDocument } from "../src/ingest/chunk";

async function main(): Promise<void> {
  const files = ["eval/docs/world-facts.pdf", "eval/docs/field-notes.md"];
  for (const rel of files) {
    const abs = path.join(__dirname, "..", rel);
    const buffer = fs.readFileSync(abs);
    const ext = rel.slice(rel.lastIndexOf(".") + 1);
    const kind = kindFromExt(ext)!;
    const pages = await extractDocument(buffer, kind);
    const chunks = chunkDocument(pages);
    console.log(`\n=== ${rel} (${kind}) ===`);
    console.log(`pages=${pages.length} chunks=${chunks.length}`);
    pages.forEach((p) => {
      const preview = p.text.replace(/\s+/g, " ").slice(0, 110);
      console.log(`  p.${p.page} [${p.text.length} chars] ${preview}`);
    });
    const pageCounts = new Map<number, number>();
    chunks.forEach((c) => pageCounts.set(c.page, (pageCounts.get(c.page) ?? 0) + 1));
    console.log("  chunks per page:", [...pageCounts.entries()].sort((a, b) => a[0] - b[0]).map(([p, n]) => `p${p}:${n}`).join(" "));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
