"use strict";
// Tests for the greedy sliding-window chunker (dist/src/ingest/chunk.js).
// Pure logic only: no DB, no network. All inputs are in-memory strings.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chunkDocument,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  LINES_PER_PAGE,
} = require("../dist/src/ingest/chunk.js");

/** Build n unique sentences joined by spaces (~60 chars each). */
function makeSentences(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      "Sentence number " + i + " talks about volcanoes and magma chambers in detail."
    );
  }
  return out.join(" ");
}

/** Count unpaired UTF-16 surrogates (i.e. mid-codepoint splits). */
function countLoneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) n++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) n++;
    }
  }
  return n;
}

test("exported chunking constants match the documented architecture values", () => {
  assert.equal(CHUNK_SIZE, 1200);
  assert.equal(CHUNK_OVERLAP, 200);
  assert.equal(LINES_PER_PAGE, 50);
  assert.ok(CHUNK_OVERLAP < CHUNK_SIZE, "overlap must be smaller than the window");
});

test("empty, whitespace-only, and sub-minimum inputs produce no chunks", () => {
  assert.deepEqual(chunkDocument([{ page: 1, text: "" }]), []);
  assert.deepEqual(chunkDocument([{ page: 1, text: "   \n  \t " }]), []);
  // 11 chars: below the 20-char minimum content length, so it is dropped.
  assert.deepEqual(chunkDocument([{ page: 1, text: "hello world" }]), []);
});

test("short input yields a single verbatim chunk at page 1, idx 0", () => {
  const text = "This is a short but sufficiently long piece of text.";
  const chunks = chunkDocument([{ page: 1, text }]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, text); // preserved verbatim
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[0].idx, 0);
});

test("long input: chunk sizes stay within window + forward-snap slack, idx is sequential, run is deterministic", () => {
  const chunks = chunkDocument([{ page: 1, text: makeSentences(60) }]);
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) {
    // The implementation may snap forward up to 120 chars past the window
    // edge to keep sentences intact; never beyond that.
    assert.ok(
      c.content.length <= CHUNK_SIZE + 120,
      `chunk ${c.idx} length ${c.content.length} exceeds ${CHUNK_SIZE + 120}`
    );
    assert.ok(c.content.length >= 20, "emitted chunks respect the minimum length");
  }
  chunks.forEach((c, i) => assert.equal(c.idx, i, "idx is a sequential counter"));

  // Determinism: identical input -> byte-identical chunk list.
  const again = chunkDocument([{ page: 1, text: makeSentences(60) }]);
  assert.deepEqual(chunks, again);
});

test("long input: consecutive chunks overlap and no input text is lost", () => {
  const text = makeSentences(60);
  const chunks = chunkDocument([{ page: 1, text }]);

  // Overlap: each chunk (after the first) opens inside the previous chunk's
  // window, so the first 30 chars of chunk i+1 appear inside chunk i.
  for (let i = 0; i + 1 < chunks.length; i++) {
    const head = chunks[i + 1].content.slice(0, 30);
    assert.ok(
      chunks[i].content.includes(head),
      `chunks ${i}/${i + 1} do not overlap at "${head}"`
    );
  }

  // No text loss: every input word is covered by the concatenated chunks.
  const joined = chunks.map((c) => c.content).join("\n");
  for (const word of text.split(" ")) {
    assert.ok(joined.includes(word), `word "${word}" missing from all chunks`);
  }
});

test("multi-page input (PDF style): every chunk is attributed to its source page", () => {
  const pages = [
    { page: 1, text: "Page one content that is long enough to become at least one chunk of text for sure yes." },
    { page: 2, text: "Page two content that is long enough to become at least one chunk of text for sure yes." },
    { page: 3, text: "Page three content that is long enough to become at least one chunk of text for sure yes." },
  ];
  const chunks = chunkDocument(pages);
  assert.equal(chunks.length, 3, "one chunk per short page");
  chunks.forEach((c, i) => {
    assert.equal(c.page, i + 1, "chunk page matches its source page");
    assert.equal(c.idx, i, "idx continues across pages");
  });
});

test("single-blob input (txt/md/docx): pages advance every LINES_PER_PAGE lines", () => {
  const lines = [];
  for (let i = 0; i < 120; i++) {
    lines.push("Line " + i + " of the single blob document with some padding words here.");
  }
  const chunks = chunkDocument([{ page: 1, text: lines.join("\n") }]);
  assert.equal(chunks[0].page, 1, "first chunk is on page 1");
  const pagesSeen = new Set(chunks.map((c) => c.page));
  assert.ok(pagesSeen.has(2) && pagesSeen.has(3), "120 lines must span pages 1-3");
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].page >= chunks[i - 1].page, "page attribution never goes backwards");
  }
});

test("unicode: multi-byte characters are never split mid-codepoint and no text is lost", () => {
  // Realistic space-separated prose containing astral emoji, CJK and
  // accented Latin. Boundary snapping lands on whitespace/word edges, so
  // surrogate pairs survive chunking intact.
  const text = ("Word \u{1F680} rocket é test 日本語 text with emoji \u{1F600} and more words. ").repeat(80);
  const chunks = chunkDocument([{ page: 1, text }]);
  assert.ok(chunks.length >= 2, "unicode-heavy text still splits into multiple chunks");
  const joined = chunks.map((c) => c.content).join("\n");
  for (const word of new Set(text.split(" "))) {
    if (word.length === 0) continue;
    assert.ok(joined.includes(word), `unicode word "${word}" missing from chunks`);
  }
  for (const c of chunks) {
    assert.equal(
      countLoneSurrogates(c.content),
      0,
      `chunk ${c.idx} contains a split codepoint`
    );
  }
});
