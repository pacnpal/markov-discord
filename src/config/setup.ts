import 'reflect-metadata';
import 'dotenv/config';
import json5 from 'json5';
import path from 'path';
import fs from 'fs-extra';
import { validateSync } from 'class-validator';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import pino from 'pino';
import { AppConfig } from './classes';

// Declare pino logger as importing would cause dependency cycle
const L = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      translateTime: `SYS:standard`,
    },
  },
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
});

// TODO: Add YAML parser
const EXTENSIONS = ['.json', '.json5']; // Allow .json or .json5 extension

const removeFileExtension = (filename: string): string => {
  const ext = path.extname(filename);
  if (EXTENSIONS.includes(ext)) {
    return path.basename(filename, ext);
  }
  return path.basename(filename);
};

export const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
export const CONFIG_FILE_NAME = process.env.CONFIG_FILE_NAME
  ? removeFileExtension(process.env.CONFIG_FILE_NAME)
  : 'config';

const configPaths = EXTENSIONS.map((ext) => path.resolve(CONFIG_DIR, `${CONFIG_FILE_NAME}${ext}`));
const configPath = configPaths.find((p) => fs.existsSync(p));
// eslint-disable-next-line import/no-mutable-exports
let config: AppConfig;
if (!configPath) {
  L.warn('No config file detected');
  const newConfigPath = path.resolve(CONFIG_DIR, `${CONFIG_FILE_NAME}.json`);
  config = new AppConfig();
  try {
    L.info({ newConfigPath }, 'Creating new config file');
    fs.writeJSONSync(newConfigPath, instanceToPlain(config), { spaces: 2 });
    L.info({ newConfigPath }, 'Wrote new default config file');
  } catch (err) {
    L.info(err, 'Not allowed to create new config. Continuing...');
  }
} else {
  L.debug({ configPath });
  const parsedConfig = json5.parse(fs.readFileSync(configPath, 'utf8'));
  config = plainToInstance(AppConfig, parsedConfig);
}

const errors = validateSync(config, {
  validationError: {
    target: false,
  },
});
if (errors.length > 0) {
  L.error({ errors }, 'Validation error(s)');
  throw new Error('Invalid config');
}

L.debug({ config: instanceToPlain(config) });

export { config };
