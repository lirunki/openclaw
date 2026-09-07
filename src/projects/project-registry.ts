import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { insideGitCheckout, runGit } from "../agents/worktrees/git.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createProjectRegistryStore,
  type ProjectRegistryStoreOptions,
} from "../storage/project-registry-store-factory.js";
import type {
  ProjectRegistryLease,
  StoredProjectRegistryRecord,
} from "../storage/project-registry-store.js";

export type ProjectRegistryRecord = {
  id: string;
  displayName: string;
  repoRoot: string;
  originUrl?: string;
  source: "workspace" | "registered" | "cloned";
  agentId?: string;
};

export class ProjectCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectCheckoutError";
  }
}

function projectFromStoredRecord(row: StoredProjectRegistryRecord): ProjectRegistryRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    repoRoot: row.repoRoot,
    ...(row.originUrl ? { originUrl: row.originUrl } : {}),
    source: row.source,
  };
}

async function insertProjectRegistry(
  input: {
    displayName: string;
    repoRoot: string;
    originUrl?: string;
    source: "registered" | "cloned";
  },
  options: ProjectRegistryStoreOptions,
  lease: ProjectRegistryLease,
): Promise<ProjectRegistryRecord> {
  const store = createProjectRegistryStore(options);
  const record = await store.insertOrGet(input, lease);
  return projectFromStoredRecord(record);
}

export async function withProjectCheckoutLifecycle<T>(
  repoRoot: string,
  options: ProjectRegistryStoreOptions,
  run: (lease: ProjectRegistryLease) => Promise<T>,
): Promise<T> {
  return await createProjectRegistryStore(options).withCheckoutLease(repoRoot, run);
}

function workspaceProject(cfg: OpenClawConfig, agentId: string): ProjectRegistryRecord {
  const repoRoot = resolveAgentWorkspaceDir(cfg, agentId);
  return {
    id: `workspace:${agentId}`,
    displayName: path.basename(repoRoot) || agentId,
    repoRoot,
    source: "workspace",
    agentId,
  };
}

function projectRegistryOptionsForConfig(
  cfg: OpenClawConfig,
  options: ProjectRegistryStoreOptions,
): ProjectRegistryStoreOptions {
  return cfg.storage ? { ...options, storage: cfg.storage } : options;
}

function compareProjects(left: ProjectRegistryRecord, right: ProjectRegistryRecord): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName !== rightName) {
    return leftName < rightName ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export async function resolveProjectDirectory(projectPath: string): Promise<string> {
  const requested = await fs.realpath(projectPath).catch(() => {
    throw new ProjectCheckoutError(`project path does not exist: ${projectPath}`);
  });
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ProjectCheckoutError(`project path is not a directory: ${projectPath}`);
  }
  return requested;
}

export async function resolveProjectCheckout(projectPath: string): Promise<{
  path: string;
  repoRoot: string;
  originUrl?: string;
}> {
  const requested = await resolveProjectDirectory(projectPath);
  if (!insideGitCheckout(requested)) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    throw new ProjectCheckoutError(`project path is not a git checkout: ${projectPath}`);
  }
  const repoRoot = await fs.realpath(rootResult.stdout.trim()).catch(() => {
    throw new ProjectCheckoutError(`project checkout root is unavailable: ${projectPath}`);
  });
  const headResult = await runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.code !== 0) {
    throw new ProjectCheckoutError(`project checkout has no commits: ${projectPath}`);
  }
  const originResult = await runGit(repoRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = originResult.code === 0 ? originResult.stdout.trim() : "";
  return { path: requested, repoRoot, ...(originUrl ? { originUrl } : {}) };
}

async function registerResolvedProject(
  input: {
    path: string;
    name?: string;
    originUrl?: string;
    source: "registered" | "cloned";
  },
  options: ProjectRegistryStoreOptions = {},
): Promise<ProjectRegistryRecord> {
  const checkout = await resolveProjectCheckout(input.path);
  const displayName = input.name?.trim() || path.basename(checkout.repoRoot) || "Project";
  return await withProjectCheckoutLifecycle(checkout.repoRoot, options, async (lease) => {
    // A deletion may have won the lease after the first canonicalization. Revalidate under the
    // lifecycle owner so a stale registration cannot recreate a row for the removed checkout.
    const current = await resolveProjectCheckout(checkout.repoRoot);
    if (current.repoRoot !== checkout.repoRoot) {
      throw new ProjectCheckoutError(`project checkout changed while registering: ${input.path}`);
    }
    return insertProjectRegistry(
      {
        displayName,
        repoRoot: checkout.repoRoot,
        originUrl: input.originUrl ?? checkout.originUrl,
        source: input.source,
      },
      options,
      lease,
    );
  });
}

export async function registerProjectRegistry(
  input: { path: string; name?: string },
  options: ProjectRegistryStoreOptions = {},
): Promise<ProjectRegistryRecord> {
  return await registerResolvedProject({ ...input, source: "registered" }, options);
}

export async function registerClonedProjectRegistry(
  input: { path: string; name: string; originUrl: string },
  options: ProjectRegistryStoreOptions = {},
): Promise<ProjectRegistryRecord> {
  return await registerResolvedProject({ ...input, source: "cloned" }, options);
}

export async function listProjectRegistry(
  cfg: OpenClawConfig,
  options: ProjectRegistryStoreOptions = {},
): Promise<ProjectRegistryRecord[]> {
  const store = createProjectRegistryStore(projectRegistryOptionsForConfig(cfg, options));
  const stored = (await store.list()).map(projectFromStoredRecord);
  const workspaces = listAgentIds(cfg).map((agentId) => workspaceProject(cfg, agentId));
  return [...workspaces, ...stored].toSorted(compareProjects);
}

export async function resolveProjectRegistry(
  cfg: OpenClawConfig,
  id: string,
  options: ProjectRegistryStoreOptions = {},
): Promise<ProjectRegistryRecord | undefined> {
  if (id.startsWith("workspace:")) {
    const agentId = id.slice("workspace:".length);
    return listAgentIds(cfg).includes(agentId) ? workspaceProject(cfg, agentId) : undefined;
  }
  const project = await createProjectRegistryStore(
    projectRegistryOptionsForConfig(cfg, options),
  ).findById(id);
  return project ? projectFromStoredRecord(project) : undefined;
}

export async function removeProjectCheckoutReference(
  project: ProjectRegistryRecord,
  lease: ProjectRegistryLease,
  options: ProjectRegistryStoreOptions = {},
): Promise<"missing" | "changed" | "remaining" | "final"> {
  if (project.source !== "cloned") {
    return "changed";
  }
  const store = createProjectRegistryStore(options);
  return await store.removeCheckoutReference(
    {
      id: project.id,
      displayName: project.displayName,
      repoRoot: project.repoRoot,
      ...(project.originUrl ? { originUrl: project.originUrl } : {}),
      source: "cloned",
    },
    lease,
  );
}

export async function resolveRecordedProjectRoot(
  projectPath: string,
  options: ProjectRegistryStoreOptions = {},
): Promise<string | undefined> {
  const repoRoot = await fs.realpath(projectPath).catch(() => undefined);
  if (!repoRoot) {
    return undefined;
  }
  return (await createProjectRegistryStore(options).findByRepoRoot(repoRoot))?.repoRoot;
}

export async function removeProjectRegistry(
  id: string,
  options: ProjectRegistryStoreOptions = {},
): Promise<boolean> {
  return await createProjectRegistryStore(options).remove(id);
}
