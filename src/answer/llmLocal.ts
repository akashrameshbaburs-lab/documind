import { config } from "../config";
import { HttpError } from "../httpError";
import type { RetrievalHit } from "../retrieval/search";

/**
 * Generative answer builder backed by the self-hosted GPU inference sidecar
 * (Qwen2.5-1.5B-Instruct on CUDA). Same grounding contract as the OpenAI path:
 * answer only from the retrieved passages and append `[source: file, p.N]`
 * citation markers so answers stay verifiable.
 */
export async function buildLocalLlmAnswer(
  question: string,
  hits: RetrievalHit[]
): Promise<string> {
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

  const url = config.GPU_INFERENCE_URL;
  if (!url) {
    throw new HttpError(503, "GPU_INFERENCE_URL is not configured", "gpu_not_configured");
  }
  const base = url.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    // Thrown to the caller, which degrades to an extractive answer with a note.
    throw new HttpError(
      502,
      "gpu-inference sidecar unreachable - check GPU_INFERENCE_URL and that the sidecar stack is running",
      "gpu_unreachable"
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(
      502,
      `gpu-inference chat request failed (${res.status}): ${body.slice(0, 300)}`
    );
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new HttpError(502, "gpu-inference returned an empty completion");
  return text;
}
