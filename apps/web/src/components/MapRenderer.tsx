import type { MapSpec } from '@hydro/shared-types';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Renders a MapSpec with MapLibre GL.
 *
 * No basemap is loaded by default. A water-resources map is read for its own
 * layers — the basin, the network, the gauges, the inundation extent — and a
 * commercial basemap would add an external dependency, an attribution
 * requirement and a network call for no analytical gain. Set
 * VITE_BASEMAP_STYLE to a MapLibre style URL to add one.
 */

const BASEMAP_STYLE = import.meta.env.VITE_BASEMAP_STYLE as string | undefined;

const STATION_COLORS: Record<string, string> = {
  streamgage: '#0f6fb8',
  precipitation: '#12897b',
  weather: '#e0721c',
  water_quality: '#7b3ff2',
  groundwater: '#8b5e34',
  reservoir: '#1a7f4b',
  snotel: '#4b5563',
};

/**
 * A valid, minimal style with no external dependencies: a solid background
 * that our GeoJSON layers draw on top of. No `glyphs` key is declared, so no
 * layer may use text — which is why every label in the map surface is rendered
 * in HTML overlays rather than as map symbols.
 */
const blankStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f6' } }],
};

export function MapRenderer({ spec, height = 420 }: { spec: MapSpec; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: BASEMAP_STYLE ?? blankStyle,
      center: spec.center,
      zoom: spec.zoom,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => setReady(true));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // The map instance is created once; layer changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    // Remove previously added layers and sources before rebuilding.
    for (const layer of m.getStyle().layers ?? []) {
      if (layer.id.startsWith('hc-')) m.removeLayer(layer.id);
    }
    for (const id of Object.keys(m.getStyle().sources ?? {})) {
      if (id.startsWith('hc-')) m.removeSource(id);
    }

    for (const layer of spec.layers) {
      const sourceId = `hc-src-${layer.id}`;
      const data = layer.data as GeoJSON.FeatureCollection | undefined;
      if (!data || !('features' in data)) continue;
      m.addSource(sourceId, { type: 'geojson', data });

      const hasPolygons = data.features.some((f) => f.geometry?.type?.includes('Polygon'));
      const hasLines = data.features.some((f) => f.geometry?.type?.includes('LineString'));
      const hasPoints = data.features.some((f) => f.geometry?.type?.includes('Point'));

      if (hasPolygons) {
        m.addLayer({
          id: `hc-${layer.id}-fill`,
          type: 'fill',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'fill-color': ['coalesce', ['get', 'color'], ['case', ['==', ['get', 'kind'], 'watershed'], '#1a80c7', '#79bdec']],
            'fill-opacity': ['case', ['==', ['get', 'kind'], 'watershed'], 0.1, 0.34],
          },
        });
        m.addLayer({
          id: `hc-${layer.id}-outline`,
          type: 'line',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'line-color': ['case', ['==', ['get', 'kind'], 'watershed'], '#0d5488', '#0f6fb8'],
            'line-width': ['case', ['==', ['get', 'kind'], 'watershed'], 2.2, 0.9],
          },
        });
      }
      if (hasLines) {
        m.addLayer({
          id: `hc-${layer.id}-line`,
          type: 'line',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': '#12897b',
            'line-width': ['interpolate', ['linear'], ['coalesce', ['get', 'streamOrder'], 3], 3, 1, 6, 3],
          },
        });
      }
      if (hasPoints) {
        m.addLayer({
          id: `hc-${layer.id}-point`,
          type: 'circle',
          source: sourceId,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 6,
            'circle-color': [
              'match',
              ['coalesce', ['get', 'stationType'], 'other'],
              ...Object.entries(STATION_COLORS).flat(),
              '#526176',
            ] as unknown as maplibregl.ExpressionSpecification,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.6,
          },
        });
      }
    }

    const identify = (e: maplibregl.MapMouseEvent) => {
      const features = m.queryRenderedFeatures(e.point).filter((f) => f.layer.id.startsWith('hc-'));
      setSelected(features[0]?.properties ?? null);
    };
    m.on('click', identify);
    m.getCanvas().style.cursor = 'crosshair';
    return () => {
      m.off('click', identify);
    };
  }, [ready, spec]);

  // Layer visibility toggles.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const layer of spec.layers) {
      const visibility = hidden.has(layer.id) ? 'none' : 'visible';
      for (const suffix of ['fill', 'outline', 'line', 'point']) {
        const id = `hc-${layer.id}-${suffix}`;
        if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', visibility);
      }
    }
  }, [hidden, ready, spec]);

  const legend = useMemo(
    () => spec.layers.flatMap((l) => (l.legend ?? []).map((entry) => ({ ...entry, layerId: l.id }))),
    [spec.layers],
  );

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2">
        <p className="text-sm font-semibold text-ink-900">{spec.title}</p>
      </figcaption>

      <div className="relative overflow-hidden rounded-md border border-ink-200" style={{ height }}>
        <div ref={container} className="h-full w-full" />

        {/* Layer control */}
        <div className="absolute left-2 top-2 max-w-[15rem] rounded-md border border-ink-200 bg-white/95 p-2 shadow-panel">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">Layers</p>
          <ul className="space-y-1">
            {spec.layers.map((l) => (
              <li key={l.id}>
                <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-700">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-hydro-600"
                    checked={!hidden.has(l.id)}
                    onChange={() =>
                      setHidden((prev) => {
                        const next = new Set(prev);
                        if (next.has(l.id)) next.delete(l.id);
                        else next.add(l.id);
                        return next;
                      })
                    }
                  />
                  {l.label}
                </label>
              </li>
            ))}
          </ul>
          {legend.length > 0 && (
            <>
              <p className="mb-1 mt-2 text-2xs font-semibold uppercase tracking-wide text-ink-500">Legend</p>
              <ul className="space-y-0.5">
                {legend.map((entry, i) => (
                  <li key={i} className="flex items-center gap-1.5 text-2xs text-ink-600">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: entry.color }} aria-hidden />
                    {entry.label}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Identify panel */}
        {selected && (
          <div className="absolute bottom-2 right-2 max-w-[18rem] rounded-md border border-ink-200 bg-white/97 p-2 shadow-panel">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-2xs font-semibold uppercase tracking-wide text-ink-500">Identify</p>
              <button type="button" className="text-2xs text-ink-400 hover:text-ink-700" onClick={() => setSelected(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <dl className="space-y-0.5">
              {Object.entries(selected)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .slice(0, 10)
                .map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-2xs">
                    <dt className="shrink-0 text-ink-500">{k}</dt>
                    <dd className="ml-auto truncate text-right font-medium text-ink-900">{String(v)}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )}

        {!BASEMAP_STYLE && (
          <p className="absolute bottom-1 right-2 text-[9px] text-ink-400">
            No basemap configured (VITE_BASEMAP_STYLE)
          </p>
        )}
      </div>

      <p className="mt-2 text-2xs leading-relaxed text-ink-500">{spec.caption}</p>
    </figure>
  );
}
