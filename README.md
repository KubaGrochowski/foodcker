# Grochu's makro

Dziennik posiłków w stylu Fitatu: robisz zdjęcie talerza, AI (Claude) rozpoznaje danie, rozbija je na składniki z gramaturą i liczy kalorie, białko, tłuszcze i węglowodany. Wygląd 1:1 jak Grochu's tracker (czerń, Outfit + JetBrains Mono, morskie animacje), tylko akcent jasnoniebieski zamiast zielonego.
Czysty HTML/CSS/JS, bez budowania. Konto i synchronizacja przez ten sam projekt Supabase co tracker (to samo konto e-mail + hasło).

## Uruchomienie lokalnie

```bash
node .claude/serve.js 5174
```

i otwórz http://localhost:5174.

## Konfiguracja Supabase (jednorazowo)

1. **Baza:** Supabase → SQL Editor → New query → wklej `supabase/setup.sql` → Run. Tworzy tabelę `makro_data` (RLS, Realtime) i licznik dziennych skanów.
2. **Klucz AI:** Edge Functions → Secrets → dodaj `ANTHROPIC_API_KEY` (klucz z console.anthropic.com). Opcjonalnie `MEAL_SCAN_LIMIT` (domyślnie 30 skanów dziennie na osobę).
3. **Funkcja:** Edge Functions → Deploy a new function → Via Editor → nazwa `meal-scan` → wklej `supabase/functions/meal-scan/index.ts` → Deploy (zostaw włączone „Verify JWT”).
   Albo z terminala: `supabase functions deploy meal-scan --project-ref xumjkmfctdutouvfgzsh`.

Bez kroku 2–3 aplikacja działa, ale zamiast wyniku skanu pokaże komunikat i opcję „Wpisz ręcznie”.

## Obsługa

- **Skanuj posiłek** → zdjęcie z aparatu albo z galerii (+ opcjonalna podpowiedź, np. „bez sosu”). W trakcie: sonar, przypływ i bąbelki na zdjęciu.
- Wynik: nazwa, składniki z gramami i makro, sumy na żywo. Zmiana gramatury przelicza kcal i makro proporcjonalnie. Można dodać/usunąć składnik, zmienić rodzaj posiłku, dzień i godzinę.
- **Dzień:** koło kalorii z wodą (poziom = % celu, pomarańczowe po przekroczeniu 110%), rurki białka/tłuszczu/węgli, posiłki pogrupowane (Śniadanie, Obiad, Kolacja, Przekąska). Strzałki ‹ › lub przesunięcie palcem zmienia dzień. Osiągnięcie celu kalorii (100–110%) = fala przez cały ekran.
- **Historia:** wszystkie posiłki od najnowszych, wyszukiwarka po nazwie i składnikach, „Dodaj dziś” powtarza posiłek na dziś, klik w datę otwiera ten dzień.
- **Podsumowanie:** 7 / 30 dni — słupki kalorii z linią celu, średnie makro, dni w celu, seria wpisów, najczęstsze posiłki.
- **Cele** (menu ⋯ / ☰): kalorie i gramy makro, gotowe podziały Redukcja / Utrzymanie / Masa.
- Zdjęcie do AI jest zmniejszane do ~1024 px; w danych zostaje tylko miniatura 120 px.

Po zmianach w plikach podbij wersję: `VERSION` w `sw.js` oraz `?v=` w `index.html` i w `SHELL` w `sw.js`.

## Struktura

- `index.html` – szkielet i ekran logowania
- `css/styles.css` – wygląd (styl trackera + część makro)
- `js/app.js` – logika, widoki, skanowanie, animacje
- `js/cloud.js` – konto, synchronizacja (tabela `makro_data`), wywołanie funkcji AI
- `supabase/setup.sql`, `supabase/functions/meal-scan/index.ts` – baza i funkcja AI (Claude Opus 5.5)
- `manifest.webmanifest`, `sw.js`, `icons/` – PWA
