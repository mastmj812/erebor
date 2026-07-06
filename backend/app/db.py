from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

# erebor is a READ-ONLY client of the engineering_db warehouse (curated.intel_*).
# Against hosted Postgres (Supabase) the connection needs SSL and TCP keepalives so
# long, quiet spatial reads survive the pooler.
#
# Sized for the Supavisor TRANSACTION pooler (DATABASE_URL port 6543), NOT the
# session pooler (5432): the session pooler hard-caps at 15 clients and repeated
# backend reloads strand idle server sessions until it fills, after which every
# DB-backed endpoint hangs then 500s while static tile/geojson endpoints keep
# working — that split is the tell. The transaction pooler multiplexes onto a
# shared backend pool and has no 15-client cap. Being correct on it requires:
#   1. Prepared statements OFF (prepare_threshold=None): transaction mode can't
#      reuse a server-side prepared statement across its multiplexed backend, so
#      leaving them on yields "prepared statement does not exist" errors.
#   2. Session-scoped GUCs must become TRANSACTION-scoped — see the `begin` hook
#      below. Neither a per-session `SET` (connect hook) NOR the libpq startup
#      `options` string reliably delivers statement_timeout / read-only on the
#      transaction pooler: verified against 6543, Supavisor forwards `search_path`
#      from startup options but silently DROPS statement_timeout and
#      default_transaction_read_only (each transaction lands on a different server
#      backend, so anything not re-applied per transaction is lost).
# pool_recycle + LIFO keep idle connections from being hoarded across reloads.
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
    pool_recycle=600,     # retire a connection 10 min after it opened (~narvi max_lifetime)
    pool_use_lifo=True,   # reuse hot connections; let the idle tail age out and recycle
    future=True,
    connect_args={
        # SSL required by hosted Postgres (Supabase).
        "sslmode": "require",
        # Disable psycopg3 prepared statements — the transaction pooler can't reuse
        # them across its multiplexed server connection.
        "prepare_threshold": None,
        # Fail fast if the warehouse is unreachable rather than hanging on the
        # default ~75s TCP timeout.
        "connect_timeout": 5,
        # Keep long, quiet spatial reads alive through a connection pooler.
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    },
)


@event.listens_for(engine, "begin")
def _begin_readonly_bounded(conn):  # noqa: ANN001
    # Apply the warehouse GUCs at the start of EVERY transaction. This is the only
    # scope that survives the Supavisor transaction pooler (port 6543): `SET LOCAL`
    # / `SET TRANSACTION` bind to the current transaction, which the pooler pins to
    # a single server backend, so they hold for every statement in the unit and
    # reset cleanly afterwards. A connect-time `SET` or startup `options` would be
    # dropped on the next multiplexed backend (verified empirically). Runs as the
    # first statements of the transaction, before any app query.
    #   - READ ONLY: erebor never writes the warehouse; a stray write now raises
    #     ReadOnlySqlTransaction (SQLSTATE 25006).
    #   - statement_timeout=300s: a generous CEILING so a query stuck on a
    #     slow/unreachable pooler self-aborts (SQLSTATE 57014) and frees the worker,
    #     rather than a no-timeout read wedging `uvicorn --reload`. Far above any
    #     legit curated.intel_* spatial read.
    #   - search_path: the role baseline already carries `extensions` (where
    #     Supabase installs PostGIS), but pin it so ST_* keeps resolving if that
    #     default ever changes.
    conn.exec_driver_sql("SET TRANSACTION READ ONLY")
    conn.exec_driver_sql("SET LOCAL statement_timeout = '300s'")
    conn.exec_driver_sql("SET LOCAL search_path TO public, extensions")


SessionLocal = sessionmaker(
    bind=engine, autoflush=False, autocommit=False, expire_on_commit=False
)


def get_session() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
