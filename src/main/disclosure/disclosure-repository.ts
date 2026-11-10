import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import {
  DEFAULT_DISCLOSURE_POLICY,
  disclosureFieldClassesSchema,
  disclosurePolicySchema,
  type DisclosureClass,
  type DisclosureField,
  type DisclosureOverride,
  type DisclosureOverrideScope,
  type DisclosurePolicy,
} from '../../shared/disclosure/policy.js';
import { queryAll, queryGet, runNamed } from '../db/sql.js';

interface PolicyRow {
  readonly version: number;
  readonly fields: string;
}

interface OverrideRow {
  readonly scope_id: string;
  readonly field: string;
  readonly class: string;
  readonly widened: number;
}

/** The library's disclosure policy and scope overrides (#509, ADR-0032 §6).
 * Everything is re-parsed on the way in — a hostile IPC payload never
 * reaches SQL — and on the way out, so a row this build does not understand
 * falls back to the §6 defaults instead of widening anything. */
export class DisclosureRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  policy(): DisclosurePolicy {
    const row = queryGet<PolicyRow>(this.db, 'SELECT version, fields FROM disclosure_policy WHERE id = 1');
    if (row === undefined) return DEFAULT_DISCLOSURE_POLICY;
    try {
      const fields = disclosureFieldClassesSchema.parse(JSON.parse(row.fields));
      return disclosurePolicySchema.parse({ version: row.version, fields });
    } catch {
      return DEFAULT_DISCLOSURE_POLICY;
    }
  }

  writePolicy(policy: DisclosurePolicy, now: () => Date = () => new Date()): DisclosurePolicy {
    const parsed = disclosurePolicySchema.parse(policy);
    runNamed(
      this.db,
      `INSERT INTO disclosure_policy (id, version, fields, updated_at)
         VALUES (1, @version, @fields, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, fields = excluded.fields, updated_at = excluded.updated_at`,
      { version: parsed.version, fields: JSON.stringify(parsed.fields), updatedAt: now().toISOString() },
    );
    return parsed;
  }

  overrides(scope: DisclosureOverrideScope, scopeId: string): readonly DisclosureOverride[] {
    return this.overridesFor(scope, [scopeId]).get(scopeId) ?? [];
  }

  /** Overrides for many scope ids in one query, keyed by id. */
  overridesFor(scope: DisclosureOverrideScope, scopeIds: readonly string[]): ReadonlyMap<string, readonly DisclosureOverride[]> {
    const result = new Map<string, DisclosureOverride[]>();
    const uniqueIds = [...new Set(scopeIds)];
    if (uniqueIds.length === 0) return result;
    for (let start = 0; start < uniqueIds.length; start += 500) {
      const chunk = uniqueIds.slice(start, start + 500);
      const params: Record<string, unknown> = { scope };
      chunk.forEach((scopeId, index) => {
        params[`id${String(index)}`] = scopeId;
      });
      const rows = queryAll<OverrideRow>(
        this.db,
        `SELECT scope_id, field, class, widened FROM disclosure_overrides
          WHERE scope = @scope AND scope_id IN (${chunk.map((_, index) => `@id${String(index)}`).join(', ')})
          ORDER BY scope_id, field`,
        params,
      );
      for (const row of rows) {
        const list = result.get(row.scope_id) ?? [];
        list.push({ field: row.field as DisclosureField, class: row.class as DisclosureClass, widened: row.widened === 1 });
        result.set(row.scope_id, list);
      }
    }
    return result;
  }

  setOverride(
    scope: DisclosureOverrideScope,
    scopeId: string,
    field: DisclosureField,
    cls: DisclosureClass,
    widened: boolean,
    now: () => Date = () => new Date(),
  ): void {
    runNamed(
      this.db,
      `INSERT INTO disclosure_overrides (scope, scope_id, field, class, widened, updated_at)
         VALUES (@scope, @scopeId, @field, @class, @widened, @updatedAt)
         ON CONFLICT (scope, scope_id, field) DO UPDATE SET
           class = excluded.class, widened = excluded.widened, updated_at = excluded.updated_at`,
      { scope, scopeId, field, class: cls, widened: widened ? 1 : 0, updatedAt: now().toISOString() },
    );
  }

  clearOverride(scope: DisclosureOverrideScope, scopeId: string, field: DisclosureField): void {
    runNamed(this.db, 'DELETE FROM disclosure_overrides WHERE scope = @scope AND scope_id = @scopeId AND field = @field', {
      scope,
      scopeId,
      field,
    });
  }

  /** The collections a photo belongs to — the middle of the §6 chain. */
  collectionsOf(photoId: string): readonly string[] {
    return queryAll<{ albumId: string }>(
      this.db,
      'SELECT album_id AS albumId FROM album_photos WHERE photo_id = @photoId ORDER BY album_id',
      {
        photoId,
      },
    ).map((row) => row.albumId);
  }
}
