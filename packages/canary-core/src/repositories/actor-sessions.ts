import { createSessionToken, generateActorIdentity } from "../identity/runtime-identity.js";
import type { CanaryConnection } from "../db/connection.js";
import { createId } from "../db/ids.js";
import { parseJsonObject, stringifyJson } from "../db/json.js";
import type { JsonObject, ResolvedActorIdentity, SessionRecord, StartedAgentSession } from "../types/models.js";
import type { ActorKind, AgentKind } from "../types/models.js";

interface ActorRow {
  id: string;
  kind: string;
  display_name: string;
  avatar_svg: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  project_root: string;
  agent_kind: string;
  actor_id: string | null;
  session_token: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  metadata_json: string;
}

function mapSession(row: SessionRow, actor: ActorRow | null): SessionRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    agentKind: row.agent_kind as SessionRecord["agentKind"],
    status: row.status as SessionRecord["status"],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: parseJsonObject(row.metadata_json),
    actorId: actor?.id ?? row.actor_id ?? null,
    actorName: actor?.display_name ?? null,
    actorAvatarSvg: actor?.avatar_svg ?? null
  };
}

async function createActor(connection: CanaryConnection, kind: ActorKind): Promise<ActorRow> {
  const now = new Date().toISOString();
  const identity = generateActorIdentity(kind);

  await connection.db
    .insertInto("actors")
    .values({
      id: identity.id,
      project_root: connection.projectRoot,
      kind,
      display_name: identity.displayName,
      avatar_svg: identity.avatarSvg,
      created_at: now,
      updated_at: now
    })
    .execute();

  return {
    id: identity.id,
    kind,
    display_name: identity.displayName,
    avatar_svg: identity.avatarSvg,
    created_at: now,
    updated_at: now
  };
}

async function createSessionWithActor(
  connection: CanaryConnection,
  kind: ActorKind,
  actor: ActorRow,
  metadata: JsonObject,
  sessionToken: string | null
): Promise<SessionRecord> {
  const id = createId("sess");
  const startedAt = new Date().toISOString();

  await connection.db
    .insertInto("sessions")
    .values({
      id,
      project_root: connection.projectRoot,
      agent_kind: kind,
      actor_id: actor.id,
      session_token: sessionToken,
      status: "running",
      started_at: startedAt,
      ended_at: null,
      metadata_json: stringifyJson(metadata)
    })
    .execute();

  return {
    id,
    projectRoot: connection.projectRoot,
    agentKind: kind,
    status: "running",
    startedAt,
    endedAt: null,
    metadata,
    actorId: actor.id,
    actorName: actor.display_name,
    actorAvatarSvg: actor.avatar_svg
  };
}

async function ensureProjectHumanActor(connection: CanaryConnection): Promise<ActorRow> {
  const existing = await connection.db
    .selectFrom("actors")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .where("kind", "=", "human")
    .orderBy("created_at", "asc")
    .limit(1)
    .executeTakeFirst();

  if (existing) {
    return existing as ActorRow;
  }

  return createActor(connection, "human");
}

export async function startAgentSession(
  connection: CanaryConnection,
  kind: AgentKind,
  metadata: JsonObject = {}
): Promise<StartedAgentSession> {
  const actor = await createActor(connection, kind);
  const sessionToken = createSessionToken();
  const session = await createSessionWithActor(connection, kind, actor, metadata, sessionToken);
  return {
    session,
    sessionToken
  };
}

export async function createMonitorSession(
  connection: CanaryConnection,
  metadata: JsonObject = {}
): Promise<SessionRecord> {
  const actor = await createActor(connection, "monitor");
  return createSessionWithActor(connection, "monitor", actor, metadata, null);
}

export async function resolveCallerIdentity(
  connection: CanaryConnection,
  sessionToken?: string | null,
  fallbackToHuman = true
): Promise<ResolvedActorIdentity> {
  if (sessionToken) {
    const row = await connection.db
      .selectFrom("sessions")
      .leftJoin("actors", "actors.id", "sessions.actor_id")
      .select([
        "sessions.id as session_id",
        "sessions.actor_id as actor_id",
        "actors.kind as actor_kind",
        "actors.display_name as display_name",
        "actors.avatar_svg as avatar_svg"
      ])
      .where("sessions.project_root", "=", connection.projectRoot)
      .where("sessions.session_token", "=", sessionToken)
      .where("sessions.status", "=", "running")
      .executeTakeFirst();

    if (row && row.display_name) {
      return {
        sessionId: row.session_id,
        authorId: row.actor_id,
        author: row.display_name,
        authorType: (row.actor_kind as ResolvedActorIdentity["authorType"]) ?? null,
        authorAvatarSvg: row.avatar_svg ?? null
      };
    }
  }

  if (!fallbackToHuman) {
    return {
      sessionId: null,
      authorId: null,
      author: "unknown",
      authorType: null,
      authorAvatarSvg: null
    };
  }

  const actor = await ensureProjectHumanActor(connection);
  return {
    sessionId: null,
    authorId: actor.id,
    author: actor.display_name,
    authorType: "human",
    authorAvatarSvg: actor.avatar_svg
  };
}

export async function getSessionByToken(
  connection: CanaryConnection,
  sessionToken: string
): Promise<SessionRecord | null> {
  const row = await connection.db
    .selectFrom("sessions")
    .leftJoin("actors", "actors.id", "sessions.actor_id")
    .select([
      "sessions.id as id",
      "sessions.project_root as project_root",
      "sessions.agent_kind as agent_kind",
      "sessions.actor_id as actor_id",
      "sessions.session_token as session_token",
      "sessions.status as status",
      "sessions.started_at as started_at",
      "sessions.ended_at as ended_at",
      "sessions.metadata_json as metadata_json",
      "actors.id as actor_join_id",
      "actors.kind as actor_kind",
      "actors.display_name as display_name",
      "actors.avatar_svg as avatar_svg",
      "actors.created_at as actor_created_at",
      "actors.updated_at as actor_updated_at"
    ])
    .where("sessions.project_root", "=", connection.projectRoot)
    .where("sessions.session_token", "=", sessionToken)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const actor = row.actor_join_id
    ? {
        id: row.actor_join_id,
        kind: row.actor_kind ?? row.agent_kind,
        display_name: row.display_name ?? row.agent_kind,
        avatar_svg: row.avatar_svg ?? "",
        created_at: row.actor_created_at ?? row.started_at,
        updated_at: row.actor_updated_at ?? row.started_at
      }
    : null;

  return mapSession(row as SessionRow, actor);
}
