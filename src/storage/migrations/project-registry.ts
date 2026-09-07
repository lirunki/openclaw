import type {
  ProjectRegistryInsert,
  ProjectRegistryStore,
  StoredProjectRegistryRecord,
} from "../project-registry-store.js";

export type ProjectRegistryMigrationReport = {
  mode: "dry-run" | "execute";
  sourceRows: number;
  existingRows: number;
  copiedRows: number;
};

export async function migrateProjectRegistry(params: {
  source: ProjectRegistryStore;
  target: ProjectRegistryStore;
  mode: "dry-run" | "execute";
  assertSourceStopped: () => void;
}): Promise<ProjectRegistryMigrationReport> {
  params.assertSourceStopped();
  const sourceRows = await params.source.list();
  const report: ProjectRegistryMigrationReport = {
    mode: params.mode,
    sourceRows: sourceRows.length,
    existingRows: 0,
    copiedRows: 0,
  };

  for (const sourceRow of sourceRows) {
    const existing = await params.target.findByRepoRoot(sourceRow.repoRoot);
    if (existing) {
      report.existingRows += 1;
      continue;
    }
    if (params.mode === "dry-run") {
      report.copiedRows += 1;
      continue;
    }
    await params.target.withCheckoutLease(sourceRow.repoRoot, async (lease) => {
      const current = await params.target.findByRepoRoot(sourceRow.repoRoot);
      if (current) {
        report.existingRows += 1;
        return;
      }
      const input: ProjectRegistryInsert = storedProjectToInsert(sourceRow);
      await params.target.insertOrGet(input, lease);
      report.copiedRows += 1;
    });
  }
  return report;
}

function storedProjectToInsert(row: StoredProjectRegistryRecord): ProjectRegistryInsert {
  return {
    id: row.id,
    displayName: row.displayName,
    repoRoot: row.repoRoot,
    ...(row.originUrl ? { originUrl: row.originUrl } : {}),
    source: row.source,
  };
}
