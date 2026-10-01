/**
 * @file Zod schemas for MQTT payloads (contract v1) and the telemetry REST API.
 *
 * Every device payload is untrusted input: the broker is shared infrastructure
 * and a flashed board can be wrong in ways nobody intended. The schemas are
 * `.strict()`, so an unknown field fails the message instead of being carried
 * into storage, and numbers must be finite.
 *
 * @module validators/telemetry.validator
 */

import { z } from 'zod';

import { SENSOR_TYPES } from '../models/SensorBinding.model.js';
import {
  CHANNEL_KEY_PATTERN,
  COMMAND_NAMES,
  MACHINE_ID_PATTERN,
} from '../utils/mqttTopics.js';
import { sensorIdSchema } from './meshNode.validator.js';

/** Largest payload the ingestion pipeline will even try to parse. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

/** Most channels a single machine may declare or report. */
export const MAX_CHANNELS = 32;

/** Most bins a spectrum may carry. */
export const MAX_SPECTRUM_BINS = 256;

const finite = z.number().finite();

const channelKey = z.string().regex(CHANNEL_KEY_PATTERN, 'Channel key must be UPPER_SNAKE_CASE');

const scenarioName = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, 'Scenario must be UPPER_SNAKE_CASE');

/* ─── birth ────────────────────────────────────────────────────────────────── */

const limitsSchema = z
  .object({
    warnLow: finite.optional(),
    warnHigh: finite.optional(),
    alarmLow: finite.optional(),
    alarmHigh: finite.optional(),
  })
  .strict();

const channelDeclarationSchema = z
  .object({
    key: channelKey,
    label: z.string().min(1).max(80),
    unit: z.string().max(16),
    sensorType: z.enum(/** @type {[string, ...string[]]} */ (SENSOR_TYPES)),
    min: finite,
    max: finite,
    decimals: z.number().int().min(0).max(6),
    limits: limitsSchema,
  })
  .strict()
  .refine((channel) => channel.min < channel.max, {
    message: 'Channel min must be less than max',
    path: ['max'],
  });

const spectrumLayoutSchema = z
  .object({
    key: channelKey,
    label: z.string().min(1).max(80),
    unit: z.string().max(16),
    startHz: finite.min(0),
    stepHz: finite.positive(),
    count: z.number().int().min(1).max(MAX_SPECTRUM_BINS),
    intervalMs: z.number().int().min(250).max(60_000),
    // The machine's fundamental frequency (motor shaft speed, 1X). Lets a
    // viewer mark its harmonics without hard-coding any machine's speed.
    fundamentalHz: finite.positive().optional(),
  })
  .strict();

