"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppConfig = exports.LogLevel = void 0;
/* eslint-disable @typescript-eslint/no-empty-function, no-useless-constructor, max-classes-per-file */
require("reflect-metadata");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
var LogLevel;
(function (LogLevel) {
    LogLevel["SILENT"] = "silent";
    LogLevel["ERROR"] = "error";
    LogLevel["WARN"] = "warn";
    LogLevel["INFO"] = "info";
    LogLevel["DEBUG"] = "debug";
    LogLevel["TRACE"] = "trace";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
/**
 * The config file supports [JSON5](https://json5.org/) syntax. It supports both `.json` and `.json5` extensions if you prefer one over the other.
 * @example ```jsonc
 * {
 *   "token": "k5NzE2NDg1MTIwMjc0ODQ0Nj.DSnXwg.ttNotARealToken5p3WfDoUxhiH",
 *   "commandPrefix": "!mark",
 *   "activity": "\"!mark help\" for help",
 *   "ownerIds": ["00000000000000000"],
 *   "logLevel": "info",
 * }
 * ```
 */
class AppConfig {
    constructor() {
        /**
         * Your Discord bot token
         * @example k5NzE2NDg1MTIwMjc0ODQ0Nj.DSnXwg.ttNotARealToken5p3WfDoUxhiH
         * @env TOKEN
         */
        this.token = process.env.TOKEN || '';
        /**
         * The command prefix used to trigger the bot commands (when not using slash commands)
         * @example !bot
         * @default !mark
         * @env MESSAGE_COMMAND_PREFIX
         */
        this.messageCommandPrefix = process.env.MESSAGE_COMMAND_PREFIX || '!mark';
        /**
         * The slash command name to generate a message from the bot. (e.g. `/mark`)
         * @example message
         * @default mark
         * @env SLASH_COMMAND_NAME
         */
        this.slashCommandName = process.env.SLASH_COMMAND_NAME || 'mark';
        /**
         * The activity status shown under the bot's name in the user list
         * @example "!mark help" for help
         * @default !mark help
         * @env ACTIVITY
         */
        this.activity = process.env.ACTIVITY || '!mark help';
        /**
         * A list of Discord user IDs that have owner permissions for the bot
         * @example ["82684276755136512"]
         * @default []
         * @env OWNER_IDS (comma separated)
         */
        this.ownerIds = process.env.OWNER_IDS ? process.env.OWNER_IDS.split(',').map((id) => id.trim()) : [];
        /**
         * If provided, the standard "generate response" command will only work for a user in this list of role IDs.
         * Moderators and owners configured in `ownerIds` do not bypass this check, so make sure to add them to a valid role as well.
         * @example ["734548250895319070"]
         * @default []
         * @env USER_ROLE_IDS (comma separated)
         */
        this.userRoleIds = process.env.USER_ROLE_IDS
            ? process.env.USER_ROLE_IDS.split(',').map((id) => id.trim())
            : [];
        /**
         * TZ name from this list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List
         * @example America/Chicago
         * @default UTC
         * @env TZ
         */
        this.timezone = process.env.TZ || 'UTC';
        /**
         * Log level in lower case. Can be [silent, error, warn, info, debug, trace]
         * @example debug
         * @default info
         * @env LOG_LEVEL
         */
        this.logLevel = process.env.LOG_LEVEL || LogLevel.INFO;
        /**
         * The stateSize is the number of words for each "link" of the generated sentence.
         * 1 will output gibberish sentences without much sense.
         * 2 is a sensible default for most cases.
         * 3 and more can create good sentences if you have a corpus that allows it.
         * @example 3
         * @default 2
         * @env STATE_SIZE
         */
        this.stateSize = process.env.STATE_SIZE ? parseInt(process.env.STATE_SIZE, 10) : 2;
        /**
         * The number of tries the sentence generator will try before giving up
         * @example 2000
         * @default 1000
         * @env MAX_TRIES
         */
        this.maxTries = process.env.MAX_TRIES ? parseInt(process.env.MAX_TRIES, 10) : 1000;
        /**
         * The minimum score required when generating a sentence.
         * A relative "score" based on the number of possible permutations.
         * Higher is "better", but the actual value depends on your corpus.
         * @example 15
         * @default 10
         * @env MIN_SCORE
         */
        this.minScore = process.env.MIN_SCORE ? parseInt(process.env.MIN_SCORE, 10) : 10;
        /**
         * This guild ID should be declared if you want its commands to update immediately during development
         * @example 1234567890
         * @env DEV_GUILD_ID
         */
        this.devGuildId = process.env.DEV_GUILD_ID;
        /**
         * A list of channel IDs where the bot will respond to mentions.
         * If empty, the bot will respond to mentions in any channel.
         * @example ["734548250895319070"]
         * @default []
         * @env RESPONSE_CHANNEL_IDS (comma separated)
         */
        this.responseChannelIds = process.env.RESPONSE_CHANNEL_IDS
            ? process.env.RESPONSE_CHANNEL_IDS.split(',').map((id) => id.trim())
            : [];
        // ===== PERFORMANCE OPTIMIZATION SETTINGS =====
        /**
         * Enable the optimized MarkovStore with O(1) alias method sampling
         * When enabled, replaces markov-strings-db with serialized chain store
         * @example true
         * @default false
         * @env ENABLE_MARKOV_STORE
         */
        this.enableMarkovStore = process.env.ENABLE_MARKOV_STORE === 'true' || false;
        /**
         * Enable worker thread pool for CPU-intensive operations
         * Offloads chain building and generation to background threads
         * @example true
         * @default false
         * @env ENABLE_WORKER_POOL
         */
        this.enableWorkerPool = process.env.ENABLE_WORKER_POOL === 'true' || false;
        /**
         * Number of worker threads for the worker pool
         * Recommended: Number of CPU cores or 4, whichever is smaller
         * @example 4
         * @default 4
         * @env WORKER_POOL_SIZE
         */
        this.workerPoolSize = process.env.WORKER_POOL_SIZE ? parseInt(process.env.WORKER_POOL_SIZE, 10) : 4;
        /**
         * Enable batch processing optimizations in training
         * Uses worker pool for parallel batch processing
         * @example true
         * @default false
         * @env ENABLE_BATCH_OPTIMIZATION
         */
        this.enableBatchOptimization = process.env.ENABLE_BATCH_OPTIMIZATION === 'true' || false;
        /**
         * Batch size for training operations
         * Higher values use more memory but may be more efficient
         * @example 2000
         * @default 2000
         * @env BATCH_SIZE
         */
        this.batchSize = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : 2000;
        /**
         * Memory limit for chain caching (in MB)
         * MarkovStore will use LRU eviction when this limit is reached
         * @example 256
         * @default 128
         * @env CHAIN_CACHE_MEMORY_LIMIT
         */
        this.chainCacheMemoryLimit = process.env.CHAIN_CACHE_MEMORY_LIMIT ? parseInt(process.env.CHAIN_CACHE_MEMORY_LIMIT, 10) : 128;
        /**
         * Debounce delay for chain persistence (in milliseconds)
         * Higher values reduce disk I/O but increase risk of data loss
         * @example 5000
         * @default 5000
         * @env CHAIN_SAVE_DEBOUNCE_MS
         */
        this.chainSaveDebounceMs = process.env.CHAIN_SAVE_DEBOUNCE_MS ? parseInt(process.env.CHAIN_SAVE_DEBOUNCE_MS, 10) : 5000;
        /**
         * Percentage of guilds to enable optimizations for (0-100)
         * Allows gradual rollout of performance optimizations
         * @example 10
         * @default 0
         * @env OPTIMIZATION_ROLLOUT_PERCENTAGE
         */
        this.optimizationRolloutPercentage = process.env.OPTIMIZATION_ROLLOUT_PERCENTAGE ? parseFloat(process.env.OPTIMIZATION_ROLLOUT_PERCENTAGE) : 0;
        /**
         * List of guild IDs to force-enable optimizations for (canary testing)
         * These guilds will always use optimizations regardless of rollout percentage
         * @example ["1234567890", "0987654321"]
         * @default []
         * @env OPTIMIZATION_FORCE_GUILD_IDS (comma separated)
         */
        this.optimizationForceGuildIds = process.env.OPTIMIZATION_FORCE_GUILD_IDS
            ? process.env.OPTIMIZATION_FORCE_GUILD_IDS.split(',').map((id) => id.trim())
            : [];
        /**
         * Enable performance monitoring and metrics collection
         * Collects timing data for optimization validation
         * @example true
         * @default false
         * @env ENABLE_PERFORMANCE_MONITORING
         */
        this.enablePerformanceMonitoring = process.env.ENABLE_PERFORMANCE_MONITORING === 'true' || false;
    }
}
exports.AppConfig = AppConfig;
__decorate([
    (0, class_validator_1.IsDefined)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "token", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "messageCommandPrefix", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "slashCommandName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "activity", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_transformer_1.Type)(() => String),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "ownerIds", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_transformer_1.Type)(() => String),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "userRoleIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "timezone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(LogLevel),
    __metadata("design:type", Object)
], AppConfig.prototype, "logLevel", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "stateSize", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "maxTries", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "devGuildId", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_transformer_1.Type)(() => String),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "responseChannelIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "enableMarkovStore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "enableWorkerPool", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(16),
    __metadata("design:type", Object)
], AppConfig.prototype, "workerPoolSize", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "enableBatchOptimization", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(100),
    (0, class_validator_1.Max)(10000),
    __metadata("design:type", Object)
], AppConfig.prototype, "batchSize", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(64),
    (0, class_validator_1.Max)(2048),
    __metadata("design:type", Object)
], AppConfig.prototype, "chainCacheMemoryLimit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1000),
    (0, class_validator_1.Max)(30000),
    __metadata("design:type", Object)
], AppConfig.prototype, "chainSaveDebounceMs", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Object)
], AppConfig.prototype, "optimizationRolloutPercentage", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_transformer_1.Type)(() => String),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "optimizationForceGuildIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Object)
], AppConfig.prototype, "enablePerformanceMonitoring", void 0);
