#!/usr/bin/env bash
# Tests for scripts/verify-dump.sh — the gate that decides whether a dump is a
# backup or just a file.
#
# Pure bash + gzip + awk. No database, no network, no secrets, no node_modules,
# so it runs in a bare worktree and on any CI runner. tests/unit/db-backup-
# verify-dump.test.ts wraps this so the repo's REQUIRED "Unit Tests" job runs it
# too — a verification script nothing executes is exactly the shape of defect it
# exists to catch.
#
# Usage: bash scripts/verify-dump.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${HERE}/verify-dump.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  echo "  ok   — $1"
}
nok() {
  FAIL=$((FAIL + 1))
  echo "  FAIL — $1" >&2
}

# Asserts the script's exit status for a fixture. Output is captured, never
# echoed on success, so a dump's contents can never reach a CI log.
expect_exit() {
  local want="$1" file="$2" desc="$3" out got
  out="$(bash "$VERIFY" "$file" 2>&1)"
  got=$?
  if [ "$got" -eq "$want" ]; then
    ok "$desc (exit $got)"
  else
    nok "$desc — wanted exit $want, got $got"
    echo "       output: $out" >&2
  fi
}

# ── fixtures ────────────────────────────────────────────────────────────────
# Shaped like real pg_dump plain output so the checks are exercised against the
# format they actually meet in production.

dump_preamble() {
  cat <<'SQL'
--
-- PostgreSQL database dump
--

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';
SET default_table_access_method = heap;
SQL
}

# A dump with N tables and no data at all — the CRM failure shape.
make_schema_only() {
  local out="$1"
  {
    dump_preamble
    cat <<'SQL'

--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id text NOT NULL,
    store_id text NOT NULL,
    total numeric(12,3) NOT NULL,
    status text NOT NULL
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id text NOT NULL,
    store_id text NOT NULL,
    name text NOT NULL,
    price numeric(12,3) NOT NULL
);

--
-- PostgreSQL database dump complete
--
SQL
  } | gzip >"$out"
}

# The same three tables WITH data — a healthy backup.
make_valid() {
  local out="$1"
  {
    dump_preamble
    cat <<'SQL'

--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id text NOT NULL,
    store_id text NOT NULL,
    total numeric(12,3) NOT NULL,
    status text NOT NULL
);

--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id text NOT NULL,
    store_id text NOT NULL,
    name text NOT NULL,
    price numeric(12,3) NOT NULL
);

--
-- Data for Name: stores; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stores (id, name, slug, created_at) FROM stdin;
str_1	Wady Al Juz	wady-al-juz	2026-01-04 10:00:00
str_2	Om Hassan	om-hassan	2026-02-11 09:30:00
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orders (id, store_id, total, status) FROM stdin;
ord_1	str_1	12.500	paid
ord_2	str_1	7.250	paid
ord_3	str_2	31.000	pending
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.products (id, store_id, name, price) FROM stdin;
prd_1	str_1	Olive Oil 500ml	4.750
prd_2	str_1	Zaatar 200g	1.900
prd_3	str_2	Date Cake	6.000
\.


--
-- PostgreSQL database dump complete
--
SQL
  } | gzip >"$out"
}

echo "verify-dump.sh — test suite"

VALID="$WORK/valid.sql.gz"
make_valid "$VALID"

EMPTY="$WORK/empty.sql.gz"
printf '' | gzip >"$EMPTY"

SCHEMA_ONLY="$WORK/schema-only.sql.gz"
make_schema_only "$SCHEMA_ONLY"

TRUNCATED="$WORK/truncated.sql.gz"
head -c 120 "$VALID" >"$TRUNCATED"

NOT_A_DUMP="$WORK/not-a-dump.sql.gz"
{
  echo "<html><head><title>502 Bad Gateway</title></head><body>"
  head -c 4000 /dev/zero | tr '\0' 'x'
  echo "</body></html>"
} | gzip >"$NOT_A_DUMP"

NO_TABLES="$WORK/no-tables.sql.gz"
{
  dump_preamble
  head -c 2000 /dev/zero | tr '\0' '-'
  echo
  echo "-- PostgreSQL database dump complete"
} | gzip >"$NO_TABLES"

# ── the four cases the fix is required to distinguish ───────────────────────
expect_exit 0 "$VALID" "a valid dump with data PASSES"
expect_exit 1 "$EMPTY" "an empty (zero-byte) dump FAILS — this is the artifact found in _backups"
expect_exit 1 "$TRUNCATED" "a truncated gzip FAILS"
expect_exit 1 "$SCHEMA_ONLY" "a schema-only dump FAILS the row check (3 tables, 0 rows)"

# ── the holes a weaker check would leave open ───────────────────────────────
expect_exit 1 "$NOT_A_DUMP" "a large non-dump payload FAILS despite clearing the byte floor"
expect_exit 1 "$NO_TABLES" "a dump with 0 tables AND 0 rows FAILS (rows<tables is 0<0 = false)"
expect_exit 1 "$WORK/does-not-exist.sql.gz" "a missing file FAILS"

# ── positive control: the suite is measuring something real ─────────────────
# A gate that silently tests nothing reports success forever. Prove the fixtures
# differ in the way the checks depend on, and that the valid one is not passing
# merely by being large.
valid_rows="$(gzip -dc "$VALID" | grep -c '^str_\|^ord_\|^prd_')"
if [ "$valid_rows" -eq 8 ]; then
  ok "positive control — the valid fixture really carries 8 data rows"
else
  nok "positive control — valid fixture carries $valid_rows data rows, expected 8"
fi

schema_bytes="$(gzip -dc "$SCHEMA_ONLY" | wc -c | tr -d ' ')"
if [ "$schema_bytes" -gt 1024 ]; then
  ok "positive control — the schema-only fixture is ${schema_bytes} bytes, so it clears the byte floor and is rejected on CONTENT"
else
  nok "positive control — schema-only fixture is only ${schema_bytes} bytes; it would be caught by size, not by the row check"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
