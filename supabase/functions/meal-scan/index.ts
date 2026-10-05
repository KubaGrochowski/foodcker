/*
  Foodcker — meal-scan: funkcja serwerowa Supabase (Deno), jedyne miejsce, które zna klucz OpenAI.

  Aplikacja wysyła zdjęcie posiłku (JPEG w base64, ~1024 px) i opcjonalną podpowiedź użytkownika.
  Model rozpoznaje danie, rozbija je na składniki z gramaturą i liczy kcal, białko, tłuszcze, węglowodany.
  Sumy liczy aplikacja (żeby po zmianie gramatury wszystko się zgadzało).

  Sekrety (Supabase → Edge Functions → Secrets):
    OPENAI_API_KEY   — klucz z platform.openai.com (wymagany)
    OPENAI_MODEL     — opcjonalnie, domyślnie gpt-6-luna (jak w Foodini)
    MEAL_SCAN_LIMIT  — opcjonalnie, domyślnie 30 skanów dziennie na użytkownika
  SUPABASE_URL Supabase dostarcza sam. Funkcja nie potrzebuje kluczy Supabase: sprawdza użytkownika jego własnym tokenem.
*/
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
const DAILY_LIMIT = Number(Deno.env.get("MEAL_SCAN_LIMIT") ?? "30");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `Jesteś dietetykiem w polskiej aplikacji do liczenia kalorii (w stylu Fitatu).
Dostajesz zdjęcie posiłku i ewentualnie podpowiedź użytkownika. Oszacuj, co jest na talerzu.
Zasady:
- Rozbij posiłek na osobne składniki (np. "Ryż biały gotowany", "Pierś z kurczaka smażona", "Sos śmietanowy"), maksymalnie 12.
- Gramaturę oceniaj po wielkości talerza, sztućców i typowych porcjach. Podawaj masę jadalną w gramach (dla napojów ml ≈ g).
- Kalorie i makro licz z typowych wartości odżywczych (jak w polskich tabelach / bazach produktów) dla podanej gramatury, nie na 100 g.
- Uwzględnij tłuszcz użyty do smażenia i sosy, jeśli są widoczne lub typowe dla dania.
- Podpowiedź użytkownika ma pierwszeństwo przed tym, co widać (np. "bez cukru", "2 kromki").
- Nazwa posiłku: krótka, po polsku, np. "Spaghetti bolognese".
- Jeśli na zdjęciu nie ma jedzenia, zwróć pustą listę składników i wyjaśnij to w komentarzu.
- comment: jedno krótkie zdanie po polsku — co było trudne do oceny albo co warto poprawić ręcznie.`;

const SCHEMA = {
  name: "meal_scan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      comment: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            grams: { type: "number" },
            kcal: { type: "number" },
            protein: { type: "number" },
            fat: { type: "number" },
            carbs: { type: "number" },
          },
          required: ["name", "grams", "kcal", "protein", "fat", "carbs"],
        },
      },
    },
    required: ["name", "confidence", "comment", "items"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Tylko POST" }, 405);
  if (!OPENAI_KEY) return json({ error: "Brak klucza OPENAI_API_KEY w Supabase" }, 500);

  // kto pyta: zalogowany użytkownik aplikacji (jego token + klucz publiczny aplikacji)
  const sb = { apikey: req.headers.get("apikey") ?? "", Authorization: req.headers.get("Authorization") ?? "" };
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: sb });
  if (!who.ok) return json({ error: "Zaloguj się" }, 401);

  let body: { image?: string; mediaType?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: "Zły format zapytania" }, 400); }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > 4_000_000) return json({ error: "Brak zdjęcia albo jest za duże" }, 400);
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType ?? "") ? body.mediaType! : "image/jpeg";
  const note = String(body.note ?? "").slice(0, 160).trim();

  // dzienny limit (funkcja w bazie liczy skany zalogowanego użytkownika)
  const lim = await fetch(`${SUPABASE_URL}/rest/v1/rpc/makro_take_scan`, {
    method: "POST", headers: { ...sb, "Content-Type": "application/json" }, body: JSON.stringify({ p_limit: DAILY_LIMIT }),
  });
  if (!lim.ok) return json({ error: "Limit: " + (await lim.text()).slice(0, 200) + " (czy uruchomiono setup.sql?)" }, 500);
  const ok = await lim.json();
  if (!ok) return json({ error: `Dzienny limit ${DAILY_LIMIT} skanów wykorzystany` }, 429);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}`, detail: "high" } },
            { type: "text", text: note ? `Podpowiedź użytkownika: ${note}` : "Oszacuj ten posiłek." },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_completion_tokens: 4000,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("insufficient_quota")) return json({ error: "Brak środków na koncie OpenAI — doładuj saldo na platform.openai.com" }, 402);
    if (res.status === 429) return json({ error: "OpenAI jest chwilowo przeciążone — spróbuj za chwilę" }, 503);
    return json({ error: `OpenAI ${res.status}: ${text.slice(0, 300)}` }, 502);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) return json({ error: "AI odmówiło analizy tego zdjęcia" }, 422);
  if (!msg?.content) return json({ error: "AI nie zwróciło wyniku" }, 502);
  try { return json(JSON.parse(msg.content)); }
  catch { return json({ error: "AI zwróciło niepełny wynik — spróbuj ponownie" }, 502); }
});
