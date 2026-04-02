"""Postgres-backed JSON document store for tracker app runtime state."""
from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager

import psycopg


_SCHEMA_INIT_LOCK = threading.Lock()
_SCHEMA_INIT_DONE = False

DOC_AUTHOR_OVERRIDES = "author_overrides_v1"
DOC_AUTHORS_RUNTIME = "authors_runtime_v1"
DOC_TRACKER_OVERRIDES = "tracker_overrides_v1"
DOC_CALLBACKS = "callbacks_v1"
DOC_SHEET_URLS = "consultant_sheet_urls_v1"


def get_env(*names: str) -> str:
    for name in names:
        val = os.getenv(name)
        if val:
            return val
    return ""


def get_postgres_dsn() -> str:
    # Prefer non-pooled/unpooled for serverless write operations.
    return get_env(
        "DATABASE_URL_UNPOOLED",
        "POSTGRES_URL_NON_POOLING",
        "DATABASE_URL",
        "POSTGRES_URL",
    )


def db_available() -> bool:
    return bool(get_postgres_dsn())


@contextmanager
def db_conn():
    dsn = get_postgres_dsn()
    if not dsn:
        raise RuntimeError("Postgres database not configured")
    conn = psycopg.connect(dsn, autocommit=True)
    try:
        ensure_schema(conn)
        yield conn
    finally:
        conn.close()


def ensure_schema(conn) -> None:
    global _SCHEMA_INIT_DONE
    if _SCHEMA_INIT_DONE:
        return
    with _SCHEMA_INIT_LOCK:
        if _SCHEMA_INIT_DONE:
            return
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS app_documents (
                  key TEXT PRIMARY KEY,
                  value JSONB NOT NULL,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
        _SCHEMA_INIT_DONE = True


def get_doc(key: str, default=None):
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT value FROM app_documents WHERE key = %s", (key,))
        row = cur.fetchone()
        if not row:
            return default
        return row[0]


def set_doc(key: str, value) -> None:
    payload = json.dumps(value)
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO app_documents (key, value, updated_at)
            VALUES (%s, %s::jsonb, NOW())
            ON CONFLICT (key)
            DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """,
            (key, payload),
        )


def merge_doc_object(key: str, patch: dict) -> dict:
    base = get_doc(key, default={}) or {}
    if not isinstance(base, dict):
        base = {}
    for k, v in (patch or {}).items():
        base[k] = v
    set_doc(key, base)
    return base


def delete_doc_object_keys(key: str, keys: list[str]) -> dict:
    base = get_doc(key, default={}) or {}
    if not isinstance(base, dict):
        base = {}
    for k in keys or []:
        base.pop(k, None)
    set_doc(key, base)
    return base


def get_all_runtime_state() -> dict:
    author_overrides = get_doc(DOC_AUTHOR_OVERRIDES, default={}) or {}
    authors_runtime = get_doc(DOC_AUTHORS_RUNTIME, default=None)
    tracker_overrides = get_doc(DOC_TRACKER_OVERRIDES, default={}) or {}
    callbacks = get_doc(DOC_CALLBACKS, default=[]) or []
    consultant_sheet_urls = get_doc(DOC_SHEET_URLS, default={}) or {}
    if not isinstance(author_overrides, dict):
        author_overrides = {}
    if authors_runtime is not None and not isinstance(authors_runtime, list):
        authors_runtime = None
    if not isinstance(tracker_overrides, dict):
        tracker_overrides = {}
    if not isinstance(callbacks, list):
        callbacks = []
    if not isinstance(consultant_sheet_urls, dict):
        consultant_sheet_urls = {}
    return {
        "db": {"configured": True, "provider": "postgres"},
        "authorOverrides": author_overrides,
        "authorsRuntime": authors_runtime,
        "trackerOverrides": tracker_overrides,
        "callbacks": callbacks,
        "consultantSheetUrls": consultant_sheet_urls,
    }
