-- =============================================================================
-- Schema guarantee tests. Run against a scratch database after schema.sql.
--
--   createdb golf && psql -d golf -f schema.sql && psql -d golf -f schema-tests.sql
--
-- Expected: rls_enabled_no_policy = 0; three ERRORs where marked (they are the
-- passing result); OUTSIDER sees 0 events and 0 event_players.
--
-- Verified green on PostgreSQL 16.15.
-- =============================================================================

\set ON_ERROR_STOP off
SELECT count(*) AS rls_enabled_no_policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid);

INSERT INTO organizations (id,name,slug) VALUES
 ('11111111-1111-1111-1111-111111111111','Divot Diggers','ddd'),
 ('22222222-2222-2222-2222-222222222222','Other Group','other');
INSERT INTO people (id,display_name,email) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','Justin','j@x.com'),
 ('bbbbbbbb-0000-0000-0000-000000000002','Outsider','o@y.com');
INSERT INTO org_members (org_id,person_id,role) VALUES
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','owner'),
 ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002','owner');
INSERT INTO events (id,org_id,name,year,status) VALUES
 ('eeeeeeee-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','DDD 2026',2026,'draft');

\echo '=== ruleset immutability (expect ERROR) ==='
INSERT INTO rulesets (id,org_id,key,name,version,document,published_at)
VALUES ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','ddd','DDD',1,'{"a":1}','now()');
UPDATE rulesets SET document='{"a":2}' WHERE id='dddddddd-0000-0000-0000-000000000001';

\echo '=== cup: same player on two teams (expect ERROR) ==='
INSERT INTO cup_teams (id,event_id,key,name) VALUES
 ('cccccccc-0000-0000-0000-00000000000a','eeeeeeee-0000-0000-0000-000000000001','a','Inglorious Bogies'),
 ('cccccccc-0000-0000-0000-00000000000b','eeeeeeee-0000-0000-0000-000000000001','b','Bad Birdies');
INSERT INTO event_players (id,event_id,person_id,starting_ptp,starting_ptp_source)
VALUES ('ffffffff-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',46,'carried');
INSERT INTO cup_team_members (cup_team_id,event_player_id) VALUES
 ('cccccccc-0000-0000-0000-00000000000a','ffffffff-0000-0000-0000-000000000001');
INSERT INTO cup_team_members (cup_team_id,event_player_id) VALUES
 ('cccccccc-0000-0000-0000-00000000000b','ffffffff-0000-0000-0000-000000000001');

\echo '=== ADVERSARIAL: org B reads org A ==='
CREATE ROLE app_user NOLOGIN;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE event_players FORCE ROW LEVEL SECURITY;

SET ROLE app_user;
SET app.person_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT 'insider' AS who, count(*) AS orgs_visible FROM organizations;
SELECT 'insider' AS who, count(*) AS events_visible FROM events;

SET app.person_id = 'bbbbbbbb-0000-0000-0000-000000000002';
SELECT 'OUTSIDER' AS who, count(*) AS orgs_visible FROM organizations;
SELECT 'OUTSIDER' AS who, count(*) AS events_visible FROM events;
SELECT 'OUTSIDER' AS who, count(*) AS event_players_visible FROM event_players;
RESET ROLE;
