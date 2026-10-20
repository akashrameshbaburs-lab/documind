/** One-off probe: ask a specific question against a fresh set and print the answer. */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3200";
const email = `probe+${Date.now()}@documind.local`;
const password = "probe-password-123";

async function json(method: string, url: string, body?: unknown, token?: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: unknown;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload as never });
  const text = await res.text();
  console.log(`  [${method} ${url}] ${res.status}`);
  return JSON.parse(text || "{}");
}

async function main(): Promise<void> {
  await json("POST", "/api/register", { email, password });
  const login = await json("POST", "/api/login", { email, password });
  const form = new FormData();
  form.append("name", `probe-${Date.now()}`);
  for (const f of ["world-facts.pdf", "field-notes.md"]) {
    const buf = fs.readFileSync(path.join(__dirname, "..", "eval", "docs", f));
    form.append("files", new Blob([new Uint8Array(buf)]), f);
  }
  const up = await json("POST", "/api/docs", form, login.token);
  const question = process.argv[2] ?? "When was PostgreSQL first released and where was it developed?";
  const chat = await json("POST", "/api/chat", { setId: up.setId, question }, login.token);
  console.log("\nQ:", question);
  console.log("A:\n" + chat.answer);
  console.log("\nCitations:");
  for (const c of chat.citations) console.log(`  [${c.fileName} p.${c.page}] score=${c.score}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
