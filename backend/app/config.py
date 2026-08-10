from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Read DSN for the oilgas warehouse - the Supabase Supavisor transaction
    # pooler (:6543), set via DATABASE_URL in backend/.env. The default below
    # deliberately cannot resolve (.invalid TLD), so a missing .env fails loud
    # on the first query instead of silently hitting a local Postgres. Engine
    # creation is lazy, so tests (which never touch the DB) are unaffected.
    database_url: str = Field(
        default="postgresql+psycopg://set-database-url@in-backend-dotenv.invalid:6543/postgres",
        alias="DATABASE_URL",
    )
    pmtiles_path: Path = Field(
        default=Path("../../permian_type_curve/infra/basemap/permian.pmtiles"),
        alias="PMTILES_PATH",
    )
    # TX (GLO blocks/sections) + NM survey grid, reused from permian_type_curve.
    # Static dataset covering both basins; section number is LEVEL3_SUR.
    blocks_geojson_path: Path = Field(
        default=Path("../../permian_type_curve/infra/basemap/blocks_tx_nm.geojson"),
        alias="BLOCKS_GEOJSON_PATH",
    )
    sections_geojson_path: Path = Field(
        default=Path("../../permian_type_curve/infra/basemap/sections_tx_nm.geojson"),
        alias="SECTIONS_GEOJSON_PATH",
    )
    report_version: str = Field(default="3Q25", alias="REPORT_VERSION")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")


settings = Settings()
