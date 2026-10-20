/**
 * Shared text normalization utilities.
 *
 * Both the hashing embedder and the sentence scorer use the same pipeline so
 * that query and document text are mapped into an identical token space
 * (the transform is deterministic and applied symmetrically).
 */

/** Common English stopwords dropped before hashing. Keeps feature vectors focused on content words. */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from had has have he her his i if in into is it its me my no nor not of on or our " +
    "she so than that the their them then there these they this to too was we were what when where which who whom why " +
    "will with you your can could should would may might must do does did done being about after over under again further " +
    "once any both each few more most other some such only own same too very s t just now up down out off by's it's that's " +
    "don't doesn't didn't won't isn't aren't wasn't weren't i'm you're we're they're i've you've we've there's here's " +
    "how what which whom please tell give show"
  ).split(/\s+/)
);

/**
 * Light suffix normalization (not a real stemmer - deliberately tiny and symmetric):
 *   volcanoes -> volcano, planets -> planet, cities -> city, flowed -> flow
 */
function normalizeToken(token: string): string {
  let t = token;
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith("oes")) return t.slice(0, -2); // volcanoes -> volcano
  if (t.length > 5 && t.endsWith("sses")) return t.slice(0, -2); // classes -> class
  if (t.length > 4 && t.endsWith("ves")) return `${t.slice(0, -3)}f`; // leaves -> leaf
  if (t.length > 4 && t.endsWith("ing")) return t.slice(0, -3); // flowing -> flow
  if (t.length > 4 && t.endsWith("ed") && !t.endsWith("ted") && !t.endsWith("ded")) return t.slice(0, -2); // flowed -> flow
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
  return t;
}

/** Lowercase, strip accents/punctuation, split on non-alphanumerics, light normalization. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Consecutive unigrams + bigrams (after stopword removal) used as embedding features. */
export function features(text: string): { unigrams: string[]; bigrams: string[] } {
  const tokens = tokenize(text);
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return { unigrams: tokens, bigrams };
}

/** Normalization used for the answer cache key: case-fold + collapse whitespace. */
export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}
