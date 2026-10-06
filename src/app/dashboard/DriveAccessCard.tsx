'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, Folder, FileSpreadsheet, FileText, Presentation, File, Users, HardDrive, Search, Check, ArrowLeft, CornerLeftUp,
} from 'lucide-react';
import { Card, buttonSecondary } from '@/components/ui';
import {
  effectiveDriveAccess, settingsFromRules, decidingSettings, countDriveSettings, classifyDriveSettings, settingsAfterClear, accessLabel, driveDefaultLabel, SHARED_WITH_ME_ID, SHARED_DRIVES_ID,
  type DriveAccess, type DriveDefault, type DriveEffective, type DriveSetting, type LineageNode, type DriveNodeKind,
} from '@/lib/driveTreeAccess';
import { setDriveDefault, setDriveNodeAccess, clearDriveOverrides, type DriveNodeInput } from './actions';
import type { Rule } from './AgentProfilesView';

// ─── Types ──────────────────────────────────────────────────────────────────

type FileKind = 'sheet' | 'doc' | 'slide' | 'pdf' | 'other';
interface Node {
  id: string;
  name: string;
  kind: DriveNodeKind;
  fileKind?: FileKind;
  isShortcut?: boolean;
  /** Search results: root … parent. */
  path?: LineageNode[];
}
type Setting = 'inherit' | DriveAccess;
type View = { mode: 'tree' } | { mode: 'folder'; folder: Node } | { mode: 'search'; query: string };

const QUICK_OPTIONS: { value: DriveDefault; title: string; body: string; isDefault?: boolean }[] = [
  { value: 'read', title: 'Read everything', isDefault: true, body: 'The agent can read any file you can. To narrow it, set My Drive, Shared with me or a Shared drive below.' },
  { value: 'write', title: 'Read & write everything', body: 'The agent can read and edit any file you can. Protect sensitive folders below by setting them to Read or Blocked.' },
  { value: 'explicit', title: 'Only files I allow', body: 'Nothing is visible until you set Read or Write on a folder or file below. Everything else stays hidden.' },
];

const TONE = {
  read: { solid: 'bg-info text-info-foreground border-info-foreground/30', dashed: 'bg-card text-info-foreground border-dashed border-info-foreground/45' },
  write: { solid: 'bg-success text-success-foreground border-success-foreground/30', dashed: 'bg-card text-success-foreground border-dashed border-success-foreground/45' },
  block: { solid: 'bg-error text-error-foreground border-error-foreground/30', dashed: 'bg-card text-error-foreground border-dashed border-error-foreground/45' },
} as const;

const SETTING_OPTIONS: { value: Setting; label: string }[] = [
  { value: 'inherit', label: 'Inherit' }, { value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }, { value: 'block', label: 'Block' },
];

function isContainer(node: Node) { return node.kind !== 'file'; }

function NodeIcon({ node, dim }: { node: Node; dim: boolean }) {
  const cls = `h-[18px] w-[18px] shrink-0 ${dim ? 'opacity-50' : ''}`;
  if (node.kind === 'shared_with_me') return <Users className={`${cls} text-muted-foreground`} />;
  if (node.kind === 'shared_drives' || node.kind === 'shared_drive') return <HardDrive className={`${cls} text-muted-foreground`} />;
  if (node.kind === 'folder') return <Folder className={`${cls} text-muted-foreground`} />;
  if (node.fileKind === 'sheet') return <FileSpreadsheet className={`${cls} text-sheets`} />;
  if (node.fileKind === 'doc') return <FileText className={`${cls} text-docs`} />;
  if (node.fileKind === 'slide') return <Presentation className={`${cls} text-slides`} />;
  if (node.fileKind === 'pdf') return <File className={`${cls} text-destructive`} />;
  return <File className={`${cls} text-muted-foreground`} />;
}

