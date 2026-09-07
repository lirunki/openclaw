type StoredProjectRegistrySource = "registered" | "cloned";

export type StoredProjectRegistryRecord = {
  id: string;
  displayName: string;
  repoRoot: string;
  originUrl?: string;
  source: StoredProjectRegistrySource;
};

export type ProjectRegistryInsert = {
  id?: string;
  displayName: string;
  repoRoot: string;
  originUrl?: string;
  source: StoredProjectRegistrySource;
};

export type ProjectCheckoutReferenceRemoval = "missing" | "changed" | "remaining" | "final";

/**
 * A lifecycle lease supplied by the owning service.
 *
 * The selected backend calls `assertOwnedInTransaction` with its active transaction before
 * mutating project rows. `Transaction` defaults to `unknown` so the `ProjectRegistryStore`
 * contract stays opaque to callers, while each backend instantiates the lease with its own
 * connection/transaction representation so it can assert ownership without casting.
 */
export type ProjectRegistryLease<Transaction = unknown> = {
  assertOwned(): void;
  assertOwnedInTransaction(transaction: Transaction): void | Promise<void>;
};

export interface ProjectRegistryStore {
  withCheckoutLease<T>(
    repoRoot: string,
    run: (lease: ProjectRegistryLease) => Promise<T>,
  ): Promise<T>;
  list(): Promise<StoredProjectRegistryRecord[]>;
  findById(id: string): Promise<StoredProjectRegistryRecord | undefined>;
  findByRepoRoot(repoRoot: string): Promise<StoredProjectRegistryRecord | undefined>;
  findByOriginUrl(originUrl: string): Promise<StoredProjectRegistryRecord | undefined>;
  insertOrGet(
    input: ProjectRegistryInsert,
    lease: ProjectRegistryLease,
  ): Promise<StoredProjectRegistryRecord>;
  removeCheckoutReference(
    project: StoredProjectRegistryRecord,
    lease: ProjectRegistryLease,
  ): Promise<ProjectCheckoutReferenceRemoval>;
  remove(id: string): Promise<boolean>;
}
