#!/usr/bin/env node

/**
 * Markov Discord Load Testing Script
 *
 * This script performs load testing on the Markov Discord bot to measure
 * performance under various loads and configurations.
 */

import 'source-map-support/register';
import { performance } from 'perf_hooks';
import { MarkovStore } from '../src/markov-store';
import { getWorkerPool } from '../src/workers/worker-pool';
import fs from 'fs/promises';
import path from 'path';

// Configuration
interface LoadTestConfig {
  duration: number; // Duration in seconds
  concurrency: number; // Number of concurrent requests
  warmupTime: number; // Warmup time in seconds
  guildId: string;
  testDataSize: number; // Number of test messages to use
  outputFile: string;
  useOptimized: boolean; // Whether to use optimized components
}

// Test result interface
interface TestResult {
  config: LoadTestConfig;
  summary: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    requestsPerSecond: number;
    averageLatency: number;
    minLatency: number;
    maxLatency: number;
    p95Latency: number;
    p99Latency: number;
  };
  latencies: number[];
  errors: string[];
  memoryUsage: {
    start: NodeJS.MemoryUsage;
    end: NodeJS.MemoryUsage;
    peak: NodeJS.MemoryUsage;
  };
  timestamp: string;
}

// Default configuration
const defaultConfig: LoadTestConfig = {
  duration: 60,
  concurrency: 10,
  warmupTime: 5,
  guildId: 'load-test-guild',
  testDataSize: 1000,
  outputFile: `load_test_${new Date().toISOString().replace(/:/g, '-')}.json`,
  useOptimized: true
};

// Test data generator
class TestDataGenerator {
  private words: string[] = [
    'hello', 'world', 'this', 'is', 'a', 'test', 'message', 'for', 'performance',
    'testing', 'with', 'many', 'different', 'words', 'and', 'phrases', 'that',
    'simulate', 'real', 'conversation', 'patterns', 'in', 'discord', 'channels',
    'where', 'people', 'talk', 'about', 'various', 'topics', 'like', 'gaming',
    'programming', 'music', 'movies', 'books', 'sports', 'technology', 'science'
  ];

  generateMessage(): string {
    const length = Math.floor(Math.random() * 15) + 3; // 3-17 words
    const message: string[] = [];

    for (let i = 0; i < length; i++) {
      message.push(this.words[Math.floor(Math.random() * this.words.length)]);
    }

    return message.join(' ');
  }

  generateTrainingData(count: number): Array<{ message: string }> {
    const data: Array<{ message: string }> = [];

    for (let i = 0; i < count; i++) {
      data.push({ message: this.generateMessage() });
    }

    return data;
  }

  generatePrefixes(count: number): string[] {
    const prefixes: string[] = [];

    for (let i = 0; i < count; i++) {
      const length = Math.floor(Math.random() * 2) + 1; // 1-2 words
      const prefix: string[] = [];

      for (let j = 0; j < length; j++) {
        prefix.push(this.words[Math.floor(Math.random() * this.words.length)]);
      }

      prefixes.push(prefix.join(' '));
    }

    return prefixes;
  }
}

// Load tester class
class LoadTester {
  private config: LoadTestConfig;
  private generator: TestDataGenerator;
  private results: number[] = [];
  private errors: string[] = [];
  private startTime: number = 0;
  private endTime: number = 0;
  private memoryStart: NodeJS.MemoryUsage;
  private memoryPeak: NodeJS.MemoryUsage;

  constructor(config: LoadTestConfig) {
    this.config = config;
    this.generator = new TestDataGenerator();
    this.memoryStart = process.memoryUsage();
    this.memoryPeak = { ...this.memoryStart };
  }

  // Update memory peak
  private updateMemoryPeak(): void {
    const current = process.memoryUsage();
    if (current.heapUsed > this.memoryPeak.heapUsed) {
      this.memoryPeak = current;
    }
  }

  // Generate training data
  private async setupTrainingData(): Promise<Array<{ prefix: string; suffix: string; weight: number }>> {
    console.log(`Generating ${this.config.testDataSize} training messages...`);

    const messages = this.generator.generateTrainingData(this.config.testDataSize);
    const trainingData: Array<{ prefix: string; suffix: string; weight: number }> = [];

    for (const msg of messages) {
      const words = msg.message.split(' ');
      for (let i = 0; i < words.length - 1; i++) {
        trainingData.push({
          prefix: words[i],
          suffix: words[i + 1],
          weight: 1
        });
      }
    }

    console.log(`Generated ${trainingData.length} training pairs`);
    return trainingData;
  }

  // Build chains (training phase)
  private async buildChains(): Promise<void> {
    console.log('Building Markov chains...');

    if (this.config.useOptimized) {
      const workerPool = getWorkerPool(2);
      const trainingData = await this.setupTrainingData();

      // Split data into chunks for workers
      const chunkSize = Math.ceil(trainingData.length / 2);
      const chunk1 = trainingData.slice(0, chunkSize);
      const chunk2 = trainingData.slice(chunkSize);

      const [result1, result2] = await Promise.all([
        workerPool.buildChains(this.config.guildId, chunk1, true, 2),
        workerPool.buildChains(this.config.guildId, chunk2, false, 2)
      ]);

      console.log(`Chains built: ${result1.processedCount + result2.processedCount} entries`);
    } else {
      // Fallback to basic implementation
      const store = new MarkovStore(this.config.guildId);
      await store.load();
      store.clear();

      const trainingData = await this.setupTrainingData();
      for (const item of trainingData) {
        store.addPrefix(item.prefix, item.suffix, item.weight);
      }
      await store.save();
      console.log('Basic training completed');
    }
  }

