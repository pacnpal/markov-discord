import 'source-map-support/register';
import 'reflect-metadata';
import Markov, { MarkovConstructorOptions, AddDataProps } from 'markov-strings-db';
import { DataSource } from 'typeorm';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { config } from './config';
import ormconfig from './ormconfig';
import { Guild } from './entity/Guild';
import { Channel } from './entity/Channel';
import L from './logger';
import { MarkovDataCustom } from './types';
import { TrainingStateManager } from './training-state';
import { CONFIG_DIR } from './config/setup';
import { getMarkovStore, MarkovStore } from './markov-store';
import { getWorkerPool } from './workers/worker-pool';

/**
 * Determine if a guild should use optimization features
 * Based on rollout percentage and force-enable lists
 */
function shouldUseOptimizations(guildId: string): boolean {
  // Check force-enable list first
  if (config.optimizationForceGuildIds.includes(guildId)) {
    return config.enableMarkovStore;
  }

  // Check rollout percentage
  if (config.optimizationRolloutPercentage > 0) {
    const hash = guildId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    const percentage = Math.abs(hash) % 100;
    return percentage < config.optimizationRolloutPercentage && config.enableMarkovStore;
  }

  return false;
}

/**
 * Add training data to MarkovStore
 */
async function addDataToMarkovStore(store: MarkovStore, messageData: AddDataProps): Promise<void> {
  const words = messageData.string.trim().split(/\s+/).filter(word => word.length > 0);
  
  // Build chain prefixes (sliding window of stateSize)
  const stateSize = config.stateSize;
  for (let i = 0; i < words.length - stateSize; i++) {
    const prefix = words.slice(i, i + stateSize).join(' ');
    const suffix = words[i + stateSize];
    store.addPrefix(prefix, suffix, 1);
  }
}

const markovOpts: MarkovConstructorOptions = {
  stateSize: config.stateSize,
};

// Constants for batch processing - OPTIMIZED for large datasets
const BATCH_SIZE = 2000; // Increased from 100 to 2000 for better DB performance
const BATCH_DELAY = 50; // Reduced delay since batches are larger
const MAX_MEMORY_USAGE = 1024 * 1024 * 1024; // 1GB memory limit
const MEMORY_CHECK_INTERVAL = 10; // Check memory every N batches instead of every batch

// Monitor memory usage
const getMemoryUsage = () => {
  const used = process.memoryUsage();
  return used.heapUsed;
};

// Add delay between batches
const processingDelay = () => new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));

async function getMarkovByGuildId(guildId: string): Promise<Markov> {
  const markov = new Markov({ id: guildId, options: { ...markovOpts, id: guildId } });
  L.trace({ guildId }, 'Setting up markov instance');
  await markov.setup(); // Connect the markov instance to the DB to assign it an ID
  return markov;
}

interface JSONImport {
  message: string;
  attachments?: string[];
}

/**
 * Train from a JSON file containing messages
 */

