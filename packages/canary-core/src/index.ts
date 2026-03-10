export { applyMigrations } from "./db/migrate.js";
export { openConnection } from "./db/connection.js";
export { createId } from "./db/ids.js";
export {
  addThreadMessage,
  appendEvent,
  createNote,
  createReviewMark,
  createSession,
  createThread,
  finishSession,
  getLatestSession,
  getProjectOverview,
  listFileBriefs,
  listNotes,
  listRecentEvents,
  listReviewMarks,
  listThreads,
  searchProject,
  upsertFileBrief
} from "./repositories/project-repository.js";
export type * from "./types/database.js";
export type * from "./types/models.js";
export type { CanaryConnection } from "./db/connection.js";
