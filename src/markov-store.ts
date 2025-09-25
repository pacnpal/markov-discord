import 'source-map-support/register';
import fs from 'fs/promises';
import path from 'path';
import { CONFIG_DIR } from './config/setup';
import L from './logger';

/**
 * Alias table entry for O(1) weighted sampling
 */
interface AliasEntry {
  /** The actual suffix word */
  word: string;
  /** Alias index for sampling */
  alias: number;
  /** Probability weight */
  weight: number;
}

/**
 * Serialized Markov chain prefix entry
 */
interface PrefixEntry {
  /** The prefix key (e.g., "word1 word2") */
  prefix: string;
  /** Array of possible suffix words with weights */
  suffixes: Array<{ word: string; weight: number }>;
  /** Alias table for optimized sampling */
  aliasTable?: AliasEntry[];
  /** Total weight sum for normalization */
  totalWeight: number;
}

/**
 * Markov Store - High-performance serialized chain storage with alias method sampling
 *
 * This replaces database queries with O(1) serialized lookups and uses the alias method
 * for constant-time weighted random sampling instead of O(n) weighted selection.
 */
export class MarkovStore {
  private storePath: string;
  private chains = new Map<string, PrefixEntry>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_DEBOUNCE_MS = 5000;

  constructor(guildId: string) {
    this.storePath = path.join(CONFIG_DIR, `markov_${guildId}.json`);
  }

