import { config } from "../config";
import { HttpError } from "../httpError";
import type { RetrievalHit } from "../retrieval/search";

/**
 * Generative answer builder (LLM mode).
 * Only invoked when OPENAI_API_KEY is set at runtime. The prompt forces the
 * model to answer *only* from the retrieved passages and to append
 * `[source: file, p.N]` markers, keeping answers grounded and citable.
 */
export async function buildLlmAnswer(question: string, hits: RetrievalHit[]): Promise<string> {
  if (hits.length === 0) {
    return "I could not find any relevant passages in this document set for that question.";
  }

  const passages = hits
    .map((h, i) => `[passage ${i + 1} | file: ${h.fileName} | page: ${h.page}]\n${h.content}`)
    .join("\n\n");

  const system =
    "You are DocuMind AI, a document question-answering assistant. Answer ONLY using the provided passages. " +
    "After every factual claim append a citation marker exactly like [source: file.pdf, p.3]. " +
    "If the passages do not contain the answer, say so explicitly. Be concise (max 180 words).";
  const user = `Passages:\n${passages}\n\nQuestion: ${question}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.OPENAI_CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(502, `openai chat request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new HttpError(502, "openai returned an empty completion");
  return text;
}
