/** Proves the daily usage limit returns 429 with a clear JSON body. */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3200";
const email = `ratelimit+${Date.now()}@documind.local`;
const password = "ratelimit-pass-123";

async function json(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: unknown;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload as never });
  return { status: res.status, data: JSON.parse((await res.text()) || "{}") };
}

async function main(): Promise<void> {
  await json("POST", "/api/register", { email, password });
  const login = await json("POST", "/api/login", { email, password });
  const form = new FormData();
  form.append("name", `rl-${Date.now()}`);
  const buf = fs.readFileSync(path.join(__dirname, "..", "eval", "docs", "field-notes.md"));
  form.append("files", new Blob([new Uint8Array(buf)]), "field-notes.md");
  const up = await json("POST", "/api/docs", form, login.data.token);

  const limit = (await json("GET", "/api/config")).data.maxQueriesPerDay;
  console.log(`configured MAX_QUERIES_PER_DAY=${limit}`);
  let saw429 = false;
  for (let i = 1; i <= limit + 2; i++) {
    const r = await json("POST", "/api/chat", { setId: up.data.setId, question: `Question number ${i}: which country has the most volcanoes?` }, login.data.token);
    console.log(`  ask #${i} -> ${r.status} ${r.status === 429 ? JSON.stringify(r.data) : ""}`);
    if (r.status === 429) { saw429 = true; break; }
  }
  console.log(saw429 ? "RATE LIMIT VERIFIED (429 with JSON body)" : "RATE LIMIT NOT HIT - check limit config");
  process.exit(saw429 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
