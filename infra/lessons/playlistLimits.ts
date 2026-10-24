// How many lessons one bulk add takes. The Worker refuses a longer list, and
// the client splits a bigger selection into requests of this size, in order.
// A course is tens of lessons, so one request almost always does.
export const MAX_LESSONS_PER_ADD = 200;
