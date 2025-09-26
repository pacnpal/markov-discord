"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const pino_1 = __importDefault(require("pino"));
const pino_pretty_1 = __importDefault(require("pino-pretty"));
const config_1 = require("./config");
const logger = (0, pino_1.default)({
    formatters: {
        level: (label) => {
            return { level: label };
        },
    },
    level: config_1.config.logLevel,
    base: undefined,
}, (0, pino_pretty_1.default)({
    translateTime: `SYS:standard`,
}));
exports.default = logger;
