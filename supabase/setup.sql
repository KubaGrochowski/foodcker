-- Foodcker — jednorazowa konfiguracja bazy (Supabase → SQL Editor → New query → wklej → Run).
-- Ten sam projekt Supabase co Grochu's tracker, więc konto (e-mail + hasło) jest wspólne.

-- 1. Dane użytkownika: jeden wiersz na konto (cele + posiłki z miniaturami), jak user_data w trackerze.
create table if not exists public.makro_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.makro_data enable row level security;

drop policy if exists "makro_data: własny wiersz" on public.makro_data;
create policy "makro_data: własny wiersz" on public.makro_data
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- synchronizacja na żywo między urządzeniami
do $$ begin
  alter publication supabase_realtime add table public.makro_data;
exception when duplicate_object then null; end $$;

-- 2. Dzienny limit skanów AI na użytkownika (chroni budżet na API). Wywołuje go funkcja meal-scan tokenem użytkownika.
create table if not exists public.makro_ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  calls integer not null default 0,
  primary key (user_id, day)
);
alter table public.makro_ai_usage enable row level security;
-- brak polityk = tabeli nie da się czytać ani zmieniać bezpośrednio; liczy tylko funkcja poniżej

drop function if exists public.makro_take_scan(uuid, integer);
-- Zajmuje jeden skan z dziennej puli zalogowanego użytkownika. Zwraca true, jeśli mieści się w limicie.
create or replace function public.makro_take_scan(p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  used integer;
begin
  if auth.uid() is null then return false; end if;
  insert into public.makro_ai_usage (user_id, day, calls)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set calls = public.makro_ai_usage.calls + 1
  returning calls into used;
  return used <= p_limit;
end;
$$;

revoke all on function public.makro_take_scan(integer) from public, anon;
grant execute on function public.makro_take_scan(integer) to authenticated;
