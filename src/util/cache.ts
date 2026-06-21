import { LRUCache } from "lru-cache";

export function createCache<T extends object>(ttlSeconds: number) {
  return new LRUCache<string, T>({
    max: 200,
    ttl: ttlSeconds * 1000,
    allowStale: false,
  });
}
