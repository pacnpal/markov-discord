"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerPool = void 0;
exports.getWorkerPool = getWorkerPool;
exports.shutdownWorkerPool = shutdownWorkerPool;
const worker_threads_1 = require("worker_threads");
const events_1 = require("events");
const path_1 = __importDefault(require("path"));
const logger_1 = __importDefault(require("../logger"));
/**
 * Worker pool for managing Markov worker threads
 */
class WorkerPool extends events_1.EventEmitter {
    constructor(maxWorkers = 4) {
        super();
        this.workers = [];
        this.taskQueue = [];
        this.activeTasks = new Map();
        this.maxWorkers = maxWorkers;
        this.workerPath = path_1.default.join(__dirname, 'markov-worker.js');
        this.initializeWorkers();
    }
    /**
     * Initialize worker threads
     */
    async initializeWorkers() {
        logger_1.default.info({ maxWorkers: this.maxWorkers }, 'Initializing worker pool');
        for (let i = 0; i < this.maxWorkers; i++) {
            await this.createWorker(i);
        }
        logger_1.default.info({ workerCount: this.workers.length }, 'Worker pool initialized');
    }
    /**
     * Create a single worker
     */
    async createWorker(workerId) {
        return new Promise((resolve, reject) => {
            const worker = new worker_threads_1.Worker(this.workerPath, {
                workerData: { workerId },
            });
            // Handle worker ready message
            worker.once('message', (message) => {
                if (message.success && message.result?.status === 'ready') {
                    logger_1.default.info({ workerId }, 'Worker ready');
                    resolve();
                }
                else {
                    reject(new Error(message.error || 'Worker failed to initialize'));
                }
            });
            // Handle worker errors
            worker.on('error', (error) => {
                logger_1.default.error({ workerId, error: error.message }, 'Worker error');
                this.handleWorkerError(workerId, error);
            });
            worker.on('exit', (code) => {
                logger_1.default.warn({ workerId, code }, 'Worker exited');
                this.handleWorkerExit(workerId, code);
            });
            // Handle task results
            worker.on('message', (message) => {
                if (message.success === false || message.success === true) {
                    this.handleTaskResult(message);
                }
            });
            this.workers[workerId] = worker;
            this.emit('workerCreated', workerId);
        });
    }
    /**
     * Handle worker errors
     */
    handleWorkerError(workerId, error) {
        logger_1.default.error({ workerId, error: error.message }, 'Worker error, restarting');
        // Remove failed worker
        const worker = this.workers[workerId];
        if (worker) {
            worker.terminate();
            delete this.workers[workerId];
        }
        // Restart worker
        setTimeout(() => {
            this.createWorker(workerId).catch((err) => {
                logger_1.default.error({ workerId, error: err }, 'Failed to restart worker');
            });
        }, 1000);
    }
    /**
     * Handle worker exit
     */
    handleWorkerExit(workerId, code) {
        if (code !== 0) {
            logger_1.default.warn({ workerId, code }, 'Worker exited with non-zero code, restarting');
            setTimeout(() => {
                this.createWorker(workerId).catch((err) => {
                    logger_1.default.error({ workerId, error: err }, 'Failed to restart worker');
                });
            }, 1000);
        }
    }
    /**
     * Handle task completion
     */
    handleTaskResult(message) {
        const task = this.activeTasks.get(message.workerId);
        if (!task) {
            logger_1.default.warn({ workerId: message.workerId }, 'Received result for unknown task');
            return;
        }
        this.activeTasks.delete(message.workerId);
        if (message.success) {
            task.resolve(message.result);
        }
        else {
            task.reject(new Error(message.error || 'Worker task failed'));
        }
        // Process next task
        this.processNextTask();
    }
    /**
     * Process next task from queue
     */
    processNextTask() {
        if (this.taskQueue.length === 0)
            return;
        // Find available worker
        const availableWorkerId = this.findAvailableWorker();
        if (availableWorkerId === -1)
            return;
        // Get highest priority task
        const sortedTasks = this.taskQueue.sort((a, b) => b.priority - a.priority);
        const task = sortedTasks.shift();
        this.taskQueue = sortedTasks;
        this.activeTasks.set(String(availableWorkerId), task);
        // Send task to worker
        const worker = this.workers[availableWorkerId];
        if (worker) {
            worker.postMessage({
                type: task.type,
                data: task.data,
                taskId: task.id
            });
        }
    }
    /**
     * Find available worker
     */
    findAvailableWorker() {
        for (let i = 0; i < this.maxWorkers; i++) {
            if (this.workers[i] && !this.activeTasks.has(String(i))) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Submit a task to the worker pool
     */
    async submitTask(type, data, priority = 1) {
        return new Promise((resolve, reject) => {
            const task = {
                id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type,
                data,
                resolve,
                reject,
                priority,
                timestamp: Date.now()
            };
            this.taskQueue.push(task);
            this.processNextTask();
        });
    }
    /**
     * Build chains from training data
     */
    async buildChains(guildId, messages, clearExisting = false, priority = 1) {
        const workerData = {
            guildId,
            messages,
            clearExisting
        };
        return this.submitTask('build-chains', workerData, priority);
    }
    /**
     * Generate response using worker
     */
    async generateResponse(guildId, prefix, maxLength = 50, temperature = 1.0, priority = 1) {
        const workerData = {
            guildId,
            prefix,
            maxLength,
            temperature
        };
        return this.submitTask('generate-response', workerData, priority);
    }
    /**
     * Batch update chains
     */
    async batchUpdate(guildId, updates, operation, priority = 1) {
        const workerData = {
            guildId,
            updates,
            operation
        };
        return this.submitTask('batch-update', workerData, priority);
    }
    /**
     * Get worker statistics
     */
    async getStats() {
        const promises = [];
        for (let i = 0; i < this.maxWorkers; i++) {
            if (this.workers[i]) {
                promises.push(this.submitTask('stats', { workerId: i }, 0));
            }
        }
        return Promise.all(promises);
    }
    /**
     * Get pool statistics
     */
    getPoolStats() {
        return {
            totalWorkers: this.maxWorkers,
            activeWorkers: this.activeTasks.size,
            queuedTasks: this.taskQueue.length,
            activeTasks: Array.from(this.activeTasks.keys()),
            availableWorkers: this.workers.filter((w, i) => w && !this.activeTasks.has(String(i))).length
        };
    }
    /**
     * Gracefully shutdown the worker pool
     */
    async shutdown() {
        logger_1.default.info('Shutting down worker pool');
        // Wait for active tasks to complete
        const shutdownPromises = [];
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = this.workers[i];
            if (worker) {
                shutdownPromises.push(new Promise((resolve) => {
                    worker.once('exit', () => resolve());
                    worker.postMessage({ type: 'shutdown' });
                    // Force terminate after 5 seconds
                    setTimeout(() => {
                        worker.terminate().then(() => resolve());
                    }, 5000);
                }));
            }
        }
        await Promise.all(shutdownPromises);
        logger_1.default.info('Worker pool shutdown complete');
    }
    /**
     * Emergency shutdown (force terminate all workers)
     */
    async forceShutdown() {
        logger_1.default.warn('Force shutting down worker pool');
        const shutdownPromises = [];
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = this.workers[i];
            if (worker) {
                shutdownPromises.push(worker.terminate().then(() => { }));
            }
        }
        await Promise.all(shutdownPromises);
        this.workers = [];
        this.taskQueue = [];
        this.activeTasks.clear();
        logger_1.default.info('Force shutdown complete');
    }
}
exports.WorkerPool = WorkerPool;
/**
 * Global worker pool instance
 */
let globalWorkerPool = null;
/**
 * Get or create global worker pool
 */
function getWorkerPool(maxWorkers = 4) {
    if (!globalWorkerPool) {
        globalWorkerPool = new WorkerPool(maxWorkers);
    }
    return globalWorkerPool;
}
/**
 * Shutdown global worker pool
 */
async function shutdownWorkerPool() {
    if (globalWorkerPool) {
        await globalWorkerPool.shutdown();
        globalWorkerPool = null;
    }
}
