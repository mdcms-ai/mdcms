import { z } from "zod";

export const CollaborationPresenceModeSchema = z.enum(["view", "edit"]);

export type CollaborationPresenceMode = z.infer<
  typeof CollaborationPresenceModeSchema
>;

export const CollaborationPresenceCursorSchema = z.object({
  anchor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
});

export type CollaborationPresenceCursor = z.infer<
  typeof CollaborationPresenceCursorSchema
>;

export const CollaborationPresenceUpdateSchema = z.object({
  type: z.literal("presence.update"),
  documentId: z.string().uuid().nullable().optional(),
  mode: CollaborationPresenceModeSchema,
  cursor: CollaborationPresenceCursorSchema.nullable().optional(),
});

export type CollaborationPresenceUpdate = z.infer<
  typeof CollaborationPresenceUpdateSchema
>;

export const CollaborationPresenceUserSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  documentId: z.string().uuid().nullable(),
  mode: CollaborationPresenceModeSchema,
  cursor: CollaborationPresenceCursorSchema.optional(),
  updatedAt: z.string().datetime(),
});

export type CollaborationPresenceUser = z.infer<
  typeof CollaborationPresenceUserSchema
>;

export const CollaborationPresenceSnapshotSchema = z.object({
  type: z.literal("presence.snapshot"),
  project: z.string().min(1),
  environment: z.string().min(1),
  users: z.array(CollaborationPresenceUserSchema),
});

export type CollaborationPresenceSnapshot = z.infer<
  typeof CollaborationPresenceSnapshotSchema
>;
