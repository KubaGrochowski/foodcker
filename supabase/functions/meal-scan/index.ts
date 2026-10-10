/*
  Foodcker — meal-scan: funkcja serwerowa Supabase (Deno), jedyne miejsce, które zna klucz OpenAI.

  Aplikacja wysyła zdjęcie posiłku (JPEG w base64, ~1024 px) i wymagany opis od użytkownika.
  Model rozpoznaje składniki i podaje dla każdego: gramy oraz wartości odżywcze NA 100 g.
  Mnożenie (wartość na 100 g × gramy / 100) robi ta funkcja, nie model — modele mylą się w rachunkach,
  a tabela wartości na 100 g jest dla nich pewniejsza. Do aplikacji idą gotowe kcal i makro dla gramatury.
  Kontrola: jeśli kcal na 100 g nie zgadza się z makro (4×B + 9×T + 4×W), kcal liczymy z makro.

  Sekrety (Supabase → Edge Functions → Secrets):
    OPENAI_API_KEY   — klucz z platform.openai.com (wymagany)
    OPENAI_MODEL     — opcjonalnie, domyślnie gpt-6.1-sol
    OPENAI_EFFORT    — opcjonalnie: low | medium | high (domyślnie medium; wyższe = dokładniej, ale drożej i wolniej)
    MEAL_SCAN_LIMIT  — opcjonalnie, domyślnie 30 skanów dziennie na użytkownika
  SUPABASE_URL Supabase dostarcza sam. Funkcja nie potrzebuje kluczy Supabase: sprawdza użytkownika jego własnym tokenem.
*/
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-6.1-sol";
const EFFORT = Deno.env.get("OPENAI_EFFORT") ?? "medium";
const DAILY_LIMIT = Number(Deno.env.get("MEAL_SCAN_LIMIT") ?? "30");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `Jesteś dietetykiem w polskiej aplikacji do liczenia kalorii (jak Fitatu). Twoje zadanie: jak najdokładniej ustalić, z czego składa się posiłek i ile waży każdy składnik, oraz podać wartości odżywcze każdego składnika na 100 g.

Dostajesz zdjęcie posiłku i opis od użytkownika.

OPIS UŻYTKOWNIKA JEST WIĄŻĄCY
- Wszystko, co użytkownik podał (produkty, liczba sztuk, gramy, sposób przygotowania), traktuj jako fakt — nawet jeśli zdjęcie sugeruje coś innego.
- "dwa jajka" = 2 sztuki, "5g masła" = dokładnie 5 g. Nie zmieniaj podanych ilości.
- Zdjęcie służy do ustalenia tego, czego opis nie mówi: wielkości porcji, rodzaju pieczywa, dodatków, sposobu przygotowania.
- Nie dodawaj składników, których nie widać i których nie ma w opisie — z wyjątkiem tłuszczu do smażenia, gdy produkt jest wyraźnie smażony, a opis go nie podaje (wtedy ok. 5 g oleju na porcję i napisz o tym w komentarzu).

JEDNOSTKI NA GRAMY (masa jadalna)
- jajko kurze M: 50 g (L: 60 g, S: 40 g)
- kromka chleba: 35 g (cienka 25 g, gruba 50 g); bułka pszenna (kajzerka): 50 g; grahamka: 70 g
- łyżeczka: masło 5 g, cukier 5 g, olej 4 g; łyżka: olej/oliwa 10 g, masło 15 g, cukier 12 g, mąka 10 g, śmietana 15 g
- plaster: szynka/wędlina 15 g, ser żółty 18 g
- szklanka płynu: 250 ml ≈ 250 g
- porcja ugotowanego ryżu lub kaszy: 150 g; makaronu ugotowanego: 200 g; ziemniaki gotowane: 1 średni 100 g
- pierś z kurczaka (1 pojedyncza): 150 g; kotlet schabowy: 120 g
- banan bez skórki: 120 g; jabłko: 180 g
Jeśli użytkownik podaje sztuki, przelicz je według tej listy (albo typowej wagi, gdy produktu tu nie ma).

WARTOŚCI ODŻYWCZE NA 100 g (używaj tych, gdy pasują; dla innych produktów — typowe wartości z polskich tabel)
produkt: kcal / białko / tłuszcz / węglowodany
- jajko kurze całe: 140 / 12.5 / 9.7 / 0.7
- chleb pszenny: 250 / 8.0 / 1.8 / 50.0
- chleb żytni: 230 / 6.0 / 1.7 / 47.0
- bułka pszenna: 280 / 8.5 / 3.0 / 55.0
- masło 82%: 740 / 0.7 / 82.0 / 0.7
- olej / oliwa: 880 / 0 / 100 / 0
- ser żółty (gouda): 356 / 25.0 / 27.0 / 0.1
- szynka wieprzowa gotowana: 120 / 19.0 / 4.5 / 1.0
- pierś z kurczaka surowa: 100 / 22.0 / 1.3 / 0 · pieczona/grillowana: 155 / 31.0 / 3.5 / 0
- ryż biały ugotowany: 130 / 2.7 / 0.3 / 28.0
- makaron pszenny ugotowany: 158 / 5.8 / 0.9 / 31.0
- ziemniaki gotowane: 77 / 1.9 / 0.1 / 17.0
- płatki owsiane: 370 / 13.0 / 7.0 / 58.0
- mleko 2%: 50 / 3.4 / 2.0 / 4.8
- banan: 95 / 1.1 / 0.3 / 22.0
- jabłko: 52 / 0.3 / 0.2 / 14.0
- cukier: 400 / 0 / 0 / 100

ZASADY LICZENIA
- Każdy składnik osobno (np. "Chleb pszenny (2 kromki)", "Jajko sadzone (2 szt.)", "Masło"), maksymalnie 12. Nie licz dwa razy tego samego.
- grams = masa jadalna składnika w posiłku (bez skorupek, pestek, kości). Dla napojów ml ≈ g.
- Wartości na 100 g podawaj dla stanu, w jakim składnik jest jedzony (ryż/makaron/kasza ugotowane, mięso po obróbce).
- Sprawdź każdy składnik: kcal_100g ≈ 4×białko + 9×tłuszcz + 4×węglowodany (różnica do ok. 10%; wyjątki: alkohol, dużo błonnika).
- name: krótka nazwa posiłku po polsku, np. "Chleb z jajkami".
- confidence: high — ilości znane z opisu; medium — część ilości oceniona ze zdjęcia; low — trudno ocenić.
- comment: jedno krótkie zdanie po polsku: co oceniłeś na oko i warto sprawdzić (np. grubość kromek).
- Jeśli na zdjęciu nie ma jedzenia i opis go nie podaje, zwróć pustą listę składników i wyjaśnij to w komentarzu.`;

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
            grams: { type: "number", description: "masa jadalna składnika w posiłku, w gramach" },
            kcal_100g: { type: "number" },
            protein_100g: { type: "number" },
            fat_100g: { type: "number" },
            carbs_100g: { type: "number" },
          },
          required: ["name", "grams", "kcal_100g", "protein_100g", "fat_100g", "carbs_100g"],
        },
      },
    },
    required: ["name", "confidence", "comment", "items"],
  },
};