  // Run generation load test
  private async runGenerationTest(): Promise<void> {
    console.log(`Starting load test: ${this.config.duration}s duration, ${this.config.concurrency} concurrency`);

    const prefixes = this.generator.generatePrefixes(1000);
    const endTime = Date.now() + (this.config.duration * 1000);

    this.startTime = performance.now();

    // Warmup phase
    if (this.config.warmupTime > 0) {
      console.log(`Warmup phase: ${this.config.warmupTime} seconds`);
      await new Promise(resolve => setTimeout(resolve, this.config.warmupTime * 1000));
    }

    // Load test phase
    const promises: Promise<void>[] = [];

    for (let i = 0; i < this.config.concurrency; i++) {
      promises.push(this.generateLoad(i, prefixes, endTime));
    }

    await Promise.all(promises);

    this.endTime = performance.now();
    console.log('Load test completed');
  }

  // Generate load for a single worker
  private async generateLoad(
    workerId: number,
    prefixes: string[],
    endTime: number
  ): Promise<void> {
    const latencies: number[] = [];

    while (Date.now() < endTime) {
      const start = performance.now();

      try {
        if (this.config.useOptimized) {
          // Use worker pool
          const workerPool = getWorkerPool(2);
          const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
          await workerPool.generateResponse(this.config.guildId, prefix, 30, 1.0, 1);
        } else {
          // Use basic store
          const store = new MarkovStore(this.config.guildId);
          await store.load();
          const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
          store.generate(prefix, 30);
        }

        const latency = performance.now() - start;
        latencies.push(latency);
        this.results.push(latency);

        this.updateMemoryPeak();
      } catch (error) {
        this.errors.push(`Worker ${workerId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log(`Worker ${workerId}: completed ${latencies.length} requests`);
  }

  // Calculate statistics
  private calculateStats(): TestResult['summary'] {
    if (this.results.length === 0) {
      return {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: this.errors.length,
        requestsPerSecond: 0,
        averageLatency: 0,
        minLatency: 0,
        maxLatency: 0,
        p95Latency: 0,
        p99Latency: 0
      };
    }

    const sortedLatencies = [...this.results].sort((a, b) => a - b);
    const totalTime = this.endTime - this.startTime;

    const p95Index = Math.floor(sortedLatencies.length * 0.95);
    const p99Index = Math.floor(sortedLatencies.length * 0.99);

    return {
      totalRequests: this.results.length,
      successfulRequests: this.results.length,
      failedRequests: this.errors.length,
      requestsPerSecond: (this.results.length / totalTime) * 1000,
      averageLatency: this.results.reduce((sum, lat) => sum + lat, 0) / this.results.length,
      minLatency: sortedLatencies[0],
      maxLatency: sortedLatencies[sortedLatencies.length - 1],
      p95Latency: sortedLatencies[p95Index] || 0,
      p99Latency: sortedLatencies[p99Index] || 0
    };
  }

  // Run complete load test
  async run(): Promise<TestResult> {
    console.log('=== Markov Discord Load Test ===');
    console.log('Configuration:', JSON.stringify(this.config, null, 2));

    try {
      // Build chains
      await this.buildChains();

      // Run load test
      await this.runGenerationTest();

      // Calculate results
      const summary = this.calculateStats();
      const memoryEnd = process.memoryUsage();

      const result: TestResult = {
        config: this.config,
        summary,
        latencies: this.results,
        errors: this.errors,
        memoryUsage: {
          start: this.memoryStart,
          end: memoryEnd,
          peak: this.memoryPeak
        },
        timestamp: new Date().toISOString()
      };

      // Save results
      await fs.writeFile(
        path.join(process.cwd(), this.config.outputFile),
        JSON.stringify(result, null, 2)
      );

      console.log('\n=== Load Test Results ===');
      console.log(`Total Requests: ${summary.totalRequests}`);
      console.log(`Requests/sec: ${summary.requestsPerSecond.toFixed(2)}`);
      console.log(`Average Latency: ${summary.averageLatency.toFixed(2)}ms`);
      console.log(`Min Latency: ${summary.minLatency.toFixed(2)}ms`);
      console.log(`Max Latency: ${summary.maxLatency.toFixed(2)}ms`);
      console.log(`95th Percentile: ${summary.p95Latency.toFixed(2)}ms`);
      console.log(`99th Percentile: ${summary.p99Latency.toFixed(2)}ms`);
      console.log(`Failed Requests: ${summary.failedRequests}`);
      console.log(`Memory Usage: ${((memoryEnd.heapUsed - this.memoryStart.heapUsed) / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Results saved to: ${this.config.outputFile}`);

      return result;

    } catch (error) {
      console.error('Load test failed:', error);
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  // Parse command line arguments
  const config: LoadTestConfig = { ...defaultConfig };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];

    if (value !== undefined) {
      switch (key) {
        case 'duration':
          config.duration = parseInt(value);
          break;
        case 'concurrency':
          config.concurrency = parseInt(value);
          break;
        case 'warmup':
          config.warmupTime = parseInt(value);
          break;
        case 'guild':
          config.guildId = value;
          break;
        case 'data-size':
          config.testDataSize = parseInt(value);
          break;
        case 'output':
          config.outputFile = value;
          break;
        case 'optimized':
          config.useOptimized = value === 'true';
          break;
      }
    }
  }

  // Run load test
  const tester = new LoadTester(config);
  await tester.run();
}

// Handle CLI execution
if (require.main === module) {
  main().catch(console.error);
}

export { LoadTester, TestDataGenerator, LoadTestConfig, TestResult };