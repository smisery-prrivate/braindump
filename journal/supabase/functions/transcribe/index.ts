// Journal transcription function (Supabase Edge Function, Deno).
// The app sends one audio segment (a few minutes) with the user's sign-in token. This function
// checks the sign-in with the project's own auth service, optionally restricts the service to
// listed e-mail addresses, hands the audio to the transcription provider and returns the text.
// Nothing is stored here; the provider's API key never reaches the phone.
//
// Secrets (supabase secrets set KEY=value):
//   STT_PROVIDER     openai (default) | deepgram
//   OPENAI_API_KEY   for openai;  STT_MODEL   gpt-4o-transcribe (default) | whisper-1 | gpt-4o-mini-transcribe
//   DEEPGRAM_API_KEY for deepgram; STT_MODEL  nova-3 (default)
//   ALLOWED_EMAILS   comma-separated list; when set, only these signed-in users may transcribe
//   ALLOWED_ORIGIN   the app's origin for CORS, e.g. https://example.github.io (default: *)
//   MAX_BYTES        upload limit per segment in bytes (default 26214400 = 25 MB)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const PROVIDER = (Deno.env.get("STT_PROVIDER") ?? "openai").toLowerCase();
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MAX_BYTES = Number(Deno.env.get("MAX_BYTES") ?? 26214400);
const ALLOWED = (Deno.env.get("ALLOWED_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function userOf(req: Request): Promise<{ id: string; email: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, email: (u.email ?? "").toLowerCase() } : null;
}

async function openai(file: File, language: string, prompt: string) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = Deno.env.get("STT_MODEL") ?? "gpt-4o-transcribe";
  const fd = new FormData();
  fd.append("file", file, file.name || "segment.webm");
  fd.append("model", model);
  fd.append("response_format", "json");
  if (language) fd.append("language", language);
  if (prompt) fd.append("prompt", prompt);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  if (!r.ok) throw new Error(`transcription provider answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { text: String(j.text ?? ""), language: String(j.language ?? "") };
}

async function deepgram(file: File, language: string, prompt: string) {
  const key = Deno.env.get("DEEPGRAM_API_KEY");
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set");
  const model = Deno.env.get("STT_MODEL") ?? "nova-3";
  const q = new URLSearchParams({ model, smart_format: "true", punctuate: "true", paragraphs: "true", language: language || "multi" });
  // the previous segment's last words become key terms, which helps names and jargon continue correctly
  for (const w of prompt.split(/\s+/).filter((x) => x.length > 3).slice(-20)) q.append("keyterm", w);
  const r = await fetch(`https://api.deepgram.com/v1/listen?${q}`, { method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": file.type || "application/octet-stream" }, body: await file.arrayBuffer() });
  if (!r.ok) throw new Error(`transcription provider answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const alt = j?.results?.channels?.[0]?.alternatives?.[0];
  const text = alt?.paragraphs?.transcript ?? alt?.transcript ?? "";
  return { text: String(text).trim(), language: String(j?.results?.channels?.[0]?.detected_language ?? "") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const user = await userOf(req);
  if (!user) return reply(401, { error: "not signed in" });
  if (ALLOWED.length && !ALLOWED.includes(user.email)) return reply(403, { error: "this account may not transcribe" });
  let form: FormData;
  try { form = await req.formData(); } catch { return reply(400, { error: "expected multipart form data with a file" }); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return reply(400, { error: "no audio file" });
  if (file.size > MAX_BYTES) return reply(413, { error: `the segment is larger than ${MAX_BYTES} bytes` });
  const language = String(form.get("language") ?? "").trim().slice(0, 8);
  const prompt = String(form.get("prompt") ?? "").trim().slice(0, 600);
  try {
    const out = PROVIDER === "deepgram" ? await deepgram(file, language, prompt) : await openai(file, language, prompt);
    return reply(200, { ...out, provider: PROVIDER });
  } catch (e) {
    return reply(502, { error: (e as Error).message ?? "transcription failed" });
  }
});
