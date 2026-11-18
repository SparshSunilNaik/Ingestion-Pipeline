// Typed client for the Ingestion-Pipeline backend API.

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error", `Cannot reach the backend at ${API_BASE}. Is it running?`);
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
      } else if (body?.detail) {
        message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: number;
  kind: "ingest" | "agent_report";
  repository_id: number | null;
  snapshot_id: number | null;
  requested_url: string;
  status: JobStatus;
  stage: string;
  progress: number;
  message: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  reused_cache: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  params: Record<string, unknown>;
}

export interface SnapshotBrief {
  id: number;
  commit_sha: string;
  status: string;
  default_branch: string | null;
  acquired_at: string;
  analyzer_version: string;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  canonical_url: string;
  default_branch: string | null;
  current_snapshot_id: number | null;
  created_at: string;
  updated_at: string;
  snapshots: SnapshotBrief[];
  current: SnapshotBrief | null;
  latest_job: Job | null;
}

export interface Coverage {
  tracked_files: number;
  inventoried_files: number;
  tracked_files_beyond_limit: number;
  eligible_text_files: number;
  analyzed_files: number;
  analyzed_bytes: number;
  budget_skipped_files: number;
  is_partial: boolean;
  exclusions: Record<string, number>;
  limits: Record<string, number>;
}

export interface Snapshot {
  id: number;
  repository_id: number;
  commit_sha: string;
  default_branch: string | null;
  status: string;
  analyzer_version: string;
  acquired_at: string;
  commit_info: { sha?: string; author?: string; date?: string; subject?: string };
  recent_commits: { sha: string; author: string; date: string; subject: string }[];
  coverage: Coverage;
  inventory_summary: {
    languages_by_files: Record<string, number>;
    languages_by_bytes: Record<string, number>;
    categories: Record<string, number>;
    top_level_directories: Record<string, number>;
    documentation_files: string[];
    dependency_manifests: string[];
    configuration_files: string[];
    test_files_count: number;
    ci_files: string[];
    container_files: string[];
    source_directories: string[];
    total_bytes: number;
  };
  analysis_summary: {
    stats?: Record<string, number>;
    evidence_records?: number;
    evidence_rejected?: number;
    graph?: { nodes: number; edges: number; edge_kinds: Record<string, number>; edge_resolution: Record<string, number> };
    central_files?: { key: string; path: string; imported_by: number }[];
    most_referenced_symbols?: { key: string; label: string; kind: string; path: string; references: number }[];
  };
  repository: Omit<Repository, "snapshots" | "current" | "latest_job">;
}

export interface FileRecord {
  path: string;
  size: number;
  extension: string;
  language: string | null;
  category: string;
  is_text: boolean;
  analyzed: boolean;
  exclusion_reason: string | null;
  line_count: number | null;
}

export interface Page<T> {
  total: number;
  items: T[];
}

export interface Source {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  language: string | null;
  lines: string[];
}

export interface GraphNode {
  key: string;
  kind: string;
  label: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  attrs: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  resolution: string;
  evidence_id: string | null;
  count: number;
}

export interface Graph {
  view: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  totals: Record<string, number>;
}

export interface Impact {
  key: string;
  dependents: { key: string; kind: string | null; label: string | null; depth: number; via: string }[];
  truncated: boolean;
  note: string;
}

export interface Finding {
  id: number;
  kind: string;
  name: string;
  detail: Record<string, unknown>;
  evidence_id: string | null;
  confidence: string;
}

export interface Dependency {
  ecosystem: string;
  name: string;
  specifier: string | null;
  scope: string;
  manifest_path: string | null;
  status: string;
  evidence_id: string | null;
  import_count: number;
}

export interface EvidenceDetail {
  id: string;
  repository_id: number;
  snapshot_id: number;
  commit_sha: string;
  path: string;
  start_line: number;
  end_line: number;
  category: string;
  subject: string | null;
  extraction_method: string;
  analyzer_version: string;
  contract_version: string;
  verification_status: string;
  source_kind: string;
  limitations: string[];
  verified_now: boolean;
  verification_reason: string | null;
  excerpt: string | null;
}

