import { positive } from './security.mjs';

export const MODEL_MAX_ATTEMPTS = 6; // One initial request and five retries.
export const DEFAULT_MODEL_FIRST_BYTE_TIMEOUT_SECONDS = 90;
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_SECONDS = 180;
export const DEFAULT_RUN_TIMEOUT_MS = 420000;
export const runTimeoutMs = () => positive('RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
