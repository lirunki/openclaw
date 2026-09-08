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
    const existingByRoot = await params.target.findByRepoRoot(sourceRow.repoRoot);
    if (existingByRoot) {
      assertMatchingProject(sourceRow, existingByRoot);
      report.existingRows += 1;
      continue;
    }
    const existingById = await params.target.findById(sourceRow.id);
    if (existingById) {
      throw projectMigrationConflict(sourceRow, existingById);
    }
    if (params.mode === "dry-run") {
      report.copiedRows += 1;
      continue;
    }
    await params.target.withCheckoutLease(sourceRow.repoRoot, async (lease) => {
      const current = await params.target.findByRepoRoot(sourceRow.repoRoot);
      if (current) {
        assertMatchingProject(sourceRow, current);
        report.existingRows += 1;
        return;
      }
      const input: ProjectRegistryInsert = storedProjectToInsert(sourceRow);
      const inserted = await params.target.insertOrGet(input, lease);
      assertMatchingProject(sourceRow, inserted);
      report.copiedRows += 1;
    });
  }
  return report;
}

function assertMatchingProject(
  source: StoredProjectRegistryRecord,
  target: StoredProjectRegistryRecord,
): void {
  if (
    source.id !== target.id ||
    source.displayName !== target.displayName ||
    source.repoRoot !== target.repoRoot ||
    source.originUrl !== target.originUrl ||
    source.source !== target.source
  ) {
    throw projectMigrationConflict(source, target);
  }
}

function projectMigrationConflict(
  source: StoredProjectRegistryRecord,
  target: StoredProjectRegistryRecord,
): Error {
  return new Error(
    `Project registry migration conflict for source id ${JSON.stringify(source.id)} and target id ${JSON.stringify(target.id)}`,
  );
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
