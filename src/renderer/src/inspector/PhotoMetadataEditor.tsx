import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { photoTagSchema, type PhotoMetadataUpdate } from '../../../shared/library/photo-metadata.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { Button } from '../components/Button';

const messages = defineMessages({
  heading: { id: 'inspector.metadata.heading', defaultMessage: 'Descriptive metadata' },
  title: { id: 'inspector.metadata.title', defaultMessage: 'Title' },
  description: { id: 'inspector.metadata.description', defaultMessage: 'Description' },
  mixed: { id: 'inspector.metadata.mixed', defaultMessage: 'Mixed values — unchanged until edited' },
  tags: { id: 'inspector.metadata.tags', defaultMessage: 'Tags and keywords' },
  common: { id: 'inspector.metadata.common', defaultMessage: 'On every selected photo' },
  varying: { id: 'inspector.metadata.varying', defaultMessage: 'On some selected photos' },
  imported: { id: 'inspector.metadata.imported', defaultMessage: 'Imported keyword' },
  addTag: { id: 'inspector.metadata.addTag', defaultMessage: 'Add tag' },
  tagPlaceholder: { id: 'inspector.metadata.tagPlaceholder', defaultMessage: 'Type a tag and press Enter' },
  removeTag: { id: 'inspector.metadata.removeTag', defaultMessage: 'Remove {tag}' },
  // An imported keyword's chip reads "Lisbon · Imported keyword ×", so its
  // remove label has to carry the same words (WCAG 2.5.3).
  removeImportedTag: { id: 'inspector.metadata.removeImportedTag', defaultMessage: 'Remove {tag}, {imported}' },
  tagChip: { id: 'inspector.metadata.tagChip', defaultMessage: '{tag} ×' },
  importedTagChip: { id: 'inspector.metadata.importedTagChip', defaultMessage: '{tag} · {imported} ×' },
  saveOne: { id: 'inspector.metadata.saveOne', defaultMessage: 'Save metadata' },
  saveMany: { id: 'inspector.metadata.saveMany', defaultMessage: 'Apply to {count} photos' },
  saving: { id: 'inspector.metadata.saving', defaultMessage: 'Saving…' },
  result: {
    id: 'inspector.metadata.result',
    defaultMessage: 'Updated {updated}; {unchanged} unchanged; {missing} unavailable.',
  },
  failed: { id: 'inspector.metadata.failed', defaultMessage: 'Metadata could not be updated.' },
  invalidTag: { id: 'inspector.metadata.invalidTag', defaultMessage: 'Enter a tag up to 64 characters without commas or semicolons.' },
  tooMany: { id: 'inspector.metadata.tooMany', defaultMessage: 'Edit at most 10,000 selected photos at a time.' },
  manage: { id: 'inspector.metadata.manage', defaultMessage: 'Manage a tag across this library' },
  sourceTag: { id: 'inspector.metadata.sourceTag', defaultMessage: 'Existing tag' },
  targetTag: { id: 'inspector.metadata.targetTag', defaultMessage: 'New tag' },
  rename: { id: 'inspector.metadata.rename', defaultMessage: 'Rename or merge on {count} photos' },
  removeEverywhere: { id: 'inspector.metadata.removeEverywhere', defaultMessage: 'Remove from {count} photos' },
  manageResult: {
    id: 'inspector.metadata.manageResult',
    defaultMessage: 'Updated {count} photos{merged, select, yes { and merged tags} other {}}.',
  },
});

type Summary = Awaited<ReturnType<typeof window.overlook.library.metadataSummary>>;
type Suggestions = Awaited<ReturnType<typeof window.overlook.library.tagSuggestions>>['tags'];

export interface PhotoMetadataEditorProps {
  readonly photo: PhotoRecord;
  readonly photoIds: readonly string[];
}

