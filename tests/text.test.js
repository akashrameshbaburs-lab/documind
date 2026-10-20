"use strict";
// Tests for shared text normalization (dist/src/text.js).
// These utilities drive both the hashing embedder and the sentence scorer,
// so the contract is: deterministic, symmetric, stopword-aware, unicode-safe.
const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenize, features, normalizeQuestion } = require("../dist/src/text.js");

test("tokenize folds case and strips punctuation", () => {
  assert.deepEqual(tokenize("HELLO World"), ["hello", "world"]);
  assert.deepEqual(tokenize("Magma-Chamber, Eruption!"), ["magma", "chamber", "eruption"]);
});

test("tokenize removes common English stopwords", () => {
  assert.deepEqual(tokenize("the quick brown fox"), ["quick", "brown", "fox"]);
  assert.deepEqual(tokenize("the and of is"), [], "stopword-only input yields no tokens");
  assert.deepEqual(tokenize("What is the answer"), ["answer"]);
});

test("tokenize applies the documented light suffix normalization", () => {
  assert.deepEqual(tokenize("The Volcanoes Are Erupting"), ["volcano", "erupt"]);
  assert.deepEqual(tokenize("cities classes flowed leaves"), ["city", "class", "flow", "leaf"]);
});

test("tokenize strips accents via NFKD (unicode handling)", () => {
  assert.deepEqual(tokenize("Café naïve"), ["cafe", "naive"]);
  assert.deepEqual(tokenize("Ångström"), ["angstrom"]);
});

test("tokenize drops single-character tokens and is deterministic", () => {
  assert.deepEqual(tokenize("a bb I"), ["bb"]);
  assert.deepEqual(tokenize("Magma Chamber Magma Chamber"), tokenize("magma chamber magma chamber"));
});

test("features() emits unigrams plus consecutive bigrams", () => {
  const f = features("volcanic eruption near the city");
  // Note: "near" is not in the project's stopword list, so it survives.
  assert.deepEqual(f.unigrams, ["volcanic", "eruption", "near", "city"]);
  assert.deepEqual(f.bigrams, ["volcanic eruption", "eruption near", "near city"]);
  // Bigram count is always unigramCount - 1 (when >= 1 token).
  assert.equal(f.bigrams.length, f.unigrams.length - 1);
});

test("features() of an empty/stopword-only string is empty on both axes", () => {
  const f = features("   ");
  assert.deepEqual(f.unigrams, []);
  assert.deepEqual(f.bigrams, []);
});

test("normalizeQuestion case-folds and collapses whitespace for cache keys", () => {
  assert.equal(normalizeQuestion("  What   IS\nthe Answer? "), "what is the answer?");
  assert.equal(
    normalizeQuestion("What is the answer?"),
    normalizeQuestion("  what   IS the answer?  "),
    "semantically equal questions map to the same cache key"
  );
});
