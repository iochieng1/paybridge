import { Queue, Worker } from "bullmq";
import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

import type { Database } from "../db/client.js";
import { payments, webhookDeliveries, webhookEndpoints } from "../db/schema.js";
import type { DarajaClient } from "../mpesa/daraja.js";
import type { Payment } from "../payments/payments.js";
import { reconcilePendingPayments } from "../payments/reconcile.js";
import {
  deliverPaymentWebhook,
  FINAL_STATUSES,
  WEBHOOK_RETRY_DELAYS_MS,
} from "../webhooks/deliver.js";

/** How often reconciliation and the webhook sweep run. */
export const MAINTENANCE_INTERVAL_MS = 60_000;

/** Final payments this recent are checked for a webhook that was never queued. */
const SWEEP_WINDOW_MINUTES = 60;

export type JobsOptions = {
  redisUrl: string;
  db: Database;
  daraja: DarajaClient;
  log: FastifyBaseLogger;
  encryptionKey: Buffer;
  allowPrivateAddresses: boolean;
  /** Start workers in this process (the API process runs them by default). */
  runWorkers: boolean;
  /** Namespace for BullMQ's Redis keys; tests use a unique one per app. */
  prefix?: string;
  retryDelaysMs?: number[];
  maintenanceIntervalMs?: number;
  webhookTimeoutMs?: number;
};

const webhookJobId = (paymentId: string) => `payment-${paymentId}`;

/**
 * Background work on BullMQ:
 * - `webhooks`: one job per final payment, retried with the backoff in
 *   WEBHOOK_RETRY_DELAYS_MS. The job id is derived from the payment, so
 *   queueing the same payment twice is a no-op.
 * - `maintenance`: a repeatable job, every minute, that reconciles stale
 *   PENDING payments and queues any webhook that was missed (say, the
 *   process died between settling a payment and queueing its webhook).
 */
export const createJobs = ({
  redisUrl,
  db,
  daraja,
  log,
  encryptionKey,
  allowPrivateAddresses,
  runWorkers,
  prefix = "bull",
  retryDelaysMs = WEBHOOK_RETRY_DELAYS_MS,
  maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
  webhookTimeoutMs,
}: JobsOptions) => {
  // Producers fail fast if Redis is down (the sweep catches up later), so a
  // callback request is never stuck waiting on the queue.
  const producer = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const queueOptions = { connection: producer, prefix };
  const webhookQueue = new Queue("webhooks", {
    ...queueOptions,
    defaultJobOptions: {
      attempts: retryDelaysMs.length + 1,
      backoff: { type: "custom" },
      // Kept a while so a re-queue of a finished payment stays a no-op.
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  });
  const maintenanceQueue = new Queue("maintenance", {
    ...queueOptions,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });

  /** Queues the webhook for a payment that just reached a final status. */
  const enqueueWebhook = async (payment: Pick<Payment, "id">) => {
    await webhookQueue.add(
      "deliver",
      { paymentId: payment.id },
      { jobId: webhookJobId(payment.id) },
    );
  };

  /** Like enqueueWebhook, but logs instead of throwing: the sweep retries. */
  const notifyPaymentFinal = async (payment: Pick<Payment, "id">) => {
    try {
      await enqueueWebhook(payment);
    } catch (err) {
      log.error(
        { err, paymentId: payment.id },
        "Failed to queue webhook; the sweep will retry",
      );
    }
  };

  /** Queues webhooks for recent final payments that have none logged. */
  const sweepMissedWebhooks = async () => {
    const missed = await db
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(
        webhookEndpoints,
        eq(webhookEndpoints.merchantId, payments.merchantId),
      )
      .where(
        and(
          inArray(payments.status, FINAL_STATUSES),
          gt(
            payments.completedAt,
            sql`now() - make_interval(mins => ${SWEEP_WINDOW_MINUTES})`,
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(webhookDeliveries)
              .where(eq(webhookDeliveries.paymentId, payments.id)),
          ),
        ),
      )
      .limit(100);
    for (const payment of missed) await enqueueWebhook(payment);
    return missed.length;
  };

  const runMaintenance = async () => {
    const reconciled = await reconcilePendingPayments({
      db,
      daraja,
      log,
      onFinal: enqueueWebhook,
    });
    const swept = await sweepMissedWebhooks();
    if (reconciled.checked > 0 || swept > 0) {
      log.info({ reconciled, swept }, "Maintenance run finished");
    }
    return { reconciled, swept };
  };

  const workers: Worker[] = [];
  const workerConnections: Redis[] = [];
  if (runWorkers) {
    // Workers block on Redis, so BullMQ needs retries left unlimited. BullMQ
    // doesn't close connections it was given, so close() quits these.
    const workerConnection = () => {
      const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      workerConnections.push(connection);
      return connection;
    };

    const webhookWorker = new Worker<{ paymentId: string }>(
      "webhooks",
      async (job) => {
        // attemptsStarted counts every run, including one re-run after a
        // crash, so each logged attempt gets its own number.
        const attempt = job.attemptsStarted;
        const retryInMs =
          attempt <= retryDelaysMs.length
            ? retryDelaysMs[attempt - 1]
            : undefined;
        const outcome = await deliverPaymentWebhook(
          {
            db,
            encryptionKey,
            allowPrivateAddresses,
            timeoutMs: webhookTimeoutMs,
          },
          job.data.paymentId,
          attempt,
          retryInMs,
        );
        const jobLog = log.child({ paymentId: job.data.paymentId, attempt });
        if (outcome.kind === "failed") {
          jobLog.warn(
            { statusCode: outcome.statusCode, error: outcome.error, retryInMs },
            "Webhook delivery failed",
          );
          // Throwing hands the job back to BullMQ to retry with backoff.
          throw new Error(outcome.error);
        }
        jobLog.info({ outcome }, "Webhook job finished");
        return outcome;
      },
      {
        connection: workerConnection(),
        prefix,
        concurrency: 10,
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            retryDelaysMs[attemptsMade - 1] ?? retryDelaysMs.at(-1)!,
        },
      },
    );

    const maintenanceWorker = new Worker("maintenance", runMaintenance, {
      connection: workerConnection(),
      prefix,
      concurrency: 1,
    });

    for (const worker of [webhookWorker, maintenanceWorker]) {
      worker.on("error", (err) =>
        log.error({ err, queue: worker.name }, "Queue worker error"),
      );
      workers.push(worker);
    }
  }

  /** Registers the repeatable maintenance job (idempotent across instances). */
  const start = async () => {
    await maintenanceQueue.upsertJobScheduler(
      "maintenance",
      { every: maintenanceIntervalMs },
      { name: "maintenance" },
    );
  };

  const close = async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled([webhookQueue.close(), maintenanceQueue.close()]);
    await Promise.allSettled(
      [producer, ...workerConnections].map((connection) => connection.quit()),
    );
  };

  return {
    webhookQueue,
    enqueueWebhook,
    notifyPaymentFinal,
    sweepMissedWebhooks,
    runMaintenance,
    start,
    close,
  };
};

export type Jobs = ReturnType<typeof createJobs>;
