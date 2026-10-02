export type DatabasePool = {
  connect(): Promise<DatabaseClient>;
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

export type DatabaseClient = {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  release(): void;
};

type DatabaseModule = typeof import("@workspace/db");

export function createLazyDatabasePool(
  importer: () => Promise<Pick<DatabaseModule, "pool">> = () => import("@workspace/db"),
) {
  return async (env: NodeJS.ProcessEnv = process.env): Promise<DatabasePool> => {
    if (!env.DATABASE_URL) throw new Error("Approval database is unavailable because DATABASE_URL is not configured.");
    const database = await importer();
    return database.pool as unknown as DatabasePool;
  };
}

export const getApprovalDatabasePool = createLazyDatabasePool();