import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

type CacheNamespace = 'search' | 'content';

interface CacheEntry<T> {
  key: string;
  namespace: CacheNamespace;
  data: T;
  cachedAt: number;
  ttlMs: number;
  version: 1;
}

/**
 * Deterministic JSON stringify with sorted keys to ensure stable hashes
 * regardless of object property insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function hashKey(namespace: CacheNamespace, payload: unknown): string {
  return createHash('sha256')
    .update(namespace + '|' + stableStringify(payload))
    .digest('hex');
}

export class DiskCache {
  private readonly baseDir: string;
  private readonly ttlMs: number;
  private readonly disabled: boolean;
  private readonly debug: boolean;
  /** Tracks whether each namespace directory has been created this session */
  private readonly ensuredDirs: Set<CacheNamespace> = new Set();
  /** Set to true if we failed to create the cache dir — avoids repeated errors */
  private broken = false;

  constructor(opts: { baseDir: string; ttlMs: number; disabled?: boolean }) {
    this.baseDir = opts.baseDir;
    this.ttlMs = opts.ttlMs;
    this.disabled = opts.disabled ?? false;
    this.debug = process.env.CACHE_DEBUG === 'true';
  }

  async get<T>(namespace: CacheNamespace, keyPayload: unknown): Promise<T | null> {
    if (this.disabled || this.broken) return null;

    const hash = hashKey(namespace, keyPayload);
    const filePath = this.filePath(namespace, hash);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry<T>;

      if (Date.now() > entry.cachedAt + entry.ttlMs) {
        if (this.debug) console.error(`[cache] expired: ${namespace}/${hash.slice(0, 8)}`);
        // Best-effort delete of stale entry
        fs.unlink(filePath).catch(() => undefined);
        return null;
      }

      if (this.debug) console.error(`[cache] hit: ${namespace}/${hash.slice(0, 8)} (${entry.key})`);
      return entry.data;
    } catch (err: unknown) {
      // ENOENT is a normal cache miss — anything else is a corrupted file
      // eslint-disable-next-line no-undef
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[cache] read error for ${namespace}/${hash.slice(0, 8)}, treating as miss:`, err);
        fs.unlink(filePath).catch(() => undefined);
      }
      return null;
    }
  }

  async set<T>(namespace: CacheNamespace, keyPayload: unknown, data: T): Promise<void> {
    if (this.disabled || this.broken) return;

    await this.ensureDir(namespace);
    if (this.broken) return;

    const hash = hashKey(namespace, keyPayload);
    const filePath = this.filePath(namespace, hash);
    const tmpPath = filePath + '.tmp';

    const entry: CacheEntry<T> = {
      key: stableStringify(keyPayload).slice(0, 120),
      namespace,
      data,
      cachedAt: Date.now(),
      ttlMs: this.ttlMs,
      version: 1,
    };

    try {
      await fs.writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
      await fs.rename(tmpPath, filePath);
      if (this.debug) console.error(`[cache] set: ${namespace}/${hash.slice(0, 8)}`);
    } catch (err) {
      console.error(`[cache] write error for ${namespace}/${hash.slice(0, 8)}:`, err);
      // Clean up temp file if rename failed
      fs.unlink(tmpPath).catch(() => undefined);
    }
  }

  /** Deletes all cache files across all namespaces. Returns count of deleted files. */
  async clearAll(): Promise<number> {
    if (this.broken) return 0;
    let count = 0;
    for (const ns of ['search', 'content'] as CacheNamespace[]) {
      const dir = join(this.baseDir, ns);
      try {
        const files = await fs.readdir(dir);
        await Promise.allSettled(
          files
            .filter(f => f.endsWith('.json'))
            .map(async f => {
              await fs.unlink(join(dir, f));
              count++;
            })
        );
      } catch {
        // Directory may not exist yet — that's fine
      }
    }
    // Reset ensuredDirs so next set() re-creates directories
    this.ensuredDirs.clear();
    console.error(`[cache] cleared ${count} entries from ${this.baseDir}`);
    return count;
  }

  private filePath(namespace: CacheNamespace, hash: string): string {
    return join(this.baseDir, namespace, hash + '.json');
  }

  private async ensureDir(namespace: CacheNamespace): Promise<void> {
    if (this.ensuredDirs.has(namespace)) return;
    try {
      await fs.mkdir(join(this.baseDir, namespace), { recursive: true });
      this.ensuredDirs.add(namespace);
    } catch (err) {
      console.error(`[cache] failed to create cache directory, disabling cache:`, err);
      this.broken = true;
    }
  }
}

/**
 * Factory that reads CACHE_TTL_HOURS, CACHE_DIR, CACHE_DISABLED from env
 * and returns a configured DiskCache instance.
 */
export function createDefaultCache(): DiskCache {
  const disabled = process.env.CACHE_DISABLED === '1' || process.env.CACHE_DISABLED === 'true';

  const ttlHours = parseFloat(process.env.CACHE_TTL_HOURS ?? '72');
  const ttlMs = (isNaN(ttlHours) || ttlHours < 0 ? 72 : ttlHours) * 60 * 60 * 1000;

  const defaultDir = (() => {
    try {
      return join(homedir(), '.cache', 'web-search-mcp');
    } catch {
      return join(tmpdir(), 'web-search-mcp');
    }
  })();
  const baseDir = process.env.CACHE_DIR ?? defaultDir;

  console.error(
    `[cache] init: dir=${baseDir}, ttl=${ttlHours}h, disabled=${disabled}`
  );

  return new DiskCache({ baseDir, ttlMs, disabled });
}