type RawItem = { name: string; grams: number; kcal_100g: number; protein_100g: number; fat_100g: number; carbs_100g: number };
const num = (v: unknown, max: number) => Math.min(max, Math.max(0, Number(v) || 0));
const r1 = (v: number) => Math.round(Number(v.toPrecision(12)) * 10) / 10;

// Wartości na 100 g → kcal i makro dla gramatury. Kontrola spójności kcal z makro.
export function toItems(raw: RawItem[]) {
  return (raw ?? []).slice(0, 12).map((it) => {
    const g = num(it.grams, 3000), p = num(it.protein_100g, 100), f = num(it.fat_100g, 100), c = num(it.carbs_100g, 100);
    let k = num(it.kcal_100g, 900);
    const fromMacro = 4 * p + 9 * f + 4 * c;
    // Poprawiamy tylko produkty kaloryczne z wyraźną rozbieżnością (warzywa z błonnikiem i alkohol zostają jak podał model).
    if (fromMacro >= 80 && Math.abs(k - fromMacro) / fromMacro > 0.2) k = fromMacro;
    const s = g / 100;
    return { name: String(it.name ?? "").slice(0, 80), grams: Math.round(g), kcal: Math.round(k * s), protein: r1(p * s), fat: r1(f * s), carbs: r1(c * s) };
  }).filter((it) => it.name);
}

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
      reasoning_effort: EFFORT,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: note ? `Opis od użytkownika (wiążący): ${note}` : "Użytkownik nie dodał opisu — oceń wszystko ze zdjęcia." },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}`, detail: "high" } },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_completion_tokens: 16000, // model myślący: miejsce na rozumowanie + JSON (płacisz tylko za zużyte)
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("insufficient_quota")) return json({ error: "Brak środków na koncie OpenAI — doładuj saldo na platform.openai.com" }, 402);
    if (res.status === 429) return json({ error: "OpenAI jest chwilowo przeciążone — spróbuj za chwilę" }, 503);
    return json({ error: `OpenAI ${res.status}: ${text.slice(0, 300)}` }, 502);
  }
  const data = await res.json();
  const choice = data.choices?.[0], msg = choice?.message;
  if (msg?.refusal) return json({ error: "AI odmówiło analizy tego zdjęcia" }, 422);
  if (choice?.finish_reason === "length") return json({ error: "AI nie zdążyło skończyć odpowiedzi — spróbuj ponownie" }, 502);
  if (!msg?.content) return json({ error: "AI nie zwróciło wyniku" }, 502);
  let out: { name: string; confidence: string; comment: string; items: RawItem[] };
  try { out = JSON.parse(msg.content); } catch { return json({ error: "AI zwróciło niepełny wynik — spróbuj ponownie" }, 502); }
  return json({ name: out.name, confidence: out.confidence, comment: out.comment, items: toItems(out.items) });
});
