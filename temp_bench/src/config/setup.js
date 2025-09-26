"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.CONFIG_FILE_NAME = exports.CONFIG_DIR = void 0;
require("reflect-metadata");
require("dotenv/config");
const json5_1 = __importDefault(require("json5"));
const path_1 = __importDefault(require("path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const pino_1 = __importDefault(require("pino"));
const classes_1 = require("./classes");
// Declare pino logger as importing would cause dependency cycle
const L = (0, pino_1.default)({
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
const removeFileExtension = (filename) => {
    const ext = path_1.default.extname(filename);
    if (EXTENSIONS.includes(ext)) {
        return path_1.default.basename(filename, ext);
    }
    return path_1.default.basename(filename);
};
exports.CONFIG_DIR = process.env.CONFIG_DIR || 'config';
exports.CONFIG_FILE_NAME = process.env.CONFIG_FILE_NAME
    ? removeFileExtension(process.env.CONFIG_FILE_NAME)
    : 'config';
const configPaths = EXTENSIONS.map((ext) => path_1.default.resolve(exports.CONFIG_DIR, `${exports.CONFIG_FILE_NAME}${ext}`));
const configPath = configPaths.find((p) => fs_extra_1.default.existsSync(p));
// eslint-disable-next-line import/no-mutable-exports
let config;
if (!configPath) {
    L.warn('No config file detected');
    const newConfigPath = path_1.default.resolve(exports.CONFIG_DIR, `${exports.CONFIG_FILE_NAME}.json`);
    exports.config = config = new classes_1.AppConfig();
    try {
        L.info({ newConfigPath }, 'Creating new config file');
        fs_extra_1.default.writeJSONSync(newConfigPath, (0, class_transformer_1.instanceToPlain)(config), { spaces: 2 });
        L.info({ newConfigPath }, 'Wrote new default config file');
    }
    catch (err) {
        L.info(err, 'Not allowed to create new config. Continuing...');
    }
}
else {
    L.debug({ configPath });
    const parsedConfig = json5_1.default.parse(fs_extra_1.default.readFileSync(configPath, 'utf8'));
    exports.config = config = (0, class_transformer_1.plainToInstance)(classes_1.AppConfig, parsedConfig);
}
const errors = (0, class_validator_1.validateSync)(config, {
    validationError: {
        target: false,
    },
});
if (errors.length > 0) {
    L.error({ errors }, 'Validation error(s)');
    throw new Error('Invalid config');
}
L.debug({ config: (0, class_transformer_1.instanceToPlain)(config) });
