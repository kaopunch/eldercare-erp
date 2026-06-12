-- 014: M6 hardening — pin search_path on ERP helper functions
-- (Supabase security advisor: function_search_path_mutable WARN)
-- rollback: alter function ... reset search_path;
alter function public.current_app_role() set search_path = public;
alter function public.current_app_user_id() set search_path = public;
alter function public.is_admin_role() set search_path = public;
alter function public.current_app_claims() set search_path = public;
