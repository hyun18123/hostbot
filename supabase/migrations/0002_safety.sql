-- Additional safety constraints for an existing installation.
-- Safe to run after 0001_init.sql.

-- One live hosting record per Discord bot. Re-registering the same bot with a
-- rotated token would otherwise start two containers for the same bot.
create unique index if not exists hosted_bots_active_discord_bot
  on public.hosted_bots(discord_bot_id)
  where deleted_at is null and discord_bot_id is not null;

-- Speed up owner lookups performed on every management-bot request.
create index if not exists users_discord_id_idx on public.users(discord_id);

-- Ensure the API role keeps table/sequence privileges on existing installs.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
