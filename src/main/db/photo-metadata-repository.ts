import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { markDirty } from '../backup/sync-ledger.js';
import {
  effectivePhotoTags,
  MAX_PHOTO_TAGS,
  normalizeImportedPhotoTags,
  normalizePhotoTags,
  photoMetadataUpdateSchema,
  photoTagKey,
  photoTagManagementSchema,
  type PhotoMetadataUpdate,
  type PhotoTagManagement,
} from '../../shared/library/photo-metadata.js';
import { queryAll, runNamed } from './sql.js';

interface MetadataRow {
  readonly id: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly importedKeywords: string;
  readonly userTags: string;
  readonly suppressedKeywords: string;
  readonly metadataVersion: number;
}

function parseTags(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return normalizePhotoTags(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
}

function keys(tags: readonly string[]): Set<string> {
  return new Set(tags.map((tag) => photoTagKey(tag)));
}

function without(tags: readonly string[], removed: ReadonlySet<string>): string[] {
  return tags.filter((tag) => !removed.has(photoTagKey(tag)));
}

function rowState(row: MetadataRow): {
  readonly title: string | null;
  readonly description: string | null;
  readonly imported: string[];
  readonly user: string[];
  readonly suppressed: string[];
} {
  return {
    title: row.title,
    description: row.description,
    imported: parseTags(row.importedKeywords),
    user: parseTags(row.userTags),
    suppressed: parseTags(row.suppressedKeywords),
  };
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => photoTagKey(value) === photoTagKey(right[index] ?? ''));
}

function fitImportedKeywords(keywords: readonly string[], userTags: readonly string[], suppressedKeywords: readonly string[]): string[] {
  const fitted: string[] = [];
  for (const keyword of normalizeImportedPhotoTags(keywords)) {
    if (effectivePhotoTags([...fitted, keyword], userTags, suppressedKeywords).length <= MAX_PHOTO_TAGS) fitted.push(keyword);
  }
  return fitted;
}

export interface PhotoMetadataMutationResult {
  readonly updated: number;
  readonly unchanged: number;
  readonly missing: number;
  readonly photoIds: readonly string[];
}

export interface PhotoMetadataSummary {
  readonly found: number;
  readonly missing: number;
  readonly title: { readonly mixed: boolean; readonly value: string | null };
  readonly description: { readonly mixed: boolean; readonly value: string | null };
  readonly commonTags: readonly string[];
  readonly varyingTags: readonly string[];
}

