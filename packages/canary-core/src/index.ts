export { applyMigrations } from "./db/migrate.js";
export { openConnection } from "./db/connection.js";
export { createId } from "./db/ids.js";
export {
  getCanaryHomeDir,
  getProjectDbFile,
  getProjectStateDir,
  getProjectStorageKey,
  resolveProjectRoot
} from "./db/storage.js";
export {
  addThreadMessage,
  appendEvent,
  createSession,
  createThread,
  finishSession,
  getLatestSession,
  getProjectOverview,
  listFileBriefs,
  listRecentEvents,
  listTodos,
  listThreads,
  reconcileArtifactsForFileChange,
  searchProject,
  updateThreadStatus,
  upsertFileBrief
} from "./repositories/project-repository.js";
export type * from "./types/database.js";
export type * from "./types/models.js";
export type { CanaryConnection } from "./db/connection.js";
