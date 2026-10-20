"use strict";
// Tests for the offline extractive answer builder (dist/src/answer/extractive.js).
// Pure scoring logic: hits are plain in-memory objects shaped like RetrievalHit,
// no DB connection or embedding call is ever made.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExtractiveAnswer, toCitations } = require("../dist/src/answer/extractive.js");

/** Build a RetrievalHit-shaped object with sensible defaults. */
function makeHit(overrides) {
  return Object.assign(
    {
      chunkId: 1,
      docId: "doc-1",
      fileName: "doc.txt",
      page: 1,
      content: "",
      cos: 0.5,
      tsRank: 0.5,
      fused: 0.5,
      rank: 1,
    },
    overrides
  );
}

test("no hits: returns the friendly fallback message with zero citations", () => {
  const { answer, citations } = buildExtractiveAnswer("what is magma?", []);
  assert.match(answer, /could not find any relevant passages/i);
  assert.equal(citations.length, 0);
});

test("ranking: the sentence with the highest question-token overlap is emitted first", () => {
  const question = "volcano magma chamber eruption";
  const relevant = makeHit({
    rank: 1,
    fused: 0.9,
    content:
      "The volcano magma chamber erupted violently during the eruption. " +
      " filler text to make this sentence long enough to pass the thirty char filter easily ok.",
  });
  const irrelevant = makeHit({
    rank: 2,
    fused: 0.8,
    content:
      "A completely unrelated sentence about gardening and tomatoes in summer. " +
      "Also long enough to pass the thirty character filter here.",
  });
  const { answer, citations } = buildExtractiveAnswer(question, [relevant, irrelevant]);

  assert.match(answer, /volcano magma chamber erupted/i, "relevant sentence is quoted");
  assert.doesNotMatch(answer, /gardening and tomatoes/i, "irrelevant sentence is not quoted");
  assert.ok(
    answer.indexOf("volcano magma chamber erupted") < answer.indexOf("gardening") ||
      answer.indexOf("gardening") === -1,
    "relevant quote ranks ahead of any irrelevant one"
  );

  // Citations preserve hit metadata and fused score, in hit order.
  assert.equal(citations.length, 2);
  assert.equal(citations[0].fileName, "doc.txt");
  assert.equal(citations[0].page, 1);
  assert.equal(citations[0].score, 0.9);
});

test("answer lines carry the [source: file, p.N] citation marker", () => {
  const hit = makeHit({
    fileName: "report.md",
    page: 7,
    content:
      "The annual revenue grew by twelve percent across all regions worldwide. " +
      "More than enough padding characters to clear the thirty character floor here.",
  });
  const { answer } = buildExtractiveAnswer("annual revenue", [hit]);
  assert.match(answer, /\[source: report\.md, p\.7\]/);
  assert.match(answer, /Based on the most relevant passages/);
});

test("tie behavior: equal-scoring sentences keep document order (stable ranking)", () => {
  // Both sentences share the exact same single-token overlap ("magma chamber")
  // and the same rank bonus, so the stable sort must preserve input order.
  const sentenceA =
    "The magma chamber sits below the volcano surface area. This is extra padding to pass the filter.";
  const sentenceB =
    "Magma chamber depth varies across volcanic regions worldwide with significant extra padding here.";
  const hit = makeHit({ rank: 1, content: sentenceA + " " + sentenceB });
  const { answer } = buildExtractiveAnswer("magma chamber", [hit]);

  const posA = answer.indexOf("The magma chamber sits below");
  const posB = answer.indexOf("Magma chamber depth varies");
  assert.ok(posA !== -1 && posB !== -1, "both tied sentences are quoted");
  assert.ok(posA < posB, "ties preserve original document order");
});

test("no-keyword fallback: punctuation-only question still quotes the top hit", () => {
  const top = makeHit({
    rank: 1,
    content:
      "First sentence of the top chunk is quite long and should pass the thirty char filter easily.",
  });
  const second = makeHit({
    rank: 2,
    fileName: "second.txt",
    content:
      "Second hit first sentence also long enough to easily pass the thirty character filter rule.",
  });
  const { answer } = buildExtractiveAnswer("?!", [top, second]);
  assert.match(answer, /First sentence of the top chunk/);
  assert.match(answer, /Second hit first sentence/);
  assert.match(answer, /\[source: doc\.txt, p\.1\]/);
});

test("no-overlap fallback: keywords absent from all chunks quote the top hit's opening", () => {
  const hit = makeHit({
    rank: 1,
    content:
      "First sentence of the top chunk is quite long and should pass the thirty char filter easily.",
  });
  const { answer } = buildExtractiveAnswer("quantum entanglement", [hit]);
  assert.match(answer, /First sentence of the top chunk/);
});

test("toCitations caps at 5, truncates long snippets with an ellipsis, and rounds scores", () => {
  const hits = [];
  for (let i = 0; i < 7; i++) {
    hits.push(
      makeHit({
        chunkId: i,
        content: "Sentence number " + i + " is a perfectly valid long enough sentence for testing purposes.",
      })
    );
  }
  const cites = toCitations(hits);
  assert.equal(cites.length, 5, "citation list is capped at MAX_CITATIONS = 5");

  const long = toCitations([makeHit({ content: "x".repeat(500) })])[0];
  assert.equal(long.snippet.length, 241, "240 chars + ellipsis");
  assert.ok(long.snippet.endsWith("…"));

  const rounded = toCitations([makeHit({ fused: 0.123456789 })])[0];
  assert.equal(rounded.score, 0.1235, "score rounded to 4 decimal places");

  const short = toCitations([makeHit({ content: "short" })])[0];
  assert.equal(short.snippet, "short", "short content is not modified");
});
