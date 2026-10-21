"""Which Novi DSU pad vintage erebor draws from raw_novi_intel.pads.

The warehouse keeps every loaded pad drop side by side, tagged by
report_version: the legacy '3Q25' polygons and, from engineering_db sql/66, the
official '2026Q3' DSU polygons (all of them — the DSU geometry of record). A
read that does not pin one vintage draws both sets on top of each other, so
every raw_novi_intel.pads reader goes through current_pads_version().

The two labels use different formats ('3Q25' from the file drops, '2026Q3' =
the Snowflake share's label), so "newest" is decided by vintage_key(), not by
string order ('3Q25' > '2026Q3' lexically) or by ingest time (a re-load of an
old drop would win).
"""

from __future__ import annotations

import re

from sqlalchemy import text
from sqlalchemy.orm import Session

_SHARE = re.compile(r"^(\d{4})Q([1-4])$")   # '2026Q3'
_DROP = re.compile(r"^([1-4])Q(\d{2})$")    # '3Q25'


def vintage_key(report_version: str) -> tuple[int, int] | None:
    """(year, quarter) for either label format; None when unparseable."""
    m = _SHARE.match(report_version)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = _DROP.match(report_version)
    if m:
        return 2000 + int(m.group(2)), int(m.group(1))
    return None


def newest_vintage(versions: list[str]) -> str | None:
    """The newest parseable vintage label, or None."""
    keyed = [(k, v) for v in versions if (k := vintage_key(v)) is not None]
    return max(keyed)[1] if keyed else None


def current_pads_version(session: Session, basin: str) -> str | None:
    """Newest Novi pad vintage loaded for the basin (None = no pads loaded)."""
    versions = session.execute(
        text("SELECT DISTINCT report_version FROM raw_novi_intel.pads WHERE basin = :basin"),
        {"basin": basin},
    ).scalars().all()
    return newest_vintage(list(versions))
