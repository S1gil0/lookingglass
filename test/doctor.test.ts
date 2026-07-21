import assert from "node:assert/strict";
import test from "node:test";
import { schedulerDoctorCheck } from "../src/doctor.js";

test("doctor converts scheduler failures into a failed check", () => {
  const check = schedulerDoctorCheck(() => {
    throw new Error("Task Scheduler lookup unavailable");
  });

  assert.deepEqual(check, {
    name: "scheduler",
    ok: false,
    detail: "Task Scheduler lookup unavailable",
    fatal: true,
  });
});

test("doctor keeps scheduler status details readable", () => {
  assert.deepEqual(
    schedulerDoctorCheck(() => "TaskStatus=Running\nActiveState=active"),
    { name: "scheduler", ok: true, detail: "TaskStatus=Running, ActiveState=active", fatal: false },
  );
});

test("doctor treats an inactive scheduler as an advisory failure", () => {
  assert.deepEqual(
    schedulerDoctorCheck(() => "TaskStatus=NotInstalled\nActiveState=inactive"),
    { name: "scheduler", ok: false, detail: "TaskStatus=NotInstalled, ActiveState=inactive", fatal: false },
  );
});