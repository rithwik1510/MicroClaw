import { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { getPersonaFiles, savePersonaFile } from './api';
import type { PersonaFile } from './api';

export function PersonaPage() {
  const [files, setFiles] = useState<PersonaFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getPersonaFiles().then(f => {
      setFiles(f);
      if (f.length > 0) {
        setActiveFile(f[0].filename);
        setEditorContent(f[0].content);
      }
    }).catch(() => {});
  }, []);

  function switchFile(filename: string) {
    const file = files.find(f => f.filename === filename);
    if (!file) return;
    setActiveFile(filename);
    setEditorContent(file.content);
    setHasChanges(false);
    setSaved(false);
  }

  function handleEdit(value: string) {
    setEditorContent(value);
    setHasChanges(true);
    setSaved(false);
  }

  async function handleSave() {
    if (!activeFile || !hasChanges) return;
    setSaving(true);
    try {
      await savePersonaFile(activeFile, editorContent);
      setFiles(prev => prev.map(f =>
        f.filename === activeFile ? { ...f, content: editorContent } : f
      ));
      setHasChanges(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Could show error toast
    }
    setSaving(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    // Tab inserts spaces instead of changing focus
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = editorContent;
      setEditorContent(value.substring(0, start) + '  ' + value.substring(end));
      setHasChanges(true);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
    }
  }

  const activeDescription = files.find(f => f.filename === activeFile)?.description || '';
  const displayName = activeFile?.replace('.md', '') || '';

  return (
    <div className="persona-page">
      <motion.div
        className="persona-header"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="persona-title">Persona</h1>
      </motion.div>

      {/* File chips */}
      <div className="persona-chips">
        {files.map((file, i) => (
          <motion.button
            key={file.filename}
            className={`persona-chip ${activeFile === file.filename ? 'active' : ''}`}
            onClick={() => switchFile(file.filename)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04, duration: 0.25 }}
          >
            {file.filename.replace('.md', '')}
          </motion.button>
        ))}
      </div>

      {/* Editor */}
      {activeFile && (
          <div className="persona-editor">
            <div className="persona-editor-header">
              <div className="persona-editor-title-row">
                <span className="persona-editor-name">{displayName}</span>
                <span className="persona-editor-desc">{activeDescription}</span>
                {hasChanges && <span className="persona-unsaved-dot" />}
              </div>
              <button
                className="persona-save-btn"
                onClick={handleSave}
                disabled={!hasChanges || saving}
              >
                {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
              </button>
            </div>

            <textarea
              ref={textareaRef}
              className="persona-textarea"
              value={editorContent}
              onChange={e => handleEdit(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />

            <div className="persona-editor-footer">
              <span>Ctrl+S to save</span>
              <span>{editorContent.length.toLocaleString()} chars</span>
            </div>
          </div>
        )}
    </div>
  );
}
