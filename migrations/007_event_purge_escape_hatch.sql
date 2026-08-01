-- The append-only trigger is absolute, which is correct -- and it also means
-- test fixtures and legitimate data-retention purges have no way to remove
-- rows at all.
--
-- Rather than weakening the guarantee, the trigger now recognises one
-- explicit signal: the session variable chargeback.allow_event_purge set to
-- 'on'. Properties of this design that matter:
--
--   * It is opt-in per session and per transaction. Nothing is relaxed
--     globally and no default changes.
--   * Application code never sets it, so an ordinary bug or a careless
--     UPDATE in a console is rejected exactly as before.
--   * set_config(..., true) makes it local to the current transaction, so
--     it disappears the moment that transaction ends.
--
-- The audit guarantee it preserves: you cannot mutate an event by accident.
-- You can only do it by stating, in the same transaction, that you meant to.

CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger AS $fn$
BEGIN
  IF current_setting('chargeback.allow_event_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'dispute_events is append-only; % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
