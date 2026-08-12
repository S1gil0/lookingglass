import assert from "node:assert/strict";
import test from "node:test";
import { LookingGlassApp } from "../src/app.js";
import type { SessionRecord } from "../src/types.js";

function session(id: string): SessionRecord {
  return { id } as SessionRecord;
}

test("one-shot runs create new sessions unless a session id is explicit", async () => {
  const created = session("new-session");
  const resumed = session("existing-session");
  const calls: string[] = [];
  const app = Object.create(LookingGlassApp.prototype) as LookingGlassApp;
  app.createSession = async () => {
    calls.push("create");
    return created;
  };
  app.currentOrNewSession = async (id?: string) => {
    calls.push(`resume:${id ?? ""}`);
    return resumed;
  };

  assert.equal(await app.sessionForRun(), created);
  assert.equal(await app.sessionForRun("existing-session"), resumed);
  assert.deepEqual(calls, ["create", "resume:existing-session"]);
});