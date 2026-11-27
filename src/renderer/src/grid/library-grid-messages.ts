import { defineMessages } from 'react-intl';

export const libraryGridMessages = defineMessages({
  nativeDragWithheld: {
    id: 'library.nativeDrag.withheld',
    defaultMessage: 'Original drag blocked. Withheld: {fields}. Use Export → Baked.',
  },
  trashPolicyDays: {
    id: 'library.trash.retentionPolicy.days',
    defaultMessage: 'Items in Trash are deleted permanently after {days} days.',
  },
  trashPolicyOff: {
    id: 'library.trash.retentionPolicy.off',
    defaultMessage: 'Items in Trash are kept until you delete them permanently.',
  },
  purgedWithCloudRetry: {
    id: 'library.trash.purge.partial',
    defaultMessage: 'Deleted permanently: {purged} local; {remoteFailures} cloud pending retry',
  },
  purged: {
    id: 'library.trash.purge.complete',
    defaultMessage: 'Deleted {count, plural, one {# photo} other {# photos}} permanently',
  },
});
