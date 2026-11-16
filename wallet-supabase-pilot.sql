-- Isolated pilot table. This does not alter the production transacciones table.
create table if not exists public.wallet_sync_pilot (
  wallet_record_id text primary key,
  record_date timestamptz,
  wallet_record jsonb not null,
  sync_run_id text not null,
  is_deleted boolean not null default false,
  synced_at timestamptz not null default now()
);

-- Migration for a pilot table created before record_date was added.
alter table public.wallet_sync_pilot
  add column if not exists record_date timestamptz;

-- Backfill existing pilot rows from Wallet's original transaction timestamp.
update public.wallet_sync_pilot
set record_date = nullif(wallet_record->>'recordDate', '')::timestamptz
where record_date is null
  and nullif(wallet_record->>'recordDate', '') is not null;

create index if not exists wallet_sync_pilot_synced_at_idx
  on public.wallet_sync_pilot (synced_at desc);

create index if not exists wallet_sync_pilot_record_date_idx
  on public.wallet_sync_pilot (record_date desc);

-- Apps Script uses the Supabase secret/service role key from Script Properties.
grant all on table public.wallet_sync_pilot to service_role;
