import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlassDatabase } from "./database.js";

export interface ArtifactRecord {
  id: string;
  uri: string;
  path: string;
  byteCount: number;
  kind: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  kind: string;
  file_path: string;
  byte_count: number;
  metadata_json: string;
  created_at: number;
}

export class ArtifactStore {
  constructor(
    private readonly db: GlassDatabase,
    private readonly directory: string,
  ) {}

  save(sessionId: string | null, kind: string, content: string | Buffer, metadata: Record<string, unknown> = {}): ArtifactRecord {
    const id = randomUUID();
    const path = join(this.directory, id);
    const data = typeof content === "string" ? Buffer.from(content) : content;
    writeFileSync(path, data, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO artifacts(id, session_id, kind, file_path, byte_count, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, kind, path, data.byteLength, JSON.stringify(metadata), createdAt);
    return { id, uri: `artifact://${id}`, path, byteCount: data.byteLength, kind, metadata, createdAt };
  }

  get(idOrUri: string): ArtifactRecord | null {
    const id = idOrUri.startsWith("artifact://") ? idOrUri.slice("artifact://".length) : idOrUri;
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      uri: `artifact://${row.id}`,
      path: row.file_path,
      byteCount: row.byte_count,
      kind: row.kind,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  read(idOrUri: string, offset = 0, limit = 64 * 1024): Buffer {
    const artifact = this.get(idOrUri);
    if (!artifact) throw new Error(`Artifact not found: ${idOrUri}`);
    const data = readFileSync(artifact.path);
    return data.subarray(offset, Math.min(data.length, offset + limit));
  }
}
