"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkovStore = void 0;
exports.getMarkovStore = getMarkovStore;
exports.clearAllStores = clearAllStores;
require("source-map-support/register");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const setup_1 = require("./config/setup");
const logger_1 = __importDefault(require("./logger"));
/**
 * Markov Store - High-performance serialized chain storage with alias method sampling
 *
 * This replaces database queries with O(1) serialized lookups and uses the alias method
 * for constant-time weighted random sampling instead of O(n) weighted selection.
 */
class MarkovStore {
    constructor(guildId) {
        this.chains = new Map();
        this.dirty = false;
        this.saveTimer = null;
        this.SAVE_DEBOUNCE_MS = 5000;
        this.storePath = path_1.default.join(setup_1.CONFIG_DIR, `markov_${guildId}.json`);
    }
    /**
     * Load chains from serialized storage
     */
    async load() {
        try {
            const data = await promises_1.default.readFile(this.storePath, 'utf-8');
            const parsed = JSON.parse(data);
            this.chains.clear();
            for (const [key, value] of Object.entries(parsed)) {
                this.chains.set(key, value);
            }
            logger_1.default.info({ chainCount: this.chains.size }, 'Loaded Markov chains from store');
        }
        catch (err) {
            if (err.code === 'ENOENT') {
                logger_1.default.info('No existing chain store found, starting fresh');
            }
            else {
                logger_1.default.error({ err }, 'Error loading Markov store');
            }
        }
    }
    /**
     * Save chains to serialized storage with debouncing
     */
    async save() {
        if (!this.dirty)
            return;
        try {
            // Cancel existing timer
            if (this.saveTimer) {
                clearTimeout(this.saveTimer);
            }
            // Debounce saves
            this.saveTimer = setTimeout(async () => {
                const data = Object.fromEntries(this.chains);
                await promises_1.default.writeFile(this.storePath, JSON.stringify(data, null, 0));
                this.dirty = false;
                logger_1.default.trace({ chainCount: this.chains.size }, 'Saved Markov chains to store');
            }, this.SAVE_DEBOUNCE_MS);
        }
        catch (err) {
            logger_1.default.error({ err }, 'Error saving Markov store');
        }
    }
    /**
     * Build alias table for O(1) weighted sampling
     * Implements the alias method: https://en.wikipedia.org/wiki/Alias_method
     */
    buildAliasTable(suffixes) {
        const n = suffixes.length;
        if (n === 0)
            return [];
        const aliasTable = new Array(n);
        const scaledWeights = new Array(n);
        const small = [];
        const large = [];
        // Scale weights to probabilities
        const totalWeight = suffixes.reduce((sum, s) => sum + s.weight, 0);
        for (let i = 0; i < n; i++) {
            scaledWeights[i] = (suffixes[i].weight / totalWeight) * n;
            if (scaledWeights[i] < 1) {
                small.push(i);
            }
            else {
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
            const l = small.pop();
            const g = large.pop();
            aliasTable[l].alias = g;
            scaledWeights[g] = scaledWeights[g] + scaledWeights[l] - 1;
            if (scaledWeights[g] < 1) {
                small.push(g);
            }
            else {
                large.push(g);
            }
        }
        // Handle remaining entries
        while (large.length > 0) {
            const g = large.pop();
            scaledWeights[g] = 1;
        }
        while (small.length > 0) {
            const l = small.pop();
            scaledWeights[l] = 1;
        }
        return aliasTable;
    }
    /**
     * Sample from alias table in O(1) time
     */
    sampleFromAliasTable(aliasTable) {
        if (aliasTable.length === 0)
            throw new Error('Empty alias table');
        const n = aliasTable.length;
        const i = Math.floor(Math.random() * n);
        const coinToss = Math.random();
        const entry = aliasTable[i];
        return coinToss < entry.weight ? entry.word : aliasTable[entry.alias].word;
    }
    /**
     * Add or update a prefix entry
     */
    addPrefix(prefix, suffix, weight = 1) {
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
        }
        else {
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
    getNext(prefix) {
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
    generate(prefix, maxLength = 50) {
        const result = prefix.split(' ');
        let currentPrefix = prefix;
        for (let i = 0; i < maxLength; i++) {
            const nextWord = this.getNext(currentPrefix);
            if (!nextWord)
                break;
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
    getAllPrefixes() {
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
    clear() {
        this.chains.clear();
        this.dirty = true;
        this.save();
    }
    /**
     * Remove a specific prefix
     */
    removePrefix(prefix) {
        if (this.chains.delete(prefix)) {
            this.dirty = true;
            this.save();
        }
    }
    /**
     * Import chains from database format (for migration)
     */
    async importFromDatabase(chains) {
        logger_1.default.info({ chainCount: chains.length }, 'Importing chains from database');
        for (const chain of chains) {
            this.addPrefix(chain.prefix, chain.suffix, chain.weight);
        }
        this.dirty = true;
        await this.save();
        logger_1.default.info('Chain import completed');
    }
    /**
     * Export chains to database format (for fallback)
     */
    exportToDatabase() {
        const result = [];
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
exports.MarkovStore = MarkovStore;
/**
 * Global store cache for performance
 */
const storeCache = new Map();
/**
 * Get or create a Markov store for a guild
 */
async function getMarkovStore(guildId) {
    if (!storeCache.has(guildId)) {
        const store = new MarkovStore(guildId);
        await store.load();
        storeCache.set(guildId, store);
    }
    return storeCache.get(guildId);
}
/**
 * Clear all cached stores
 */
function clearAllStores() {
    storeCache.clear();
}
