import assert from "node:assert/strict";
import test from "node:test";
import { report } from "../src/course_policy.ts";

test("late completion remains overdue in the educator report", () => {
  const result = report({ id: "algebra", title: "Algebra", deadline: "2026-09-01T00:00:00Z", enrollments: [
    { learnerId: "a", completedAt: "2026-08-31T12:00:00Z" },
    { learnerId: "b", completedAt: "2026-09-02T12:00:00Z" },
    { learnerId: "c" }
  ] }, "2026-09-03T00:00:00Z");
  assert.deepEqual(result, { courseId: "algebra", enrolled: 3, completedOnTime: 1, overdue: 2 });
});
