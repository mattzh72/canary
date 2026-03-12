import { createHash, randomBytes } from "node:crypto";
import { createId } from "../db/ids.js";
import type { ActorKind } from "../types/models.js";
import { ALOHE_AVATAR_PATHS } from "./alohe-avatars.js";

const ADJECTIVES = [
  "amber",
  "brisk",
  "cobalt",
  "curious",
  "daring",
  "eager",
  "fuzzy",
  "gentle",
  "hungry",
  "jolly",
  "lucky",
  "mellow",
  "nimble",
  "orbiting",
  "peppy",
  "quiet",
  "rapid",
  "solar",
  "tidy",
  "vivid",
  "witty",
  "zesty"
] as const;

const NOUNS = [
  "badger",
  "comet",
  "falcon",
  "hippo",
  "juniper",
  "lantern",
  "meadow",
  "otter",
  "pine",
  "quartz",
  "raccoon",
  "signal",
  "sparrow",
  "tiger",
  "willow",
  "yarrow"
] as const;

export interface GeneratedActorIdentity {
  id: string;
  kind: ActorKind;
  displayName: string;
  avatarSvg: string;
}

function hashSeed(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function pick<T>(items: readonly T[], seed: Buffer, offset: number): T {
  const value = seed[offset] ?? 0;
  return items[value % items.length] as T;
}

function createDisplayName(kind: ActorKind, seed: string): string {
  if (kind === "monitor") {
    return "canary-watchtower";
  }

  if (kind === "human") {
    return "local-engineer";
  }

  const hash = hashSeed(`${seed}:name`);
  const adjective = pick(ADJECTIVES, hash, 0);
  const noun = pick(NOUNS, hash, 1);
  return `${adjective}-${noun}-${kind}`;
}

function createAvatarPath(seed: string): string {
  const hash = hashSeed(`${seed}:avatar`);
  return pick(ALOHE_AVATAR_PATHS, hash, 0);
}

export function createSessionToken(): string {
  return randomBytes(24).toString("hex");
}

export function generateActorIdentity(kind: ActorKind): GeneratedActorIdentity {
  const id = createId("actor");
  return {
    id,
    kind,
    displayName: createDisplayName(kind, id),
    avatarSvg: createAvatarPath(id)
  };
}
