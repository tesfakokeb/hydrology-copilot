# Python scientific service.
#
# Built from services/science. The heavy optional stacks (PyTorch for LSTM/GRU,
# geopandas/rasterio/xarray for geospatial and NetCDF work) are NOT installed
# by default — they add gigabytes to the image and the service reports their
# absence explicitly rather than failing. Uncomment the lines below, or extend
# this image, when you need them.

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-deep.txt requirements-geo.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Optional stacks — uncomment to enable the models and readers they unlock.
# RUN pip install --no-cache-dir -r requirements-deep.txt   # LSTM, GRU
# RUN pip install --no-cache-dir -r requirements-geo.txt    # NetCDF, GeoTIFF, shapefile

COPY hydro_science/ hydro_science/
COPY tests/ tests/
COPY pyproject.toml ./

RUN useradd --system --create-home --uid 10002 science && chown -R science:science /srv
USER science

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "hydro_science.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
