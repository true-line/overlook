import type { Dispatch } from 'react';
import { defineMessages, type IntlShape } from 'react-intl';

import type { AppAction } from '../../../shared/library/app-state.js';

const deletePhotoMessages = defineMessages({
  trashedOne: { id: 'commands.toast.trashedOne', defaultMessage: 'Moved 1 photo to Trash' },
  preservedOne: { id: 'commands.toast.preservedOne', defaultMessage: 'Preserved 1 protected Original' },
});

export function deletePhoto(photoId: string, dispatch: Dispatch<AppAction>, intl?: IntlShape): void {
  void window.overlook.library.delete({ photoIds: [photoId] }).then(({ protected: protectedCount }) => {
    const fallback = protectedCount === 0 ? 'Moved 1 photo to Trash' : 'Preserved 1 protected Original';
    dispatch({
      type: 'toast/shown',
      toast: {
        title: intl
          ? intl.formatMessage(protectedCount === 0 ? deletePhotoMessages.trashedOne : deletePhotoMessages.preservedOne)
          : fallback,
        tone: protectedCount === 0 ? 'neutral' : 'amber',
      },
    });
  });
}
