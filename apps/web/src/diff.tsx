import { useEffect, useRef } from 'react';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import { Copy } from './content';

export function Diff({ text, label }: { text: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = EditorState.create({ doc: text }).doc;
    const marks = new RangeSetBuilder<Decoration>();
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const kind = line.text.startsWith('+') ? 'added' : line.text.startsWith('-') ? 'removed' : line.text.startsWith('@@') ? 'hunk' : '';
      if (kind) marks.add(line.from, line.from, Decoration.line({ class: `diff-${kind}` }));
    }
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: text, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(),
        EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
        EditorView.decorations.of(marks.finish()),
        EditorView.theme({
          '&': { background: '#080a0d', color: '#d5dfec', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', maxHeight: '420px', fontFamily: 'monospace' },
          '.cm-gutters': { background: '#0d1117', color: '#68768a', border: 'none' },
          '.diff-added': { background: '#0e291d', color: '#b5ecc8' },
          '.diff-removed': { background: '#32191e', color: '#f1b6bf' },
          '.diff-hunk': { background: '#102235', color: '#95c9f5' },
        }, { dark: true }),
      ] }),
    });
    return () => view.destroy();
  }, [text, label]);
  return <div className="diff"><Copy text={text}/><div ref={host}/></div>;
}
