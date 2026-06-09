import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import (
    basemap,
    export,
    gunbarrel,
    health,
    highgrade,
    layers,
    production,
    select,
    tiles,
)
from app.config import settings

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(title="erebor API", version=__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(basemap.router, prefix="/api")
app.include_router(tiles.router, prefix="/api")
app.include_router(layers.router, prefix="/api")
app.include_router(select.router, prefix="/api")
app.include_router(production.router, prefix="/api")
app.include_router(gunbarrel.router, prefix="/api")
app.include_router(highgrade.router, prefix="/api")
app.include_router(export.router, prefix="/api")
