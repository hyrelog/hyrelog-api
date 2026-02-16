import type { ApiKeyInfo } from './apiKey.js';

/**
 * In-memory cache for API key lookups
 * TTL: 5 minutes
 * 
 * Maps hashedKey -> ApiKeyInfo to avoid cross-region DB queries
 */
interface CacheEntry {
  info: ApiKeyInfo;
  expiresAt: number;
}

class ApiKeyCache {
  private cache: Map<string, CacheEntry> = new Map();
  private keyIdToHashed: Map<string, string> = new Map(); // apiKeyId -> hashedKey (for invalidation on revoke)
  private readonly ttl = 5 * 60 * 1000; // 5 minutes in milliseconds

  get(hashedKey: string): ApiKeyInfo | null {
    const entry = this.cache.get(hashedKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.keyIdToHashed.delete(entry.info.id);
      this.cache.delete(hashedKey);
      return null;
    }
    return entry.info;
  }

  set(hashedKey: string, info: ApiKeyInfo): void {
    this.keyIdToHashed.set(info.id, hashedKey);
    this.cache.set(hashedKey, {
      info,
      expiresAt: Date.now() + this.ttl,
    });
  }

  clear(): void {
    this.cache.clear();
    this.keyIdToHashed.clear();
  }

  delete(hashedKey: string): void {
    const entry = this.cache.get(hashedKey);
    if (entry) this.keyIdToHashed.delete(entry.info.id);
    this.cache.delete(hashedKey);
  }

  /** Invalidate cache for a key by API key id (call after revoke/archive so effect is immediate). */
  deleteByKeyId(apiKeyId: string): void {
    const hashedKey = this.keyIdToHashed.get(apiKeyId);
    if (hashedKey) {
      this.cache.delete(hashedKey);
      this.keyIdToHashed.delete(apiKeyId);
    }
  }
}

// Singleton instance
let apiKeyCache: ApiKeyCache | null = null;

export function getApiKeyCache(): ApiKeyCache {
  if (!apiKeyCache) {
    apiKeyCache = new ApiKeyCache();
  }
  return apiKeyCache;
}

