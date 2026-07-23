import { useState, type CSSProperties } from 'react';
import type { HarnessConfig, Profile } from '@/store/config';
import { upsertProfile, removeProfile } from '@/store/config';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

// Agent Profiles (#105) — a self-contained Settings section (pattern:
// OfficeThemePicker). Manages HarnessConfig.profiles: a reusable named bundle of
// environment + spawn defaults the user selects at hire (AddAgentModal). CRUD is
// persisted through window.cth.updateConfig({ profiles }) — the same read/write
// spread-merge path as mcpDefaults / missions — using the pure upsert/remove
// reducers from store/config.ts.

function genId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface EnvRow { key: string; value: string; }

/** The in-flight editor form (env as ordered rows so blank rows can be typed). */
interface Draft {
  id: string; // '' when creating a new profile
  label: string;
  env: EnvRow[];
  model: string;
  command: string;
}

const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
};
const fieldLabel: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase'
};
const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)',
  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)', outline: 'none'
};
const monoInput: CSSProperties = { ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 };

export function ProfilesEditor({ config }: { config: HarnessConfig }) {
  const [profiles, setProfiles] = useState<Profile[]>(config.profiles ?? []);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const persist = async (next: Profile[]): Promise<boolean> => {
    setBusy(true);
    setNote('');
    try {
      await window.cth.updateConfig({ profiles: next });
      setProfiles(next);
      return true;
    } catch (e) {
      setNote(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startNew = () =>
    setEditing({ id: '', label: '', env: [{ key: '', value: '' }], model: '', command: '' });

  const startEdit = (p: Profile) =>
    setEditing({
      id: p.id,
      label: p.label,
      env: Object.entries(p.env ?? {}).map(([key, value]) => ({ key, value })),
      model: p.model ?? '',
      command: p.command ?? ''
    });

  const patchDraft = (patch: Partial<Draft>) => setEditing((d) => (d ? { ...d, ...patch } : d));
  const setRow = (i: number, patch: Partial<EnvRow>) =>
    setEditing((d) => (d ? { ...d, env: d.env.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : d));
  const addRow = () => setEditing((d) => (d ? { ...d, env: [...d.env, { key: '', value: '' }] } : d));
  const removeRow = (i: number) =>
    setEditing((d) => (d ? { ...d, env: d.env.filter((_, j) => j !== i) } : d));

  const saveDraft = async () => {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) { setNote('Label is required'); return; }
    // Collapse the rows to a Record, dropping blank keys (last write wins on dupes).
    const env: Record<string, string> = {};
    for (const r of editing.env) {
      const k = r.key.trim();
      if (k) env[k] = r.value;
    }
    const profile: Profile = {
      id: editing.id || genId(),
      label,
      ...(Object.keys(env).length ? { env } : {}),
      ...(editing.model.trim() ? { model: editing.model.trim() } : {}),
      ...(editing.command.trim() ? { command: editing.command.trim() } : {})
    };
    if (await persist(upsertProfile(profiles, profile))) setEditing(null);
  };

  const del = async (id: string) => {
    if (await persist(removeProfile(profiles, id)) && editing?.id === id) setEditing(null);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={headStyle}>Agent Profiles</div>
        {!editing && (
          <PixelButton variant="secondary" size="sm" onClick={startNew} disabled={busy}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Icon name="plus" /> new profile
            </span>
          </PixelButton>
        )}
      </div>

      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', marginBottom: 10 }}>
        A named bundle of environment variables and spawn defaults you can pick when hiring an agent —
        e.g. set <code style={{ fontFamily: 'var(--cth-font-mono)' }}>CLAUDE_CONFIG_DIR</code> to run a
        separate Claude account. The profile&apos;s env is injected into that agent&apos;s terminal.
      </div>

      {/* Existing profiles */}
      {profiles.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: editing ? 12 : 0 }}>
          {profiles.map((p) => {
            const envCount = Object.keys(p.env ?? {}).length;
            const bits: string[] = [];
            if (envCount) bits.push(`${envCount} env var${envCount === 1 ? '' : 's'}`);
            if (p.model) bits.push(`model ${p.model}`);
            if (p.command) bits.push(`cmd ${p.command}`);
            return (
              <div
                key={p.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 14, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.label}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {bits.length ? bits.join(' · ') : 'no overrides'}
                  </span>
                </span>
                <PixelButton variant="secondary" size="sm" onClick={() => startEdit(p)} disabled={busy}>
                  edit
                </PixelButton>
                <PixelButton variant="destructive" size="sm" onClick={() => void del(p.id)} disabled={busy}>
                  delete
                </PixelButton>
              </div>
            );
          })}
        </div>
      )}

      {/* Editor form */}
      {editing && (
        <div style={{
          marginTop: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)'
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Label</span>
            <input
              value={editing.label}
              onChange={(e) => patchDraft({ label: e.target.value })}
              placeholder="Work account"
              style={inputStyle}
            />
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Environment variables</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {editing.env.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={r.key}
                    onChange={(e) => setRow(i, { key: e.target.value })}
                    placeholder="CLAUDE_CONFIG_DIR"
                    style={{ ...monoInput, flex: '0 0 44%' }}
                  />
                  <span style={{ color: 'var(--cth-ink-500)' }}>=</span>
                  <input
                    value={r.value}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                    placeholder="~/.claude-work"
                    style={{ ...monoInput, flex: 1 }}
                  />
                  <button
                    onClick={() => removeRow(i)}
                    title="Remove this variable"
                    aria-label="remove variable"
                    style={{
                      flexShrink: 0, width: 26, height: 26, display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              ))}
              <button
                onClick={addRow}
                style={{
                  alignSelf: 'flex-start', padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                  background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                  display: 'inline-flex', alignItems: 'center', gap: 4
                }}
              >
                <Icon name="plus" /> add variable
              </button>
            </div>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Model (optional)</span>
            <input
              value={editing.model}
              onChange={(e) => patchDraft({ model: e.target.value })}
              placeholder="claude-opus-4-8"
              style={monoInput}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={fieldLabel}>Command (optional)</span>
            <input
              value={editing.command}
              onChange={(e) => patchDraft({ command: e.target.value })}
              placeholder="claude"
              style={monoInput}
            />
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <PixelButton variant="ghost" size="md" onClick={() => { setEditing(null); setNote(''); }} disabled={busy}>
              cancel
            </PixelButton>
            <PixelButton variant="primary" size="md" onClick={() => void saveDraft()} disabled={busy}>
              {busy ? 'saving…' : editing.id ? 'save changes' : 'add profile'}
            </PixelButton>
          </div>
        </div>
      )}

      {note && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cth-coral)' }}>{note}</div>}
    </div>
  );
}
