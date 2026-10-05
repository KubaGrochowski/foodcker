/*
  Grochu's makro — meal-scan: funkcja serwerowa Supabase (Deno), jedyne miejsce, które zna klucz Anthropic.

  Aplikacja wysyła zdjęcie posiłku (JPEG w base64, ~1024 px) i opcjonalną podpowiedź użytkownika.
  Claude rozpoznaje danie, rozbija je na składniki z gramaturą i liczy kcal, białko, tłuszcze, węglowodany.
  Sumy liczy aplikacja (żeby po zmianie gramatury wszystko się zgadzało).

  Sekrety (Supabase → Edge Functions → Secrets):
    ANTHROPIC_API_KEY  — klucz z console.anthropic.com (wymagany)
    MEAL_SCAN_LIMIT    — opcjonalnie, domyślnie 30 skanów dziennie na użytkownika
  SUPABASE_URL, SUPABASE_ANON_KEY i SUPABASE_SERVICE_ROLE_KEY Supabase dostarcza sam.
*/
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = Number(Deno.env.get("MEAL_SCAN_LIMIT") ?? "30");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const anthropic = new Anthropic(); // czyta ANTHROPIC_API_KEY

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
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Tylko POST" }, 405);

  // kto pyta: zalogowany użytkownik aplikacji
  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Zaloguj się" }, 401);

  let body: { image?: string; mediaType?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: "Zły format zapytania" }, 400); }
  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > 4_000_000) return json({ error: "Brak zdjęcia albo jest za duże" }, 400);
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType ?? "") ? body.mediaType! : "image/jpeg";
  const note = String(body.note ?? "").slice(0, 160).trim();

  // dzienny limit
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: ok, error: limErr } = await admin.rpc("makro_take_scan", { p_user: user.id, p_limit: DAILY_LIMIT });
  if (limErr) return json({ error: "Limit: " + limErr.message }, 500);
  if (!ok) return json({ error: `Dzienny limit ${DAILY_LIMIT} skanów wykorzystany` }, 429);

  try {
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: note ? `Podpowiedź użytkownika: ${note}` : "Oszacuj ten posiłek." },
        ],
      }],
    };
    const msg = await anthropic.beta.messages.create(params);
    if (msg.stop_reason === "refusal") return json({ error: "AI odmówiło analizy tego zdjęcia" }, 422);
    // deno-lint-ignore no-explicit-any
    const text = (msg.content as any[]).find((b) => b.type === "text")?.text;
    if (!text) return json({ error: "AI nie zwróciło wyniku" }, 502);
    return json(JSON.parse(text));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "AI jest chwilowo przeciążone — spróbuj za chwilę" }, 503);
    if (e instanceof Anthropic.APIError) return json({ error: `AI: ${e.message}` }, 502);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
