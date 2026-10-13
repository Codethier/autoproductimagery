import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { createPipelineNotifications } from "../server/utils/pipelineNotifications.ts";
import { createPipelineWorkerLoop } from "../server/utils/pipelineWorkerLoop.ts";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Client extends EventEmitter {
  releases = 0;
  queries: string[] = [];
  work: () => Promise<unknown> = async () => ({});
  async query(text: string) {
    this.queries.push(text);
    return this.work();
  }
  release(destroy?: boolean) {
    assert.equal(destroy, true);
    this.releases++;
  }
}
const clientAs = (client: Client) => client as unknown as PoolClient;

test("notification connections coalesce, reconnect after disconnect and never release a client twice", async () => {
  const first = new Client(),
    second = new Client(),
    acquiring = gate<PoolClient>();
  let connections = 0,
    notifications = 0,
    unavailable = 0;
  const helper = createPipelineNotifications({
    pool: {
      connect: () =>
        ++connections === 1
          ? acquiring.promise
          : Promise.resolve(clientAs(second)),
    },
    notify: () => notifications++,
    unavailable: () => unavailable++,
  });
  const a = helper.connect(),
    b = helper.connect();
  assert.equal(connections, 1);
  acquiring.resolve(clientAs(first));
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(helper.connected, true);
  assert.deepEqual(first.queries, ["LISTEN pipeline_run_ready"]);
  first.emit("notification", { channel: "unrelated" });
  first.emit("notification", {
    channel: "pipeline_run_ready",
    payload: "untrusted SQL-looking payload is ignored",
  });
  assert.equal(notifications, 1);
  first.emit("error", new Error("private connection diagnostic"));
  first.emit("end");
  first.emit("error", new Error("late socket error"));
  assert.equal(first.releases, 1);
  assert.equal(unavailable, 1);
  assert.equal(helper.connected, false);
  assert.equal(await helper.connect(), true);
  await helper.close();
  await helper.close();
  second.emit("notification", { channel: "pipeline_run_ready" });
  second.emit("error", new Error("late destroyed socket error"));
  assert.equal(second.releases, 1);
  assert.equal(await helper.connect(), false);
  assert.equal(connections, 2);
  assert.equal(notifications, 1);
});

test("shutdown waits for an acquisition and releases a client that arrives after stopping before LISTEN", async () => {
  const client = new Client(),
    acquiring = gate<PoolClient>();
  const helper = createPipelineNotifications({
    pool: { connect: () => acquiring.promise },
    notify: () => assert.fail("No wake after close"),
    unavailable: () => assert.fail("Shutdown is not an outage"),
  });
  const connecting = helper.connect();
  let stopped = false;
  const stopping = helper.close().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  acquiring.resolve(clientAs(client));
  assert.equal(await connecting, false);
  await stopping;
  assert.equal(stopped, true);
  assert.equal(client.releases, 1);
  assert.deepEqual(client.queries, []);
  client.emit("error", new Error("late socket event after stop"));
  assert.equal(client.releases, 1);
});

test("shutdown during the LISTEN query releases once and does not restore a stopped connection", async () => {
  const client = new Client(),
    listening = gate<unknown>(),
    entered = gate();
  client.work = () => {
    entered.resolve();
    return listening.promise;
  };
  const helper = createPipelineNotifications({
    pool: { connect: async () => clientAs(client) },
    notify: () => assert.fail("No notification after stop"),
    unavailable: () => assert.fail("No outage notification during stop"),
  });
  const connecting = helper.connect();
  await entered.promise;
  const stopping = helper.close();
  assert.equal(client.releases, 1);
  listening.resolve({});
  assert.equal(await connecting, false);
  await stopping;
  assert.equal(helper.connected, false);
  client.emit("end");
  client.emit("error", new Error("late query/socket failure"));
  assert.equal(client.releases, 1);
});

test("LISTEN or connection failure is best effort and authoritative worker polling still drains saved jobs", async () => {
  const client = new Client();
  client.work = async () => {
    throw new Error("LISTEN unavailable, private diagnostic");
  };
  let unavailable = 0,
    calls = 0,
    connectionFails = false;
  const helper = createPipelineNotifications({
    pool: {
      connect: async () => {
        if (connectionFails)
          throw new Error("Private PostgreSQL connection diagnostic");
        return clientAs(client);
      },
    },
    notify: () => {},
    unavailable: () => unavailable++,
  });
  let pending = true;
  const worker = createPipelineWorkerLoop({
    load: async () => (pending ? [{ runId: "saved-run" }] : []),
    advance: async () => {
      calls++;
      pending = false;
      return true;
    },
    error: () => assert.fail("Polling remains available"),
  });
  assert.equal(await helper.connect(), false);
  await worker.kick();
  assert.equal(calls, 1);
  assert.equal(client.releases, 1);
  connectionFails = true;
  assert.equal(await helper.connect(), false);
  pending = true;
  await worker.kick();
  assert.equal(calls, 2);
  assert.equal(unavailable, 2);
  await Promise.all([helper.close(), worker.close()]);
});
