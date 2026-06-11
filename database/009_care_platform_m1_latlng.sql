-- 009: denormalized lat/lng columns next to geography columns.
-- PostgREST returns geography as WKB hex which the API cannot echo back as
-- coordinates; plain numerics let forms re-display pins. The geography columns
-- remain the source for PostGIS queries (ST_DWithin in M3 matching).
-- rollback: alter table ... drop column home_lat/home_lng/service_area_lat/service_area_lng.

alter table care_elder_profiles
  add column if not exists home_lat numeric(9,6),
  add column if not exists home_lng numeric(9,6);

alter table care_caregiver_profiles
  add column if not exists service_area_lat numeric(9,6),
  add column if not exists service_area_lng numeric(9,6);
