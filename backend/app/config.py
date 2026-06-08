from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Direct read DSN for engineering_db's oilgas DB (curated.intel_*).
    database_url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/oilgas",
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
