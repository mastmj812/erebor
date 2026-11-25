from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(tags=["health"])


@router.get("/health")
def health(session: Session = Depends(get_session)) -> dict:
    """Liveness + DB reachability. Confirms the relation erebor serves, curated.erebor_locations
    (BOX sticks + producing wells), is present. It used to count curated.intel_locations, a Novi
    Intelligence relation erebor only compares against and a quarterly reload drops and rebuilds."""
    n = session.execute(text("SELECT count(*) FROM curated.erebor_locations")).scalar()
    return {"status": "ok", "locations": int(n or 0)}
