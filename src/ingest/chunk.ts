import type { ExtractedPage } from "./extract";

/** Chunking parameters (documented in README + docs/ARCHITECTURE.md). */
export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 200;

/**
 * For txt/md/docx there is no fixed page geometry, so we approximate pages:
 * every LINES_PER_PAGE lines count as one page. PDFs use their real pages.
 */
export const LINES_PER_PAGE = 50;

export interface RawChunk {
  content: string;
  page: number;
  idx: number;
}

/** Split a string into cumulative line start offsets (for line/page lookup). */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Binary search: 0-based line index that contains character position `pos`. */
function lineIndexAt(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Greedy sliding-window chunker over one text region.
 *
 *  - window of CHUNK_SIZE chars, advanced by CHUNK_SIZE - CHUNK_OVERLAP
 *  - the right edge snaps backwards to a paragraph break ("\n\n") within 120
 *    chars when possible, else to a word boundary, for readable chunks
 *  - each chunk is attributed to the page of its first character, where
 *    pageOf() gives the page for a character offset (real PDF page, or the
 *    lines-per-page approximation for txt/md/docx)
 */
function slideWindow(text: string, pageOf: (startPos: number) => number, startIdx: number): RawChunk[] {
  const chunks: RawChunk[] = [];
  if (text.trim().length === 0) return chunks;

  let start = 0;
  let idx = startIdx;
  const step = Math.max(CHUNK_SIZE - CHUNK_OVERLAP, 100);

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      // Snap the cut, in priority order, to the nearest suitable boundary
      // within 120 chars backwards: paragraph break, then sentence end, then
      // word boundary. Sentence snapping keeps gold sentences intact so the
      // extractive answer stage can quote them whole.
      const floor = end - 120;
      const para = text.lastIndexOf("\n\n", end);
      let sentence = -1;
      for (let p = end; p > Math.max(floor, start); p--) {
        if (/[.!?]/.test(text[p - 1]) && /\s/.test(text[p])) {
          sentence = p;
          break;
        }
      }
      if (para > floor && para > start) {
        end = para;
      } else if (sentence > start) {
        end = sentence;
      } else {
        // No sentence end behind us: allow snapping FORWARD (<=120 chars) to
        // the next sentence end so gold sentences are not cut in half when the
        // window edge lands just before their final period.
        let forward = -1;
        for (let p = end + 1; p <= Math.min(end + 120, text.length - 1); p++) {
          if (/[.!?]/.test(text[p - 1]) && /\s/.test(text[p])) {
            forward = p;
            break;
          }
        }
        if (forward > start) {
          end = forward;
        } else {
          const space = text.lastIndexOf(" ", end);
          if (space > floor) end = space;
        }
      }
      if (end <= start) end = Math.min(start + CHUNK_SIZE, text.length);
    }

    const content = text.slice(start, end).trim();
    if (content.length >= 20) {
      chunks.push({ content, page: pageOf(start), idx: idx++ });
    }
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + step - CHUNK_OVERLAP);
    // Snap the overlap start forward to a word boundary so chunks never begin
    // mid-word (which would also break sentence selection downstream).
    if (start > 0 && start < text.length && !/\s/.test(text[start])) {
      const nextSpace = text.indexOf(" ", start);
      start = nextSpace === -1 ? text.length : nextSpace + 1;
    }
  }
  return chunks;
}

/**
 * Chunk extracted pages into page-attributed segments.
 * Multi-page input (PDF) is chunked per page, so page attribution is exact.
 * Single-blob input (txt/md/docx) is chunked across the whole file with the
 * lines-per-page page approximation.
 */
export function chunkDocument(pages: ExtractedPage[]): RawChunk[] {
  const out: RawChunk[] = [];
  let idx = 0;

  const isSingleBlob = pages.length === 1 && pages[0].page === 1;

  if (!isSingleBlob) {
    for (const p of pages) {
      const chunks = slideWindow(p.text, () => p.page, idx);
      for (const c of chunks) out.push(c);
      idx += chunks.length;
    }
    return out;
  }

  const text = pages[0].text;
  const offsets = lineOffsets(text);
  const pageOf = (pos: number): number => Math.floor(lineIndexAt(offsets, pos) / LINES_PER_PAGE) + 1;
  return slideWindow(text, pageOf, 0);
}
