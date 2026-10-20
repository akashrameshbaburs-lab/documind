"use strict";
// Tests for the deterministic offline hashing embedder
// (dist/src/embeddings/hashing.js).
//
// IMPORTANT: the hashing provider imports ../config, which validates env at
// import time via zod. We therefore pin env vars BEFORE the first require.
// The module under test never opens a DB connection or calls any endpoint.
process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY; // keep the provider-independent hashing path pure
delete process.env.GPU_INFERENCE_URL;

const test = require("node:test");
const assert = require("node:assert/strict");
const { HashingEmbeddingProvider } = require("../dist/src/embeddings/hashing.js");
const { EMBEDDING_DIM } = require("../dist/src/config.js");

const provider = new HashingEmbeddingProvider();

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test("provider identifies itself as 'hashing'", () => {
  assert.equal(provider.name, "hashing");
});

test("same input always yields the identical vector (determinism)", () => {
  const a = provider.embedOne("the volcano erupted near the city");
  const b = provider.embedOne("the volcano erupted near the city");
  assert.deepEqual(a, b);
  // A fresh instance must agree too: no hidden state between instances.
  const c = new HashingEmbeddingProvider().embedOne("the volcano erupted near the city");
  assert.deepEqual(a, c);
});

test("vectors have the configured dimensionality", () => {
  assert.equal(EMBEDDING_DIM, 1536, "DocuMind emits 1536-dim vectors (pgvector vector(1536))");
  const v = provider.embedOne("volcano magma chamber");
  assert.equal(v.length, EMBEDDING_DIM);
  assert.ok(v.every((x) => Number.isFinite(x)), "no NaN/Infinity components");
});

test("vectors are L2-normalized (unit length)", () => {
  for (const text of [
    "the volcano erupted near the city",
    "quarterly invoice payment terms",
    "a b c d e f g",
  ]) {
    const v = provider.embedOne(text);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `norm for "${text}" was ${norm}`);
  }
});

test("different inputs yield different vectors, and related text scores higher", () => {
  const base = provider.embedOne("volcano magma chamber");
  const other = provider.embedOne("quantum physics is fascinating");
  assert.notDeepEqual(base, other);

  const related = provider.embedOne("volcano eruption ash");
  const unrelated = provider.embedOne("invoice payment quarterly");
  assert.ok(
    cosine(base, related) > cosine(base, unrelated),
    `related cos ${cosine(base, related)} should exceed unrelated cos ${cosine(base, unrelated)}`
  );
});

test("degenerate inputs (empty string, stopword-only) never produce a zero or NaN vector", () => {
  for (const text of ["", "   ", "the and of is"]) {
    const v = provider.embedOne(text);
    assert.equal(v.length, EMBEDDING_DIM);
    assert.ok(v.some((x) => x !== 0), `vector for ${JSON.stringify(text)} is all zeros`);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `norm for ${JSON.stringify(text)} was ${norm}`);
  }
});

test("embedTexts maps embedOne over the batch without mutating results", async () => {
  const texts = ["volcano magma chamber", "quantum physics is fascinating"];
  const batch = await provider.embedTexts(texts);
  assert.equal(batch.length, texts.length);
  texts.forEach((t, i) => assert.deepEqual(batch[i], provider.embedOne(t)));
  assert.deepEqual(await provider.embedTexts([]), []);
});
