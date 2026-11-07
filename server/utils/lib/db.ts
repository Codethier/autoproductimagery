import { Pool, type PoolConfig, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {acquireDatabaseConnection, DATABASE_CONNECT_ATTEMPT_MS, DatabaseUnavailableError} from './databaseConnection';

type DatabaseEnvironment = Record<string, string | undefined>;

export function getDatabasePoolConfig(environment: DatabaseEnvironment = process.env): PoolConfig {
    const connectionString = environment.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL must be configured for PostgreSQL.");

    let url: URL;
    try {
        url = new URL(connectionString);
    } catch {
        throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error("DATABASE_URL must use PostgreSQL; local SQLite is no longer supported.");
    }
    if (url.searchParams.get("sslmode") === "no-verify") {
        throw new Error("PostgreSQL TLS certificate verification cannot be disabled.");
    }
    // Keep encrypted URL configurations certificate/hostname-verified even if
    // pg adopts libpq-compatible semantics in a later major version.
    url.searchParams.delete("uselibpqcompat");
    if (["prefer", "require", "verify-ca"].includes(url.searchParams.get("sslmode") ?? "")) {
        url.searchParams.set("sslmode", "verify-full");
    }

    const requestedMax = Number(environment.DATABASE_POOL_MAX ?? 3);
    const max = Number.isFinite(requestedMax) ? Math.max(1, Math.min(10, Math.floor(requestedMax))) : 3;
    const config: PoolConfig = {
        connectionString: url.toString(),
        max,
        min: 0,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: DATABASE_CONNECT_ATTEMPT_MS,
        statement_timeout: 30_000,
        query_timeout: 35_000,
        idle_in_transaction_session_timeout: 15_000,
        allowExitOnIdle: true,
        options: "-c timezone=UTC",
    };
    if (environment.DATABASE_SSL === "true") {
        // pg's URL TLS options take precedence over the object. Remove those
        // options so this explicit secure mode cannot be weakened by the URL.
        for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(name);
        config.connectionString = url.toString();
        config.ssl = {
            rejectUnauthorized: true,
            ...(environment.DATABASE_CA_CERT ? {ca: environment.DATABASE_CA_CERT.replace(/\\n/g, "\n")} : {}),
        };
    }
    return config;
}

type PoolConnectCallback = Parameters<Pool['connect']>[0];

/** Both Drizzle transactions and pool.query use this acquisition boundary. */
export class ServerlessPostgresPool extends Pool {
    constructor(config: PoolConfig) {
        const requested = config.connectionTimeoutMillis ?? DATABASE_CONNECT_ATTEMPT_MS;
        super({...config, connectionTimeoutMillis: Number.isFinite(requested) && requested > 0
            ? Math.max(100, Math.min(DATABASE_CONNECT_ATTEMPT_MS, Math.floor(requested))) : DATABASE_CONNECT_ATTEMPT_MS});
    }
    override connect(): Promise<PoolClient>;
    override connect(callback: PoolConnectCallback): void;
    override connect(callback?: PoolConnectCallback): Promise<PoolClient> | void {
        const connected = acquireDatabaseConnection(() => super.connect(), {
            attemptTimeoutMs: this.options.connectionTimeoutMillis ?? DATABASE_CONNECT_ATTEMPT_MS,
            stopped: () => this.ending || this.ended,
        }).then(client => {
            if (this.ending || this.ended) {
                client.release(true);
                throw new DatabaseUnavailableError();
            }
            return client;
        });
        if (!callback) return connected;
        void connected.then(client => callback(undefined, client, client.release), (error: unknown) =>
            callback(error instanceof Error ? error : new DatabaseUnavailableError(), undefined, () => undefined));
    }
}

let pool: Pool | undefined;
let database: NodePgDatabase | undefined;

export function getDatabasePool(): Pool {
    if (!pool) {
        pool = new ServerlessPostgresPool(getDatabasePoolConfig());
        // A disconnected idle client emits an error asynchronously. Handle it
        // without printing connection strings or driver details containing SQL.
        pool.on("error", () => console.error("An idle PostgreSQL connection failed; the pool will reconnect."));
    }
    return pool;
}

export function getDatabase(): NodePgDatabase {
    database ??= drizzle({client: getDatabasePool()});
    return database;
}

// Only explicit shutdown/test cleanup closes the shared warm-instance pool.
export async function closeDatabasePool() {
    const current = pool;
    pool = undefined;
    database = undefined;
    await current?.end();
}
