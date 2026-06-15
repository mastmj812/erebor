"""Authoritative export: the current selection (AOI + rule), minus excluded
formations and manually-culled wells, as a multi-tab xlsx workbook for the
finance handoff. Sheet layout lives in ``app.exports.xlsx_builder``; data
gathering in ``app.exports.data`` (reusable outside HTTP — the future
"graduate DSU" workflow calls the same pair).

Economics in here are Novi's pre-computed numbers on one flat price deck — a
screen. The point of the export is to feed YOUR model.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.db import get_session
from app.exports.data import ExportBody, gather_export_data
from app.exports.xlsx_builder import XLSX_MEDIA_TYPE, build_workbook

router = APIRouter(prefix="/export", tags=["export"])

_FILENAME_OK_RE = re.compile(r"[^A-Za-z0-9 ._()-]+")


def _safe_filename(requested: str | None, basin: str) -> str:
    """Sanitized download name, ``.xlsx`` enforced.

    Strips path/header-unsafe chars (also closes off Content-Disposition
    header injection) and falls back to ``erebor_{basin}_{date}``.
    """
    name = requested or ""
    name = re.sub(r"\.(xlsx|zip)$", "", name.strip(), flags=re.IGNORECASE)
    name = _FILENAME_OK_RE.sub("_", name).strip(" .")[:80]
    if not name:
        name = f"erebor_{basin}_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    return f"{name}.xlsx"


@router.post("")
def export(body: ExportBody, session: Session = Depends(get_session)) -> Response:
    data = gather_export_data(session, body)
    content = build_workbook(data)
    fname = _safe_filename(body.filename, body.basin)
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