function Pill({ access, explicit, compact = false }: { access: DriveAccess; explicit: boolean; compact?: boolean }) {
  return (
    <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full border ${compact ? 'px-1.5' : 'px-2 py-0.5'} text-[11px] font-semibold ${explicit ? TONE[access].solid : TONE[access].dashed}`}>
      {accessLabel(access)}
    </span>
  );
}

function SettingControl({ value, options, disabled, onPick, label }: {
  value: Setting; options: Setting[]; disabled?: boolean; onPick: (v: Setting) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-max items-center gap-0.5 rounded-full border border-border bg-muted p-0.5">
      {SETTING_OPTIONS.filter(o => options.includes(o.value)).map(o => {
        const selected = o.value === value;
        const selectedCls = o.value === 'inherit' ? 'bg-card text-foreground border-border' : TONE[o.value].solid;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onPick(o.value)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-4 whitespace-nowrap disabled:opacity-60 ${selected ? selectedCls : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── The card ───────────────────────────────────────────────────────────────

export function DriveAccessCard({ profileId, driveDefault: initialDefault, rules }: {
  profileId: string;
  driveDefault: DriveDefault;
  /** Rules that apply to this profile (global + assigned), any service. */
  rules: Rule[];
}) {
  const [driveDefault, setDefault] = useState<DriveDefault>(initialDefault);
  useEffect(() => { setDefault(initialDefault); }, [initialDefault]);

  // Settings keyed by node id, from the server's rules; edited optimistically.
  const [settings, setSettings] = useState<Map<string, DriveSetting[]>>(() => settingsFromRules(rules));
  useEffect(() => { setSettings(settingsFromRules(rules)); }, [rules]);

  const [roots, setRoots] = useState<Node[]>([]);
  const [children, setChildren] = useState<Map<string, Node[]>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Ancestors of every node the card has seen, nearest first.
  const chains = useRef<Map<string, LineageNode[]>>(new Map());
  const [view, setView] = useState<View>({ mode: 'tree' });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Node[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);

  const lineageOf = useCallback((node: Node): LineageNode[] => {
    const self: LineageNode = { id: node.id, name: node.name, kind: node.kind };
    if (node.path) return [self, ...node.path.slice().reverse()];
    return [self, ...(chains.current.get(node.id) ?? [])];
  }, []);

  const effectiveOf = useCallback((node: Node): DriveEffective => effectiveDriveAccess(lineageOf(node), settings, driveDefault), [lineageOf, settings, driveDefault]);

  const settingOf = useCallback((id: string): Setting => {
    const use = decidingSettings(settings.get(id) ?? []);
    if (use.length === 0) return 'inherit';
    if (use.some(s => s.access === 'block')) return 'block';
    if (use.some(s => s.access === 'write')) return 'write';
    return 'read';
  }, [settings]);

  const loadChildren = useCallback(async (parent: Node) => {
    if (children.has(parent.id) || loadingIds.has(parent.id)) return;
    setLoadingIds(prev => new Set(prev).add(parent.id));
    try {
      const res = await fetch(`/api/drive/children?parent=${encodeURIComponent(parent.id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const nodes: Node[] = data.nodes ?? [];
      const parentChain = [{ id: parent.id, name: parent.name, kind: parent.kind }, ...(chains.current.get(parent.id) ?? [])];
      for (const n of nodes) chains.current.set(n.id, parentChain);
      setChildren(prev => new Map(prev).set(parent.id, nodes));
    } catch (err) {
      setError(`Could not load "${parent.name}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingIds(prev => { const next = new Set(prev); next.delete(parent.id); return next; });
    }
  }, [children, loadingIds]);

  // Roots, then My Drive open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/drive/children?parent=roots');
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        if (cancelled) return;
        const rootNodes: Node[] = data.roots ?? [];
        for (const r of rootNodes) chains.current.set(r.id, []);
        setRoots(rootNodes);
        const myDrive = rootNodes.find(r => r.kind === 'folder');
        if (myDrive) {
          setExpanded(new Set([myDrive.id]));
          void loadChildren(myDrive);
        }
      } catch (err) {
        if (!cancelled) setError(`Could not load your Drive: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Search, debounced.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setView(v => (v.mode === 'search' ? { mode: 'tree' } : v));
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drive/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const found: Node[] = data.results ?? [];
        for (const n of found) if (n.path) chains.current.set(n.id, n.path.slice().reverse());
        setResults(found);
        setView({ mode: 'search', query: q });
      } catch (err) {
        setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const toggle = (node: Node) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id); else { next.add(node.id); void loadChildren(node); }
      return next;
    });
  };

  const openFolder = (node: Node) => {
    setQuery('');
    setResults(null);
    setView({ mode: 'folder', folder: node });
    void loadChildren(node);
  };

  const openParentOf = (node: Node) => {
    const chain = node.path ? node.path.slice().reverse() : (chains.current.get(node.id) ?? []);
    const parent = chain[0];
    if (!parent) return;
    chains.current.set(parent.id, chain.slice(1));
    openFolder({ id: parent.id, name: parent.name, kind: parent.kind });
  };

  const showInTree = (node: Node) => {
    const chain = lineageOf(node).slice(1); // nearest first
    setQuery('');
    setResults(null);
    setView({ mode: 'tree' });
    const open = new Set(expanded);
    const ancestors = chain.slice().reverse(); // root first
    for (const a of ancestors) open.add(a.id);
    if (isContainer(node)) open.add(node.id);
    setExpanded(open);
    // Load each level that is not loaded yet, top down.
    (async () => {
      for (let i = 0; i < ancestors.length; i++) {
        const a = ancestors[i];
        chains.current.set(a.id, ancestors.slice(0, i).reverse());
        await loadChildren({ id: a.id, name: a.name, kind: a.kind });
      }
      if (isContainer(node)) await loadChildren(node);
    })();
  };

  const pickDefault = async (value: DriveDefault) => {
    const previous = driveDefault;
    setDefault(value);
    setError(null);
    try { await setDriveDefault(profileId, value); } catch (err) {
      setDefault(previous);
      setError(`Could not save the default: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pickSetting = async (node: Node, value: Setting) => {
    const previous = settings.get(node.id);
    // The card edits only the user's own setting; the agent's create
    // auto-grant on the node stays (Inherit hands the node back to it).
    const withSetting = (prev: Map<string, DriveSetting[]>, ruleId: string | null) => {
      const next = new Map(prev);
      const kept = (prev.get(node.id) ?? []).filter(s => s.agentCreated);
      const list = value === 'inherit' || !ruleId ? kept : [...kept, { nodeId: node.id, access: value, ruleId, source: 'drive' as const, name: node.name }];
      if (list.length) next.set(node.id, list); else next.delete(node.id);
      return next;
    };
    setSettings(prev => withSetting(prev, 'pending'));
    setSavingIds(prev => new Set(prev).add(node.id));
    setError(null);
    try {
      const input: DriveNodeInput = { id: node.id, name: node.name, kind: node.kind };
      const { ruleId } = await setDriveNodeAccess(profileId, input, value);
      if (ruleId && value !== 'inherit') setSettings(prev => withSetting(prev, ruleId));
      setSavedIds(prev => new Set(prev).add(node.id));
      setTimeout(() => setSavedIds(prev => { const next = new Set(prev); next.delete(node.id); return next; }), 2500);
    } catch (err) {
      setSettings(prev => { const next = new Map(prev); if (previous) next.set(node.id, previous); else next.delete(node.id); return next; });
      setError(`Could not save "${node.name}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingIds(prev => { const next = new Set(prev); next.delete(node.id); return next; });
    }
  };

  // "Overrides" are the settings made on this card — exactly what Clear
  // removes. The agent's own files and legacy per-file rules are counted
  // apart and kept by Clear.
  const counts = useMemo(() => countDriveSettings(settings), [settings]);
  const overrideCount = counts.overrides;
  const hasSettingWithin = useCallback((id: string): boolean => {
    if ((settings.get(id) ?? []).length > 0) return true;
    return (children.get(id) ?? []).some(c => hasSettingWithin(c.id));
  }, [settings, children]);

  const clearAll = async () => {
    if (overrideCount === 0 || clearing) return;
    setClearing(true);
    try {
      await clearDriveOverrides(profileId);
      setSettings(prev => settingsAfterClear(prev));
    } catch (err) {
      setError(`Could not clear settings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClearing(false);
    }
  };

  // ─── Rows for the current view ──────────────────────────────────────────

  type Row = { node: Node; depth: number; inFolder: boolean; isResult: boolean };
  const rows: Row[] = useMemo(() => {
    if (view.mode === 'search') return (results ?? []).map(node => ({ node, depth: 0, inFolder: false, isResult: true }));
    if (view.mode === 'folder') return (children.get(view.folder.id) ?? []).map(node => ({ node, depth: 0, inFolder: true, isResult: false }));
    const out: Row[] = [];
    const walk = (node: Node, depth: number) => {
      if (overridesOnly && !hasSettingWithin(node.id)) return;
      out.push({ node, depth, inFolder: false, isResult: false });
      if (isContainer(node) && expanded.has(node.id)) for (const c of children.get(node.id) ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out;
  }, [view, results, children, roots, expanded, overridesOnly, hasSettingWithin]);

  const folderInfo = useMemo(() => {
    if (view.mode !== 'folder') return null;
    const folder = view.folder;
    const chain = chains.current.get(folder.id) ?? [];
    const crumbs: LineageNode[] = [...chain.slice().reverse(), { id: folder.id, name: folder.name, kind: folder.kind }];
    const eff = effectiveOf(folder);
    let explain: string;
    if (eff.level === 'default') explain = `Everything in ${folder.name} inherits ${accessLabel(eff.access)} from the default: ${driveDefaultLabel(driveDefault)}. Nothing in the path is set.`;
    else if (eff.hops === 0) explain = `Set on ${folder.name} itself. Applies to everything inside unless a subfolder or file overrides it.`;
    else explain = `Everything in ${folder.name} inherits ${accessLabel(eff.access)} from ${eff.decidedBy?.name}, ${eff.hops === 1 ? 'one level up' : `${eff.hops} levels up`}. Set it here to stop inheriting.`;
    return { folder, crumbs, eff, explain };
  }, [view, effectiveOf, driveDefault]);

  const legendPill = (cls: string, text: string) => (
    <span className="inline-flex items-center gap-1.5"><span className={`inline-flex rounded-full border px-1.5 text-[11px] font-semibold ${cls}`}>Read</span><span>{text}</span></span>
  );

  return (
    <Card testId="drive-access-card">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-foreground">Google Drive access</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">What this profile&apos;s agent can see and change across My Drive, Shared with me and Shared drives</p>
          {(counts.agentCreated > 0 || counts.perFile > 0) && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="drive-kept-settings">
              Not counted as overrides, and kept by Clear overrides:{' '}
              {[
                counts.agentCreated > 0 && `${counts.agentCreated} ${counts.agentCreated === 1 ? 'file' : 'files'} the agent created (Read & write for it, so it can keep working on its own output)`,
                counts.perFile > 0 && `${counts.perFile} per-file ${counts.perFile === 1 ? 'rule' : 'rules'} from the Picker or approval links`,
              ].filter(Boolean).join('; ')}.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground">{driveDefaultLabel(driveDefault)} · {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}</span>
          <button className={buttonSecondary} onClick={clearAll} disabled={overrideCount === 0 || clearing}>
            {clearing ? 'Clearing…' : `Clear overrides (${overrideCount})`}
          </button>
        </div>
      </div>

      {/* Quick options */}
      <div className="px-5 pb-4 space-y-3">
        <div role="radiogroup" aria-label="Default Drive access for every file" className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {QUICK_OPTIONS.map(opt => {
            const on = driveDefault === opt.value;
            return (
              <label key={opt.value} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 ${on ? 'border-primary bg-primary-muted ring-1 ring-inset ring-primary' : 'border-border bg-card'}`}>
                <input type="radio" name={`drive-default-${profileId}`} value={opt.value} checked={on} onChange={() => pickDefault(opt.value)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[13px] font-bold text-foreground">
                    {opt.title}
                    {opt.isDefault && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Default</span>}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{opt.body}</span>
                </span>
              </label>
            );
          })}
        </div>
        {driveDefault === 'write' && (
          <div className="rounded-sm border border-warning-foreground/30 bg-warning px-3 py-2.5 text-xs leading-relaxed text-warning-foreground">
            The agent can edit, rename and share every file it can see, including files other people shared with you. Set folders that must stay untouched to <strong>Read</strong> or <strong>Blocked</strong> below.
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4 border-t border-border/60 px-5 py-3">
        <label className="flex h-[34px] w-full max-w-[300px] items-center gap-2 rounded-sm border border-border bg-card px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="sr-only">Search your Drive</span>
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your Drive" className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
          <input type="checkbox" checked={overridesOnly} onChange={e => setOverridesOnly(e.target.checked)} className="h-[15px] w-[15px] accent-primary" />
          Show only items with a setting
        </label>
        <div className="ml-auto hidden items-center gap-3.5 text-xs text-muted-foreground lg:flex">
          {legendPill(TONE.read.solid, 'set here')}
          {legendPill(TONE.read.dashed, 'inherited')}
        </div>
      </div>

      {error && (
        <div className="mx-5 mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground [overflow-wrap:anywhere]" data-testid="drive-tree-error">
          {error} <button className="underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Folder view header: path = the inheritance chain */}
      {folderInfo && (
        <div className="flex flex-col gap-2.5 border-t border-border/60 bg-card px-5 py-3">
          <div className="flex items-center gap-3 text-xs">
            <button type="button" onClick={() => setView({ mode: 'tree' })} className="inline-flex items-center gap-1 font-semibold text-primary"><ArrowLeft className="h-3 w-3" />All files</button>
            <span className="text-subtle">·</span>
            <span className="text-muted-foreground">Click any folder in the path to jump there. Pills mark the folders that have a setting; every other folder inherits.</span>
          </div>
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[13px]">
            {folderInfo.crumbs.map((crumb, i) => {
              const last = i === folderInfo.crumbs.length - 1;
              const crumbSetting = settingOf(crumb.id);
              const pill = crumbSetting !== 'inherit' && <Pill access={crumbSetting} explicit compact />;
              return (
                <span key={crumb.id} className="inline-flex items-center gap-0.5">
                  {last ? (
                    <span aria-current="location" className="inline-flex items-center gap-2 px-1 font-bold text-foreground"><Folder className="h-4 w-4 text-muted-foreground" />{crumb.name}{pill}</span>
                  ) : (
                    <button type="button" onClick={() => { chains.current.set(crumb.id, folderInfo.crumbs.slice(0, i).reverse()); openFolder({ id: crumb.id, name: crumb.name, kind: crumb.kind }); }} className="inline-flex items-center gap-1.5 rounded-xs px-1 py-0.5 font-medium text-muted-foreground hover:text-foreground hover:underline">
                      {crumb.name}{pill}
                    </button>
                  )}
                  {!last && <ChevronRight className="h-3.5 w-3.5 text-subtle" />}
                </span>
              );
            })}
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-muted/40 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Pill access={folderInfo.eff.access} explicit={folderInfo.eff.hops === 0} />
              <span>{folderInfo.explain}</span>
            </div>
            <SettingControl
              label={`Access setting for ${folderInfo.folder.name}`}
              value={settingOf(folderInfo.folder.id)}
              options={['inherit', 'read', 'write', 'block']}
              disabled={savingIds.has(folderInfo.folder.id)}
              onPick={v => pickSetting(folderInfo.folder, v)}
            />
          </div>
        </div>
      )}

      {view.mode === 'search' && (
        <div className="flex items-center justify-between gap-4 border-t border-border/60 bg-muted px-5 py-2 text-xs text-muted-foreground">
          <span>{searching ? 'Searching…' : `${rows.length} ${rows.length === 1 ? 'result' : 'results'} for “${view.query}” across your whole Drive, folders first`}</span>
          <button type="button" onClick={() => setQuery('')} className="font-semibold text-primary">Clear search</button>
        </div>
      )}

      {/* Column header */}
      <div className="hidden grid-cols-[minmax(0,1fr)_220px_250px] gap-4 border-y border-border/60 bg-muted px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground xl:grid">
        <span>{view.mode === 'search' ? 'Name and location' : 'Name'}</span>
        <span>Effective access</span>
        <span>Setting</span>
      </div>

      {/* Rows */}
      <div className="max-h-[720px] overflow-y-auto">
        {rows.map(({ node, depth, inFolder, isResult }) => {
          const eff = effectiveOf(node);
          const setting = settingOf(node.id);
          const explicit = eff.hops === 0;
          const dim = eff.access === 'block';
          const container = isContainer(node);
          const open = expanded.has(node.id);
          const loading = loadingIds.has(node.id);
          const saving = savingIds.has(node.id);
          const path = isResult ? (node.path ?? []).map(p => p.name).join(' › ') : '';
          const source = explicit ? 'Set here' : eff.level === 'default' ? `default: ${driveDefaultLabel(driveDefault)}` : `from ${eff.decidedBy?.name}`;
          const settingClass = classifyDriveSettings(settings.get(node.id) ?? []);
          return (
            <div key={`${node.id}-${depth}`} className={`grid grid-cols-1 items-center gap-2 border-b border-border/60 px-5 py-2 xl:grid-cols-[minmax(0,1fr)_220px_250px] xl:gap-4 ${isResult ? 'min-h-[60px]' : 'min-h-[46px]'} ${explicit ? 'bg-muted/30' : 'bg-card'}`}>
              <div className="flex min-w-0 items-start gap-2">
                <span className="shrink-0" style={{ width: isResult || inFolder ? 0 : depth * 22 }} />
                {container && !isResult && !inFolder ? (
                  <button type="button" onClick={() => toggle(node)} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} aria-expanded={open} className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-muted">
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
                  </button>
                ) : <span className="h-[22px] w-[22px] shrink-0" />}
                <span className="mt-0.5"><NodeIcon node={node} dim={dim} /></span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {container ? (
                      <button type="button" onClick={() => openFolder(node)} title={node.name} className={`truncate text-left text-[13px] font-semibold hover:underline ${dim ? 'text-subtle' : 'text-foreground'}`}>{node.name}</button>
                    ) : (
                      <span title={node.name} className={`truncate text-[13px] font-medium ${dim ? 'text-subtle' : 'text-foreground'}`}>{node.name}</span>
                    )}
                    {node.isShortcut && <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">shortcut</span>}
                    {settingClass === 'agent_created' && <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground" title="The agent created this file, so it is Read & write for it. Not an override: Clear overrides keeps it. Set it here to change it.">created by agent</span>}
                    {settingClass === 'per_file' && <span className="rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground" title="Set by the Picker or an approval link before this profile had Drive access">per-file rule</span>}
                    {container && inFolder && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />}
                    {loading && <span className="text-[11px] text-subtle">loading…</span>}
                  </span>
                  {isResult && (
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-subtle">
                      <span className="break-words">{path || 'Shared with me'}</span>
                      <button type="button" onClick={() => (container ? openFolder(node) : openParentOf(node))} className="shrink-0 font-semibold text-primary hover:underline">Open folder</button>
                      <span className="text-border">·</span>
                      <button type="button" onClick={() => showInTree(node)} className="shrink-0 font-semibold text-primary hover:underline">Show in tree</button>
                    </span>
                  )}
                </span>
              </div>
              <div className="flex min-w-0 flex-col items-start gap-0.5 pl-[52px] xl:pl-0">
                <Pill access={eff.access} explicit={explicit} />
                <span className="flex min-w-0 max-w-full items-start gap-1 text-xs text-muted-foreground" title={source}>
                  {!explicit && <CornerLeftUp className="mt-0.5 h-3 w-3 shrink-0 text-subtle" />}
                  <span className="min-w-0 break-words">{source}</span>
                </span>
              </div>
              <div className="flex items-center gap-2.5 pl-[52px] xl:pl-0">
                <SettingControl
                  label={`Access setting for ${node.name}`}
                  value={setting}
                  options={['inherit', 'read', 'write', 'block']}
                  disabled={saving}
                  onPick={v => pickSetting(node, v)}
                />
                {savedIds.has(node.id) && <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary"><Check className="h-3 w-3" />Saved</span>}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="m-5 rounded-sm border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
            {view.mode === 'search' ? (searching ? 'Searching…' : 'Nothing matches.') : view.mode === 'folder' ? (loadingIds.has(view.folder.id) ? 'Loading…' : 'This folder is empty.') : roots.length === 0 ? 'Loading your Drive…' : 'Nothing to show. Turn off “Show only items with a setting”.'}
          </div>
        )}
      </div>

      <p className="px-5 py-3 text-xs text-subtle">
        The quick option sets the default for every file, including items other people shared with you. A setting on a folder applies to everything inside it; a setting on a file or subfolder overrides its parent. Blocked files are invisible to the agent, not just read-only. Root ids: My Drive, {SHARED_WITH_ME_ID}, {SHARED_DRIVES_ID}.
      </p>
    </Card>
  );
}
