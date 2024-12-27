import 'source-map-support/register';
import 'reflect-metadata';
import Markov, { MarkovConstructorOptions, AddDataProps } from 'markov-strings-db';
import { DataSource } from 'typeorm';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config';
import ormconfig from './ormconfig';
import { Guild } from './entity/Guild';
import { Channel } from './entity/Channel';
import L from './logger';
import { MarkovDataCustom } from './types';
import { TrainingStateManager } from './training-state';
import { CONFIG_DIR } from './config/setup';

const markovOpts: MarkovConstructorOptions = {
  stateSize: config.stateSize,
};

// Constants for batch processing
const BATCH_SIZE = 100; // Process messages in batches
const BATCH_DELAY = 100; // Milliseconds to wait between batches
const MAX_MEMORY_USAGE = 1024 * 1024 * 1024; // 1GB memory limit

// Monitor memory usage
const getMemoryUsage = () => {
  const used = process.memoryUsage();
  return used.heapUsed;
};

// Add delay between batches
const processingDelay = () => new Promise(resolve => setTimeout(resolve, BATCH_DELAY));

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

async function trainFromJson(
  guildId: string,
  jsonPath: string,
  clean = true,
): Promise<string> {
  const markov = await getMarkovByGuildId(guildId);

  let trainingData: AddDataProps[];
  try {
    const fileContent = await fs.readFile(jsonPath, 'utf-8');
    const importData = JSON.parse(fileContent) as JSONImport[];

    // Filter out invalid entries first
    const validData = importData.filter((datum, index) => {
      if (!datum.message || typeof datum.message !== 'string') {
        L.debug({ index }, 'Skipping entry without valid message');
        return false;
      }
      if (datum.attachments?.some(a => typeof a !== 'string')) {
        L.debug({ index }, 'Skipping entry with invalid attachments');
        return false;
      }
      return true;
    });

    // Map valid entries to training data
    trainingData = validData.map(datum => {
      let custom: MarkovDataCustom | undefined;
      if (datum.attachments?.length) {
        custom = { attachments: datum.attachments };
      }
      return {
        string: datum.message,
        custom,
        tags: [guildId]
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
      // Check memory usage
      const memoryUsage = getMemoryUsage();
      if (memoryUsage > MAX_MEMORY_USAGE) {
        L.warn('Memory usage too high, waiting for garbage collection');
        await processingDelay();
        global.gc?.(); // Optional garbage collection if --expose-gc flag is used
      }

      const batch = trainingData.slice(i, i + BATCH_SIZE);
      await markov.addData(batch);
      
      processedCount += batch.length;
      batchCount++;

      // Log progress
      if (batchCount % 5 === 0) {
        const progress = (processedCount / totalMessages * 100).toFixed(2);
        L.info(`Progress: ${progress}% (${processedCount}/${totalMessages} messages)`);
        await processingDelay(); // Add delay every 5 batches
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
    await fs.writeFile(lockPath, process.pid.toString(), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const pid = parseInt(await fs.readFile(lockPath, 'utf-8'));
        try {
          // Check if process is still running
          process.kill(pid, 0);
          return false; // Process is still running
        } catch {
          // Process is not running, safe to remove lock
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, process.pid.toString());
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
    await fs.unlink(lockPath);
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
    const stats = await fs.stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }
    await fs.access(normalizedPath, fs.constants.R_OK);
    return normalizedPath;
  } catch (err) {
    throw new Error(`Invalid directory path: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Train from all JSON files in a directory
 */
async function trainFromDirectory(
  guildId: string,
  dirPath: string,
  clean = true,
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
    if (!await acquireTrainingLock(guildId)) {
      return 'Another training process is already running. Please wait for it to complete.';
    }

    // Always reset state at the start of training
    stateManager.reset();

    try {
      // Validate and normalize directory path
      const absolutePath = await validateDirectoryPath(dirPath);
      
      // Get all JSON files in the directory
      L.trace({ dirPath: absolutePath }, 'Reading directory');
      const files = await fs.readdir(absolutePath);
      const jsonFiles = files.filter(file => file.toLowerCase().endsWith('.json'));
      
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
        L.debug(
          { file: jsonFiles[i], progress: `${fileNumber}/${jsonFiles.length}` },
          'Processing file'
        );
        
        try {
          // Check memory usage before processing file
          const memoryUsage = getMemoryUsage();
          if (memoryUsage > MAX_MEMORY_USAGE) {
            L.warn('Memory usage too high, waiting for garbage collection');
            await processingDelay();
            global.gc?.(); // Optional garbage collection if --expose-gc flag is used
          }

          // Check if we should skip this file (already processed)
          if (!clean && stateManager.isChannelProcessed(jsonFiles[i])) {
            L.debug({ file: jsonFiles[i] }, 'Skipping already processed file');
            continue;
          }

          const result = await trainFromJson(
            guildId,
            jsonPath,
            i === 0 ? clean : false // Only clean on first file
          );
          
          // Extract number of processed messages from result string
          const processed = parseInt(result.match(/\d+/)?.[0] || '0');
          totalProcessed += processed;
          batchCount++;

          // Update state after each file
          stateManager.updateProgress('json-import', jsonFiles[i], totalProcessed);
          L.trace(
            { file: jsonFiles[i], processed, totalProcessed },
            'File processing complete'
          );

          // Add delay between files
          if (batchCount % 5 === 0) {
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
            'Error processing JSON file'
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
      'Error during directory training'
    );
    stateManager.recordError(error);
    return `Training encountered an error: ${error.message}. Use clean=false to resume from last checkpoint.`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node train.js <guildId> <path> [--keep-existing] [--directory]');
    console.log('Options:');
    console.log('  --keep-existing  Keep existing training data');
    console.log('  --directory      Process all JSON files in the specified directory');
    process.exit(1);
  }

  const guildId = args[0];
  const inputPath = args[1];
  const keepExisting = args.includes('--keep-existing');
  const isDirectory = args.includes('--directory');

  const dataSourceOptions = Markov.extendDataSourceOptions(ormconfig);
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  // Ensure guild exists in DB
  await Guild.upsert(Guild.create({ id: guildId }), ['id']);

  const result = isDirectory
    ? await trainFromDirectory(guildId, inputPath, !keepExisting)
    : await trainFromJson(guildId, inputPath, !keepExisting);
  console.log(result);

  await dataSource.destroy();
}

if (require.main === module) {
  main().catch(console.error);
}