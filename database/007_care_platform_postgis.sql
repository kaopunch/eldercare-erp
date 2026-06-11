-- 007: enable PostGIS for อุ่นใจ Care Platform (geography points, service areas, geofencing)
-- rollback: drop extension postgis; (only safe while no care_* table has geography columns)
create extension if not exists postgis with schema extensions;
