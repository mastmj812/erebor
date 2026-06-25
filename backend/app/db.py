from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

# erebor is a READ-ONLY client of the engineering_db warehouse (curated.intel_*).
# Against hosted Postgres (Supabase) the connection needs SSL, TCP keepalives so
# long spatial reads survive the pooler, and a search_path that includes
# `extensions` (Supabase installs PostGIS there, so geometry / ST_* resolve).
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
    future=True,
    connect_args={
        # SSL required by hosted Postgres (Supabase).
        "sslmode": "require",
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


@event.listens_for(engine, "connect")
def _warehouse_session_setup(dbapi_conn, _record):  # noqa: ANN001
    # Per-session GUCs, applied in autocommit so they persist for the whole
    # connection. We can't use libpq startup `options` because a transaction
    # pooler (Supabase/pgbouncer) strips it:
    #  - default_transaction_read_only: erebor never writes the warehouse; any
    #    accidental write raises ReadOnlySqlTransaction (SQLSTATE 25006).
    #  - statement_timeout=0: large curated.intel_* spatial reads must not hit a
    #    hosted instance's short default timeout.
    #  - search_path includes `extensions` so PostGIS types / ST_* resolve.
    prev = dbapi_conn.autocommit
    dbapi_conn.autocommit = True
    try:
        with dbapi_conn.cursor() as cur:
            cur.execute("SET default_transaction_read_only = on")
            cur.execute("SET statement_timeout = 0")
            cur.execute("SET search_path TO public, extensions")
    finally:
        dbapi_conn.autocommit = prev


SessionLocal = sessionmaker(
    bind=engine, autoflush=False, autocommit=False, expire_on_commit=False
)


def get_session() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
