/** A real space between two adjacent texts.
 *
 * axe reads a widget's visible text by concatenating the text of its child
 * elements with NO separator, so two sibling spans ("IMG_4021.RAF" and
 * "Imported") read as one glued word ("RAFImported"). A label-in-name check
 * (WCAG 2.5.3) then cannot match that visible word against the accessible
 * name, even when the name carries every word separately.
 *
 * Rendering this between the siblings keeps the words apart for both the
 * visible text and the name. It is a named constant rather than a JSX literal
 * because a literal would be counted by the i18n string ratchet, and because
 * Prettier rewrites a literal `{' '}` but keeps this one.
 */
export const WORD_SEPARATOR = ' ';
