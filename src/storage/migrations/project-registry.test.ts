import { describe, expect, it } from "vitest";
import type {
  ProjectCheckoutReferenceRemoval,
  ProjectRegistryInsert,
  ProjectRegistryLease,
  ProjectRegistryStore,
  StoredProjectRegistryRecord,
} from "../project-registry-store.js";
import { migrateProjectRegistry } from "./project-registry.js";

class MemoryProjectStore implements ProjectRegistryStore {
  readonly rows = new Map<string, StoredProjectRegistryRecord>();
  leaseCount = 0;

  async withCheckoutLease<T>(_repoRoot: string, run: (lease: ProjectRegistryLease) => Promise<T>) {
    this.leaseCount += 1;
    return await run({
      assertOwned: () => {},
      assertOwnedInTransaction: () => {},
    });
  }

  async list(): Promise<StoredProjectRegistryRecord[]> {
    return [...this.rows.values()];
  }

  async findById(id: string): Promise<StoredProjectRegistryRecord | undefined> {
    return this.rows.get(id);
  }

  async findByRepoRoot(repoRoot: string): Promise<StoredProjectRegistryRecord | undefined> {
    return [...this.rows.values()].find((row) => row.repoRoot === repoRoot);
  }

  async findByOriginUrl(originUrl: string): Promise<StoredProjectRegistryRecord | undefined> {
    return [...this.rows.values()].find((row) => row.originUrl === originUrl);
  }

  async insertOrGet(
    input: ProjectRegistryInsert,
    _lease: ProjectRegistryLease,
  ): Promise<StoredProjectRegistryRecord> {
    const record: StoredProjectRegistryRecord = {
      id: input.id ?? input.displayName.toLowerCase(),
      displayName: input.displayName,
      repoRoot: input.repoRoot,
      ...(input.originUrl ? { originUrl: input.originUrl } : {}),
      source: input.source,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async removeCheckoutReference(
    _project: StoredProjectRegistryRecord,
    _lease: ProjectRegistryLease,
  ): Promise<ProjectCheckoutReferenceRemoval> {
    return "missing";
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

describe("migrateProjectRegistry", () => {
  it("plans without writing and reports existing rows", async () => {
    const source = new MemoryProjectStore();
    source.rows.set("one", {
      id: "one",
      displayName: "One",
      repoRoot: "/one",
      source: "registered",
    });
    source.rows.set("two", {
      id: "two",
      displayName: "Two",
      repoRoot: "/two",
      source: "cloned",
    });
    const target = new MemoryProjectStore();
    target.rows.set("one", source.rows.get("one") as StoredProjectRegistryRecord);

    await expect(
      migrateProjectRegistry({
        source,
        target,
        mode: "dry-run",
        assertSourceStopped: () => {},
      }),
    ).resolves.toEqual({ mode: "dry-run", sourceRows: 2, existingRows: 1, copiedRows: 1 });
    expect(target.rows.size).toBe(1);
    expect(target.leaseCount).toBe(0);
  });

  it("copies canonical rows with stable ids after the source-stop gate", async () => {
    const source = new MemoryProjectStore();
    source.rows.set("stable-id", {
      id: "stable-id",
      displayName: "Stable",
      repoRoot: "/stable",
      originUrl: "https://example.invalid/stable.git",
      source: "cloned",
    });
    const target = new MemoryProjectStore();
    let stopped = false;

    await expect(
      migrateProjectRegistry({
        source,
        target,
        mode: "execute",
        assertSourceStopped: () => {
          stopped = true;
        },
      }),
    ).resolves.toEqual({ mode: "execute", sourceRows: 1, existingRows: 0, copiedRows: 1 });
    expect(stopped).toBe(true);
    expect(await target.findById("stable-id")).toEqual(source.rows.get("stable-id"));
    expect(target.leaseCount).toBe(1);
  });
});
