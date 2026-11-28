// Row-level clauses shared by the live query builder (photo-query.ts) and
// the predicate compiler (predicate-compiler.ts). They live apart from both
// so a derived source and a Smart Album facet compile to the same SQL text
// (ADR-0030 §3/§4: one clause, several accelerators over it).

/** The RAW source and the RAW filter chip compile to this one clause
 * (ADR-0030 §4: the chip is an accelerator over the same predicate). */
export const RAW_WHERE = `p.file_kind = 'raw'`;

/** Unavailable is derived from the row's typed renderability reasons: a
 * recorded preview failure, confirmed missing previews, unknown decoded dimensions, or confirmed missing originals.
 * Clearing these conditions moves the row out of the source with no restart. */
export const UNAVAILABLE_WHERE = `(p.preview_failure IS NOT NULL OR p.preview_missing = 1 OR p.dimension_status = 'unavailable' OR p.original_failure IS NOT NULL OR p.local_custody_failure IS NOT NULL)`;

/** Rows whose dimensions are not known. They are never treated as zero
 * megapixels (ADR-0030 §4) and pass every size threshold. */
export const UNKNOWN_DIMENSIONS_WHERE = `(p.dimension_status = 'unavailable' OR p.width <= 0 OR p.height <= 0)`;