export function PhotoMetadataEditor({ photo, photoIds }: PhotoMetadataEditorProps): ReactElement {
  const intl = useIntl();
  const scope = useMemo(() => [...new Set(photoIds.length === 0 ? [photo.id] : photoIds)], [photo.id, photoIds]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [addTags, setAddTags] = useState<readonly string[]>([]);
  const [removeTags, setRemoveTags] = useState<readonly string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestions>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [manageSource, setManageSource] = useState('');
  const [manageTarget, setManageTarget] = useState('');
  const summaryRequestRef = useRef(0);
  const suggestionsRequestRef = useRef(0);
  const titleTouchedRef = useRef(false);
  const descriptionTouchedRef = useRef(false);

  useEffect(() => {
    titleTouchedRef.current = titleTouched;
    descriptionTouchedRef.current = descriptionTouched;
  }, [descriptionTouched, titleTouched]);

  const loadSummary = useCallback(
    (preserveTouched = false): void => {
      const requestId = (summaryRequestRef.current += 1);
      if (scope.length > 10_000) return;
      void window.overlook.library
        .metadataSummary({ photoIds: scope })
        .then((next) => {
          if (summaryRequestRef.current !== requestId) return;
          setSummary(next);
          if (!preserveTouched || !titleTouchedRef.current) {
            setTitle(next.title.value ?? '');
            setTitleTouched(false);
          }
          if (!preserveTouched || !descriptionTouchedRef.current) {
            setDescription(next.description.value ?? '');
            setDescriptionTouched(false);
          }
          if (!preserveTouched) {
            setAddTags([]);
            setRemoveTags([]);
          }
        })
        .catch(() => {
          if (summaryRequestRef.current === requestId) setStatus(intl.formatMessage(messages.failed));
        });
    },
    [intl, scope],
  );

  useEffect(() => {
    loadSummary();
    return () => {
      summaryRequestRef.current += 1;
    };
  }, [loadSummary]);
  useEffect(() => {
    if (typeof window.overlook.library.onChanged !== 'function') return;
    const scopeSet = new Set(scope);
    return window.overlook.library.onChanged(({ photoIds: changedIds, derivativeOnly }) => {
      if (derivativeOnly === true) return;
      if (changedIds.length === 0 || changedIds.some((id) => scopeSet.has(id))) {
        loadSummary(true);
      }
    });
  }, [loadSummary, scope]);
  useEffect(() => {
    const requestId = (suggestionsRequestRef.current += 1);
    const query = manageSource.trim() === '' ? tagDraft : manageSource;
    void window.overlook.library
      .tagSuggestions({ query, limit: 20 })
      .then(({ tags }) => {
        if (suggestionsRequestRef.current === requestId) setSuggestions(tags);
      })
      .catch(() => {
        if (suggestionsRequestRef.current === requestId) setSuggestions([]);
      });
    return () => {
      suggestionsRequestRef.current += 1;
    };
  }, [manageSource, status, tagDraft]);

  const queueTag = (): void => {
    const parsed = photoTagSchema.safeParse(tagDraft);
    if (!parsed.success) {
      setStatus(intl.formatMessage(messages.invalidTag));
      return;
    }
    setAddTags((current) => [...new Set([...current, parsed.data])]);
    setRemoveTags((current) => current.filter((tag) => tag.toLowerCase() !== parsed.data.toLowerCase()));
    setTagDraft('');
    setStatus(null);
  };

  const remove = (tag: string): void => {
    setRemoveTags((current) => [...new Set([...current, tag])]);
    setAddTags((current) => current.filter((candidate) => candidate.toLowerCase() !== tag.toLowerCase()));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving || summary === null || scope.length > 10_000) return;
    const request: PhotoMetadataUpdate = {
      photoIds: scope,
      ...(titleTouched ? { title } : {}),
      ...(descriptionTouched ? { description } : {}),
      ...(addTags.length > 0 ? { addTags: [...addTags] } : {}),
      ...(removeTags.length > 0 ? { removeTags: [...removeTags] } : {}),
    };
    setSaving(true);
    setStatus(null);
    void window.overlook.library
      .updateMetadata(request)
      .then((result) => {
        setStatus(
          intl.formatMessage(messages.result, {
            updated: result.updated,
            unchanged: result.unchanged,
            missing: result.missing,
          }),
        );
        loadSummary();
      })
      .catch(() => setStatus(intl.formatMessage(messages.failed)))
      .finally(() => setSaving(false));
  };

  const manage = (operation: 'rename' | 'remove'): void => {
    const source = photoTagSchema.safeParse(manageSource);
    const target = photoTagSchema.safeParse(manageTarget);
    if (!source.success || (operation === 'rename' && !target.success)) {
      setStatus(intl.formatMessage(messages.invalidTag));
      return;
    }
    setSaving(true);
    const request =
      operation === 'remove'
        ? ({ operation, source: source.data } as const)
        : ({ operation, source: source.data, target: target.success ? target.data : manageTarget } as const);
    void window.overlook.library
      .manageTag(request)
      .then((result) => {
        setStatus(intl.formatMessage(messages.manageResult, { count: result.updated, merged: result.merged ? 'yes' : 'no' }));
        setManageSource('');
        setManageTarget('');
        loadSummary();
      })
      .catch(() => setStatus(intl.formatMessage(messages.failed)))
      .finally(() => setSaving(false));
  };

  const sourceCount = suggestions.find(({ name }) => name.toLowerCase() === manageSource.trim().toLowerCase())?.count ?? 0;
  const imported = new Set(photo.importedKeywords.map((tag) => tag.toLowerCase()));
  const commonTags =
    summary?.commonTags.filter(
      (tag) =>
        !removeTags.some((removed) => removed.toLowerCase() === tag.toLowerCase()) &&
        !addTags.some((added) => added.toLowerCase() === tag.toLowerCase()),
    ) ?? [];
  const varyingTags =
    summary?.varyingTags.filter((tag) => !removeTags.some((removed) => removed.toLowerCase() === tag.toLowerCase())) ?? [];

  return (
    <section className="ovl-inspector__metadataEditor" aria-labelledby="inspector-metadata-heading">
      <h3 id="inspector-metadata-heading" className="ovl-inspector__sectionTitle">
        {intl.formatMessage(messages.heading)}
      </h3>
      {scope.length > 10_000 ? (
        <div className="ovl-inspector__metadataStatus" role="alert">
          {intl.formatMessage(messages.tooMany)}
        </div>
      ) : (
        <form onSubmit={submit}>
          <label className="ovl-inspector__metadataLabel" htmlFor="photo-metadata-title">
            {intl.formatMessage(messages.title)}
          </label>
          <input
            id="photo-metadata-title"
            className="ovl-inspector__metadataInput"
            value={title}
            maxLength={200}
            placeholder={summary?.title.mixed === true && !titleTouched ? intl.formatMessage(messages.mixed) : undefined}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              setTitleTouched(true);
            }}
          />
          <label className="ovl-inspector__metadataLabel" htmlFor="photo-metadata-description">
            {intl.formatMessage(messages.description)}
          </label>
          <textarea
            id="photo-metadata-description"
            className="ovl-inspector__metadataInput ovl-inspector__metadataTextarea"
            value={description}
            maxLength={4_000}
            placeholder={summary?.description.mixed === true && !descriptionTouched ? intl.formatMessage(messages.mixed) : undefined}
            onChange={(event) => {
              setDescription(event.currentTarget.value);
              setDescriptionTouched(true);
            }}
          />
          <div className="ovl-inspector__metadataLabel">{intl.formatMessage(messages.tags)}</div>
          {commonTags.length === 0 ? null : <div className="ovl-inspector__tagGroupLabel">{intl.formatMessage(messages.common)}</div>}
          <div className="ovl-inspector__tags">
            {commonTags.map((tag) => {
              const isImported = imported.has(tag.toLowerCase());
              return (
                <button
                  key={tag}
                  type="button"
                  className="ovl-inspector__tag"
                  aria-label={
                    isImported
                      ? intl.formatMessage(messages.removeImportedTag, { tag, imported: intl.formatMessage(messages.imported) })
                      : intl.formatMessage(messages.removeTag, { tag })
                  }
                  onClick={() => remove(tag)}
                >
                  {intl.formatMessage(isImported ? messages.importedTagChip : messages.tagChip, {
                    tag,
                    imported: intl.formatMessage(messages.imported),
                  })}
                </button>
              );
            })}
          </div>
          {varyingTags.length === 0 ? null : <div className="ovl-inspector__tagGroupLabel">{intl.formatMessage(messages.varying)}</div>}
          <div className="ovl-inspector__tags">
            {varyingTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="ovl-inspector__tag ovl-inspector__tag--mixed"
                aria-label={intl.formatMessage(messages.removeTag, { tag })}
                onClick={() => remove(tag)}
              >
                {intl.formatMessage(messages.tagChip, { tag })}
              </button>
            ))}
            {addTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="ovl-inspector__tag ovl-inspector__tag--added"
                aria-label={intl.formatMessage(messages.removeTag, { tag })}
                onClick={() => remove(tag)}
              >
                {intl.formatMessage(messages.tagChip, { tag })}
              </button>
            ))}
          </div>
          <div className="ovl-inspector__tagEntry">
            <input
              className="ovl-inspector__metadataInput"
              value={tagDraft}
              list="photo-tag-suggestions"
              aria-label={intl.formatMessage(messages.addTag)}
              placeholder={intl.formatMessage(messages.tagPlaceholder)}
              onChange={(event) => setTagDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  queueTag();
                }
              }}
            />
            <datalist id="photo-tag-suggestions">
              {suggestions.map(({ name }) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Button size="sm" onClick={queueTag}>
              {intl.formatMessage(messages.addTag)}
            </Button>
          </div>
          <Button className="ovl-inspector__metadataSave" variant="primary" type="submit" disabled={saving || summary === null}>
            {saving
              ? intl.formatMessage(messages.saving)
              : intl.formatMessage(scope.length === 1 ? messages.saveOne : messages.saveMany, { count: scope.length })}
          </Button>
        </form>
      )}
      <details className="ovl-inspector__tagManager">
        <summary>{intl.formatMessage(messages.manage)}</summary>
        <label className="ovl-inspector__metadataLabel" htmlFor="photo-tag-source">
          {intl.formatMessage(messages.sourceTag)}
        </label>
        <input
          id="photo-tag-source"
          className="ovl-inspector__metadataInput"
          list="photo-tag-suggestions"
          value={manageSource}
          onChange={(event) => setManageSource(event.currentTarget.value)}
        />
        <label className="ovl-inspector__metadataLabel" htmlFor="photo-tag-target">
          {intl.formatMessage(messages.targetTag)}
        </label>
        <input
          id="photo-tag-target"
          className="ovl-inspector__metadataInput"
          value={manageTarget}
          onChange={(event) => setManageTarget(event.currentTarget.value)}
        />
        <div className="ovl-inspector__tagManagerActions">
          <Button size="sm" disabled={saving || sourceCount === 0} onClick={() => manage('rename')}>
            {intl.formatMessage(messages.rename, { count: sourceCount })}
          </Button>
          <Button size="sm" variant="danger" disabled={saving || sourceCount === 0} onClick={() => manage('remove')}>
            {intl.formatMessage(messages.removeEverywhere, { count: sourceCount })}
          </Button>
        </div>
      </details>
      {status === null ? null : (
        <div className="ovl-inspector__metadataStatus" role="status">
          {status}
        </div>
      )}
    </section>
  );
}
