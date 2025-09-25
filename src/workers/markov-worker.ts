import { parentPort, workerData } from 'worker_threads';
import { MarkovStore } from '../markov-store';
import L from '../logger';

/**
 * Worker message types for communication with main thread
 */
interface WorkerMessage {
  type: 'build-chains' | 'generate-response' | 'batch-update' | 'stats';
  data?: any;
}

interface WorkerResponse {
  success: boolean;
  result?: any;
  error?: string;
  workerId: number;
}

/**
 * Worker data passed from main thread
 */
interface WorkerInitData {
  guildId: string;
  workerId: number;
}

/**
 * Markov Worker - Handles CPU-intensive operations in separate threads
 *
 * This worker processes chain building, batch updates, and heavy generation
 * tasks without blocking the main Discord bot thread.
 */
class MarkovWorker {
  private store: MarkovStore;
  private workerId: number;

  constructor(data: WorkerInitData) {
    this.workerId = data.workerId;
    this.store = new MarkovStore(data.guildId);

    L.info({ workerId: this.workerId, guildId: data.guildId }, 'Markov worker initialized');
  }

  /**
   * Initialize worker and load store
   */
  async init(): Promise<void> {
    await this.store.load();
    L.trace({ workerId: this.workerId }, 'Markov worker store loaded');
  }

  /**
   * Process worker messages
   */
  async processMessage(message: WorkerMessage): Promise<WorkerResponse> {
    try {
      switch (message.type) {
        case 'build-chains':
          return await this.handleBuildChains(message.data);
        case 'generate-response':
          return await this.handleGenerateResponse(message.data);
        case 'batch-update':
          return await this.handleBatchUpdate(message.data);
        case 'stats':
          return await this.handleStats();
        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      L.error({
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
        messageType: message.type
      }, 'Worker processing error');

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        workerId: this.workerId
      };
    }
  }

  /**
   * Build chains from training data
   */
  private async handleBuildChains(data: {
    messages: Array<{ prefix: string; suffix: string; weight?: number }>;
    clearExisting?: boolean;
  }): Promise<WorkerResponse> {
    const { messages, clearExisting = false } = data;

    if (clearExisting) {
      this.store.clear();
    }

    let processedCount = 0;
    const batchSize = 1000; // Process in batches to avoid memory issues

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);

      for (const msg of batch) {
        this.store.addPrefix(msg.prefix, msg.suffix, msg.weight || 1);
        processedCount++;
      }

      // Yield control periodically to prevent blocking
      if (i % 5000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    await this.store.save(); // Ensure all changes are saved

    return {
      success: true,
      result: { processedCount, workerId: this.workerId },
      workerId: this.workerId
    };
  }

  /**
   * Generate response using the store
   */
  private async handleGenerateResponse(data: {
    prefix: string;
    maxLength?: number;
    temperature?: number;
  }): Promise<WorkerResponse> {
    const { prefix, maxLength = 50, temperature = 1.0 } = data;

    // For now, use basic generation - could add temperature sampling later
    const words = this.store.generate(prefix, maxLength);
    const response = words.join(' ');

    return {
      success: true,
      result: { response, wordCount: words.length },
      workerId: this.workerId
    };
  }

  /**
   * Handle batch updates to the store
   */
  private async handleBatchUpdate(data: {
    updates: Array<{ prefix: string; suffix: string; weight: number }>;
    operation: 'add' | 'remove';
  }): Promise<WorkerResponse> {
    const { updates, operation } = data;

    if (operation === 'remove') {
      for (const update of updates) {
        this.store.removePrefix(update.prefix);
      }
    } else {
      for (const update of updates) {
        this.store.addPrefix(update.prefix, update.suffix, update.weight);
      }
    }

    await this.store.save();

    return {
      success: true,
      result: { updateCount: updates.length, operation },
      workerId: this.workerId
    };
  }

  /**
   * Get worker statistics
   */
  private async handleStats(): Promise<WorkerResponse> {
    const stats = this.store.getStats();
    return {
      success: true,
      result: { ...stats, workerId: this.workerId },
      workerId: this.workerId
    };
  }
}

/**
 * Worker initialization and message handling
 */
async function main() {
  try {
    const worker = new MarkovWorker(workerData);
    await worker.init();

    // Set up message handler
    parentPort?.on('message', async (message: WorkerMessage) => {
      const response = await worker.processMessage(message);

      if (parentPort) {
        parentPort.postMessage(response);
      }
    });

    // Signal readiness
    if (parentPort) {
      parentPort.postMessage({
        success: true,
        result: { status: 'ready' },
        workerId: workerData.workerId
      });
    }

    L.info({ workerId: workerData.workerId }, 'Markov worker ready');
  } catch (error) {
    L.error({
      workerId: workerData.workerId,
      error: error instanceof Error ? error.message : String(error)
    }, 'Worker initialization error');

    if (parentPort) {
      parentPort.postMessage({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        workerId: workerData.workerId
      });
    }
  }
}

// Start the worker
main().catch((error) => {
  L.error({
    workerId: workerData?.workerId,
    error: error instanceof Error ? error.message : String(error)
  }, 'Unhandled worker error');
  process.exit(1);
});