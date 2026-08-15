import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTiles } from "@/features/catalogue/hooks/useTiles.js";
import { searchTiles } from "@/services/tiles.api.js";
import {
  normalizeTile,
  isTileCompatibleWithSurface,
} from "@/features/catalogue/lib/tile-adapter.js";

export const TILE_SEARCH_QUERY_KEY = (params) => ["catalogue", "search", params];

/**
 * Zone-aware tile search for the catalogue.
 *
 * When a text query or an active zone tab is set, results are fetched from
 * `GET /api/v1/tiles/search?q=&zone=` (the server routes through Elasticsearch
 * when configured, otherwise the Mongo $text/compatibleZones fallback). While
 * the request is in flight, and whenever it fails (backend unreachable / ES
 * down), the loaded tile list is filtered in-memory by `compatibleZones`, so
 * offline and seed-only builds keep working with no console errors.
 *
 * @param {{ q?: string, zone?: "all"|"floor"|"wall"|"counter" }} params
 * @returns {{ tiles: Object[], isSearching: boolean, isError: boolean, refetch: () => Promise }}
 */
export function useTileSearch({ q = "", zone = "all" } = {}) {
  const { tiles: allTiles } = useTiles();

  const trimmedQ = q.trim();
  const zoneActive = zone !== "all";
  const shouldSearch = trimmedQ !== "" || zoneActive;

  const query = useQuery({
    queryKey: TILE_SEARCH_QUERY_KEY({ q: trimmedQ, zone }),
    queryFn: async () => {
      const res = await searchTiles({
        q: trimmedQ,
        zone: zoneActive ? zone : undefined,
        limit: 100,
      });
      return (res.data || []).map(normalizeTile);
    },
    enabled: shouldSearch,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  // Graceful fallback — zone/compatibleZones client-side filter over the full
  // loaded list, used before the server responds and when it cannot.
  const fallbackTiles = useMemo(() => {
    let list = allTiles;
    if (zoneActive) {
      list = list.filter((t) => isTileCompatibleWithSurface(t, zone));
    }
    if (trimmedQ) {
      const needle = trimmedQ.toLowerCase();
      list = list.filter((t) =>
        `${t.name} ${t.material} ${t.finish} ${t.size} ${t.category}`
          .toLowerCase()
          .includes(needle)
      );
    }
    return list;
  }, [allTiles, zoneActive, zone, trimmedQ]);

  const tiles = query.isSuccess ? query.data : fallbackTiles;

  return {
    tiles,
    isSearching: shouldSearch && query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
  };
}