import { useEffect, useRef } from 'react';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import { Copy } from './content';
import { analyzeDiff } from './diff-lines';

export function Diff({ text, label }: { text: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = EditorState.create({ doc: text }).doc;
    const { kinds } = analyzeDiff(text);
    const marks = new RangeSetBuilder<Decoration>();
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const kind = kinds[n - 1];
      if (kind) marks.add(line.from, line.from, Decoration.line({ class: `diff-${kind}` }));
    }
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: text, extensions: [
        EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(),
        EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
        EditorView.decorations.of(marks.finish()),
        EditorView.theme({
          '&': { background: '#02080c', color: '#cadfeb', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.8' },
          '.cm-content': { padding: '12px 0', minWidth: '100%' },
          '.cm-line': { padding: '0 14px' },
          '.cm-gutters': { background: '#030b10', color: '#50728a', borderRight: '1px solid #15303f' },
          '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
          '.diff-added': { background: '#0a261d', color: '#80e2b5' },
          '.diff-removed': { background: '#29141b', color: '#f7a1b0' },
          '.diff-hunk': { background: '#092033', color: '#79cfff' },
          '.diff-file': { color: '#93b3c8', fontWeight: '600' },
        }, { dark: true }),
      ] }),
    });
    return () => view.destroy();
  }, [text, label]);
  const stats = analyzeDiff(text);
  return <div className="diff"><div className="diff-toolbar"><span>Unified Diff</span><span className="diff-stats"><span className="added">+{stats.added}</span><span className="removed">−{stats.removed}</span></span><Copy text={text}/></div><div className="diff-editor" ref={host}/></div>;
}
