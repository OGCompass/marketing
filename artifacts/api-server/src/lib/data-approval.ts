import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "./workspace-root";

export function loadDataApproval(): {
  hostingApproved: boolean;
  dataOwner: string;
  appOwner: string;
  confirmedOn: string;
} {
  const record = JSON.parse(
    readFileSync(join(workspaceRoot(), "config/data-approval.json"), "utf8"),
  );
  if (
    typeof record.hostingApproved !== "boolean" ||
    typeof record.dataOwner !== "string" || !record.dataOwner.trim() ||
    typeof record.appOwner !== "string" || !record.appOwner.trim() ||
    typeof record.confirmedOn !== "string" || !record.confirmedOn.trim()
  ) {
    throw new Error("Invalid data-hosting approval configuration.");
  }
  return record;
}