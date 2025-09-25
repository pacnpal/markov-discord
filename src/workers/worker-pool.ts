import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import path from 'path';
import L from '../logger';

/**
 * Worker task types
 */
export type WorkerTaskType = 'build-chains' | 'generate-response' | 'batch-update' | 'stats';

/**
 * Worker task with promise resolution
 */
interface WorkerTask {
  id: string;
  type: WorkerTaskType;
  data: any;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  priority: number; // 0 = low, 1 = normal, 2 = high
  timestamp: number;
}

/**
 * Worker pool for managing Markov worker threads
 */
export class WorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private activeTasks = new Map<string, WorkerTask>();
  private readonly maxWorkers: number;
  private readonly workerPath: string;

  constructor(maxWorkers = 4) {
    super();
    this.maxWorkers = maxWorkers;
    this.workerPath = path.join(__dirname, 'markov-worker.js');

    this.initializeWorkers();
  }

  /**
   * Initialize worker threads
   */
  private async initializeWorkers(): Promise<void> {
    L.info({ maxWorkers: this.maxWorkers }, 'Initializing worker pool');

    for (let i = 0; i < this.maxWorkers; i++) {
      await this.createWorker(i);
    }

    L.info({ workerCount: this.workers.length }, 'Worker pool initialized');
  }

  /**
   * Create a single worker
   */
  private async createWorker(workerId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: { workerId },
      });

      // Handle worker ready message
      worker.once('message', (message) => {
        if (message.success && message.result?.status === 'ready') {
          L.info({ workerId }, 'Worker ready');
          resolve();
        } else {
          reject(new Error(message.error || 'Worker failed to initialize'));
        }
      });

      // Handle worker errors
      worker.on('error', (error) => {
        L.error({ workerId, error: error.message }, 'Worker error');
        this.handleWorkerError(workerId, error);
      });

      worker.on('exit', (code) => {
        L.warn({ workerId, code }, 'Worker exited');
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
  private handleWorkerError(workerId: number, error: Error): void {
    L.error({ workerId, error: error.message }, 'Worker error, restarting');

    // Remove failed worker
    const worker = this.workers[workerId];
    if (worker) {
      worker.terminate();
      delete this.workers[workerId];
    }

    // Restart worker
    setTimeout(() => {
      this.createWorker(workerId).catch((err) => {
        L.error({ workerId, error: err }, 'Failed to restart worker');
      });
    }, 1000);
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(workerId: number, code: number): void {
    if (code !== 0) {
      L.warn({ workerId, code }, 'Worker exited with non-zero code, restarting');
      setTimeout(() => {
        this.createWorker(workerId).catch((err) => {
          L.error({ workerId, error: err }, 'Failed to restart worker');
        });
      }, 1000);
    }
  }

  /**
   * Handle task completion
   */
  private handleTaskResult(message: any): void {
    const task = this.activeTasks.get(message.workerId);
    if (!task) {
      L.warn({ workerId: message.workerId }, 'Received result for unknown task');
      return;
    }

    this.activeTasks.delete(message.workerId);

    if (message.success) {
      task.resolve(message.result);
    } else {
      task.reject(new Error(message.error || 'Worker task failed'));
    }

    // Process next task
    this.processNextTask();
  }

  /**
   * Process next task from queue
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;

    // Find available worker
    const availableWorkerId = this.findAvailableWorker();
    if (availableWorkerId === -1) return;

    // Get highest priority task
    const sortedTasks = this.taskQueue.sort((a, b) => b.priority - a.priority);
    const task = sortedTasks.shift()!;

    this.taskQueue = sortedTasks;
    this.activeTasks.set(availableWorkerId, task);

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
  private findAvailableWorker(): number {
    for (let i = 0; i < this.maxWorkers; i++) {
      if (this.workers[i] && !this.activeTasks.has(i)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Submit a task to the worker pool
   */
  async submitTask(
    type: WorkerTaskType,
    data: any,
    priority = 1
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const task: WorkerTask = {
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
  async buildChains(
    guildId: string,
    messages: Array<{ prefix: string; suffix: string; weight?: number }>,
    clearExisting = false,
    priority = 1
  ): Promise<{ processedCount: number }> {
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
  async generateResponse(
    guildId: string,
    prefix: string,
    maxLength = 50,
    temperature = 1.0,
    priority = 1
  ): Promise<{ response: string; wordCount: number }> {
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
  async batchUpdate(
    guildId: string,
    updates: Array<{ prefix: string; suffix: string; weight: number }>,
    operation: 'add' | 'remove',
    priority = 1
  ): Promise<{ updateCount: number; operation: string }> {
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
  async getStats(): Promise<Array<{ workerId: number; stats: any }>> {
    const promises: Promise<any>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      if (this.workers[i]) {
        promises.push(
          this.submitTask('stats', { workerId: i }, 0)
        );
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
      availableWorkers: this.workers.filter((w, i) => w && !this.activeTasks.has(i)).length
    };
  }

  /**
   * Gracefully shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    L.info('Shutting down worker pool');

    // Wait for active tasks to complete
    const shutdownPromises: Promise<void>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = this.workers[i];
      if (worker) {
        shutdownPromises.push(
          new Promise((resolve) => {
            worker.once('exit', () => resolve());
            worker.postMessage({ type: 'shutdown' });
            // Force terminate after 5 seconds
            setTimeout(() => {
              worker.terminate().then(() => resolve());
            }, 5000);
          })
        );
      }
    }

    await Promise.all(shutdownPromises);
    L.info('Worker pool shutdown complete');
  }

  /**
   * Emergency shutdown (force terminate all workers)
   */
  async forceShutdown(): Promise<void> {
    L.warn('Force shutting down worker pool');

    const shutdownPromises: Promise<void>[] = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const worker = this.workers[i];
      if (worker) {
        shutdownPromises.push(worker.terminate());
      }
    }

    await Promise.all(shutdownPromises);
    this.workers = [];
    this.taskQueue = [];
    this.activeTasks.clear();

    L.info('Force shutdown complete');
  }
}

/**
 * Global worker pool instance
 */
let globalWorkerPool: WorkerPool | null = null;

/**
 * Get or create global worker pool
 */
export function getWorkerPool(maxWorkers = 4): WorkerPool {
  if (!globalWorkerPool) {
    globalWorkerPool = new WorkerPool(maxWorkers);
  }
  return globalWorkerPool;
}

/**
 * Shutdown global worker pool
 */
export async function shutdownWorkerPool(): Promise<void> {
  if (globalWorkerPool) {
    await globalWorkerPool.shutdown();
    globalWorkerPool = null;
  }
}