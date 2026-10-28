-- Run ONCE as a PostgreSQL superuser on a DEVELOPMENT / CI server (fictional data only).
-- psql -v owner_pw="'...'" -v app_pw="'...'" -v db=ezz_dev -f scripts/bootstrap-roles.sql
-- ezz_owner: owns the schema, runs migrations. ezz_app: the API; least privilege, subject to RLS, no BYPASSRLS.
CREATE ROLE ezz_owner LOGIN PASSWORD :owner_pw NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ezz_app   LOGIN PASSWORD :app_pw   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE :db OWNER ezz_owner;
REVOKE ALL ON DATABASE :db FROM PUBLIC;
GRANT CONNECT ON DATABASE :db TO ezz_app;