async function trainFromJson(guildId: string, jsonPath: string, clean = true): Promise<string> {
  const markov = await getMarkovByGuildId(guildId);

  let trainingData: AddDataProps[];
  try {
    // Use streaming JSON processing for better memory efficiency with large files
    const pipeline = fs.createReadStream(jsonPath)
      .pipe(parser())
      .pipe(streamArray());

    const importData: JSONImport[] = [];

    // Collect all data from stream
    for await (const { value } of pipeline) {
      importData.push(value as JSONImport);
    }

    // Filter out invalid entries first
    const validData = importData.filter((datum, index) => {
      if (!datum.message || typeof datum.message !== 'string') {
        L.debug({ index }, 'Skipping entry without valid message');
        return false;
      }
      if (datum.attachments?.some((a) => typeof a !== 'string')) {
        L.debug({ index }, 'Skipping entry with invalid attachments');
        return false;
      }
      return true;
    });

    // Map valid entries to training data
    trainingData = validData.map((datum) => {
      let custom: MarkovDataCustom | undefined;
      if (datum.attachments?.length) {
        custom = { attachments: datum.attachments };
      }
      return {
        string: datum.message,
        custom,
        tags: [guildId],
      };
    });
  } catch (err) {
    L.error(err);
    if (err instanceof SyntaxError) {
      return 'The provided JSON file has invalid formatting. See the logs for details.';
    }
    return `Error reading file: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }

  if (clean) {
    L.debug('Deleting old data');
    await markov.delete();
  } else {
    L.debug('Not deleting old data during training');
  }

  let processedCount = 0;
  let batchCount = 0;
  const totalMessages = trainingData.length;

  // Process messages in batches
  for (let i = 0; i < trainingData.length; i += BATCH_SIZE) {
    try {
      // Check memory usage less frequently for better performance
      if (batchCount % MEMORY_CHECK_INTERVAL === 0) {
        const memoryUsage = getMemoryUsage();
        if (memoryUsage > MAX_MEMORY_USAGE) {
          L.warn('Memory usage too high, waiting for garbage collection');
          await processingDelay();
          global.gc?.(); // Optional garbage collection if --expose-gc flag is used
        }
      }

      const batch = trainingData.slice(i, i + BATCH_SIZE);
      
      // Use optimized batch training or fallback to traditional
      if (shouldUseOptimizations(guildId)) {
        L.debug({ guildId, batchSize: batch.length }, 'Processing training batch with optimized MarkovStore');
        const store = await getMarkovStore(guildId);
        for (const messageData of batch) {
          await addDataToMarkovStore(store, messageData);
        }
      } else {
        L.debug({ guildId, batchSize: batch.length }, 'Processing training batch with traditional Markov');
        await markov.addData(batch);
      }

      processedCount += batch.length;
      batchCount++;

      // Log progress less frequently due to larger batches
      if (batchCount % 2 === 0) {
        const progress = ((processedCount / totalMessages) * 100).toFixed(2);
        L.info(`Progress: ${progress}% (${processedCount}/${totalMessages} messages)`);
        await processingDelay(); // Add delay every 2 large batches
      }
    } catch (err) {
      L.error({ err, batchIndex: i }, 'Error processing batch');
      // Continue with next batch instead of failing completely
      await processingDelay(); // Wait a bit longer after an error
      continue;
    }
  }

  L.info(`Successfully trained from ${processedCount} messages.`);
  return `Successfully trained from ${processedCount} messages.`;
}

/**
 * Train from all JSON files in a directory
 */
/**
 * Train from all JSON files in a directory
 * @param guildId The Discord guild ID
 * @param dirPath Path to directory containing JSON files
 * @param clean Whether to clean existing data before training
 */
/**
 * Acquire a lock file for training to prevent concurrent processes
 */
async function acquireTrainingLock(guildId: string): Promise<boolean> {
  const lockPath = path.join(CONFIG_DIR, `${guildId}_training.lock`);
  try {
    await fsPromises.writeFile(lockPath, process.pid.toString(), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const pid = parseInt(await fsPromises.readFile(lockPath, 'utf-8'));
        try {
          // Check if process is still running
          process.kill(pid, 0);
          return false; // Process is still running
        } catch {
          // Process is not running, safe to remove lock
          await fsPromises.unlink(lockPath);
          await fsPromises.writeFile(lockPath, process.pid.toString());
          return true;
        }
      } catch {
        // Error reading/writing lock file
        return false;
      }
    }
    return false;
  }
}

/**
 * Release the training lock file
 */
async function releaseTrainingLock(guildId: string): Promise<void> {
  const lockPath = path.join(CONFIG_DIR, `${guildId}_training.lock`);
  try {
    await fsPromises.unlink(lockPath);
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Sanitize and validate a directory path
 */
async function validateDirectoryPath(dirPath: string): Promise<string> {
  // Resolve to absolute path
  const absolutePath = path.resolve(dirPath);

  // Prevent directory traversal
  const normalizedPath = path.normalize(absolutePath);
  if (!normalizedPath.startsWith(process.cwd())) {
    throw new Error('Directory must be within current working directory');
  }

  // Verify directory exists and is accessible
  try {
    const stats = await fsPromises.stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }
    await fsPromises.access(normalizedPath, fsPromises.constants.R_OK);
    return normalizedPath;
  } catch (err) {
    throw new Error(
      `Invalid directory path: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
}

/**
 * Train from all JSON files in a directory
 */
async function trainFromDirectory(
  guildId: string,
  dirPath: string,
  clean = true,
  forceRetrain = false,
): Promise<string> {
  L.debug({ guildId, dirPath, clean }, 'Starting directory training');
  const stateManager = new TrainingStateManager(guildId, CONFIG_DIR);

  // Set up cleanup handler
  const cleanup = async () => {
    try {
      await releaseTrainingLock(guildId);
      stateManager.finishTraining();
    } catch (err) {
      L.error({ err }, 'Error during cleanup');
    }
  };

  // Handle process termination
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  try {
    // Try to acquire lock
    if (!(await acquireTrainingLock(guildId))) {
      return 'Another training process is already running. Please wait for it to complete.';
    }

    // Always reset state at the start of training
    stateManager.reset();

    try {
      // Validate and normalize directory path
      const absolutePath = await validateDirectoryPath(dirPath);

      // Get all JSON files in the directory
      L.trace({ dirPath: absolutePath }, 'Reading directory');
      const files = await fsPromises.readdir(absolutePath);
      const jsonFiles = files.filter((file: string) => file.toLowerCase().endsWith('.json'));

      if (jsonFiles.length === 0) {
        L.warn({ dirPath: absolutePath }, 'No JSON files found in directory');
        return 'No JSON files found in the specified directory.';
      }

      let totalProcessed = 0;
      let batchCount = 0;
      L.info({ fileCount: jsonFiles.length }, 'Found JSON files to process');

      stateManager.startTraining();

      // Process first file with clean flag, subsequent files without cleaning
      for (let i = 0; i < jsonFiles.length; i++) {
        const jsonPath = path.join(absolutePath, jsonFiles[i]);
        const fileNumber = i + 1;
        // Log progress to console
        console.log(`\nProcessing file ${fileNumber}/${jsonFiles.length}: ${jsonFiles[i]}`);
        console.log(`${jsonFiles.length - fileNumber} files remaining\n`);

        L.debug(
          { file: jsonFiles[i], progress: `${fileNumber}/${jsonFiles.length}` },
          'Processing file',
        );

        try {
          // Check memory usage less frequently during file processing
          if (fileNumber % 3 === 0) {
            // Check every 3rd file
            const memoryUsage = getMemoryUsage();
            if (memoryUsage > MAX_MEMORY_USAGE) {
              L.warn('Memory usage too high, waiting for garbage collection');
              await processingDelay();
              global.gc?.(); // Optional garbage collection if --expose-gc flag is used
            }
          }

          // Check if file was already processed
          if (!clean && !forceRetrain && stateManager.isChannelProcessed(jsonFiles[i])) {
            console.log(`\nSkipping ${jsonFiles[i]} - already processed`);
            console.log(`Use --force-retrain to process this file again`);
            console.log(`${jsonFiles.length - fileNumber} files remaining\n`);
            continue;
          }

          // Log progress to console
          console.log(`\nProcessing file ${fileNumber}/${jsonFiles.length}: ${jsonFiles[i]}`);
          console.log(`${jsonFiles.length - fileNumber} files remaining\n`);

          const result = await trainFromJson(
            guildId,
            jsonPath,
            i === 0 ? clean : false, // Only clean on first file
          );

          // Extract number of processed messages from result string
          const processed = parseInt(result.match(/\d+/)?.[0] || '0');
          totalProcessed += processed;
          batchCount++;

          // Update state after each file
          stateManager.updateProgress('json-import', jsonFiles[i], totalProcessed);
          L.trace({ file: jsonFiles[i], processed, totalProcessed }, 'File processing complete');

          // Add delay between files less frequently due to larger batches
          if (batchCount % 3 === 0) {
            await processingDelay();
          }

          // Clear any references that might be held
          if (global.gc) {
            global.gc();
          }
        } catch (err) {
          const error = err as Error;
          L.error(
            { error: error.message, file: jsonFiles[i], stack: error.stack },
            'Error processing JSON file',
          );
          stateManager.recordError(error, 'json-import', jsonFiles[i]);
          // Add longer delay after error
          await processingDelay();
          // Continue with next file instead of failing completely
          continue;
        }
      }

      const summary = { totalProcessed, fileCount: jsonFiles.length };
      L.info(summary, 'Directory training complete');
      return `Successfully trained from ${totalProcessed} messages across ${jsonFiles.length} files.`;
    } finally {
      // Clean up regardless of success/failure
      await cleanup();
      // Remove process termination handlers
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
    }
  } catch (err) {
    const error = err as Error;
    L.error(
      { error: error.message, stack: error.stack, dirPath },
      'Error during directory training',
    );
    stateManager.recordError(error);
    return `Training encountered an error: ${error.message}. Use clean=false to resume from last checkpoint.`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(
      'Usage: node train.js <guildId> <path> [--keep-existing] [--directory] [--force-retrain]',
    );
    console.log('Options:');
    console.log('  --keep-existing  Keep existing training data');
    console.log('  --directory      Process all JSON files in the specified directory');
    console.log('  --force-retrain  Force retraining on files even if already processed');
    process.exit(1);
  }

  const guildId = args[0];
  const inputPath = args[1];
  const keepExisting = args.includes('--keep-existing');
  const isDirectory = args.includes('--directory');
  const forceRetrain = args.includes('--force-retrain');

  const dataSourceOptions = Markov.extendDataSourceOptions(ormconfig);
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  // Ensure guild exists in DB
  await Guild.upsert(Guild.create({ id: guildId }), ['id']);

  const result = isDirectory
    ? await trainFromDirectory(guildId, inputPath, !keepExisting, forceRetrain)
    : await trainFromJson(guildId, inputPath, !keepExisting);
  console.log(result);

  await dataSource.destroy();
}

if (require.main === module) {
  main().catch(console.error);
}
