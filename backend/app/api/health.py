from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(tags=["health"])


@router.get("/health")
def health(session: Session = Depends(get_session)) -> dict:
    """Liveness + DB reachability. Confirms curated.intel_locations is present."""
    n = session.execute(text("SELECT count(*) FROM curated.intel_locations")).scalar()
    return {"status": "ok", "intel_locations": int(n or 0)}
