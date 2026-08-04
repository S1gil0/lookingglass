import assert from "node:assert/strict";
import test from "node:test";
import { ModalArbiter } from "../src/ui/modal-arbiter.js";

test("modal arbiter presents requests in FIFO order", async () => {
  const opened: string[] = [];
  const closed: string[] = [];
  let finishFirst!: (value: string) => void;
  let finishSecond!: (value: string) => void;
  const arbiter = new ModalArbiter();
  const first = arbiter.request<string>((finish) => {
    opened.push("first");
    finishFirst = finish;
    return { close: () => closed.push("first") };
  }, "cancelled");
  const second = arbiter.request<string>((finish) => {
    opened.push("second");
    finishSecond = finish;
    return { close: () => closed.push("second") };
  }, "cancelled");

  assert.deepEqual(opened, ["first"]);
  finishFirst("one");
  assert.deepEqual(opened, ["first", "second"]);
  finishSecond("two");
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
  assert.deepEqual(closed, ["first", "second"]);
});

test("modal arbiter cancellation settles visible and waiting requests", async () => {
  const opened: string[] = [];
  const closed: string[] = [];
  const arbiter = new ModalArbiter();
  const visible = arbiter.request<string>((_finish) => {
    opened.push("visible");
    return { close: () => closed.push("visible") };
  }, "denied");
  const waiting = arbiter.request<string>((_finish) => {
    opened.push("waiting");
    return { close: () => closed.push("waiting") };
  }, "cancelled");

  arbiter.cancelAll();
  assert.deepEqual(await Promise.all([visible, waiting]), ["denied", "cancelled"]);
  assert.deepEqual(opened, ["visible"]);
  assert.deepEqual(closed, ["visible"]);
  assert.equal(arbiter.hasVisibleModal, false);
});