export class PhotoMetadataRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  update(input: PhotoMetadataUpdate): PhotoMetadataMutationResult {
    const request = photoMetadataUpdateSchema.parse(input);
    const requested = [...new Set(request.photoIds)];
    const rows = this.rows(requested);
    const changed: string[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        const current = rowState(row);
        const added = normalizePhotoTags(request.addTags ?? []);
        const removedKeys = keys(request.removeTags ?? []);
        const addedKeys = keys(added);
        const user = normalizePhotoTags([...without(current.user, removedKeys), ...added]);
        const importedKeys = keys(current.imported);
        const suppressed = normalizePhotoTags([
          ...without(current.suppressed, addedKeys),
          ...(request.removeTags ?? []).filter((tag) => importedKeys.has(photoTagKey(tag))),
        ]);
        const title = Object.hasOwn(request, 'title') ? (request.title ?? null) : current.title;
        const description = Object.hasOwn(request, 'description') ? (request.description ?? null) : current.description;
        if (
          title === current.title &&
          description === current.description &&
          sameTags(user, current.user) &&
          sameTags(suppressed, current.suppressed)
        ) {
          continue;
        }
        const effective = effectivePhotoTags(current.imported, user, suppressed);
        if (effective.length > MAX_PHOTO_TAGS) throw new Error(`a photo can have at most ${String(MAX_PHOTO_TAGS)} effective tags`);
        runNamed(
          this.db,
          `UPDATE photos
              SET user_title = @title,
                  user_description = @description,
                  user_tags = @userTags,
                  suppressed_keywords = @suppressed,
                  metadata_tags_search = @search,
                  metadata_version = metadata_version + 1
            WHERE id = @id`,
          {
            id: row.id,
            title,
            description,
            userTags: JSON.stringify(user),
            suppressed: JSON.stringify(suppressed),
            search: effective.join(' '),
          },
        );
        markDirty(this.db, row.id);
        changed.push(row.id);
      }
    })();
    return { updated: changed.length, unchanged: rows.length - changed.length, missing: requested.length - rows.length, photoIds: changed };
  }

  summary(photoIds: readonly string[]): PhotoMetadataSummary {
    const requested = [...new Set(photoIds)];
    const rows = this.rows(requested);
    const states = rows.map(rowState);
    const values = (pick: (state: ReturnType<typeof rowState>) => string | null): { mixed: boolean; value: string | null } => {
      const unique = new Set(states.map(pick));
      return { mixed: unique.size > 1, value: unique.size === 1 ? (unique.values().next().value ?? null) : null };
    };
    const effective = states.map((state) => effectivePhotoTags(state.imported, state.user, state.suppressed));
    const commonKeys = effective.length === 0 ? new Set<string>() : keys(effective[0] ?? []);
    for (const tags of effective.slice(1)) {
      const current = keys(tags);
      for (const key of commonKeys) if (!current.has(key)) commonKeys.delete(key);
    }
    const all = normalizePhotoTags(effective.flat());
    return {
      found: rows.length,
      missing: requested.length - rows.length,
      title: values((state) => state.title),
      description: values((state) => state.description),
      commonTags: all.filter((tag) => commonKeys.has(photoTagKey(tag))),
      varyingTags: all.filter((tag) => !commonKeys.has(photoTagKey(tag))),
    };
  }

  addImportedKeywords(photoId: string, keywords: readonly string[]): boolean {
    const row = this.row(photoId);
    if (row === undefined) return false;
    const current = rowState(row);
    const imported = fitImportedKeywords([...current.imported, ...keywords], current.user, current.suppressed);
    if (sameTags(imported, current.imported)) return false;
    const effective = effectivePhotoTags(imported, current.user, current.suppressed);
    this.db.transaction(() => {
      runNamed(
        this.db,
        `UPDATE photos
            SET imported_keywords = @imported,
                metadata_tags_search = @search,
                metadata_version = metadata_version + 1
          WHERE id = @id`,
        { id: photoId, imported: JSON.stringify(imported), search: effective.join(' ') },
      );
      markDirty(this.db, photoId);
    })();
    return true;
  }

  manage(input: PhotoTagManagement): PhotoMetadataMutationResult & { readonly merged: boolean } {
    const request = photoTagManagementSchema.parse(input);
    const rows = this.allRows();
    const sourceKey = photoTagKey(request.source);
    const targetKey = request.operation === 'rename' ? photoTagKey(request.target) : null;
    const matching = rows.filter((row) => effectivePhotoTags(...this.tagState(row)).some((tag) => photoTagKey(tag) === sourceKey));
    const merged =
      targetKey !== null && rows.some((row) => effectivePhotoTags(...this.tagState(row)).some((tag) => photoTagKey(tag) === targetKey));
    const aggregate = this.db.transaction(() =>
      matching.flatMap(
        (row) =>
          this.update({
            photoIds: [row.id],
            removeTags: [request.source],
            ...(request.operation === 'rename' ? { addTags: [request.target] } : {}),
          }).photoIds,
      ),
    )();
    return { updated: aggregate.length, unchanged: rows.length - aggregate.length, missing: 0, photoIds: aggregate, merged };
  }

  suggestions(query: string, limit: number): { readonly name: string; readonly count: number }[] {
    const needle = query.normalize('NFKC').trim().toLowerCase();
    const found = new Map<string, { name: string; count: number }>();
    for (const row of this.allRows()) {
      for (const tag of effectivePhotoTags(...this.tagState(row))) {
        const key = photoTagKey(tag);
        const current = found.get(key);
        found.set(key, { name: current?.name ?? tag, count: (current?.count ?? 0) + 1 });
      }
    }
    const matches = [...found.values()]
      .filter(({ name }) => name.toLowerCase().includes(needle))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    const limited = matches.slice(0, limit);
    const exact = matches.find(({ name }) => name.toLowerCase() === needle);
    if (exact === undefined || limited.some(({ name }) => name.toLowerCase() === needle)) return limited;
    return [exact, ...limited.filter(({ name }) => name.toLowerCase() !== needle)].slice(0, limit);
  }

  private tagState(row: MetadataRow): [string[], string[], string[]] {
    const state = rowState(row);
    return [state.imported, state.user, state.suppressed];
  }

  private row(photoId: string): MetadataRow | undefined {
    return this.rows([photoId])[0];
  }

  private rows(photoIds: readonly string[]): MetadataRow[] {
    const uniqueIds = [...new Set(photoIds)];
    if (uniqueIds.length === 0) return [];
    const found: MetadataRow[] = [];
    for (let start = 0; start < uniqueIds.length; start += 500) {
      const chunk = uniqueIds.slice(start, start + 500);
      const params = Object.fromEntries(chunk.map((id, index) => [`id${String(index)}`, id]));
      found.push(
        ...queryAll<MetadataRow>(
          this.db,
          `SELECT id, user_title AS title, user_description AS description,
                  imported_keywords AS importedKeywords, user_tags AS userTags,
                  suppressed_keywords AS suppressedKeywords, metadata_version AS metadataVersion
             FROM ordinary_visible_photos
            WHERE id IN (${chunk.map((_id, index) => `@id${String(index)}`).join(', ')})`,
          params,
        ),
      );
    }
    return found;
  }

  private allRows(): MetadataRow[] {
    return queryAll<MetadataRow>(
      this.db,
      `SELECT id, user_title AS title, user_description AS description,
              imported_keywords AS importedKeywords, user_tags AS userTags,
              suppressed_keywords AS suppressedKeywords, metadata_version AS metadataVersion
         FROM ordinary_visible_photos`,
    );
  }
}
