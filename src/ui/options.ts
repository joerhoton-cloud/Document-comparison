import type { CompareOptions } from '../types';
import { h } from './dom';

/** Comparison settings form; calls onChange with a fresh options object on every edit. */
export function optionsPanel(options: CompareOptions, onChange: (o: CompareOptions) => void): HTMLElement {
  const check = (key: 'ignoreCase' | 'ignorePunctuation' | 'ignoreWhitespace', label: string, hint: string) =>
    h(
      'label',
      { class: 'opt', title: hint },
      h('input', {
        type: 'checkbox',
        checked: options[key],
        onchange: (e: Event) => onChange({ ...options, [key]: (e.target as HTMLInputElement).checked }),
      }),
      h('span', null, label),
    );

  const granularity = h(
    'select',
    {
      'aria-label': 'Highlight granularity',
      onchange: (e: Event) =>
        onChange({ ...options, granularity: (e.target as HTMLSelectElement).value as CompareOptions['granularity'] }),
    },
    h('option', { value: 'word', selected: options.granularity === 'word' }, 'Word-level'),
    h('option', { value: 'char', selected: options.granularity === 'char' }, 'Character-level'),
  );

  return h(
    'div',
    { class: 'options' },
    check('ignoreCase', 'Ignore case', 'Treat "Agreement" and "agreement" as the same'),
    check('ignorePunctuation', 'Ignore punctuation', 'Ignore commas, periods, quotes and other symbols'),
    check('ignoreWhitespace', 'Ignore spacing', 'Ignore extra spaces, tabs and line wrapping'),
    h('label', { class: 'opt' }, h('span', null, 'Highlight'), granularity),
  );
}
