import type { RetrievalHit } from "../retrieval/search";
import { tokenize } from "../text";

export interface Citation {
  fileId: string;
  fileName: string;
  page: number;
  snippet: string;
  score: number;
}

const MAX_CITATIONS = 5;
const SNIPPET_LEN = 240;

/** Split a chunk into candidate sentences (keeps original casing/punctuation). */
function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/) // paragraph breaks first (chapter headings become their own segment)
    .flatMap((seg) => seg.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
    .map((s) =>
      s
        .trim()
        // Strip markdown decorations so bullet points/headings read as plain prose.
        .replace(/^[#>\-*+\s]+/, "")
        .trim()
    )
    .filter((s) => s.length >= 30 && s.length <= 500);
}

export function toCitations(hits: RetrievalHit[]): Citation[] {
  return hits.slice(0, MAX_CITATIONS).map((h) => ({
    fileId: h.docId,
    fileName: h.fileName,
    page: h.page,
    snippet: h.content.length > SNIPPET_LEN ? `${h.content.slice(0, SNIPPET_LEN).trimEnd()}…` : h.content,
    score: Number(h.fused.toFixed(4)),
  }));
}

/**
 * Extractive answer builder (offline mode).
 *
 * Passages are quoted verbatim from the highest-ranked retrieved chunks.
 * Sentences are scored by query-token overlap (Jaccard-ish coverage) plus a
 * small bonus for coming from a highly-ranked chunk; the top sentences are
 * then emitted in document order (file, page, chunk) so the answer reads
 * naturally, each followed by a `[source: file, p.N]` citation marker.
 */
export function buildExtractiveAnswer(question: string, hits: RetrievalHit[]): { answer: string; citations: Citation[] } {
  const citations = toCitations(hits);
  if (hits.length === 0) {
    return {
      answer:
        "I could not find any relevant passages in this document set. Try re-phrasing the question, or upload documents that cover the topic.",
      citations: [],
    };
  }

  const qTokens = new Set(tokenize(question));
  const candidates: Array<{ text: string; hit: RetrievalHit; score: number }> = [];

  for (const h of hits.slice(0, 3)) {
    const segs = sentences(h.content);
    segs.forEach((s, si) => {
      // The first segment of a chunk can be an overlap fragment starting
      // mid-sentence; those never make good answer material.
      if (si === 0 && /^[a-z]/.test(s)) return;
      const sTokens = new Set(tokenize(s));
      let overlap = 0;
      for (const t of qTokens) if (sTokens.has(t)) overlap++;
      const coverage = qTokens.size > 0 ? overlap / qTokens.size : 0;
      // Scoring (not gating) handles relevance: sentences with more shared
      // tokens win, but single-token matches can still carry gold facts.
      const rankBonus = (hits.length - h.rank) * 0.03;
      const lengthPenalty = s.length > 320 ? 0.08 : 0;
      const score = coverage + rankBonus - lengthPenalty;
      if (overlap > 0) candidates.push({ text: s, hit: h, score });
    });
  }

  // Deduplicate near-identical sentences, take the best few in relevance order.
  const seen = new Set<string>();
  const picked = candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const key = c.text.slice(0, 80).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  if (picked.length === 0) {
    // Fallback: open with the top chunk's first sentences even without overlap.
    for (const h of hits.slice(0, 2)) {
      for (const s of sentences(h.content).slice(0, 1)) {
        picked.push({ text: s, hit: h, score: 0 });
      }
    }
  }

  const lines = picked.map((p) => `- ${p.text} [source: ${p.hit.fileName}, p.${p.hit.page}]`);
  const answer = ["Based on the most relevant passages in your documents:", "", ...lines].join("\n");
  return { answer, citations };
}
