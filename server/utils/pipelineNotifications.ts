import type { PoolClient } from "pg";

type NotificationClient = Pick<
  PoolClient,
  "query" | "release" | "on" | "removeListener"
>;
export type PipelineNotificationDependencies = {
  pool: { connect(): Promise<NotificationClient> };
  notify(): void;
  unavailable(): void;
};

/** LISTEN is a latency hint; durable polling must continue when it is unavailable. */
export function createPipelineNotifications(
  deps: PipelineNotificationDependencies,
) {
  let closed = false, epoch = 0;
  let current:
    { client: NotificationClient; release(): void; ready: boolean } | undefined;
  let connecting: Promise<boolean> | undefined;

  async function connect(): Promise<boolean> {
    if (closed) return false;
    if (current?.ready) return true;
    if (connecting) return connecting;
    const connectingEpoch = epoch;
    connecting = (async () => {
      let client: NotificationClient;
      try {
        client = await deps.pool.connect();
      } catch {
        if (!closed) deps.unavailable();
        return false;
      }
      let released = false;
      const notification = (value: { channel?: string }) => {
        if (!closed && !released && value.channel === "pipeline_run_ready")
          deps.notify();
      };
      const release = () => {
        if (released) return;
        released = true;
        if (current?.client === client) current = undefined;
        client.removeListener("notification", notification);
        // Keep the guarded error listener until the destroyed client
        // is collected. A late socket error must not be unhandled.
        try {
          client.release(true);
        } catch {
          /* already unusable */
        }
      };
      const disconnected = () => {
        if (released) return;
        release();
        if (!closed) deps.unavailable();
      };
      client.on("error", disconnected);
      client.on("end", disconnected);
      if (closed || connectingEpoch !== epoch) {
        release();
        return false;
      }
      current = { client, release, ready: false };
      client.on("notification", notification);
      try {
        await client.query("LISTEN pipeline_run_ready");
        if (closed || released || connectingEpoch !== epoch) {
          release();
          return false;
        }
        if (current?.client === client) current.ready = true;
        return true;
      } catch {
        release();
        if (!closed) deps.unavailable();
        return false;
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function disconnect() {
    epoch++;
    current?.release();
    // A client acquired after shutdown begins is released in connect()
    // before PostgreSQL's pool is allowed to close.
    await connecting;
  }
  async function close() {closed = true; await disconnect();}
  return {
    connect,
    disconnect,
    close,
    get connected() {
      return Boolean(current?.ready);
    },
  };
}