  /**
   * Load chains from serialized storage
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, PrefixEntry>;

      this.chains.clear();
      for (const [key, value] of Object.entries(parsed)) {
        this.chains.set(key, value);
      }

      L.info({ chainCount: this.chains.size }, 'Loaded Markov chains from store');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        L.info('No existing chain store found, starting fresh');
      } else {
        L.error({ err }, 'Error loading Markov store');
      }
    }
  }

  /**
   * Save chains to serialized storage with debouncing
   */
  private async save(): Promise<void> {
    if (!this.dirty) return;

    try {
      // Cancel existing timer
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
      }

      // Debounce saves
      this.saveTimer = setTimeout(async () => {
        const data = Object.fromEntries(this.chains);
        await fs.writeFile(this.storePath, JSON.stringify(data, null, 0));
        this.dirty = false;
        L.trace({ chainCount: this.chains.size }, 'Saved Markov chains to store');
      }, this.SAVE_DEBOUNCE_MS);
    } catch (err) {
      L.error({ err }, 'Error saving Markov store');
    }
  }

  /**
   * Build alias table for O(1) weighted sampling
   * Implements the alias method: https://en.wikipedia.org/wiki/Alias_method
   */
  private buildAliasTable(suffixes: Array<{ word: string; weight: number }>): AliasEntry[] {
    const n = suffixes.length;
    if (n === 0) return [];

    const aliasTable: AliasEntry[] = new Array(n);
    const scaledWeights: number[] = new Array(n);
    const small: number[] = [];
    const large: number[] = [];

    // Scale weights to probabilities
    const totalWeight = suffixes.reduce((sum, s) => sum + s.weight, 0);
    for (let i = 0; i < n; i++) {
      scaledWeights[i] = (suffixes[i].weight / totalWeight) * n;
      if (scaledWeights[i] < 1) {
        small.push(i);
      } else {
        large.push(i);
      }
    }

    // Build alias table
    for (let i = 0; i < n; i++) {
      aliasTable[i] = {
        word: suffixes[i].word,
        alias: i, // Default to self
        weight: scaledWeights[i]
      };
    }

    while (small.length > 0 && large.length > 0) {
      const l = small.pop()!;
      const g = large.pop()!;

      aliasTable[l].alias = g;
      scaledWeights[g] = scaledWeights[g] + scaledWeights[l] - 1;

      if (scaledWeights[g] < 1) {
        small.push(g);
      } else {
        large.push(g);
      }
    }

    // Handle remaining entries
    while (large.length > 0) {
      const g = large.pop()!;
      scaledWeights[g] = 1;
    }

    while (small.length > 0) {
      const l = small.pop()!;
      scaledWeights[l] = 1;
    }

    return aliasTable;
  }

  /**
   * Sample from alias table in O(1) time
   */
  private sampleFromAliasTable(aliasTable: AliasEntry[]): string {
    if (aliasTable.length === 0) throw new Error('Empty alias table');

    const n = aliasTable.length;
    const i = Math.floor(Math.random() * n);
    const coinToss = Math.random();

    const entry = aliasTable[i];
    return coinToss < entry.weight ? entry.word : aliasTable[entry.alias].word;
  }

  /**
   * Add or update a prefix entry
   */
  addPrefix(prefix: string, suffix: string, weight = 1): void {
    let entry = this.chains.get(prefix);

    if (!entry) {
      entry = {
        prefix,
        suffixes: [],
        totalWeight: 0
      };
      this.chains.set(prefix, entry);
    }

    // Find existing suffix or add new one
    const existingSuffix = entry.suffixes.find(s => s.word === suffix);
    if (existingSuffix) {
      existingSuffix.weight += weight;
    } else {
      entry.suffixes.push({ word: suffix, weight });
    }

    entry.totalWeight += weight;

    // Rebuild alias table for optimization
    if (entry.suffixes.length > 1) {
      entry.aliasTable = this.buildAliasTable(entry.suffixes);
    }

    this.dirty = true;
    this.save(); // Trigger debounced save
  }

  /**
   * Get next word for a prefix using alias method (O(1))
   */
  getNext(prefix: string): string | null {
    const entry = this.chains.get(prefix);
    if (!entry || entry.suffixes.length === 0) {
      return null;
    }

    // Use alias table for O(1) sampling if available
    if (entry.aliasTable) {
      return this.sampleFromAliasTable(entry.aliasTable);
    }

    // Fallback to weighted random selection
    const totalWeight = entry.totalWeight;
    let random = Math.random() * totalWeight;

    for (const suffix of entry.suffixes) {
      random -= suffix.weight;
      if (random <= 0) {
        return suffix.word;
      }
    }

    // Fallback to first suffix (shouldn't happen with proper weights)
    return entry.suffixes[0].word;
  }

  /**
   * Generate a sequence of words from a starting prefix
   */
  generate(prefix: string, maxLength = 50): string[] {
    const result: string[] = prefix.split(' ');
    let currentPrefix = prefix;

    for (let i = 0; i < maxLength; i++) {
      const nextWord = this.getNext(currentPrefix);
      if (!nextWord) break;

      result.push(nextWord);

      // Update prefix for next iteration (sliding window)
      const words = result.slice(-2); // Keep last 2 words for state
      currentPrefix = words.join(' ');
    }

    return result;
  }

  /**
   * Get all prefixes (for debugging/analysis)
   */
  getAllPrefixes(): string[] {
    return Array.from(this.chains.keys());
  }

  /**
   * Get chain statistics
   */
  getStats() {
    return {
      prefixCount: this.chains.size,
      totalSuffixes: Array.from(this.chains.values())
        .reduce((sum, entry) => sum + entry.suffixes.length, 0),
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  /**
   * Clear all chains
   */
  clear(): void {
    this.chains.clear();
    this.dirty = true;
    this.save();
  }

  /**
   * Remove a specific prefix
   */
  removePrefix(prefix: string): void {
    if (this.chains.delete(prefix)) {
      this.dirty = true;
      this.save();
    }
  }

  /**
   * Import chains from database format (for migration)
   */
  async importFromDatabase(chains: Array<{ prefix: string; suffix: string; weight: number }>): Promise<void> {
    L.info({ chainCount: chains.length }, 'Importing chains from database');

    for (const chain of chains) {
      this.addPrefix(chain.prefix, chain.suffix, chain.weight);
    }

    this.dirty = true;
    await this.save();
    L.info('Chain import completed');
  }

  /**
   * Export chains to database format (for fallback)
   */
  exportToDatabase(): Array<{ prefix: string; suffix: string; weight: number }> {
    const result: Array<{ prefix: string; suffix: string; weight: number }> = [];

    for (const [prefix, entry] of this.chains) {
      for (const suffix of entry.suffixes) {
        result.push({
          prefix,
          suffix: suffix.word,
          weight: suffix.weight
        });
      }
    }

    return result;
  }
}

/**
 * Global store cache for performance
 */
const storeCache = new Map<string, MarkovStore>();

/**
 * Get or create a Markov store for a guild
 */
export async function getMarkovStore(guildId: string): Promise<MarkovStore> {
  if (!storeCache.has(guildId)) {
    const store = new MarkovStore(guildId);
    await store.load();
    storeCache.set(guildId, store);
  }

  return storeCache.get(guildId)!;
}

/**
 * Clear all cached stores
 */
export function clearAllStores(): void {
  storeCache.clear();
}