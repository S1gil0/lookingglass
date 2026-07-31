import assert from "node:assert/strict";
import test from "node:test";
import { LookingGlassApp } from "../src/app.js";
import { transientRetryDelay, waitForTransientRetry } from "../src/retry.js";
import type { GatewayModel } from "../src/types.js";

const model = {
  id: "test-model",
  provider: "custom",
} as GatewayModel;

test("transient retry delays grow exponentially and cap at thirty seconds", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => transientRetryDelay(index + 1)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
  );
});

test("transient retry waits remain cancellable when an injected delay ignores its signal", async () => {
  const controller = new AbortController();
  const waiting = waitForTransientRetry(
    controller.signal,
    1,
    undefined,
    async () => new Promise<void>(() => undefined),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("stop retrying"));
  await assert.rejects(waiting, /stop retrying/);
});

test("turn model lookup retries transient catalog outages but not permanent model errors", async () => {
  const app = Object.create(LookingGlassApp.prototype) as LookingGlassApp;
  const delays: number[] = [];
  const statuses: string[] = [];
  let requests = 0;
  app.catalogModel = async () => {
    requests += 1;
    if (requests <= 2) throw Object.assign(new Error("catalog unavailable"), { status: 503 });
    return model;
  };

  const found = await app.modelForTurn(
    model.id,
    model.provider,
    new AbortController().signal,
    (status) => statuses.push(status),
    async (milliseconds) => { delays.push(milliseconds); },
  );
  assert.equal(found, model);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.ok(statuses.some((status) => /Ctrl\+C/.test(status)));

  requests = 0;
  delays.length = 0;
  app.catalogModel = async () => {
    requests += 1;
    throw Object.assign(new Error("model not found"), { status: 404 });
  };
  await assert.rejects(app.modelForTurn(
    model.id,
    model.provider,
    new AbortController().signal,
    undefined,
    async (milliseconds) => { delays.push(milliseconds); },
  ), /model not found/);
  assert.equal(requests, 1);
  assert.deepEqual(delays, []);
});