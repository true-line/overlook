import type { FacetGroup, SmartPredicate } from '../../shared/library/smart-album.js';
import { UNAVAILABLE_WHERE, UNKNOWN_DIMENSIONS_WHERE } from './photo-clauses.js';

// The one compiler behind live facet filters and saved Smart Albums
// (ADR-0030 §3). Every clause is a cursor-friendly row predicate over the
// `p` alias (ordinary_visible_photos), so it composes with keyset paging
// and the count query without any renderer post-filtering (§6).

export interface CompiledPredicate {
  readonly where: string;
  readonly params: Readonly<Record<string, string | number | null>>;
}

type Params = Record<string, string | number | null>;

function list(values: readonly string[], prefix: string, params: Params, lower = false): string {
  return values
    .map((value, index) => {
      const name = `${prefix}v${String(index)}`;
      params[name] = lower ? value.toLowerCase() : value;
      return `@${name}`;
    })
    .join(', ');
}

function compileGroup(group: FacetGroup, prefix: string, params: Params): string {
  switch (group.facet) {
    case 'fileType':
      return `p.file_kind IN (${list(group.values, prefix, params)})`;
    case 'camera':
      return `p.camera IN (${list(group.values, prefix, params)})`;
    case 'lens':
      return `p.lens IN (${list(group.values, prefix, params)})`;
    case 'location':
      return `p.place IN (${list(group.values, prefix, params)})`;
    case 'tag': {
      // Effective tags = user tags ∪ (imported keywords − suppressed), matched
      // case-insensitively like photoTagKey. Suppression is per keyword: a
      // photo matching one tag is not excluded by having suppressed another.
      const values = list(group.values, prefix, params, true);
      return `(EXISTS (SELECT 1 FROM json_each(p.user_tags) WHERE lower(value) IN (${values}))
        OR EXISTS (SELECT 1 FROM json_each(p.imported_keywords) i WHERE lower(i.value) IN (${values})
                     AND lower(i.value) NOT IN (SELECT lower(value) FROM json_each(p.suppressed_keywords))))`;
    }
    case 'favorite': {
      const yes = group.values.includes('yes');
      const no = group.values.includes('no');
      return yes && no ? '1 = 1' : yes ? 'p.favorite = 1' : 'p.favorite = 0';
    }
    case 'custody':
      return `p.id IN (SELECT photo_id FROM sync_ledger WHERE status IN (${list(group.values, prefix, params)}))`;
    case 'availability': {
      const unavailable = group.values.includes('unavailable');
      const available = group.values.includes('available');
      return unavailable && available ? '1 = 1' : unavailable ? UNAVAILABLE_WHERE : `NOT ${UNAVAILABLE_WHERE}`;
    }
    case 'megapixels': {
      // A size facet asks about a known size: unknown dimensions match no
      // range rather than counting as zero megapixels (ADR-0030 §4).
      const ranges = group.ranges.map((range, index) => {
        const bounds: string[] = [];
        if (range.min !== null) {
          params[`${prefix}r${String(index)}min`] = Math.round(range.min * 1_000_000);
          bounds.push(`p.width * p.height >= @${prefix}r${String(index)}min`);
        }
        if (range.max !== null) {
          params[`${prefix}r${String(index)}max`] = Math.round(range.max * 1_000_000);
          bounds.push(`p.width * p.height <= @${prefix}r${String(index)}max`);
        }
        return `(${bounds.join(' AND ')})`;
      });
      return `(NOT ${UNKNOWN_DIMENSIONS_WHERE} AND (${ranges.join(' OR ')}))`;
    }
  }
}

export function compilePredicate(predicate: SmartPredicate, paramPrefix = ''): CompiledPredicate {
  const params: Params = {};
  const clauses = predicate.groups.map((group, index) => `(${compileGroup(group, `${paramPrefix}f${String(index)}`, params)})`);
  const where = clauses.length === 0 ? '1 = 1' : `(${clauses.join(predicate.composition === 'and' ? ' AND ' : ' OR ')})`;
  return { where, params };
}