export const birthPayloadSchema = z
  .object({
    v: z.literal(1),
    machineId: z.string().regex(MACHINE_ID_PATTERN),
    machineType: z.string().regex(/^[a-z0-9-]{1,24}$/),
    label: z.string().min(1).max(80),
    fw: z.string().min(1).max(24),
    mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'MAC must be AA:BB:CC:DD:EE:FF'),
    bootId: z.string().regex(/^[0-9a-fA-F]{4,16}$/),
    intervalMs: z.number().int().min(100).max(60_000),
    scenarios: z.array(scenarioName).max(8),
    channels: z.array(channelDeclarationSchema).min(1).max(MAX_CHANNELS),
    spectrum: spectrumLayoutSchema.nullable(),
  })
  .strict()
  .superRefine((birth, ctx) => {
    const keys = new Set();
    for (const [index, channel] of birth.channels.entries()) {
      if (keys.has(channel.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate channel key ${channel.key}`,
          path: ['channels', index, 'key'],
        });
      }
      keys.add(channel.key);
    }
  });

/* ─── status ───────────────────────────────────────────────────────────────── */

/** Plain-text `online` or `offline`, trimmed. */
export const statusPayloadSchema = z.enum(['online', 'offline']);

/* ─── telemetry ────────────────────────────────────────────────────────────── */

export const telemetryPayloadSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    synced: z.boolean(),
    m: z
      .record(channelKey, finite)
      .refine((values) => {
        const count = Object.keys(values).length;
        return count >= 1 && count <= MAX_CHANNELS;
      }, `Telemetry must carry between 1 and ${MAX_CHANNELS} channels`),
  })
  .strict();

/* ─── spectrum ─────────────────────────────────────────────────────────────── */

export const spectrumPayloadSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    key: channelKey,
    amp: z.array(finite.nonnegative()).min(1).max(MAX_SPECTRUM_BINS),
  })
  .strict();

/* ─── diag ─────────────────────────────────────────────────────────────────── */

export const diagPayloadSchema = z
  .object({
    v: z.literal(1),
    ts: z.number().int().nonnegative(),
    fw: z.string().min(1).max(24),
    bootId: z.string().regex(/^[0-9a-fA-F]{4,16}$/),
    uptimeS: z.number().int().nonnegative(),
    rssi: z.number().int().min(-127).max(0),
    heapFree: z.number().int().nonnegative(),
    heapMin: z.number().int().nonnegative(),
    reset: z.string().max(24),
    wifiReconnects: z.number().int().nonnegative(),
    mqttReconnects: z.number().int().nonnegative(),
    restarts: z.number().int().nonnegative(),
    publishFailures: z.number().int().nonnegative(),
    tls: z.boolean(),
    insecure: z.boolean(),
    sim: z
      .object({
        scenario: scenarioName,
        ramp: finite.min(0).max(1),
        rampSec: finite.min(0).max(3600),
      })
      .strict()
      .optional(),
  })
  .strict();

/* ─── ack ──────────────────────────────────────────────────────────────────── */

export const ackPayloadSchema = z
  .object({
    cmdId: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
    name: z.enum(/** @type {[string, ...string[]]} */ (COMMAND_NAMES)),
    ok: z.boolean(),
    detail: z.string().max(160),
    ts: z.number().int().nonnegative().optional(),
  })
  .strict();

/* ─── REST: query strings ──────────────────────────────────────────────────── */

/** Longest window `GET /telemetry/history` will serve, in hours. */
const MAX_HISTORY_HOURS = 48;

/**
 * `GET /api/v1/telemetry/history`.
 *
 * `from` and `to` are epoch milliseconds or ISO strings. Defaults: the last
 * 15 minutes. The bucket width is derived from the window when omitted so a
 * caller never has to do the arithmetic, and `maxPoints` caps the response.
 *
 * @type {import('zod').ZodTypeAny}
 */
export const historyQuerySchema = z
  .object({
    sensorId: sensorIdSchema,
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    bucketSec: z.coerce.number().int().min(1).max(3600).optional(),
    maxPoints: z.coerce.number().int().min(10).max(2000).default(600),
  })
  .superRefine((query, ctx) => {
    if (query.from && query.to && query.from >= query.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`from` must be earlier than `to`',
        path: ['from'],
      });
    }
  })
  .transform((query) => {
    const now = Date.now();
    const to = query.to ?? new Date(now);
    const earliest = new Date(now - MAX_HISTORY_HOURS * 3600 * 1000);
    const requestedFrom = query.from ?? new Date(to.getTime() - 15 * 60 * 1000);
    // Older data has expired; clamping is friendlier than an error.
    const from = requestedFrom < earliest ? earliest : requestedFrom;

    const spanSec = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));
    const bucketSec = query.bucketSec ?? Math.max(1, Math.ceil(spanSec / query.maxPoints));

    return { sensorId: query.sensorId, from, to, bucketSec, maxPoints: query.maxPoints };
  });

/**
 * `GET /api/v1/telemetry/latest`: optionally one machine only.
 * @type {import('zod').ZodTypeAny}
 */
export const latestQuerySchema = z.object({
  machineId: z.string().regex(MACHINE_ID_PATTERN).optional(),
});

/**
 * `GET /api/v1/telemetry/spectrum/latest`.
 * @type {import('zod').ZodTypeAny}
 */
export const spectrumQuerySchema = z.object({
  machineId: z.string().regex(MACHINE_ID_PATTERN),
});

export default {
  MAX_PAYLOAD_BYTES,
  birthPayloadSchema,
  statusPayloadSchema,
  telemetryPayloadSchema,
  spectrumPayloadSchema,
  diagPayloadSchema,
  ackPayloadSchema,
  historyQuerySchema,
  latestQuerySchema,
  spectrumQuerySchema,
};
