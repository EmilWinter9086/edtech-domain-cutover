export type Enrollment = { learnerId: string; completedAt?: string };
export type Course = { id: string; title: string; deadline: string; enrollments: Enrollment[] };

export function report(course: Course, now: string) {
  const due = Date.parse(course.deadline) < Date.parse(now);
  const completed = course.enrollments.filter((entry) => entry.completedAt && Date.parse(entry.completedAt) <= Date.parse(course.deadline)).length;
  return {
    courseId: course.id,
    enrolled: course.enrollments.length,
    completedOnTime: completed,
    overdue: due ? course.enrollments.length - completed : 0
  };
}
