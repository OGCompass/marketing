import { integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const programApprovalReview = pgTable("program_approval_review", {
  id: varchar("id", { length: 40 }).primaryKey(),
  revision: integer("revision").notNull().default(0),
  sourceVersion: varchar("source_version", { length: 64 }).notNull(),
  ruleVersion: varchar("rule_version", { length: 64 }).notNull(),
  inventoryGeneratedAt: timestamp("inventory_generated_at", { withTimezone: true }),
  answers: jsonb("answers").notNull().default({}),
  sectionApprovals: jsonb("section_approvals").notNull().default({}),
  finalSignoff: jsonb("final_signoff"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const programApprovalHistory = pgTable("program_approval_history", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  revision: integer("revision").notNull(),
  action: varchar("action", { length: 24 }).notNull(),
  sectionId: varchar("section_id", { length: 80 }),
  actorUserId: text("actor_user_id").notNull(),
  reviewerLabel: varchar("reviewer_label", { length: 80 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  sourceVersion: varchar("source_version", { length: 64 }).notNull(),
  summary: text("summary").notNull(),
  stateSnapshot: jsonb("state_snapshot").notNull(),
});

export const maskedInventorySource = pgTable("masked_inventory_source", {
  id: varchar("id", { length: 40 }).primaryKey(),
  sourceVersion: varchar("source_version", { length: 64 }).notNull(),
  report: jsonb("report").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});