export type Basis =
  | "source_evidence"
  | "configuration_evidence"
  | "documentation_claim"
  | "inventory_measured"
  | "heuristic"
  | "unknown"
  | "unsupported";

export interface Claim {
  statement: string;
  basis: Basis;
  evidence_ids: string[];
  note: string | null;
}

export interface Section {
  title: string;
  claims: Claim[];
}

export interface EvidenceRef {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  category: string;
  source_kind: string;
  verification_status: string;
  reason: string | null;
}

export interface ReportContent {
  schema_version: string;
  kind: "deterministic" | "agent";
  repository: string;
  canonical_url: string;
  commit_sha: string;
  default_branch: string | null;
  generated_at: string;
  model: string | null;
  overview: Section[];
  installation: Section[];
  architecture: Section[];
  code_structure: Section[];
  engineering: Section[];
  agent_narrative: Section[];
  coverage: Coverage;
  evidence: EvidenceRef[];
  evidence_summary: Record<string, number>;
}

export interface ReportBrief {
  id: number;
  snapshot_id: number;
  kind: "deterministic" | "agent";
  status: string;
  model: string | null;
  created_at: string;
  error: string | null;
}

export interface Report extends ReportBrief {
  content: ReportContent;
  usage: Record<string, unknown>;
}

export interface AgentStatus {
  mode: string;
  available: boolean;
  version: string | null;
  base_url: string | null;
  error: string | null;
  selected_model: string;
  selected_model_available: boolean | null;
  agent_ready: boolean;
}

export interface AgentModel {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  family: string | null;
  status: string | null;
  enabled: boolean;
  context_limit: number | null;
  output_limit: number | null;
  variants: string[];
}

const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health"),
  validateUrl: (url: string) =>
    request<{ valid: boolean; canonical_url: string | null; error: string | null }>("/api/repositories/validate", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  createJob: (url: string) => request<{ job: Job; created: boolean }>("/api/jobs", { method: "POST", body: JSON.stringify({ url }) }),
  jobs: (limit = 20) => request<Job[]>(`/api/jobs${q({ limit })}`),
  job: (id: number) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: number) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  repositories: () => request<Repository[]>("/api/repositories"),
  snapshot: (id: number) => request<Snapshot>(`/api/snapshots/${id}`),
  files: (id: number, p: { category?: string; analyzed?: boolean; q?: string; offset?: number; limit?: number }) =>
    request<Page<FileRecord>>(`/api/snapshots/${id}/files${q(p)}`),
  source: (id: number, path: string, start?: number, end?: number) =>
    request<Source>(`/api/snapshots/${id}/source${q({ path, start, end })}`),
  graph: (id: number, p: { view: "files" | "symbols"; path_prefix?: string; include_unresolved?: boolean; limit?: number }) =>
    request<Graph>(`/api/snapshots/${id}/graph${q(p)}`),
  impact: (id: number, key: string, depth = 3) => request<Impact>(`/api/snapshots/${id}/impact${q({ key, depth })}`),
  findings: (id: number, kind?: string) => request<Finding[]>(`/api/snapshots/${id}/findings${q({ kind })}`),
  dependencies: (id: number) => request<Dependency[]>(`/api/snapshots/${id}/dependencies`),
  search: (id: number, query: string) => request<{ path: string; snippet: string; score: number }[]>(`/api/snapshots/${id}/search${q({ q: query })}`),
  evidence: (id: string) => request<EvidenceDetail>(`/api/evidence/${encodeURIComponent(id)}`),
  reports: (snapshotId: number) => request<ReportBrief[]>(`/api/snapshots/${snapshotId}/reports`),
  report: (id: number) => request<Report>(`/api/reports/${id}`),
  reportMarkdownUrl: (id: number) => `${API_BASE}/api/reports/${id}/markdown`,
  requestAgentReport: (snapshotId: number) =>
    request<{ job: Job; created: boolean }>(`/api/snapshots/${snapshotId}/agent-report`, { method: "POST" }),
  agentStatus: () => request<AgentStatus>("/api/agent/status"),
  agentModels: () => request<AgentModel[]>("/api/agent/models"),
  selectModel: (model: string) => request<AgentStatus>("/api/agent/model", { method: "PUT", body: JSON.stringify({ model }) }),
};
